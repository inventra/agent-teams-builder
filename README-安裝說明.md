# Agent Teams Builder 一鍵安裝

## 安裝

壓縮包已內建 Node.js Runtime，不需要預先安裝 Node.js。電腦需已安裝至少一個支援的宿主：Claude Code 2.1.265 以上或 Codex CLI 0.148.0 以上。

- macOS：解壓縮後，雙擊 `Install Agent Teams Builder.app` 或 `install.command`。如果 macOS 第一次阻擋，請按右鍵選「打開」。
- Windows：解壓縮後，雙擊 `Install-Agent-Builder.exe`。也可使用 `.cmd` 或 PowerShell 版。

安裝器會：

1. 查詢 GitHub `main` 的最新 commit；若有更新，下載該固定 commit 的公開 ZIP。
2. 選擇壓縮包內對應 macOS arm64、macOS Intel 或 Windows x64 的 Node.js Runtime，再檢查 Claude Code、Codex CLI、Claude Desktop、ChatGPT Desktop 與 Codex App。
3. 建立 `下載/Agent Teams`。
4. 把 Plugin 與 Runtime 安裝到 `下載/Agent Teams/.system/marketplace`。
5. 若同時找到 Claude Code 與 Codex CLI，兩邊都安裝；只找到其中一個，就安裝到該環境。
6. 檢查宿主登入狀態。Codex 使用 `codex login status`；Claude Code 使用 `claude auth status --json`。
7. 若尚未登入，執行 `codex login` 或 `claude auth login --claudeai`，開啟官方瀏覽器頁面讓使用者自行登入。Plugin 不讀取或保存帳號密碼。
8. 只有登入完成且 Runtime Doctor 通過才會更新成功紀錄。
9. 產生 `下載/Agent Teams/installation-report.json` 與 `.system/update-state.json`，記錄版本、commit SHA、下載檔 SHA-256、登入、安裝與 Doctor 結果。
10. 啟動只監聽本機的 VIXO Agents Dashboard，並建立 `Open VIXO Agents.command` 與 `Open VIXO Agents.cmd`。
11. Codex 有可用的本機 CDP Renderer 時，在側欄顯示 `VIXO Agents`；否則回退至 Codex 原生瀏覽器面板。

## 更新

從 v1.6.0 起，VIXO Agents 頁面啟動時會檢查 GitHub `main`，開啟期間每 15 分鐘重新確認。老師把 Skill 或程式碼 push 後，學員會在頁面看到新版提示，按「立即更新」即可同步 Plugin、Dashboard、Skills 與功能。頁面右上角也能手動按「檢查更新」。

原本的一鍵安裝檔也仍是更新器：再次雙擊就會自動檢查、下載並安裝最新版。若沒有更新則不重裝；若 GitHub 暫時無法連線，已安裝版本會原封不動保留，避免舊 ZIP 覆蓋新版本。

安全邊界：更新來源固定為公開 repo `inventra/agent-teams-builder`，只下載 GitHub 回傳的 40 位 commit SHA 對應 archive，限制 50 MB，並記錄本機下載內容的 SHA-256。v1.5.0 與更舊版本尚未包含頁面更新按鈕，所以既有使用者必須先安裝 v1.6.0 一次；之後即可直接從頁面更新。

安裝後請開新的 Session，說：「列出我的 Agent Teams」或「把目前流程建立成 Agent 小美，用途是查詢航班」。

## 重要相容性邊界

- Claude Desktop 應用程式本身與 Claude Code Plugin 是不同介面。本安裝器會偵測 Claude Desktop，但本機 Plugin 的正式安裝目標是 Claude Code CLI。
- ChatGPT Desktop／Codex 共用公開 Plugin 目錄，但本機 Marketplace 的自動安裝需要 Codex CLI；只有 ChatGPT Desktop、沒有 Codex CLI 時，安裝器會清楚報告未安裝，不會假裝成功。
- Agent 永遠在目前宿主執行：Codex Session 由 Codex 執行，Claude Code Session 由 Claude Code 執行。本 Plugin 不使用 Anthropic API、OpenAI API 或獨立 Agent SDK。
- Dashboard Play/排程使用已登入的 Codex 或 Claude Code CLI。手動模式可在等待輸入或核准後續跑同一個 Session；自動核准只適用於 Workflow 內建節點，不繞過宿主安全權限。Dashboard 必須保持執行，排程才會如期觸發。
- Codex 正式 Plugin manifest 目前無法宣告自訂左側頁面。側欄是參考 Dashi Taskboard 的桌面 CDP/DOM Bridge；若不可用，會自動回退至原生瀏覽器面板。
- macOS App 與 Windows EXE 目前為未簽章發行檔，Gatekeeper 或 SmartScreen 可能要求使用者確認。
- 本機 stdio MCP 適用 Claude Code 與 Codex。要公開提交到 ChatGPT Plugin Directory，MCP Server 需另行部署成穩定的 HTTPS 服務並完成官方審核；這個 ZIP 不會假裝已完成公開上架。

## 使用範例

- 「建立 Agent 小美，用途是查詢航班，把剛剛星宇航空的操作整理成 SOP。」
- 「修改小美，新增中華航空查詢技能。」
- 「調用小美幫我查曼谷到新加坡的班機。」
- 「列出每個 Agent 目前有哪些 Skills。」
- 「替小美新增一個每日航班查詢 Workflow。」
- 「開啟 VIXO Agents Dashboard。」

建立／修改一定會先顯示預覽並請你 Double Check。只有你後續明確確認，才會寫入 Agent 資料夾。
