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
  // departures.to 的页面标题形如「番茄小说 TestFlight Beta — Departures」，
  // 直接拿来当名字很难看 —— 把这两个壳一起剥掉。
  t = t.replace(/\s*[—–-]\s*Departures\s*$/i, "");
  t = t.replace(/\s+TestFlight(\s+Beta)?\s*$/i, "");
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

/**
 * 这些状态码值得重试：429 是限流、5xx 是对方抖动。
 *
 * ⚠️ 为什么特别在意 429：Cloudflare 的出口 IP 是**全平台共享**的，
 * 而 iTunes 是按 IP 限流的 —— 所以 Worker 调 `itunes.apple.com` 被 429 是常态，
 * 而同一时刻从自己电脑调同一个接口是好的（实测：本机 3/3 成功）。
 * 重试能救短时突发；持续限流救不了，所以调用方还要给出可执行的替代方案。
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function httpGet(url, { fetchImpl, timeoutMs = 25000, headers = {}, retries = 2, retryBaseMs = 350 } = {}) {
  const f = fetchImpl || fetch;
  let last = [0, "未发起请求"];
  for (let attempt = 0; attempt <= retries; attempt++) {
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
      last = [res.status, text];
      if (!RETRYABLE.has(res.status) || attempt === retries) return last;
    } catch (e) {
      last = [0, String((e && e.message) || e)];
      if (attempt === retries) return last;
    } finally {
      clearTimeout(timer);
    }
    // 退避：350ms / 700ms（Worker 里 setTimeout 可用，且 webhook 走 waitUntil 不占响应时间）
    await new Promise((r) => setTimeout(r, retryBaseMs * (attempt + 1)));
  }
  return last;
}

// ─────────────────────────── 探针 ───────────────────────────

export async function probeJoin(code, opts = {}) {
  const url = "https://testflight.apple.com/join/" + code;
  const [st, text] = await httpGet(url, opts);
  const out = parseJoinPage(text, st, st === 0 ? text : "");
  out.code = code;
  out.url = url;
  out.checkedAt = nowStamp();
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
  if (tm) out.appName = cleanAppName(tm[1]);

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
/**
 * 列表顺序：**按加入时间，先加的在前**（没有时间的排最后，再按码）。
 *
 * 为什么不按名字排：中文用 `<` 比的是**码点**，不是字典序 ——
 * `阿里云盘`(U+963F) 会排在 `番茄`(U+756A) 后面，对人不构成"按名字排"。
 * 要真正的拼音序得靠 `Intl.Collator("zh")`，那又要赌 Worker 的 ICU 数据（不可靠）。
 * 按加入时间则：确定、不依赖 ICU、而且**改名字时顺序不会跳**。
 */
