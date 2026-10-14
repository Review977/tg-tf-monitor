/**
 * tg-tf-monitor-cloud —— 单文件构建产物，请勿直接编辑
 *
 * 由 build.mjs 从以下模块拼成（改了源文件请重跑 node build.mjs）：
 *   - src/core.js
 *   - src/config.js
 *   - src/storage.js
 *   - src/runner.js
 *   - src/worker.js
 *
 * 用法：整个文件贴进 Cloudflare 控制台的 Worker 编辑器即可。
 * 该产物已被 test/handler.test.mjs 实际 import 并跑过断言。
 *
 * 源码指纹（sha256 前 16 位）：3d32dadf99f0beb3
 * ⚠️ 这里刻意**不放构建时间** —— 放了构建就不可复现，
 *    CI 里"产物必须与源码同步"那条检查会永远失败（这是被 CI 抓出来的）。
 */

// ═══════════ src/core.js ═══════════
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

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STATE_LABEL = {
  open: "可加入 ✅",
  full: "已满员 ⛔",
  closed: "已关闭 🚫",
  invalid: "链接失效 ❌",
  error: "检查失败 ⚠️",
  unknown: "状态未知 ❓",
};

// 页面里"获取 TestFlight"那段通用说明，取描述时要排除掉
const GENERIC_DESC = ["Help developers test beta versions", "帮助开发者测试"];

// ─────────────────────────── 纯函数 ───────────────────────────

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 去标签 + 反转义，保留换行（做消息兜底用） */
function htmlToPlain(s) {
  return unescapeEntities(String(s || "").replace(/<[^>]+>/g, ""));
}

