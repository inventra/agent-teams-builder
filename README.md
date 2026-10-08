# Agent Teams Builder

把 Claude Code 或 Codex Session 裡完成過的流程整理成 Agent。連接雲端後，以 Supabase 儲存的版本為準，支援換裝置同步、團隊分享 Agent／Skill／Workflow、衝突保留與版本回復；執行仍由目前的 Codex／Claude 宿主完成。

## v1.10.0：帳號密碼登入與雲端同步

在外掛 Dashboard 按「雲端同步」，用 VIXO 帳號密碼登入。原本已連線的裝置先選「設定帳號密碼」，會綁定原有身分並保留 Agent、版本與團隊權限。帳號為英文起頭的 3–32 個字元，只接受小寫英文字母、數字、`_` 與 `-`；密碼至少 12 個字元。

目前沒有公開註冊。同仁第一次使用，先以團隊邀請碼配對，再設定自己的帳號；自己的換機碼保留在進階連線入口，不能代替同仁邀請碼。忘記密碼請聯絡管理員；不要求 M365 或 SMTP，尚未提供寄信重設密碼。既有員工可完整預覽後上傳；連線後新增或修改 Agent 直接儲存雲端，並保留完整 SOP 確認流程。

[雲端管理中心](https://inventra.github.io/agent-teams-builder/) · [使用與管理說明](docs/CLOUD-AGENT-TEAMS.md)

## 一鍵安裝

請從 [GitHub Releases](https://github.com/inventra/agent-teams-builder/releases/latest) 下載 `Agent-Teams-Builder-v1.10.0.zip`，解壓縮後：

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

## v1.8.0：影片自動判斷與 ERP 程式碼產生

VIXO Agent 收到影片後，會先閱讀實際影格與相關說明，判斷是否與 ERP 操作有關。若與 ERP 有關，就自動調用共用 `erp-video-automation`，將錄影流程產出成自動化程式碼、完整輸入契約、空白範本與離線表單；使用者不需先說出技能名稱。一般 Agent、Workflow、Dashboard Play／排程及續跑任務共用這個規則；直接在宿主對話附影片時，`vixo-video-intake` 提供自動技能入口。

Plugin 同時隨附相依技能 `expense-claim-helper`（Windows Cosmos ERP 收據請款）。更新 VIXO 後開新 Session 即可載入；共用路由不會改写個別員工的 SOP。影片無法讀取或操作證據不足時，會列出待補資料；未校準流程不標成可執行。範例資料庫、使用方式、Windows 需求與尚未校準的日期區間查詢，請見 [ERP 共用技能說明](docs/ERP-VIDEO-AUTOMATION.md)。

## v1.7.0：Docs 工作台

VIXO 預設開啟新的 Docs 工作台，保留原本的員工總覽及每位員工入口：

- 經典首頁九張預設卡片與像素辦公室，共用實際 Agent、Skills、Workflows 與執行紀錄。
- 今天／本週／本月統計讀取完整紀錄，不只計最近 30 筆；原生 Codex 任務建立不會被計為完成。
- 卡片新增、排序、縮放、換色，明暗主題與常用流程偏好持久保存；圖示使用本機 SVG。
- 從首頁或像素員工詳情啟動 Play／每日排程，查看結果、補資料、核准／拒絕及開啟 Codex 任務。
- 修復新式側欄定位、document-start 圖示遺失、重掛 iframe 空白頁、舊 bridge 停止等待及前端版本快取問題。
- 企業信件、行事曆、ERP／BI 等來源尚未串接時明確顯示「未串接」，不使用示範數字。員工清單來自使用者自己的資料，不附送範例員工。

使用指南與完整後續範圍見 [Docs 工作台說明](docs/VIXO-DOCS-WORKBENCH.md) 與 [173 節點功能對照表](docs/VIXO-Docs-功能對照表.md)。LazyOffice 的員工、Plugin、偏好與「小懶」規則仍屬另一套系統。

安裝完會自動開啟 Dashboard。之後可雙擊 `下載/Agent Teams/Open VIXO Agents.command` (macOS) 或 `Open VIXO Agents.cmd` (Windows)，也可在 Session 中說「開啟 VIXO Agents Dashboard」。

安裝後開啟新 Session，可以說：

> 把目前流程建立成 Agent 小美，用途是查詢航班。

或：

> 調用小美幫我查曼谷到新加坡的班機。

## 相容性說明

安裝器會偵測 Claude Desktop、ChatGPT Desktop 與 Codex App，但正式的本機 Plugin 安裝介面是 Claude Code Plugin 管理器與 Codex CLI Marketplace。桌面應用程式若沒有對應 CLI，不會被回報成安裝成功。公開 ChatGPT Plugin Directory 上架另需 HTTPS MCP 服務與官方審核。

Codex／Claude 的宿主登入由官方命令與瀏覽器頁面處理，Plugin 不會讀取或保存宿主帳號密碼。VIXO 雲端帳號密碼則由專用表單送交驗證服務；本地只保存 session，不保存密碼，也不將密碼加入 Agent、SOP 或共享套件。

Codex 正式 Plugin API 目前未提供「自訂左側頁面」manifest 欄位。桌面 Bridge 同時支援 `/Applications/ChatGPT.app`（內含 Codex 的統一桌面程式）與 `/Applications/Codex.app`。它會優先連接已有 CDP 的主畫面；若 App 已開啟但沒有 CDP，會啟動受管理的桌面視窗後加入 `VIXO Agents` 側欄。只有兩種 App 都無法建立安全 Renderer 時，才回退至 Codex 原生瀏覽器面板。這是桌面相容層，不是官方 manifest 提供的側欄 API。

詳情請看 [安裝說明](README-安裝說明.md) 與 [測試報告](TEST-REPORT.md)。

## 驗證狀態

- v1.8.0 本機 Node 回歸 71 通過、0 失敗、1 個 live Codex CDP 測試 skip；ERP 工具另有 43 項離線測試通過。新影片規則涵蓋普通 Agent、Workflow、舊紀錄續跑與搬移後的公用技能尋址；沒有以本次結果宣稱新影片模型端到端實跑或 ERP 實單已驗證。
- v1.7.0 本機程式回歸 58 通過、0 失敗、1 個需 live Codex CDP 的環境測試 skip。
- 隔離瀏覽器另驗證工作台 9 組、图示 4 組、嵌入生命週期 3 組與雙側欄點擊 7 組；不是 Codex App 實機端到端證據。最新桌面重載仍需使用者確認。
- Claude Code strict validator 與 Codex Plugin validator 通過。
- macOS arm64 實機雙宿主安裝通過。
- GitHub Actions 的 `macos-latest` 與 `windows-latest` 均使用真實 Claude Code／Codex CLI 完成安裝驗證。
- MCP stdio 握手、宿主登入分支、Double Check、防路徑穿越、秘密掃描、多 Skill 與版本封存流程通過。

完整限制與尚需使用者憑證的測試項目請見 [測試報告](TEST-REPORT.md)。

## License

MIT
