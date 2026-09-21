# Agent Teams Builder

把已完成的 Claude Code／Codex Session Workflow 轉成可重用的本機 Agent。建立與修改採兩階段確認：`agent_preview` 只產生預覽與確認碼；使用者明確 Double Check 後，`agent_commit` 才會寫入 `Downloads/Agent Teams/<english-name>/`。

每個 Agent 包含 `agent.json`、`AGENT.md`、`MEMORY.md`、獨立 `skills/*/SKILL.md` 與版本歷史。執行分成：

- host：由目前 Claude Code／Codex Session 使用其 Computer Use、Browser、MCP 等工具。
- sdk：透過官方 `@anthropic-ai/claude-agent-sdk` 執行，需要 Anthropic API Key 或官方支援的雲端供應商認證。

安裝、相容性與完整使用方法請見壓縮包根目錄的 `README-安裝說明.md`。
