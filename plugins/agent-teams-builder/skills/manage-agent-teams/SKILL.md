---
name: manage-agent-teams
description: 管理登入後的 VIXO 本地／雲端合併資料庫，查看 Agent／Skill／Workflow、同步佇列與衝突，註冊／審核、匯入舊本地內容、私人／團隊分享、換裝置與相容性說明。
---

# Agent Teams 管理與雲端同步

你好，我是 Agent Builder 插件。你可以完成一段 Workflow 後說「建立 Agent 小美，用途是查詢航班」，或說「調用小美幫我查曼谷到新加坡的班機」。

- 先呼叫 `cloud_status`。v1.12 先登入再使用資料庫；`agent_list`／`agent_get` 合併本人本地草稿與授權雲端 Agent，使用 `local:<uuid>`／`cloud:<asset-id>` 區別來源與同名項目。`cloud_list` 查看本地／雲端合併的 Agent／Skill／Workflow。
- 登入不會自動取得 `Downloads/Agent Teams` 的舊檔案。升級快照中的候選 UUID 必須再與本次 Auth 驗證一致；未歸屬檔案先由使用者明確確認匯入。原本地 SOP 保持不變，其他帳號不能看到本人本地草稿與佇列。
- 開啟視覺管理頁：呼叫 `dashboard_open`。在「雲端同步」用 VIXO 帳號密碼登入；請使用者直接填表單，不在對話或工具參數中索取密碼。帳號為 3–32 個字元、英文起頭，只接受小寫英文字母、數字、`_` 與 `-`；密碼至少 12 個字元，UTF-8 編碼最多 72 bytes。
- 新使用者可在網站或「雲端同步」自行註冊，填寫自訂帳號、密碼與顯示名稱。帳號先待審核，Kevin 核准後才可使用雲端資產與團隊功能；一般使用者不能自行指定管理員或核准狀態。註冊／登入成功不代表已核准，完全離線或舊快取不能越過審核。
- 既有已連線裝置尚未設定帳號：在「雲端同步」選「設定帳號密碼」。沿用目前 UUID、私人 Agent、版本與團隊權限，不另外建立空白帳號。進階團隊邀請配對仍保留，但新身分仍須 Kevin 核准；bootstrap 由專案管理者建立，客戶端不能自行提升權限。
- 自己換裝置：可直接以 VIXO 帳號密碼登入；使用者要求時也可呼叫 `cloud_create_device_code`。這是相同身分的一次性 10 分鐘換機碼，會取得同一份私人內容與團隊權限，只交給該使用者自己的裝置。
- 分享給同仁：呼叫 `cloud_create_workspace` 建立團隊；owner 使用 `cloud_create_invite`，角色選 `viewer`（使用／複製）或 `editor`（另可更新團隊版本）。同仁透過邀請碼加入自己的身分；不能以換機碼代替團隊邀請。將碼交給使用者自行分享，不自動聯絡其他人。
- 建立／修改 Agent：切換到 `build-agent`，走 `agent_preview` → 完整 SOP → Double Check → `agent_commit`；獨立 Skill／Workflow 使用 `library_preview`／`library_commit`。確認後預設僅保存本機（`syncMode: local-only`），回報 `saved-local`。使用者明確要求雲端同步時才在預覽帶 `syncMode: cloud`，並展示分享範圍；不能把 `queued` 回覆說成雲端已儲存。
- 已保存的本機草稿需先展示完整內容與私人／團隊範圍，再依使用者明確確認呼叫 `library_enable_sync`，傳入 id、目前 bundleHash（expectedHash）、localHash（expectedLocalHash）與確認原文。不得因使用者按「立即同步」就將所有僅存本機資料加入上傳。
- 以 `library_sync` 手動同步已開啟同步的項目；外掛每 180 秒嘗試同步。衝突先比較兩份完整內容，再以 `library_resolve` 選採用遠端／另存副本，傳入目前 bundleHash（`expectedHash`）／遠端 revision（`remoteRevision`），同步器另核對本地 localHash。不得強制覆寫或遺棄衝突稿。
- 明確分享：選私人或團隊目的地，展示完整 SOP、檔案、依賴、流程與分享範圍後確認。舊本地內容可使用 `cloud_preview_publish`／`agent_commit`；原檔案不修改。團隊更新須當下 editor／owner 權限，私人同步不等於團隊共享。
- 執行：切換到 `run-agent`。本地 Skill／Workflow 可用穩定本地 ID 交給 `agent_prepare_run`／`workflow_prepare_run`；已有雲端資產 ID 時可用 `cloud_prepare_run`。必須在目前宿主實際執行回傳的 `prepared.prompt`。
- 雲端管理頁可檢視完整內容、下載／匯入 JSON、複製到自己或團隊空間，以及預覽舊版後新增回復版本。私人記憶、對話、執行資料與憑證不包含在共享套件。

介面的「公用 Skills」顯示已安裝的 GitHub 技能與版本，可閱讀完整內容或取得目前宿主的使用提示。ERP 影片使用 `erp-video-automation`，配套為 `vixo-video-intake` 與 `expense-claim-helper`；不需另存成個人雲端資產。

GitHub 管理插件原始碼與公用 Skill 發布；Supabase 管理已同步資產、權限及 revision，本地保存本人草稿、持久佇列與程式快取。換機只能取得已同步內容，不轉移外部登入、ERP 權限或模型權重。執行、續跑、排程須線上查核帳號核准及資產／membership；完全離線只保存草稿，不自行啟用離線執行。

插件使用目前已登入的 Codex 或 Claude Code，不另外要求模型 API Key。安裝器以 `codex login status` 或 `claude auth status --json` 檢查宿主登入；這與 VIXO 裝置連線是不同狀態。

忘記 VIXO 密碼請聯絡管理員。仍已連線的自己的裝置可產生換機碼連接新裝置，但這不是重設密碼。無須 M365、SMTP 或電子郵件驗證；不要宣稱已提供寄信或自助重設功能。

不要刪除 Agent 或歷史版本；本版沒有提供資產刪除工具。
