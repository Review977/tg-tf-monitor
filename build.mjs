/**
 * 打包成单文件 dist/worker.js
 *
 *   node build.mjs
 *
 * 为什么要它：Cloudflare 控制台的代码编辑器只吃**单个文件**。
 * 而你的机器上没装 Node，装不了 wrangler —— 所以"控制台粘贴"是主要部署路径，
 * 必须有一个自包含的单文件产物。
 *
 * 做法很朴素（不用打包器）：按依赖顺序把模块拼起来，去掉相对 import 行、
 * 去掉 `export ` 前缀（保留 `export default`，Workers 模块格式需要它）。
 * 因为模块之间没有循环依赖、也没有重复的顶层标识符，这么拼是安全的 ——
 * 而且**每次构建都会真的检查这两点**，撞名就报错，不靠人眼。
 *
 * 产物由 test/handler.test.mjs 实际 import 并跑一遍断言 —— 即"发出去的包我跑过"。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORDER = [
  "src/core.js",
  "src/config.js",
  "src/storage.js",
  "src/runner.js",
  "src/worker.js",
];

const IMPORT_RE = /^import\s[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;

function topLevelNames(src) {
  const names = new Set();
  const re = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

const parts = [];
const owner = new Map();
const dupes = [];
const sources = [];

for (const rel of ORDER) {
  const p = join(HERE, rel);
  if (!existsSync(p)) throw new Error("缺文件：" + rel);
  let src = readFileSync(p, "utf8");

  // 依赖检查：只允许 import 本项目里 ORDER 中的模块
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of imports) {
    if (!spec.startsWith(".")) {
      throw new Error(`${rel} 引用了外部包 ${spec} —— 单文件包不支持依赖，请改成零依赖`);
    }
  }

  for (const n of topLevelNames(src)) {
    if (owner.has(n)) {
      dupes.push(`  ${n}：${owner.get(n)} 与 ${rel} 撞名`);
    } else {
      owner.set(n, rel);
    }
  }

  src = src.replace(IMPORT_RE, "").replace(EXPORT_RE, "");
  sources.push({ rel, src });
}

if (dupes.length) {
  console.error("✗ 顶层标识符撞名，拼单文件不安全：");
  console.error(dupes.join("\n"));
  console.error("  修法：把其中一个改名（加模块前缀），或让 build.mjs 支持作用域包裹。");
  process.exit(1);
}

const srcHash = createHash("sha256").update(sources.map((s) => s.src).join("\n")).digest("hex").slice(0, 16);

const header = `/**
 * tg-tf-monitor-cloud —— 单文件构建产物，请勿直接编辑
 *
 * 由 build.mjs 从以下模块拼成（改了源文件请重跑 node build.mjs）：
${ORDER.map((f) => " *   - " + f).join("\n")}
 *
 * 用法：整个文件贴进 Cloudflare 控制台的 Worker 编辑器即可。
 * 该产物已被 test/handler.test.mjs 实际 import 并跑过断言。
 *
 * 源码指纹（sha256 前 16 位）：${srcHash}
 * ⚠️ 这里刻意**不放构建时间** —— 放了构建就不可复现，
 *    CI 里"产物必须与源码同步"那条检查会永远失败（这是被 CI 抓出来的）。
 */

`;

for (const { rel, src } of sources) {
  parts.push(`// ═══════════ ${rel} ═══════════\n${src.trim()}\n`);
}

const out = header + parts.join("\n");
mkdirSync(join(HERE, "dist"), { recursive: true });
const outPath = join(HERE, "dist", "worker.js");
writeFileSync(outPath, out, "utf8");

// 自检：产物必须能被当成 ESM 解析，且恰好有一个 export default
writeFileSync(join(HERE, "dist", ".verify.mjs"), out, "utf8");
const { execFileSync } = await import("node:child_process");
try {
  execFileSync(process.execPath, ["--check", join(HERE, "dist", ".verify.mjs")], { stdio: "pipe" });
} catch (e) {
  console.error("✗ 产物语法检查失败：");
  console.error(String(e.stderr || e.message));
  process.exit(1);
} finally {
  const { unlinkSync } = await import("node:fs");
  try { unlinkSync(join(HERE, "dist", ".verify.mjs")); } catch { /* ignore */ }
}

const defaults = (out.match(/^export default/gm) || []).length;
if (defaults !== 1) {
  console.error(`✗ 产物里 export default 出现 ${defaults} 次，应恰好 1 次`);
  process.exit(1);
}

console.log("✅ 已生成 dist/worker.js");
console.log(`   大小 ${(out.length / 1024).toFixed(1)} KB，拼接 ${ORDER.length} 个模块，无撞名，语法通过`);