function sortCodesByLabel(state) {
  const key = (c) => {
    const t = parseStamp((state.links[c] || {}).firstSeen);
    return t ? t.getTime() : Number.POSITIVE_INFINITY;
  };
  return Object.keys(state.links || {}).sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function renderApps(state) {
  // 按**加入时间**排（见 sortCodesByLabel 的说明）
  const codes = sortCodesByLabel(state);
  if (!codes.length) return "还没有监控任何 App。发 /find <名字> 找，或 /add <TestFlight 链接> 直接加。";
  const L = [`<b>监控中的 App（${codes.length} 个）</b>`];
  codes.forEach((code, i) => {
    const r = state.links[code];
    const url = r.url || "https://testflight.apple.com/join/" + code;
    L.push("");
    L.push(`${i + 1}. <b>${esc(r.label || r.appName || code)}</b> — ${STATE_LABEL[r.state] || r.state || "未检查"}`);
    L.push(`   ${esc(url)}`);
    // 一行说清"绑了什么"：绑定决定了有没有版本告警 / 链接轮换检测
    const asv = r.appStoreId ? state.appstore[String(r.appStoreId)] : null;
    const bits = [];
    if (asv && asv.version) {
      const d = daysAgo(asv.releaseDate);
      const day = String(asv.releaseDate || "").slice(0, 10);
      bits.push(`正式版 ${esc(asv.version)}${day ? "（" + esc(day.slice(5)) + " 上架" + (d === null ? "" : "，" + d + " 天前") + "）" : ""}`);
    }
    bits.push(r.appStoreId ? `App Store ${esc(r.appStoreId)}` : "未绑 App Store");
    bits.push(r.departuresId ? `departures ${esc(r.departuresId)}` : "未绑 departures");
    L.push(`   ${bits.join(" ｜ ")}`);
    // 缺绑定压成一行说清"少了什么能力"，而不是两条各说一半
    const missing = [];
    if (!r.appStoreId) missing.push("版本更新告警");
    if (!r.departuresId) missing.push("链接轮换检测");
    if (missing.length) {
      L.push(`   ⚠️ 没绑 ${[!r.appStoreId && "App Store", !r.departuresId && "departures"].filter(Boolean).join(" / ")} id` +
        ` → 少了：${missing.join("、")}（重新 /add 一次可自动补）`);
    }
    // 「加入」保留：回答"我什么时候开始盯的"。
    // 「来源」只在**不是** manual 时才显示 —— 自己加的 App 写"来源 manual"是废话。
    const srcs = (r.sources || []).filter((x) => x && x !== "manual");
    // 措辞用"加入监控"而不是"加入" —— 它就在"可加入 ✅"下面，
    // 写"加入 16:17"会被读成"16:17 加入了测试"，语义完全不同。
    L.push(`   加入监控 ${esc(fmtStamp(r.firstSeen) || "?")}${srcs.length ? " ｜ 来源 " + esc(srcs.join(",")) : ""}`);
  });
  return L.join("\n");
}

/**
 * /find —— 按名字查一个 App 的线索，让用户知道能不能加、加哪个。
 * 三个来源：iTunes（App Store id）、departures.to（轮换检测用）、tfstore（TF 码）
 */
/**
 * 按名字把条目分组。
 *
 * 为什么需要：同一个 App 在 tfstore / departures 上常有多条记录
 * （多个 TF 码、多个 app id），平铺出来就是"怎么有这么多"。
 * 分组后一眼能看出"其实只有两个 App"。
 */
export function groupByName(items, nameOf) {
  const map = new Map();
  for (const it of items || []) {
    const k = String(nameOf(it) || "").trim() || "(未命名)";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return [...map.entries()].map(([name, list]) => ({ name, items: list }));
}

/**
 * /find 结果末尾那几句"提醒"。抽成纯函数是为了能直接测 ——
 * 这几句的价值全在**判断条件**上，而判断条件靠读代码是看不出对错的。
 *
 * 两种情况要分开说，因为对用户的意义完全不同：
 *   1. App Store 里**有**名字正好是这个的，但两个 TF 来源都没有它的码
 *      -> "它没走公开 TestFlight 分发"（实测：搜「微信」就是这个情况）
 *   2. 连 App Store 都没有正好同名的 -> 说明搜索是**子串匹配**，别以为漏了
 */
/**
 * 从 `/add` 的参数里认出"departures app id"。
 * 支持 `dep=21038` / `departures=21038` / `https://departures.to/apps/21038`。
 * 为什么要这个：departures 的 app 页里**带着 join 链接**，所以给 id 就能反解出码 ——
 * 用户看到"app id 21038"时应该能直接加，而不是被迫先去别处找码。
 */
export function parseDeparturesArg(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return "";
  let m = /^dep(?:artures)?[=:]([A-Za-z0-9]+)$/i.exec(t);
  if (m) return m[1];
  m = /departures\.to\/apps\/([A-Za-z0-9]+)/i.exec(t);
  if (m) return m[1];
  return "";
}

/**
 * 把 tfstore 的码和 departures 反解出来的码**按码合并**。
 * 同一份链接经常两边都有（实测：微信读书的 7Jg9MM8h 在两边都是它），
 * 不合并就会重复展示、看着像两个不同的东西。
 */
export function mergeFindResults(tfs = [], depResolved = []) {
  const byCode = new Map();
  const put = (code, appName, departuresId) => {
    const c = String(code || "").trim();
    if (!c) return;
    const cur = byCode.get(c) || { code: c, appName: "", departuresId: "" };
    if (!cur.appName && appName) cur.appName = String(appName).trim();
    if (!cur.departuresId && departuresId) cur.departuresId = String(departuresId);
    byCode.set(c, cur);
  };
  for (const t of tfs || []) put(t.code, t.appName, "");
  for (const d of depResolved || []) put(d.code, d.appName, d.appId);
  return [...byCode.values()];
}

export function findHints({ term, itunes = [], tfs = [], deps = [] }) {
  const t = String(term || "").trim();
  if (!t) return [];
  const eq = (n) => String(n || "").trim() === t;
  const exactItunes = (itunes || []).find((a) => eq(a.trackName));
  const tfNames = [...(tfs || []).map((x) => x.appName), ...(deps || []).map((x) => x.name)];
  const exactTf = tfNames.some(eq);
  const out = [];
  if (exactItunes && !exactTf) {
    out.push(`ℹ️ App Store 里有「${esc(t)}」本体（id <code>${esc(exactItunes.trackId)}</code>），` +
      `但 tfstore / departures 都没有它的公开 TF 链接 —— 说明它没走公开 TestFlight 分发。`);
  } else if (!exactItunes && !exactTf && tfNames.length) {
    out.push(`ℹ️ 没有名字正好是「${esc(t)}」的 —— 上面都是名字里<b>含</b>「${esc(t)}」的其他 App。`);
  }
  return out;
}

/**
 * 按名字搜三路（App Store / departures / tfstore），把 departures 的 app 页反解成码，
 * 再给每个码补上真实状态。
 *
 * 抽出来是为了让 `/find`（只查）和 `/add <名字>`（查完就加）**用同一套逻辑** ——
 * 两边各写一份的话，迟早会出现"find 搜得到、add 搜不到"这种不一致。
 */
export async function lookupByName({ term, fetchImpl, log = () => {} }) {
  const [it, dp, tfs] = await Promise.all([
    probeItunesSearch(term, { fetchImpl }).catch((e) => ({ hits: [], error: e.message })),
    probeDeparturesSearch(term, { fetchImpl }).catch((e) => ({ hits: [], error: e.message })),
    probeTfstore(term, { fetchImpl }).catch(() => []),
  ]);
  const itunes = it.hits || [];
  const deps = dp.hits || [];
  log(`  搜「${term}」iTunes=${itunes.length} departures=${deps.length} tfstore=${tfs.length}` +
    (it.error ? ` iTunes错误=${it.error}` : "") + (dp.error ? ` departures错误=${dp.error}` : ""));

  // departures 的 app 页里带着 join 链接 —— 反解出码才能给出"能直接点"的命令
  const depResolved = (await Promise.all(deps.slice(0, 6).map(async (d) => {
    try {
      const r = await probeDepartures(d.appId, { fetchImpl });
      return r && r.code ? { code: r.code, appName: r.appName || d.name, appId: d.appId } : null;
    } catch {
      return null;
    }
  }))).filter(Boolean);

  // 按码合并两个来源（同一份链接常常两边都有），再补状态
  const merged = mergeFindResults(tfs, depResolved);
  const withStatus = await Promise.all(merged.slice(0, 8).map(async (m) => {
    try {
      const j = await probeJoin(m.code, { fetchImpl });
      return { ...m, state: j.state };
    } catch {
      return { ...m, state: "" };
    }
  }));
  return { itunes, itErr: it.error || "", deps, depErr: dp.error || "", merged: withStatus };
}

/** 状态优先级：能进的排前面。`/add <名字>` 靠它挑"最值得加"的那个码。 */
const STATE_RANK = { open: 0, full: 1, closed: 2, invalid: 3, error: 4 };
export function pickBestLink(items) {
  const list = [...(items || [])];
  list.sort((a, b) => {
    const ra = STATE_RANK[a.state] === undefined ? 9 : STATE_RANK[a.state];
    const rb = STATE_RANK[b.state] === undefined ? 9 : STATE_RANK[b.state];
    if (ra !== rb) return ra - rb;
    return String(a.code) < String(b.code) ? -1 : 1;   // 同状态时顺序确定
  });
  return list[0] || null;
}

/**
 * 按名字挑出候选 App。优先**精确同名**，没有再退回"名字里含关键词"。
 * 返回按 App 名分好的组 —— 组数 > 1 就说明"这个名字有歧义"，不能替用户瞎选。
 */
export function matchAppsByName(entries, term) {
  const t = String(term || "").trim().toLowerCase();
  if (!t) return [];
  const exact = [], partial = [];
  for (const e of entries || []) {
    const n = String(e.appName || "").trim();
    if (!n) continue;
    const ln = n.toLowerCase();
    if (ln === t) exact.push(e);
    else if (ln.includes(t)) partial.push(e);
  }
  return groupByName(exact.length ? exact : partial, (x) => x.appName);
}

export async function findApp({ state, query, fetchImpl, log = () => {} }) {
  const term = String(query || "").trim();
  if (!term) return "用法：<code>/find &lt;App 名字或关键词&gt;</code>";

  const { itunes, itErr: it_error, deps, depErr: dp_error, merged: withStatus } =
    await lookupByName({ term, fetchImpl, log });
  const it = { error: it_error };
  const dp = { error: dp_error };

  const L = [`<b>「${esc(term)}」的搜索结果</b>`];
  const watched = new Set(Object.keys(state.links || {}));

  if (itunes.length) {
    L.push("", "<b>App Store</b>");
    for (const a of itunes.slice(0, 4)) {
      L.push(`· ${esc(a.trackName)} — id <code>${esc(a.trackId)}</code>${a.bundleId ? "　<code>" + esc(a.bundleId) + "</code>" : ""}`);
    }
  } else if (it.error) {
    L.push("", `App Store：查询失败（${esc(it.error)}）`);
    // 429 是 Cloudflare 共享出口 IP 被 iTunes 限流 —— 光说"稍后重试"没用，
    // 得给出**现在就能绕过去**的办法（手动给 id）。
    if (/429/.test(it.error)) {
      L.push("<i>iTunes 对 Cloudflare 的共享出口 IP 限流，过一会儿再试通常就好；</i>",
        "<i>急着加就先不加 id：<code>/add &lt;链接&gt;</code> 照样能盯链接状态，之后补 <code>appstore=&lt;id&gt;</code> 即可。</i>");
    }
  } else {
    L.push("", "App Store：没搜到");
  }

  if (withStatus.length) {
    L.push("", "<b>找到的 TestFlight 链接</b>");
    for (const g of groupByName(withStatus, (x) => x.appName).slice(0, 5)) {
      L.push(`· ${esc(g.name)}${g.items.length > 1 ? ` — ${g.items.length} 个码` : ""}`);
      for (const it of g.items) {
        const bits = [];
        if (it.state) bits.push(STATE_LABEL[it.state] || it.state);
        if (it.departuresId) bits.push(`departures ${it.departuresId}`);
        if (watched.has(it.code)) bits.push("已在监控");
        L.push(`  <code>/add ${esc(it.code)}</code>${bits.length ? " — " + esc(bits.join(" · ")) : ""}`);
      }
    }
  } else {
    L.push("", "tfstore：没有（它只收录一部分 App，不代表没有 TF 版）");
  }
  if (dp.error) L.push("", `departures.to：查询失败（${esc(dp.error)}）`);
  else if (!deps.length) L.push("", "departures.to：没收录（不影响状态监控，只是少一层轮换检测）");

  for (const note of findHints({ term, itunes, tfs: withStatus, deps })) L.push("", `<i>${note}</i>`);

  L.push("", "<b>怎么加</b>",
    "· 直接 <code>/add &lt;App名字&gt;</code> —— 它会自己挑最值得加的那个码",
    "· 或点上面的 <code>/add &lt;码&gt;</code> 指定（App Store id 与 departures id 会自动补齐）",
    "· 只有 departures 的 app id → <code>/add dep=&lt;id&gt;</code>（会自动反解出 TF 码）",
    "· 要手动指定 → <code>/add &lt;链接&gt; 名称 appstore=&lt;id&gt; departures=&lt;id&gt;</code>");
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

/**
 * 从 ISO 日期算"距今几天"。纯函数，便于单测。
 * 用来把 App Store 正式版号讲清楚 —— "7.3.9（9 月 30 日上架，14 天前）"
 * 比孤零零一个版本号有用得多。
 */
export function daysAgo(isoDate, now = new Date()) {
  const t = Date.parse(String(isoDate || ""));
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86400000);
  return days < 0 ? 0 : days;
}

/**
 * 显示用时间。
 *
 * ⚠️ serverless 里没有"本地时间"这个概念 —— Cloudflare Workers 跑在边缘节点上，
 * `Date` 默认就是 UTC，直接输出会带着 8 小时偏差。所以时区要**显式配置**。
 *
 * 两条路，优先前者：
 *   1. IANA 时区名（`Asia/Shanghai`）—— 走 `Intl.DateTimeFormat`，能正确处理夏令时
 *   2. 固定偏移（`utcOffsetMinutes: 480`）—— `Intl` 不可用或时区数据缺失时的兜底
 *
 * 为什么不只用 IANA：Worker 的 `Intl` 虽然存在，但**时区/区域数据是否完整并不保证**；
 * 而且不同运行时的默认 locale 会让输出格式漂移。所以下面会**校验输出格式**，
 * 不符合预期就自动退回固定偏移 —— 宁可少一点夏令时支持，也不能把时间显示错。
 */
// 默认就用项目默认时区（Asia/Shanghai / +8），**不是 UTC-0**。
// 理由：入口忘了调用 setDisplayTimeZone 时，"显示成 UTC" 是个很隐蔽的错误
// （实测踩过：renderApps 少了这一步就把 16:17 显示成 08:17）。
// 宁可退回一个"和配置默认一致"的值，也不要退回 UTC。
let DISPLAY_TZ = { name: "Asia/Shanghai", offsetMinutes: 480, usable: true };

const TZ_FMT_OPTS = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
};

/** 探测某个 IANA 时区名在当前运行时能不能用（Worker 的 Intl 时区数据不保证完整） */
function tzNameUsable(name) {
  if (!name) return false;
  try {
    const out = new Intl.DateTimeFormat("sv-SE", { timeZone: name, ...TZ_FMT_OPTS }).format(new Date(0));
    return TS_SHAPE.test(out);
  } catch {
    return false;
  }
}

/**
 * 算出某个 IANA 时区在给定时刻的**真实**偏移（分钟）。
 * 为什么需要：配置里可能同时给了 timezone 和 utcOffsetMinutes，而两者未必一致
 * （比如 America/New_York 在夏令时是 UTC-4）。标签必须反映**实际生效**的那个，
 * 否则会出现"显示纽约时间、标签却写 UTC+8"这种自相矛盾。
 */
function offsetMinutesForName(name, d) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: name, ...TZ_FMT_OPTS }).formatToParts(d);
    const g = {};
    for (const p of parts) if (p.type !== "literal") g[p.type] = p.value;
    const asUTC = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day),
      Number(g.hour) % 24, Number(g.minute));
    // ⚠️ 必须先把 d 截到整分钟再相减 —— 格式化结果只精确到分钟，
    // 拿它去减带秒/毫秒的时间戳会差不到一分钟，Math.round 会把 +8:00 算成 +7:59
    // （实测：秒数 > 30 时必现）。这个 bug 是测试抓出来的。
    const t = Math.floor(d.getTime() / 60000) * 60000;
    return Math.round((asUTC - t) / 60000);
  } catch {
    return null;
  }
}

