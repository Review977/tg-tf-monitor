/**
 * "从 TG 加新 App" 这条链路的测试。
 *
 * 覆盖：三个自动查询源（iTunes / departures.to 搜索 / tfstore）、元数据补齐、
 * 认不准时不硬猜、以及 /add · /apps · /find 三个命令的完整行为。
 * 全部用桩 fetch，不发网络。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  enrichApp, deriveKeywords, probeItunesSearch, probeDeparturesSearch,
  watchedNames, discoveryRelevant, effectiveTfstoreQueries, renderApps, findApp,
  handleCommand, normalizeState, makeNotifier,
} from "../src/core.js";
import { FIXTURES_DIR } from "./fixtures-dir.mjs";

const load = (n) => readFileSync(join(FIXTURES_DIR, n), "utf8");

const jsonRes = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const htmlRes = (s) => new Response(s, { status: 200, headers: { "content-type": "text/html" } });

const ITUNES = {
  resultCount: 4,
  results: [
    { trackId: 1468454200, trackName: "番茄小说 - 热门短剧全本小说电子书阅读器", bundleId: "com.dragon.read", version: "7.3.9", trackViewUrl: "https://apps.apple.com/cn/app/id1468454200" },
    { trackId: 1508443800, trackName: "番茄畅听-海量小说音乐评书全场畅听", bundleId: "com.xs.fm", version: "6.7.2" },
  ],
};

/** departures.to 搜索结果页（结构照真实页面写：<a href=".../apps/N?ref=search"> + <h3>名字<span） */
function depSearchPage(rows) {
  return rows.map(([id, name]) =>
    `<a href="https://departures.to/apps/${id}?ref=search" class="m-2">` +
    `<div><div><h3 class="text-lg font-bold text-base-content"> ${name} ` +
    `<span class="text-sm">· 1yr ago</span></h3></div></div></a>`
  ).join("\n");
}

function makeFetch({ itunes = ITUNES, depRows = [["16645", "番茄小说 - 热门短剧全本小说电子书阅读器"]], tfstorePage = "", joinHtml } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("itunes.apple.com/search")) return jsonRes(itunes);
    if (u.includes("departures.to/search")) return htmlRes(depSearchPage(depRows));
    if (u.includes("departures.to/apps/")) {
      const snap = JSON.stringify({ data: { app_id: 16645, status: "open", url: "https://testflight.apple.com/join/dTUO1uyt" } }).replace(/"/g, "&quot;");
      return htmlRes(`<title>番茄小说 TestFlight Beta — Departures</title><div wire:snapshot="${snap}"></div>`);
    }
    if (u.includes("testflight.apple.com/join/")) return htmlRes(joinHtml || load("open_zh.html"));
    if (u.includes("tfstore.top")) return htmlRes(tfstorePage);
    if (u.includes("api.telegram.org")) return jsonRes({ ok: true, result: { message_id: 1 } });
    return new Response("", { status: 404 });
  };
  return { f, calls };
}

// ───────────────────── 关键词派生 ─────────────────────

test("deriveKeywords：从应用名切出可用的发现关键词", () => {
  const k = deriveKeywords("番茄小说 - 热门短剧全本小说电子书阅读器", "com.dragon.read");
  assert.ok(k.includes("番茄小说"), "应切出首段");
  assert.ok(k.includes("com.dragon.read"), "应含 bundle id");
  assert.ok(k.length <= 4);
});

test("deriveKeywords：名字为空时不炸", () => {
  assert.deepEqual(deriveKeywords("", ""), []);
  assert.deepEqual(deriveKeywords(null, null), []);
});

// ───────────────────── 三个自动查询源 ─────────────────────

test("probeItunesSearch：解析出 trackId / bundleId", async () => {
  const { f } = makeFetch();
  const { hits, error } = await probeItunesSearch("番茄小说", { fetchImpl: f });
  assert.equal(error, "");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].trackId, 1468454200);
  assert.equal(hits[0].bundleId, "com.dragon.read");
});

test("probeDeparturesSearch：解析出 appId 与名字", async () => {
  const { f } = makeFetch();
  const { hits, error } = await probeDeparturesSearch("番茄小说", { fetchImpl: f });
  assert.equal(error, "");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].appId, "16645");
  assert.match(hits[0].name, /番茄小说/);
});

test("probeDeparturesSearch：URL 用的是 searchTerm（不是 q）—— 参数名写错会静默返回默认列表", async () => {
  const { f, calls } = makeFetch();
  await probeDeparturesSearch("微信", { fetchImpl: f });
  assert.ok(calls[0].includes("searchTerm="), "必须用 searchTerm，实测 ?q= 会被忽略");
});

// ───────────────────── 元数据补齐 ─────────────────────

test("enrichApp：三个来源全命中，一次补齐", async () => {
  const { f } = makeFetch();
  const e = await enrichApp({ code: "dTUO1uyt", fetchImpl: f });
  assert.equal(e.appName, "番茄小说 - 热门短剧全本小说电子书阅读器");
  assert.equal(e.state, "open");
  assert.equal(e.appStoreId, 1468454200, "应自动拿到 App Store id");
  assert.equal(e.bundleId, "com.dragon.read");
  assert.equal(e.departuresId, 16645, "应自动拿到 departures.to app id（轮换检测要用）");
  assert.ok(e.keywords.includes("番茄小说"));
  assert.deepEqual(e.notes, [], "全都精确命中时不该有提醒");
});

test("enrichApp：iTunes 结果都不像 → 不填 App Store id，且明确说明", async () => {
  const { f } = makeFetch({ itunes: { resultCount: 1, results: [{ trackId: 999, trackName: "完全无关的记账软件", bundleId: "com.x.y" }] } });
  const e = await enrichApp({ code: "dTUO1uyt", fetchImpl: f });
  assert.equal(e.appStoreId, null, "认不准就不许硬猜 —— 猜错会让正式版告警张冠李戴");
  assert.ok(e.notes.some((n) => n.includes("都不像")), "要说清为什么没填：" + JSON.stringify(e.notes));
});

test("enrichApp：departures.to 没收录 → 不填，但说明不影响状态监控", async () => {
  const { f } = makeFetch({ depRows: [] });
  const e = await enrichApp({ code: "dTUO1uyt", fetchImpl: f });
  assert.equal(e.departuresId, null);
  assert.ok(e.notes.some((n) => n.includes("没收录")), JSON.stringify(e.notes));
});

test("enrichApp：iTunes 抛错时不整体失败，只记一条提醒", async () => {
  const f = async (url) => {
    if (String(url).includes("itunes.apple.com/search")) throw new Error("boom");
    if (String(url).includes("departures.to/search")) return htmlRes(depSearchPage([["16645", "番茄小说"]]));
    if (String(url).includes("testflight.apple.com")) return htmlRes(load("open_zh.html"));
    return new Response("", { status: 404 });
  };
  const e = await enrichApp({ code: "dTUO1uyt", fetchImpl: f });
  assert.equal(e.state, "open", "链接状态仍要拿到");
  assert.ok(e.notes.some((n) => n.includes("iTunes 查询失败")),
    "网络/接口失败必须与「确实没搜到」区分开，否则用户会以为这 App 不在 App Store：" + JSON.stringify(e.notes));
  assert.ok(!e.notes.some((n) => n.includes("确实没搜到")), "失败时不该说成没搜到");
});

// ───────────────────── 关键词/查询词合并 ─────────────────────

test("watchedNames + discoveryRelevant：监控里的 App 自己要能被发现源捞到", () => {
  const state = normalizeState({ links: { abc: { label: "微信读书", appName: "微信读书", keywords: ["微信读书", "com.tencent.weread"] } } });
  const names = watchedNames(state);
  assert.ok(names.includes("微信读书"));
  assert.ok(names.includes("com.tencent.weread"));
  assert.ok(discoveryRelevant({ keywords: ["番茄小说"], watched: names }, { appName: "微信读书" }),
    "监控里的 App 本身必须能过（否则新加 App 等于白加）");
});

test("effectiveTfstoreQueries：带上各 App 的名字，且有上限", () => {
  const cfg = { discovery: { tfstoreQueries: ["番茄小说"] } };
  const links = {};
  for (let i = 0; i < 20; i++) links["c" + i] = { appName: `App${i} - 副标题` };
  const q = effectiveTfstoreQueries(cfg, normalizeState({ links }), 8);
  assert.ok(q.includes("番茄小说"));
  assert.ok(q.includes("App0"));
  assert.equal(q.length, 8, "必须有上限，否则请求数会随 App 数量膨胀");
});

// ───────────────────── /add 命令 ─────────────────────

function collector() {
  const sent = [];
  return { sent, notifier: { dry: false, send: async (t) => { sent.push(t); return true; } } };
}

test("/add：加一个 App 并自动补齐元数据，落进 state", async () => {
  const { f } = makeFetch();
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add https://testflight.apple.com/join/dTUO1uyt", fetchImpl: f });
  const rec = state.links["dTUO1uyt"];
  assert.ok(rec, "应写进 state.links");
  assert.equal(rec.appStoreId, 1468454200);
  assert.equal(rec.bundleId, "com.dragon.read");
  assert.equal(rec.departuresId, 16645);
  assert.ok(rec.keywords.includes("番茄小说"));
  assert.equal(rec.state, "open");
  const all = sent.join("\n");
  assert.match(all, /已加入监控/);
  assert.match(all, /1468454200/);
  assert.match(all, /16645/);
});

test("/add：可以手动覆盖 appstore= / departures=", async () => {
  const { f } = makeFetch({ itunes: { resultCount: 0, results: [] }, depRows: [] });
  const state = normalizeState(null);
  const { notifier } = collector();
  await handleCommand({
    cfg: { telegram: {} }, state, notifier, fetchImpl: f,
    text: "/add dTUO1uyt 我的番茄 appstore=999 departures=888",
  });
  const rec = state.links["dTUO1uyt"];
  assert.equal(rec.appStoreId, 999);
  assert.equal(rec.departuresId, 888);
  assert.equal(rec.appStoreSource, "manual");
  assert.equal(rec.label, "我的番茄");
});

test("⭐ /add <名字>：按名字直接加进监控（自己找链接、自己挑能进的那个）", async () => {
  // 语义分工：/find 是「查」，/add <名字> 是「查完就加」。
  // 这条测试钉住的就是这个分工 —— 以前 /add 只收链接，用户得先 /find 再复制码，两步。
  const { f } = makeFetch({
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/dTUO1uyt","name":"番茄小说"},
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/zzzzzzzz","name":"番茄小说"}]}]}</script>`,
  });
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({
    cfg: { telegram: {} }, state, notifier,
    text: "/add 番茄小说", fetchImpl: f,
  });
  const all = sent.join("\n");
  assert.equal(Object.keys(state.links).length, 1, "应该真的加进去了，而且只加一个");
  assert.ok(state.links.dTUO1uyt || state.links.zzzzzzzz, "加的是搜到的码之一");
  assert.match(all, /已加入监控/);
  assert.match(all, /还有 1 个别的链接/, "要告诉用户还有别的码可选");
});

test("⭐ /add 微信：iTunes 挂掉（429）时也必须建对 App 级监控 —— 决策不能依赖 iTunes", async () => {
  // 这条是老板实测打回来的那个 bug 的**根因测试**：
  // 我第一版把"用户指的是哪个 App"挂在 iTunes 的精确同名上，
  // 而 Cloudflare 共享出口 IP 常被 iTunes 429 -> 一失败就退回"名字里含关键词"
  // -> 又变成列「微信读书/微信输入法」并拒绝。**决策必须建立在最稳的来源上。**
  const itunes429 = new Response("rate limited", { status: 429 });
  const calls = [];
  const f = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("itunes.apple.com")) return itunes429;          // 模拟限流
    if (u.includes("departures.to/search")) return htmlRes(depSearchPage([]));
    if (u.includes("tfstore.top")) {
      return htmlRes(`<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
        {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/5MWjLpYl","name":"微信读书"},
        {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/iSTXkF4K","name":"微信输入法"}]}]}</script>`);
    }
    return htmlRes(load("open_zh.html"));
  };
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 微信", fetchImpl: f });
  const all = sent.join("\n").replace(/<[^>]+>/g, "");

  const keys = Object.keys(state.links);
  assert.equal(keys.length, 1, "只该建一条，实际：" + JSON.stringify(keys));
  assert.equal(state.links[keys[0]].kind, "app", "要建 App 级监控");
  assert.equal(state.links[keys[0]].label, "微信");
  assert.ok(!state.links["5MWjLpYl"] && !state.links["iSTXkF4K"], "绝不能被名字里含「微信」的其它 App 带偏");
  assert.ok(!/匹配到 2 个 App/.test(all), "不该再判成有歧义（老板明确不要这个行为）");
  assert.match(all, /已加入监控（App 级）：微信/);
  assert.match(all, /都不是「微信」本身/, "那些近似候选要作为附注给出");
});

