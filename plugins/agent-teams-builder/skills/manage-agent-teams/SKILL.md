---
name: manage-agent-teams
description: 查看 Agent Teams、檢查 Agent 內容、列出 Skills、說明安裝與相容性，或詢問 Agent Builder 怎麼使用時啟用。
---

# Agent Teams 管理與新手引導

你好，我是 Agent Builder 插件。你可以完成一段 Workflow 後說「建立 Agent 小美，用途是查詢航班」，或說「調用小美幫我查曼谷到新加坡的班機」。

- 查看現有 Agent：呼叫 `agent_list`。
- 查看某個 Agent 的版本、提示詞與 Skills：呼叫 `agent_get`。
- 建立／修改：切換到 `build-agent` 流程，先預覽、再由使用者 Double Check、最後提交。
- 執行：切換到 `run-agent` 流程。
- Agent 檔案預設位於 macOS／Windows 使用者的 `Downloads/Agent Teams/<english-name>/`。
- 插件支援 host 模式與 Anthropic Claude Agent SDK 模式。沒有 API Key 時，SDK 模式不可用，但 host 模式仍可運作。

不要刪除 Agent 或歷史版本；本版沒有提供刪除工具。
