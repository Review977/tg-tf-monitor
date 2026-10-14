/**
 * 核心逻辑的确定性离线单测（Node 内置 test runner，零依赖）
 *
 *   node --test test/
 *
 * 用的**和 Python 版同一批 fixture**（tg-tf-monitor/tests/fixtures/*.html）——
 * 这样"移植是否忠实"有硬证据，而不是靠肉眼看。
 * 只存一份样本，避免两份实现各自漂移。
 *
 * 为什么必须离线：Apple 的 join 页语言是随机的（同一链接这次中文、下次英文），
 * 只测线上页面 = 测不准。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "./fixtures-dir.mjs";

import {
  parseJoinPage, cleanAppName, findJoinCodes, firstJoinCode, shortHash,
  tgHtmlCheck, tgPrepare, htmlToPlain, tgSendParams,
  GENERIC_DESC, TG_ALLOWED_TAGS, JOIN_CODE_RE,
} from "../src/core.js";

function load(name) {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

// ───────────────────────── 状态判定 ─────────────────────────

const CASES = [
  ["open_zh.html", "open"],
  ["open_en.html", "open"],
  ["full_zh.html", "full"],
  ["full_en.html", "full"],
  ["closed_zh.html", "closed"],
  ["closed_en.html", "closed"],
];

for (const [file, want] of CASES) {
  test(`状态判定 ${file} → ${want}`, () => {
    const info = parseJoinPage(load(file), 200);
    assert.equal(
      info.state, want,
      `${file} 判成了 ${info.state}（期望 ${want}）；statusText=${JSON.stringify(info.statusText)}`
    );
  });
}

// ───────────────────────── 回归护栏 ─────────────────────────

const VIEW_BUTTON = ["View in TestFlight", "在 TestFlight 中查看"];
const hasViewButton = (h) => VIEW_BUTTON.some((k) => h.includes(k));

test("护栏：已满/已关闭页面上仍带着 beta-status 与「加入测试」按钮", () => {
  for (const f of ["full_zh.html", "full_en.html", "closed_zh.html", "closed_en.html"]) {
    const h = load(f);
    assert.ok(h.includes("beta-status"), `${f} 本应仍带 beta-status（这正是坑所在）`);
    assert.ok(hasViewButton(h), `${f} 本应仍带「加入测试」按钮文案`);
  }
});

test("护栏：把「有 beta-status + 加入按钮就算可加入」这条错规则跑一遍，确认它真的会判错", () => {
  for (const f of ["full_zh.html", "full_en.html", "closed_zh.html", "closed_en.html"]) {
    const h = load(f);
    const naive = h.includes("beta-status") && hasViewButton(h) ? "open" : "not-open";
    assert.equal(naive, "open", `错规则在 ${f} 上本应判成 open（说明它确实不可用）`);
    assert.notEqual(parseJoinPage(h, 200).state, "open", `正确实现不该把 ${f} 判成 open`);
  }
});

// ───────────────────────── HTTP 分支 ─────────────────────────

test("404 → invalid", () => {
  assert.equal(parseJoinPage("", 404).state, "invalid");
});

test("网络异常 → error，且带上原因", () => {
  const i = parseJoinPage("", 0, "timed out");
  assert.equal(i.state, "error");
  assert.equal(i.error, "timed out");
});

test("其它 HTTP 码 → error 且含码值", () => {
  const i = parseJoinPage("", 503);
  assert.equal(i.state, "error");
  assert.ok(i.error.includes("503"));
});

test("200 但页面空/被截断 → unknown，绝不能误报成可加入", () => {
  assert.equal(parseJoinPage("", 200).state, "unknown");
  assert.equal(parseJoinPage("<html><body>hi</body></html>", 200).state, "unknown");
});

// ───────────────────────── 反例 ─────────────────────────

test("反例：App 描述里写「名额已满」不该把 open 页判成 full", () => {
  const h = load("open_zh.html");
  const tampered = h.replace('<p class="step3">', '<p class="step3">名额已满？不，还有名额！');
  assert.notEqual(h, tampered, "样本里应能找到 step3 以做注入");
  const info = parseJoinPage(tampered, 200);
  assert.equal(info.state, "open", `描述文案不该影响状态判定；statusText=${JSON.stringify(info.statusText)}`);
});

test("反例：App 名里带状态词（如叫「测试员已满」）不该误判", () => {
  const h = load("open_zh.html");
  const tampered = h.replace(
    /<title>[\s\S]*?<\/title>/,
    "<title>加入 Beta 版“测试员已满” - TestFlight - Apple</title>"
  );
  assert.notEqual(h, tampered);
  assert.equal(parseJoinPage(tampered, 200).state, "open");
});

// ───────────────────────── 字段抽取 ─────────────────────────

test("抽取：open 中文页的应用名与描述", () => {
  const i = parseJoinPage(load("open_zh.html"), 200);
  assert.equal(i.appName, "番茄小说 - 热门短剧全本小说电子书阅读器");
  assert.ok(i.desc.includes("内测名额"), `desc=${JSON.stringify(i.desc)}`);
});

test("抽取：open 英文页的应用名（与中文页一致）", () => {
  assert.equal(
    parseJoinPage(load("open_en.html"), 200).appName,
    "番茄小说 - 热门短剧全本小说电子书阅读器"
  );
});

test("抽取：描述必须取 app 专属块，不能取到通用说明段", () => {
  for (const f of ["open_zh.html", "open_en.html", "full_zh.html", "full_en.html"]) {
    const i = parseJoinPage(load(f), 200);
    for (const g of GENERIC_DESC) {
      assert.ok(!i.desc.includes(g), `${f} 的描述取到了通用说明段`);
    }
  }
});

test("抽取：已满时描述仍应能取到（满员期间也盯得住文案变化）", () => {
  assert.ok(parseJoinPage(load("full_zh.html"), 200).desc);
});

test("抽取：descHash 稳定且非空", () => {
  const a = parseJoinPage(load("open_zh.html"), 200).descHash;
  const b = parseJoinPage(load("open_zh.html"), 200).descHash;
  assert.equal(a, b);
  assert.ok(a);
});

test("抽取：应用名剥壳（中英各种写法）", () => {
  const cases = [
    ["View Foo Beta", "Foo"],
    ["查看“Foo”Beta 版", "Foo"],
    ["Join the Foo beta", "Foo"],
    ["加入 Beta 版“Foo”", "Foo"],
    ["View 番茄小说 - 热门短剧全本小说电子书阅读器 Beta", "番茄小说 - 热门短剧全本小说电子书阅读器"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(cleanAppName(raw), want, `剥壳失败：${JSON.stringify(raw)}`);
  }
});

// ───────────────────────── join 码抽取 ─────────────────────────

test("join 码：各种 URL 形态都要能抠出来", () => {
  const cases = [
    ["https://testflight.apple.com/join/dTUO1uyt", "dTUO1uyt"],
    ["https://testflight.apple.com%2Fjoin%2FdTUO1uyt", "dTUO1uyt"],
    ["https:\\/\\/testflight.apple.com\\/join\\/dTUO1uyt", "dTUO1uyt"],
    ['data-mdurl="https://testflight.apple.com/join/Q3eOYwKC"', "Q3eOYwKC"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(firstJoinCode(raw), want, `没从 ${JSON.stringify(raw)} 里抠出 join 码`);
  }
});

test("join 码：不该匹配其它路径", () => {
  assert.equal(firstJoinCode("https://testflight.apple.com/app/12345"), "");
  assert.equal(firstJoinCode("https://example.com/join/dTUO1uyt"), "");
});

test("join 码：多次调用不因正则 lastIndex 而漏抓（易错点）", () => {
  const s = "a https://testflight.apple.com/join/AAAAAAAA b https://testflight.apple.com/join/BBBBBBBB";
  assert.deepEqual(findJoinCodes(s).sort(), ["AAAAAAAA", "BBBBBBBB"]);
  assert.deepEqual(findJoinCodes(s).sort(), ["AAAAAAAA", "BBBBBBBB"], "第二次调用必须结果一致");
  assert.equal(firstJoinCode(s), "AAAAAAAA");
  assert.equal(firstJoinCode(s), "AAAAAAAA", "第二次调用必须结果一致");
});

test("join 码：格式校验", () => {
  assert.ok(JOIN_CODE_RE.test("dTUO1uyt"));
  assert.ok(JOIN_CODE_RE.test("zzzzzzzz"));
  assert.ok(!JOIN_CODE_RE.test("坏码"));
  assert.ok(!JOIN_CODE_RE.test("abc"));
});

// ───────────────────────── 语言无关性 ─────────────────────────

/**
 * Cloudflare Workers 的出口 IP 可能落在东京等地，Apple 就会返回**日语页**。
 * 只认中英措辞的话，那时会判成"状态未知" —— 所以结构判据是必需的。
 * 这几条测试把样本里的措辞换成日语，验证"看不懂措辞也判得对"。
 */
