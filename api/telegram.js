/**
 * Vercel 入口：Telegram Webhook
 *
 * Telegram 推送地址填： https://<你的项目>.vercel.app/api/telegram
 * 部署后用 /api/set-webhook?key=… 也可以自动设。
 */

import { handleUpdate, webhookSecret } from "../src/runner.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("只接受 POST（Telegram Webhook）");
    return;
  }

  const secret = webhookSecret(process.env);
  if (secret) {
    const got = req.headers["x-telegram-bot-api-secret-token"] || "";
    if (got !== secret) {
      console.log("[webhook] 拒绝：secret_token 不匹配");
      res.status(403).send("forbidden");
      return;
    }
  }

  const update = req.body && typeof req.body === "object" ? req.body : null;
  if (!update) {
    res.status(400).send("bad json");
    return;
  }

  // 先回 200，再干活：Telegram 等超时会重推，/scan 要跑 2-3 秒。
  // Vercel 的 Node 函数在响应后仍会把当前微任务跑完（只要不 await 新的定时器）。
  res.status(200).send("ok");
  try {
    await handleUpdate(process.env, update, {});
  } catch (e) {
    console.log("[webhook] 处理失败（已吞掉，避免重推）: " + (e && e.message));
  }
}
