/**
 * CPU 基准：量"解析一个真实页面"要多少毫秒。
 *
 * 为什么必须量：Cloudflare Workers **免费版每次调用只有 10ms CPU**
 * （网络等待不计，但 JS 执行计）。这条限制决定了"一次扫描所有源"到底行不行。
 * 与其猜，不如拿真实页面量。
 *
 *   node bench.mjs
 *
 * 输出的是**纯解析时间**（不含网络）。
 */

import {
  parseJoinPage, findJoinCodes, probeDepartures, probeTfstore, probeBing, probeSo360, probeTgChannel,
} from "./src/core.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" } });
  return [res.status, await res.text()];
}

function timeIt(label, bytes, fn, rounds = 20) {
  fn(); // 预热
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) fn();
  const per = (performance.now() - t0) / rounds;
  console.log(
    `  ${label.padEnd(34)} ${String(Math.round(bytes / 1024)).padStart(4)}KB  ` +
    `${per.toFixed(3).padStart(8)} ms`
  );
  return per;
}

const TARGETS = [
  ["join 页（Apple）", "https://testflight.apple.com/join/dTUO1uyt"],
  ["departures.to 应用页", "https://departures.to/apps/16645"],
  ["tfstore 搜索页", "https://tfstore.top/zh-CN/apps/search?search=%E7%95%AA%E8%8C%84"],
  ["t.me/s/testflight", "https://t.me/s/testflight"],
  ["Bing 搜索页", "https://cn.bing.com/search?q=testflight"],
  ["360 搜索页", "https://www.so.com/s?q=testflight"],
];

const pages = {};
console.log("抓取真实页面…");
for (const [label, url] of TARGETS) {
  const [st, text] = await get(url);
  pages[label] = text;
  console.log(`  ${label.padEnd(34)} http=${st} ${Math.round(text.length / 1024)}KB`);
}

console.log("\n=== 纯解析 CPU（每次调用）===");
const joinPage = pages["join 页（Apple）"];
timeIt("parseJoinPage(join 页)", joinPage.length, () => parseJoinPage(joinPage, 200));
timeIt("findJoinCodes(join 页)", joinPage.length, () => findJoinCodes(joinPage));
timeIt("findJoinCodes(360 页, 最大)", pages["360 搜索页"].length, () => findJoinCodes(pages["360 搜索页"]));

console.log("\n=== 各发现源的解析成本（用探针实跑，含网络）===");
async function probeCost(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  const n = Array.isArray(r) ? r.length : 1;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms（含网络，命中 ${n}）`);
  return ms;
}
await probeCost("probeDepartures(16645)", () => probeDepartures(16645));
await probeCost("probeTfstore(番茄)", () => probeTfstore("番茄"));
await probeCost("probeBing(…)", () => probeBing("testflight"));
await probeCost("probeSo360(…)", () => probeSo360("testflight"));
await probeCost("probeTgChannel(testflight)", () => probeTgChannel("testflight"));

// 只看纯解析部分（探针里网络占大头，这里把解析单独拎出来量）
console.log("\n=== 纯解析（把网络摘掉，模拟 Worker 的 CPU 计费口径）===");
const dep = pages["departures.to 应用页"];
const so = pages["360 搜索页"];
const tg = pages["t.me/s/testflight"];
const tf = pages["tfstore 搜索页"];
timeIt("departures wire:snapshot 解析", dep.length, () => {
  const re = /wire:snapshot="([^"]+)"/g;
  let m;
  while ((m = re.exec(dep)) !== null) { try { JSON.parse(m[1]); } catch { /* ignore */ } }
});
timeIt("so360 res-list 解析", so.length, () => {
  const re = /<li class="res-list"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(so)) !== null) findJoinCodes(m[0]);
});
timeIt("tg channel 消息切分", tg.length, () => {
  for (const c of tg.split("tgme_widget_message_wrap").slice(1)) findJoinCodes(c);
});
timeIt("tfstore JSON-LD 解析", tf.length, () => {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(tf)) !== null) { try { JSON.parse(m[1]); } catch { /* ignore */ } }
});
