// 这个文件**故意**单独放：只有全新的模块实例才能观察到"模块初始化时的默认值"。
// （apps.test.mjs 里前面的用例已经把时区改过了，在那里测不到初始状态。）
import test from "node:test";
import assert from "node:assert/strict";

test("模块初始默认时区是项目默认（+8），不是 UTC —— 忘了设也不能把 16:17 显示成 08:17", async () => {
  const { nowStr, tzLabel } = await import("../src/core.js");
  const d = new Date("2026-10-14T08:18:00Z");
  assert.equal(nowStr(d), "2026-10-14 16:18",
    "初始默认必须是 +8：入口忘了调用 setDisplayTimeZone 时，退回 UTC 是很隐蔽的错误");
  assert.match(tzLabel(d), /Asia\/Shanghai（UTC\+8）/);
  assert.ok(!/UTC$/.test(nowStr(d)), "默认输出里不该有裸 UTC");
});
