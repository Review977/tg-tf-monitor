/**
 * Cloudflare Workers 入口
 *
 * 部署后有两条路：
 *   · Cron Trigger（scheduled）—— 定时监控 / 发现，不需要任何人访问
 *   · fetch —— Telegram Webhook（收命令）+ 几个运维端点
 *
 * 端点了哪些：
 *   POST /            Telegram Webhook（也可用 /telegram 或 /webhook）
 *   GET  /health      部署体检（配置 / 存储 / Webhook 状态）
 *   GET  /run         手动跑一轮，需 key：?key=…&mode=monitor|discovery|all
 *   GET  /set-webhook 把 Telegram 推送地址指到本 Worker，需 key
 *   GET  /del-webhook 撤销推送地址，需 key
 *
 * 运维端点一律需要 ADMIN_KEY（没配就一律拒绝 —— 失败关闭，不留后门）。
 */

import { loadConfig } from "./config.js";
import { doRun, handleUpdate, setWebhook, deleteWebhook, health, listChatIds, setBotCommands } from "./runner.js";

const log = (m) => console.log("[worker] " + m);

function adminOk(env, url) {
  const key = String(env.ADMIN_KEY || env.TG_WEBHOOK_SECRET || "");
  if (!key) return false; // 没配 key：拒绝，不默认放行
  const given = url.searchParams.get("key") || "";
  // 定长比较，避免时序侧信道（这里风险很低，但顺手做对）
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  /** 定时任务。靠 event.cron 区分"只监控"还是"监控+发现"。 */
  async scheduled(event, env, ctx) {
    let mode = "monitor";
    try {
      const cfg = loadConfig(env);
      const discCron = (cfg.cron && cfg.cron.discovery) || "0 */6 * * *";
      if (event.cron === discCron) mode = "all";
    } catch {
      /* 配置坏了也要跑，让 doRun 去报错 */
    }
    log(`cron=${event.cron} → mode=${mode}`);
    ctx.waitUntil(
      doRun(env, { mode, log }).catch((e) => log("定时任务失败: " + (e && e.message)))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();

    // ── Telegram Webhook ──
    if (request.method === "POST" && (path === "/" || path === "/telegram" || path === "/webhook")) {
      const secret = String(env.TG_WEBHOOK_SECRET || "");
      if (secret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== secret) {
          log("拒绝：secret_token 不匹配");
          return text("forbidden", 403);
        }
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return text("bad json", 400);
      }
      // 命令可能要跑几秒（/scan 约 2-3 秒），用 waitUntil 先回 200 再干活，
      // 免得 Telegram 等超时重推。
      ctx.waitUntil(handleUpdate(env, update, { log }).then(() => {}));
      return text("ok");
    }

    // ── 体检 ──
    if (path === "/health") {
      try {
        const h = await health(env);
        return new Response(JSON.stringify(h, null, 2), {
          status: h.ok ? 200 : 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (e) {
        return text("health 失败: " + e.message, 500);
      }
    }

    // ── 运维端点（都要 key）──
    if (path === "/run" || path === "/set-webhook" || path === "/del-webhook" || path === "/chat-id" || path === "/set-commands") {
      if (!adminOk(env, url)) {
        return text(
          "403：需要 key。用法 /run?key=<ADMIN_KEY>&mode=monitor|discovery|all\n" +
          "（ADMIN_KEY 没配时会用 TG_WEBHOOK_SECRET；两个都没配则一律拒绝）",
          403
        );
      }
      try {
        if (path === "/run") {
          const mode = url.searchParams.get("mode") || "all";
          const r = await doRun(env, { mode, log });
          return text(`OK mode=${r.mode} 事件=${r.events} 存储=${r.storage}`);
        }
        if (path === "/set-commands") {
          const r = await setBotCommands(env);
          return text(`OK 已注册 ${r.count} 个命令：${r.commands.join(" ")}`);
        }
        if (path === "/chat-id") {
          const r = await listChatIds(env);
          const lines = ["用这个端点拿 chat_id（填到 TG_CHAT_ID）", "", r.hint, ""];
          if (!r.chatIds.length) lines.push("（暂时没查到任何会话）");
          for (const c of r.chatIds) lines.push(`chat_id: ${c.id}    ${c.desc}`);
          if (r.webhookSet) lines.push("", "当前已设 webhook = true");
          return text(lines.join("\n"));
        }
        if (path === "/set-webhook") {
          const target = url.searchParams.get("url") || `${url.origin}/telegram`;
          const r = await setWebhook(env, target);
          return text(`OK webhook=${r.url} secretSet=${r.secretSet}`);
        }
        const r = await deleteWebhook(env);
        return text("OK 已撤销 webhook: " + r.ok);
      } catch (e) {
        return text("失败: " + e.message, 500);
      }
    }

    // ── 根路径 GET：给人看的自检页 ──
    if (request.method === "GET" && path === "/") {
      let h;
      try {
        h = await health(env);
      } catch (e) {
        return text("体检失败: " + e.message, 500);
      }
      const lines = [
        "tg-tf-monitor-cloud 已部署（Cloudflare Workers）",
        "",
        `总体：${h.ok ? "✅ 正常" : "⚠️ 有问题"}`,
        `配置：${JSON.stringify(h.checks.config)}`,
        `存储：${JSON.stringify(h.checks.storage)}`,
        `Webhook：${JSON.stringify(h.checks.webhook)}`,
        `监控列表：${JSON.stringify(h.checks.watch)}`,
        "",
        "部署顺序（别搞反，设了 webhook 之后 getUpdates 就空了）：",
        "  1. 在 TG 里给 bot 发一条消息（群里则发 /status@<你的bot用户名>）",
        `  2. 拿 chat_id：${url.origin}/chat-id?key=<ADMIN_KEY>`,
        "     把结果填进 TG_CHAT_ID，重新部署",
        `  3. 设推送地址：${url.origin}/set-webhook?key=<ADMIN_KEY>`,
        `  4. 注册命令菜单：${url.origin}/set-commands?key=<ADMIN_KEY>`,
        `  5. 手动跑一轮：${url.origin}/run?key=<ADMIN_KEY>&mode=all`,
        "",
        "Telegram 推送地址：" + `${url.origin}/telegram`,
      ];
      return text(lines.join("\n"));
    }

    return text("404。可用：POST /telegram、GET /health、GET /run、GET /chat-id、GET /set-webhook、GET /set-commands、GET /del-webhook", 404);
  },
};
