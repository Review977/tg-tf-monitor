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
  effectiveKeywords, effectiveTfstoreQueries, renderApps, findApp,
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

test("effectiveKeywords：并上各 App 自己的关键词（否则新加的 App 在 /scan 里永远匹配不上）", () => {
  const cfg = { keywords: ["番茄小说"] };
  const state = normalizeState({ links: { abc: { keywords: ["微信读书", "com.tencent.weread"] } } });
  const kws = effectiveKeywords(cfg, state);
  assert.ok(kws.includes("番茄小说"));
  assert.ok(kws.includes("微信读书"));
  assert.ok(kws.includes("com.tencent.weread"));
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

test("/add：给的不是 join 码时，指路到 /find 而不是只说看不懂", async () => {
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add 微信读书" });
  const all = sent.join("\n");
  assert.match(all, /\/find/);
  assert.match(all, /join 码长这样/);
  assert.equal(Object.keys(state.links).length, 0);
});

test("/add：不带参数时给用法", async () => {
  const state = normalizeState(null);
  const { sent, notifier } = collector();
  await handleCommand({ cfg: { telegram: {} }, state, notifier, text: "/add" });
  assert.match(sent.join("\n"), /用法/);
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
  assert.match(out, /tfstore/);
  assert.match(out, /CNeMrOox/);
  assert.match(out, /\/add CNeMrOox/, "要给出可直接复制的命令");
  assert.match(out, /departures\.to/);
  assert.match(out, /16645/);
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

test("端到端：加一个 App 后，它的关键词进入发现过滤（新 App 才会被 /scan 捞到）", async () => {
  const { f } = makeFetch();
  const state = normalizeState(null);
  const { notifier } = collector();
  const cfg = { telegram: {}, keywords: ["番茄小说"], discovery: { tfstoreQueries: [] } };
  await handleCommand({ cfg, state, notifier, text: "/add dTUO1uyt", fetchImpl: f });
  const kws = effectiveKeywords(cfg, state);
  assert.ok(kws.some((k) => k.includes("番茄")), "新加 App 的关键词要进过滤集");
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

// ───────────────────── 发送前的消息安全仍然成立 ─────────────────────

test("新增的 /apps、/find 输出都能过 Telegram 的 HTML 校验", async () => {
  const { tgHtmlCheck } = await import("../src/core.js");
  const { f } = makeFetch();
  const dirty = normalizeState({
    links: { abcdef: { label: "某 <App> & 名字", appName: "某 <App> & 名字", state: "open", keywords: ["a<b"] } },
  });
  for (const text of [renderApps(dirty), await findApp({ state: dirty, query: "a&b", fetchImpl: f })]) {
    const [ok, why] = tgHtmlCheck(text);
    assert.ok(ok, "消息必须合法：" + why);
  }
});
