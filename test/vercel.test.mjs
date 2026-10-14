/**
 * Vercel 入口测试（api/*.js）+ Upstash 存储适配器测试。
 *
 * Vercel 函数的签名是 (req, res)，所以这里用最小的 req/res 桩，
 * 并逐条设置/还原 process.env —— 和线上行为一致，不需要真的部署。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "./fixtures-dir.mjs";

const load = (n) => readFileSync(join(FIXTURES_DIR, n), "utf8");

const runHandler = (await import("../api/run.js")).default;
const telegramHandler = (await import("../api/telegram.js")).default;
const healthHandler = (await import("../api/health.js")).default;
const setWebhookHandler = (await import("../api/set-webhook.js")).default;
const { redisStorage } = await import("../src/storage.js");

function mockRes() {
  const r = {
    statusCode: 0, body: null, sent: null,
    status(c) { r.statusCode = c; return r; },
    json(o) { r.body = o; return r; },
    send(s) { r.sent = s; return r; },
  };
  return r;
}

/**
 * 临时设置环境变量并运行 fn。
 *
 * ⚠️ 必须 await fn() 再还原 —— 早先写成同步 `return fn()`，
 * 结果 async 回调一遇到 await 就先把环境变量还原了，
 * 后面的断言其实跑在**没设过环境变量**的状态下。这种夹具 bug 会掩盖真实失败，别省这个 await。
 */
async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
}

const BASE_ENV = {
  TG_TOKEN: "123456:FAKE",
  TG_CHAT_ID: "-1001234567890",
  ADMIN_KEY: "s3cret-key",
  TG_WEBHOOK_SECRET: "wh-secret",
  ALLOW_NO_STORAGE: "1",
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  CRON_SECRET: undefined,
};

function makeFetchStub() {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body || null, headers: opts.headers || {} });
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "https://p.vercel.app/api/telegram", pending_update_count: 0 } }), { status: 200 });
      if (method === "setWebhook" || method === "deleteWebhook") return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes("testflight.apple.com/join/")) return new Response(load("open_zh.html"), { status: 200 });
    if (u.includes("departures.to/apps/")) {
      const snap = JSON.stringify({ data: { app_id: 16645, status: "open", url: "https://testflight.apple.com/join/dTUO1uyt" } }).replace(/"/g, "&quot;");
      return new Response(`<title>番茄小说 TestFlight Beta — Departures</title><div wire:snapshot="${snap}"></div>`, { status: 200 });
    }
    if (u.includes("itunes.apple.com")) {
      return new Response(JSON.stringify({ resultCount: 1, results: [{ version: "7.3.9", trackName: "番茄小说", currentVersionReleaseDate: "2026-09-30T00:00:00Z" }] }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  return { f, calls };
}

async function withFetch(f, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// ───────────────────────── /api/run ─────────────────────────

test("api/run：无 key → 403", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await runHandler({ method: "GET", headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.hint, /key/);
  });
});

test("api/run：错 key → 403", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await runHandler({ method: "GET", headers: {}, query: { key: "nope" } }, res);
    assert.equal(res.statusCode, 403);
  });
});

test("api/run：对 key → 真的跑一轮并返回统计", async () => {
  await withEnv(BASE_ENV, async () => {
    const { f, calls } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await runHandler({ method: "GET", headers: {}, query: { key: "s3cret-key", mode: "monitor" } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.mode, "monitor");
      assert.ok(calls.some((c) => c.url.includes("testflight.apple.com/join/dTUO1uyt")));
    });
  });
});

test("api/run：Vercel Cron 的 Bearer CRON_SECRET 也放行", async () => {
  await withEnv({ ...BASE_ENV, CRON_SECRET: "cron-secret-xyz" }, async () => {
    const { f } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await runHandler(
        { method: "GET", headers: { authorization: "Bearer cron-secret-xyz" }, query: { mode: "monitor" } },
        res
      );
      assert.equal(res.statusCode, 200, "Vercel Cron 应能免 key 触发");
    });
  });
});

test("api/run：mode 非法 → 400", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await runHandler({ method: "GET", headers: {}, query: { key: "s3cret-key", mode: "bogus" } }, res);
    assert.equal(res.statusCode, 400);
  });
});

test("api/run：配置缺 token 时明确报错（不静默）", async () => {
  await withEnv({ ...BASE_ENV, TG_TOKEN: undefined }, async () => {
    const res = mockRes();
    await runHandler({ method: "GET", headers: {}, query: { key: "s3cret-key", mode: "monitor" } }, res);
    assert.equal(res.statusCode, 500);
    assert.match(String(res.body.error), /TG_TOKEN|telegram\.token/);
  });
});

test("api/run：没配 CRON_SECRET 时，Vercel Cron 的 x-vercel-cron-schedule 头放行（避免静默 403）", async () => {
  await withEnv({ ...BASE_ENV, CRON_SECRET: undefined }, async () => {
    const { f } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await runHandler(
        { method: "GET", headers: { "x-vercel-cron-schedule": "0 3 * * *" }, query: { mode: "monitor" } },
        res
      );
      assert.equal(res.statusCode, 200, "不设 CRON_SECRET 时 Vercel Cron 不该被 403 挡住");
      assert.equal(res.body.via, "vercel-cron-unsecured");
    });
  });
});

