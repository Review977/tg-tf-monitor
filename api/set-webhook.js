/**
 * Vercel 入口：把 Telegram 推送地址指到本项目
 *   GET /api/set-webhook?key=<ADMIN_KEY>[&url=https://…/api/telegram]
 * 不传 url 就自动用当前请求的域名。
 */

import { setWebhook, deleteWebhook, webhookInfo, adminKey } from "../src/runner.js";

function authorized(req) {
  const key = adminKey(process.env);
  if (!key) return false;
  const q = (req.query && req.query.key) || "";
  if (q.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= q.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (!authorized(req)) {
    res.status(403).json({ error: "需要 ?key=<ADMIN_KEY>" });
    return;
  }
  const action = (req.query && req.query.action) || "set";
  try {
    if (action === "info") {
      res.status(200).json(await webhookInfo(process.env));
      return;
    }
    if (action === "delete") {
      res.status(200).json(await deleteWebhook(process.env));
      return;
    }
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const url = (req.query && req.query.url) || `${proto}://${host}/api/telegram`;
    const r = await setWebhook(process.env, url);
    res.status(200).json({ ...r, note: "Telegram 现在会把命令推到这里" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