test("语言无关：措辞换成日语，open 仍判得出来（靠结构）", () => {
  const h = load("open_zh.html")
    .replace(/第 2 步/g, "ステップ 2")
    .replace(/第 1 步/g, "ステップ 1")
    .replace(/要加入 Beta 版/g, "ベータ版に参加するには");
  const info = parseJoinPage(h, 200);
  assert.equal(info.state, "open", `日语页应靠结构判出 open；statusText=${JSON.stringify(info.statusText)}`);
  assert.equal(info.stateBasis, "structure", "应标明是靠结构判的");
});

test("语言无关：措辞换成日语，full 仍判得出来（靠标题）", () => {
  const h = load("full_zh.html").replace("此 Beta 版本的测试员已满。", "このベータ版は満員です。");
  const info = parseJoinPage(h, 200);
  assert.equal(info.state, "full", `应靠标题判出 full；title=${JSON.stringify(info.title)}`);
  assert.equal(info.stateBasis, "title", "应标明是标题推断");
});

test("语言无关：措辞换成日语，closed 仍判得出来（靠通用标题）", () => {
  const h = load("closed_zh.html").replace("此 Beta 版本目前不接受任何新测试员。", "このベータ版は現在新しいテスターを受け付けていません。");
  const info = parseJoinPage(h, 200);
  assert.equal(info.state, "closed", `应靠通用标题判出 closed；title=${JSON.stringify(info.title)}`);
  assert.equal(info.stateBasis, "title");
});

