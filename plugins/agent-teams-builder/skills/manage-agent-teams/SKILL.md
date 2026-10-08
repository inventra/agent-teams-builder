---
name: manage-agent-teams
description: 查看 VIXO Agent Teams、檢查 Agent／Skill／Workflow、連接雲端、換裝置同步、發布本地訓練成果或分享給同仁，以及說明安裝與相容性時啟用。
---

# Agent Teams 管理與雲端同步

你好，我是 Agent Builder 插件。你可以完成一段 Workflow 後說「建立 Agent 小美，用途是查詢航班」，或說「調用小美幫我查曼谷到新加坡的班機」。

- 先呼叫 `cloud_status` 確認本裝置來源。已連線時 Supabase 是正式資料來源；`agent_list`／`agent_get` 讀取有權限的雲端 Agent。`cloud_list` 另列出獨立 Skill 與 Workflow。雲端失敗不能自行改讀本地同名員工。
- 未連線的舊安裝仍使用本地 Agent，預設位於使用者 `Downloads/Agent Teams/<english-name>/`。不要將「未連線」與「雲端目前無法連線」混為一談。
- 開啟視覺管理頁：呼叫 `dashboard_open`。在「雲端連線」輸入已取得的換機碼／團隊邀請碼；不要要求使用者另建登入帳號。首台裝置由專案管理者使用管理連線建立短效 bootstrap，客戶端不能自行提升權限。
- 自己換裝置：使用者要求時呼叫 `cloud_create_device_code`。這是相同身分的一次性 10 分鐘換機碼，會取得同一份私人內容與團隊權限，只交給該使用者自己的裝置。
- 分享給同仁：呼叫 `cloud_create_workspace` 建立團隊；owner 使用 `cloud_create_invite`，角色選 `viewer`（使用／複製）或 `editor`（另可更新團隊版本）。同仁透過邀請碼加入自己的身分；不能以換機碼代替團隊邀請。將碼交給使用者自行分享，不自動聯絡其他人。
- 本地內容發布：呼叫 `cloud_preview_publish`，指定 `agent`、`kind`、必要的 `skillId`／`workflowId` 及目標 `workspaceId`。展示完整 SOP、檔案、依賴、流程與分享範圍；使用者明確確認該預覽後，才以 token 與確認原文呼叫 `agent_commit`。
- 建立／修改 Agent：切換到 `build-agent`。已連線時仍走 `agent_preview` → 完整 SOP → Double Check → `agent_commit`，工具會儲存雲端新版本。更新衝突要讀取並比較新版本，不能強制覆蓋。
- 執行：切換到 `run-agent`。`cloud_prepare_run` 可準備獨立 Agent／Skill／Workflow；必須在目前宿主實際執行回傳的 `prepared.prompt`。
- 雲端管理頁可檢視完整內容、下載／匯入 JSON、複製到自己或團隊空間，以及預覽舊版後新增回復版本。私人記憶、對話、執行資料與憑證不包含在共享套件。

GitHub 管理插件原始碼與公用 Skill 發布；Supabase 管理使用者資產、權限及 revision；本地快取讓目前 Codex／Claude 使用本地工具執行。換機不會轉移外部系統登入或 ERP 權限，也不是複製模型權重。正式雲端調用預設需本次連線驗權，不自行啟用離線快取。

插件使用目前已登入的 Codex 或 Claude Code，不另外要求模型 API Key。安裝器以 `codex login status` 或 `claude auth status --json` 檢查宿主登入；這與 VIXO 裝置連線是不同狀態。

不要刪除 Agent 或歷史版本；本版沒有提供資產刪除工具。
