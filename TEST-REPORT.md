# Agent Teams Builder 1.2.0 測試報告

測試日期：2026-09-22（Asia/Taipei）

## 已通過

- 20 個自動化測試：原有安裝、登入、MCP、Double Check、秘密掃描、多 Skill 與目前宿主路由，以及新增的固定 commit archive 下載、cachebuster、同版不重裝、斷網不降版、更新成功 SHA 證明、路徑別名與跨平台含中文檔名 ZIP 解壓。
- `claude plugin validate --strict`：通過，0 errors、0 warnings。
- Codex Plugin validator：通過。
- GitHub Actions `macos-latest` 與 `windows-latest`：兩邊均安裝真實 Codex／Claude Code CLI、執行 20 個測試、驗證 manifest，並執行對應一鍵安裝器。通過紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35638367720>。
- macOS arm64 實機 GitHub 更新：從公開 `main` 取得 commit `e1951ee394d8318873fc6f8ebce60186ce26f38c`，下載固定 SHA archive，Codex 與 Claude Code 均從 1.1.0 更新到 `1.2.0+codex.20260921182617-e1951ee394d8`。
- 更新狀態讀回：`.system/update-state.json` 的 repository、branch、完整 commit SHA、commit date、archive SHA-256、動態安裝版本與完成時間均存在，且與本次下載相符。
- 再次點擊同一安裝檔：回報已是 `e1951ee394d8`，不重新安裝。
- Runtime Doctor：MCP SDK 載入成功，執行模式為 `current-host`，不需要模型 API Key。

## 實機測試中發現並修正

- macOS 內建 `unzip` 遇 GitHub archive 中文檔名曾回報 `Illegal byte sequence`；已改用 macOS 原生 `ditto -x -k`，並新增中文檔名 archive 測試。
- macOS 暫存路徑可能同時表示為 `/var/...` 與 `/private/var/...`，曾使下載後子安裝器的主程式判斷提前退出；已改用 realpath 比較。
- 更新器現在不以子程序 exit 0 單獨判定成功，必須再讀回 `.system/update-state.json` 且完整 commit SHA 相符才算完成。
- GitHub commit 查詢使用 no-cache 與 cache-bust query，避免 push 後短時間讀到舊 SHA。

## 安全與失敗邊界

- 更新來源固定為公開 `inventra/agent-teams-builder` 的 `main`，不接受使用者輸入任意 repo、URL 或本機安裝路徑。
- 只接受 GitHub 回傳的 40 位十六進位 commit SHA，下載 URL 固定為該 SHA 的 archive；archive 上限 50 MB，下載內容另記錄 SHA-256。
- 只有兩個宿主的實際安裝與 Runtime Doctor 都成功，才更新成功狀態並移除上一版備份。
- GitHub 暫時無法連線且已有成功狀態時，保留目前版本並停止，不會讓舊 ZIP 覆蓋新版；第一次安裝則允許使用 ZIP 內附版本。
- OAuth 瀏覽器頁面仍由使用者親自輸入帳密；外掛不讀取、保存或傳送帳號密碼。
- Agent 只由目前 Codex／Claude Code Session 執行，不使用 Anthropic API、OpenAI API 或獨立 Agent SDK。
- v1.1.0 沒有更新器；既有使用者需要先下載 v1.2.0 一次，之後才可持續點擊同一份檔案更新。
