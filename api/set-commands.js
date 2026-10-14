/**
 * Vercel 入口：把命令菜单注册到 Telegram
 *   GET /api/set-commands?key=<ADMIN_KEY>
 *
 * 注册后 TG 输入框旁边那个「/」列表就有全部命令了，不用去 BotFather 手敲。
 */

import { setBotCommands, adminKey } from "../src/runner.js";

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
  try {
    res.status(200).json(await setBotCommands(process.env));
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
