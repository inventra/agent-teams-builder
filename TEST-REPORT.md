# VIXO Agent Teams Builder 1.6.2 測試報告

測試日期：2026-09-24（Asia/Taipei）

## v1.6.2 已通過

- 修正 `ChatGPT.app` 或 `Codex.app` 已經開啟、但沒有帶 CDP 啟動參數時，Bridge 過早回退成 `codex-browser-panel` 的問題；現在會啟動受管理的桌面 Renderer，再注入 `VIXO Agents` 側欄。
- macOS 同時支援系統與使用者 Applications 內的 `ChatGPT.app`、`Codex.app`，兩者並存時優先選擇正在執行的 App；Windows 保留 ChatGPT／Codex 雙套件偵測。
- 新增雙 App 候選排序與「已開啟但無 CDP 仍啟動 Bridge」測試。
- 目前共 36 個自動化測試，35 通過，1 個需 live Codex CDP 的環境測試標記 skip。

## v1.6.1 已通過

- Claude Code 2.1.270 已登入，`agent-teams-builder@agent-teams-local` v1.6.0 安裝且啟用；全新 Claude Code Session 實際載入 3 個 Skills、連上本機 MCP，並成功呼叫一次 `agent_list`，回傳 `execution host=Claude Code, agents=2`。
- 一鍵安裝器現在即使 GitHub 版本相同或暫時離線，也會重新檢查登入、修復每個已偵測且相容的 Codex／Claude Code Plugin 註冊，再用兩邊的 `plugin list --json` 讀回驗證安裝與啟用狀態。
- 新增同版重跑修復測試；目前共 34 個自動化測試，33 通過，1 個需 live Codex CDP 的環境測試標記 skip。
- Claude Code strict validator 通過；Codex 與 Claude Code 現機修復及讀回驗證均通過。

## v1.6.0 已通過

- 33 個自動化測試包含安裝、登入、安全更新、Dashboard 更新提示、固定更新執行器、更新後快取失效、MCP、Double Check、秘密掃描、多 Skill、Workflow 與 Dashboard。
- Dashboard 啟動時與手動按鈕可檢查 GitHub `main`；遠端 commit 不同時顯示新版版本、立即更新按鈕與更新中／成功／失敗狀態。
- 頁面更新只會執行安裝於 `下載/Agent Teams/.system/updater/install.mjs` 的固定更新器，不接受任意 repo、URL 或執行檔路徑。
- 更新沿用固定 commit SHA、50 MB 上限、archive SHA-256、安裝後 SHA 讀回證明與失敗保留上一版機制；成功時整包替換 Plugin、Dashboard、Skills 與執行功能並重新啟動。
- 發行包內含 `release-metadata.json`，第一次安裝即記錄來源 commit，避免安裝後誤判同一版為新版。
- 實機首次按頁面更新時，更新器安全失敗並保留舊版；定位為安裝階段的一次性 `SKIP_UPDATE` 被背景服務繼承。已在 Dashboard、獨立 runner 與子更新器三層清除／覆寫該旗標，並納入後續實機重測。
- 修正後的頁面更新實機重測通過：Dashboard 從 commit `5597442054f9` 偵測到 `4d4c630f5a5a`，API 回傳 202 後由獨立 runner 完成更新；狀態為 `succeeded`，Codex 與 Claude Code 均安裝成功，Runtime Doctor 通過，Dashboard 與 Codex sidebar Bridge 重新啟動且 `frameLoaded=true`。
- 更新後再次查詢，安裝版本為 `1.6.0+codex.20260923192303-4d4c630f5a5a`，本機與 GitHub 完整 commit SHA 相同，`available=false`，證明不會反覆提示同一版。
- Windows CI log 複查發現：EXE 安裝成功，但傳統 Windows PowerShell 5 會錯誤解碼無 BOM 的中文 `.ps1` 訊息；已將 PowerShell 備援入口改為 ASCII 訊息，並在 CI 加上非零 exit code 強制失敗檢查，避免假通過。
- 嚴格檢查進一步發現 Windows 第二次執行安裝器時，背景 Dashboard 仍占用已安裝的 `node.exe`，導致 Runtime 取代出現 `EPERM`。安裝順序已改為先使用既有 Runtime 停止 Dashboard／Bridge，再替換 Runtime 與 Plugin。

## v1.6.0 已知邊界

- v1.5.0 與更舊版本的頁面沒有「立即更新」按鈕，必須先用 v1.6.0 安裝包更新一次；之後才能完全從頁面更新。
- GitHub 無法連線時，頁面會保留目前版本並顯示檢查失敗；不會以舊檔覆蓋。
- Windows EXE 與 macOS App 尚未簽章，Gatekeeper 或 SmartScreen 可能顯示安全確認。

## v1.5.0 歷史驗證

