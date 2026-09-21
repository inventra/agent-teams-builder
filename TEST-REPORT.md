# Agent Teams Builder 1.1.0 測試報告

測試日期：2026-09-22（Asia/Taipei）

## 已通過

- 13 個自動化測試：安裝器版本比較、已登入雙宿主安裝、Codex／Claude Code 未登入時的登入啟動、登入未完成不得回報成功、Claude 更新流程、MCP stdio 握手、一次性新手引導、建立／修改／多 Skill 路由、移除 Skill 封存、路徑穿越阻擋、秘密掃描、Double Check 強制與目前宿主路由。
- `claude plugin validate --strict`：通過，0 errors、0 warnings。
- Codex Plugin validator：通過。
- macOS arm64 實機一鍵安裝：Node v22.23.2、Codex CLI 0.148.0、Claude Code 2.1.270；兩個宿主均安裝並啟用 1.1.0。
- Codex 真實新 Session：模型成功呼叫 `agent_list` MCP 工具，取得 `Downloads/Agent Teams` 與 0 個 Agent。
- Runtime Doctor：MCP SDK 載入成功，執行模式為 `current-host`，不需要模型 API Key。
- 登入實測：`codex login status` 回報 ChatGPT 已登入；Claude Code 從未登入狀態執行 `claude auth login --claudeai` 後，`claude auth status --json` 回報 `loggedIn: true`、`authMethod: claude.ai`。
- 雙宿主真實 Session：Codex 與 Claude Code 都成功從各自 Session 呼叫同一個 `agent_list` MCP 工具並取得 0 個 Agent；未啟動另一個 CLI 或呼叫模型 API。

## 外部條件與邊界

- 本版已完全移除 Anthropic Claude Agent SDK 與 `ANTHROPIC_API_KEY` 路徑；Agent 只由目前 Codex／Claude Code Session 執行。
- OAuth 瀏覽器頁面需要使用者親自輸入帳密，CI 以跨平台假宿主驗證「狀態檢查 → 啟動登入 → 再次檢查 → 才安裝」控制流程，不會自動填寫或保存真實密碼。
- GitHub Actions `windows-latest` 與 `macos-latest` 均已通過：兩邊都安裝真實 Codex／Claude Code CLI、驗證 manifest，並執行對應的一鍵安裝器。通過紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35633143320>。
- ChatGPT Desktop 與 Claude Desktop 沒有提供等同本機 CLI Marketplace 的無互動安裝介面；安裝器只會使用官方支援的 Codex CLI 與 Claude Code Plugin 管理器，並清楚報告桌面應用程式偵測結果。
