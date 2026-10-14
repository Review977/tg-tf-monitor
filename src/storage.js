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

import { normalizeState } from "./core.js";

const KEY = "state";

/** Cloudflare Workers KV */
export function kvStorage(kv) {
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
export function redisStorage({ url, token, fetchImpl }) {
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
