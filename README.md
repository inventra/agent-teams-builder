# Agent Teams Builder

把 Claude Code 或 Codex Session 裡完成過的流程，整理成可重複使用、可持續修改的本機 Agent。Agent 會儲存在使用者的 `下載/Agent Teams`，每個 Agent 使用獨立的英文資料夾，並可擁有多個 Skills。

## 一鍵安裝

請從 [GitHub Releases](https://github.com/inventra/agent-teams-builder/releases/latest) 下載 `Agent-Teams-Builder-v1.6.1.zip`，解壓縮後：

- macOS：雙擊 `Install Agent Teams Builder.app` 或 `install.command`；若首次被系統阻擋，請右鍵選「打開」。
- Windows：雙擊 `Install-Agent-Builder.exe`；也可執行 `.cmd` 或 PowerShell 版。

壓縮包內建 macOS arm64、macOS Intel 與 Windows x64 的 Node.js Runtime，使用者不需要另外安裝 Node.js。電腦仍需要至少一個宿主：Claude Code 2.1.265 以上或 Codex CLI 0.148.0 以上。安裝器會自動偵測、安裝到所有可用宿主，並在未登入時啟動官方瀏覽器登入流程。

## 頁面提示與一鍵自動更新

從 v1.6.0 起，VIXO Agents 頁面啟動時會檢查公開 GitHub repo 的 `main`，開啟期間每 15 分鐘重新確認。發現新版時會顯示更新提示，按下「立即更新」即可同步更新 Plugin、Dashboard、Skills 與執行功能，完成後會自動重新啟動。頁面右上角也可隨時按「檢查更新」。

`install.command`、`Install-Agent-Builder.cmd` 與 `Install-Agent-Builder.ps1` 仍同時是安裝器與更新器。每次點擊也會檢查 `main`：

- 有新 commit：下載該固定 commit 的 ZIP，更新本機 Marketplace，並讓 Claude Code／Codex 重新安裝最新版。
- 沒有新 commit：保留目前檔案，但仍重新檢查登入、修復 Codex 與 Claude Code 的 Plugin 註冊，並從兩邊的 Plugin 清單讀回確認「已安裝且啟用」。
- GitHub 暫時無法連線：已安裝的電腦保留目前版本，不會被舊 ZIP 降版；第一次安裝則可使用 ZIP 內附版本。

因此日後只要把 Skill 或程式碼 push 到 `main`，學員可直接在 VIXO Agents 頁面更新，也能再次點擊手上的同一份安裝檔，不需要另外下載每次的 Release。更新紀錄會寫入 `下載/Agent Teams/.system/update-state.json`，包含 commit SHA、安裝版本與下載檔 SHA-256。v1.5.0 與更舊版本尚未包含頁面更新按鈕，既有使用者需要先安裝 v1.6.0 一次。

## 可以做什麼

- 從目前 Session 濃縮 Workflow 與 SOP，建立具中文名稱／暱稱的 Agent。
- 修改既有 Agent，新增或更新多個 Skills。
- 建立或修改前先顯示預覽，只有後續明確確認才會寫入。
- 在新 Session 中依名稱調用 Agent，準備對應 Skill 的執行內容。
- 只使用目前 Session 的宿主執行：Codex 裡由 Codex 執行，Claude Code 裡由 Claude Code 執行。
- 不使用 Anthropic API、OpenAI API 或獨立 Agent SDK 呼叫。
- 保存 `agent.json`、`AGENT.md`、`MEMORY.md`、Skills 與版本歷程。
- 每位員工可建立多個 Workflows，寫入 `workflows/<workflow-id>/`，並以 Skill、Tool、Manual、Approval 節點呈現。
- VIXO Agents Dashboard 即時顯示員工、Skills 與 Workflow 節點，提供 Play、執行紀錄與每日排程。
- 在 Codex 內按 Play 可先選擇專案；外掛會在該專案建立一個真正的 Codex Session，立即顯示於左側專案清單並在任務頁內執行。
- Play 可選擇「遇核准節點暫停」或「本次自動核准」；等待資料與等待核准會分開顯示，並可在 Dashboard 原 Session 續跑。
- Codex 仍可改選「背景 CLI 執行」；Claude Code 與排程使用已登入的宿主 CLI，不另外調用模型 API。

安裝完會自動開啟 Dashboard。之後可雙擊 `下載/Agent Teams/Open VIXO Agents.command` (macOS) 或 `Open VIXO Agents.cmd` (Windows)，也可在 Session 中說「開啟 VIXO Agents Dashboard」。

安裝後開啟新 Session，可以說：

> 把目前流程建立成 Agent 小美，用途是查詢航班。

或：

> 調用小美幫我查曼谷到新加坡的班機。

## 相容性說明

安裝器會偵測 Claude Desktop、ChatGPT Desktop 與 Codex App，但正式的本機 Plugin 安裝介面是 Claude Code Plugin 管理器與 Codex CLI Marketplace。桌面應用程式若沒有對應 CLI，不會被回報成安裝成功。公開 ChatGPT Plugin Directory 上架另需 HTTPS MCP 服務與官方審核。

登入時只會啟動宿主官方登入命令與瀏覽器頁面。Plugin 不會讀取、保存或傳送使用者的帳號密碼。

Codex 正式 Plugin API 目前未提供「自訂左側頁面」manifest 欄位。v1.6.0 延續 Dashi Taskboard 的桌面 Bridge 做法，在可用的 Codex CDP Renderer 中加入 `VIXO Agents` 側欄頁面，並使用 Codex 原生專案路由建立任務；若當前環境無法安全注入，會回退至 Codex 原生瀏覽器面板。這是桌面相容層，不是官方 manifest 提供的側欄 API。

詳情請看 [安裝說明](README-安裝說明.md) 與 [測試報告](TEST-REPORT.md)。

## 驗證狀態

- 34 個自動化測試：33 通過，1 個需 live Codex CDP 的環境測試標記 skip；另有 Codex 側欄實機穩定性檢查通過。
- Claude Code strict validator 與 Codex Plugin validator 通過。
- macOS arm64 實機雙宿主安裝通過。
- GitHub Actions 的 `macos-latest` 與 `windows-latest` 均使用真實 Claude Code／Codex CLI 完成安裝驗證。
- MCP stdio 握手、宿主登入分支、Double Check、防路徑穿越、秘密掃描、多 Skill 與版本封存流程通過。

完整限制與尚需使用者憑證的測試項目請見 [測試報告](TEST-REPORT.md)。

## License

MIT
