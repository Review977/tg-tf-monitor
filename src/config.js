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

export const DEFAULT_CONFIG = {
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

export function loadConfig(env = {}) {
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
export function checkConfig(cfg, { requireTelegram = true } = {}) {
  const problems = [];
  if (requireTelegram) {
    if (!cfg.telegram || !cfg.telegram.token) problems.push("缺 telegram.token（设 TG_TOKEN）");
    if (!cfg.telegram || !cfg.telegram.chatId) problems.push("缺 telegram.chatId（设 TG_CHAT_ID）");
  }
  if (!Array.isArray(cfg.watch) || !cfg.watch.length) problems.push("watch 为空，没有东西可监控");
  return problems;
}