test("/add <名字>：没有精确同名时建 App 级监控，并把近似候选作为附注（不再要求用户二选一）", async () => {
  const { f } = makeFetch({
    itunes: { resultCount: 0, results: [] },
    depRows: [],
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/aaaaaaaa","name":"微信读书"},
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/bbbbbbbb","name":"微信输入法"}]}]}</script>`,
  });
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 微信", fetchImpl: f });
  const all = sent.join("\n").replace(/<[^>]+>/g, "");
  assert.equal(Object.keys(state.links).length, 1);
  assert.equal(Object.values(state.links)[0].kind, "app");
  assert.match(all, /顺便说/);
  assert.match(all, /\/add aaaaaaaa/, "近似候选要给出可直接点的命令");
  assert.match(all, /\/add bbbbbbbb/);
});


test("⭐ /add <名字>：现在没有可用链接也照样加进监控（App 级监控），等出现链接再提醒", async () => {
  // 这是老板明确要求的语义：add 是「把这个 App 加进监控」，
  // 跟"现在有没有可用链接"无关 —— 没有也要加，以后出现了再提醒。
  const { f } = makeFetch({ tfstorePage: "", depRows: [], itunes: { resultCount: 0, results: [] } });
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 某还没上TF的App", fetchImpl: f });
  const all = sent.join("\n");
  assert.equal(Object.keys(state.links).length, 1, "没链接也要加进去");
  const key = Object.keys(state.links)[0];
  assert.equal(state.links[key].kind, "app", "要建成 App 级监控条目");
  assert.equal(state.links[key].state, "waiting");
  assert.match(all, /已加入监控（App 级）/);
  assert.match(all, /一旦出现能加入的链接，我会主动告诉你/);
});

test("⭐ /add 微信：App Store 里精确同名时以它为准，不能被「微信读书/微信输入法」带偏", async () => {
  // 老板实测截图里的场景：/add 微信 列出「微信输入法」「微信读书」却唯独不提微信本身，
  // 还被判成"有歧义"拒绝 —— 因为「微信」没有 TF 链接，精确同名匹配在**TF 来源**里失败了。
  // 但 App Store 里明明有名字正好是「微信」的 App。
  const itunes = { resultCount: 2, results: [
    { trackId: 414478124, trackName: "微信", bundleId: "com.tencent.xin", version: "8.0", trackViewUrl: "" },
    { trackId: 952059546, trackName: "微信读书", bundleId: "com.tencent.weread", version: "9.1", trackViewUrl: "" },
  ] };
  const { f } = makeFetch({
    itunes, depRows: [],
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/5MWjLpYl","name":"微信读书"},
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/iSTXkF4K","name":"微信输入法"}]}]}</script>`,
  });
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 微信", fetchImpl: f });
  const all = sent.join("\n").replace(/<[^>]+>/g, "");   // 去标签再断言（消息里有 <b>）

  assert.ok(state.links["app:414478124"], "要按「微信」本体建 App 级监控，实际 key：" + Object.keys(state.links));
  assert.ok(!state.links["5MWjLpYl"] && !state.links["iSTXkF4K"], "绝不能被名字里含「微信」的其它 App 带偏");
  assert.ok(!/匹配到 2 个 App/.test(all), "精确同名时不该判成有歧义");
  assert.match(all, /已加入监控（App 级）：微信/);
  assert.match(all, /都不是「微信」本身/, "要顺带说清那些只是名字里含「微信」的别的 App");
});

test("/add 微信读书：精确同名且有链接时，照旧挂链接（别被新逻辑误伤）", async () => {
  const itunes = { resultCount: 1, results: [
    { trackId: 952059546, trackName: "微信读书", bundleId: "com.tencent.weread", version: "9.1", trackViewUrl: "" },
  ] };
  const { f } = makeFetch({
    itunes, depRows: [],
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/5MWjLpYl","name":"微信读书"}]}]}</script>`,
  });
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 微信读书", fetchImpl: f });
  assert.ok(state.links["5MWjLpYl"], "要真的把链接挂上，实际：" + Object.keys(state.links));
  assert.match(sent.join("\n").replace(/<[^>]+>/g, ""), /已加入监控：微信读书/);
});

test("⭐ /joined 的效果：状态照常更新，但**不发提醒**（带对照组）", async () => {
  const { runMonitor } = await import("../src/core.js");
  const mk = (joined) => normalizeState({
    links: { dTUO1uyt: { label: "番茄小说", state: "full", joined, appStoreId: 1468454200,
                         firstSeen: "2026-10-14T08:00:00Z", sources: ["manual"] } },
    appstore: { "1468454200": { version: "7.3.9", checkedAt: "2026-10-14T08:00:00Z" } },
  });
  const run = async (joined) => {
    const state = mk(joined);
    const { sent, notifier } = collector();
    const { f } = makeFetch({ joinHtml: load("open_zh.html"), itunes: { resultCount: 0, results: [] }, depRows: [] });
    await runMonitor({ cfg: { watch: [], keywords: [] }, state, notifier, fetchImpl: f });
    return { state, sent };
  };
  const muted = await run(true);
  assert.equal(muted.state.links.dTUO1uyt.state, "open", "已加入的：状态照样要更新");
  assert.equal(muted.sent.filter((t) => /状态变化/.test(t)).length, 0, "已加入的不该收到状态变化提醒");

  const normal = await run(false);
  assert.equal(normal.sent.filter((t) => /状态变化/.test(t)).length, 1, "对照组（没标记）应该收到");
});

test("/joined：按名字标记；匹配到多条时不猜，列出来让用户说具体点", async () => {
  const state = normalizeState({
    links: { aaaaaaaa: { label: "微信读书", state: "open" }, bbbbbbbb: { label: "微信读书" , state: "full" } },
  });
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/joined 微信读书" });
  assert.match(sent.join("\n"), /匹配到 2 条/);
  assert.ok(!state.links.aaaaaaaa.joined && !state.links.bbbbbbbb.joined, "有歧义时不该擅自标记");

  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/joined aaaaaaaa" });
  assert.equal(state.links.aaaaaaaa.joined, true, "用码指定要能标上");
  assert.ok(!state.links.bbbbbbbb.joined);
});

test("/unjoined：恢复提醒", async () => {
  const state = normalizeState({ links: { aaaaaaaa: { label: "某App", state: "open", joined: true } } });
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/unjoined 某App" });
  assert.ok(!state.links.aaaaaaaa.joined, "要能恢复");
  assert.match(sent.join("\n"), /已恢复提醒/);
});

test("⭐ 已标记「已加入」的 App 出现**新链接**时，仍然要告诉你（joined 只压状态来回）", async () => {
  // 老板问的就是这个：「那如果番茄小说后面又有新链接呢？」
  // 答案必须是"会告诉你" —— 否则 joined 会让人漏掉真信息。
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState({
    links: { dTUO1uyt: { label: "番茄小说", state: "full", joined: true, keywords: ["番茄小说"] } },
  });
  const { sent, notifier } = collector();
  const { f } = makeFetch({ joinHtml: load("open_zh.html") });
  await registerDiscovery(
    { cfg: { autoWatchDiscovered: false, keywords: [] }, state, notifier, fetchImpl: f },
    { code: "NEWCODE9", source: "tfstore.top", appName: "番茄小说", context: "" }
  );
  const all = sent.join("\n");
  assert.match(all, /发现新的 TF 链接/, "新链接必须提醒，不能被 joined 吃掉");
  assert.match(all, /NEWCODE9/);
});

test("已标记「已加入」的 App：新链接提醒，但**不自动**加进监控（并说明原因）", async () => {
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState({
    links: { "app:1468454200": { kind: "app", label: "番茄小说", joined: true, keywords: ["番茄小说"], codes: [] } },
  });
  const { sent, notifier } = collector();
  const { f } = makeFetch({ joinHtml: load("open_zh.html") });
  await registerDiscovery(
    { cfg: { autoWatchDiscovered: false, keywords: [] }, state, notifier, fetchImpl: f },
    { code: "NEWCODE9", source: "tfstore.top", appName: "番茄小说", context: "" }
  );
  assert.ok(!state.links.NEWCODE9, "已加入的 App 不该再自动多盯一条");
  assert.match(sent.join("\n"), /你标记过「已加入」，所以没自动加进监控/);
  assert.match(sent.join("\n"), /新链接仍然告诉你/);
});

test("同 App 的其它链接已标记「已加入」时，新自动加入的链接也一并静音（不再推状态来回）", async () => {
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState({
    links: { OLDCODE1: { label: "番茄小说", state: "full", joined: true, keywords: ["番茄小说"] } },
  });
  const { sent, notifier } = collector();
  const { f } = makeFetch({ joinHtml: load("open_zh.html") });
  await registerDiscovery(
    { cfg: { autoWatchDiscovered: true, keywords: [] }, state, notifier, fetchImpl: f },
    { code: "NEWCODE9", source: "tfstore.top", appName: "番茄小说", context: "" }
  );
  assert.equal(state.links.NEWCODE9.joined, true, "新链接要继承静音，否则又会开始推状态来回");
  assert.match(sent.join("\n"), /这条也一并静音了/);
  assert.match(sent.join("\n"), /发现新的 TF 链接/, "但「有新链接」这条提醒本身不能省");
});

test("/health 要暴露 features —— 用来判断\"到底部署上没有\"（别再靠猜）", async () => {
  const { health } = await import("../src/runner.js");
  const h = await health({ TG_TOKEN: "t", TG_CHAT_ID: "1", ADMIN_KEY: "k" });
  assert.ok(Array.isArray(h.features) && h.features.length, "要有 features 列表");
  assert.ok(h.features.includes("name-decision-offline"),
    "这次修的\"/add 不依赖 iTunes\"必须能在 /health 里查到，实际：" + JSON.stringify(h.features));
  assert.ok(h.features.includes("app-level-watch"));
});

test("findWatchEntries：先当码认、再当 App 级 key 认、最后按名字（精确优先）", async () => {
  const { findWatchEntries } = await import("../src/core.js");
  const state = normalizeState({ links: {
    dTUO1uyt: { label: "番茄小说" },
    "app:999": { kind: "app", label: "某愿望" },
    abcd1234: { label: "微信读书" },
  } });
  assert.deepEqual(findWatchEntries(state, "dTUO1uyt").map(([k]) => k), ["dTUO1uyt"]);
  assert.deepEqual(findWatchEntries(state, "https://testflight.apple.com/join/dTUO1uyt").map(([k]) => k), ["dTUO1uyt"]);
  assert.deepEqual(findWatchEntries(state, "app:999").map(([k]) => k), ["app:999"]);
  assert.deepEqual(findWatchEntries(state, "微信").map(([k]) => k), ["abcd1234"], "名字包含也能找到");
  assert.deepEqual(findWatchEntries(state, "不存在"), []);
  assert.deepEqual(findWatchEntries(state, ""), []);
});