test("中英页面仍走措辞层（不被结构层抢走精度）", () => {
  assert.equal(parseJoinPage(load("full_en.html"), 200).stateBasis, "wording");
  assert.equal(parseJoinPage(load("full_zh.html"), 200).stateBasis, "wording");
  assert.equal(parseJoinPage(load("closed_en.html"), 200).stateBasis, "wording");
  assert.equal(parseJoinPage(load("closed_zh.html"), 200).stateBasis, "wording");
  assert.equal(parseJoinPage(load("open_zh.html"), 200).stateBasis, "structure");
});

test("结构判据本身：非空 step1 是 open 与 非open 的分水岭", () => {
  const countNonEmpty = (h) =>
    h.split('class="app-steps"').slice(1)
      .filter((ch) => {
        const m = /<div class="step1">([\s\S]*?)<\/div>/i.exec(ch);
        return m && m[1].trim();
      }).length;
  assert.equal(countNonEmpty(load("open_zh.html")), 2);
  assert.equal(countNonEmpty(load("open_en.html")), 2);
  for (const f of ["full_zh.html", "full_en.html", "closed_zh.html", "closed_en.html"]) {
    assert.equal(countNonEmpty(load(f)), 0, `${f} 不该有非空 step1`);
  }
});

// ───────────────────────── Telegram 消息安全 ─────────────────────────