test("api/run：配了 CRON_SECRET 后，光有 x-vercel-cron-schedule 头不再放行（收紧）", async () => {
  await withEnv({ ...BASE_ENV, CRON_SECRET: "cron-secret-xyz" }, async () => {
    const res = mockRes();
    await runHandler(
      { method: "GET", headers: { "x-vercel-cron-schedule": "0 3 * * *" }, query: { mode: "monitor" } },
      res
    );
    assert.equal(res.statusCode, 403, "配了 CRON_SECRET 就必须用它，不能被伪造头绕过");
    assert.match(res.body.hint, /CRON_SECRET/);
  });
});

test("api/run：普通请求（无 key、无 cron 头）仍被拒", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await runHandler({ method: "GET", headers: {}, query: { mode: "monitor" } }, res);
    assert.equal(res.statusCode, 403);
  });
});

// ───────────────────────── /api/telegram ─────────────────────────

test("api/telegram：GET → 405", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await telegramHandler({ method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});

test("api/telegram：secret 不对 → 403", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await telegramHandler(
      { method: "POST", headers: { "x-telegram-bot-api-secret-token": "nope" }, body: { message: { text: "/help" } } },
      res
    );
    assert.equal(res.statusCode, 403);
  });
});

test("api/telegram：secret 对 → 200 且真的回消息", async () => {
  await withEnv(BASE_ENV, async () => {
    const { f, calls } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await telegramHandler(
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "wh-secret" },
          body: { message: { text: "/status", chat: { id: -1001234567890 } } },
        },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.sent, "ok");
      // handler 先回 200 再干活，等一下让 sendMessage 落地
      await new Promise((r) => setTimeout(r, 20));
      const sent = calls.filter((c) => c.url.includes("/sendMessage"));
      assert.equal(sent.length, 1);
    });
  });
});

test("api/telegram：body 不是对象 → 400（secret 校验在前，所以这里要带对 secret）", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await telegramHandler(
      { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wh-secret" }, body: null },
      res
    );
    assert.equal(res.statusCode, 400);
  });
});

// ───────────────────────── /api/health ─────────────────────────

test("api/health：返回结构化体检", async () => {
  await withEnv(BASE_ENV, async () => {
    const { f } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await healthHandler({ method: "GET", headers: {} }, res);
      assert.ok([200, 503].includes(res.statusCode));
      assert.ok("checks" in res.body);
      assert.deepEqual(res.body.checks.watch, ["dTUO1uyt"]);
    });
  });
});

// ───────────────────────── /api/set-webhook ─────────────────────────

test("api/set-webhook：用请求域名拼出推送地址", async () => {
  await withEnv(BASE_ENV, async () => {
    const { f, calls } = makeFetchStub();
    await withFetch(f, async () => {
      const res = mockRes();
      await setWebhookHandler(
        { method: "GET", headers: { "x-forwarded-host": "my-bot.vercel.app", "x-forwarded-proto": "https" }, query: { key: "s3cret-key" } },
        res
      );
      assert.equal(res.statusCode, 200);
      const setCall = calls.find((c) => c.url.includes("/setWebhook"));
      const p = new URLSearchParams(setCall.body);
      assert.equal(p.get("url"), "https://my-bot.vercel.app/api/telegram");
      assert.equal(p.get("secret_token"), "wh-secret");
    });
  });
});

test("api/set-webhook：无 key → 403", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = mockRes();
    await setWebhookHandler({ method: "GET", headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 403);
  });
});

// ───────────────────────── /api/chat-id ─────────────────────────

test("api/chat-id：列出会话 id", async () => {
  await withEnv(BASE_ENV, async () => {
    const f = async (url) => {
      const u = String(url);
      if (u.includes("/getUpdates")) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{ update_id: 1, message: { chat: { id: -1001234567890, type: "supergroup", title: "我的群" } } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
    };
    await withFetch(f, async () => {
      const chatIdHandler = (await import("../api/chat-id.js")).default;
      const res = mockRes();
      await chatIdHandler({ method: "GET", headers: {}, query: { key: "s3cret-key" } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.chatIds[0].id, "-1001234567890");
      assert.equal(res.body.webhookSet, false);
    });
  });
});

test("api/chat-id：无 key → 403", async () => {
  await withEnv(BASE_ENV, async () => {
    const chatIdHandler = (await import("../api/chat-id.js")).default;
    const res = mockRes();
    await chatIdHandler({ method: "GET", headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 403);
  });
});

// ───────────────────────── Upstash 存储适配器 ─────────────────────────

test("Upstash 存储：save 写 / load 读，走 REST 且带 Bearer", async () => {
  const calls = [];
  let stored = null;
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    if (String(url).includes("/set/")) {
      stored = opts.body;
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: stored }), { status: 200 });
  };
  const store = redisStorage({ url: "https://x.upstash.io", token: "tok", fetchImpl: f });
  const state = { links: { abc: { state: "open" } }, discoveries: {}, appstore: {}, meta: { lastCheck: "t" } };
  await store.save(state);
  assert.equal(store.kind, "upstash-redis");
  const back = await store.load();
  assert.equal(back.links.abc.state, "open");
  assert.equal(back.meta.lastCheck, "t");
  assert.ok(calls[0].url.includes("/set/state"));
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.ok(calls[1].url.includes("/get/state"));
});

test("Upstash 存储：存的东西坏了 → 当空状态重建，不整个崩掉", async () => {
  const f = async () => new Response(JSON.stringify({ result: "{这不是JSON" }), { status: 200 });
  const store = redisStorage({ url: "https://x.upstash.io", token: "tok", fetchImpl: f });
  const st = await store.load();
  assert.deepEqual(st.links, {});
});

test("Upstash 存储：缺配置时明确报错", () => {
  assert.throws(() => redisStorage({ url: "", token: "" }), /Upstash/);
});