test("wishMatches：App 级监控只认自己的名字，且不重复认同一个码", async () => {
  const { wishMatches } = await import("../src/core.js");
  const wish = { kind: "app", label: "番茄小说", keywords: ["番茄小说", "com.dragon.read"], codes: [] };
  assert.equal(wishMatches(wish, "番茄小说", "abc12345"), true);
  assert.equal(wishMatches(wish, "番茄小说 - 热门短剧", "abc12345"), true, "名字带后缀也算命中");
  assert.equal(wishMatches(wish, "微信读书", "abc12345"), false, "别的 App 不能命中");
  assert.equal(wishMatches({ ...wish, codes: ["abc12345"] }, "番茄小说", "abc12345"), false, "已经找到过的码不重复认");
  assert.equal(wishMatches({ kind: "link", label: "番茄小说" }, "番茄小说", "x"), false, "普通链接条目不参与");
  assert.equal(wishMatches(wish, "", "x"), false, "没有名字不硬认");
});


test("/add：不带参数时给用法，且说清两种主要用法", async () => {
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add" });
  const all = sent.join("\n");
  assert.match(all, /用法/);
  assert.match(all, /按名字加/, "要说清 /add <名字> 这条路");
  assert.match(all, /\/find/, "也要说清 /find 是查");
});




// ───────────────────── /apps 与 /find ─────────────────────

test("/apps：列出每个 App 都盯了什么（新版式：一行说清绑定）", async () => {
  const { renderApps } = await import("../src/core.js");
  const out = renderApps(normalizeState({
    links: { dTUO1uyt: { label: "番茄小说 TF 公测", state: "open", appStoreId: 1468454200,
                       departuresId: 16645, firstSeen: "2026-10-14T08:17:00Z", sources: ["manual"] } },
    appstore: { "1468454200": { version: "7.3.9", releaseDate: "2026-09-30" } },
  }));
  assert.match(out, /番茄小说 TF 公测.*可加入/);
  assert.match(out, /testflight\.apple\.com\/join\/dTUO1uyt/);
  assert.match(out, /正式版 7\.3\.9/);
  assert.match(out, /App Store 1468454200/);
  assert.match(out, /departures 16645/);
  assert.match(out, /加入监控 2026-10-14 16:17/, "加入监控的时间要显示（且是本地时区）");
  // 明确不该出现的（这些是上一版的噪音）
  assert.ok(!/join 码/.test(out), "join 码和链接重复，应删掉");
  assert.ok(!/页面上的名字/.test(out), "页面上的名字是噪音");
  assert.ok(!/公测页测试说明/.test(out), "测试说明每次都一样，是噪音");
  assert.ok(!/\/add &lt;TestFlight/.test(out), "命令菜单已注册进 TG，页脚提示是冗余");
  assert.ok(!/来源/.test(out), "自己加的 App 写「来源 manual」是废话");
});

test("/apps：没绑 id 时要明确警告（否则你不知道收不到告警）", async () => {
  const { renderApps } = await import("../src/core.js");
  const out = renderApps(normalizeState({
    links: { abcdef: { label: "某App", state: "open", firstSeen: "2026-10-14T08:17:00Z", sources: ["tfstore"] } },
  }));
  // 缺绑定压成一行：说清"没绑什么" + "少了哪个能力"
  assert.match(out, /没绑 App Store \/ departures id/);
  assert.match(out, /少了：版本更新告警、链接轮换检测/);
  assert.match(out, /来源 tfstore/, "非 manual 的来源要显示（这条码是从哪发现的）");
});


test("/apps：空列表时给出下一步", () => {
  assert.match(renderApps(normalizeState(null)), /\/find/);
});

test("/apps 命令走通", async () => {
  const state = normalizeState({ links: { abcdef: { label: "某App", state: "full" } } });
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/apps" });
  assert.match(sent.join("\n"), /监控中的 App/);
});

test("/find：三路结果都列出来，并给可直接复制的 /add", async () => {
  const { f } = makeFetch({
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/CNeMrOox","name":"番茄助眠"}]}]}</script>`,
  });
  const state = normalizeState(null);
  const out = await findApp({ state, query: "番茄", fetchImpl: f });
  assert.match(out, /App Store/);
  assert.match(out, /1468454200/);
  // 现在把 tfstore 与 departures 的码**按码合并**成一段，并补上状态（哪个能进）
  assert.match(out, /找到的 TestFlight 链接/);
  assert.match(out, /CNeMrOox/);
  assert.match(out, /\/add CNeMrOox/, "要给出可直接复制的命令");
  assert.match(out, /16645/, "departures id 要带出来");
  assert.match(out, /可加入|已满员|已关闭|链接失效/, "要显示状态，否则用户得一个个试");
  assert.match(out, /\/add dep=&lt;id&gt;|\/add dep=<id>/, "要告诉用户只有 departures id 时怎么加");
});

test("parseDeparturesArg：三种写法都认，别误吃普通码", async () => {
  const { parseDeparturesArg } = await import("../src/core.js");
  assert.equal(parseDeparturesArg("dep=21038"), "21038");
  assert.equal(parseDeparturesArg("departures=21038"), "21038");
  assert.equal(parseDeparturesArg("https://departures.to/apps/21038"), "21038");
  assert.equal(parseDeparturesArg("DEP=21038"), "21038");
  // 不该误认的
  for (const bad of ["dTUO1uyt", "https://testflight.apple.com/join/dTUO1uyt", "21038", "", null]) {
    assert.equal(parseDeparturesArg(bad), "", `${JSON.stringify(bad)} 不该被当成 departures 参数`);
  }
});

test("mergeFindResults：同一份链接两边都有时只留一条（但把 departures id 带上）", async () => {
  const { mergeFindResults } = await import("../src/core.js");
  const m = mergeFindResults(
    [{ code: "7Jg9MM8h", appName: "微信读书" }, { code: "only-tf", appName: "只在 tfstore" }],
    [{ code: "7Jg9MM8h", appName: "微信读书 TestFlight Beta — Departures", appId: 21038 },
     { code: "only-dep", appName: "只在 departures", appId: 999 }]
  );
  assert.equal(m.length, 3, "重复的码要合并");
  const dupe = m.find((x) => x.code === "7Jg9MM8h");
  assert.equal(dupe.departuresId, "21038", "合并时要保住 departures id");
  assert.equal(dupe.appName, "微信读书", "已有名字就用已有的（tfstore 的更干净）");
  assert.ok(m.find((x) => x.code === "only-dep").departuresId === "999");
});

test("cleanAppName：要剥掉 departures 的标题壳（番茄小说 TestFlight Beta — Departures）", async () => {
  const { cleanAppName } = await import("../src/core.js");
  assert.equal(cleanAppName("番茄小说 TestFlight Beta — Departures"), "番茄小说");
  assert.equal(cleanAppName("微信读书 - Departures"), "微信读书");
  assert.equal(cleanAppName("微信输入法 TestFlight"), "微信输入法");
  assert.equal(cleanAppName("番茄小说"), "番茄小说", "正常名字不能被动");
});

test("/find：已在监控的会标出来", async () => {
  const { f } = makeFetch({
    tfstorePage: `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/CNeMrOox","name":"番茄助眠"}]}]}</script>`,
  });
  const state = normalizeState({ links: { CNeMrOox: { label: "番茄助眠" } } });
  const out = await findApp({ state, query: "番茄", fetchImpl: f });
  assert.match(out, /已在监控/);
});

test("/find：空查询给用法", async () => {
  const out = await findApp({ state: normalizeState(null), query: "  " });
  assert.match(out, /用法/);
});

test("/find 命令走通（先回「正在搜」再给结果）", async () => {
  const { f } = makeFetch();
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/find 番茄小说", fetchImpl: f });
  assert.equal(sent.length, 2);
  assert.match(sent[0], /正在搜/);
  assert.match(sent[1], /搜索结果/);
});

// ───────────────────── 端到端：加完之后发现源认它 ─────────────────────

test("端到端：加一个 App 后，它的名字进入发现过滤（新 App 才会被 /scan 捞到）", async () => {
  const { f } = makeFetch();
  const state = normalizeState(null);
  const { notifier } = collector();
  const cfg = { telegram: {}, keywords: ["番茄小说"], discovery: { tfstoreQueries: [] } };
  await handleCommand({ cfg, state, notifier, text: "/add dTUO1uyt", fetchImpl: f });
  const names = watchedNames(state);
  assert.ok(names.some((k) => k.includes("番茄")), "新加 App 的名字要进过滤集");
  assert.ok(discoveryRelevant({ keywords: cfg.keywords, watched: names },
    { appName: "番茄小说 - 热门短剧全本小说电子书阅读器" }), "新加的 App 本身要能被捞到");
  assert.ok(effectiveTfstoreQueries(cfg, state).length > 0, "tfstore 查询词也要带上它");
});

// ───────────────────── 版本信息（TF 构建号拿不到，把能拿到的讲清楚）─────────────────────

test("daysAgo：纯函数，边界与坏输入都要稳", async () => {
  const { daysAgo } = await import("../src/core.js");
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(daysAgo("2026-10-14T02:00:00Z", now), 0);
  assert.equal(daysAgo("2026-10-07T12:00:00Z", now), 7);
  assert.equal(daysAgo("2026-09-30T02:17:58Z", now), 14);
  assert.equal(daysAgo("2026-12-01T00:00:00Z", now), 0, "未来日期不该算出负数");
  assert.equal(daysAgo("", now), null);
  assert.equal(daysAgo("不是日期", now), null);
  assert.equal(daysAgo(null, now), null);
});

test("/apps：显示 App Store 正式版号 + 上架日期 + 距今 + 公测页测试说明", async () => {
  const { renderApps } = await import("../src/core.js");
  const state = normalizeState({
    links: {
      dTUO1uyt: {
        label: "番茄小说", state: "open", appStoreId: 1468454200,
        desc: "恭喜你获得了内测名额~", keywords: ["番茄小说"],
      },
    },
    appstore: {
      "1468454200": { version: "7.3.9", releaseDate: "2026-09-30", name: "番茄小说" },
    },
  });
  const out = renderApps(state);
  assert.match(out, /正式版 7\.3\.9/, "要显示正式版号");
  assert.match(out, /09-30 上架/, "要显示上架日期（月-日 就够）");
  assert.match(out, /\d+ 天前/, "要显示距今多久");
  assert.match(out, /正式版 7\.3\.9/, "要显示正式版号");
});

test("/apps：上游给完整 ISO 时间戳时，日期也要显示干净（不带 T…Z）", async () => {
  const { renderApps } = await import("../src/core.js");
  const state = normalizeState({
    links: { abcdef: { label: "某App", state: "open", appStoreId: 1 } },
    appstore: { "1": { version: "1.0", releaseDate: "2026-09-30T02:17:58Z" } },
  });
  const out = renderApps(state);
  assert.match(out, /09-30 上架/, "应截断到天");
  assert.ok(!/T02:17:58Z/.test(out), "不该把完整 ISO 时间戳甩给用户：" + out);
});

test("/help：TF 构建号拿不到这件事写在帮助里（而不是每次 /status 刷屏）", async () => {
  const { HELP } = await import("../src/core.js");
  assert.match(HELP, /TF 版本号/, "帮助里要有这一节");
  assert.match(HELP, /Apple 不公开/, "要说明原因");
  assert.match(HELP, /TestFlight App 里看/, "要指明去哪看");
  const { renderStatus, normalizeState } = await import("../src/core.js");
  const out = renderStatus({}, normalizeState({ links: { abcdef: { label: "A", state: "open" } } }));
  assert.ok(!/TF 构建号/.test(out), "/status 不该每次都刷这段说明");
});


test("/status：不再显示静态的「测试说明」（每次都一样，是噪音）", async () => {
  const { renderStatus, normalizeState } = await import("../src/core.js");
  const out = renderStatus({}, normalizeState({
    links: { abcdef: { label: "某App", state: "open", desc: "恭喜你获得了内测名额~" } },
  }));
  assert.ok(!/测试说明/.test(out), "静态说明不该出现在状态页：\n" + out);
});


// ───────────────────── 时间显示（不能用 UTC）─────────────────────

test("nowStr：默认按配置的时区显示，不带 UTC 字样", async () => {
  const { nowStr, setDisplayTimeZone, tzLabel } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:24:00Z");

  setDisplayTimeZone("Asia/Shanghai", 480);
  assert.equal(nowStr(d), "2026-10-14 16:24", "UTC+8 应显示 16:24");
  assert.ok(!/UTC/.test(nowStr(d)), "消息里不该出现 UTC");
  assert.match(tzLabel(), /Asia\/Shanghai/);
  assert.match(tzLabel(), /UTC\+8/);
});

