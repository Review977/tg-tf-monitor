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

import {
  makeNotifier, runMonitor, runDiscovery, handleCommand, tgCall, tgPrepare,
} from "./core.js";
import { loadConfig, checkConfig } from "./config.js";
import { pickStorage } from "./storage.js";

/**
 * 把"填了但其实是占位"的值当成未配置。
 *
 * 为什么需要：Cloudflare 的部署表单会把 `.dev.vars.example` 里每个未注释项都当**必填**，
 * 于是有人会随手填个 `0` / `TODO` 把表单过了 —— 那样 bot 会把消息发到 chat 0，
 * 报一个很难懂的错。这里直接识别成"未配置"，并给出可执行的提示。
 */
export function isPlaceholder(v) {
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
export async function doRun(env = {}, opts = {}) {
  const mode = opts.mode || "all";
  const log = opts.log || mkLog("run");
  const fetchImpl = opts.fetchImpl;
  const cfg = loadConfig(env);
  if (cfg.telegram && isPlaceholder(cfg.telegram.chatId)) cfg.telegram.chatId = "";

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
export async function handleUpdate(env = {}, update, opts = {}) {
  const log = opts.log || mkLog("webhook");
  const fetchImpl = opts.fetchImpl;
  try {
    const cfg = loadConfig(env);
    if (cfg.telegram && isPlaceholder(cfg.telegram.chatId)) cfg.telegram.chatId = "";
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
/**
 * Webhook 的 secret_token。
 *
 * `TG_WEBHOOK_SECRET` 没配时**回落到 `ADMIN_KEY`** —— 这样部署表单只需要问两个值
 * （`TG_TOKEN` + `ADMIN_KEY`），少一个必填项，而且**不会出现"两个都没配"的不设防状态**：
 * 只要配了 ADMIN_KEY，webhook 就有来源校验。
 */
export function webhookSecret(env = {}) {
  return String(env.TG_WEBHOOK_SECRET || env.ADMIN_KEY || "");
}

/**
 * 运维端点（`/run` `/set-webhook` `/chat-id` `/set-commands`）比对的 key。
 *
 * ⚠️ 优先级和 `webhookSecret()` **正好相反** —— 这两件事各有所属：
 *   · webhook 头 `X-Telegram-Bot-Api-Secret-Token` 该比 `TG_WEBHOOK_SECRET`
 *   · URL 里的 `?key=` 该比 `ADMIN_KEY`
 * 一开始我用同一个函数，结果 `?key=` 被拿去比 `TG_WEBHOOK_SECRET` 了 —— 被测试抓到。
 */
export function adminKey(env = {}) {
  return String(env.ADMIN_KEY || env.TG_WEBHOOK_SECRET || "");
}

export async function setWebhook(env = {}, url, opts = {}) {
  const cfg = loadConfig(env);
  const secret = webhookSecret(env);
  const params = {
    url,
    allowed_updates: JSON.stringify(["message", "channel_post"]),
    drop_pending_updates: "true",
  };
  if (secret) params.secret_token = secret;
  const r = await tgCall(cfg, "setWebhook", params, { fetchImpl: opts.fetchImpl });
  return { ok: r === true, url, secretSet: !!secret };
}

export async function deleteWebhook(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  await tgCall(cfg, "deleteWebhook", { drop_pending_updates: "true" }, { fetchImpl: opts.fetchImpl });
  return { ok: true };
}

export async function webhookInfo(env = {}, opts = {}) {
  const cfg = loadConfig(env);
  return tgCall(cfg, "getWebhookInfo", {}, { fetchImpl: opts.fetchImpl });
}

/**
 * 机器人的命令菜单（TG 输入框旁边那个「/」列表）。
 * BotCommand 的限制（官方文档实测）：command 只能小写字母/数字/下划线、1-32 字符；
 * description 1-256 字符。下面有测试守着，改坏了会红。
 */
export const BOT_COMMANDS = [
  { command: "apps", description: "看监控中的 App 各自盯了什么" },
  { command: "find", description: "按名字搜 App（App Store id / departures / tfstore 上的 TF 码）" },
  { command: "add", description: "加一个 App 进监控：/add <TestFlight 链接> [名称]" },
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
export async function setBotCommands(env = {}, opts = {}) {
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
export async function botInfo(env = {}, opts = {}) {
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
export async function listChatIds(env = {}, opts = {}) {
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
export async function health(env = {}, opts = {}) {
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
  if (isPlaceholder(env.TG_CHAT_ID)) {
    notes.push("TG_CHAT_ID 还是空的或占位值 —— 先在 TG 里给 bot 发条消息，再打开 /chat-id?key=… 拿数字填进来。");
  }
  if (notes.length) out.notes = notes;
  return out;
}

/** 自检消息文本（可直接发到 TG） */
export function renderHealth(h) {
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
