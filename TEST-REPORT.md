# Agent Teams Builder 1.0.4 測試報告

測試日期：2026-09-22（Asia/Taipei）

## 已通過

- 12 個自動化測試：安裝器版本比較、雙宿主安裝、Claude 更新流程、MCP stdio 握手、一次性新手引導、建立／修改／多 Skill 路由、移除 Skill 封存、路徑穿越阻擋、秘密掃描、Double Check 強制、SDK mock 與無憑證拒絕。
- `claude plugin validate --strict`：通過，0 errors、0 warnings。
- Codex Plugin validator：通過。
- macOS arm64 實機一鍵安裝：Node v22.23.2、Codex CLI 0.148.0、Claude Code 2.1.270；兩個宿主均安裝並啟用 1.0.4。
- Codex 真實新 Session：模型成功呼叫 `agent_list` MCP 工具，取得 `Downloads/Agent Teams` 與 0 個 Agent。
- Runtime Doctor：Claude Agent SDK 0.2.141、MCP SDK 1.30.0 載入成功。

## 外部條件與邊界

- 本機沒有 `ANTHROPIC_API_KEY`，所以沒有付費執行真實 Agent SDK 模型呼叫；已驗證 SDK 套件載入、mock 執行與「不得借用 claude.ai 訂閱」的拒絕路徑。
- Claude Code 的本機 OAuth 已過期，因此模型對話 E2E 回傳 `Failed to authenticate: OAuth session expired and could not be refreshed`；Plugin 本身在 `claude plugin list` 顯示 1.0.4、enabled，manifest、Skills、Hook 與 MCP 組件可載入。
- GitHub Actions `windows-latest` 與 `macos-latest` 均已通過：兩邊都安裝真實 Codex／Claude Code CLI、驗證 manifest，並執行對應的一鍵安裝器。通過紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35631439874>。
- ChatGPT Desktop 與 Claude Desktop 沒有提供等同本機 CLI Marketplace 的無互動安裝介面；安裝器只會使用官方支援的 Codex CLI 與 Claude Code Plugin 管理器，並清楚報告桌面應用程式偵測結果。
