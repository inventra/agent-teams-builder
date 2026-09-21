# Agent Teams Builder

把 Claude Code 或 Codex Session 裡完成過的流程，整理成可重複使用、可持續修改的本機 Agent。Agent 會儲存在使用者的 `下載/Agent Teams`，每個 Agent 使用獨立的英文資料夾，並可擁有多個 Skills。

## 一鍵安裝

請從 [GitHub Releases](https://github.com/inventra/agent-teams-builder/releases/latest) 下載 `Agent-Teams-Builder-v1.0.4.zip`，解壓縮後：

- macOS：雙擊 `install.command`；若首次被系統阻擋，請右鍵選「打開」。
- Windows：雙擊 `Install-Agent-Builder.cmd`；也可執行 `Install-Agent-Builder.ps1`。

需求：Node.js 18 以上，以及 Claude Code 2.1.265 以上或 Codex CLI 0.148.0 以上。安裝器會自動偵測可用環境；兩個 CLI 都存在時，會同時安裝並啟用。

## 可以做什麼

- 從目前 Session 濃縮 Workflow 與 SOP，建立具中文名稱／暱稱的 Agent。
- 修改既有 Agent，新增或更新多個 Skills。
- 建立或修改前先顯示預覽，只有後續明確確認才會寫入。
- 在新 Session 中依名稱調用 Agent，準備對應 Skill 的執行內容。
- 使用目前 Session 的工具執行，或在具備 `ANTHROPIC_API_KEY`／官方雲端認證時，透過 Anthropic Claude Agent SDK 獨立執行。
- 保存 `agent.json`、`AGENT.md`、`MEMORY.md`、Skills 與版本歷程。

安裝後開啟新 Session，可以說：

> 把目前流程建立成 Agent 小美，用途是查詢航班。

或：

> 調用小美幫我查曼谷到新加坡的班機。

## 相容性說明

安裝器會偵測 Claude Desktop、ChatGPT Desktop 與 Codex App，但正式的本機 Plugin 安裝介面是 Claude Code Plugin 管理器與 Codex CLI Marketplace。桌面應用程式若沒有對應 CLI，不會被回報成安裝成功。公開 ChatGPT Plugin Directory 上架另需 HTTPS MCP 服務與官方審核。

Anthropic Agent SDK 的獨立模式不能借用 claude.ai 訂閱或登入狀態；沒有 SDK 憑證時，仍可在 Claude Code／Codex 的目前 Session 中使用 Host 模式。

詳情請看 [安裝說明](README-安裝說明.md) 與 [測試報告](TEST-REPORT.md)。

## 驗證狀態

- 12 個自動化測試通過。
- Claude Code strict validator 與 Codex Plugin validator 通過。
- macOS arm64 實機雙宿主安裝通過。
- GitHub Actions 的 `macos-latest` 與 `windows-latest` 均使用真實 Claude Code／Codex CLI 完成安裝驗證。
- MCP stdio 握手、Double Check、防路徑穿越、秘密掃描、多 Skill 與版本封存流程通過。

完整限制與尚需使用者憑證的測試項目請見 [測試報告](TEST-REPORT.md)。

## License

MIT