test("nowStr：时区名不可用时自动退回固定偏移（而不是显示错时间）", async () => {
  const { nowStr, setDisplayTimeZone } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:24:00Z");

  setDisplayTimeZone("Bogus/Nowhere", 480);
  assert.equal(nowStr(d), "2026-10-14 16:24", "坏时区名必须退回偏移，仍要显示对");

  setDisplayTimeZone("", 0);
  assert.equal(nowStr(d), "2026-10-14 08:24", "偏移 0 时应等于 UTC 时间（但不出 UTC 字样）");

  setDisplayTimeZone("Asia/Shanghai", -300);  // 名字可用时以名字为准
  assert.equal(nowStr(d), "2026-10-14 16:24");

  setDisplayTimeZone("", 330);
  assert.equal(nowStr(d), "2026-10-14 13:54", "半点偏移也要正确（印度 +5:30）");
  setDisplayTimeZone("Asia/Shanghai", 480);   // 还原，免得影响其它用例
});

test("tzLabel：带秒/毫秒的时刻也算得准（曾把 +8:00 算成 +7:59）", async () => {
  const { tzLabel, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  for (const iso of ["2026-10-14T08:24:00Z", "2026-10-14T08:24:37Z", "2026-10-14T08:24:59.999Z"]) {
    assert.equal(tzLabel(new Date(iso)), "Asia/Shanghai（UTC+8）", iso + " 算出了 " + tzLabel(new Date(iso)));
  }
  // 用"现在"（一定带秒）也不能飘
  assert.match(tzLabel(), /UTC\+8）$/, "用当前时刻算标签也不能飘：" + tzLabel());
});

test("tzLabel：时区名生效时，标签必须报**真实**偏移（不能拿配置里的 offset 糊弄）", async () => {
  const { tzLabel, nowStr, setDisplayTimeZone } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:24:00Z");   // 纽约此时是夏令时 UTC-4

  setDisplayTimeZone("America/New_York", 480);  // 故意给一个不匹配的 offset
  assert.equal(nowStr(d), "2026-10-14 04:24", "时间要按纽约算");
  assert.match(tzLabel(d), /America\/New_York（UTC-4）/, "标签要报真实的 -4，不能报配置里的 +8");
  assert.ok(!/UTC\+8/.test(tzLabel(d)), "标签与实际时间自相矛盾是最糟的");

  setDisplayTimeZone("Asia/Kolkata", 0);
  assert.match(tzLabel(d), /UTC\+5:30/, "半小时偏移也要对");

  setDisplayTimeZone("Asia/Shanghai", 480);     // 还原
});

test("tzLabel：时区名不可用时，只报偏移，**不能把坏名字显示出来**", async () => {
  const { tzLabel, nowStr, setDisplayTimeZone } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:24:00Z");
  setDisplayTimeZone("Bogus/Zone", 330);
  assert.equal(nowStr(d), "2026-10-14 13:54");
  assert.equal(tzLabel(d), "UTC+5:30", "坏时区名不该出现在给用户看的标签里");
  setDisplayTimeZone("Asia/Shanghai", 480);
});

test("tzLabel：能正确表达正负与半小时偏移", async () => {
  const { tzLabel, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("", 480);   assert.equal(tzLabel(), "UTC+8");
  setDisplayTimeZone("", -300);  assert.equal(tzLabel(), "UTC-5");
  setDisplayTimeZone("", 330);   assert.equal(tzLabel(), "UTC+5:30");
  setDisplayTimeZone("", 0);     assert.equal(tzLabel(), "UTC+0");
  setDisplayTimeZone("UTC", 0);  assert.equal(tzLabel(), "UTC+0", "UTC 当成没有名字，走偏移分支");
  setDisplayTimeZone("Asia/Shanghai", 480);
});

test("/status 抬头标注了时区（不然用户不知道看到的是哪个时区）", async () => {
  const { renderStatus, normalizeState, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  const out = renderStatus({}, normalizeState({ links: { abcdef: { label: "A", state: "open" } } }));
  assert.match(out, /当前状态/);
  assert.match(out, /Asia\/Shanghai/, "抬头要带时区（折进标题行，不单独占一行）");
  assert.ok(!/时间均为/.test(out), "时区不该再单独占一行");
});

test("nowStamp：存储用 ISO UTC（不带毫秒）", async () => {
  const { nowStamp } = await import("../src/core.js");
  assert.equal(nowStamp(new Date("2026-10-14T08:18:00Z")), "2026-10-14T08:18:00Z");
  assert.equal(nowStamp(new Date("2026-10-14T08:18:00.123Z")), "2026-10-14T08:18:00Z");
});

test("fmtStamp：三种历史形态都要处理对（ISO / 旧版 UTC 串 / 旧版本地串）", async () => {
  const { fmtStamp, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);

  // 1) 本版本起：ISO UTC -> 转成 +8
  assert.equal(fmtStamp("2026-10-14T08:18:00Z"), "2026-10-14 16:18");
  // 2) 旧版本写下的 UTC 显示串 -> 也要转成 +8（否则抬头说本地、行里却是 UTC）
  assert.equal(fmtStamp("2026-10-14 08:18 UTC"), "2026-10-14 16:18");
  assert.equal(fmtStamp("2026-10-14 08:17 UTC"), "2026-10-14 16:17");
  // 3) 旧版本写下的本地串（无标记）-> 已是显示值，原样返回，别二次偏移
  assert.equal(fmtStamp("2026-10-14 16:18"), "2026-10-14 16:18");
  // 4) 非时间值要能穿过（"从未" / "?" / 空）
  for (const v of ["从未", "?", "", null, undefined, "刚刚"]) {
    assert.equal(fmtStamp(v), v == null ? "" : v, `${JSON.stringify(v)} 应原样返回`);
  }
});

test("⭐ 回归：KV 里存着旧版 `… UTC` 时，/status 也不能再出现 UTC 字样", async () => {
  // 这正是老板实测到的自相矛盾：抬头写"时间均为 Asia/Shanghai（UTC+8）"，
  // 下面每一行却还是 `08:18 UTC`。旧值不会被重写（比如 firstSeen 是历史记录），
  // 所以必须在**显示时**转换。
  const { renderStatus, normalizeState, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  const out = renderStatus({}, normalizeState({
    meta: { lastCheck: "2026-10-14 08:18 UTC", lastScan: "2026-10-14 08:18 UTC" },
    links: { abcdef: { label: "某App", state: "open", stateSince: "2026-10-14 08:18 UTC",
                       lastChecked: "2026-10-14 08:18 UTC", firstSeen: "2026-10-14 08:17 UTC" } },
    appstore: { "1": { version: "1.0", checkedAt: "2026-10-14 08:18 UTC" } },
  }));
  assert.ok(!/UTC(?!\+)/.test(out.replace(/UTC\+8/g, "")), "除抬头的 UTC+8 外不该再出现 UTC：\n" + out);
  // /status 现在用相对时间，所以旧版 UTC 串要能被正确解析成"多久之前"
  assert.match(out, /上次监控 \d+ (分钟|小时|天)前/, "旧版 UTC 串要被解析成相对时间：\n" + out);
  assert.match(out, /状态已保持 \d+ (分钟|小时|天)/, "stateSince 也要解析对");
});

test("groupByName：同一 App 的多条记录要并到一起（否则看着像「怎么这么多」）", async () => {
  const { groupByName } = await import("../src/core.js");
  const g = groupByName(
    [{ appName: "微信读书", code: "a" }, { appName: "微信输入法", code: "b" },
     { appName: "微信读书", code: "c" }, { appName: "", code: "d" }],
    (x) => x.appName
  );
  assert.deepEqual(g.map((x) => x.name), ["微信读书", "微信输入法", "(未命名)"]);
  assert.equal(g[0].items.length, 2, "同名要并成一组");
  assert.equal(g[1].items.length, 1);
  assert.equal(groupByName([], (x) => x.n).length, 0);
});

test("/find：429 要给**现在就能用**的办法，不能只说「稍后重试」", async () => {
  const { findApp, normalizeState } = await import("../src/core.js");
  const fakeFetch = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("<html></html>", { status: 200 });
  };
  const out = await findApp({ state: normalizeState({}), query: "微信", fetchImpl: fakeFetch });
  assert.match(out, /HTTP 429/);
  assert.match(out, /Cloudflare 的共享出口 IP 限流/, "要说清为什么会 429（不是我们写错了）");
  assert.match(out, /appstore=&lt;id&gt;|appstore=<id>/, "要给出绕过办法");
  assert.match(out, /照样能盯链接状态/, "要说清不加 id 也能用，别让人以为必须等");
});

test("findHints：App Store 有本体但没公开 TF 链接时，要明说（这就是搜「微信」的真实情形）", async () => {
  const { findHints } = await import("../src/core.js");
  const notes = findHints({
    term: "微信",
    itunes: [{ trackName: "微信", trackId: 414478124 }],
    tfs: [{ appName: "微信读书" }, { appName: "微信输入法" }],
    deps: [{ name: "微信读书" }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /App Store 里有「微信」本体/);
  assert.match(notes[0], /414478124/, "要把 id 给出来");
  assert.match(notes[0], /没走公开 TestFlight 分发/, "要给出结论，而不是让用户自己猜");
});

test("findHints：连 App Store 都没有正好同名时，说明是子串匹配", async () => {
  const { findHints } = await import("../src/core.js");
  const notes = findHints({
    term: "微信",
    itunes: [{ trackName: "微信读书", trackId: 1 }],
    tfs: [{ appName: "微信读书" }],
  });
  assert.match(notes[0], /没有名字正好是「微信」的/);
  assert.match(notes[0], /含/);
});

test("findHints：有精确同名时不该多嘴", async () => {
  const { findHints } = await import("../src/core.js");
  assert.deepEqual(findHints({ term: "微信读书", itunes: [{ trackName: "微信读书", trackId: 1 }], tfs: [{ appName: "微信读书" }] }), []);
  assert.deepEqual(findHints({ term: "", itunes: [{ trackName: "x" }] }), []);
  assert.deepEqual(findHints({ term: "微信" }), [], "什么都没搜到时不乱说");
});

test("/find：搜的是子串，没有精确同名时要明说（省得以为漏了）", async () => {
  const { findApp, normalizeState } = await import("../src/core.js");
  const body = JSON.stringify({ "@type": "ItemList", itemListElement: [
    { "@type": "SoftwareApplication", name: "微信读书", url: "https://tfstore.top/zh-CN/apps/5MWjLpYl" },
    { "@type": "SoftwareApplication", name: "微信输入法", url: "https://tfstore.top/zh-CN/apps/iSTXkF4K" },
  ] });
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes("itunes.apple.com")) return new Response("x", { status: 429 });
    if (u.includes("tfstore.top")) {
      return new Response('<script type="application/ld+json">' + body + "</script>", { status: 200 });
    }
    return new Response("<html></html>", { status: 200 });
  };
  const out = await findApp({ state: normalizeState({}), query: "微信", fetchImpl: fakeFetch });
  assert.match(out, /没有名字正好是「微信」的/, "要说明是子串匹配，不是漏了");
  assert.match(out, /微信读书/);
  assert.match(out, /2 个码|微信输入法/, "tfstore 结果要在");
});

test("列表按加入时间排（先加的在前）；中文不能靠码点当字典序", async () => {
  const { renderApps, normalizeState } = await import("../src/core.js");
  const out = renderApps(normalizeState({
    links: {
      zzzzzzzz: { label: "阿里云盘", state: "open", url: "https://x/1", firstSeen: "2026-10-14T08:19:00Z" },
      dTUO1uyt: { label: "番茄小说", state: "open", url: "https://x/2", firstSeen: "2026-10-14T08:17:00Z" },
      "5MWjLpYl": { label: "微信读书", state: "full", url: "https://x/3", firstSeen: "2026-10-14T08:18:00Z" },
      nonetime: { label: "没时间的", state: "closed", url: "https://x/4" },
    },
  }));
  const pos = ["番茄小说", "微信读书", "阿里云盘", "没时间的"].map((n) => out.indexOf(n));
  assert.ok(pos.every((p) => p >= 0), "四个都该出现");
  assert.ok(pos[0] < pos[1] && pos[1] < pos[2], "应按加入时间：番茄(17) < 微信(18) < 阿里(19)");
  assert.ok(pos[3] > pos[2], "没有加入时间的排最后，不能插到中间");
  // 说明为什么不用名字排：中文的 < 是码点序，不是字典序
  assert.ok("阿里云盘" > "番茄小说", "码点序下 阿里云盘 确实排在 番茄小说 后面 —— 所以按名字排是假象");
});


test("旧记录纠正：配置带的条目若被旧版写成 manual，要纠正成 config（只动纯 manual）", async () => {
  const { monitorTargets } = await import("../src/core.js");
  const cfg = { watch: [{ code: "dTUO1uyt", label: "番茄小说" }] };
  // 旧版写下的不实记录
  const st = { links: { dTUO1uyt: { label: "番茄小说", sources: ["manual"] },
                        abcdef: { label: "手加的", sources: ["manual"] } } };
  const t = monitorTargets(cfg, st);
  // 复现 runMonitor 里那段纠正逻辑（不联网，直接照抄判定）
  for (const [code, meta] of Object.entries(t)) {
    const rec = st.links[code] || (st.links[code] = {});
    if (!rec.sources) rec.sources = [meta.fromConfig ? "config" : "manual"];
    else if (meta.fromConfig && rec.sources.length === 1 && rec.sources[0] === "manual") rec.sources = ["config"];
  }
  assert.deepEqual(st.links.dTUO1uyt.sources, ["config"], "配置带进来的要纠正成 config");
  assert.deepEqual(st.links.abcdef.sources, ["manual"], "不在配置里的不该被动");
});

test("来源要如实：配置 watch 带进来的标 config，不是 manual（以前写 manual 是不实）", async () => {
  const { monitorTargets } = await import("../src/core.js");
  const cfg = { watch: [{ code: "dTUO1uyt", label: "番茄小说" }] };
  const t = monitorTargets(cfg, { links: { abcdef: { label: "别的" } } });
  assert.equal(t.dTUO1uyt.fromConfig, true, "配置来的要标出来");
  assert.equal(t.abcdef.fromConfig, undefined, "state 里已有的不该被标成配置来的");
});

test("「加入」这个措辞必须写清是「加入监控」——它就在「可加入 ✅」下面，容易被读成加入了测试", async () => {
  const { renderApps, normalizeState } = await import("../src/core.js");
  const out = renderApps(normalizeState({
    links: { abcdef: { label: "某App", state: "open", url: "https://x/1", firstSeen: "2026-10-14T08:17:00Z" } },
  }));
  assert.match(out, /加入监控 2026-10-14 16:17/);
  assert.ok(!/^\s*加入 2026/m.test(out), "不能只写「加入」");
});

test("departures.to 只在和我们的判断不一致时才显示（一致=噪音）", async () => {
  const { renderStatus, normalizeState, departuresDisagrees, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);

  // 纯函数先定规则
  assert.equal(departuresDisagrees("open", "open"), false, "一致不算不一致");
  assert.equal(departuresDisagrees("open", "full"), true, "它说开、我们说满 -> 不一致");
  assert.equal(departuresDisagrees("closed", "open"), true, "它说关、我们说开 -> 不一致");
  assert.equal(departuresDisagrees("closed", "full"), false, "都说不能进 -> 一致");
  assert.equal(departuresDisagrees("", "open"), false, "没状态不报");
  assert.equal(departuresDisagrees("some-new-word", "open"), false, "认不出的状态不误报");

  const mk = (dep) => normalizeState({
    links: { abcdef: { label: "某App", state: "open", url: "https://x/join/abcdef",
                       departures: { status: dep } } },
  });
  assert.ok(!/departures/.test(renderStatus({}, mk("open"))), "一致时不该出现 departures 这行");
  assert.match(renderStatus({}, mk("closed")), /departures\.to 认为 closed/,
    "不一致时要提醒（这是换链接的信号）");
});

test("humanAgo：确定性地验证相对时间（含旧版 UTC 串的解析）", async () => {
  const { humanAgo, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  const now = new Date("2026-10-14T16:58:00Z");   // 北京时间 10-15 00:58

  assert.equal(humanAgo("2026-10-14T16:57:00Z", now), "刚刚");
  assert.equal(humanAgo("2026-10-14T16:28:00Z", now), "30 分钟前");
  assert.equal(humanAgo("2026-10-14T08:18:00Z", now), "8 小时前");
  assert.equal(humanAgo("2026-10-11T16:58:00Z", now), "3 天前");
  // 旧版 UTC 显示串也要解析对（这正是老板 KV 里存着的形态）
  assert.equal(humanAgo("2026-10-14 08:18 UTC", now), "8 小时前");
  // 旧版"本地串"（无标记）按当前时区猜：16:18 本地 = 08:18 UTC
  assert.equal(humanAgo("2026-10-14 16:18", now), "8 小时前");
  // 认不出的原样返回，不能吞
  for (const v of ["从未", "?", "刚刚"]) assert.equal(humanAgo(v, now), v);
  assert.equal(humanAgo("", now), "");
});

test("humanDuration：状态保持了多久", async () => {
  const { humanDuration, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  const now = new Date("2026-10-14T16:58:00Z");
  assert.equal(humanDuration("2026-10-14T16:57:00Z", now), "刚刚");
  assert.equal(humanDuration("2026-10-14T16:28:00Z", now), "30 分钟");
  assert.equal(humanDuration("2026-10-11T16:58:00Z", now), "3 天");
});



test("⭐ 回归：/apps 里的「加入」时间同样要换算", async () => {
  const { renderApps, normalizeState, setDisplayTimeZone } = await import("../src/core.js");
  setDisplayTimeZone("Asia/Shanghai", 480);
  const out = renderApps(normalizeState({
    links: { abcdef: { label: "某App", state: "open", firstSeen: "2026-10-14 08:17 UTC", sources: ["manual"] } },
  }));
  assert.match(out, /加入监控 2026-10-14 16:17/);
  assert.ok(!/UTC/.test(out), "不该出现 UTC：" + out);
});

// ═══════════════════ 一轮 bug 审查后的回归测试 ═══════════════════
// 每条都对着一个**实测复现过的**缺陷写，不是凭空补的。

test("⭐ 首次发现时是满员的码，之后变成可加入必须提醒（以前永久漏报）", async () => {
  // 审查发现的 high：registerDiscovery 以前"只要在 discoveries 里就 return 0"，
  // 而发现源搜到的码绝大多数当时都是满员的 -> 机器人最核心的承诺在最常见路径上失效。
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState(null);
  const cfg = { autoWatchDiscovered: false, keywords: [] };
  const item = () => ({ code: "NEWCODE9", source: "tfstore.top", appName: "某App", context: "" });

  let c = collector();
  let { f } = makeFetch({ joinHtml: load("full_zh.html") });
  await registerDiscovery({ cfg, state, notifier: c.notifier, fetchImpl: f }, item());
  assert.equal(state.discoveries.NEWCODE9.state, "full");
  assert.equal(c.sent.length, 0, "首次发现就是满员 -> **不打扰**，只记录（以前会刷一条没用的）");

  // 状态没变的复探：不能重复报（否则同一码每轮都被"发现"一次，变成噪音）
  c = collector();
  await registerDiscovery({ cfg, state, notifier: c.notifier, fetchImpl: f }, item());
  assert.equal(c.sent.length, 0, "状态没变不该重复报");

  // 变成可加入 -> 必须提醒
  c = collector();
  ({ f } = makeFetch({ joinHtml: load("open_zh.html") }));
  const n = await registerDiscovery({ cfg, state, notifier: c.notifier, fetchImpl: f }, item());
  assert.equal(n, 1, "满员变可加入必须提醒（这正是漏报的那条）");
  assert.match(c.sent.join("\n"), /状态变了/);
  assert.match(c.sent.join("\n"), /可加入/);
});

test("⭐ 告警发送失败时不能记账，下一轮要能重发（以前一次失败=永久丢失）", async () => {
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState(null);
  const cfg = { autoWatchDiscovered: false, keywords: [] };
  const item = () => ({ code: "NEWCODE9", source: "tfstore.top", appName: "某App", context: "" });
  const { f } = makeFetch({ joinHtml: load("open_zh.html") });

  const failing = { send: async () => false };            // 模拟 Telegram 429
  const n = await registerDiscovery({ cfg, state, notifier: failing, fetchImpl: f }, item());
  assert.equal(n, 0);
  assert.equal(state.discoveries.NEWCODE9.notified, false, "发送失败要标记未通知");

  const c = collector();
  const n2 = await registerDiscovery({ cfg, state, notifier: c.notifier, fetchImpl: f }, item());
  assert.equal(n2, 1, "下一轮必须能重发（不能被「状态没变」的短路挡掉）");
});

test("⭐ App 级监控：/del 掉链接后不能留「幽灵码」，状态也不能继续说「等待可用链接」", async () => {
  // 老板截图里的自相矛盾：「微信 — 等待可用链接 ⏳」下面却写着「已找到的链接：7Jg9MM8h」。
  // 那个码是上一轮 bug 误记的，/del 之后 wish 里的记录没清，而状态标签是写死的。
  const { renderApps, renderStatus, handleCommand } = await import("../src/core.js");
  const state = normalizeState({
    links: {
      "app:414478124": { kind: "app", label: "微信", state: "waiting", codes: ["7Jg9MM8h"], firstSeen: "2026-10-14T11:02:00Z" },
      "7Jg9MM8h": { label: "微信读书", state: "open", url: "https://testflight.apple.com/join/7Jg9MM8h" },
    },
  });
  // 删掉那条链接
  const { notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/del 7Jg9MM8h" });

  const apps = renderApps(state).replace(/<[^>]+>/g, "");
  assert.ok(!/7Jg9MM8h/.test(apps), "删掉的码不该还挂在 wish 上：\n" + apps);
  assert.ok(!/已找到的链接/.test(apps), "没有在监控的链接时不该说「已找到」");
  assert.match(apps, /微信 — 等待可用链接/, "应该回到「等待可用链接」");
});

test("App 级监控：有在监控的链接时，状态要显示「已找到链接」而不是「等待」", async () => {
  const { renderApps } = await import("../src/core.js");
  const state = normalizeState({
    links: {
      "app:414478124": { kind: "app", label: "微信", state: "waiting", codes: ["7Jg9MM8h"], firstSeen: "2026-10-14T11:02:00Z" },
      "7Jg9MM8h": { label: "微信读书", state: "open", url: "https://x/7Jg9MM8h" },
    },
  });
  const apps = renderApps(state).replace(/<[^>]+>/g, "");
  assert.match(apps, /微信 — 已找到链接/, "实际：\n" + apps);
  assert.match(apps, /已找到的链接：7Jg9MM8h/);
});

test("⭐ sameAppName：微信 不能被判成 微信读书（includes 做身份判断会误加监控）", async () => {
  const { sameAppName, wishMatches } = await import("../src/core.js");
  // 同名 / 前缀+分隔符 -> 同一个 App
  assert.equal(sameAppName("微信读书", "微信读书"), true);
  assert.equal(sameAppName("番茄小说", "番茄小说 - 热门短剧全本小说电子书阅读器"), true, "前缀后面紧跟分隔符，算同一个");
  assert.equal(sameAppName("微信读书 TestFlight Beta", "微信读书"), true, "空格也是分隔符 -> 同一个 App（这是页面标题变体）");
  // 只是"包含"关系 -> 不是同一个 App（这条就是实测 bug）
  assert.equal(sameAppName("微信", "微信读书"), false, "微信 ≠ 微信读书");
  assert.equal(sameAppName("微信", "微信输入法"), false);
  assert.equal(sameAppName("", "微信"), false);
  assert.equal(sameAppName(null, null), false);

  // wishMatches 是它的使用者：/add 微信 的监控**不该**去认领 微信读书 的码
  const wish = { kind: "app", label: "微信", keywords: ["微信"], codes: [] };
  assert.equal(wishMatches(wish, "微信读书", "7Jg9MM8h"), false, "不能把别的 App 的码当成「你要的」自动加进监控");
  assert.equal(wishMatches(wish, "微信", "abc12345"), true);
});

test("⭐ 满员链接的首次发现只记录不打扰；变成可加入时才提醒（一次 /scan 不再刷十几条没用的）", async () => {
  const { registerDiscovery } = await import("../src/core.js");
  const state = normalizeState(null);
  const cfg = { autoWatchDiscovered: false, keywords: [] };
  const c = collector();
  const { f } = makeFetch({ joinHtml: load("full_zh.html") });
  const n = await registerDiscovery({ cfg, state, notifier: c.notifier, fetchImpl: f },
    { code: "FULLCODE", source: "tfstore.top", appName: "某App", context: "" });
  assert.equal(n, 0, "满员不打扰");
  assert.equal(c.sent.length, 0);
  assert.equal(state.discoveries.FULLCODE.state, "full", "但必须记录下来（/links 看得到，且每轮复探）");
});

test("⭐ runMonitor：状态变化告警发送失败要回退状态，下一轮重发", async () => {
  const { runMonitor } = await import("../src/core.js");
  const mk = () => normalizeState({
    links: { dTUO1uyt: { label: "番茄", state: "full", firstSeen: "2026-10-14T08:00:00Z", sources: ["manual"] } },
  });
  const { f } = makeFetch({ joinHtml: load("open_zh.html"), itunes: { resultCount: 0, results: [] }, depRows: [] });
  const cfg = { watch: [], keywords: [] };

  const state = mk();
  await runMonitor({ cfg, state, notifier: { send: async () => false }, fetchImpl: f });
  assert.equal(state.links.dTUO1uyt.state, "full", "发送失败要回退状态，否则这次变化永久丢失");

  const c = collector();
  const n = await runMonitor({ cfg, state, notifier: c.notifier, fetchImpl: f });
  assert.ok(n >= 1, "下一轮应该重新检测到并发出");
  assert.match(c.sent.join("\n"), /状态变化/);
});

test("⭐ 只读命令不写盘（以前 /status 一回写就把并发期间的更新整份覆盖）", async () => {
  const state = normalizeState({ links: { aaaaaaaa: { label: "A", state: "open" } } });
  const { notifier } = collector();
  for (const text of ["/status", "/apps", "/links", "/help"]) {
    const r = await handleCommand({ cfg: { telegram: {} }, state, notifier, text });
    assert.equal(r && r.mutated, false, text + " 不该标记为改了状态");
  }
  // 会改状态的命令要标 true
  const r2 = await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/del aaaaaaaa" });
  assert.equal(r2 && r2.mutated, true, "/del 应该标记为改了状态");
});

test("⭐ /del 要真的删得掉配置 watch 里的码（以前下一轮自己又回来）", async () => {
  const { monitorTargets, handleCommand: hc } = await import("../src/core.js");
  const state = normalizeState({ links: { dTUO1uyt: { label: "番茄", state: "open" } } });
  const cfg = { telegram: {}, watch: [{ code: "dTUO1uyt", label: "番茄" }] };
  const { notifier } = collector();
  await hc({ cfg, state, notifier, text: "/del dTUO1uyt" });
  assert.ok(!state.links.dTUO1uyt, "要删掉");
  assert.ok(state.removed.dTUO1uyt, "要记墓碑");
  assert.deepEqual(Object.keys(monitorTargets(cfg, state)), [], "墓碑生效后不该再被当目标");
});

test("⭐ /del 支持按名字（App 级监控以前按名字删不掉，还回「列表里没有」）", async () => {
  const state = normalizeState({ links: { "app:微信读书": { kind: "app", label: "微信读书", state: "waiting" } } });
  const { notifier, sent } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/del 微信读书" });
  assert.ok(!state.links["app:微信读书"], "按名字要删得掉，实际：" + JSON.stringify(Object.keys(state.links)));
  assert.match(sent.join("\n"), /已移出监控/);
});

test("裸 /del 要给用法（以前落到「未知命令」，而菜单里点的就是裸 /del）", async () => {
  const state = normalizeState(null);
  const { notifier, sent } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/del" });
  assert.match(sent.join("\n"), /用法/);
  assert.ok(!/未知命令/.test(sent.join("\n")));
});

test("⭐ 重新 /add <名字> 且 iTunes 失败时，不能抹掉已有的 appStoreId", async () => {
  const state = normalizeState(null);
  const cfg = { telegram: {} };
  const tf = `<script type="application/ld+json">{"@graph":[{"@type":"ItemList","itemListElement":[
    {"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/zzzzzzzz","name":"别的App"}]}]}</script>`;
  // 第一次：iTunes 正常
  let { f } = makeFetch({ itunes: { resultCount: 1, results: [
    { trackId: 999, trackName: "某App", bundleId: "com.x", version: "1.0", trackViewUrl: "" }] },
    depRows: [], tfstorePage: tf });
  let { notifier } = collector();
  await handleCommand({ cfg, state, notifier, text: "/add 某App", fetchImpl: f });
  const key = Object.keys(state.links)[0];
  assert.equal(state.links[key].appStoreId, 999, "第一次要拿到 id");

  // 第二次：iTunes 429
  const f429 = async (url) => {
    const u = String(url);
    if (u.includes("itunes.apple.com")) return new Response("x", { status: 429 });
    if (u.includes("tfstore.top")) return htmlRes(tf);
    if (u.includes("departures.to/search")) return htmlRes(depSearchPage([]));
    return new Response("", { status: 404 });
  };
  ({ notifier } = collector());
  await handleCommand({ cfg, state, notifier, text: "/add 某App", fetchImpl: f429 });
  assert.equal(state.links[key].appStoreId, 999, "iTunes 失败时绝不能把已有的 id 抹掉（否则版本告警永久失效）");
});

test("⭐ /add Telegram：6-14 位纯字母数字的英文 App 名不能被当成 join 码", async () => {
  const state = normalizeState(null);
  const { notifier, sent } = collector();
  // 所有 join 码都 404（模拟"Telegram"不是有效码），tfstore 也没有精确同名
  const f = async (url) => {
    const u = String(url);
    if (u.includes("itunes.apple.com")) return jsonRes({ resultCount: 0, results: [] });
    if (u.includes("departures.to/search")) return htmlRes(depSearchPage([]));
    if (u.includes("tfstore.top")) return htmlRes("");
    return new Response("", { status: 404 });
  };
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add Telegram", fetchImpl: f });
  const keys = Object.keys(state.links);
  assert.equal(keys.length, 1, "实际：" + JSON.stringify(keys));
  assert.equal(state.links[keys[0]].kind, "app", "要按名字建成 App 级监控，而不是一条永远失效的链接条目");
  assert.match(sent.join("\n").replace(/<[^>]+>/g, ""), /已加入监控（App 级）：Telegram/);
});

test("⭐ 已关闭页面的通用标题 TestFlight - Apple 不能被当成应用名（会污染关键词）", async () => {
  const { parseJoinPage } = await import("../src/core.js");
  const r = parseJoinPage(load("closed_zh.html"), 200);
  assert.equal(r.state, "closed");
  assert.ok(!/TestFlight/i.test(r.appName || ""), "不能把通用壳当应用名，实际：" + JSON.stringify(r.appName));
});

test("⭐ 一次瞬时抓取失败不能清空已存的 desc（否则之后真正的文案变化会漏报）", async () => {
  const { runMonitor } = await import("../src/core.js");
  const state = normalizeState({
    links: { dTUO1uyt: { label: "番茄", state: "open", desc: "旧说明A", descHash: "hA",
                         firstSeen: "2026-10-14T08:00:00Z", sources: ["manual"] } },
  });
  const cfg = { watch: [], keywords: [] };
  const f = async () => new Response("boom", { status: 503 });   // 模拟瞬时失败
  const c = collector();
  await runMonitor({ cfg, state, notifier: c.notifier, fetchImpl: f });
  assert.equal(state.links.dTUO1uyt.desc, "旧说明A", "失败时不能把好值清空，实际：" + JSON.stringify(state.links.dTUO1uyt.desc));
});

test("/links：同一个码不能既列在「监控中」又列在「历史发现」", async () => {
  const { renderLinks } = await import("../src/core.js");
  const out = renderLinks(normalizeState({
    links: { QQQ11111: { label: "某App", state: "open" } },
    discoveries: { QQQ11111: { code: "QQQ11111", appName: "某App", state: "open", source: "tfstore.top" } },
  }));
  assert.equal((out.match(/QQQ11111/g) || []).length, 1, "只该出现一次：\n" + out);
});

test("/add dep=<id> 也要接受 appstore= / bundle=（以前被静默丢弃）", async () => {
  const state = normalizeState(null);
  const { notifier } = collector();
  const f = async (url) => {
    const u = String(url);
    if (u.includes("departures.to/apps/")) {
      const snap = JSON.stringify({ data: { app_id: 21038, status: "open", url: "https://testflight.apple.com/join/7Jg9MM8h" } }).replace(/"/g, "&quot;");
      return htmlRes(`<title>微信读书 TestFlight Beta — Departures</title><div wire:snapshot="${snap}"></div>`);
    }
    if (u.includes("itunes.apple.com")) return jsonRes({ resultCount: 0, results: [] });
    if (u.includes("departures.to/search")) return htmlRes(depSearchPage([]));
    if (u.includes("testflight.apple.com/join/")) return htmlRes(load("open_zh.html"));
    return new Response("", { status: 404 });
  };
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add dep=21038 appstore=1468454200 bundle=com.dragon.read", fetchImpl: f });
  const rec = state.links["7Jg9MM8h"];
  assert.ok(rec, "要加成，实际：" + JSON.stringify(Object.keys(state.links)));
  assert.equal(rec.appStoreId, 1468454200, "手动指定的 appstore= 必须生效");
  assert.equal(rec.bundleId, "com.dragon.read");
});

// ───────────────────── 发送前的消息安全仍然成立 ─────────────────────

test("新增的 /apps、/find、/sources 输出都能过 Telegram 的 HTML 校验", async () => {
  const { tgHtmlCheck } = await import("../src/core.js");
  const { f } = makeFetch();
  const dirty = normalizeState({
    links: { abcdef: { label: "某 <App> & 名字", appName: "某 <App> & 名字", state: "open", keywords: ["a<b"] } },
  });
  const texts = [renderApps(dirty), await findApp({ state: dirty, query: "a&b", fetchImpl: f })];
  // /sources 会把关键词和监控 App 名原样打出来 —— 带 < & 时也不能把整条消息搞成非法 HTML
  const c = collector();
  await handleCommand({
    cfg: {
      telegram: {}, intervalMinutes: 30,
      keywords: ["a<b", "x&y"], autoWatchKeywords: ["<z>"],
      discovery: { tfstoreQueries: ["q<1"], departuresApps: [] },
    },
    state: dirty, notifier: c.notifier, text: "/sources",
  });
  texts.push(...c.sent);
  for (const text of texts) {
    const [ok, why] = tgHtmlCheck(text);
    assert.ok(ok, "消息必须合法：" + why + "\n" + text);
  }
});

// ───────────────────── ⭐ 2026-10-15 一轮 bug 审查的回归测试 ─────────────────────
// 每条都对着一个**实测复现过**的缺陷写。共同点：都是"看起来在盯，其实没盯"
// 或者"该报的没报"这类**静默**失败。

test("⭐ 回归：App Store 版本更新告警发送失败后必须重发（不能永久丢失）", async () => {
  const { runMonitor, normalizeState } = await import("../src/core.js");
  const cfg = { watch: [], discovery: { useDepartures: false }, keywords: [] };
  const state = normalizeState({
    links: { abcdef: { label: "番茄小说", state: "invalid", appStoreId: 1468454200, firstSeen: "2026-10-01T00:00:00Z" } },
    appstore: { "1468454200": { version: "7.3.9", checkedAt: "2026-10-01T00:00:00Z", name: "番茄小说", releaseDate: "2026-09-30" } },
  });
  const f = async (url) => String(url).includes("itunes.apple.com/lookup")
    ? jsonRes({ results: [{ version: "7.4.0", trackName: "番茄小说", currentVersionReleaseDate: "2026-10-14T00:00:00Z", trackId: 1468454200 }] })
    : new Response("not found", { status: 404 });
  const got = [];
  const failing = { dry: false, async send(t) { got.push(t); return false; } };
  const ok = { dry: false, async send(t) { got.push(t); return true; } };

  assert.equal(await runMonitor({ cfg, state, notifier: failing, fetchImpl: f, log: () => {} }), 0);
  assert.equal(state.appstore["1468454200"].version, "7.3.9",
    "发送失败时不能把新版本号写进去 —— 写了下一轮就不再报了（告警永久丢失）");
  assert.equal(await runMonitor({ cfg, state, notifier: ok, fetchImpl: f, log: () => {} }), 1, "下一轮必须重发");
  assert.equal(state.appstore["1468454200"].version, "7.4.0", "发送成功之后才写新版本号");
  assert.equal(got.filter((t) => /正式版更新/.test(t)).length, 2, "两轮各发一次（第一次失败、第二次成功）");
});

test("⭐ 回归：/del 过的码不能被发现扫描复活（复活了也永远不会被轮询）", async () => {
  const { registerDiscovery, monitorTargets, normalizeState } = await import("../src/core.js");
  const state = normalizeState({ links: {}, removed: { "5MWjLpYl": "2026-10-14T10:00:00Z" } });
  const sent = [];
  const notifier = { dry: false, async send(t) { sent.push(t); return true; } };
  const f = async (url) => String(url).includes("/join/")
    ? htmlRes(load("open_zh.html")) : new Response("", { status: 404 });
  const cfg = { watch: [], keywords: [], autoWatchKeywords: ["番茄小说"], autoWatchDiscovered: true };

  const n = await registerDiscovery({ cfg, state, notifier, fetchImpl: f },
    { source: "tfstore:番茄", code: "5MWjLpYl", appName: "番茄小说", context: "番茄小说 testflight" });

  assert.equal(n, 0, "不该通知");
  assert.equal(sent.length, 0, "不该发消息");
  assert.ok(!state.links["5MWjLpYl"],
    "墓碑必须挡住复活：复活后 /links 说『监控中』，monitorTargets 却按墓碑跳过它 —— 永远不轮询");
  assert.equal(Object.keys(monitorTargets(cfg, state)).length, 0);
});

test("⭐ 回归：/status 里 App 级监控的状态也要按事实推导（不能写死 waiting）", async () => {
  const { renderStatus, renderApps, normalizeState } = await import("../src/core.js");
  const state = normalizeState({
    links: {
      "app:414478124": { kind: "app", label: "微信", appName: "微信", state: "waiting", codes: ["7Jg9MM8h"], firstSeen: "2026-10-14T08:00:00Z" },
      "7Jg9MM8h": { label: "微信读书", state: "full", firstSeen: "2026-10-14T08:05:00Z" },
    },
  });
  const st = renderStatus({}, state);
  assert.match(st, /微信<\/b> — 已找到链接 🔗/, "/status 也要显示『已找到链接』：\n" + st);
  assert.ok(!/等待可用链接/.test(st), "不能出现『等待可用链接 + 已找到链接』这种自相矛盾：\n" + st);
  assert.match(renderApps(state), /微信<\/b> — 已找到链接 🔗/, "/apps 与 /status 必须一致");
});

test("⭐ 回归：/add <裸字母数字> 探测失败时不能猜成 join 码", async () => {
  const state = normalizeState({ links: {} });
  const msgs = [];
  const f = async (url) => {
    if (String(url).includes("testflight.apple.com")) throw new Error("network timeout");
    return new Response("", { status: 200 });
  };
  const res = await handleCommand({
    cfg: { telegram: {} }, state,
    notifier: { dry: true, async send(t) { msgs.push(t); return true; } },
    text: "/add Telegram", fetchImpl: f, log: () => {},
  });
  assert.deepEqual(Object.keys(state.links), [],
    "探测失败时既不能当 join 码（建一条 https://…/join/Telegram 的垃圾记录），也不该瞎猜名字");
  assert.ok(!(res && res.mutated), "什么都没加，就不该回写 state");
  assert.match(msgs.join("\n"), /探测 .*失败/, "要如实说清是探测失败并给出两条出路：\n" + msgs.join("\n"));
});

test("⭐ 回归：TIMEZONE=UTC 不能被静默换成 UTC+8", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { setDisplayTimeZone, nowStr, tzLabel } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:24:00Z");
  try {
    const cfg = loadConfig({ TIMEZONE: "UTC" });
    setDisplayTimeZone(cfg.timezone, cfg.utcOffsetMinutes);
    assert.equal(nowStr(d), "2026-10-14 08:24", "配了 UTC 就该显示 UTC 时间");
    assert.equal(tzLabel(d), "UTC+0");
    // 显式给了偏移就以显式值为准
    const cfg2 = loadConfig({ TIMEZONE: "UTC", UTC_OFFSET_MINUTES: "330" });
    setDisplayTimeZone(cfg2.timezone, cfg2.utcOffsetMinutes);
    assert.equal(tzLabel(d), "UTC+5:30");
  } finally {
    setDisplayTimeZone("Asia/Shanghai", 480);
  }
});

test("⭐ 回归：没改动 state 的命令不能回写整份 state（/del 打错字也一样）", async () => {
  for (const text of ["/del 不存在的码", "/del", "/joined", "/add"]) {
    const state = normalizeState({ links: { abcdef: { label: "A", state: "open" } } });
    const res = await handleCommand({
      cfg: { telegram: {} }, state,
      notifier: { dry: true, async send() { return true; } },
      text, log: () => {},
    });
    assert.ok(!(res && res.mutated),
      `${text} 什么都没改，不该报 mutated（回写会覆盖并发期间 cron 写下的更新）：${JSON.stringify(res)}`);
  }
  // 对照：真的改了就要报
  const s2 = normalizeState({ links: { abcdef: { label: "A", state: "open" } } });
  const r2 = await handleCommand({
    cfg: { telegram: {} }, state: s2,
    notifier: { dry: true, async send() { return true; } },
    text: "/del abcdef", log: () => {},
  });
  assert.ok(r2 && r2.mutated, "真删掉了就必须报 mutated");
  assert.ok(!s2.links.abcdef);
});

test("⭐ 回归：joined 的静音继承要按 sameAppName 判身份（不能用 includes）", async () => {
  const { registerDiscovery, sameAppName, normalizeState } = await import("../src/core.js");
  const cfg = { watch: [], keywords: [], autoWatchKeywords: ["番茄小说"], autoWatchDiscovered: true };
  const f = async (url) => String(url).includes("/join/")
    ? htmlRes(load("open_zh.html")) : new Response("", { status: 404 });
  const notifier = { dry: false, async send() { return true; } };
  assert.equal(sameAppName("番茄", "番茄小说 - 热门短剧"), false, "这两个名字按项目自己的规则不是同一个 App");

  const s1 = normalizeState({ links: { "app:1": { kind: "app", label: "番茄", appName: "番茄", joined: true, codes: [] } } });
  await registerDiscovery({ cfg, state: s1, notifier, fetchImpl: f },
    { source: "tfstore", code: "Abc12345", appName: "番茄小说 - 热门短剧", context: "番茄小说" });
  assert.ok(s1.links["Abc12345"] && !s1.links["Abc12345"].joined,
    "别的 App 的新链接不该被静音（否则它满员/开放都不再提醒）");

  // 真正同一个 App（前缀 + 紧跟分隔符）仍然要一并静音
  const s2 = normalizeState({ links: { "app:1": { kind: "app", label: "番茄小说", appName: "番茄小说", joined: true, codes: [] } } });
  await registerDiscovery({ cfg, state: s2, notifier, fetchImpl: f },
    { source: "tfstore", code: "Zz987654", appName: "番茄小说 - 热门短剧", context: "番茄小说" });
  assert.equal(s2.links["Zz987654"].joined, true, "同一个 App 的别的链接要一并静音");
});

test("⭐ 回归：自动加入监控的发现告警发送失败后，下一轮必须真的重发（不能被 state.links 挡住）", async () => {
  const { registerDiscovery, normalizeState } = await import("../src/core.js");
  const cfg = { watch: [], keywords: [], autoWatchKeywords: ["番茄小说"], autoWatchDiscovered: true };
  const f = async (url) => String(url).includes("/join/")
    ? htmlRes(load("open_zh.html")) : new Response("", { status: 404 });
  const state = normalizeState(null);
  const item = () => ({ source: "tfstore:番茄", code: "5MWjLpYl", appName: "番茄小说", context: "番茄小说" });

  assert.equal(await registerDiscovery({
    cfg, state, notifier: { dry: false, async send() { return false; } }, fetchImpl: f, log: () => {},
  }, item()), 0);
  assert.ok(state.links["5MWjLpYl"], "命中 autoWatchKeywords 时会先把码自动加进监控");
  assert.equal(state.discoveries["5MWjLpYl"].notified, false, "没发出去要记成未通知");

  const sent = [];
  assert.equal(await registerDiscovery({
    cfg, state, notifier: { dry: false, async send(t) { sent.push(t); return true; } }, fetchImpl: f, log: () => {},
  }, item()), 1, "下一轮必须重发 —— 否则『链接开放时告诉你』这条核心承诺会永久丢失");
  assert.equal(state.discoveries["5MWjLpYl"].notified, true);
  assert.match(sent.join("\n"), /🆕 发现新的 TF 链接/,
    "这是重发、不是状态变化，标题不该写『之前发现的链接状态变了』：\n" + sent.join("\n"));
});

test("⭐ 回归：重新 /add 时探测失败，不能把好状态和 desc 基线冲掉", async () => {
  const { handleCommand, runMonitor, normalizeState } = await import("../src/core.js");
  const state = normalizeState({
    links: {
      dTUO1uyt: {
        label: "番茄小说", state: "open", desc: "旧说明：内测名额已发放", descHash: "deadbeef",
        sources: ["manual"], stateSince: "2026-10-01T00:00:00Z",
      },
    },
  });
  const bad = async (url) => {
    if (String(url).includes("testflight.apple.com")) throw new Error("network timeout");
    return new Response("", { status: 429 });
  };
  await handleCommand({
    cfg: { telegram: {} }, state, notifier: { dry: true, async send() { return true; } },
    text: "/add dTUO1uyt", fetchImpl: bad, log: () => {},
  });
  assert.equal(state.links.dTUO1uyt.state, "open", "探测失败不能把 open 写成 error");
  assert.equal(state.links.dTUO1uyt.desc, "旧说明：内测名额已发放", "desc 基线不能被空串冲掉");
  assert.equal(state.links.dTUO1uyt.descHash, "deadbeef");

  const sent = [];
  const good = async (url) => String(url).includes("/join/")
    ? htmlRes(load("open_zh.html")) : new Response("", { status: 404 });
  await runMonitor({
    cfg: { watch: [], keywords: [] }, state,
    notifier: { dry: false, async send(t) { sent.push(t); return true; } }, fetchImpl: good, log: () => {},
  });
  assert.ok(!/状态变化/.test(sent.join("\n")),
    "不能推一条假的『检查失败 ⚠️ → 可加入 ✅』：\n" + sent.join("\n"));
});

test("⭐ 回归：/links 里 App 级监控也不能写死 waiting", async () => {
  const { renderLinks, normalizeState } = await import("../src/core.js");
  const out = renderLinks(normalizeState({
    links: {
      "app:414478124": { kind: "app", label: "微信", state: "waiting", codes: ["7Jg9MM8h"], firstSeen: "2026-10-14T08:00:00Z" },
      "7Jg9MM8h": { label: "微信读书", state: "full", firstSeen: "2026-10-14T08:05:00Z" },
    },
  }));
  assert.match(out, /已找到链接 🔗/, "/links 也要按事实推导：\n" + out);
  assert.ok(!/等待可用链接/.test(out), "不能自相矛盾：\n" + out);
});

// ═══════════════ 第三轮 bug 审查后的回归测试（2026-10-15）═══════════════

test("⭐ 回归：/add <链接> 探测失败时，新记录不能带 error 状态（否则下一轮推假告警）", async () => {
  // 上一轮修了"重新 /add 时不能冲掉已有状态"，但漏了**新建记录**这一半：
  // 新建时照抄 e.state="error"，下一轮成功探测就推一条假的「检查失败 ⚠️ → 可加入 ✅」。
  const { handleCommand, runMonitor, normalizeState } = await import("../src/core.js");
  const state = normalizeState(null);
  const bad = async (url) => {
    if (String(url).includes("testflight.apple.com")) throw new Error("network timeout");
    return new Response("", { status: 429 });
  };
  await handleCommand({
    cfg: { telegram: {} }, state, notifier: { dry: true, async send() { return true; } },
    text: "/add https://testflight.apple.com/join/NEWCODE1", fetchImpl: bad, log: () => {},
  });
  assert.equal(state.links.NEWCODE1.state, undefined,
    "没探测成功过就不该有状态（写 error = 下一轮会推一条假的『检查失败 → 可加入』）");
  assert.equal(state.links.NEWCODE1.stateSince, undefined, "没有状态就不该有『状态已保持』");

  const sent = [];
  const good = async (url) => String(url).includes("/join/")
    ? htmlRes(load("open_zh.html")) : new Response("", { status: 404 });
  await runMonitor({
    cfg: { watch: [], keywords: [] }, state,
    notifier: { dry: false, async send(t) { sent.push(t); return true; } }, fetchImpl: good, log: () => {},
  });
  assert.ok(!/状态变化/.test(sent.join("\n")), "首次探测成功不能报成『状态变化』：\n" + sent.join("\n"));
  assert.equal(state.links.NEWCODE1.state, "open");
});

test("⭐ 回归：页面里超范围的数字实体不能让整轮探测抛出去（&#1114112;）", async () => {
  // 发现源的输入是**别人网页上的任意文本**；一个超范围实体让 probeJoin 抛 RangeError，
  // 整轮监控/扫描就在中途炸掉、state 一次都不落盘（已发的告警下一轮还会重发）。
  const { unescapeEntities, parseJoinPage, probeJoin } = await import("../src/core.js");
  assert.equal(unescapeEntities("a&#1114112;b"), "ab");
  assert.equal(unescapeEntities("a&#x110000;b"), "ab");
  assert.equal(unescapeEntities("a&#65;b"), "aAb", "正常实体照常解");
  const html = `<html><title>Join the &#1114112; Beta</title><div class="beta-status"><span>&#1114112;</span></div></html>`;
  assert.doesNotThrow(() => parseJoinPage(html, 200));
  const r = await probeJoin("ABCDEFG", { fetchImpl: async () => htmlRes(html) });
  assert.ok(r.state, "探测要能正常返回状态：" + JSON.stringify(r));
});

test("⭐ 回归：长得像 join 码但 Apple 404 时，按名字加也要说清（别让人以为链接加上了）", async () => {
  const { handleCommand, normalizeState } = await import("../src/core.js");
  const state = normalizeState(null);
  const sent = [];
  const f = async (url) => {
    const s = String(url);
    if (s.includes("testflight.apple.com/join/")) return new Response("", { status: 404 });
    if (s.includes("itunes.apple.com")) return jsonRes({ resultCount: 0, results: [] });
    if (s.includes("departures.to/search")) return htmlRes("");
    if (s.includes("tfstore.top")) return htmlRes("");
    return new Response("", { status: 404 });
  };
  await handleCommand({
    cfg: { telegram: {} }, state, notifier: { dry: false, async send(t) { sent.push(t); return true; } },
    text: "/add dTUO1uyt", fetchImpl: f, log: () => {},
  });
  const all = sent.join("\n");
  assert.ok(/404/.test(all), "要说明 Apple 那边 404（链接失效或拼错）：\n" + all);
  assert.ok(/App 名字/.test(all), "要说清这次是按 App 名字记下的：\n" + all);
});

test("⭐ 回归：discoveries 裁剪不能先淘汰已知 open 的码（否则会被当「新发现」重报）", async () => {
  // 窗口一满，排序会退化成"按插入顺序"（时间戳只到秒），最早那个 open 码第一个被淘汰，
  // 下一轮又被当成「🆕 发现新的 TF 链接」重报 —— 实测复现过。
  const { registerDiscovery, normalizeState } = await import("../src/core.js");
  const state = normalizeState(null);
  const cfg = { watch: [], keywords: [], autoWatchKeywords: [], autoWatchDiscovered: false };
  const f = async (u) => {
    const s = String(u);
    if (!s.includes("/join/")) return new Response("", { status: 404 });
    return htmlRes(s.endsWith("/KEEPCODE") ? load("open_zh.html") : load("full_zh.html"));
  };
  const fire = async (code) => {
    const sent = [];
    const n = await registerDiscovery({ cfg, state, notifier: { dry: false, async send(t) { sent.push(t); return true; } }, fetchImpl: f },
      { source: "tfstore", code, appName: "某App" + code, context: "" });
    return { n, sent };
  };
  assert.equal((await fire("KEEPCODE")).n, 1, "首次发现可加入要提醒");
  for (let i = 0; i < 80; i++) { await fire("NEW" + i); await fire("KEEPCODE"); }
  assert.ok(state.discoveries.KEEPCODE, "已知 open 的码不能被裁掉");
  const again = await fire("KEEPCODE");
  assert.equal(again.n, 0, "它已经通知过了，不能再报一次：" + again.sent.join("\n"));
});

test("⭐ 回归：发现源被反爬拦住时要出声（360 返回验证码页不能静默当成「0 条」）", async () => {
  // 2026-10-15 线上实测：so.com 对本机**所有**查询都返回 HTTP 200 的验证码页
  // （标题「访问异常页面」），probeSo360 于是静默返回 []，日志里和"今天没有新链接"一样。
  const { probeSo360, probeTfstore, probeBing, probeTgChannel } = await import("../src/core.js");
  const captcha = "<html><head><title>访问异常页面</title></head><body>" +
    "<h4 class='title'>请输入验证码以便正常访问</h4>" +
    "<script src='https://s.ssl.qhres2.com/pkg/anti_captcha/vip/latest/q360.js'></script></body></html>";
  const logs = [];
  const out = await probeSo360("番茄小说", { fetchImpl: async () => htmlRes(captcha), log: (m) => logs.push(m) });
  assert.deepEqual(out, [], "拦住了就是没有结果");
  assert.ok(logs.some((m) => /反爬|验证码/.test(m)), "被拦住必须说出来：\n" + logs.join("\n"));

  for (const [name, fn] of [["tfstore", probeTfstore], ["Bing", probeBing], ["TG 频道", probeTgChannel]]) {
    const l = [];
    const r = await fn("x", { fetchImpl: async () => new Response("boom", { status: 503 }), log: (m) => l.push(m) });
    assert.deepEqual(r, []);
    assert.ok(l.some((m) => /503/.test(m)), `${name} 非 200 也要说出来：` + l.join("|"));
  }
});

// ═══════════ 2026-10-19：老板实测「没加过微信输入法，却被推了它的链接」 ═══════════

test("⭐ 回归：加了「微信」之后，「微信输入法」的链接不能被推（身份匹配，不是子串）", async () => {
  // 实测经过：他加过一条 App 级监控「微信」（微信本体没有公开 TF 链接），
  // 这条记录派生出关键词 "微信"；旧的推送过滤把全局关键词和它混在一起做**子串**匹配，
  // 于是 "微信输入法".includes("微信") 成立 -> 推了一条「微信输入法」的告警，
  // 而消息里自己还写着"未自动加入监控"（自相矛盾）。截图见 2026-10-19。
  const { discoveryRelevant, watchedNames, normalizeState, runDiscovery } = await import("../src/core.js");

  // ① 纯函数层：两套关键词的匹配方式必须不同
  const watched = ["微信", "com.tencent.xin"];
  assert.equal(discoveryRelevant({ keywords: ["番茄小说"], watched }, { appName: "微信输入法" }), false,
    "「微信输入法」不是「微信」—— 按身份匹配必须拦住它");
  assert.equal(discoveryRelevant({ keywords: ["番茄小说"], watched }, { appName: "微信读书" }), false,
    "「微信读书」也不是「微信」");
  assert.equal(discoveryRelevant({ keywords: ["番茄小说"], watched }, { appName: "微信" }), true,
    "监控里的 App 本身要能过");
  assert.equal(discoveryRelevant({ keywords: ["番茄小说"], watched }, { appName: "番茄小说 - 热门短剧全本小说电子书阅读器" }), true,
    "全局关键词仍然是子串匹配：配了「番茄小说」要能命中带副标题的全名");
  assert.equal(discoveryRelevant({ keywords: [], watched: ["微信读书"] }, { appName: "微信读书 - 小说" }), true,
    "监控里的 App 的副标题变体也算同一个 App");
  assert.equal(discoveryRelevant({ keywords: [], watched: ["微信"] }, { context: "微信 内测 链接" }), true,
    "拿不到应用名时（TG 频道只有正文）退回子串 —— 别把那条源变成瞎子");

  // ② 端到端：tfstore 搜到「微信输入法」的可加入链接，一条消息都不该发
  const state = normalizeState({
    links: { "app:414478124": { kind: "app", label: "微信", appName: "微信", keywords: ["微信", "com.tencent.xin"], codes: [], firstSeen: "2026-10-14T00:00:00Z" } },
    // 上一轮扫到过、当时满员 —— 和截图里「🔄 之前发现的链接状态变了」一致
    discoveries: { "406CX1N8": { source: "tfstore.top", code: "406CX1N8", appName: "微信输入法", state: "full", foundAt: "2026-10-18T00:00:00Z", notified: false, unsent: false } },
  });
  const cfg = {
    keywords: ["番茄小说", "番茄免费小说", "番茄畅听", "dragon.read", "fqnovel", "fanqie"],
    autoWatchKeywords: ["番茄小说", "dragon.read", "fqnovel", "fanqie"],
    autoWatchDiscovered: true,
    discovery: { useDepartures: false, departuresApps: [], tfstoreQueries: ["微信"], webQueries: [], telegramChannels: [] },
  };
  const f = async (url) => {
    const s = String(url);
    if (s.includes("tfstore.top")) {
      return new Response(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/406CX1N8","name":"微信输入法"}]}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (s.includes("/join/406CX1N8")) return htmlRes(load("open_zh.html"));
    if (s.includes("api.telegram.org")) return jsonRes({ ok: true, result: { message_id: 1 } });
    return new Response("", { status: 404 });
  };
  const sent = [];
  await runDiscovery({ cfg, state, notifier: { dry: false, async send(t) { sent.push(t); return true; } }, log: () => {}, fetchImpl: f });
  assert.deepEqual(sent, [], "「微信输入法」不该被推给用户：\n" + sent.join("\n"));
  assert.ok(!state.links["406CX1N8"], "也不该被加进监控");

  // ③ 同一套过滤下，监控里的「微信读书」仍然要能过（别修过头）
  const state2 = normalizeState({
    links: { "app:1": { kind: "app", label: "微信读书", appName: "微信读书", keywords: ["微信读书"], codes: [] } },
  });
  const f2 = async (url) => {
    const s = String(url);
    if (s.includes("tfstore.top")) {
      return new Response(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"https://tfstore.top/zh-CN/apps/7Jg9MM8h","name":"微信读书"}]}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (s.includes("/join/7Jg9MM8h")) return htmlRes(load("open_zh.html"));
    if (s.includes("api.telegram.org")) return jsonRes({ ok: true, result: { message_id: 1 } });
    return new Response("", { status: 404 });
  };
  const sent2 = [];
  await runDiscovery({ cfg, state: state2, notifier: { dry: false, async send(t) { sent2.push(t); return true; } }, log: () => {}, fetchImpl: f2 });
  assert.equal(sent2.length, 1, "监控里的「微信读书」出了可加入链接，必须告诉老板：\n" + sent2.join("\n"));
});
