/**
 * 状态存储适配器
 *
 * serverless 没有本地文件系统，状态必须放外部。两个平台各一个实现，
 * 接口统一为 `{ load(), save(state, { base }) }`：
 *   · Cloudflare：Workers KV（绑定名 STATE）—— 平台自带，不需要额外注册服务
 *   · Vercel：Upstash Redis REST（Vercel 函数无状态，必须外接）
 *   · 内存：只给单测/一次性试跑用，**不会持久化**
 *
 * 状态体积很小（几个链接 + 历史发现，约 2-5KB），KV 免费额度绰绰有余。
 *
 * ⚠️ `base`（调用方 load 出来的那份快照）是**必须**的：不传就是"整份覆盖"，
 * 而 serverless 里两个入口随时并发 —— 定时任务跑一轮要好几秒网络，
 * 期间老板发一条 `/joined`，那一笔写入就会被定时任务的旧快照整份抹掉
 * （实测复现：`/joined` 后 joined=true，cron 落盘后变回 undefined ——
 * 他被告知"之后不再提醒"，却继续收到提醒）。传了 base 就走三方合并：
 * 只把**本轮真的改过**的字段盖上去，别的写入保留。
 */

import { normalizeState } from "./core.js";

const KEY = "state";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 深比较（数组按整体比，不做元素级合并） */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * 三方合并：`cur` = 存储里现在的（别人可能刚改过），`next` = 本轮算出来的，`base` = 本轮开始时读到的。
 *
 * 规则（按字段，数组整体当原子）：
 *   · 本轮改过（`next[k]` 与 `base[k]` 不同）→ 用 `next[k]`（含本轮新增/删除）
 *   · 本轮没改 → 保留 `cur[k]`（也就是别人在窗口期里的写入）
 *   · 两边都是普通对象 → 递归下去，这样"同一条记录的不同字段分别被两边改"也不会丢
 *   · 本轮删掉的键 → 合并结果里也不留（尊重删除）
 */
export function mergeStates(cur, next, base) {
  if (!isPlainObject(cur) || !isPlainObject(next)) return next;
  const b = isPlainObject(base) ? base : {};
  const out = {};
  const keys = new Set([...Object.keys(cur), ...Object.keys(next)]);
  for (const k of keys) {
    const inNext = Object.prototype.hasOwnProperty.call(next, k);
    const inBase = Object.prototype.hasOwnProperty.call(b, k);
    if (!inNext) {
      // 本轮没有这个键：base 里也没有 -> 是别人新加的，保留；base 里有 -> 是本轮删的，尊重删除
      if (!inBase) out[k] = cur[k];
      continue;
    }
    if (inBase && deepEqual(next[k], b[k])) {
      // 本轮没动这个字段 -> 别人改过的赢（别人删了就不复活）
      if (Object.prototype.hasOwnProperty.call(cur, k)) out[k] = cur[k];
      continue;
    }
    if (isPlainObject(next[k]) && isPlainObject(cur[k])) {
      out[k] = mergeStates(cur[k], next[k], b[k]);
      continue;
    }
    out[k] = next[k];
  }
  return out;
}

/** Cloudflare Workers KV */
export function kvStorage(kv) {
  if (!kv) throw new Error("缺少 KV 绑定：请在 wrangler.jsonc / 控制台绑定 KV 命名空间到 STATE");
  const load = async () => normalizeState(await kv.get(KEY, "json"));
  return {
    kind: "cloudflare-kv",
    load,
    async save(state, { base } = {}) {
      // base 缺失（旧调用方 / 测试桩）时退回整份覆盖，行为和以前一致
      const out = base === undefined ? state : mergeStates(await load(), state, base);
      await kv.put(KEY, JSON.stringify(out));
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
export function redisStorage({ url, token, fetchImpl }) {
  const f = fetchImpl || fetch;
  const root = String(url || "").replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${token}` };
  if (!root || !token) {
    throw new Error("缺少 Upstash 配置：需要 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN");
  }
  const load = async () => {
    const res = await f(`${root}/get/${KEY}`, { headers: auth });
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
  };
  return {
    kind: "upstash-redis",
    load,
    async save(state, { base } = {}) {
      const out = base === undefined ? state : mergeStates(await load(), state, base);
      const res = await f(`${root}/set/${KEY}`, {
        method: "POST",
        headers: { ...auth, "content-type": "text/plain" },
        body: JSON.stringify(out),
      });
      const json = await upstashJson(res, "写入");
      if (json.error) throw new Error("Upstash 写入失败: " + json.error);
    },
  };
}

/** 内存存储：仅测试 / 一次性试跑，**进程结束就没了** */
export function memoryStorage(initial) {
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
export function pickStorage(env = {}) {
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
