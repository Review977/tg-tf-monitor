/**
 * Vercel 入口：部署体检
 *   GET /api/health
 * 浏览器直接打开就能看配置 / 存储 / Webhook 有没有配好。
 */

import { health } from "../src/runner.js";

export default async function handler(req, res) {
  try {
    const h = await health(process.env);
    res.status(h.ok ? 200 : 503).json(h);
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
