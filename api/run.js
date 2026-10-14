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

import { doRun } from "../src/runner.js";

function authorized(req) {
  const key = String(process.env.ADMIN_KEY || process.env.TG_WEBHOOK_SECRET || "");
  const cronSecret = String(process.env.CRON_SECRET || "");
  const auth = String(req.headers.authorization || "");
  const q = (req.query && req.query.key) || "";

  // Vercel Cron 会带 Bearer CRON_SECRET
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  // 没配 CRON_SECRET 时，Vercel Cron 请求不带 Authorization —— 那就只认 key
  if (!key) return false; // 没配 key：拒绝，不默认放行
  if (q.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= q.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (!authorized(req)) {
    res.status(403).json({
      error: "需要授权",
      hint: "带 ?key=<ADMIN_KEY>，或由 Vercel Cron 携带 Authorization: Bearer $CRON_SECRET 触发",
    });
    return;
  }
  const mode = (req.query && req.query.mode) || "all";
  if (!["all", "monitor", "discovery"].includes(mode)) {
    res.status(400).json({ error: "mode 只能是 all / monitor / discovery" });
    return;
  }
  try {
    const r = await doRun(process.env, { mode, log: (m) => console.log("[run] " + m) });
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.log("[run] 失败: " + (e && e.message));
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
