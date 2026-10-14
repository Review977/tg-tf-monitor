#!/usr/bin/env node
/**
 * 本地命令行工具（可选，用不着 Node 也能部署 —— 见 README）
 *
 *   node cli.mjs selftest        用 4 个已知状态的 join 码验证判定逻辑（联网）
 *   node cli.mjs check           真实网络跑一轮，只打印不发送
 *   node cli.mjs scan            真实网络跑一轮发现扫描，只打印
 *   node cli.mjs health          部署体检（需要已配好环境变量）
 *   node cli.mjs set-webhook <url>   把 Telegram 推送地址指过去
 *   node cli.mjs del-webhook     撤销推送地址
 *
 * 默认 DRY_RUN（只打印），加 --send 才真的发到 TG。
 * 默认 ALLOW_NO_STORAGE（状态不持久化），加 --persist 才用真实存储。
 */

import { doRun, health, renderHealth, setWebhook, deleteWebhook, listChatIds } from "./src/runner.js";
import { probeJoin, parseJoinPage, STATE_LABEL } from "./src/core.js";

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const send = argv.includes("--send");
const persist = argv.includes("--persist");

if (!send) process.env.DRY_RUN = "1";
if (!persist) process.env.ALLOW_NO_STORAGE = "1";

const log = (m) => console.log(m);

const SELFTEST_CASES = [
  ["dTUO1uyt", "open", "番茄小说 TF 公测（当前活跃）"],
  ["XgaxaRtd", "full", "T3 Code 公测（已满，用于校准 full）"],
  ["yb2xm7Ej", "closed", "已关闭样本（用于校准 closed）"],
  ["zzzzzzzz", "invalid", "不存在的码（应为 404）"],
];

async function selftest() {
  let ok = true;
  for (const [code, want, note] of SELFTEST_CASES) {
    const info = await probeJoin(code);
    const good = info.state === want;
    ok = ok && good;
    console.log(`${good ? "✅" : "❌"} ${code.padEnd(10)} 期望=${want.padEnd(8)} 实际=${String(info.state).padEnd(8)} http=${String(info.http).padEnd(4)} ${note}`);
    console.log(`     应用名=${JSON.stringify(info.appName)}`);
    console.log(`     文案  =${JSON.stringify((info.desc || "").slice(0, 70))}`);
    if (info.state === "unknown") console.log(`     ⚠️ 未识别，状态句原文=${JSON.stringify(info.statusText.slice(0, 200))}`);
  }
  console.log("\n判定逻辑自检：" + (ok ? "全部通过 ✅" : "有失败项 ❌"));
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (cmd === "selftest") return selftest();

  if (cmd === "check" || cmd === "scan") {
    const mode = cmd === "check" ? "monitor" : "discovery";
    console.log(`真实网络跑一轮（mode=${mode}${send ? "，会真的发 TG" : "，DRY_RUN 只打印"}）…\n`);
    const r = await doRun(process.env, { mode, log });
    console.log(`\n完成：${r.events} 条事件，存储=${r.storage}`);
    return;
  }

  if (cmd === "health") {
    const h = await health(process.env);
    console.log(JSON.stringify(h, null, 2));
    console.log("\n（发到 TG 的版本）\n" + renderHealth(h));
    return;
  }

  if (cmd === "chat-id") {
    const r = await listChatIds(process.env);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "set-webhook") {
    const url = argv[1];
    if (!url || !url.startsWith("http")) {
      console.error("用法：node cli.mjs set-webhook https://<你的部署>/telegram");
      process.exit(2);
    }
    console.log(JSON.stringify(await setWebhook(process.env, url), null, 2));
    return;
  }

  if (cmd === "del-webhook") {
    console.log(JSON.stringify(await deleteWebhook(process.env), null, 2));
    return;
  }

  console.log(`tg-tf-monitor-cloud CLI

  node cli.mjs selftest             用 4 个已知状态的 join 码验证判定逻辑（联网）
  node cli.mjs check [--send]       跑一轮监控（默认只打印）
  node cli.mjs scan  [--send]       跑一轮发现扫描（默认只打印）
  node cli.mjs health               部署体检
  node cli.mjs chat-id              拿 chat_id（设了 webhook 之后会返回空）
  node cli.mjs set-webhook <url>    设置 Telegram 推送地址
  node cli.mjs del-webhook          撤销推送地址

  --send     真的发到 TG（默认 DRY_RUN）
  --persist  用真实存储（默认不持久化，仅试跑）

注意：本 CLI 只是给你本机调试用；**部署到 Cloudflare / Vercel 不需要它，也不需要装 Node**。`);
}

main().catch((e) => {
  console.error("✗ " + (e && e.message));
  process.exit(1);
});
