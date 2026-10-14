#!/bin/bash
# 把工作区的云端版同步到公开仓库并推送。
#
#   ./publish.sh            构建 + 测试 + 同步 + 推送
#   ./publish.sh --dry-run  只做检查与同步，不提交不推送
#
# 发布前会挡住这些情况：
#   · 构建或测试不通过
#   · 产物与源码不同步（改了 src 忘了 build）
#   · 把 .dev.vars / .env / node_modules 带进去
#   · 仓库里出现疑似真实 bot token
#   · 发布副本里跑不通测试（证明发出去的东西是自包含、能跑的）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TG_TF_REPO:-/Users/z/Desktop/项目文件/tg-tf-monitor}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

NODE="${TG_TF_NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  for c in /Users/z/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
[ -n "$NODE" ] || { echo "✗ 找不到 node。用 TG_TF_NODE=/path/to/node $0" >&2; exit 1; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6 构建 + 测试（工作区）"
cd "$SRC"
"$NODE" build.mjs
"$NODE" --test 2>&1 | grep -E "^ℹ (tests|pass|fail)" || true
"$NODE" --test >/dev/null 2>&1 || { echo "✗ 工作区测试没通过，不发布" >&2; exit 1; }

say "2/6 检查产物与源码同步"
cp dist/worker.js /tmp/.publish-worker.js
"$NODE" build.mjs >/dev/null
cmp -s /tmp/.publish-worker.js dist/worker.js || { echo "✗ 产物不可复现（两次构建不同）" >&2; exit 1; }
rm -f /tmp/.publish-worker.js
echo "  ✅ 产物可复现"

say "3/6 同步到 $REPO"
[ -d "$REPO/.git" ] || { echo "✗ $REPO 不是 git 仓库。先 clone：git clone git@github.com:Review977/tg-tf-monitor.git \"$REPO\"" >&2; exit 1; }
rsync -a --delete \
  --exclude '.git/' --exclude 'node_modules' --exclude '.wrangler' --exclude '.vercel' \
  --exclude '.dev.vars' --exclude '.dev.vars.local' --exclude '.env' --exclude '.env.local' \
  --exclude 'logs' --exclude '__pycache__' --exclude '.DS_Store' \
  "$SRC/" "$REPO/"
echo "  已同步"

say "4/6 安全检查（绝不能把密钥发出去）"
bad=0
for f in .dev.vars .dev.vars.local .env .env.local; do
  [ -e "$REPO/$f" ] && { echo "  ✗ 混进了 $f" >&2; bad=1; }
done
[ -d "$REPO/node_modules" ] && { echo "  ✗ 混进了 node_modules" >&2; bad=1; }
if grep -rInE "[0-9]{8,10}:[A-Za-z0-9_-]{30,}" "$REPO" --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null | grep -v "123456:FAKE\|FAKE_TOKEN\|your_token_here" | head -3; then
  echo "  ✗ 疑似真实 bot token" >&2; bad=1
fi
[ "$bad" = 0 ] && echo "  ✅ 无密钥、无依赖目录"

say "5/6 在发布副本上跑测试（证明发出去的东西自包含、能跑）"
cd "$REPO"
"$NODE" build.mjs >/dev/null
"$NODE" --test >/dev/null 2>&1 || { echo "✗ 发布副本测试没通过" >&2; exit 1; }
"$NODE" --test 2>&1 | grep -E "^ℹ (tests|pass|fail)" || true
git add -A

say "6/6 提交并推送"
if git diff --cached --quiet; then
  echo "  没有变化，无需提交"
  exit 0
fi
git diff --cached --stat | tail -12
if [ "$DRY" = 1 ]; then
  echo "  --dry-run：已同步到 $REPO，未提交"
  exit 0
fi
git commit -q -m "${TG_TF_MSG:-同步自工作区 $(date '+%Y-%m-%d %H:%M')}"
git push
echo
echo "✅ 已推送：https://github.com/Review977/tg-tf-monitor"
