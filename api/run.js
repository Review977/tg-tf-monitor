/**
 * Vercel 入口：手动 / 定时跑一轮
 *
 *   GET /api/run?key=<ADMIN_KEY>&mode=all|monitor|discovery
 *
 * 三种触发方式：
 *   1. Vercel Cron（vercel.json 里配了 crons；Vercel 会自动带
 *      `Authorization: Bearer $CRON_SECRET`，前提是你设了 CRON_SECRET）
 *   2. 外部免费定时器（cron-job.org 等）—— Vercel Hobby 的 cron 一天只能跑一次，
 *      想每 30 分钟跑就得用外部定时器打这个地址
 *   3. 你手动在浏览器打开
 */

import { doRun, adminKey } from "../src/runner.js";

/**
 * 鉴权。三条路，任一成立即放行：
 *   1. `Authorization: Bearer <CRON_SECRET>` —— Vercel Cron 在设了 CRON_SECRET 时会自动带
 *   2. `?key=<ADMIN_KEY>`（或 TG_WEBHOOK_SECRET）—— 手动 / 外部定时器用
 *   3. 带 `x-vercel-cron-schedule` 头且**没配 CRON_SECRET**
 *      —— 这个头是 Vercel Cron 每次调用都会带的（官方文档明说）。
 *      之所以放行：不设 CRON_SECRET 时 Vercel 不带任何 Authorization，
 *      如果这里一律拒绝，**每日定时就会静默 403、什么都不做** —— 那比"能被伪造触发"更糟。
 *      代价是别人伪造这个头也能触发一轮检查；因为去重机制在，
 *      最多是多跑一次、不会重复推送。想要严就设 CRON_SECRET。
 */
function authorized(req) {
  const key = adminKey(process.env);
  const cronSecret = String(process.env.CRON_SECRET || "");
  const auth = String(req.headers.authorization || "");
  const q = (req.query && req.query.key) || "";

  if (cronSecret && auth === `Bearer ${cronSecret}`) return { ok: true, via: "cron-secret" };

  if (key) {
    if (q.length === key.length) {
      let diff = 0;
      for (let i = 0; i < key.length; i++) diff |= q.charCodeAt(i) ^ key.charCodeAt(i);
      if (diff === 0) return { ok: true, via: "admin-key" };
    }
  }

  const isVercelCron = !!(req.headers["x-vercel-cron-schedule"] || req.headers["x-vercel-cron"]);
  if (isVercelCron && !cronSecret) return { ok: true, via: "vercel-cron-unsecured" };

  return {
    ok: false,
    why: cronSecret
      ? "带了 CRON_SECRET 就必须用它（Authorization: Bearer …），或改用 ?key=<ADMIN_KEY>"
      : "需要 ?key=<ADMIN_KEY>；如果你是 Vercel Cron 触发的，说明它没带 x-vercel-cron-schedule 头",
  };
}

export default async function handler(req, res) {
  const auth = authorized(req);
  if (!auth.ok) {
    res.status(403).json({ error: "需要授权", hint: auth.why });
    return;
  }
  const mode = (req.query && req.query.mode) || "all";
  if (!["all", "monitor", "discovery"].includes(mode)) {
    res.status(400).json({ error: "mode 只能是 all / monitor / discovery" });
    return;
  }
  if (auth.via === "vercel-cron-unsecured") {
    console.log("[run] ⚠️ 这次是 Vercel Cron 触发的，但没配 CRON_SECRET —— 建议设一个（随机 16+ 位），否则任何带 x-vercel-cron-schedule 头的请求都能触发。");
  }
  try {
    const r = await doRun(process.env, { mode, log: (m) => console.log("[run] " + m) });
    res.status(200).json({ ok: true, via: auth.via, ...r });
  } catch (e) {
    console.log("[run] 失败: " + (e && e.message));
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