export function setDisplayTimeZone(name, offsetMinutes) {
  const n = String(name == null ? "" : name).trim();
  const off = Number(offsetMinutes);
  const tzName = n && n.toUpperCase() !== "UTC" ? n : "";
  DISPLAY_TZ = {
    name: tzName,
    offsetMinutes: Number.isFinite(off) ? off : 0,
    usable: tzNameUsable(tzName),
  };
  return { name: DISPLAY_TZ.name, offsetMinutes: DISPLAY_TZ.offsetMinutes,
           mode: DISPLAY_TZ.usable ? "name" : "offset" };
}

export function getDisplayTimeZone() {
  return { ...DISPLAY_TZ, mode: DISPLAY_TZ.usable ? "name" : "offset" };
}

/** 形如 "2026-10-14 16:24"；不满足这个形状的输出一律不采用 */
const TS_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function formatWithOffset(d, offsetMinutes) {
  const t = new Date(d.getTime() + offsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export function nowStr(d = new Date()) {
  if (DISPLAY_TZ.usable) {
    try {
      // sv-SE 的日期格式恰好是 "YYYY-MM-DD HH:mm"，拿来当 ISO 风格输出最省事
      const out = new Intl.DateTimeFormat("sv-SE", { timeZone: DISPLAY_TZ.name, ...TZ_FMT_OPTS }).format(d);
      if (TS_SHAPE.test(out)) return out;
    } catch {
      /* 运行期才失效（理论上不会，setDisplayTimeZone 已探测过）-> 退回固定偏移 */
    }
  }
  return formatWithOffset(d, DISPLAY_TZ.offsetMinutes);
}

function offsetLabel(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60), mm = abs % 60;
  return `UTC${sign}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

/**
 * 时区标签，给 /status 抬头用。
 * **只报告实际生效的那个**：名字可用就报名字（附它此刻的真实偏移），否则报固定偏移。
 */
/**
 * **存储**用的时间戳：ISO 8601 UTC（秒级）。
 *
 * 为什么存储不存"显示串"：显示串里带了时区（或者干脆没带、取决于当时的配置），
 * 一旦改时区、或者读到旧版本写下的数据，显示就会错乱 —— 实测就踩到了：
 * 抬头写着"时间均为 Asia/Shanghai（UTC+8）"，下面每一行却还是旧的 `08:18 UTC`。
 * 内部一律存 UTC 时间点、显示时才转时区，这类自相矛盾就不可能发生。
 */
export function nowStamp(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const LEGACY_UTC_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))? UTC$/;

/**
 * 把**存储里的**时间戳渲染成当前时区的显示值。必须兼容三种历史形态：
 *   1. ISO 8601（本版本起）：`2026-10-14T08:18:00Z`  -> 按时区渲染
 *   2. 旧版 UTC 显示串：`2026-10-14 08:18 UTC`       -> 当 UTC 解析后按时区渲染
 *   3. 旧版本地显示串：`2026-10-14 16:18`（无标记）  -> 已是显示值，原样返回
 * 认不出来的一律原样返回（"从未"、"?" 这类要能穿过去）。
 */
export function fmtStamp(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return "";
  if (ISO_RE.test(raw)) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return nowStr(new Date(t));
  }
  const m = raw.match(LEGACY_UTC_RE);
  if (m) {
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3] || "00"}Z`);
    if (Number.isFinite(t)) return nowStr(new Date(t));
  }
  return raw;
}

