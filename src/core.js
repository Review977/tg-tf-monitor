/**
 * tg-tf-monitor-cloud · 核心逻辑（平台无关）
 * ==========================================
 * 同一份代码同时给 Cloudflare Workers 和 Vercel 用 —— 只有这一份实现，
 * 平台差异全部收敛在 `src/worker.js` / `src/vercel-*.js` 和 storage 适配器里。
 * （刻意不做两份实现：本仓库有过"复制式并存必然分叉"的教训。）
 *
 * 设计约束（都来自实测的平台限制，见 README）：
 *  1. 无本地文件系统 —— 状态一律通过注入的 store 读写（KV / Redis / 内存）。
 *  2. CF Workers 免费版每次调用只有 10ms CPU —— 所以解析只在**有界切片**上做，
 *     绝不对整页 40KB 跑正则。`bench.mjs` 可以量出来。
 *  3. 无长轮询 —— 命令走 Webhook，定时走平台 Cron。
 *
 * 纯函数（parseJoinPage / tgHtmlCheck / tgPrepare / cleanAppName …）不碰网络，
 * 由 `test/core.test.mjs` 拿真实页面样本做确定性断言。
 */

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const STATE_LABEL = {
  open: "可加入 ✅",
  full: "已满员 ⛔",
  closed: "已关闭 🚫",
  invalid: "链接失效 ❌",
  error: "检查失败 ⚠️",
  unknown: "状态未知 ❓",
};

// 页面里"获取 TestFlight"那段通用说明，取描述时要排除掉
export const GENERIC_DESC = ["Help developers test beta versions", "帮助开发者测试"];

// ─────────────────────────── 纯函数 ───────────────────────────

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 去标签 + 反转义，保留换行（做消息兜底用） */
export function htmlToPlain(s) {
  return unescapeEntities(String(s || "").replace(/<[^>]+>/g, ""));
}

export function unescapeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * 去标签 + 压空白。**只喂有界切片**，不要喂整页（CPU 限制）。
 */
