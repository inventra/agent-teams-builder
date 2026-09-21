#!/bin/bash
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Agent Teams Builder 一鍵安裝／更新程式"
echo "正在檢查 GitHub 更新、Node.js、Claude Code、Codex 與桌面應用程式…"
if ! command -v node >/dev/null 2>&1; then
  echo "安裝失敗：找不到 Node.js 18+。請先安裝 Node.js LTS，再重新點擊此檔案。"
  read -r -p "按 Enter 關閉…" _
  exit 1
fi
node "$SCRIPT_DIR/scripts/install.mjs"
STATUS=$?
if [ -t 0 ]; then
  read -r -p "按 Enter 關閉…" _
fi
exit "$STATUS"