test("消息安全：正常告警通过", () => {
  const msg = "<b>番茄小说 TF 公测 TF 链接状态变化</b>\n链接：https://testflight.apple.com/join/dTUO1uyt\n" +
    "状态：可加入 ✅ → <b>已满员 ⛔</b>\njoin 码：<code>dTUO1uyt</code>";
  const [ok, why] = tgHtmlCheck(msg);
  assert.ok(ok, `正常告警不该被判不合法：${why}`);
});

test("消息安全：裸 < 被拒（页面数据不可信）", () => {
  const [ok, why] = tgHtmlCheck("应用：<b>番茄</b> 小说 < 测试版 > 上线");
  assert.ok(!ok);
  assert.ok(why.includes("<"));
});

test("消息安全：未闭合 / 不配对 / 未知标签被拒", () => {
  assert.ok(!tgHtmlCheck("<b>没关标签")[0]);
  assert.ok(!tgHtmlCheck("<b>x</i>")[0]);
  assert.ok(!tgHtmlCheck("<script>x</script>")[0]);
  assert.ok(!tgHtmlCheck("<div>x</div>")[0]);
});

test("消息安全：未转义 & 被拒，转义后通过", () => {
  assert.ok(!tgHtmlCheck("A & B")[0]);
  assert.ok(tgHtmlCheck("A &amp; B")[0]);
});

test("消息安全：白名单标签都通过", () => {
  for (const t of ["b", "i", "u", "s", "code", "pre", "blockquote", "tg-spoiler"]) {
    assert.ok(tgHtmlCheck(`<${t}>x</${t}>`)[0], `标签 ${t} 应被允许`);
    assert.ok(TG_ALLOWED_TAGS.has(t));
  }
});

test("消息安全：超长按行截断，且不会截在标签中间", () => {
  const long = Array.from({ length: 500 }, (_, i) => `<b>第 ${i} 行</b> 番茄小说 TF 状态：可加入 ✅`).join("\n");
  const { body } = tgPrepare(long);
  assert.ok(body.length <= 4040, `截断后不该明显超长，实际 ${body.length}`);
  const [ok, why] = tgHtmlCheck(body);
  assert.ok(ok, `截断后的消息仍必须合法：${why}`);
  assert.ok(body.includes("已截断"));
});

test("消息安全：脏数据降级成纯文本而不是发不出去", () => {
  const { body, degraded } = tgPrepare("应用：<b>番茄</b> & <script>alert(1)</script>");
  assert.ok(degraded, "含未知标签的消息本应降级");
  assert.ok(!body.includes("<script>"));
  assert.ok(!body.includes("<b>"));
  assert.ok(body.includes("番茄"));
});

test("htmlToPlain 保留换行", () => {
  assert.equal(htmlToPlain("<b>a</b>\n<i>b</i>"), "a\nb");
});

test("sendMessage 参数：现代 + 老式链接预览键都在", () => {
  const p = tgSendParams("123", "<b>hi</b>");
  assert.ok("link_preview_options" in p, "必须发现代键 link_preview_options");
  assert.equal(JSON.parse(p.link_preview_options).is_disabled, true);
  assert.equal(p.disable_web_page_preview, "true", "旧键应保留做兼容");
  assert.equal(p.parse_mode, "HTML");
  assert.equal(p.chat_id, "123");
});

test("纯文本重试时不能带 parse_mode", () => {
  const p = tgSendParams("123", "a < b");
  delete p.parse_mode;
  assert.ok(!("parse_mode" in p));
});

// ───────────────────────── 哈希 ─────────────────────────

test("shortHash 稳定、定长、区分大小写内容", () => {
  assert.equal(shortHash("abc"), shortHash("abc"));
  assert.notEqual(shortHash("abc"), shortHash("abd"));
  assert.equal(shortHash("abc").length, 8);
  assert.equal(shortHash(""), "811c9dc5");
});
