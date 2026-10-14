/**
 * 定位页面样本目录。
 *
 * 优先用项目内的 `test/fixtures/`（公开仓库就是这种自包含形态）；
 * 找不到时退回工作区里那套共用的样本（开发时的原始位置）。
 *
 * ⚠️ 两处都有时必须是**逐字节相同**的 —— `test/fixtures-sync.test.mjs` 会检查这一点。
 * 样本是"不可变的页面快照"，不是逻辑，所以存两份的风险远小于两份判定逻辑；
 * 但漂移了仍然会让人拿旧样本验证新逻辑，所以还是要挡。
 */

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export const LOCAL_FIXTURES = join(ROOT, "test", "fixtures");
export const SHARED_FIXTURES = join(ROOT, "..", "tg-tf-monitor-local", "tests", "fixtures");

const REQUIRED = [
  "open_zh.html", "open_en.html",
  "full_zh.html", "full_en.html",
  "closed_zh.html", "closed_en.html",
];

function hasAll(dir) {
  return existsSync(dir) && REQUIRED.every((f) => existsSync(join(dir, f)));
}

export const FIXTURES_DIR = hasAll(LOCAL_FIXTURES) ? LOCAL_FIXTURES : SHARED_FIXTURES;

if (!hasAll(FIXTURES_DIR)) {
  throw new Error(
    "找不到页面样本。应该在 test/fixtures/ 下有这 6 个文件：\n  " + REQUIRED.join("\n  ")
  );
}

export { REQUIRED as REQUIRED_FIXTURES };
export { LOCAL_FIXTURES as LOCAL_DIR, SHARED_FIXTURES as SHARED_DIR };

export function listFixtures(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".html")).sort() : [];
}