- 30 個自動化測試包含安裝、登入、自動更新、MCP、Double Check、秘密掃描、多 Skill、Workflow 與 Dashboard。
- Codex 原生 Play 實機驗證：選擇專案後建立新 Session，任務內容成功執行，並從 `thread-project-assignments` 讀回與選擇專案相同的 Project ID。
- Dashboard 將原生 Session ID 保存於執行紀錄，可用「在 Codex 開啟」回到該任務；偽造或尚未成立的 client thread ID 會被拒絕。
- Workflow 執行狀態可區分 `waiting-input`、`waiting-approval`、`completed`、`failed` 與 `rejected`。
- 手動核准模式實測：到達 Approval 節點後暫停，Dashboard 呼叫 approve API，沿用原 Codex Session 完成後續節點。
- 自動核准模式實測：Workflow 內建 Approval 不再暫停，但宿主工具權限仍保留。
- Codex 側欄實機穩定性檢查：Dashi Taskboard 與 VIXO Agents 順序固定，1.5 秒內 0 次換位。
- 發行包含 macOS arm64、macOS Intel、Windows x64 的 Node.js Runtime，macOS `.app` / `.command` 與 Windows `.exe` / `.cmd` / PowerShell 入口。
- Codex Plugin validator：通過。
- Claude Code `plugin validate --strict --json`：通過，0 errors、0 warnings。

### v1.5.0 已知邊界

- Codex 正式 Plugin manifest 仍沒有自訂左側頁面欄位；本版側欄是桌面 CDP/DOM Bridge，不是官方側欄 API，並有原生瀏覽器面板回退。
- 排程由 Dashboard 背景服務觸發；電腦關機或服務停止時不會補跑。
- 自動核准是「單次執行」或「單筆排程」設定，不會改變 Agent 永久安全規則，也不繞過 Codex／Claude Code 的工具權限。
- 舊版已結束且沒有記錄 Session ID 的 `waiting-approval` 紀錄無法原地續跑，需從新版 Play 重新啟動。
- Codex 原生 Play 的進度、工具核准與最終輸出在新建的 Codex 任務內查看；Dashboard 只顯示「已建立 Codex 任務」與開啟按鈕。
- 背景 Play 會載入使用者現有 Codex/Claude Code 設定與工具；其他外掛的登入錯誤可能出現在 run log，但本次真實 Play 仍完成。
- macOS App 與 Windows EXE 未簽章；Gatekeeper 或 SmartScreen 可能顯示安全確認。

## v1.4.0 歷史驗證

- 28 個自動化測試、Workflow 手動／自動核准、Codex 側欄與 Taskboard 共存穩定性檢查通過。

## v1.3.0 歷史驗證

- 23 個自動化測試、雙宿主實機安裝、Dashboard Play 真實 Codex E2E 與 macOS/Windows GitHub Actions 均通過。
- GitHub Actions 紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35765604515>。

## v1.2.0 歷史驗證

### 已通過

- 20 個自動化測試：原有安裝、登入、MCP、Double Check、秘密掃描、多 Skill 與目前宿主路由，以及新增的固定 commit archive 下載、cachebuster、同版不重裝、斷網不降版、更新成功 SHA 證明、路徑別名與跨平台含中文檔名 ZIP 解壓。
- `claude plugin validate --strict`：通過，0 errors、0 warnings。
- Codex Plugin validator：通過。
- GitHub Actions `macos-latest` 與 `windows-latest`：兩邊均安裝真實 Codex／Claude Code CLI、執行 20 個測試、驗證 manifest，並執行對應一鍵安裝器。通過紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35638367720>。
- macOS arm64 實機 GitHub 更新：從公開 `main` 取得 commit `e1951ee394d8318873fc6f8ebce60186ce26f38c`，下載固定 SHA archive，Codex 與 Claude Code 均從 1.1.0 更新到 `1.2.0+codex.20260921182617-e1951ee394d8`。
- 更新狀態讀回：`.system/update-state.json` 的 repository、branch、完整 commit SHA、commit date、archive SHA-256、動態安裝版本與完成時間均存在，且與本次下載相符。
- 再次點擊同一安裝檔：回報已是 `e1951ee394d8`，不重新安裝。
- Runtime Doctor：MCP SDK 載入成功，執行模式為 `current-host`，不需要模型 API Key。

### 實機測試中發現並修正

- macOS 內建 `unzip` 遇 GitHub archive 中文檔名曾回報 `Illegal byte sequence`；已改用 macOS 原生 `ditto -x -k`，並新增中文檔名 archive 測試。
- macOS 暫存路徑可能同時表示為 `/var/...` 與 `/private/var/...`，曾使下載後子安裝器的主程式判斷提前退出；已改用 realpath 比較。
- 更新器現在不以子程序 exit 0 單獨判定成功，必須再讀回 `.system/update-state.json` 且完整 commit SHA 相符才算完成。
- GitHub commit 查詢使用 no-cache 與 cache-bust query，避免 push 後短時間讀到舊 SHA。

### 安全與失敗邊界

- 更新來源固定為公開 `inventra/agent-teams-builder` 的 `main`，不接受使用者輸入任意 repo、URL 或本機安裝路徑。
- 只接受 GitHub 回傳的 40 位十六進位 commit SHA，下載 URL 固定為該 SHA 的 archive；archive 上限 50 MB，下載內容另記錄 SHA-256。
- 只有兩個宿主的實際安裝與 Runtime Doctor 都成功，才更新成功狀態並移除上一版備份。
- GitHub 暫時無法連線且已有成功狀態時，保留目前版本並停止，不會讓舊 ZIP 覆蓋新版；第一次安裝則允許使用 ZIP 內附版本。
- OAuth 瀏覽器頁面仍由使用者親自輸入帳密；外掛不讀取、保存或傳送帳號密碼。
- Agent 只由目前 Codex／Claude Code Session 執行，不使用 Anthropic API、OpenAI API 或獨立 Agent SDK。
- v1.1.0 沒有更新器；既有使用者需要先下載 v1.2.0 一次，之後才可持續點擊同一份檔案更新。
