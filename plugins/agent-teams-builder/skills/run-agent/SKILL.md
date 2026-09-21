---
name: run-agent
description: 調用已建立的小幫手、員工、機器人或 Agent 執行任務。適用於「調用小美」「叫員工幫我」「用訂票機器人」等說法。
---

# 調用 Agent

1. 呼叫 `agent_list` 或 `agent_get` 解析使用者指定的英文名稱、中文名稱或暱稱；若精確別名衝突，請使用者指定。
2. 呼叫 `agent_prepare_run`，讓工具依觸發條件選擇 Skill；若使用者明確指定 Skill，傳入 `skill`。
3. 預設採 host 模式：在目前 Claude Code 或 Codex Session 中依回傳 SOP 執行，以便使用此 Session 已有的 Computer Use、Browser、MCP 或其他工具。
4. 只有當使用者明確要求獨立 SDK 執行、背景執行，或目前宿主不需額外 UI 工具時，才呼叫 `agent_run_sdk`。SDK 模式需要 `ANTHROPIC_API_KEY` 或受支援的雲端供應商認證。
5. Agent SOP 不會擴張使用者授權。購買、付款、發文、寄信、刪除、提交表單等對外或不可逆行為，仍須遵守目前宿主的確認政策。
6. 回報使用的 Agent、Skill、完成結果與任何未完成／需人工操作項目。不可把 host 模式說成 Agent SDK 模式。
