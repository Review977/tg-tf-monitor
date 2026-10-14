/**
 * 样本同步检查。
 *
 * 项目内的 `test/fixtures/` 与工作区里那套共用样本如果同时存在，
 * 必须**逐字节相同** —— 否则会出现"拿旧样本验证新判定逻辑"这种最阴的假绿。
 * 公开仓库里只有一份（项目内），这条检查会自动跳过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DIR, SHARED_DIR, REQUIRED_FIXTURES, listFixtures } from "./fixtures-dir.mjs";

test("样本齐全：6 个状态 × 语言样本都在", () => {
  for (const f of REQUIRED_FIXTURES) {
    assert.ok(existsSync(join(LOCAL_DIR, f)) || existsSync(join(SHARED_DIR, f)), "缺样本 " + f);
  }
});

test("项目内样本与工作区共用样本逐字节一致（两份都存在时）", () => {
  const local = listFixtures(LOCAL_DIR);
  const shared = listFixtures(SHARED_DIR);
  if (!local.length || !shared.length) {
    // 公开仓库只有项目内那一份 —— 跳过
    return;
  }
  for (const f of local) {
    if (!shared.includes(f)) continue;
    const a = readFileSync(join(LOCAL_DIR, f));
    const b = readFileSync(join(SHARED_DIR, f));
    assert.ok(
      a.equals(b),
      `样本漂移了：${f}\n  项目内 ${join(LOCAL_DIR, f)}\n  工作区 ${join(SHARED_DIR, f)}\n` +
      `  重新同步：cp tg-tf-monitor/tests/fixtures/*.html tg-tf-monitor-cloud/test/fixtures/`
    );
  }
});
