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
 * 源码指纹（sha256 前 16 位）：1f3c693185f993b9
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
  waiting: "等待可用链接 ⏳",
  found: "已找到链接 🔗",
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

/**
 * 数字实体 → 字符。**超范围的码点必须挡住。**
 *
 * ⚠️ `String.fromCodePoint()` 对 > U+10FFFF 的值会抛 RangeError，而这里的输入是
 * **别人网页上的任意文本**（公测页、搜索结果摘要、TG 频道正文）。实测：页面里出现一个
 * `&#1114112;` 就让 `probeJoin()` 直接抛出去 —— 后果不是少显示一个字，而是
 * **整轮监控/扫描在中途炸掉、state 一次都不落盘**，已经发出去的告警下一轮还会重发一遍。
 * 挡不住的实体直接丢掉（宁可少一个字，也不能让一整轮白跑）。
 */
function codePointChar(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function unescapeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => codePointChar(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointChar(parseInt(h, 16)))
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
    // ⚠️ 已关闭的页面用的是通用标题「TestFlight - Apple」——
    // 拿它当应用名会连累一串：用户给的名字不参与 iTunes 匹配（绑不上 App Store id）、
    // 关键词被污染成 TestFlight/Apple（而搜索结果里必然含 "testflight.apple.com/join"，
    // 于是 relevant() 对所有结果放行，无关的码全被当"新发现"推给用户）。
    if (om) {
      const t = cleanAppName(om[1]);
      if (t && !GENERIC_TITLE_RE.test(t)) out.appName = t;
    }
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

async function probeJoin(code, opts = {}) {
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
async function probeDepartures(appId, opts = {}) {
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

/**
 * 按名字搜 App Store（拿 App Store id 与 bundle id）。
 *
 * 返回 `{ hits, error }` 而不是裸数组 —— 必须能区分
 * **「确实没这个 App」**和**「这次查询失败了」**：
 * 前者可以安心不填，后者若也说成"没搜到"，用户会误以为这 App 不在 App Store。
 */
async function probeItunesSearch(term, opts = {}) {
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
async function probeDeparturesSearch(term, opts = {}) {
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
function deriveKeywords(name, bundleId) {
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
/**
 * 从 iTunes 搜索结果里挑最像查询词的一条。
 *
 * 抽出来是因为**同一个 App 无论走哪条路都该得到同一个结果** ——
 * 之前 `enrichApp` 用 `>= 1` 就填、App 级监控那条路却用 `>= 3`，
 * 于是「高德地图」按链接加能拿到 id、按名字加却拿不到。这种分叉迟早会再犯。
 *
 * 返回 `{ hit, score }`；score 为 0（完全不像）时 hit 为 null。
 * score < 3 表示是近似匹配，调用方应当提醒用户核对。
 */
function bestItunesHit(hits, name) {
  let best = null, bestScore = 0;
  for (const h of hits || []) {
    const sc = nameMatch(h.trackName, name);
    if (sc > bestScore) { best = h; bestScore = sc; }
  }
  return { hit: bestScore >= 1 ? best : null, score: bestScore };
}

async function enrichApp({ code, name = "", fetchImpl, log = () => {} } = {}) {
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
    const { hit: best, score: bestScore } = bestItunesHit(hits, appName || term);
    if (best) {
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

/**
 * App 级监控（`/add <名字>` 加的、当时还没有链接的那种）**现在真的在监控里**的码。
 *
 * ⚠️ 为什么必须共享这一个函数：`/del` 掉链接之后 wish.codes 里会留下"幽灵码"，
 * 只有按 state.links 过滤才是事实。两处（/apps 与 /status）各写一份的话，
 * 迟早又只剩一边是对的 —— 上次就正是这样：renderApps 修了，/status 没修。
 */
function liveWishCodes(rec, state) {
  if (!rec || rec.kind !== "app") return [];
  return (rec.codes || []).filter((c) => state && state.links && state.links[c]);
}

/**
 * App 级监控的**显示状态**：推导，不照抄存储值。
 * 存储里的 `state: "waiting"` 是创建时写死的，找到链接之后也不变 —— 照抄它就会说谎。
 */
function appWatchState(rec, state) {
  if (!rec || rec.kind !== "app") return rec ? rec.state : "";
  return liveWishCodes(rec, state).length ? "found" : "waiting";
}

function renderApps(state) {
  // 按**加入时间**排（见 sortCodesByLabel 的说明）
  const codes = sortCodesByLabel(state);
  if (!codes.length) return "还没有监控任何 App。发 /find <名字> 找，或 /add <TestFlight 链接> 直接加。";
  const L = [`<b>监控中的 App（${codes.length} 个）</b>`];
  codes.forEach((code, i) => {
    const r = state.links[code];
    L.push("");
    // App 级监控的状态是**推导**出来的：有还在监控的码就是"已找到链接"，否则"等待可用链接"。
    // 写死 state:"waiting" 会在找到链接之后继续说谎。
    const liveCodes = liveWishCodes(r, state);
    const shownState = appWatchState(r, state);
    L.push(`${i + 1}. <b>${esc(r.label || r.appName || code)}</b> — ${STATE_LABEL[shownState] || shownState || "未检查"}`);
    if (r.kind === "app") {
      // App 级监控没有具体链接 —— 别用 key 拼一个假 URL 出来
      if (r.appStoreId) L.push(`   App Store ${esc(r.appStoreId)}${r.bundleId ? "（" + esc(r.bundleId) + "）" : ""}`);
      // ⚠️ 只显示**现在真的在监控里**的码。
      // 以前直接显示 r.codes，于是 /del 掉链接之后这里还挂着一个幽灵码，
      // 状态却写着"等待可用链接" —— 自相矛盾（实测截图）。
      const live = liveCodes;
      if (live.length) {
        L.push(`   已找到的链接：${live.map((c) => `<code>${esc(c)}</code>`).join("、")}`);
      } else {
        L.push("   还没有可用的公开链接 —— 每轮 /scan 会按名字去找，出现了会主动告诉你");
      }
      if (r.joined) L.push("   🔕 已标记「已加入」：不再提醒（<code>/unjoined</code> 可恢复）");
      L.push(`   加入监控 ${esc(fmtStamp(r.firstSeen) || "?")}`);
      return;
    }
    const url = r.url || "https://testflight.apple.com/join/" + code;
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
    if (r.joined) L.push("   🔕 已标记「已加入」：不再提醒它的状态变化（<code>/unjoined</code> 可恢复）");
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
function groupByName(items, nameOf) {
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
function parseDeparturesArg(s) {
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
function mergeFindResults(tfs = [], depResolved = []) {
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

function findHints({ term, itunes = [], tfs = [], deps = [] }) {
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
async function lookupByName({ term, fetchImpl, log = () => {} }) {
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
function pickBestLink(items) {
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
function matchAppsByName(entries, term) {
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

async function findApp({ state, query, fetchImpl, log = () => {} }) {
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

/**
 * 按「码 / 名字」找出要操作的监控条目。给 `/joined` `/unjoined` `/del` 这类命令用。
 * 顺序：先当码认（含完整链接），再当 App 级监控的 key 认，最后按名字（精确优先、再包含）。
 */
function findWatchEntries(state, arg) {
  const t = String(arg == null ? "" : arg).trim();
  const links = (state && state.links) || {};
  if (!t) return [];
  const asCode = firstJoinCode(t) || t;
  if (links[asCode]) return [[asCode, links[asCode]]];
  if (links["app:" + t]) return [["app:" + t, links["app:" + t]]];
  const all = Object.entries(links);
  const low = t.toLowerCase();
  const eq = all.filter(([, r]) => String(r.label || "").trim().toLowerCase() === low);
  if (eq.length) return eq;
  return all.filter(([, r]) => String(r.label || "").toLowerCase().includes(low));
}

/**
 * 发现扫描捡到的这条链接，是不是命中某个「App 级监控」（`/add <名字>` 加的、当时还没有链接的那种）。
 *
 * 为什么单独判：`autoWatchDiscovered` 是个**全局**开关，而 App 级监控是用户**明确表达过意图**的 ——
 * 不该被那个开关拦住，否则"以后有可用链接就提醒我"这句承诺就是空的。
 */
/**
 * 两个名字是不是**同一个 App**。
 *
 * ⚠️ 这里绝不能用 includes：实测被它坑过 —— 用户 `/add 微信`（微信本体没有公开 TF 链接），
 * 发现扫描搜到「微信读书」的可加入链接，`"微信读书".includes("微信")` 成立，
 * 于是**把微信读书的链接当成"你要的"自动加进了监控**，用户莫名其妙多盯了一个 App。
 *
 * 规则：
 *   · 完全同名 -> 是
 *   · 一个严格是另一个的前缀，且后面**紧跟分隔符**（"番茄小说" vs "番茄小说 - 热门短剧…"）-> 是
 *   · 其它一律不是（"微信" vs "微信读书" 后面跟的是"读"，不是分隔符 -> 不是）
 */
function sameAppName(a, b) {
  const norm = (x) => String(x == null ? "" : x).trim().toLowerCase();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!long.startsWith(short)) return false;
  const rest = long.slice(short.length);
  return /^[\s\-—–:：|(（\[【]/.test(rest);
}

function wishMatches(rec, foundName, foundCode) {
  if (!rec || rec.kind !== "app") return false;
  // 只判"像不像"，**不判 joined** —— "要不要因为已加入而跳过"是调用方的决定。
  if ((rec.codes || []).includes(foundCode)) return false;
  const cands = [rec.label, rec.appName, ...(rec.keywords || [])];
  return cands.some((c) => sameAppName(c, foundName));
}

/**
 * 这个版本具备的功能标签。
 *
 * 为什么要它：我们反复遇到"改了但不确定部署上没有"—— 用户看到的旧行为可能是
 * ①没部署成功 ②部署了但依赖的外部接口挂了。**有一个可查的标记就不用猜了。**
 * 加新功能时顺手往这里补一条。
 */
const FEATURES = [
  "app-level-watch",     // /add <名字> 没链接也能加
  "joined-mute",         // /joined 静音状态来回，但新链接仍提醒
  "dep-add",             // /add dep=<id>
  "name-decision-offline", // /add 的"加哪个 App"不依赖 iTunes（429 也不影响）
  "tz-local",            // 时间按配置时区显示
  "human-time",          // 相对时间（3 分钟前）
];

/** 关键词 = 全局配置 ∪ 各在监控 App 派生的（新加的 App 才会被 /scan 捞到） */
function effectiveKeywords(cfg, state) {
  const set = new Set(cfg.keywords || []);
  for (const rec of Object.values(state.links || {})) {
    for (const k of rec.keywords || []) set.add(k);
  }
  return [...set];
}

/** 发现扫描用的 tfstore 查询词 = 配置里的 ∪ 各在监控 App 的名字（带上限，别把请求数打爆） */
function effectiveTfstoreQueries(cfg, state, cap = 8) {
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
function daysAgo(isoDate, now = new Date()) {
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

function setDisplayTimeZone(name, offsetMinutes) {
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

function getDisplayTimeZone() {
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

function nowStr(d = new Date()) {
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
function nowStamp(d = new Date()) {
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
function fmtStamp(v) {
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
function parseStamp(v) {
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
function humanDuration(v, now = new Date()) {
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
function humanAgo(v, now = new Date()) {
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
function departuresDisagrees(dep, ourState) {
  const d = String(dep || "").toLowerCase().trim();
  if (!d) return false;
  if (d === "open" || d === "available") return ourState !== "open";
  if (d === "closed" || d === "full") return ourState === "open";
  return false;   // 认不出来的状态不报，免得误报
}

function tzLabel(d = new Date()) {
  const { name, offsetMinutes, usable } = DISPLAY_TZ;
  if (usable) {
    const real = offsetMinutesForName(name, d);
    return real === null ? name : `${name}（${offsetLabel(real)}）`;
  }
  return offsetLabel(offsetMinutes);
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
  d.removed = d.removed || {};      // /del 的墓碑，见 monitorTargets
  return d;
}

function knownCodes(cfg) {
  return new Set((cfg.watch || []).map((w) => w && w.code).filter(Boolean));
}

function monitorTargets(cfg, state) {
  const out = {};
  // "墓碑"：用户 /del 过的码。没有它的话，配置 watch 里的码删了下一轮又会被加回来 ——
  // 用户收到"已移出监控"，半小时后它自己回来了（实测复现过）。
  const removed = (state && state.removed) || {};
  for (const w of cfg.watch || []) {
    if (w && w.code && !removed[w.code]) {
      // fromConfig 用来如实标注来源 —— 配置带进来的条目以前被写成 "manual"，
      // 那是**不实**的：用户根本没手动加过它。
      out[w.code] = { label: w.label || w.code, appStoreId: w.appStoreId,
                      departuresId: w.departuresId, fromConfig: true };
    }
  }
  for (const [code, rec] of Object.entries(state.links || {})) {
    if (!out[code] && !removed[code]) {
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
    // App 级监控：用户按名字加的、当时还没有链接 —— 没有码可轮询，交给发现扫描去找
    if (rec.kind === "app") {
      log(`  ${code} 是 App 级监控（暂无链接），跳过轮询`);
      continue;
    }
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
    const oldDescHash = rec.descHash;
    Object.assign(rec, {
      state: info.state, stateBasis: info.stateBasis, http: info.http, title: info.title,
      appName: info.appName || rec.appName || "",
      // ⚠️ 抓取失败时 info.desc 是空串 —— 不能拿它覆盖已存的好值。
      // 否则一次 429/超时就把 desc 清空，之后 oldDesc 恒为空，
      // "页面文案有变化"这条告警对**下一次真正的变化**永久漏报。
      desc: info.error ? rec.desc : info.desc,
      descHash: info.error ? rec.descHash : info.descHash,
      head: info.head, statusText: info.statusText, lastChecked: info.checkedAt,
    });
    if (info.error) rec.lastError = info.error;
    else delete rec.lastError;
    log(`  ${code} → ${STATE_LABEL[info.state] || info.state}${info.error ? "  (" + info.error + ")" : ""}`);

    // 标记为"已加入"的条目：状态照常更新，但**不发提醒**。
    // 为什么需要：用户已经上车了，再告诉他"链接满员了/又能进了"就是纯噪音 ——
    // 他既不需要重新加，也没法再做什么。
    const muted = !!rec.joined;

    if (oldState !== info.state) {
      const oldSince = rec.stateSince;
      rec.stateSince = nowStamp();
      if (!muted && (oldState !== undefined || info.state !== "open")) {
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
        if (await notifier.send(msg.join("\n"))) {
          events++;
        } else {
          // ⚠️ 发送失败（Telegram 429/5xx/网络抖动）时**把状态回退**：
          // 否则下一轮 oldState 已等于新状态，这次变化再也不会被报 —— 告警永久丢失。
          rec.state = oldState;
          rec.stateSince = oldSince;
          log("  ⚠️ 状态变化告警发送失败，已回退状态，下一轮会重试");
        }
      }
    }

    if (!muted && oldDesc && info.desc && oldDesc !== info.desc) {
      const msg = [
        `<b>${esc(rec.label || code)} TF 页面文案有变化</b>（可能对应新构建/新公告）`,
        `链接：${esc(info.url)}`,
        `旧：${esc(oldDesc.slice(0, 200))}`,
        `新：${esc(info.desc.slice(0, 200))}`,
        `时间：${nowStr()}`,
      ];
      if (await notifier.send(msg.join("\n"))) {
        events++;
      } else {
        rec.desc = oldDesc;
        rec.descHash = oldDescHash;
        log("  ⚠️ 文案变化告警发送失败，已回退 desc，下一轮会重试");
      }
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
    const next = { version: cur.version, checkedAt: nowStamp(), name: cur.name, releaseDate: cur.releaseDate || "" };
    // 这个 App Store id 下的监控项如果**全都**标记了"已加入"，版本更新也不用提醒了
    const allJoined = Object.values(state.links || {}).some((r) => String(r.appStoreId) === String(aid)) &&
      Object.values(state.links || {}).filter((r) => String(r.appStoreId) === String(aid)).every((r) => r.joined);
    if (!allJoined && old.version && old.version !== cur.version) {
      const msg = [
        `<b>App Store 正式版更新</b>：${esc(cur.name)}`,
        `版本：${esc(old.version)} → <b>${esc(cur.version)}</b>`,
        `上架日期：${esc(cur.releaseDate)}`,
        "<i>TF 上通常已经在测这个新版本（或更高的 beta）；TF 构建号 Apple 不公开，只能在 TestFlight App 里看。</i>",
        `时间：${nowStr()}`,
      ];
      // ⚠️ 版本号要**发送成功之后**才写：以前先写 state.appstore 再发，
      // 一次 Telegram 429/5xx 就让这条告警**永久丢失** —— 下一轮 old.version 已经等于新版本，
      // 再也不会报（和"状态变化告警"当初的 bug 是同一类，这里是漏掉的一处）。
      if (await notifier.send(msg.join("\n"))) {
        events++;
        state.appstore[String(aid)] = next;
      } else {
        // 发送失败：保留旧版本号（只刷新 checkedAt），下一轮会重试
        state.appstore[String(aid)] = { ...next, version: old.version };
        log("  ⚠️ 版本更新告警发送失败，保留旧版本号，下一轮会重试");
      }
    } else {
      state.appstore[String(aid)] = next;
      if (!old.version) log(`  记录 ${cur.name || aid} 正式版基线：${cur.version}`);
    }
  }

  state.meta.lastCheck = nowStamp();
  log(`本轮结束，产生 ${events} 条事件。`);
  return events;
}

// ─────────────────────────── 发现 ───────────────────────────

/**
 * 这条发现记录里是不是**有一条该发、却没发出去的告警**（= 下一轮要重发）？
 *
 * ⚠️ 判据不能是 `notified === false` —— 那个字段在两种完全不同的情况下都是 false：
 *   ① 该发但发送失败（要重试）
 *   ② 首次发现就是满员/已关闭，按设计**只记录、不打扰**（没有告警要发，不该重试）
 * 混在一起的后果实测过：②的码后来变成可加入时，标题会写成「🆕 发现新的 TF 链接」
 * （其实是老码状态变了），而且它一旦进了监控列表还会被重发一遍。
 * `test/apps.test.mjs` 里「满员→可加入必须提醒」和「发送失败下一轮必须重发」两条
 * 正好把这两种情况钉在一起，所以必须用两个字段分开表达。
 *
 * 兼容老记录：没有 `unsent` 时，`notified === false` 仍当成有待发告警 ——
 * 宁可多发一次，也不能把「链接开放了」这条核心告警永久丢掉。
 */
function hasUnsentAlert(rec) {
  if (!rec) return false;
  if (rec.unsent !== undefined) return rec.unsent === true;
  return rec.notified === false;
}

async function registerDiscovery({ cfg, state, notifier, log = () => {}, fetchImpl }, item) {
  const code = item.code;
  if (!code) return 0;
  if (state.links[code] || knownCodes(cfg).has(code)) {
    // ⚠️ 一个必须放行的例外：上一轮"发现扫描把它自动加进了监控、但那条告警没发出去"。
    // 这时 code 已经在 state.links 里了，如果在这里 return 0，下面"发送失败下一轮重试"
    // 的承诺就永远兑现不了 —— 最核心的那条告警（链接从满员变成可加入）会永久丢失。
    // 实测复现过。
    if (!hasUnsentAlert(state.discoveries[code])) return 0;
  }

  // ⚠️ 用户 /del 过的码（墓碑）不能再被发现扫描"复活"。
  // 复活的后果是自相矛盾 + 静默失效：它会被写进 state.links，/links 说"监控中"、
  // 消息还说"已自动加入监控列表"，但 monitorTargets 仍按墓碑把它排除 ——
  // **永远不轮询**，状态再也不更新（用户以为在盯，其实没盯）。
  if (state.removed && state.removed[code]) return 0;

  // ⚠️ 以前这里是「只要在 discoveries 里就 return 0」，后果很严重：
  // **首次发现时是满员/已关闭的码，之后变成可加入也永远不会再被探测** ——
  // 而发现源搜到的码绝大多数当时都是满员的，等于这个机器人最核心的承诺
  // （"链接开放时告诉你"）在最常见的路径上失效。
  //
  // 现在：只有**已经知道它是 open** 的才跳过；已知但不是 open 的，**每轮重新探一次**，
  // 状态一变就提醒。代价是每轮多几个请求，换来的是不漏报。
  const prev = state.discoveries[code];
  // ⚠️ 这里也要放行"上一轮该发但没发出去"的，否则它会先被"已经知道是 open 了"挡掉，
  // 重试永远发生不了。
  if (prev && prev.state === "open" && !hasUnsentAlert(prev)) {
    // ⚠️ 顺手刷新"最近一次见到它"的时间。discoveries 是按 foundAt 裁到 60 条的，
    // 而已知 open 的码会一直走这个分支、foundAt 永远停在首次发现那一刻 ——
    // 攒够 60 条别的记录后它会被裁掉，下一轮又被当成「🆕 发现新的 TF 链接」重报一遍
    // （实测复现：第 61 条新记录一进来，这个老码就重报了）。
    // 刷新后裁剪窗口 =「最近见到的 60 条」，而不是「最近变更过的 60 条」。
    prev.foundAt = nowStamp();
    return 0;
  }

  const info = await probeJoin(code, { fetchImpl });
  const prevState = prev ? prev.state : null;
  item.state = info.state;
  item.foundAt = nowStamp();
  item.appName = item.appName || info.appName || info.title || "";

  // 状态没变的复探：只刷新时间，**不发消息**（否则同一码每轮都会被"发现"一次，变成噪音）。
  // 例外：上一轮"该发但没发出去"（有待发告警）要继续重试。
  if (prev && prevState === info.state && !hasUnsentAlert(prev)) {
    prev.foundAt = item.foundAt;
    prev.lastChecked = info.checkedAt;
    prev.context = item.context || prev.context;
    return 0;
  }

  // ⚠️ **只有值得说的才发消息**：
  //   · 首次发现就是「可加入」-> 发（这才是用户要的）
  //   · 状态变化且涉及「可加入」-> 发（"现在能加入了" / "又满了"）
  //   · 首次发现是「已满员/已关闭/探测失败」-> **只记录，不发**
  // 以前不加这个判断：一次 /scan 能刷出十几条"已满员"，用户根本不知道这些能干什么，
  // 而真正有用的那条被淹在噪音里。现在满员的照样记进 discoveries、照样每轮复探，
  // 一旦变成可加入就会提醒 —— 信息没丢，只是不提前打扰。
  const worthTelling = info.state === "open" || prevState === "open";

  const aw = cfg.autoWatchKeywords || [];
  const blob = ((item.appName || "") + " " + (item.context || "")).toLowerCase();
  const autoOk = !aw.length || aw.some((k) => blob.includes(String(k).toLowerCase()));
  // 命中"App 级监控"时不受 autoWatchDiscovered 全局开关约束（见 wishMatches 的说明）
  const wish = Object.entries(state.links || {})
    .find(([, r]) => wishMatches(r, item.appName, code));
  const wishJoined = !!(wish && wish[1].joined);
  // 已标记「已加入」的 App：**新链接照样告诉你**（这是真信息），
  // 只是不再自动加进监控列表 —— 用户都上车了，不需要再多盯一条。
  const byWish = !!wish && !wishJoined && info.state === "open";
  const watched = (!!cfg.autoWatchDiscovered && autoOk && info.state === "open") || byWish;
  if (watched) {
    const rec = (state.links[code] = state.links[code] || {});
    Object.assign(rec, {
      label: item.appName || code, firstSeen: nowStamp(), sources: [item.source],
      state: info.state, url: info.url, appName: info.appName, desc: info.desc,
      descHash: info.descHash, lastChecked: info.checkedAt,
    });
    if (!rec.stateSince) rec.stateSince = nowStamp();
    // 同一个 App 的**别的**链接如果已经标记过「已加入」，这条新链接也一并静音。
    // 否则用户会开始收到这条新链接的"满员 ↔ 又能进"来回 ——
    // 而他要的信息（"有新链接了"）上面那条提醒已经给过了。
    //
    // ⚠️ 身份判断用 sameAppName()，**不用 includes**：`"番茄小说".includes("番茄")` 会成立，
    // 于是"用户 joined 了「番茄」"会把**另一个** App（"番茄小说 - 热门短剧"）的新链接
    // 也一并静音 —— 而按本项目自己的规则，这两个名字不是同一个 App。
    // （includes 做身份判断已经咬过两次，这是第三处，统一收敛到 sameAppName。）
    const siblingJoined = Object.values(state.links || {}).some((r) =>
      r !== rec && r.joined && item.appName &&
      (sameAppName(r.label, item.appName) || sameAppName(r.appName, item.appName)));
    if (siblingJoined) { rec.joined = true; rec.joinedInherited = true; }
  }
  if (byWish) {
    const wr = wish[1];
    wr.codes = [...new Set([...(wr.codes || []), code])];
    wr.lastFoundAt = nowStamp();
    log(`  命中 App 级监控「${wr.label}」→ ${code}（${STATE_LABEL[info.state] || info.state}）`);
  }

  // 这一轮若是"上一轮该发没发出去"的重发，标题别写"状态变了"（状态其实没变）
  const retryUnsent = hasUnsentAlert(prev);
  const msg = [
    (prevState && !retryUnsent) ? "<b>🔄 之前发现的链接状态变了</b>" : "<b>🆕 发现新的 TF 链接</b>",
    `join 码：<code>${esc(code)}</code>`,
    `链接：${esc(info.url)}`,
    `当前状态：<b>${STATE_LABEL[info.state] || info.state}</b>`,
  ];
  if (item.appName) msg.push(`应用：${esc(item.appName)}`);
  msg.push(`来源：${esc(item.source || "")}`);
  if (item.context) msg.push(`上下文：${esc(String(item.context).slice(0, 200))}`);
  if (watched) {
    msg.push("已自动加入监控列表。");
    if (state.links[code] && state.links[code].joinedInherited) {
      msg.push("（同 App 的其它链接你标记过「已加入」，这条也一并静音了）");
    }
  }
  else if (wishJoined) msg.push("（这个 App 你标记过「已加入」，所以没自动加进监控 —— 但新链接仍然告诉你）");
  else if (info.state === "open") msg.push(`（未自动加入监控：应用名没命中 autoWatchKeywords。要盯就发 /add ${esc(code)}）`);
  msg.push(`时间：${nowStr()}`);

  // ⚠️ 记账要放在**发送成功之后**：以前先写 discoveries 再发，一旦发送失败
  // （Telegram 429/5xx/网络抖动），这条告警就永久丢了 —— 下一轮被去重门挡住，再也不会提。
  // 记录：**不管发不发都记** —— /links 要看它，去重和"每轮复探"也靠它。
  //
  // ⚠️ `unsent` 是"有没有待发告警"的**唯一**判据（见 hasUnsentAlert）。
  // 不值得打扰的记录**不能**标成未通知：它没有告警要发，标了就等于承诺一条永远不会来的重发，
  // 而且会让这个码下次真的开放时被当成"重发"（标题写成「🆕 发现新的 TF 链接」）。
  if (worthTelling) { item.notified = false; item.unsent = true; }
  else { delete item.notified; item.unsent = false; }
  state.discoveries[code] = item;
  // 裁剪：discoveries 只增不删的话 /links 迟早被 tgPrepare 静默截断（实测约 40-90 条就截）。
  //
  // ⚠️ 淘汰顺序不能只看时间：已知 open 的码会一直走上面"跳过复探"那条路，它的 foundAt
  // 虽然每次刷新，但同一轮里所有码的时间戳精度只到秒（nowStamp）—— 一旦窗口满了，
  // 排序会退化成"按插入顺序"，**最早发现的那个 open 码第一个被淘汰**，下一轮它又被当成
  // 「🆕 发现新的 TF 链接」重报一遍（实测复现：窗口一满就开始 churn，每轮重报一条）。
  // 所以按"淘汰代价"排：先淘汰已知非 open 的（淘汰它无害 —— 下次扫到会重新记下，
  // 而"满员→可加入"那条告警本来就要等它变成 open 才发），带未发告警的最后淘汰。
  const keys = Object.keys(state.discoveries);
  if (keys.length > 60) {
    const rank = (k) => {
      const r = state.discoveries[k];
      if (hasUnsentAlert(r)) return 2;                  // 有待发告警：最后淘汰
      return r && r.state === "open" ? 1 : 0;           // 已知 open：其次；其余先淘汰
    };
    keys.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return String(state.discoveries[a].foundAt || "").localeCompare(String(state.discoveries[b].foundAt || ""));
    });
    for (const k of keys.slice(0, keys.length - 60)) delete state.discoveries[k];
  }

  if (!worthTelling) {
    log(`  ${code} → ${STATE_LABEL[info.state] || info.state}（不值得打扰，只记录；变成可加入时会提醒）`);
    return 0;
  }

  const sent = await notifier.send(msg.join("\n"));
  if (sent) {
    item.notified = true;
    item.unsent = false;
    return 1;
  }
  // 发送失败：unsent 保持 true，下一轮不会被"状态没变"的短路挡掉，会重发
  log(`  ⚠️ 发现告警发送失败，标记未通知，下一轮会重试（${code}）`);
  return 0;
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

function renderStatus(cfg, state) {
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
    // ⚠️ 这里以前直接印 rec.state，而 App 级监控的 state 是创建时写死的 "waiting" ——
    // 于是 /status 会出现「微信 — 等待可用链接 ⏳」紧跟着「已找到链接：7Jg9MM8h」
    // 这种自相矛盾（老板截图过的 /apps 那条，只修了 /apps，这里漏了）。
    // 现在两边都用同一个推导函数 appWatchState()。
    const shown = appWatchState(rec, state);
    L.push(`· <b>${esc(rec.label || code)}</b> — ${STATE_LABEL[shown] || shown || "未检查"}`);
    if (rec.kind === "app") {
      const cs = liveWishCodes(rec, state);   // 只算真的在监控的
      L.push(cs.length
        ? `  已找到链接：${cs.map((c) => `<code>${esc(c)}</code>`).join("、")}`
        : "  还没有可用的公开链接（/scan 会按名字去找）");
      if (rec.joined) L.push("  🔕 已加入，不再提醒");
      continue;
    }
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

function renderLinks(state) {
  const links = Object.keys(state.links || {});
  // 已经在监控里的码不再列到"历史发现"那栏 —— 否则同一个码在同一份输出里
  // 一处说"监控中"、一处说"未在监控"，自相矛盾
  const disc = Object.keys(state.discoveries || {}).filter((c) => !state.links[c]);
  if (!links.length && !disc.length) return "还没有任何记录。";
  const L = ["<b>已知 join 码</b>"];
  for (const code of links.sort()) {
    const rec = state.links[code];
    // App 级监控的 state 是创建时写死的 "waiting"，要按事实推导
    // （和 /apps、/status 用同一个函数，别再各写一份）
    const shown = appWatchState(rec, state);
    L.push(`· <code>${esc(code)}</code> ${esc(rec.label || "")}（监控中，${STATE_LABEL[shown] || shown || "未检查"}）`);
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

<b>加 App</b>
/add &lt;名字&gt; — 按名字<b>加进监控</b>。<b>现在有没有可用链接都能加</b>：
    有链接就挂上盯着；还没有就记下这个 App，等出现了主动告诉你
    例：<code>/add 微信读书</code>
/add &lt;TestFlight链接或join码&gt; — 手上有链接时直接用
/add dep=&lt;id&gt; — 只有 departures 的 app id 时（会反解出 TF 码）
    加的时候 App Store id、bundle id、departures.to id 会<b>自动补齐</b>
/apps — 看监控中的 App 都盯了什么
/del &lt;码&gt; — 移出监控
/joined &lt;名字或码&gt; — 标记「我已经上车了」→ <b>之后不再提醒</b>它（状态照样更新）
/unjoined &lt;名字或码&gt; — 恢复提醒
    注意：标记「已加入」只压掉"同一条链接的状态来回"和版本更新；
    **发现这个 App 的新链接时仍然会告诉你**（那是真信息，不是噪音）

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

async function handleCommand({ cfg, state, notifier, text, chatId, log = () => {}, fetchImpl, runner }) {
  const allowed = String((cfg.telegram && cfg.telegram.chatId) || "").trim();
  if (allowed && String(chatId) !== allowed) {
    log(`忽略来自非授权会话 ${chatId} 的命令`);
    return;
  }
  const parts = String(text || "").trim().split(/\s+/);
  if (!parts.length || !parts[0]) return { mutated: false };
  const cmd = parts[0].split("@")[0].toLowerCase();
  log("收到命令：" + cmd);
  const run = runner || { runMonitor, runDiscovery };
  // 这条命令有没有改 state。runner 据此决定要不要落盘 ——
  // 只读命令（/status /apps /links /find /help …）**绝不能写回整份 state**：
  // 它会把这段时间里 cron 或别的命令写下的更新整份覆盖掉（实测过：/status 一回写，
  // cron 刚记录的"满员→可加入"就没了，下一轮还会重复告警一次）。
  let mutated = false;

  if (cmd === "/start" || cmd === "/help") {
    // 顺手把 Telegram 的命令菜单刷成当前版本 —— 加了新命令后，
    // 用户按 / 就能看到，不需要知道"要重发一次 /set-commands"。
    // 失败不影响主流程（菜单只是便利设施）。
    if (run.setCommands) {
      try {
        const r = await run.setCommands();
        log(`已刷新命令菜单（${r && r.count ? r.count : "?"} 条）`);
      } catch (e) {
        log("刷新命令菜单失败（不影响使用）：" + (e && e.message));
      }
    }
    await notifier.send(HELP);
  } else if (cmd === "/status") {
    await notifier.send(renderStatus(cfg, state));
  } else if (cmd === "/links") {
    await notifier.send(renderLinks(state));
  } else if (cmd === "/check") {
    mutated = true;
    await notifier.send("开始监控检查…");
    const n = await run.runMonitor({ cfg, state, notifier, log, fetchImpl });
    await notifier.send(`检查完成，${n === 0 ? "无变化" : "产生 " + n + " 条事件"}。`);
  } else if (cmd === "/scan") {
    mutated = true;
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
    // ⚠️ mutated 不能在分支入口就置位：这条分支里有几个"什么都没干就返回"的出口
    // （参数不全、dep 反解失败）—— 入口置位会让它们照样回写整份 state。
    // 只在**真的改了 state** 的那两处置位（见下面的 App 级分支与主分支）。
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
    let asCode = depId ? "" : firstJoinCode(arg);
    // 裸 token 探测结果是 404 时，下面会走"按 App 名字加" —— 但要**说清楚**，
    // 否则用户看到「已加入监控（App 级）：dTUO1uyt」会以为自己把那条链接加上了。
    let bareTokenDead = false;
    if (!asCode && !depId && /^[A-Za-z0-9]{6,14}$/.test(arg)) {
      // ⚠️ 裸 token 有歧义：它可能真是 join 码，也可能是 6-14 位的英文 App 名
      // （Telegram / Spotify / WeChat / Alipay …）。以前直接当码处理，于是
      // `/add Telegram` 会建出一条永远"链接失效"的垃圾条目、每轮白请求一次，
      // 而用户想加的 App 根本没加上（回复还说"已加入监控"）。
      // 先探一下：真的是个 TestFlight 页面才当码，否则按名字走。
      const probe = await probeJoin(arg, { fetchImpl });
      if (probe.http === 200) {
        asCode = arg;                 // 真取到了 TestFlight 页面 -> 它是 join 码
      } else if (probe.state === "error") {
        // ⚠️ 探测失败（超时/网络抖动）时**不能猜**。以前的判据是 `state !== "invalid"`，
        // 于是"探测失败"也落进"当成 join 码"：`/add Telegram` 会建出一条
        // https://testflight.apple.com/join/Telegram 的垃圾记录（状态永远"检查失败 ⚠️"、
        // 每轮白请求一次），而用户真正想加的 App 根本没加上。
        // 这里如实说清，并给两条明确出路。
        await notifier.send([
          `⚠️ 探测 <code>${esc(arg)}</code> 失败（${esc(probe.error || "网络异常")}）——` +
            `没法确定它是 join 码还是 App 名字，所以这次<b>什么都没加</b>。`,
          `· 确认它是 join 码：<code>/add https://testflight.apple.com/join/${esc(arg)}</code>`,
          `· 确认它是 App 名字：稍后重发 <code>/add ${esc(arg)}</code>`,
        ].join("\n"));
        return;
      }
      // 404（state=invalid）：不是 TestFlight 页面 -> 按 App 名字走（下面那条分支）
      // ⚠️ 但"长得像码、Apple 却 404"要单独说一句：不说的后果实测过 ——
      // `/add dTUO1uyt`（码已失效/打错一个字母）会静默建出一条 App 级监控，
      // 回复还是「✅ 已加入监控（App 级）：dTUO1uyt」，用户以为链接加上了，
      // 而且这个名字还会被每轮 /scan 当关键词去搜。
      else bareTokenDead = true;
    }
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
      // ⚠️ 这里以前只设 departures，把用户显式给的 appstore= / bundle= **静默丢掉**了
      // （回复还建议他"可手动指定 appstore=<id>"）。和 asCode 分支用同一套解析。
      const nameParts = [];
      for (const t of parts.slice(2)) {
        const m = /^(appstore|departures|bundle)=(.+)$/i.exec(t);
        if (m) opts[m[1].toLowerCase()] = m[2].trim();
        else nameParts.push(t);
      }
      givenName = nameParts.join(" ").trim();
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

      const lowName = name.toLowerCase();
      // ⭐ 决策只看一件事：**TF 条目里有没有名字完全相等的**。
      //
      // ⚠️ 为什么不能把决策挂在 iTunes 上（我第一版就是这么写的，然后又被实测打回）：
      // Cloudflare 的出口 IP 是全平台共享的，iTunes 按 IP 限流，所以 Worker 上 iTunes
      // 经常 429。一旦它失败，"App Store 里有没有精确同名"就查不出来，逻辑退回
      // "名字里含关键词" —— `/add 微信` 于是又变成列「微信读书/微信输入法」并拒绝。
      // **决策必须建立在最稳的来源上**：tfstore/departures 的 app 名。
      const exactGroups = groupByName(
        look.merged.filter((m) => String(m.appName || "").trim().toLowerCase() === lowName),
        (x) => x.appName
      );
      // 近似候选只用于"顺便说一句"，**不参与决策**
      const nearGroups = matchAppsByName(look.merged, name)
        .filter((g) => String(g.name || "").trim().toLowerCase() !== lowName);

      if (!exactGroups.length) {
        // ⭐ 没有名字完全相等的链接 -> **照样加进监控**（App 级监控）。
        // 用户说"加微信"就是想盯微信；至于它现在有没有公开 TF 链接，那是另一回事。
        const auto = bestItunesHit(look.itunes || [], name);
        const bestIt = auto.hit;                    // iTunes 只用来补 id/bundle，可有可无
        const itScore = auto.score;
        const label = name;                         // 标签用用户输入的名字，iTunes 的完整名放附注
        const appStoreName = bestIt ? bestIt.trackName : "";
        const existing = Object.entries(state.links).find(([, r]) =>
          r.kind === "app" && String(r.label || "").trim() === label.trim());
        const key = existing ? existing[0] : ("app:" + (bestIt && bestIt.trackId ? bestIt.trackId : label));
        mutated = true;   // 从这里开始真的改 state 了
        const wr = (state.links[key] = state.links[key] || {});
        // ⚠️ 只在**这次查到了**才覆盖 id/bundle —— 否则 iTunes 一次 429 就会把
        // 上次查到的 appStoreId 抹成 undefined（JSON.stringify 会直接丢掉这个字段），
        // 该 App 的"正式版更新"告警从此永久失效，而用户完全看不出发生了什么。
        const patch = {
          kind: "app",
          label,
          appName: label,
          firstSeen: wr.firstSeen || nowStamp(),
          sources: [...new Set([...(wr.sources || []), "manual"])],
          state: "waiting",
          joined: !!wr.joined,
        };
        if (bestIt) {
          patch.appStoreId = bestIt.trackId;
          patch.appStoreName = appStoreName;
          patch.bundleId = bestIt.bundleId || "";
          patch.keywords = deriveKeywords(label, bestIt.bundleId || "");
        } else if (!wr.keywords) {
          patch.keywords = deriveKeywords(label, wr.bundleId || "");
        }
        Object.assign(wr, patch);
        await notifier.send([
          `✅ 已加入监控（App 级）：<b>${esc(label)}</b>`,
          bestIt ? `App Store：${esc(bestIt.trackId)}${bestIt.bundleId ? "（" + esc(bestIt.bundleId) + "）" : ""}` : "",
          // ⚠️ 长得像 join 码、Apple 却 404：必须说清楚，否则用户以为链接加上了
          bareTokenDead
            ? `⚠️ <i>「${esc(name)}」看着像个 join 码，但 Apple 那边 404（链接已失效或拼错了）——` +
              `这次是按 <b>App 名字</b>记下的。要加的是链接就核对后重发。</i>`
            : "",
          "",
          "现在<b>还没有名字对得上的公开 TF 链接</b> —— 但我记住了这个 App：",
          "· 每轮 <code>/scan</code> 会按它的名字去 tfstore / departures / 搜索引擎找",
          "· <b>一旦出现能加入的链接，我会主动告诉你</b>",
          "· 也可以随时 <code>/find " + esc(name.slice(0, 20)) + "</code> 手动查一次",
          (bestIt && itScore < 3) ? `<i>App Store 匹配到的是：${esc(appStoreName)}（近似名匹配，不确定就核对一下）</i>` : "",
          // 名字里含关键词的其它 App —— 用户可能其实想加那些，所以附上可直接点的命令
          nearGroups.length ? [
            "",
            `<i>顺便说：tfstore / departures 上名字里含「${esc(name)}」的是这些（都不是「${esc(name)}」本身）：</i>`,
            ...nearGroups.slice(0, 4).map((g) => `<i>· ${esc(g.name)}　` +
              g.items.slice(0, 3).map((x) => `<code>/add ${esc(x.code)}</code>`).join("　") + `</i>`),
          ].join("\n") : "",
        ].filter(Boolean).join("\n"));
        // ⚠️ 这里必须是 `return { mutated }`，不能是裸 `return;` ——
        // 裸 return 返回 undefined，handleUpdate 的 `if (res && res.mutated)` 就不落盘，
        // 于是"已加入监控（App 级）"这句回复是**假的**：这一条 App 级监控请求一结束就没了。
        // （实测：走 handleUpdate 时 KV 一次都没写；这条分支是 2026-10-14 引入 mutated 时漏掉的。）
        return { mutated };
      }
      const g = exactGroups[0];

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
    mutated = true;   // 从这里开始真的改 state 了
    const rec = (state.links[code] = state.links[code] || {});
    if (state.removed && state.removed[code]) delete state.removed[code];   // 重新加 -> 撤销墓碑
    // ⚠️ 探测失败（超时/429/5xx）时 e.state 是 "error"、e.desc/e.descHash 是空串 ——
    // **不能拿它覆盖已有记录**：否则下一轮 runMonitor 会推一条假的
    // 「检查失败 ⚠️ → 可加入 ✅」，而且 desc 基线被清空后，页面说明的真实变化会被
    // 当成新基线静默吞掉（runMonitor 里专门为这件事写过不变式，这里是漏掉的一处）。
    // 这条路真实可达：/apps 在缺绑定时会主动建议用户"重新 /add 一次可自动补"。
    //
    // ⚠️ 而且**连新建记录也不能写 "error"**：新建时 rec.state 是空的，照抄 e.state 就等于
    // 先给它安一个"检查失败"的旧状态，下一轮成功探测时同样会推那条假的
    // 「检查失败 ⚠️ → 可加入 ✅」（实测复现：/add <链接> 时网络抖动 → 下一轮假告警）。
    // 留空 = "未检查"，下一轮的成功探测就是**首次检查**（可加入时按设计不打扰）。
    const failed = e.state === "error";
    Object.assign(rec, {
      label: givenName || e.appName || rec.label || code,
      appName: e.appName || rec.appName || "",
      firstSeen: rec.firstSeen || nowStamp(),
      sources: [...new Set([...(rec.sources || []), "manual"])],
      url: e.url || rec.url,
      desc: failed ? (rec.desc || "") : e.desc,
      descHash: failed ? (rec.descHash || "") : e.descHash,
      lastChecked: e.checkedAt,
      keywords: e.keywords || [],
    });
    if (!failed) rec.state = e.state;   // 失败：保留旧状态；从来没有过就继续留空（= 未检查）
    if (opts.appstore) { rec.appStoreId = /^\d+$/.test(opts.appstore) ? Number(opts.appstore) : opts.appstore; rec.appStoreSource = "manual"; }
    else if (e.appStoreId) { rec.appStoreId = e.appStoreId; rec.appStoreSource = "auto"; }
    if (opts.bundle) rec.bundleId = opts.bundle;
    else if (e.bundleId) rec.bundleId = e.bundleId;
    if (opts.departures) { rec.departuresId = /^\d+$/.test(opts.departures) ? Number(opts.departures) : opts.departures; rec.departuresSource = "manual"; }
    else if (derivedDepartures) { rec.departuresId = /^\d+$/.test(derivedDepartures) ? Number(derivedDepartures) : derivedDepartures; rec.departuresSource = "auto"; }
    else if (e.departuresId) { rec.departuresId = e.departuresId; rec.departuresSource = "auto"; }
    // stateSince 只在**真的有状态**时才记：留空状态的记录写"状态已保持 X"是自相矛盾
    if (rec.state && !rec.stateSince) rec.stateSince = nowStamp();

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
  } else if (cmd === "/joined" || cmd === "/done" || cmd === "/unjoined") {
    // mutated 只在真的改了 state 之后置位（见下面 for 之前）——
    // 这条分支有几个"没匹配到 / 匹配到多条让你说具体点"的出口，
    // 它们什么都没改，不该回写整份 state。
    const undo = cmd === "/unjoined";
    if (parts.length < 2) {
      await notifier.send(`用法：<code>${cmd} &lt;App名字 或 join码&gt;</code>\n` +
        (undo ? "恢复提醒。" : "标记「我已经上车了」→ 之后<b>不再提醒</b>这个 App 的链接状态变化（状态照样更新）。") +
        "\n例：<code>" + cmd + " 番茄小说</code>");
      return;
    }
    const arg = parts.slice(1).join(" ").trim();
    const hit = findWatchEntries(state, arg);
    if (!hit.length) {
      await notifier.send(`监控列表里没有匹配「${esc(arg)}」的条目。发 <code>/apps</code> 看有哪些。`);
      return;
    }
    if (hit.length > 1 && !undo) {
      await notifier.send(`「${esc(arg)}」匹配到 ${hit.length} 条 —— 说具体点，或用 join 码：\n` +
        hit.slice(0, 6).map(([k, r]) => `· ${esc(r.label || k)}　<code>${esc(k)}</code>`).join("\n"));
      return;
    }
    mutated = true;
    // ⚠️ 命中 App 级记录时，要**连带它现在盯着的那些码一起**标记。
    // 原因：状态告警挂在**码**上（runMonitor 只看 monitorTargets，也就是码），
    // 只把 App 级记录标成 joined 等于没静音 —— 用户被告知"之后不再提醒"，
    // 然后照样收到这条链接的"满员 ↔ 又能进"（实测复现：/joined 微信读书 之后满员仍然告警）。
    const targets = [...hit];
    for (const [, r] of hit) {
      if (!r || r.kind !== "app") continue;
      for (const c of liveWishCodes(r, state)) {
        if (!targets.some(([k]) => k === c)) targets.push([c, state.links[c]]);
      }
    }
    for (const [, r] of targets) {
      if (undo) { delete r.joined; delete r.joinedAt; }
      else { r.joined = true; r.joinedAt = nowStamp(); }
    }
    const names = [...new Set(targets.map(([, r]) => r.label || "?"))].map((x) => esc(x)).join("、");
    await notifier.send(undo
      ? `🔔 已恢复提醒：${names}`
      : `🔕 已标记「已加入」：${names}\n` +
        `<i>之后这个 App 的链接状态变化不再提醒你（状态照样更新）。想恢复发 <code>/unjoined ${esc(arg.slice(0, 20))}</code></i>`);
  } else if (cmd === "/del" && parts.length < 2) {
    await notifier.send("用法：<code>/del &lt;join 码 或 App名字&gt;</code>\n例：<code>/del dTUO1uyt</code> 或 <code>/del 微信读书</code>");
  } else if (cmd === "/del") {
    // mutated 只在**真的删掉了**那一支置位：/del 打错字（没匹配到）或匹配到多条时
    // 什么都没改，不该回写整份 state（那会覆盖并发期间 cron 写下的更新）。
    const hit = findWatchEntries(state, parts.slice(1).join(" ").trim());
    if (hit.length > 1) {
      await notifier.send(`「${esc(parts.slice(1).join(" "))}」匹配到 ${hit.length} 条 —— 说具体点或用 join 码：\n` +
        hit.slice(0, 6).map(([k, r]) => `· ${esc(r.label || k)}　<code>${esc(k)}</code>`).join("\n"));
    } else if (hit.length === 1) {
      mutated = true;
      const k = hit[0][0];
      delete state.links[k];
      // 从各 App 级监控的 codes 里摘掉，否则 /apps 会一直挂着一个"已找到但没在监控"的幽灵码
      for (const r of Object.values(state.links)) {
        if (r && r.kind === "app" && Array.isArray(r.codes)) r.codes = r.codes.filter((c) => c !== k);
      }
      state.removed = state.removed || {};
      state.removed[k] = nowStamp();   // 墓碑：否则配置 watch 里的码下一轮会被加回来
      await notifier.send(`已移出监控：<code>${esc(k)}</code>\n<i>（已记下"别再监控"；想恢复就 /add 一次）</i>`);
    } else {
      await notifier.send(`监控列表里没有匹配 <code>${esc(parts.slice(1).join(" "))}</code> 的条目。发 <code>/apps</code> 看有哪些。`);
    }
  } else {
    await notifier.send("未知命令。发 /help 看用法。");
  }
  return { mutated };
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

  // 显示时区。⚠️ serverless 没有"本地时间"：Worker 跑在边缘节点上，Date 默认是 UTC。
  // timezone 走 Intl（能处理夏令时）；它不可用/数据缺失时自动退回 utcOffsetMinutes。
  timezone: "Asia/Shanghai",
  utcOffsetMinutes: 480,

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
    discovery: "5 */6 * * *",
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

  // 显示时区（可选；默认已在 DEFAULT_CONFIG 里给了 Asia/Shanghai）
  if (env.TIMEZONE) {
    cfg.timezone = String(env.TIMEZONE);
    // ⚠️ core.js 里 "UTC" 被刻意当成"没有时区名"、走**固定偏移**那条路（有测试钉着）。
    // 而固定偏移的默认值是 480 —— 于是 `TIMEZONE=UTC` 会静默显示成 UTC+8（北京时间），
    // 用户配了 UTC 却看到 +8，而且看不出来为什么。这里把偏移一起摆正。
    if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(cfg.timezone.trim())) cfg.utcOffsetMinutes = 0;
  }
  if (env.UTC_OFFSET_MINUTES !== undefined && String(env.UTC_OFFSET_MINUTES) !== "") {
    const n = Number(env.UTC_OFFSET_MINUTES);
    if (Number.isFinite(n)) cfg.utcOffsetMinutes = n;
  }

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
  if (!kv) throw new Error("缺少 KV 绑定：请在 wrangler.jsonc / 控制台绑定 KV 命名空间到 STATE");
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
 * 解析 Upstash 的响应。
 *
 * ⚠️ **必须先看 `res.ok` 再 `res.json()`**：Upstash 边缘节点 5xx / 网关错误返回的是 HTML，
 * 直接 `res.json()` 会抛一个「Unexpected token '<'」的 SyntaxError ——
 * 看日志的人完全不知道是存储挂了，而 doRun 会因为这一句整轮中断（这一轮的告警全丢，
 * 要等下一轮才重试）。这里把非 2xx 和非 JSON 都翻译成一句能看懂的话。
 */
async function upstashJson(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`Upstash ${what}失败：HTTP ${res.status} ${text.slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Upstash ${what}返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
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
      const json = await upstashJson(res, "读取");
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
      const json = await upstashJson(res, "写入");
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





/**
 * 把"填了但其实是占位"的值当成未配置。
 *
 * 为什么需要：Cloudflare 的部署表单会把 `.dev.vars.example` 里每个未注释项都当**必填**，
 * 于是有人会随手填个 `0` / `TODO` 把表单过了 —— 那样 bot 会把消息发到 chat 0，
 * 报一个很难懂的错。这里直接识别成"未配置"，并给出可执行的提示。
 */
function isPlaceholder(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "" || s === "0" || s === "-" || s === "todo" || s === "tbd" ||
    s === "changeme" || s === "placeholder" || s === "none" || s === "null" || s === "x";
}

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
  if (cfg.telegram && isPlaceholder(cfg.telegram.chatId)) cfg.telegram.chatId = "";
  // 时区要在任何 nowStr() 之前设定 —— Worker 里 Date 默认是 UTC
  setDisplayTimeZone(cfg.timezone, cfg.utcOffsetMinutes);

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
    if (cfg.telegram && isPlaceholder(cfg.telegram.chatId)) cfg.telegram.chatId = "";
    setDisplayTimeZone(cfg.timezone, cfg.utcOffsetMinutes);
    const msg = update.message || update.channel_post || update.edited_message;
    if (!msg) return { ok: true, skipped: "无 message 字段" };
    const text = msg.text || "";
    if (!text.startsWith("/")) return { ok: true, skipped: "非命令" };

    // ⚠️ 没配 TG_CHAT_ID 时的自解释：以前这里会静默进 dry 模式、只写日志不发送，
    // 从用户视角看就是"bot 不回我"，而且**完全无从下手**。现在改成：
    // 不执行命令，但**回到发消息的那个会话**说清怎么修，并把它的 chat_id 一并告诉他。
    const allowedChat = String((cfg.telegram && cfg.telegram.chatId) || "").trim();
    const incomingChat = msg.chat && msg.chat.id != null ? String(msg.chat.id) : "";
    // ⚠️ 条件是「只要没配 TG_CHAT_ID 就绝不执行命令」，**不能要求 update 里带 chat** ——
    // 否则伪造一个不带 chat 字段的 update 就绕过了这道兜底，命令照跑、state 照写。
    if (!allowedChat) {
      if (!incomingChat) {
        log("⚠️ 未配置 TG_CHAT_ID，且 update 里没有 chat 字段 —— 拒绝执行（不写 state）");
        return { ok: true, skipped: "未配置 TG_CHAT_ID 且无 chat 字段" };
      }
      log("⚠️ 未配置 TG_CHAT_ID，已回复诊断信息（命令未执行）");
      const tip = [
        "⚠️ <b>我不知道该把消息发到哪个会话</b> —— 环境变量 <code>TG_CHAT_ID</code> 没配，或者配成了空值/占位值。",
        "",
        "你这条消息来自：<code>" + esc(incomingChat) + "</code>",
        "",
        "<b>怎么修</b>：Cloudflare 控制台 → 你这个 Worker → <code>Settings</code> → " +
          "<code>Variables and Secrets</code> → 加一个",
        "<code>TG_CHAT_ID</code> = <code>" + esc(incomingChat) + "</code>",
        "类型请选 <b>密钥（Secret）</b> —— 选普通「变量」的话，下次重新部署可能被清掉，就会再出现现在这个现象。",
        "",
        "（这条只是诊断信息，你的命令没有被执行。）",
      ].join("\n");
      try {
        await tgCall(cfg, "sendMessage", tgSendParams(incomingChat, tip), { fetchImpl });
      } catch (e) {
        log("  诊断信息也发不出去: " + (e && e.message));
      }
      return { ok: true, skipped: "未配置 TG_CHAT_ID（已回诊断信息）" };
    }

    const store = pickStorage(env);
    const state = await store.load();
    const notifier = makeNotifier({ cfg, log, fetchImpl });
    const res = await handleCommand({
      cfg, state, notifier, text,
      chatId: msg.chat && msg.chat.id,
      log, fetchImpl,
      runner: {
        runMonitor: (a) => runMonitor(a),
        runDiscovery: (a) => runDiscovery(a),
        // 让 /start 顺手把命令菜单刷成**当前部署版本**的样子。
        // 否则加了新命令（比如 /joined）后，用户按 / 还是看到旧菜单，
        // 而且他没法知道该重发一次 /set-commands —— 这种"静默过期"最难查。
        setCommands: () => setBotCommands(env, { fetchImpl }),
      },
    });
    // 只有真的改了 state 才落盘（见 handleCommand 里 mutated 的说明）——
    // 只读命令写回整份 state 会把并发期间别人的更新整份覆盖掉。
    if (res && res.mutated) await store.save(state);
    else log("命令未改动状态，跳过写盘");
    return { ok: true };
  } catch (e) {
    // 记下来但**不要**把错误抛出去：抛了就是 5xx，Telegram 会反复重推同一条命令
    log("处理 update 失败（已吞掉，避免 Telegram 重推）: " + (e && e.message));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 把 Telegram 的推送地址指到你的部署。部署后必须跑一次。 */
/**
 * Webhook 的 secret_token。
 *
 * `TG_WEBHOOK_SECRET` 没配时**回落到 `ADMIN_KEY`** —— 这样部署表单只需要问两个值
 * （`TG_TOKEN` + `ADMIN_KEY`），少一个必填项，而且**不会出现"两个都没配"的不设防状态**：
 * 只要配了 ADMIN_KEY，webhook 就有来源校验。
 */
function webhookSecret(env = {}) {
  return String(env.TG_WEBHOOK_SECRET || env.ADMIN_KEY || "");
}

/**
 * Telegram 对 `secret_token` 的字符集有硬要求：**1-256 个字符，只允许 A-Z a-z 0-9 _ -**。
 *
 * ⚠️ 我们把 `ADMIN_KEY` 回落成它，而 README 让人"随便敲一串随机字符" ——
 * 一旦含 `!` `#` `+` `/` `=`（`openssl rand -base64` 的输出必含），`setWebhook` 会被
 * Telegram 用 400 拒掉：**webhook 永远设不上、bot 收不到任何命令**，
 * 而用户只看到一句 500，完全不知道是 key 的字符问题。
 * 这里在发出去之前就拦住并说清怎么改。
 */
function webhookSecretProblem(secret) {
  const s = String(secret || "");
  if (!s) return "";
  if (s.length > 256) return `太长（Telegram 上限 256 字符，现在是 ${s.length}）`;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    const bad = [...new Set(s.replace(/[A-Za-z0-9_-]/g, ""))].join(" ");
    return `含 Telegram 不允许的字符：${bad}（只允许 A-Z a-z 0-9 _ -）`;
  }
  return "";
}

/**
 * 运维端点（`/run` `/set-webhook` `/chat-id` `/set-commands`）比对的 key。
 *
 * ⚠️ 优先级和 `webhookSecret()` **正好相反** —— 这两件事各有所属：
 *   · webhook 头 `X-Telegram-Bot-Api-Secret-Token` 该比 `TG_WEBHOOK_SECRET`
 *   · URL 里的 `?key=` 该比 `ADMIN_KEY`
 * 一开始我用同一个函数，结果 `?key=` 被拿去比 `TG_WEBHOOK_SECRET` 了 —— 被测试抓到。
 */
function adminKey(env = {}) {
  return String(env.ADMIN_KEY || env.TG_WEBHOOK_SECRET || "");
}

async function setWebhook(env = {}, url, opts = {}) {
  const cfg = loadConfig(env);
  const secret = webhookSecret(env);
  const problem = webhookSecretProblem(secret);
  if (problem) {
    throw new Error(
      `Webhook 的 secret_token 不合法：${problem}\n` +
      `  把 TG_WEBHOOK_SECRET（没配时回落用的 ADMIN_KEY）改成只用字母数字下划线连字符的随机串，` +
      `例如：openssl rand -hex 24\n` +
      `  （不改的话 Telegram 会 400 拒掉，webhook 设不上 —— bot 收不到任何命令。）`
    );
  }
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
 * 机器人的命令菜单（TG 输入框旁边那个「/」列表）。
 * BotCommand 的限制（官方文档实测）：command 只能小写字母/数字/下划线、1-32 字符；
 * description 1-256 字符。下面有测试守着，改坏了会红。
 */
const BOT_COMMANDS = [
  { command: "apps", description: "看监控中的 App 各自盯了什么" },
  { command: "find", description: "按名字查 TF 链接（只查，不改监控列表）" },
  { command: "add", description: "按名字加进监控（没链接也能加）：/add 微信读书" },
  { command: "joined", description: "标记「我已上车」→ 不再提醒它的状态来回" },
  { command: "unjoined", description: "恢复提醒（撤销 joined）" },
  { command: "del", description: "移出监控：/del <join 码>" },
  { command: "status", description: "当前监控状态" },
  { command: "check", description: "立刻跑一轮监控" },
  { command: "scan", description: "立刻跑一轮发现扫描" },
  { command: "links", description: "列出已知 join 码" },
  { command: "sources", description: "查看发现源与关键词配置" },
  { command: "test", description: "发一条测试消息" },
  { command: "help", description: "帮助" },
];

/** 把命令菜单注册到 Telegram（省得去 BotFather 里手敲一遍） */
async function setBotCommands(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  await tgCall(cfg, "setMyCommands",
    { commands: JSON.stringify(BOT_COMMANDS) }, { fetchImpl: opts.fetchImpl });
  return { ok: true, count: BOT_COMMANDS.length, commands: BOT_COMMANDS.map((c) => "/" + c.command) };
}

/**
 * 机器人自己的信息。
 * `can_read_all_group_messages` 就是「群组隐私模式是否关闭」——
 * 这个字段让工具能**自己问出**该给用户哪种群组操作指引，而不是靠我背规则。
 */
async function botInfo(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  const me = await tgCall(cfg, "getMe", {}, { fetchImpl: opts.fetchImpl });
  return {
    id: me.id,
    username: me.username,
    name: me.first_name,
    canReadAllGroupMessages: !!me.can_read_all_group_messages,
    canJoinGroups: !!me.can_join_groups,
  };
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

  // 隐私模式直接从 Telegram 问出来，而不是靠背规则：
  // can_read_all_group_messages=false 表示处于默认的「隐私模式」，
  // 群里只送得到明确发给它的命令，所以要引导用户发 /xxx@<bot用户名>。
  let canReadAllGroupMessages = null;
  try {
    const me = await tgCall(cfg, "getMe", {}, { fetchImpl: opts.fetchImpl });
    canReadAllGroupMessages = !!me.can_read_all_group_messages;
  } catch {
    /* 同上 */
  }

  const hints = [];
  if (webhookSet) {
    hints.push("你已经设过 webhook 了，getUpdates 会是空的 —— 要么先撤销 webhook（/del-webhook?key=…）再发消息，要么在别处查 chat_id。");
  } else {
    hints.push("在 TG 里给 bot 发一条消息，再刷新本页。");
  }
  if (canReadAllGroupMessages === false) {
    hints.push("想拿**群**的 chat_id：bot 目前处于默认的群组隐私模式，普通群消息不会送给它 —— " +
      "请在群里发一条明确给它的命令，形如 /status@<你的bot用户名>，再刷新本页。");
  } else if (canReadAllGroupMessages === true) {
    hints.push("想拿**群**的 chat_id：隐私模式已关闭，在群里随便发一条消息就行。");
  }

  return {
    webhookSet,
    canReadAllGroupMessages,
    chatIds: [...seen.entries()].map(([id, desc]) => ({ id, desc })),
    hint: hints.join("\n"),
  };
}

/**
 * 部署体检：一次把"能不能正常干活"要看的都打出来。
 * 用 GET /health 就能看，省得在平台日志里翻。
 */
async function health(env = {}, opts = {}) {
  const out = { ok: true, features: FEATURES, checks: {} };
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
  try {
    const me = await botInfo(env, opts);
    out.checks.bot = { username: me.username, canReadAllGroupMessages: me.canReadAllGroupMessages };
  } catch (e) {
    out.checks.bot = "查询失败: " + e.message;
  }

  // 可执行的提醒：不设这些虽然能跑，但会静默降级成"不太安全"的形态
  const notes = [];
  if (!env.CRON_SECRET) {
    notes.push("没设 CRON_SECRET：Vercel 的定时触发将没有 Authorization 头，" +
      "只能靠 x-vercel-cron-schedule 头识别（任何伪造该头的请求也能触发）。建议设一个随机 16+ 位。");
  }
  if (!webhookSecret(env)) {
    notes.push("TG_WEBHOOK_SECRET 与 ADMIN_KEY 都没设：Webhook 端点不校验来源，任何人都能伪造 Telegram 推送来触发命令。");
  } else if (!env.TG_WEBHOOK_SECRET) {
    notes.push("没单独设 TG_WEBHOOK_SECRET，已回落到用 ADMIN_KEY 做 Webhook 来源校验（够用；想分开可以再设一个）。");
  }
  if (!env.ADMIN_KEY && !env.TG_WEBHOOK_SECRET) {
    notes.push("ADMIN_KEY 与 TG_WEBHOOK_SECRET 都没设：运维端点（/run、/set-webhook、/chat-id、/set-commands）一律拒绝，无法使用。");
  }
  const secretProblem = webhookSecretProblem(webhookSecret(env));
  if (secretProblem) {
    notes.push(`Webhook 的 secret_token 不合法（${secretProblem}）：/set-webhook 会被这里拦住，` +
      `因为 Telegram 只接受 A-Z a-z 0-9 _ -。请改成 openssl rand -hex 24 这样的值。`);
  }
  // ⚠️ 要看**配置里生效的** chatId，不是环境变量：chatId 也可以从 CONFIG_JSON 里来，
  // 只读 env.TG_CHAT_ID 会对已经配好的人误报"TG_CHAT_ID 还是空的"，
  // 把人引向错误的排查方向（实测复现）。
  const configuredChat = cfg ? (cfg.telegram && cfg.telegram.chatId) : env.TG_CHAT_ID;
  if (isPlaceholder(configuredChat)) {
    notes.push("TG_CHAT_ID 还是空的或占位值 —— 先在 TG 里给 bot 发条消息，再打开 /chat-id?key=… 拿数字填进来。");
  }
  if (notes.length) out.notes = notes;
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
  const key = adminKey(env);
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
      const secret = webhookSecret(env);
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
    if (path === "/run" || path === "/set-webhook" || path === "/del-webhook" || path === "/chat-id" || path === "/set-commands") {
      if (!adminOk(env, url)) {
        return text(
          "403：需要 key。用法 /run?key=<ADMIN_KEY>&mode=monitor|discovery|all\n" +
          "（ADMIN_KEY 与 TG_WEBHOOK_SECRET 两个都没配时，一律拒绝 —— 刻意不留默认放行的后门）",
          403
        );
      }
      try {
        if (path === "/run") {
          const mode = url.searchParams.get("mode") || "all";
          // ⚠️ 和 api/run.js 一样必须校验：不校验的话 `mode=typo` 会"什么都没跑"却回
          // `OK mode=typo 事件=0`，用户以为跑过了一轮（Vercel 入口有这个校验，Workers 入口漏了）。
          if (!["all", "monitor", "discovery"].includes(mode)) {
            return text("mode 只能是 all / monitor / discovery", 400);
          }
          const r = await doRun(env, { mode, log });
          return text(`OK mode=${r.mode} 事件=${r.events} 存储=${r.storage}`);
        }
        if (path === "/set-commands") {
          const r = await setBotCommands(env);
          return text(`OK 已注册 ${r.count} 个命令：${r.commands.join(" ")}`);
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
        "  1. 在 TG 里给 bot 发一条消息（群里则发 /status@<你的bot用户名>）",
        `  2. 拿 chat_id：${url.origin}/chat-id?key=<ADMIN_KEY>`,
        "     把结果填进 TG_CHAT_ID，重新部署",
        `  3. 设推送地址：${url.origin}/set-webhook?key=<ADMIN_KEY>`,
        `  4. 注册命令菜单：${url.origin}/set-commands?key=<ADMIN_KEY>`,
        `  5. 手动跑一轮：${url.origin}/run?key=<ADMIN_KEY>&mode=all`,
        "",
        "Telegram 推送地址：" + `${url.origin}/telegram`,
      ];
      return text(lines.join("\n"));
    }

    return text("404。可用：POST /telegram、GET /health、GET /run、GET /chat-id、GET /set-webhook、GET /set-commands、GET /del-webhook", 404);
  },
};