/**
 * 把**存储里的**时间戳解析回 Date。和 `fmtStamp` 覆盖同样三种形态。
 * 旧版"本地串"没有时区标记，只能按**当前显示时区**去猜 —— 这是唯一可行的近似。
 */
export function parseStamp(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  if (ISO_RE.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const mu = raw.match(LEGACY_UTC_RE);
  if (mu) {
    const t = Date.parse(`${mu[1]}T${mu[2]}:${mu[3] || "00"}Z`);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const ml = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/);
  if (ml) {
    const asUtc = Date.parse(`${ml[1]}T${ml[2]}:${ml[3] || "00"}Z`);
    if (!Number.isFinite(asUtc)) return null;
    const off = DISPLAY_TZ.usable
      ? (offsetMinutesForName(DISPLAY_TZ.name, new Date(asUtc)) ?? DISPLAY_TZ.offsetMinutes)
      : DISPLAY_TZ.offsetMinutes;
    return new Date(asUtc - off * 60000);
  }
  return null;
}

/** 时间段的自然说法（"3 天" / "12 分钟"）。给"状态已保持…"用。 */
export function humanDuration(v, now = new Date()) {
  const d = parseStamp(v);
  if (!d) return "";
  const sec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (sec < 90) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

/**
 * "多久之前"。状态页要回答的是"它还活着吗"，所以相对时间比精确时刻更有用；
 * 认不出的值（"从未"、"?"）原样返回，不要吞掉。
 */
export function humanAgo(v, now = new Date()) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return "";
  const d = parseStamp(raw);
  if (!d) return raw;
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (sec < 90) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * departures.to 的状态和我们的判断是否一致。
 * 只在**不一致**时才值得显示 —— 一致时它不提供任何信息，纯噪音。
 */
export function departuresDisagrees(dep, ourState) {
  const d = String(dep || "").toLowerCase().trim();
  if (!d) return false;
  if (d === "open" || d === "available") return ourState !== "open";
  if (d === "closed" || d === "full") return ourState === "open";
  return false;   // 认不出来的状态不报，免得误报
}

export function tzLabel(d = new Date()) {
  const { name, offsetMinutes, usable } = DISPLAY_TZ;
  if (usable) {
    const real = offsetMinutesForName(name, d);
    return real === null ? name : `${name}（${offsetLabel(real)}）`;
  }
  return offsetLabel(offsetMinutes);
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
      // fromConfig 用来如实标注来源 —— 配置带进来的条目以前被写成 "manual"，
      // 那是**不实**的：用户根本没手动加过它。
      out[w.code] = { label: w.label || w.code, appStoreId: w.appStoreId,
                      departuresId: w.departuresId, fromConfig: true };
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
    if (!rec.firstSeen) rec.firstSeen = nowStamp();
    if (!rec.label) rec.label = meta.label;
    if (!rec.sources) {
      rec.sources = [meta.fromConfig ? "config" : "manual"];
    } else if (meta.fromConfig && rec.sources.length === 1 && rec.sources[0] === "manual") {
      // 旧版本把"配置 watch 带进来的"也写成了 manual（不实）。这里纠正一次：
      // 只影响展示用的"来源"，且只在"就一个 manual"时才动，不会覆盖真实的手动记录
      // （用户手动 /add 过的会带上别的标记或保持 manual 与其他来源并存）。
      rec.sources = ["config"];
    }
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
      rec.stateSince = nowStamp();
      if (oldState !== undefined || info.state !== "open") {
        const msg = [
          `<b>${esc(rec.label || code)} TF 链接状态变化</b>`,
          `链接：${esc(info.url)}`,
          `状态：${STATE_LABEL[oldState] || "首次监控"} → <b>${STATE_LABEL[info.state] || info.state}</b>`,
        ];
        if (info.appName) msg.push(`应用：${esc(info.appName)}`);
        // 把公测页的"测试说明"原文带上：有些开发者会在这里写版本号/更新内容
        if (info.desc) msg.push(`测试说明：${esc(info.desc.slice(0, 200))}`);
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
      rec.departures = { status: dep.status, url: dep.url, checkedAt: nowStamp() };
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
    state.appstore[String(aid)] = { version: cur.version, checkedAt: nowStamp(), name: cur.name, releaseDate: cur.releaseDate || "" };
    if (old.version && old.version !== cur.version) {
      const msg = [
        `<b>App Store 正式版更新</b>：${esc(cur.name)}`,
        `版本：${esc(old.version)} → <b>${esc(cur.version)}</b>`,
        `上架日期：${esc(cur.releaseDate)}`,
        "<i>TF 上通常已经在测这个新版本（或更高的 beta）；TF 构建号 Apple 不公开，只能在 TestFlight App 里看。</i>",
        `时间：${nowStr()}`,
      ];
      if (await notifier.send(msg.join("\n"))) events++;
    } else if (!old.version) {
      log(`  记录 ${cur.name || aid} 正式版基线：${cur.version}`);
    }
  }

  state.meta.lastCheck = nowStamp();
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
  item.foundAt = nowStamp();
  item.appName = item.appName || info.appName || info.title || "";
  state.discoveries[code] = item;

  const aw = cfg.autoWatchKeywords || [];
  const blob = ((item.appName || "") + " " + (item.context || "")).toLowerCase();
  const autoOk = !aw.length || aw.some((k) => blob.includes(String(k).toLowerCase()));
  const watched = !!cfg.autoWatchDiscovered && autoOk && info.state === "open";
  if (watched) {
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label: item.appName || code, firstSeen: nowStamp(), sources: [item.source],
      state: info.state, url: info.url, appName: info.appName, desc: info.desc,
      descHash: info.descHash, lastChecked: info.checkedAt,
    });
    if (!rec.stateSince) rec.stateSince = nowStamp();
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

  state.meta.lastScan = nowStamp();
  log(`发现扫描结束，新增 ${events} 条。`);
  return events;
}

// ─────────────────────────── 报表 ───────────────────────────

export function renderStatus(cfg, state) {
  const L = [
    `<b>tg-tf-monitor 当前状态</b> <i>· ${esc(tzLabel())}</i>`,
    `上次监控 ${esc(humanAgo(state.meta.lastCheck) || "从未")}　｜　上次发现扫描 ${esc(humanAgo(state.meta.lastScan) || "从未")}`,
  ];
  const codes = sortCodesByLabel(state);
  if (!codes.length) L.push("", "（监控列表为空）");
  const usedAppstore = new Set();
  for (const code of codes) {
    const rec = state.links[code];
    L.push("");
    L.push(`· <b>${esc(rec.label || code)}</b> — ${STATE_LABEL[rec.state] || rec.state || "未检查"}`);
    L.push(`  ${esc(rec.url || "https://testflight.apple.com/join/" + code)}`);
    if (rec.appStoreId) usedAppstore.add(String(rec.appStoreId));
    const asv = rec.appStoreId ? state.appstore[String(rec.appStoreId)] : null;
    if (asv && asv.version) {
      const d = daysAgo(asv.releaseDate);
      const day = String(asv.releaseDate || "").slice(0, 10);
      L.push(`  正式版 ${esc(asv.version)}${day ? "（" + esc(day.slice(5)) + " 上架" + (d === null ? "" : "，" + d + " 天前") + "）" : ""}`);
    }
    if (rec.stateSince) L.push(`  状态已保持 ${esc(humanDuration(rec.stateSince) || "?")}`);
    // departures 只在和我们的判断**不一致**时才显示 —— 一致时它不提供信息
    if (rec.departures && departuresDisagrees(rec.departures.status, rec.state)) {
      L.push(`  ⚠️ departures.to 认为 ${esc(rec.departures.status)}，和我们不一致（可能换了链接）`);
    }
    if (rec.lastError) L.push(`  ⚠️ ${esc(rec.lastError)}`);
  }
  // 没挂在任何监控项下的 appstore 记录才单独列（挂上了的已经在各自 App 下面）
  for (const [aid, a] of Object.entries(state.appstore || {})) {
    if (usedAppstore.has(String(aid))) continue;
    L.push("", `· App Store 正式版（id ${esc(aid)}，没挂在任何监控项下）：${esc(a.version || "?")}`);
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
/add &lt;名字&gt; — 按名字**加进监控**：自己找链接、自己挑能进的那个
    例：<code>/add 微信读书</code>
/add &lt;TestFlight链接或join码&gt; — 手上有链接时直接用
/add dep=&lt;id&gt; — 只有 departures 的 app id 时（会反解出 TF 码）
    加的时候 App Store id、bundle id、departures.to id 会**自动补齐**
/apps — 看监控中的 App 都盯了什么
/del &lt;码&gt; — 移出监控

<b>查 App（只查，不改监控列表）</b>
/find &lt;名字&gt; — 按名字查 TF 链接：三路并搜，列出码 + 状态 + departures id

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

关于「TF 版本号」：
TestFlight 里的构建号 Apple 不公开，公测页上也没有 —— 只能在 TestFlight App 里看。
（App Store 正式版号 ≠ TF 构建号；有新构建时 TestFlight 自己会推通知。）

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
      await notifier.send("用法：<code>/add &lt;App名字&gt;</code>　或　<code>/add &lt;TestFlight链接/join码&gt;</code>\n" +
        "· 按名字加最省事：<code>/add 微信读书</code>（自己找链接、自己挑能进的那个）\n" +
        "· 有链接就直接给：<code>/add https://testflight.apple.com/join/dTUO1uyt</code>\n" +
        "· 只有 departures 的 app id：<code>/add dep=&lt;id&gt;</code>\n" +
        "· 要手动指定：<code>/add &lt;链接&gt; 名称 appstore=&lt;id&gt; departures=&lt;id&gt;</code>\n" +
        "只想查不想加 → <code>/find &lt;App名字&gt;</code>");
      return;
    }
    const arg = parts[1].trim();
    const depId = parseDeparturesArg(arg);
    const asCode = depId ? "" : (firstJoinCode(arg) || (/^[A-Za-z0-9]{6,14}$/.test(arg) ? arg : ""));
    const opts = {};
    let code = "";
    let givenName = "";
    let extraNote = "";
    let derivedDepartures = "";

    if (depId) {
      // /add dep=<id>：departures 的 app 页里带着 join 链接，直接反解，省得用户先去别处找码
      await notifier.send(`正在从 departures.to 反解 <code>${esc(depId)}</code> 的 TestFlight 码…`);
      const d = await probeDepartures(depId, { fetchImpl });
      if (d.error || !d.code) {
        await notifier.send(
          `没能反解出码（${esc(d.error || "该页面里没有 join 链接")}）\n` +
          `· 自己看一眼：<code>https://departures.to/apps/${esc(depId)}</code>\n` +
          `· 或者直接 <code>/add &lt;TestFlight链接&gt;</code>`
        );
        return;
      }
      code = d.code;
      opts.departures = depId;
      givenName = parts.slice(2).filter((t) => !/^(appstore|departures|bundle)=/i.test(t)).join(" ").trim();
    } else if (asCode) {
      code = asCode;
      // 名称与可选的手动指定：/add <码> 名称 appstore=123 departures=456
      const nameParts = [];
      for (const t of parts.slice(2)) {
        const m = /^(appstore|departures|bundle)=(.+)$/i.exec(t);
        if (m) opts[m[1].toLowerCase()] = m[2].trim();
        else nameParts.push(t);
      }
      givenName = nameParts.join(" ").trim();
    } else {
      // ── 按名字加：/add 微信读书 ──
      // 语义分工：/find 是"查"，/add <名字> 是"查完就加"。
      // 两者共用 lookupByName()，免得出现"find 搜得到、add 搜不到"这种不一致。
      const name = parts.slice(1).join(" ").trim();
      await notifier.send(`正在按名字找「${esc(name)}」的 TestFlight 链接…`);
      const look = await lookupByName({ term: name, fetchImpl, log });
      const groups = matchAppsByName(look.merged, name);

      if (!groups.length) {
        const exact = (look.itunes || []).find((a) => String(a.trackName || "").trim() === name);
        await notifier.send(exact
          ? `App Store 里有「${esc(name)}」（id <code>${esc(exact.trackId)}</code>），` +
            `但 tfstore / departures 都没有它的公开 TF 链接 —— 加不了。\n` +
            `<i>如果你手上有链接，直接 <code>/add &lt;链接&gt;</code></i>`
          : `没找到名字匹配「${esc(name)}」的 TestFlight 链接。\n` +
            `· 换个关键词查一下 → <code>/find ${esc(name.slice(0, 30))}</code>\n` +
            `· 手上有链接就直接 → <code>/add &lt;链接&gt;</code>`);
        return;
      }
      if (groups.length > 1) {
        // 名字有歧义时**不替用户猜** —— 猜错了会让他盯上一个完全不相干的 App
        const lines = [`「${esc(name)}」匹配到 ${groups.length} 个 App —— 我不替你猜，用完整名字再来一次，或直接点下面的命令：`];
        for (const g of groups.slice(0, 6)) {
          lines.push(`· ${esc(g.name)}`);
          for (const it of g.items.slice(0, 4)) {
            lines.push(`  <code>/add ${esc(it.code)}</code>${it.state ? " — " + esc(STATE_LABEL[it.state] || it.state) : ""}`);
          }
        }
        await notifier.send(lines.join("\n"));
        return;
      }
      const g = groups[0];
      const best = pickBestLink(g.items);
      code = best.code;
      // 这个 id 是机器人**自己解析出来**的，不是用户给的 —— 来源要如实标 auto
      if (best.departuresId) derivedDepartures = best.departuresId;
      givenName = g.name || name;
      const others = g.items.filter((x) => x.code !== best.code);
      if (others.length) {
        extraNote = `ℹ️ 这个 App 还有 ${others.length} 个别的链接：` +
          others.slice(0, 4).map((x) => `<code>${esc(x.code)}</code>${x.state ? "（" + esc(STATE_LABEL[x.state] || x.state) + "）" : ""}`).join("、") +
          `\n要一起盯就 <code>/add &lt;码&gt;</code>`;
      }
    }

    await notifier.send(`正在补齐 <code>${esc(code)}</code> 的信息（探测链接 + 查 App Store + 查 departures.to）…`);

    const e = await enrichApp({ code, name: givenName, fetchImpl, log });
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label: givenName || e.appName || code,
      appName: e.appName || rec.appName || "",
      firstSeen: rec.firstSeen || nowStamp(),
      sources: [...new Set([...(rec.sources || []), "manual"])],
      state: e.state, url: e.url, desc: e.desc, descHash: e.descHash, lastChecked: e.checkedAt,
      keywords: e.keywords || [],
    });
    if (opts.appstore) { rec.appStoreId = /^\d+$/.test(opts.appstore) ? Number(opts.appstore) : opts.appstore; rec.appStoreSource = "manual"; }
    else if (e.appStoreId) { rec.appStoreId = e.appStoreId; rec.appStoreSource = "auto"; }
    if (opts.bundle) rec.bundleId = opts.bundle;
    else if (e.bundleId) rec.bundleId = e.bundleId;
    if (opts.departures) { rec.departuresId = /^\d+$/.test(opts.departures) ? Number(opts.departures) : opts.departures; rec.departuresSource = "manual"; }
    else if (derivedDepartures) { rec.departuresId = /^\d+$/.test(derivedDepartures) ? Number(derivedDepartures) : derivedDepartures; rec.departuresSource = "auto"; }
    else if (e.departuresId) { rec.departuresId = e.departuresId; rec.departuresSource = "auto"; }
    if (!rec.stateSince) rec.stateSince = nowStamp();

    const L = [
      `✅ 已加入监控：<b>${esc(rec.label)}</b> — ${STATE_LABEL[e.state] || e.state}`,
      esc(e.url),
      `App Store：${rec.appStoreId ? esc(rec.appStoreId) + (rec.bundleId ? "（" + esc(rec.bundleId) + "）" : "") + (rec.appStoreSource === "auto" ? " <i>自动匹配</i>" : "") : "<i>未关联</i>"}`,
      `departures.to：${rec.departuresId ? esc(rec.departuresId) + (rec.departuresSource === "auto" ? " <i>自动匹配</i>" : "") : "<i>未关联</i>"}`,
      `发现关键词：${esc((rec.keywords || []).join(" / ") || "（无）")}`,
    ];
    if (e.notes && e.notes.length) {
      L.push("", "<b>需要留意</b>");
      for (const n of e.notes) L.push("· " + esc(n));
    }
    if (extraNote) L.push("", extraNote);
    L.push("", "会被盯：链接状态" +
      (rec.appStoreId ? "、App Store 正式版号" : "") +
      (rec.departuresId ? "、departures.to 链接轮换" : "") +
      "；<code>/scan</code> 时按它的关键词找新链接。");
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