export function stripTags(s) {
  return unescapeEntities(
    String(s || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 剥掉 Apple 包在应用名外面的壳（中英两种写法） */
export function cleanAppName(s) {
  let t = unescapeEntities(String(s || "")).replace(/\s+/g, " ").trim();
  t = t.replace(/^Join the\s+/i, "");
  t = t.replace(/^加入\s*Beta\s*版\s*[“"]?/, "");
  t = t.replace(/^View\s+/i, "");
  t = t.replace(/^查看\s*[“"]?/, "");
  t = t.replace(/[”"']?\s*Beta\s*版?\s*$/i, "");
  t = t.replace(/\s*[”"']\s*$/, "");
  return t.trim();
}

/**
 * 判定 join 页状态。**纯函数**，不发网络请求。
 *
 * 判据分两层，**先措辞、后结构**：
 *
 *   第一层（措辞，高置信，中英实测校准）：
 *     full    : 状态句含 "测试员已满" / "is full"
 *     closed  : 状态句含 "不接受" / "not accepting"
 *
 *   第二层（结构，**语言无关** —— 万一 Apple 按出口 IP 返回日语/韩语页，
 *          光靠中英措辞会判成"未知"。Cloudflare Workers 的出口 IP 可能落在东京等地，
 *          所以这层是必需的，不是锦上添花）：
 *     open    : 存在 step1 **非空**的 app-steps 块
 *     full    : 标题里带 app 名（Apple 在"已满"时保留 app 标题）
 *     closed  : 标题就是通用的 "TestFlight - Apple"
 *     （上面三条在 6 个真实样本上完全干净：可加入 2 非空/0 空，
 *       已满与已关闭 0 非空/2 空；已满标题带 app 名、已关闭是通用标题）
 *
 *   404 → invalid
 *
 * 状态句的唯一权威来源 = <div class="beta-status"> 里的 <span>
 *
 * ⚠️ 两个已实测的坑：
 *   1. full/closed 页面上 class="beta-status" 和「加入测试」按钮**依然存在**，
 *      所以不能靠它们判定。
 *   2. Apple 按 IP 定语言（改 Accept-Language 无效），full/closed 页中英随机。
 *
 * `stateBasis` 记录这次判定靠的是哪一层，便于出问题时定位：
 *   "wording"（措辞）/ "structure"（结构）/ "title"（标题推断）/ "unknown"
 */
export function parseJoinPage(html, httpStatus, errorMsg = "") {
  const text = String(html == null ? "" : html);
  const st = Number(httpStatus);
  const out = {
    http: st, state: "error", stateBasis: "", title: "", appName: "", desc: "",
    descHash: "", head: "", statusText: "",
  };
  if (st === 0) {
    out.error = errorMsg || "网络异常";
    return out;
  }
  if (st === 404) {
    out.state = "invalid";
    out.stateBasis = "wording";
    return out;
  }
  if (st !== 200) {
    out.error = "HTTP " + st;
    return out;
  }

  const tm = /<title>([\s\S]*?)<\/title>/i.exec(text);
  if (tm) out.title = unescapeEntities(tm[1]).replace(/\s+/g, " ").trim();

  // ── app 专属块：取 app 名、描述文案，以及两个结构信号 ──
  let stepTextMatch = false; // 语言相关：认得出 "Step 2" / "第 2 步"
  let nonEmptyStep1 = false; // 语言无关：step1 里有内容
  const blocks = text.split('class="app-steps"').slice(1);
  for (const ch of blocks) {
    const s1 = /<div class="step1">([\s\S]*?)<\/div>/i.exec(ch);
    const inner = s1 ? s1[1] : "";
    if (inner.trim()) nonEmptyStep1 = true;
    if (inner.includes("Step 2") || inner.includes("第 2 步") || inner.includes("第2步")) {
      stepTextMatch = true;
      const s2 = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(inner);
      if (s2 && !out.appName) out.appName = cleanAppName(s2[1]);
    }
    const s3 = /<p class="step3">([\s\S]*?)<\/p>/i.exec(ch);
    if (s3) {
      const d = unescapeEntities(s3[1]).replace(/\s+/g, " ").trim();
      if (d && !GENERIC_DESC.some((g) => d.includes(g))) {
        out.desc = d;
        out.descHash = shortHash(d);
      }
    }
  }
  const joinStep = stepTextMatch || nonEmptyStep1;

  // app 名兜底：og:title
  if (!out.appName) {
    const om = /<meta property="og:title" content="([\s\S]*?)"/i.exec(text);
    if (om) out.appName = cleanAppName(om[1]);
  }

  // ── 状态句：只在 beta-status 附近的有界切片上找（省 CPU）──
  let statusText = "";
  const bi = text.indexOf('class="beta-status"');
  if (bi !== -1) {
    const sm = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(text.slice(bi, bi + 3000));
    if (sm) statusText = unescapeEntities(sm[1]).replace(/\s+/g, " ").trim();
  }

  // head 只用于诊断与兜底；同样只取有界前缀
  let head = stripTags(text.slice(0, 8000));
  if (out.title && head.startsWith(out.title)) head = head.slice(out.title.length);
  out.head = head.slice(0, 900).trim();

  if (!statusText) {
    // 兜底：站点结构变了就退回"头部扫描"（宁可 unknown 也不猜）
    const m = /([\s\S]*?)(?:Help developers test beta versions|使用 TestFlight App 帮助开发者测试|帮助开发者测试 Beta 版)/.exec(out.head);
    statusText = (m ? m[1] : out.head.slice(0, 300)).trim();
  }
  out.statusText = statusText;
  const low = statusText.toLowerCase();

  // 第一层：措辞
  if (statusText.includes("测试员已满") || low.includes("is full") || statusText.includes("名额已满")) {
    out.state = "full";
    out.stateBasis = "wording";
    return out;
  }
  if (statusText.includes("不接受") || low.includes("not accepting") || low.includes("no longer accept")) {
    out.state = "closed";
    out.stateBasis = "wording";
    return out;
  }
  if (out.head.includes("测试员已满") || out.head.includes("This beta is full") || out.head.includes("测试版已满")) {
    out.state = "full";
    out.stateBasis = "wording";
    return out;
  }
  if (out.head.includes("不接受任何新测试员") || out.head.includes("accepting any new testers")) {
    out.state = "closed";
    out.stateBasis = "wording";
    return out;
  }

  // 第二层：结构（语言无关）
  if (joinStep) {
    out.state = "open";
    out.stateBasis = nonEmptyStep1 ? "structure" : "wording";
    return out;
  }
  // 非开放页：标题里带 app 名 = 已满；通用标题 = 已关闭
  if (out.title && !GENERIC_TITLE_RE.test(out.title)) {
    out.state = "full";
    out.stateBasis = "title";
    return out;
  }
  if (GENERIC_TITLE_RE.test(out.title)) {
    out.state = "closed";
    out.stateBasis = "title";
    return out;
  }
  out.state = "unknown";
  out.stateBasis = "unknown";
  return out;
}

/** 已关闭页面的标题是通用的（不含 app 名）；已满页面保留 app 标题 */
export const GENERIC_TITLE_RE = /^TestFlight\s*-\s*Apple$/i;

/** 稳定的短哈希（FNV-1a，够用且不需要 crypto 子请求） */
export function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// join 码：兼容 /join/xxx、%2Fjoin%2Fxxx、\/join\/xxx
const JOIN_RE = /testflight\.apple\.com(?:\/|%2F|\\\/)+join(?:\/|%2F|\\\/)+([A-Za-z0-9]{6,14})/g;

/** 找出文本里所有 join 码（去重） */
export function findJoinCodes(text) {
  const s = String(text || "");
  const re = new RegExp(JOIN_RE.source, "g");
  const out = new Set();
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[1]);
  return [...out];
}

/** 只取第一个 join 码 */
export function firstJoinCode(text) {
  const re = new RegExp(JOIN_RE.source);
  const m = re.exec(String(text || ""));
  return m ? m[1] : "";
}

export const JOIN_CODE_RE = /^[A-Za-z0-9]{6,14}$/;

// ── Telegram 消息安全 ──

export const TG_ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "span", "tg-spoiler", "blockquote", "br",
]);

/**
 * 发送前校验：这条消息是不是 Telegram 能解析的 HTML。
 * Telegram 遇到未知标签 / 未配对标签 / 裸 `<` 会**整条拒收** ——
 * 告警是单向通道，被拒就等于**静默漏报**。
 */
export function tgHtmlCheck(text) {
  const s = String(text || "");
  const stack = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const closing = m[1];
    const name = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (!TG_ALLOWED_TAGS.has(name)) return [false, "未知标签 <" + name + ">"];
    if (closing) {
      if (!stack.length || stack[stack.length - 1] !== name) return [false, "标签未配对 </" + name + ">"];
      stack.pop();
    } else if (!attrs.trimEnd().endsWith("/")) {
      stack.push(name);
    }
  }
  if (stack.length) return [false, "标签未闭合 " + stack.join(",")];
  if (/<(?![A-Za-z/])/.test(s)) return [false, "存在裸 <"];
  if (/&(?!#?\w+;)/.test(s)) return [false, "存在未转义的 &"];
  return [true, ""];
}

/** 截断到平台上限（按行边界，避免截在标签中间），不合法则退回纯文本 */
export function tgPrepare(text, limit = 4000) {
  let body = String(text || "");
  if (body.length > limit) {
    const cut = body.lastIndexOf("\n", limit);
    body = body.slice(0, cut > limit / 2 ? cut : limit) + "\n…（内容过长已截断）";
  }
  const [ok, why] = tgHtmlCheck(body);
  if (ok) return { body, degraded: false, why: "" };
  return { body: htmlToPlain(body).slice(0, limit), degraded: true, why };
}

/**
 * sendMessage 参数。
 * ⚠️ 关链接预览两个键都发：`link_preview_options` 是 Bot API 7.0 起的现代写法
 * （10.3 文档实测已**移除** `disable_web_page_preview`），老键给自建 Bot API server 兜底。
 * Telegram 忽略未知参数，所以两个都发是安全的；只发老键的话在新版云端**不生效**。
 */
export function tgSendParams(chatId, text) {
  return {
    chat_id: String(chatId),
    text: text,
    parse_mode: "HTML",
    link_preview_options: '{"is_disabled":true}',
    disable_web_page_preview: "true",
  };
}

// ─────────────────────────── HTTP ───────────────────────────

async function httpGet(url, { fetchImpl, timeoutMs = 25000, headers = {} } = {}) {
  const f = fetchImpl || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/json,application/xhtml+xml,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...headers,
      },
    });
    const text = await res.text();
    return [res.status, text];
  } catch (e) {
    return [0, String((e && e.message) || e)];
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 探针 ───────────────────────────

export async function probeJoin(code, opts = {}) {
  const url = "https://testflight.apple.com/join/" + code;
  const [st, text] = await httpGet(url, opts);
  const out = parseJoinPage(text, st, st === 0 ? text : "");
  out.code = code;
  out.url = url;
  out.checkedAt = nowStr();
  return out;
}

function walkFind(obj, pred) {
  if (obj && typeof obj === "object") {
    if (!Array.isArray(obj) && pred(obj)) return obj;
    for (const v of Object.values(obj)) {
      const r = walkFind(v, pred);
      if (r) return r;
    }
  }
  return null;
}

/** departures.to 是 Laravel Livewire，页面里嵌了结构化 wire:snapshot（含 status / url） */
export async function probeDepartures(appId, opts = {}) {
  const url = "https://departures.to/apps/" + appId;
  const out = { source: "departures.to", appId, page: url, status: "", url: "", code: "", appName: "", error: "" };
  const [st, text] = await httpGet(url, opts);
  if (st !== 200) {
    out.error = "HTTP " + st;
    return out;
  }
  const tm = /<title>([\s\S]*?)<\/title>/i.exec(text);
  if (tm) out.appName = unescapeEntities(tm[1]).replace(/\s+/g, " ").trim();

  const re = /wire:snapshot="([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let data;
    try {
      data = JSON.parse(unescapeEntities(m[1]));
    } catch {
      continue;
    }
    const node = walkFind(data, (d) => "url" in d && "status" in d);
    if (node) {
      out.status = String(node.status || "");
      out.url = String(node.url || "");
      out.code = firstJoinCode(out.url);
      return out;
    }
  }
  out.error = "未在页面里找到 wire:snapshot 数据（站点结构可能变了）";
  return out;
}

function collectItemLists(node, acc) {
  if (node && typeof node === "object") {
    if (!Array.isArray(node) && node["@type"] === "ItemList") {
      acc.push(...(node.itemListElement || []));
    }
    for (const v of Object.values(node)) collectItemLists(v, acc);
  }
}

/** tfstore.top 的 app id **就是** join 码；搜索结果里有 JSON-LD ItemList */
export async function probeTfstore(query, opts = {}) {
  const url = "https://tfstore.top/zh-CN/apps/search?search=" + encodeURIComponent(query);
  const [st, text] = await httpGet(url, opts);
  const out = [];
  if (st !== 200) return out;
  const items = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      collectItemLists(JSON.parse(m[1]), items);
    } catch {
      /* 忽略坏块 */
    }
  }
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const u = String(it.url || "");
    const mm = /\/apps\/([A-Za-z0-9]{6,14})$/.exec(u);
    if (mm) out.push({ source: "tfstore.top", code: mm[1], appName: String(it.name || ""), page: u, query });
  }
  return out;
}

/** Bing 会把外链包成 /ck/a?...&u=a1<base64url> */
export function bingDecode(href) {
  const h = String(href || "");
  if (!h.includes("bing.com/ck/a")) return h;
  try {
    const u = new URL(h).searchParams.get("u") || "";
    let b = u.startsWith("a1") ? u.slice(2) : u;
    b = b.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return h;
  }
}

export async function probeBing(query, opts = {}) {
  const url = "https://cn.bing.com/search?count=30&q=" + encodeURIComponent(query);
  const [st, text] = await httpGet(url, opts);
  const out = [];
  if (st !== 200) return out;
  const re = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const hm = /<h2>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!hm) continue;
    const href = bingDecode(unescapeEntities(hm[1]));
    const title = stripTags(hm[2]);
    const sm = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const snippet = sm ? stripTags(sm[1]) : "";
    const ctx = (title + " " + snippet).trim();
    for (const c of findJoinCodes(href + " " + block)) {
      out.push({ source: "Bing", code: c, appName: title, page: href, context: ctx.slice(0, 300), query });
    }
  }
  return out;
}

/**
 * 360 搜索（so.com）—— 实测唯一能在无浏览器下稳定拿到结果的引擎。
 * 结果结构化：<li class="res-list"> 里 data-mdurl = 真实外链，res-title = 页面标题。
 */
export async function probeSo360(query, opts = {}) {
  const url = "https://www.so.com/s?q=" + encodeURIComponent(query);
  const [st, text] = await httpGet(url, opts);
  const out = [];
  if (st !== 200) return out;
  const re = /<li class="res-list"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const dm = /data-mdurl="([^"]+)"/.exec(block);
    if (!dm) continue;
    const target = unescapeEntities(dm[1]);
    const codes = findJoinCodes(target + " " + block);
    if (!codes.length) continue;
    const tm = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block);
    const title = tm ? stripTags(tm[1]) : "";
    const sm = /<span class="res-list-summary"[^>]*>([\s\S]*?)<\/span>/.exec(block);
    const snippet = sm ? stripTags(sm[1]) : "";
    const ctx = (title + " " + snippet).trim();
    for (const c of codes) {
      out.push({ source: "360搜索", code: c, appName: title, page: target, context: ctx.slice(0, 300), query });
    }
  }
  return out;
}

