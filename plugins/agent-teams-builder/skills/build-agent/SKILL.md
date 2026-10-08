---
name: build-agent
description: 建立或修改 VIXO Agent。使用者說建立或修改 Agent、建立員工、修改小幫手，或要求將目前 Session／Workflow 轉成可重用 Agent 時使用；已連線裝置儲存到雲端，未連線則維持本地。
---

# 建立與修改 Agent

把目前 Session 中已完成、可重複的流程整理為 Agent 定義、完整 SOP 與可執行資源。資料不足時不得猜測；這是保存工作方法，不是訓練或匯出模型權重。

1. 呼叫 `cloud_status` 確认來源。已連線時 Supabase 是正式來源，查詢與修改都使用該身分可存取的雲端版本；連線失敗不能自行改寫本地同名員工。未連線時保留原本本地流程。
2. 從目前 Session 擷取實際執行或由使用者明確描述的流程、輸入、工具、判斷點、例外與完成條件。不要把未成功的嘗試寫成已驗證 SOP。
3. 整理中文顯示名稱、用途與英文 kebab-case 識別名稱。若只有中文名稱，提出英文名稱並列入完整預覽，讓使用者在同一次 Double Check 確認。
4. 一個 Agent 可有多個 Skills。每個 Skill 都有 triggers、SOP steps、allowedTools 與 successCriteria。將跨 Skill 的順序整理為 `workflows`，以 `skill`、`tool`、`manual`、`approval` 節點表達流程；依使用者定義的核准點使用 `approval`／`requiresApproval`，沿用目前宿主對外部操作的授權規則。
5. 不保存密碼、API Key、Session Cookie、付款資料或秘密。雲端共享套件排除私人 memory、對話、執行 journal、影片與輸出；執行時所需資料以輸入或環境需求描述。附加程式與文件使用可攜相對路徑，列出平台、工具及固定版本依賴。
6. 修改前呼叫 `agent_get`，保留未被要求變更的內容與原有 Workflows。雲端 Agent 使用 `cloud:<asset-id>` 避免同名混淆；`agent_preview` 傳入 `cloudAssetId` 與讀取時的 `expectedRevision`，建立團隊資產時傳入目標 `workspaceId`。不要將雲端清單的 `cloud:` 參照當成英文 spec.id。
7. 呼叫 `agent_preview`，完整展示名稱、用途、系統提示詞、每個 Skill 的 SOP、Workflow 節點、附加資源、依賴與儲存空間。預覽不代表已發布。
8. 明確詢問一次 Double Check，例如：「以上是完整 SOP 與發布位置，是否確認儲存這個版本？」
9. 只有在使用者後續訊息明確確認該預覽後，才呼叫 `agent_commit`，把確認原文放入 `userConfirmation`。沉默或含糊回覆不算確認；不得繞過 preview token 或直接寫檔。
10. 遇到雲端 revision 衝突，保留修改並讀取目前版本，比較後重新預覽；不得悄悄用最新 revision 覆蓋。回復舊內容同樣發布新版本，保留歷史。
11. 完成後回報實際位置、雲端資產 ID／revision 或本地資料夾、Skills 與 Workflows。用讀取工具確認已儲存；Dashboard 會在更新後顯示。

若需求是把既有本地員工或其中一項 Skill／Workflow 分享到雲端，使用 `cloud_preview_publish` → 展示完整內容 → 使用者明確確認 → `agent_commit`；沿用同一次內容確認，不另加不必要的核准流程。

使用者要求連接雲端時，呼叫 `dashboard_open`，引導至「雲端同步」的 VIXO 帳號密碼表單；不要在對話或 Agent 定義中索取、保存密碼。新使用者可自行註冊，帳號一律待審核，Kevin 核准後才能建立、修改、分享或執行雲端資產；註冊／登入成功不代表已核准，不以舊快取跳過核准檢查。原本已連線但未設定帳號的裝置選「設定帳號密碼」，沿用目前 UUID 與 Agent，不另註冊。團隊邀請配對仍需帳號核准；忘記密碼請聯絡管理員，不宣稱已提供寄信重設。Codex／Claude 宿主登入與 VIXO 雲端登入是分開的狀態。

共享套件下載後由本地宿主執行。它不攜帶外部 OAuth、ERP 登入或其他人的操作權限。既有 VIXO 共用影片判斷與 `erp-video-automation` 路由仍適用，不需為每位員工增加私人同名 Skill。