function unescapeEntities(s) {
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
function stripTags(s) {
  return unescapeEntities(
    String(s || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** 剥掉 Apple 包在应用名外面的壳（中英两种写法） */
function cleanAppName(s) {
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
function parseJoinPage(html, httpStatus, errorMsg = "") {
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
const GENERIC_TITLE_RE = /^TestFlight\s*-\s*Apple$/i;

/** 稳定的短哈希（FNV-1a，够用且不需要 crypto 子请求） */
function shortHash(s) {
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
function findJoinCodes(text) {
  const s = String(text || "");
  const re = new RegExp(JOIN_RE.source, "g");
  const out = new Set();
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[1]);
  return [...out];
}

/** 只取第一个 join 码 */
function firstJoinCode(text) {
  const re = new RegExp(JOIN_RE.source);
  const m = re.exec(String(text || ""));
  return m ? m[1] : "";
}

const JOIN_CODE_RE = /^[A-Za-z0-9]{6,14}$/;

// ── Telegram 消息安全 ──

const TG_ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "span", "tg-spoiler", "blockquote", "br",
]);

/**
 * 发送前校验：这条消息是不是 Telegram 能解析的 HTML。
 * Telegram 遇到未知标签 / 未配对标签 / 裸 `<` 会**整条拒收** ——
 * 告警是单向通道，被拒就等于**静默漏报**。
 */
function tgHtmlCheck(text) {
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
function tgPrepare(text, limit = 4000) {
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
function tgSendParams(chatId, text) {
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

async function probeJoin(code, opts = {}) {
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
async function probeDepartures(appId, opts = {}) {
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
async function probeTfstore(query, opts = {}) {
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
function bingDecode(href) {
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

async function probeBing(query, opts = {}) {
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
async function probeSo360(query, opts = {}) {
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
async function probeTgChannel(channel, opts = {}) {
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

async function probeAppstore(appId, opts = {}) {
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

// ─────────────────────────── 时间 ───────────────────────────

function nowStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// ─────────────────────────── Telegram 调用 ───────────────────────────

async function tgCall(cfg, method, params = {}, opts = {}) {
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

function makeNotifier({ cfg, log = () => {}, dryRun = false, fetchImpl }) {
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

function emptyState() {
  return { links: {}, discoveries: {}, appstore: {}, meta: {} };
}

function normalizeState(s) {
  const d = s && typeof s === "object" ? s : {};
  d.links = d.links || {};
  d.discoveries = d.discoveries || {};
  d.appstore = d.appstore || {};
  d.meta = d.meta || {};
  return d;
}

function knownCodes(cfg) {
  return new Set((cfg.watch || []).map((w) => w && w.code).filter(Boolean));
}

function monitorTargets(cfg, state) {
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

function relevant(cfg, text) {
  const kws = cfg.keywords || [];
  if (!kws.length) return true;
  const low = String(text || "").toLowerCase();
  return kws.some((k) => low.includes(String(k).toLowerCase()));
}

// ─────────────────────────── 监控 ───────────────────────────

async function runMonitor({ cfg, state, notifier, log = () => {}, fetchImpl }) {
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

async function registerDiscovery({ cfg, state, notifier, log = () => {}, fetchImpl }, item) {
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
async function runDiscovery({ cfg, state, notifier, log = () => {}, fetchImpl, onlySource = undefined }) {
  const d = cfg.discovery || {};
  let events = 0;

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
  for (const q of d.tfstoreQueries || []) {
    sources.push({
      name: `tfstore:${q}`,
      run: async () => {
        let n = 0;
        const hits = await probeTfstore(q, { fetchImpl });
        log(`  tfstore「${q}」→ ${hits.length} 条`);
        for (const h of hits) {
          if (relevant(cfg, h.appName)) n += await registerDiscovery({ cfg, state, notifier, log, fetchImpl }, h);
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
            if (relevant(cfg, (h.context || "") + " " + (h.appName || ""))) {
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
            if (relevant(cfg, (h.context || "") + " " + (h.appName || ""))) {
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
          if (relevant(cfg, h.context || "")) {
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

function renderStatus(cfg, state) {
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

function renderLinks(state) {
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

const HELP = `<b>tg-tf-monitor 命令</b>
/status — 当前监控状态
/check — 立刻跑一轮监控
/scan — 立刻跑一轮发现扫描
/links — 列出已知 join 码
/add &lt;码或链接&gt; [备注] — 加入监控
/del &lt;码&gt; — 移出监控
/sources — 查看发现源配置
/test — 发一条测试消息
/help — 这条帮助

链接状态含义：
可加入 ✅ / 已满员 ⛔ / 已关闭 🚫 / 链接失效 ❌`;

// ─────────────────────────── 命令 ───────────────────────────

async function handleCommand({ cfg, state, notifier, text, chatId, log = () => {}, fetchImpl, runner }) {
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
      `tfstore 查询：${esc(JSON.stringify(d.tfstoreQueries || []))}`,
      `网页搜索查询：${esc(JSON.stringify(d.webQueries || []))}`,
      `  引擎：Bing=${esc(d.useBing !== false)} / 360=${esc(d.useSo360 !== false)}`,
      `TG 频道：${esc(JSON.stringify(d.telegramChannels || []))}`,
      `推送关键词：${esc(JSON.stringify(cfg.keywords || []))}`,
      `自动监控关键词：${esc(JSON.stringify(cfg.autoWatchKeywords || []))}`,
      `自动监控新发现：${esc(cfg.autoWatchDiscovered)}`,
      `监控间隔：${esc(cfg.intervalMinutes)} 分钟`,
    ].join("\n"));
  } else if (cmd === "/add" && parts.length >= 2) {
    const arg = parts[1].trim();
    const code = firstJoinCode(arg) || arg;
    if (!JOIN_CODE_RE.test(code)) {
      await notifier.send(`看不懂这个 join 码：${esc(arg)}`);
      return;
    }
    const label = parts.slice(2).join(" ") || code;
    const info = await probeJoin(code, { fetchImpl });
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label, firstSeen: rec.firstSeen || nowStr(),
      sources: [...new Set([...(rec.sources || []), "manual"])],
      state: info.state, url: info.url, appName: info.appName,
      desc: info.desc, descHash: info.descHash, lastChecked: info.checkedAt,
    });
    if (!rec.stateSince) rec.stateSince = nowStr();
    await notifier.send(`已加入监控：<code>${esc(code)}</code>（${STATE_LABEL[info.state] || info.state}）` +
      (info.appName ? `，应用：${esc(info.appName)}` : ""));
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

// ═══════════ src/config.js ═══════════
/**
 * 配置装载
 *
 * 优先级（后面的覆盖前面的）：
 *   1. 内置默认值（就是番茄小说那套，开箱即用）
 *   2. 环境变量 CONFIG_JSON —— 想改监控对象/发现源时用
 *   3. 平台 secret（TG_TOKEN / TG_CHAT_ID / TG_API_BASE）—— **最后覆盖**，
 *      这样 CONFIG_JSON 里就算写了空 token 也不会把 secret 冲掉
 *
 * 所有配置项都能用 CONFIG_JSON 覆盖，不用改代码。
 */

const DEFAULT_CONFIG = {
  telegram: { token: "", chatId: "", apiBase: "https://api.telegram.org" },

  // 监控间隔只用于"文档说明"；真正的频率由平台的 Cron 决定
  intervalMinutes: 30,

  autoWatchDiscovered: true,

  // 哪些发现值得推送
  keywords: ["番茄小说", "番茄免费小说", "番茄畅听", "dragon.read", "fqnovel", "fanqie"],
  // 哪些发现自动纳入监控（更严，避免"番茄助眠"这种同名 App 被自动盯上）
  autoWatchKeywords: ["番茄小说", "dragon.read", "fqnovel", "fanqie"],

  watch: [
    {
      code: "dTUO1uyt",
      label: "番茄小说 TF 公测",
      appStoreId: 1468454200,
      departuresId: 16645,
    },
  ],

  discovery: {
    useDepartures: true,
    departuresApps: [16645],
    tfstoreQueries: ["番茄小说", "番茄"],
    webQueries: ['"testflight.apple.com/join" 番茄小说', "番茄小说 testflight 公测 内测"],
    useBing: true,
    useSo360: true,
    telegramChannels: ["testflight", "TestFlightApps"],
  },

  // 两个 Cron 表达式：scheduled handler 靠比对 event.cron 区分该跑哪个
  cron: {
    discovery: "0 */6 * * *",
  },
};

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function loadConfig(env = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (env.CONFIG_JSON) {
    let user;
    try {
      user = JSON.parse(env.CONFIG_JSON);
    } catch (e) {
      throw new Error("CONFIG_JSON 不是合法 JSON：" + e.message);
    }
    deepMerge(cfg, user);
  }

  // 平台 secret 最后覆盖
  cfg.telegram = cfg.telegram || {};
  if (env.TG_TOKEN) cfg.telegram.token = String(env.TG_TOKEN);
  if (env.TG_CHAT_ID) cfg.telegram.chatId = String(env.TG_CHAT_ID);
  if (env.TG_API_BASE) cfg.telegram.apiBase = String(env.TG_API_BASE);

  return cfg;
}

/**
 * 配置体检：缺什么一次性说清楚，别等到运行到一半才报错。
 *
 * `requireTelegram` 在 DRY_RUN 时会传 false —— 因为只想"先验证监控能不能跑通"
 * 的人还没配 token，此时不该被拦住（反正也不发送）。
 * 真部署时保持 true，缺 token 就必须报错，不能静默变成"什么都不发"。
 */
function checkConfig(cfg, { requireTelegram = true } = {}) {
  const problems = [];
  if (requireTelegram) {
    if (!cfg.telegram || !cfg.telegram.token) problems.push("缺 telegram.token（设 TG_TOKEN）");
    if (!cfg.telegram || !cfg.telegram.chatId) problems.push("缺 telegram.chatId（设 TG_CHAT_ID）");
  }
  if (!Array.isArray(cfg.watch) || !cfg.watch.length) problems.push("watch 为空，没有东西可监控");
  return problems;
}

// ═══════════ src/storage.js ═══════════
/**
 * 状态存储适配器
 *
 * serverless 没有本地文件系统，状态必须放外部。两个平台各一个实现，
 * 接口统一为 `{ load(), save(state) }`：
 *   · Cloudflare：Workers KV（绑定名 STATE）—— 平台自带，不需要额外注册服务
 *   · Vercel：Upstash Redis REST（Vercel 函数无状态，必须外接）
 *   · 内存：只给单测/一次性试跑用，**不会持久化**
 *
 * 状态体积很小（几个链接 + 历史发现，约 2-5KB），KV 免费额度绰绰有余。
 */



const KEY = "state";

/** Cloudflare Workers KV */
function kvStorage(kv) {
  if (!kv) throw new Error("缺少 KV 绑定：请在 wrangler.toml / 控制台绑定 KV 命名空间到 STATE");
  return {
    kind: "cloudflare-kv",
    async load() {
      const v = await kv.get(KEY, "json");
      return normalizeState(v);
    },
    async save(state) {
      await kv.put(KEY, JSON.stringify(state));
    },
  };
}

/**
 * Upstash Redis（REST API，纯 fetch，不需要 SDK）
 * 需要两个环境变量：UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 */
function redisStorage({ url, token, fetchImpl }) {
  const f = fetchImpl || fetch;
  const base = String(url || "").replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${token}` };
  if (!base || !token) {
    throw new Error("缺少 Upstash 配置：需要 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN");
  }
  return {
    kind: "upstash-redis",
    async load() {
      const res = await f(`${base}/get/${KEY}`, { headers: auth });
      const json = await res.json();
      if (json.error) throw new Error("Upstash 读取失败: " + json.error);
      const raw = json.result;
      if (!raw) return normalizeState(null);
      try {
        return normalizeState(JSON.parse(raw));
      } catch {
        // 存的东西坏了：当成空状态重新开始，而不是整个崩掉
        return normalizeState(null);
      }
    },
    async save(state) {
      const res = await f(`${base}/set/${KEY}`, {
        method: "POST",
        headers: { ...auth, "content-type": "text/plain" },
        body: JSON.stringify(state),
      });
      const json = await res.json();
      if (json.error) throw new Error("Upstash 写入失败: " + json.error);
    },
  };
}

/** 内存存储：仅测试 / 一次性试跑，**进程结束就没了** */
function memoryStorage(initial) {
  let state = normalizeState(initial || null);
  return {
    kind: "memory",
    persistent: false,
    async load() {
      return state;
    },
    async save(s) {
      state = s;
    },
    peek() {
      return state;
    },
  };
}

/**
 * 按运行环境挑一个存储。
 *
 * ⚠️ 刻意**不静默降级**：没配存储就直接抛错。
 * 因为去重全靠它 —— 悄悄退化成内存的话，每轮都会把"已发现的链接"重新推一遍，
 * 变成刷屏，而且没有任何迹象说明为什么。宁可启动就报错并说清怎么配。
 * 真要一次性试跑，显式设 ALLOW_NO_STORAGE=1。
 */
function pickStorage(env = {}) {
  if (env.STATE) return kvStorage(env.STATE);
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return redisStorage({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  }
  if (String(env.ALLOW_NO_STORAGE || "") === "1") {
    return memoryStorage(null);
  }
  throw new Error(
    "没有可用的状态存储，已停止（去重依赖它，静默降级会变成重复刷屏）。\n" +
    "  · Cloudflare：绑定一个 KV 命名空间到变量名 STATE\n" +
    "  · Vercel：设 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN\n" +
    "  · 只想试跑一次：显式设 ALLOW_NO_STORAGE=1（状态不持久化）"
  );
}

// ═══════════ src/runner.js ═══════════
/**
 * 运行编排：平台入口都调这里，逻辑只有一份。
 *
 *   doRun()        —— 定时任务干的事（监控 / 发现 / 两者）
 *   handleUpdate() —— Telegram Webhook 收到消息后干的事
 *   setWebhook()   —— 把 Telegram 的推送地址指到你的部署（含 secret_token）
 *
 * serverless 下没有长轮询，命令必须靠 Webhook。所以部署后**必须**跑一次 setWebhook，
 * 否则 bot 收不到任何命令。
 */





function mkLog(prefix) {
  return (msg) => console.log(`[${prefix}] ${msg}`);
}

/**
 * 跑一轮。
 * @param {object} env      平台环境（secrets + bindings）
 * @param {object} opts
 *   mode    "monitor" | "discovery" | "all"（默认 all）
 *   dryRun  只打印不发送（用于部署前自检）
 */
async function doRun(env = {}, opts = {}) {
  const mode = opts.mode || "all";
  const log = opts.log || mkLog("run");
  const fetchImpl = opts.fetchImpl;
  const cfg = loadConfig(env);

  // DRY_RUN 时不强制要 token：很多人的用法是"先验证监控能不能跑通，再去配 bot"。
  // 真部署（非 DRY_RUN）时缺 token 必须报错 —— 否则会静默变成"什么都不发"。
  const dry = opts.dryRun || String(env.DRY_RUN || "") === "1";
  const problems = checkConfig(cfg, { requireTelegram: !dry });
  if (problems.length) throw new Error("配置不完整：\n  - " + problems.join("\n  - "));

  const store = pickStorage(env);
  const state = await store.load();
  const notifier = makeNotifier({ cfg, log, dryRun: dry, fetchImpl });

  log(`存储=${store.kind} 模式=${mode}`);
  let events = 0;
  if (mode === "monitor" || mode === "all") {
    events += await runMonitor({ cfg, state, notifier, log, fetchImpl });
  }
  if (mode === "discovery" || mode === "all") {
    events += await runDiscovery({ cfg, state, notifier, log, fetchImpl, onlySource: opts.onlySource });
  }
  await store.save(state);
  log(`完成，共 ${events} 条事件。`);
  return { events, storage: store.kind, mode };
}

/**
 * 处理一条 Telegram update（Webhook 的 body）。
 * 任何异常都不向外抛 —— Webhook 必须回 200，否则 Telegram 会一直重推。
 */
async function handleUpdate(env = {}, update, opts = {}) {
  const log = opts.log || mkLog("webhook");
  const fetchImpl = opts.fetchImpl;
  try {
    const cfg = loadConfig(env);
    const msg = update.message || update.channel_post || update.edited_message;
    if (!msg) return { ok: true, skipped: "无 message 字段" };
    const text = msg.text || "";
    if (!text.startsWith("/")) return { ok: true, skipped: "非命令" };

    const store = pickStorage(env);
    const state = await store.load();
    const notifier = makeNotifier({ cfg, log, fetchImpl });
    await handleCommand({
      cfg, state, notifier, text,
      chatId: msg.chat && msg.chat.id,
      log, fetchImpl,
      runner: {
        runMonitor: (a) => runMonitor(a),
        runDiscovery: (a) => runDiscovery(a),
      },
    });
    await store.save(state);
    return { ok: true };
  } catch (e) {
    // 记下来但**不要**把错误抛出去：抛了就是 5xx，Telegram 会反复重推同一条命令
    log("处理 update 失败（已吞掉，避免 Telegram 重推）: " + (e && e.message));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 把 Telegram 的推送地址指到你的部署。部署后必须跑一次。 */
async function setWebhook(env = {}, url, opts = {}) {
  const cfg = loadConfig(env);
  const secret = String(env.TG_WEBHOOK_SECRET || "");
  const params = {
    url,
    allowed_updates: JSON.stringify(["message", "channel_post"]),
    drop_pending_updates: "true",
  };
  if (secret) params.secret_token = secret;
  const r = await tgCall(cfg, "setWebhook", params, { fetchImpl: opts.fetchImpl });
  return { ok: r === true, url, secretSet: !!secret };
}

async function deleteWebhook(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  await tgCall(cfg, "deleteWebhook", { drop_pending_updates: "true" }, { fetchImpl: opts.fetchImpl });
  return { ok: true };
}

async function webhookInfo(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  return tgCall(cfg, "getWebhookInfo", {}, { fetchImpl: opts.fetchImpl });
}

/**
 * 帮用户拿 chat_id。
 *
 * ⚠️ Telegram 的规则：**设了 webhook 之后 getUpdates 就返回空**。
 * 所以这个端点只在"还没设 webhook"时有用 —— 这正是它存在的意义：
 * 部署完先拿 chat_id，再设 webhook，顺序别反。
 */
async function listChatIds(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  if (!cfg.telegram || !cfg.telegram.token) throw new Error("需要先配 TG_TOKEN");
  const ups = await tgCall(
    cfg, "getUpdates",
    { timeout: 0, allowed_updates: JSON.stringify(["message", "channel_post"]) },
    { fetchImpl: opts.fetchImpl }
  );
  const seen = new Map();
  for (const u of ups || []) {
    const m = u.message || u.channel_post || u.edited_message || {};
    const c = m.chat || {};
    if (c.id !== undefined) {
      seen.set(String(c.id), `${c.type} / ${c.title || c.username || c.first_name || ""}`);
    }
  }
  let webhookSet = false;
  try {
    const info = await tgCall(cfg, "getWebhookInfo", {}, { fetchImpl: opts.fetchImpl });
    webhookSet = !!(info && info.url);
  } catch {
    /* 查不到就算了，不影响主结果 */
  }
  return {
    webhookSet,
    chatIds: [...seen.entries()].map(([id, desc]) => ({ id, desc })),
    hint: webhookSet
      ? "你已经设过 webhook 了，getUpdates 会是空的。要么先撤销 webhook 再发一条消息，要么在别处查 chat_id。"
      : "在 TG 里给 bot 发一条消息（或把它拉进群后发一条），再刷新本页。",
  };
}

/**
 * 部署体检：一次把"能不能正常干活"要看的都打出来。
 * 用 GET /health 就能看，省得在平台日志里翻。
 */
async function health(env = {}, opts = {}) {
  const out = { ok: true, checks: {} };
  let cfg;
  try {
    cfg = loadConfig(env);
    out.checks.config = checkConfig(cfg).length ? checkConfig(cfg) : "OK";
    if (checkConfig(cfg).length) out.ok = false;
  } catch (e) {
    out.ok = false;
    out.checks.config = "读取失败: " + e.message;
  }
  try {
    const store = pickStorage(env);
    const st = await store.load();
    out.checks.storage = {
      kind: store.kind,
      links: Object.keys(st.links || {}).length,
      discoveries: Object.keys(st.discoveries || {}).length,
      lastCheck: st.meta.lastCheck || null,
      lastScan: st.meta.lastScan || null,
    };
  } catch (e) {
    out.ok = false;
    out.checks.storage = "不可用: " + e.message;
  }
  try {
    const info = await webhookInfo(env, opts);
    out.checks.webhook = {
      url: info.url || "(未设置 —— 必须跑 setWebhook，否则收不到命令)",
      pending: info.pending_update_count,
      lastError: info.last_error_message || null,
    };
    if (!info.url) out.ok = false;
  } catch (e) {
    out.checks.webhook = "查询失败: " + e.message;
    out.ok = false;
  }
  if (cfg) out.checks.watch = (cfg.watch || []).map((w) => w.code);
  return out;
}

/** 自检消息文本（可直接发到 TG） */
function renderHealth(h) {
  const L = [`<b>tg-tf-monitor-cloud 体检</b>`, `总体：${h.ok ? "✅ 正常" : "⚠️ 有问题"}`];
  const c = h.checks || {};
  L.push(`配置：${escapeAny(c.config)}`);
  if (c.storage && typeof c.storage === "object") {
    L.push(`存储：${escapeAny(c.storage.kind)}（监控 ${c.storage.links} / 发现 ${c.storage.discoveries}）`);
    L.push(`上次监控：${escapeAny(c.storage.lastCheck || "从未")}｜上次扫描：${escapeAny(c.storage.lastScan || "从未")}`);
  } else {
    L.push(`存储：${escapeAny(c.storage)}`);
  }
  if (c.webhook && typeof c.webhook === "object") {
    L.push(`Webhook：${escapeAny(c.webhook.url)}`);
    if (c.webhook.lastError) L.push(`Webhook 错误：${escapeAny(c.webhook.lastError)}`);
  } else {
    L.push(`Webhook：${escapeAny(c.webhook)}`);
  }
  if (c.watch) L.push(`监控列表：${escapeAny(c.watch.join(", "))}`);
  return L.join("\n");
}

function escapeAny(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ═══════════ src/worker.js ═══════════
/**
 * Cloudflare Workers 入口
 *
 * 部署后有两条路：
 *   · Cron Trigger（scheduled）—— 定时监控 / 发现，不需要任何人访问
 *   · fetch —— Telegram Webhook（收命令）+ 几个运维端点
 *
 * 端点了哪些：
 *   POST /            Telegram Webhook（也可用 /telegram 或 /webhook）
 *   GET  /health      部署体检（配置 / 存储 / Webhook 状态）
 *   GET  /run         手动跑一轮，需 key：?key=…&mode=monitor|discovery|all
 *   GET  /set-webhook 把 Telegram 推送地址指到本 Worker，需 key
 *   GET  /del-webhook 撤销推送地址，需 key
 *
 * 运维端点一律需要 ADMIN_KEY（没配就一律拒绝 —— 失败关闭，不留后门）。
 */




const log = (m) => console.log("[worker] " + m);

function adminOk(env, url) {
  const key = String(env.ADMIN_KEY || env.TG_WEBHOOK_SECRET || "");
  if (!key) return false; // 没配 key：拒绝，不默认放行
  const given = url.searchParams.get("key") || "";
  // 定长比较，避免时序侧信道（这里风险很低，但顺手做对）
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  /** 定时任务。靠 event.cron 区分"只监控"还是"监控+发现"。 */
  async scheduled(event, env, ctx) {
    let mode = "monitor";
    try {
      const cfg = loadConfig(env);
      const discCron = (cfg.cron && cfg.cron.discovery) || "0 */6 * * *";
      if (event.cron === discCron) mode = "all";
    } catch {
      /* 配置坏了也要跑，让 doRun 去报错 */
    }
    log(`cron=${event.cron} → mode=${mode}`);
    ctx.waitUntil(
      doRun(env, { mode, log }).catch((e) => log("定时任务失败: " + (e && e.message)))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();

    // ── Telegram Webhook ──
    if (request.method === "POST" && (path === "/" || path === "/telegram" || path === "/webhook")) {
      const secret = String(env.TG_WEBHOOK_SECRET || "");
      if (secret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== secret) {
          log("拒绝：secret_token 不匹配");
          return text("forbidden", 403);
        }
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return text("bad json", 400);
      }
      // 命令可能要跑几秒（/scan 约 2-3 秒），用 waitUntil 先回 200 再干活，
      // 免得 Telegram 等超时重推。
      ctx.waitUntil(handleUpdate(env, update, { log }).then(() => {}));
      return text("ok");
    }

    // ── 体检 ──
    if (path === "/health") {
      try {
        const h = await health(env);
        return new Response(JSON.stringify(h, null, 2), {
          status: h.ok ? 200 : 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (e) {
        return text("health 失败: " + e.message, 500);
      }
    }

    // ── 运维端点（都要 key）──
    if (path === "/run" || path === "/set-webhook" || path === "/del-webhook" || path === "/chat-id") {
      if (!adminOk(env, url)) {
        return text(
          "403：需要 key。用法 /run?key=<ADMIN_KEY>&mode=monitor|discovery|all\n" +
          "（ADMIN_KEY 没配时会用 TG_WEBHOOK_SECRET；两个都没配则一律拒绝）",
          403
        );
      }
      try {
        if (path === "/run") {
          const mode = url.searchParams.get("mode") || "all";
          const r = await doRun(env, { mode, log });
          return text(`OK mode=${r.mode} 事件=${r.events} 存储=${r.storage}`);
        }
        if (path === "/chat-id") {
          const r = await listChatIds(env);
          const lines = ["用这个端点拿 chat_id（填到 TG_CHAT_ID）", "", r.hint, ""];
          if (!r.chatIds.length) lines.push("（暂时没查到任何会话）");
          for (const c of r.chatIds) lines.push(`chat_id: ${c.id}    ${c.desc}`);
          if (r.webhookSet) lines.push("", "当前已设 webhook = true");
          return text(lines.join("\n"));
        }
        if (path === "/set-webhook") {
          const target = url.searchParams.get("url") || `${url.origin}/telegram`;
          const r = await setWebhook(env, target);
          return text(`OK webhook=${r.url} secretSet=${r.secretSet}`);
        }
        const r = await deleteWebhook(env);
        return text("OK 已撤销 webhook: " + r.ok);
      } catch (e) {
        return text("失败: " + e.message, 500);
      }
    }

    // ── 根路径 GET：给人看的自检页 ──
    if (request.method === "GET" && path === "/") {
      let h;
      try {
        h = await health(env);
      } catch (e) {
        return text("体检失败: " + e.message, 500);
      }
      const lines = [
        "tg-tf-monitor-cloud 已部署（Cloudflare Workers）",
        "",
        `总体：${h.ok ? "✅ 正常" : "⚠️ 有问题"}`,
        `配置：${JSON.stringify(h.checks.config)}`,
        `存储：${JSON.stringify(h.checks.storage)}`,
        `Webhook：${JSON.stringify(h.checks.webhook)}`,
        `监控列表：${JSON.stringify(h.checks.watch)}`,
        "",
        "部署顺序（别搞反，设了 webhook 之后 getUpdates 就空了）：",
        `  1. 拿 chat_id：${url.origin}/chat-id?key=<ADMIN_KEY>`,
        "     （先在 TG 里给 bot 发一条消息）",
        `  2. 设推送地址：${url.origin}/set-webhook?key=<ADMIN_KEY>`,
        `  3. 手动跑一轮：${url.origin}/run?key=<ADMIN_KEY>&mode=all`,
        "",
        "Telegram 推送地址：" + `${url.origin}/telegram`,
      ];
      return text(lines.join("\n"));
    }

    return text("404。可用：POST /telegram、GET /health、GET /run、GET /set-webhook、GET /del-webhook", 404);
  },
};