/** t.me/s/<channel> 是公开网页预览，不需要登录 */
export async function probeTgChannel(channel, opts = {}) {
  const ch = String(channel || "").replace(/^@/, "").trim();
  const url = "https://t.me/s/" + ch;
  const [st, text] = await httpGet(url, opts);
  const out = [];
  if (st !== 200) return out;
  for (const chunk of text.split("tgme_widget_message_wrap").slice(1)) {
    const codes = findJoinCodes(chunk);
    if (!codes.length) continue;
    const bm = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
    const body = bm ? stripTags(bm[1]) : "";
    const pm = /data-post="([^"]+)"/.exec(chunk);
    const page = "https://t.me/" + (pm ? pm[1] : ch);
    for (const c of codes) {
      out.push({ source: "TG @" + ch, code: c, appName: "", page, context: body.slice(0, 300) });
    }
  }
  return out;
}

export async function probeAppstore(appId, opts = {}) {
  const url = "https://itunes.apple.com/lookup?id=" + appId + "&country=cn";
  const [st, text] = await httpGet(url, opts);
  if (st !== 200) return { error: "HTTP " + st };
  try {
    const r = (JSON.parse(text).results || [])[0];
    if (!r) return { error: "lookup 返回空" };
    return {
      version: r.version || "",
      name: r.trackName || "",
      releaseDate: String(r.currentVersionReleaseDate || "").slice(0, 10),
      trackId: r.trackId,
      url: r.trackViewUrl || "",
    };
  } catch (e) {
    return { error: "解析失败 " + e };
  }
}

/**
 * 按名字搜 App Store（拿 App Store id 与 bundle id）。
 *
 * 返回 `{ hits, error }` 而不是裸数组 —— 必须能区分
 * **「确实没这个 App」**和**「这次查询失败了」**：
 * 前者可以安心不填，后者若也说成"没搜到"，用户会误以为这 App 不在 App Store。
 */
export async function probeItunesSearch(term, opts = {}) {
  const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(term) +
    "&country=cn&entity=software&limit=8";
  const [st, text] = await httpGet(url, opts);
  if (st !== 200) return { hits: [], error: st === 0 ? text : "HTTP " + st };
  try {
    const hits = (JSON.parse(text).results || []).map((r) => ({
      trackId: r.trackId,
      trackName: r.trackName || "",
      bundleId: r.bundleId || "",
      version: r.version || "",
      url: r.trackViewUrl || "",
    }));
    return { hits, error: "" };
  } catch (e) {
    return { hits: [], error: "解析失败 " + (e && e.message) };
  }
}

/**
 * 按名字搜 departures.to。
 * ⚠️ 参数名是 `searchTerm`（**不是 `q`**）—— `?q=` 会被静默忽略、返回默认列表，
 * 看着像"这站搜不了"，其实是参数名错了。这条是实测出来的。
 */
export async function probeDeparturesSearch(term, opts = {}) {
  const url = "https://departures.to/search?searchTerm=" + encodeURIComponent(term);
  const [st, text] = await httpGet(url, opts);
  if (st !== 200) return { hits: [], error: st === 0 ? text : "HTTP " + st };
  const hits = [];
  const re = /<a href="https:\/\/departures\.to\/apps\/(\d+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<span/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = stripTags(m[2]);
    if (name) hits.push({ appId: m[1], name, page: "https://departures.to/apps/" + m[1] });
  }
  return { hits, error: "" };
}

/**
 * 从应用名派生"发现"用的关键词。
 * 例："番茄小说 - 热门短剧全本小说电子书阅读器" → ["番茄小说", "热门短剧…", 全名]
 * 这样新加的 App 才会被 /scan 的各发现源捞到，而不是只认配置里那一套关键词。
 */
