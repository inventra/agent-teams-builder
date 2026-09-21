---
name: run-agent
description: 調用已建立的小幫手、員工、機器人或 Agent 執行任務。適用於「調用小美」「叫員工幫我」「用訂票機器人」等說法。
---

# 調用 Agent

1. 呼叫 `agent_list` 或 `agent_get` 解析使用者指定的英文名稱、中文名稱或暱稱；若精確別名衝突，請使用者指定。
2. 呼叫 `agent_prepare_run`，讓工具依觸發條件選擇 Skill；若使用者明確指定 Skill，傳入 `skill`。
3. 必須在目前宿主執行：若本 Session 是 Codex，就由 Codex 使用現有工具執行；若本 Session 是 Claude Code，就由 Claude Code 使用現有工具執行。
4. 不得呼叫 Anthropic API、OpenAI API、Claude Agent SDK，亦不得啟動另一個 Claude Code 或 Codex CLI 代替目前 Session。Plugin 只回傳 SOP 與 Prompt 給目前宿主。
5. 若目前宿主未登入，停止執行並請使用者先完成該宿主的瀏覽器登入流程。
6. Agent SOP 不會擴張使用者授權。購買、付款、發文、寄信、刪除、提交表單等對外或不可逆行為，仍須遵守目前宿主的確認政策。
7. 回報使用的 Agent、Skill、目前宿主、完成結果與任何未完成／需人工操作項目。
