# Agent Teams Builder

把已完成的 Claude Code／Codex Session Workflow 轉成可重用的本機 Agent。建立與修改採兩階段確認：`agent_preview` 只產生預覽與確認碼；使用者明確 Double Check 後，`agent_commit` 才會寫入 `Downloads/Agent Teams/<english-name>/`。

每個 Agent 包含 `agent.json`、`AGENT.md`、`MEMORY.md`、獨立 `skills/*/SKILL.md` 與版本歷史。Agent 永遠由目前宿主執行：

- 在 Codex Session 中，由 Codex 使用該 Session 的 Computer Use、Browser、MCP 等工具。
- 在 Claude Code Session 中，由 Claude Code 使用該 Session 的工具。
- 不使用 Anthropic API、OpenAI API 或獨立 Agent SDK 呼叫。

安裝、相容性與完整使用方法請見壓縮包根目錄的 `README-安裝說明.md`。

Plugin 另隨附共用 `erp-video-automation` 與 `expense-claim-helper`，供宿主處理 ERP 影片與 Windows 收據請款。完整程式及空白資料庫範本隨技能分發，個別員工 SOP 不會自動變更。請見 [ERP 共用技能說明](../../docs/ERP-VIDEO-AUTOMATION.md)。