export function deriveKeywords(name, bundleId) {
  const out = new Set();
  const n = String(name || "").trim();
  if (n) {
    out.add(n);
    for (const seg of n.split(/[\-—–:：|(（\[【/,，]/)) {
      const s = seg.trim();
      if (s.length >= 2 && s.length <= 24) out.add(s);
    }
  }
  if (bundleId) out.add(String(bundleId));
  return [...out].slice(0, 4);
}

function nameMatch(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 3;                                        // 完全一致
  if (x.startsWith(y) || y.startsWith(x)) return 2;             // 一个是另一个的前缀
  const head = x.split(/[\-—–:：|(（\[【 ]/)[0].trim();
  if (head.length >= 3 && y.includes(head)) return 1;           // 首段命中
  return 0;
}

/**
 * 给一个 join 码补齐"监控一个 App"要的元数据。
 *
 * 三个来源全自动（都实测可用）：
 *   · join 页本身      → 真实应用名、当前状态
 *   · iTunes 搜索      → App Store id（用来盯正式版号）、bundle id
 *   · departures 搜索  → departures.to 的 app id（用来盯**链接轮换**）
 *
 * 认不准时**不硬猜** —— 留空并在 notes 里说明，让用户用 appstore= / departures= 手动指定。
 * 猜错 App Store id 会让"正式版更新"告警张冠李戴，比不填更糟。
 */
export async function enrichApp({ code, name = "", fetchImpl, log = () => {} } = {}) {
  const info = await probeJoin(code, { fetchImpl });
  const appName = info.appName || info.title || name || "";
  const term = (name || appName || "").trim();
  const out = {
    code, state: info.state, url: info.url, appName,
    desc: info.desc, descHash: info.descHash, checkedAt: info.checkedAt,
    appStoreId: null, bundleId: "", appStoreName: "",
    departuresId: null, departuresName: "",
    keywords: deriveKeywords(appName, ""), notes: [],
  };
  if (!term) {
    out.notes.push("页面里没读到应用名，关键词留空（可手动给：/add <码> <名称>）");
    return out;
  }

  // ── iTunes：App Store id + bundle id ──
  try {
    const { hits, error } = await probeItunesSearch(term, { fetchImpl });
    if (error) out.notes.push(`iTunes 查询失败（${error}）→ 这次没填 App Store id，可以稍后重发 /add 补上`);
    let best = null, bestScore = 0;
    for (const h of hits) {
      const s = nameMatch(h.trackName, appName || term);
      if (s > bestScore) { best = h; bestScore = s; }
    }
    if (best && bestScore >= 1) {
      out.appStoreId = best.trackId;
      out.bundleId = best.bundleId;
      out.appStoreName = best.trackName;
      out.keywords = deriveKeywords(appName, best.bundleId);
      if (bestScore < 3) out.notes.push(`App Store 那条是近似名匹配的：${best.trackName}（不确定就核对一下）`);
    } else if (hits.length) {
      out.notes.push(`iTunes 搜到 ${hits.length} 条但都不像（第一条：${hits[0].trackName}）→ 没填 App Store id`);
    } else if (!error) {
      out.notes.push("iTunes 确实没搜到 → 没填 App Store id（可手动指定 appstore=<id>）");
    }
  } catch (e) {
    out.notes.push("iTunes 搜索失败：" + (e && e.message));
  }

  // ── departures.to：app id（有它才能盯"链接轮换"）──
  try {
    const { hits, error } = await probeDeparturesSearch(appName || term, { fetchImpl });
    if (error) out.notes.push(`departures.to 查询失败（${error}）→ 这次没填 departures id`);
    let best = null, bestScore = 0;
    for (const h of hits) {
      const s = nameMatch(h.name, appName || term);
      if (s > bestScore) { best = h; bestScore = s; }
    }
    if (best && bestScore >= 1) {
      out.departuresId = /^\d+$/.test(best.appId) ? Number(best.appId) : best.appId;
      out.departuresName = best.name;
      if (bestScore < 3) out.notes.push(`departures.to 那条是近似名匹配的：${best.name}（不确定就核对一下）`);
    } else if (hits.length) {
      out.notes.push(`departures.to 搜到 ${hits.length} 条但都不像（第一条：${hits[0].name}）→ 没填 departures id`);
    } else if (!error) {
      out.notes.push("departures.to 没收录这个 App → 没填 departures id（不影响链接状态监控，只是少一层轮换检测）");
    }
  } catch (e) {
    out.notes.push("departures.to 搜索失败：" + (e && e.message));
  }

  log(`  补齐：appStoreId=${out.appStoreId || "无"} bundle=${out.bundleId || "无"} departuresId=${out.departuresId || "无"}`);
  return out;
}

/** 监控中的 App 一览（比 /links 多出"这个 App 都盯了什么"） */
export function renderApps(state) {
  const codes = Object.keys(state.links || {}).sort();
  if (!codes.length) return "还没有监控任何 App。发 /find <名字> 找，或 /add <TestFlight 链接> 直接加。";
  const L = [`<b>监控中的 App（${codes.length} 个）</b>`];
  codes.forEach((code, i) => {
    const r = state.links[code];
    L.push("");
    L.push(`${i + 1}. <b>${esc(r.label || r.appName || code)}</b> — ${STATE_LABEL[r.state] || r.state || "未检查"}`);
    L.push(`   join 码：<code>${esc(code)}</code>`);
    L.push(`   链接：${esc(r.url || "https://testflight.apple.com/join/" + code)}`);
    if (r.appName && r.appName !== r.label) L.push(`   页面上的名字：${esc(r.appName)}`);
    L.push(`   App Store：${r.appStoreId ? esc(r.appStoreId) + (r.bundleId ? "（" + esc(r.bundleId) + "）" : "") : "<i>未关联</i>"}`);
    L.push(`   departures.to：${r.departuresId ? esc(r.departuresId) : "<i>未关联（少一层链接轮换检测）</i>"}`);
    if (r.keywords && r.keywords.length) L.push(`   发现关键词：${esc(r.keywords.slice(0, 4).join(" / "))}`);
    L.push(`   加入：${esc(r.firstSeen || "?")}｜来源：${esc((r.sources || []).join(","))}`);
  });
  L.push("", "加：<code>/add &lt;TestFlight链接&gt;</code>　找：<code>/find &lt;名字&gt;</code>　删：<code>/del &lt;码&gt;</code>");
  return L.join("\n");
}

/**
 * /find —— 按名字查一个 App 的线索，让用户知道能不能加、加哪个。
 * 三个来源：iTunes（App Store id）、departures.to（轮换检测用）、tfstore（TF 码）
 */
export async function findApp({ state, query, fetchImpl, log = () => {} }) {
  const term = String(query || "").trim();
  if (!term) return "用法：<code>/find &lt;App 名字或关键词&gt;</code>";

  const [it, dp, tfs] = await Promise.all([
    probeItunesSearch(term, { fetchImpl }).catch((e) => ({ hits: [], error: e.message })),
    probeDeparturesSearch(term, { fetchImpl }).catch((e) => ({ hits: [], error: e.message })),
    probeTfstore(term, { fetchImpl }).catch(() => []),
  ]);
  const itunes = it.hits || [];
  const deps = dp.hits || [];
  log(`  /find「${term}」iTunes=${itunes.length} departures=${deps.length} tfstore=${tfs.length}` +
    (it.error ? ` iTunes错误=${it.error}` : "") + (dp.error ? ` departures错误=${dp.error}` : ""));

  const L = [`<b>「${esc(term)}」的搜索结果</b>`];
  const watched = new Set(Object.keys(state.links || {}));

  if (itunes.length) {
    L.push("", "<b>App Store</b>");
    for (const a of itunes.slice(0, 4)) {
      L.push(`· ${esc(a.trackName)}`);
      L.push(`  id <code>${esc(a.trackId)}</code>${a.bundleId ? "　bundle <code>" + esc(a.bundleId) + "</code>" : ""}　v${esc(a.version)}`);
    }
  } else {
    L.push("", it.error ? `App Store：查询失败（${esc(it.error)}），稍后重试` : "App Store：没搜到");
  }

  if (tfs.length) {
    L.push("", "<b>tfstore 上有 TestFlight 的</b>");
    for (const t of tfs.slice(0, 5)) {
      const mark = watched.has(t.code) ? "（已在监控）" : "";
      L.push(`· ${esc(t.appName)}${mark}`);
      L.push(`  <code>${esc(t.code)}</code> → 加：<code>/add ${esc(t.code)}</code>`);
    }
  } else {
    L.push("", "tfstore：没有（它只收录一部分 App，不代表没有 TF 版）");
  }

  if (deps.length) {
    L.push("", "<b>departures.to 收录的</b>（有它就能自动盯链接轮换）");
    for (const dp of deps.slice(0, 4)) {
      L.push(`· ${esc(dp.name)} — app id <code>${esc(dp.appId)}</code>`);
    }
  } else {
    L.push("", dp.error
      ? `departures.to：查询失败（${esc(dp.error)}）`
      : "departures.to：没收录（不影响状态监控，只是少一层轮换检测）");
  }

  L.push("", "<b>怎么加</b>",
    "· 已经有 TestFlight 链接 → <code>/add &lt;链接&gt;</code>（App Store id 与 departures id 会自动补齐）",
    "· 想手动指定 → <code>/add &lt;链接&gt; 名称 appstore=&lt;id&gt; departures=&lt;id&gt;</code>");
  return L.join("\n");
}

/** 关键词 = 全局配置 ∪ 各在监控 App 派生的（新加的 App 才会被 /scan 捞到） */
export function effectiveKeywords(cfg, state) {
  const set = new Set(cfg.keywords || []);
  for (const rec of Object.values(state.links || {})) {
    for (const k of rec.keywords || []) set.add(k);
  }
  return [...set];
}

/** 发现扫描用的 tfstore 查询词 = 配置里的 ∪ 各在监控 App 的名字（带上限，别把请求数打爆） */
export function effectiveTfstoreQueries(cfg, state, cap = 8) {
  const out = [...((cfg.discovery && cfg.discovery.tfstoreQueries) || [])];
  for (const rec of Object.values(state.links || {})) {
    const n = String(rec.appName || rec.label || "").split(/[\-—–:：|(（\[【]/)[0].trim();
    if (n && n.length >= 2 && n.length <= 24 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, cap);
}

// ─────────────────────────── 时间 ───────────────────────────

export function nowStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// ─────────────────────────── Telegram 调用 ───────────────────────────

export async function tgCall(cfg, method, params = {}, opts = {}) {
  const token = String((cfg.telegram && cfg.telegram.token) || "").trim();
  const base = String((cfg.telegram && cfg.telegram.apiBase) || "https://api.telegram.org").replace(/\/+$/, "");
  if (!token) throw new Error("配置里没有 telegram.token");
  const f = opts.fetchImpl || fetch;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  const res = await f(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Telegram ${method} 返回非 JSON（HTTP ${res.status}）`);
  }
  if (!json.ok) throw new Error("Telegram API 错误: " + (json.description || res.status));
  return json.result;
}

export function makeNotifier({ cfg, log = () => {}, dryRun = false, fetchImpl }) {
  const token = String((cfg.telegram && cfg.telegram.token) || "").trim();
  const chatId = String((cfg.telegram && cfg.telegram.chatId) || "").trim();
  const dry = dryRun || !token || !chatId;
  return {
    dry,
    async send(text) {
      const { body, degraded, why } = tgPrepare(text);
      if (degraded) log(`⚠️ 消息 HTML 不合法（${why}）→ 已退回纯文本，避免整条被 Telegram 拒收`);
      if (dry) {
        log("[DRY-RUN] " + body);
        return true;
      }
      try {
        await tgCall(cfg, "sendMessage", tgSendParams(chatId, body), { fetchImpl });
        return true;
      } catch (e) {
        log("TG 发送失败: " + e.message);
        try {
          const p = tgSendParams(chatId, htmlToPlain(body).slice(0, 4000));
          delete p.parse_mode;
          await tgCall(cfg, "sendMessage", p, { fetchImpl });
          log("  已用纯文本重发成功");
          return true;
        } catch (e2) {
          log("  纯文本重发也失败: " + e2.message);
          return false;
        }
      }
    },
  };
}

// ─────────────────────────── 状态与去重 ───────────────────────────

export function emptyState() {
  return { links: {}, discoveries: {}, appstore: {}, meta: {} };
}

export function normalizeState(s) {
  const d = s && typeof s === "object" ? s : {};
  d.links = d.links || {};
  d.discoveries = d.discoveries || {};
  d.appstore = d.appstore || {};
  d.meta = d.meta || {};
  return d;
}

export function knownCodes(cfg) {
  return new Set((cfg.watch || []).map((w) => w && w.code).filter(Boolean));
}

export function monitorTargets(cfg, state) {
  const out = {};
  for (const w of cfg.watch || []) {
    if (w && w.code) {
      out[w.code] = { label: w.label || w.code, appStoreId: w.appStoreId, departuresId: w.departuresId };
    }
  }
  for (const [code, rec] of Object.entries(state.links || {})) {
    if (!out[code]) {
      out[code] = { label: rec.label || code, appStoreId: rec.appStoreId, departuresId: rec.departuresId };
    }
  }
  return out;
}

export function relevant(cfg, text) {
  const kws = cfg.keywords || [];
  if (!kws.length) return true;
  const low = String(text || "").toLowerCase();
  return kws.some((k) => low.includes(String(k).toLowerCase()));
}

// ─────────────────────────── 监控 ───────────────────────────

export async function runMonitor({ cfg, state, notifier, log = () => {}, fetchImpl }) {
  let events = 0;
  const targets = monitorTargets(cfg, state);
  log(`监控 ${Object.keys(targets).length} 个链接…`);

  for (const [code, meta] of Object.entries(targets).sort()) {
    const rec = (state.links[code] = state.links[code] || {});
    if (!rec.firstSeen) rec.firstSeen = nowStr();
    if (!rec.label) rec.label = meta.label;
    if (!rec.sources) rec.sources = ["manual"];
    if (meta.appStoreId) rec.appStoreId = meta.appStoreId;
    if (meta.departuresId) rec.departuresId = meta.departuresId;

    const info = await probeJoin(code, { fetchImpl });
    const oldState = rec.state;
    const oldDesc = rec.desc;
    Object.assign(rec, {
      state: info.state, stateBasis: info.stateBasis, http: info.http, title: info.title,
      appName: info.appName || rec.appName || "", desc: info.desc, descHash: info.descHash,
      head: info.head, statusText: info.statusText, lastChecked: info.checkedAt,
    });
    if (info.error) rec.lastError = info.error;
    else delete rec.lastError;
    log(`  ${code} → ${STATE_LABEL[info.state] || info.state}${info.error ? "  (" + info.error + ")" : ""}`);

    if (oldState !== info.state) {
      rec.stateSince = nowStr();
      if (oldState !== undefined || info.state !== "open") {
        const msg = [
          `<b>${esc(rec.label || code)} TF 链接状态变化</b>`,
          `链接：${esc(info.url)}`,
          `状态：${STATE_LABEL[oldState] || "首次监控"} → <b>${STATE_LABEL[info.state] || info.state}</b>`,
        ];
        if (info.appName) msg.push(`应用：${esc(info.appName)}`);
        if (info.error) msg.push(`错误：${esc(info.error)}`);
        if (["full", "closed", "invalid"].includes(info.state)) {
          // 把 Apple 的原文也带上：万一页面语言不是中/英，这行就是唯一线索
          if (info.statusText) msg.push(`Apple 原文：${esc(info.statusText.slice(0, 160))}`);
          if (info.stateBasis === "title") {
            msg.push("（这个状态是按页面结构推断的，不是读到措辞 —— 页面语言可能不是中/英）");
          }
          msg.push("", "💡 名额用完/链接失效时，开发者通常会另开一个公测链接。发 /scan 让我去各发现源找找有没有新 join 码。");
        }
        msg.push(`时间：${nowStr()}`);
        if (await notifier.send(msg.join("\n"))) events++;
      }
    }

    if (oldDesc && info.desc && oldDesc !== info.desc) {
      const msg = [
        `<b>${esc(rec.label || code)} TF 页面文案有变化</b>（可能对应新构建/新公告）`,
        `链接：${esc(info.url)}`,
        `旧：${esc(oldDesc.slice(0, 200))}`,
        `新：${esc(info.desc.slice(0, 200))}`,
        `时间：${nowStr()}`,
      ];
      if (await notifier.send(msg.join("\n"))) events++;
    }

    const depId = rec.departuresId;
    if (depId && cfg.discovery && cfg.discovery.useDepartures !== false) {
      const dep = await probeDepartures(depId, { fetchImpl });
      rec.departures = { status: dep.status, url: dep.url, checkedAt: nowStr() };
      if (!dep.code) {
        log(`  ⚠️ departures.to app ${depId} 没取到 join 码：${dep.error || "页面里没有 url 字段"}`);
      } else if (dep.code !== code) {
        events += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, {
          source: `departures.to (app ${depId})`,
          code: dep.code,
          appName: dep.appName || "",
          page: dep.page || "",
          context: `departures.to 上这个 app 的 join 码已换成 ${dep.code}（原 ${code}）`,
        });
      }
    }
  }

  // App Store 正式版号
  const seen = new Set();
  for (const rec of Object.values(state.links)) {
    const aid = rec.appStoreId;
    if (!aid || seen.has(aid)) continue;
    seen.add(aid);
    const cur = await probeAppstore(aid, { fetchImpl });
    if (cur.error) {
      log("  App Store lookup 失败: " + cur.error);
      continue;
    }
    const old = state.appstore[String(aid)] || {};
    state.appstore[String(aid)] = { version: cur.version, checkedAt: nowStr(), name: cur.name };
    if (old.version && old.version !== cur.version) {
      const msg = [
        `<b>App Store 正式版更新</b>：${esc(cur.name)}`,
        `版本：${esc(old.version)} → <b>${esc(cur.version)}</b>`,
        `上架日期：${esc(cur.releaseDate)}`,
        "注意：正式版更新 ≠ TF 构建更新。TF 构建号只能在 TestFlight App 里看到。",
        `时间：${nowStr()}`,
      ];
      if (await notifier.send(msg.join("\n"))) events++;
    } else if (!old.version) {
      log(`  记录 ${cur.name || aid} 正式版基线：${cur.version}`);
    }
  }

  state.meta.lastCheck = nowStr();
  log(`本轮结束，产生 ${events} 条事件。`);
  return events;
}

// ─────────────────────────── 发现 ───────────────────────────

export async function registerDiscovery({ cfg, state, notifier, log = () => {}, fetchImpl }, item) {
  const code = item.code;
  if (!code) return 0;
  if (state.links[code] || state.discoveries[code] || knownCodes(cfg).has(code)) return 0;

  const info = await probeJoin(code, { fetchImpl });
  item.state = info.state;
  item.foundAt = nowStr();
  item.appName = item.appName || info.appName || info.title || "";
  state.discoveries[code] = item;

  const aw = cfg.autoWatchKeywords || [];
  const blob = ((item.appName || "") + " " + (item.context || "")).toLowerCase();
  const autoOk = !aw.length || aw.some((k) => blob.includes(String(k).toLowerCase()));
  const watched = !!cfg.autoWatchDiscovered && autoOk && info.state === "open";
  if (watched) {
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label: item.appName || code, firstSeen: nowStr(), sources: [item.source],
      state: info.state, url: info.url, appName: info.appName, desc: info.desc,
      descHash: info.descHash, lastChecked: info.checkedAt,
    });
    if (!rec.stateSince) rec.stateSince = nowStr();
  }

  const msg = [
    "<b>🆕 发现新的 TF 链接</b>",
    `join 码：<code>${esc(code)}</code>`,
    `链接：${esc(info.url)}`,
    `当前状态：<b>${STATE_LABEL[info.state] || info.state}</b>`,
  ];
  if (item.appName) msg.push(`应用：${esc(item.appName)}`);
  msg.push(`来源：${esc(item.source || "")}`);
  if (item.context) msg.push(`上下文：${esc(String(item.context).slice(0, 200))}`);
  if (watched) msg.push("已自动加入监控列表。");
  else if (info.state === "open") msg.push(`（未自动加入监控：应用名没命中 autoWatchKeywords。要盯就发 /add ${esc(code)}）`);
  msg.push(`时间：${nowStr()}`);
  return (await notifier.send(msg.join("\n"))) ? 1 : 0;
}

/**
 * 发现扫描。
 *
 * `onlySource` 是给 **Cloudflare 免费版 10ms CPU 限制**用的：
 * 一次只跑一个源，用 state.meta.discoveryCursor 轮转。
 * 传 null/undefined 则全跑（Vercel / 本地 / 付费版）。
 */
export async function runDiscovery({ cfg, state, notifier, log = () => {}, fetchImpl, onlySource = undefined }) {
  const d = cfg.discovery || {};
  let events = 0;

  // 关键词与 tfstore 查询词都要**并上各在监控 App 自己派生的** ——
  // 否则新加一个 App，发现源仍然只按番茄那套词过滤，等于白加。
  const kws = effectiveKeywords(cfg, state);
  const isRelevant = (t) => relevant({ keywords: kws }, t);
  log(`  关键词 ${kws.length} 个：${kws.slice(0, 6).join(" / ")}${kws.length > 6 ? " …" : ""}`);

  const sources = [];
  const depIds = new Set(d.departuresApps || []);
  for (const rec of Object.values(state.links || {})) {
    if (rec.departuresId) depIds.add(rec.departuresId);
  }
  if (d.useDepartures !== false && depIds.size) {
    sources.push({
      name: "departures",
      run: async () => {
        let n = 0;
        for (const aid of [...depIds].sort()) {
          const dep = await probeDepartures(aid, { fetchImpl });
          log(`  departures.to app ${aid} → 状态=${dep.status || dep.error || "?"} join码=${dep.code || "无"}`);
          if (dep.code) {
            n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, {
              source: `departures.to (app ${aid})`, code: dep.code, appName: dep.appName || "",
              page: dep.page || "", context: `departures.to 状态：${dep.status || ""}`,
            });
          }
        }
        return n;
      },
    });
  }
  for (const q of effectiveTfstoreQueries(cfg, state)) {
    sources.push({
      name: `tfstore:${q}`,
      run: async () => {
        let n = 0;
        const hits = await probeTfstore(q, { fetchImpl });
        log(`  tfstore「${q}」→ ${hits.length} 条`);
        for (const h of hits) {
          if (isRelevant(h.appName)) n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, h);
        }
        return n;
      },
    });
  }
  for (const q of d.webQueries || []) {
    if (d.useBing !== false) {
      sources.push({
        name: `bing:${q}`,
        run: async () => {
          let n = 0;
          const hits = await probeBing(q, { fetchImpl });
          log(`  Bing「${q}」→ ${hits.length} 条含 join 码`);
          for (const h of hits) {
            if (isRelevant((h.context || "") + " " + (h.appName || ""))) {
              n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, h);
            }
          }
          return n;
        },
      });
    }
    if (d.useSo360 !== false) {
      sources.push({
        name: `so360:${q}`,
        run: async () => {
          let n = 0;
          const hits = await probeSo360(q, { fetchImpl });
          log(`  360搜索「${q}」→ ${hits.length} 条含 join 码`);
          for (const h of hits) {
            if (isRelevant((h.context || "") + " " + (h.appName || ""))) {
              n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, h);
            }
          }
          return n;
        },
      });
    }
  }
  for (const ch of d.telegramChannels || []) {
    sources.push({
      name: `tg:${ch}`,
      run: async () => {
        let n = 0;
        const hits = await probeTgChannel(ch, { fetchImpl });
        log(`  TG @${ch} → ${hits.length} 条含 join 码`);
        for (const h of hits) {
          if (isRelevant(h.context || "")) {
            n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, h);
          }
        }
        return n;
      },
    });
  }

  if (!sources.length) {
    log("没有启用任何发现源。");
    return 0;
  }

  if (onlySource === undefined || onlySource === null) {
    log(`开始发现扫描（全 ${sources.length} 个源）…`);
    for (const s of sources) events += await s.run();
  } else {
    const idx = ((Number(state.meta.discoveryCursor) || 0) % sources.length + sources.length) % sources.length;
    const s = sources[idx];
    log(`开始发现扫描（轮转 ${idx + 1}/${sources.length}：${s.name}）…`);
    events += await s.run();
    state.meta.discoveryCursor = (idx + 1) % sources.length;
  }

  state.meta.lastScan = nowStr();
  log(`发现扫描结束，新增 ${events} 条。`);
  return events;
}

// ─────────────────────────── 报表 ───────────────────────────

export function renderStatus(cfg, state) {
  const L = ["<b>tg-tf-monitor 当前状态</b>",
    `上次监控：${esc(state.meta.lastCheck || "从未")}`,
    `上次发现扫描：${esc(state.meta.lastScan || "从未")}`, ""];
  const codes = Object.keys(state.links || {});
  if (!codes.length) L.push("（监控列表为空，检查配置里的 watch）");
  for (const code of codes.sort()) {
    const rec = state.links[code];
    L.push(`· <b>${esc(rec.label || code)}</b> ${STATE_LABEL[rec.state] || rec.state || "未检查"}`);
    L.push(`  <code>${esc(code)}</code>`);
    L.push(`  ${esc(rec.url || "https://testflight.apple.com/join/" + code)}`);
    if (rec.stateSince) L.push(`  状态自 ${esc(rec.stateSince)} 起`);
    if (rec.lastChecked) L.push(`  上次检查 ${esc(rec.lastChecked)}`);
    if (rec.departures && rec.departures.status) L.push(`  departures.to 认为：${esc(rec.departures.status)}`);
    if (rec.lastError) L.push(`  ⚠️ ${esc(rec.lastError)}`);
  }
  for (const [aid, a] of Object.entries(state.appstore || {})) {
    L.push(`· App Store 正式版（id ${esc(aid)}）：${esc(a.version || "?")}（检查于 ${esc(a.checkedAt || "?")}）`);
  }
  return L.join("\n");
}

export function renderLinks(state) {
  const links = Object.keys(state.links || {});
  const disc = Object.keys(state.discoveries || {});
  if (!links.length && !disc.length) return "还没有任何记录。";
  const L = ["<b>已知 join 码</b>"];
  for (const code of links.sort()) {
    const rec = state.links[code];
    L.push(`· <code>${esc(code)}</code> ${esc(rec.label || "")}（监控中，${STATE_LABEL[rec.state] || rec.state || "未检查"}）`);
  }
  if (disc.length) {
    L.push("", "<b>历史发现（未在监控）</b>");
    for (const code of disc.sort()) {
      const d = state.discoveries[code];
      L.push(`· <code>${esc(code)}</code> ${esc(d.appName || "")}（${esc(d.source || "")}，${STATE_LABEL[d.state] || d.state || "?"}）`);
    }
  }
  return L.join("\n");
}

export const HELP = `<b>tg-tf-monitor 命令</b>

<b>加 App</b>
/find &lt;名字&gt; — 按名字搜 App Store id / departures.to / tfstore 上的 TF 码
/add &lt;TestFlight链接&gt; [名称] [appstore=&lt;id&gt;] [departures=&lt;id&gt;]
    加一个 App 进监控。App Store id、bundle id、departures.to id 会**自动补齐**
/apps — 看监控中的 App 都盯了什么
/del &lt;码&gt; — 移出监控

<b>看状态</b>
/status — 当前监控状态
/links — 列出已知 join 码（含历史发现）
/check — 立刻跑一轮监控
/scan — 立刻跑一轮发现扫描
/sources — 查看发现源与关键词配置

<b>其它</b>
/test — 发一条测试消息
/help — 这条帮助

链接状态含义：
可加入 ✅ / 已满员 ⛔ / 已关闭 🚫 / 链接失效 ❌

加进来的 App 会被盯：链接状态、App Store 正式版号、departures.to 链接轮换；
/scan 时也会按它自己的名字关键词去找新的 join 码。`;

// ─────────────────────────── 命令 ───────────────────────────

export async function handleCommand({ cfg, state, notifier, text, chatId, log = () => {}, fetchImpl, runner }) {
  const allowed = String((cfg.telegram && cfg.telegram.chatId) || "").trim();
  if (allowed && String(chatId) !== allowed) {
    log(`忽略来自非授权会话 ${chatId} 的命令`);
    return;
  }
  const parts = String(text || "").trim().split(/\s+/);
  if (!parts.length || !parts[0]) return;
  const cmd = parts[0].split("@")[0].toLowerCase();
  log("收到命令：" + cmd);
  const run = runner || { runMonitor, runDiscovery };

  if (cmd === "/start" || cmd === "/help") {
    await notifier.send(HELP);
  } else if (cmd === "/status") {
    await notifier.send(renderStatus(cfg, state));
  } else if (cmd === "/links") {
    await notifier.send(renderLinks(state));
  } else if (cmd === "/check") {
    await notifier.send("开始监控检查…");
    const n = await run.runMonitor({ cfg, state, notifier, log, fetchImpl });
    await notifier.send(`检查完成，${n === 0 ? "无变化" : "产生 " + n + " 条事件"}。`);
  } else if (cmd === "/scan") {
    await notifier.send("开始发现扫描…");
    const n = await run.runDiscovery({ cfg, state, notifier, log, fetchImpl });
    await notifier.send(`扫描完成，${n === 0 ? "没有新发现" : "新增 " + n + " 条"}。`);
  } else if (cmd === "/test") {
    await notifier.send(`✅ 测试消息：机器人工作正常（${nowStr()}）`);
  } else if (cmd === "/sources") {
    const d = cfg.discovery || {};
    await notifier.send([
      "<b>发现源配置</b>",
      `departures.to apps：${esc(JSON.stringify(d.departuresApps || []))}`,
      `tfstore 查询：${esc(JSON.stringify(effectiveTfstoreQueries(cfg, state)))}`,
      `网页搜索查询：${esc(JSON.stringify(d.webQueries || []))}`,
      `  引擎：Bing=${esc(d.useBing !== false)} / 360=${esc(d.useSo360 !== false)}`,
      `TG 频道：${esc(JSON.stringify(d.telegramChannels || []))}`,
      `推送关键词：${esc(JSON.stringify(cfg.keywords || []))}`,
      `自动监控关键词：${esc(JSON.stringify(cfg.autoWatchKeywords || []))}`,
      `自动监控新发现：${esc(cfg.autoWatchDiscovered)}`,
      `监控间隔：${esc(cfg.intervalMinutes)} 分钟`,
    ].join("\n"));
  } else if (cmd === "/add") {
    if (parts.length < 2) {
      await notifier.send("用法：<code>/add &lt;TestFlight链接或join码&gt; [名称] [appstore=&lt;id&gt;] [departures=&lt;id&gt;]</code>\n" +
        "不知道链接？先发 <code>/find &lt;App名字&gt;</code>");
      return;
    }
    const arg = parts[1].trim();
    const code = firstJoinCode(arg) || arg;
    if (!JOIN_CODE_RE.test(code)) {
      await notifier.send(
        `这看着不是 TestFlight join 码：${esc(arg)}\n` +
        `· 想按名字找 → <code>/find ${esc(arg.slice(0, 30))}</code>\n` +
        `· join 码长这样：<code>dTUO1uyt</code>（6-14 位字母数字）`
      );
      return;
    }

    // 名称与可选的手动指定：/add <码> 名称 appstore=123 departures=456
    const opts = {};
    const nameParts = [];
    for (const t of parts.slice(2)) {
      const m = /^(appstore|departures|bundle)=(.+)$/i.exec(t);
      if (m) opts[m[1].toLowerCase()] = m[2].trim();
      else nameParts.push(t);
    }
    const givenName = nameParts.join(" ").trim();

    await notifier.send(`正在补齐 <code>${esc(code)}</code> 的信息（探测链接 + 查 App Store + 查 departures.to）…`);

    const e = await enrichApp({ code, name: givenName, fetchImpl, log });
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label: givenName || e.appName || code,
      appName: e.appName || rec.appName || "",
      firstSeen: rec.firstSeen || nowStr(),
      sources: [...new Set([...(rec.sources || []), "manual"])],
      state: e.state, url: e.url, desc: e.desc, descHash: e.descHash, lastChecked: e.checkedAt,
      keywords: e.keywords || [],
    });
    if (opts.appstore) { rec.appStoreId = /^\d+$/.test(opts.appstore) ? Number(opts.appstore) : opts.appstore; rec.appStoreSource = "manual"; }
    else if (e.appStoreId) { rec.appStoreId = e.appStoreId; rec.appStoreSource = "auto"; }
    if (opts.bundle) rec.bundleId = opts.bundle;
    else if (e.bundleId) rec.bundleId = e.bundleId;
    if (opts.departures) { rec.departuresId = /^\d+$/.test(opts.departures) ? Number(opts.departures) : opts.departures; rec.departuresSource = "manual"; }
    else if (e.departuresId) { rec.departuresId = e.departuresId; rec.departuresSource = "auto"; }
    if (!rec.stateSince) rec.stateSince = nowStr();

    const L = [
      `✅ 已加入监控：<b>${esc(rec.label)}</b>`,
      `join 码：<code>${esc(code)}</code>　状态：<b>${STATE_LABEL[e.state] || e.state}</b>`,
      `链接：${esc(e.url)}`,
      `App Store：${rec.appStoreId ? esc(rec.appStoreId) + (rec.bundleId ? "（" + esc(rec.bundleId) + "）" : "") + (rec.appStoreSource === "auto" ? " <i>自动匹配</i>" : "") : "<i>未关联</i>"}`,
      `departures.to：${rec.departuresId ? esc(rec.departuresId) + (rec.departuresSource === "auto" ? " <i>自动匹配</i>" : "") : "<i>未关联</i>"}`,
      `发现关键词：${esc((rec.keywords || []).join(" / ") || "（无）")}`,
    ];
    if (e.notes && e.notes.length) {
      L.push("", "<b>需要留意</b>");
      for (const n of e.notes) L.push("· " + esc(n));
    }
    L.push("", "现在这个 App 会被：每轮查链接状态、App Store 正式版号" +
      (rec.departuresId ? "、departures.to 链接轮换" : "") +
      "；<code>/scan</code> 时也会按它的关键词去找新链接。");
    L.push("看全部：<code>/apps</code>");
    await notifier.send(L.join("\n"));
  } else if (cmd === "/apps" || cmd === "/app") {
    await notifier.send(renderApps(state));
  } else if (cmd === "/find") {
    if (parts.length < 2) {
      await notifier.send("用法：<code>/find &lt;App 名字或关键词&gt;</code>");
      return;
    }
    await notifier.send(`正在搜「${esc(parts.slice(1).join(" "))}」…`);
    await notifier.send(await findApp({ state, query: parts.slice(1).join(" "), fetchImpl, log }));
  } else if (cmd === "/del" && parts.length >= 2) {
    let code = parts[1].trim().replace(/^\//, "");
    code = firstJoinCode(code) || code;
    if (state.links[code]) {
      delete state.links[code];
      await notifier.send(`已移出监控：<code>${esc(code)}</code>`);
    } else {
      await notifier.send(`监控列表里没有 <code>${esc(code)}</code>`);
    }
  } else {
    await notifier.send("未知命令。发 /help 看用法。");
  }
}
