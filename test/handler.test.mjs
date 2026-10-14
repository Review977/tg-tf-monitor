/**
 * 入口层测试：用桩 fetch + 桩 KV 把整个 Worker 跑一遍。
 *
 *   node build.mjs && node --test
 *
 * 关键点：**同一套断言对 src/worker.js 和 dist/worker.js 各跑一遍**。
 * dist 是给"没装 Node、只能往 Cloudflare 控制台粘贴"的人用的单文件包 ——
 * 所以必须证明"我发出去的那个包真的跑得起来"，而不是"源文件跑得起来"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FIXTURES_DIR } from "./fixtures-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function load(name) {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

const jsonRes = (o) =>
  new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const htmlRes = (s) => new Response(s, { status: 200, headers: { "content-type": "text/html" } });

const DEP_PAGE =
  `<html><head><title>番茄小说 - 热门短剧全本小说电子书阅读器 TestFlight Beta — Departures</title></head>` +
  `<body><div wire:snapshot="${JSON.stringify({
    data: { app_id: 16645, status: "open", url: "https://testflight.apple.com/join/dTUO1uyt" },
  }).replace(/"/g, "&quot;")}"></div></body></html>`;

/** 桩 fetch：按 URL 分派，并记录所有调用 */
function makeFetchStub({ joinHtml } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body || null });
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      if (method === "getMe") return jsonRes({ ok: true, result: { username: "demo_bot", first_name: "Demo" } });
      if (method === "getWebhookInfo") {
        return jsonRes({ ok: true, result: { url: "https://example.workers.dev/telegram", pending_update_count: 0 } });
      }
      if (method === "setWebhook" || method === "deleteWebhook") return jsonRes({ ok: true, result: true });
      if (method === "sendMessage") return jsonRes({ ok: true, result: { message_id: 1 } });
      return jsonRes({ ok: true, result: {} });
    }
    if (u.includes("testflight.apple.com/join/")) return htmlRes(joinHtml || load("open_zh.html"));
    if (u.includes("departures.to/apps/")) return htmlRes(DEP_PAGE);
    if (u.includes("itunes.apple.com")) {
      return jsonRes({
        resultCount: 1,
        results: [{
          version: "7.3.9", trackName: "番茄小说 - 热门短剧全本小说电子书阅读器",
          currentVersionReleaseDate: "2026-09-30T02:17:58Z", trackId: 1468454200,
        }],
      });
    }
    return new Response("", { status: 404 });
  };
  return { f, calls };
}

/** 桩 KV：Cloudflare Workers KV 的最小可用子集 */
function makeKvStub() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) {
      map.set(key, val);
    },
  };
}

function makeEnv(over = {}) {
  const kv = over.STATE || makeKvStub();
  return {
    TG_TOKEN: "123456:FAKE",
    TG_CHAT_ID: "-1001234567890",
    ADMIN_KEY: "s3cret-key",
    TG_WEBHOOK_SECRET: "wh-secret",
    STATE: kv,
    ...over,
    ...(over.STATE ? {} : { STATE: kv }),
  };
}

function makeCtx() {
  const pending = [];
  return { ctx: { waitUntil: (p) => pending.push(p) }, settle: () => Promise.all(pending) };
}

/** 载入被测 Worker（src 与 dist 各一份） */
async function loadWorkers() {
  const out = [];
  out.push(["src/worker.js", (await import("../src/worker.js")).default]);
  const distPath = join(ROOT, "dist", "worker.js");
  if (!existsSync(distPath)) {
    throw new Error("缺 dist/worker.js —— 先跑 `node build.mjs`（package.json 的 test 脚本已自动带上）");
  }
  out.push(["dist/worker.js", (await import(distPath)).default]);
  return out;
}

const WORKERS = await loadWorkers();

for (const [label, worker] of WORKERS) {
  const realFetch = globalThis.fetch;

  test(`[${label}] scheduled：非发现 cron 只跑监控`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const { ctx, settle } = makeCtx();
      worker.scheduled({ cron: "*/30 * * * *" }, env, ctx);
      await settle();
      const urls = calls.map((c) => c.url).join("\n");
      assert.ok(urls.includes("testflight.apple.com/join/dTUO1uyt"), "应检查被监控的链接");
      assert.ok(!urls.includes("tfstore.top"), "只监控的轮次不该跑发现源");
      const saved = JSON.parse(env.STATE.map.get("state"));
      assert.equal(saved.links["dTUO1uyt"].state, "open");
      assert.ok(saved.meta.lastCheck, "应写回 lastCheck");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] scheduled：发现 cron 会跑发现源`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const { ctx, settle } = makeCtx();
      worker.scheduled({ cron: "0 */6 * * *" }, env, ctx);
      await settle();
      const urls = calls.map((c) => c.url).join("\n");
      assert.ok(urls.includes("departures.to/apps/16645"), "发现轮应查 departures.to");
      assert.ok(urls.includes("testflight.apple.com/join/dTUO1uyt"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] GET / 返回可读自检页`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const res = await worker.fetch(new Request("https://x.workers.dev/"), makeEnv(), makeCtx().ctx);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes("tg-tf-monitor-cloud"));
      assert.ok(body.includes("/set-webhook"), "应告诉用户怎么设 webhook");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] GET /health 返回结构化体检`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      // 先跑一轮，让存储里有数据
      const { ctx, settle } = makeCtx();
      worker.scheduled({ cron: "*/30 * * * *" }, env, ctx);
      await settle();

      const res = await worker.fetch(new Request("https://x.workers.dev/health"), env, makeCtx().ctx);
      assert.equal(res.status, 200);
      const h = await res.json();
      assert.equal(h.ok, true, "体检应通过：" + JSON.stringify(h.checks));
      assert.equal(h.checks.storage.kind, "cloudflare-kv");
      assert.equal(h.checks.storage.links, 1);
      assert.ok(h.checks.webhook.url);
      assert.deepEqual(h.checks.watch, ["dTUO1uyt"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /health 在没配存储时明确报错（不静默降级）`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      delete env.STATE;
      const res = await worker.fetch(new Request("https://x.workers.dev/health"), env, makeCtx().ctx);
      const h = await res.json();
      assert.equal(h.ok, false);
      assert.match(String(h.checks.storage), /没有可用的状态存储/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /run 无 key → 403；错 key → 403；对 key → 跑通`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const noKey = await worker.fetch(new Request("https://x.workers.dev/run?mode=monitor"), env, makeCtx().ctx);
      assert.equal(noKey.status, 403);
      const badKey = await worker.fetch(new Request("https://x.workers.dev/run?key=wrong&mode=monitor"), env, makeCtx().ctx);
      assert.equal(badKey.status, 403);
      const ok = await worker.fetch(new Request("https://x.workers.dev/run?key=s3cret-key&mode=monitor"), env, makeCtx().ctx);
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /OK mode=monitor/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /run 在没配任何 key 时一律拒绝（失败关闭）`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      delete env.ADMIN_KEY;
      delete env.TG_WEBHOOK_SECRET;
      const res = await worker.fetch(new Request("https://x.workers.dev/run?mode=monitor"), env, makeCtx().ctx);
      assert.equal(res.status, 403, "没配 key 时必须拒绝，不能默认放行");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] Webhook：secret 不对 → 403；对 → 200 且真的回消息`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const update = { message: { text: "/status", chat: { id: -1001234567890 } } };

      const bad = await worker.fetch(
        new Request("https://x.workers.dev/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "nope" },
          body: JSON.stringify(update),
        }),
        env, makeCtx().ctx
      );
      assert.equal(bad.status, 403);

      const { ctx, settle } = makeCtx();
      const good = await worker.fetch(
        new Request("https://x.workers.dev/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wh-secret" },
          body: JSON.stringify(update),
        }),
        env, ctx
      );
      assert.equal(good.status, 200);
      await settle();
      const sent = calls.filter((c) => c.url.includes("/sendMessage"));
      assert.equal(sent.length, 1, "应回一条 /status 消息");
      assert.ok(decodeURIComponent(sent[0].body).includes("当前状态"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] Webhook：非授权会话的命令被忽略`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const { ctx, settle } = makeCtx();
      await worker.fetch(
        new Request("https://x.workers.dev/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wh-secret" },
          body: JSON.stringify({ message: { text: "/status", chat: { id: 999 } } }),
        }),
        env, ctx
      );
      await settle();
      assert.equal(calls.filter((c) => c.url.includes("/sendMessage")).length, 0, "陌生人发的命令不该回");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] Webhook：/scan 会跑发现源`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const { ctx, settle } = makeCtx();
      await worker.fetch(
        new Request("https://x.workers.dev/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wh-secret" },
          body: JSON.stringify({ message: { text: "/scan", chat: { id: -1001234567890 } } }),
        }),
        env, ctx
      );
      await settle();
      const urls = calls.map((c) => c.url).join("\n");
      assert.ok(urls.includes("departures.to/apps/16645"));
      const msgs = calls.filter((c) => c.url.includes("/sendMessage"));
      assert.ok(msgs.length >= 2, "应至少回'开始扫描'与'完成'两条");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /set-webhook 会把地址指向自己并带上 secret_token`, async () => {
    const { f, calls } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request("https://x.workers.dev/set-webhook?key=s3cret-key"), env, makeCtx().ctx);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /secretSet=true/);
      const setCall = calls.find((c) => c.url.includes("/setWebhook"));
      assert.ok(setCall, "应调用 setWebhook");
      const p = new URLSearchParams(setCall.body);
      assert.equal(p.get("url"), "https://x.workers.dev/telegram");
      assert.equal(p.get("secret_token"), "wh-secret");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /chat-id 列出会话（未设 webhook 时）`, async () => {
    const calls = [];
    const f = async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, body: opts.body || null });
      if (u.includes("/getUpdates")) {
        return jsonRes({
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: -1001234567890, type: "supergroup", title: "我的群" } } },
            { update_id: 2, message: { chat: { id: 555, type: "private", first_name: "老板" } } },
          ],
        });
      }
      if (u.includes("/getWebhookInfo")) {
        return jsonRes({ ok: true, result: { url: "", pending_update_count: 0 } });
      }
      return jsonRes({ ok: true, result: {} });
    };
    globalThis.fetch = f;
    try {
      const res = await worker.fetch(new Request("https://x.workers.dev/chat-id?key=s3cret-key"), makeEnv(), makeCtx().ctx);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes("-1001234567890"), "应列出群 id");
      assert.ok(body.includes("555"), "应列出私聊 id");
      assert.ok(body.includes("我的群"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] /chat-id 无 key → 403`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const res = await worker.fetch(new Request("https://x.workers.dev/chat-id"), makeEnv(), makeCtx().ctx);
      assert.equal(res.status, 403);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`[${label}] 未知路径 → 404 且给出可用端点`, async () => {
    const { f } = makeFetchStub();
    globalThis.fetch = f;
    try {
      const res = await worker.fetch(new Request("https://x.workers.dev/nope"), makeEnv(), makeCtx().ctx);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /\/health/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
