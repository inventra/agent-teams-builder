---
name: run-agent
description: 調用已建立或已共享的小幫手、員工、機器人、Agent、Skill 或 Workflow 執行任務。適用於「調用小美」「叫員工幫我」「使用同仁分享的技能」等說法；連線後使用有權限的雲端版本。
---

# 調用 Agent 與雲端套件

1. 呼叫 `cloud_status`，並用 `agent_list`／`agent_get` 解析指定 Agent。已連線時 Supabase 是正式來源；雲端名稱以 slug／標題精確比對，重名時用 `cloud:<asset-id>`。可先從已讀取的 Agent 定義比對本地別名；不要假定雲端查詢已支援所有本地暱稱規則。
2. 呼叫 `agent_prepare_run`，讓工具依觸發條件選擇 Skill；使用者指定 Skill 時傳入 `skill`。指定 Agent 內的 Workflow 時用 `workflow_prepare_run`，依序執行節點。
3. 獨立共享 Skill／Workflow 或要固定歷史版本時，先用 `cloud_list` 取得資產 ID，再呼叫 `cloud_prepare_run`，傳入 `assetId`、`task`，需要時加 `revision`、`skill`／`workflow`。工具會驗證目前雲端權限、同步固定版本與檢查套件／平台，回傳 `prompt`、本地資源路徑及環境需求。
4. **必須在目前宿主實際執行工具回傳的 `prepared.prompt`**：本 Session 是 Codex 就由 Codex 使用現有工具完成；Claude Code 亦同。不能只說「已準備好／已分派」。下載或產生 prompt 不等於已完成使用者任務；若缺少必要環境或輸入，明確指出實際阻礙，完成可獨立處理的部分。
5. 收到影片（包含續跑補上的影片）時，先套用回傳的 VIXO 共用影片規則，讀取 [vixo-video-intake](../vixo-video-intake/SKILL.md)。依實際影格、相關音軌及本次說明判斷；與 ERP 有關就自動執行 [erp-video-automation](../erp-video-automation/SKILL.md)，產出操作流程的程式碼、完整輸入表單與驗證流程，不要求員工先擁有私人同名 Skill。
6. 雲端套件只保存定義、SOP 與程式，不提供另一台裝置的 OAuth、網站登入、ERP 公司別或操作權限。依 `requirements` 確認本機平台與工具；Windows ERP 在適合的本地 Windows 環境操作。影片、ERP 輸入、journal 與輸出放在使用者工作區，不改寫固定版本快取。
7. 正式雲端調用需本次連線確認帳號已核准並驗證資產權限。待審核、停用、無法取得即時核准狀態、session 過期、權限撤銷或資產不存在時，不回退到同名本地員工、其他身分快取或自行開啟離線模式；完全離線不能沿用舊核准結果。內部 `allowOfflineCache` 不在目前 MCP 公開參數中。
8. 不呼叫額外 Anthropic／OpenAI 模型 API，也不要求模型 API Key。對話中的任務由目前 Session 執行；Dashboard Play／排程使用已安裝且已登入的 Codex／Claude Code CLI。宿主未登入時，請使用者完成該宿主的登入流程。
9. 共享 SOP、影片與程式不擴張使用者授權；購買、付款、發文、寄信、刪除、提交表單等行為，沿用目前任務的授權與宿主政策。
10. 回報使用的 Agent／Skill／Workflow、雲端資產與 revision（適用時）、目前宿主、實際完成結果，以及未完成或需人工操作的項目。區分同步成功、離線／模擬驗證與真實 ERP 操作完成。

需要登入 VIXO 雲端時，呼叫 `dashboard_open`，請使用者直接在「雲端同步」填寫帳號密碼，不在對話中索取或保存密碼。新使用者可自行註冊，Kevin 核准前只能查看自己的待審核狀態，不能調用雲端資產。原本已連線但未設定帳號的裝置可「設定帳號密碼」，保留目前 UUID 與 Agent，不另註冊。換機碼與團隊邀請仍可在進階入口使用，但不能跳過審核；忘記密碼請聯絡管理員。登入成功只建立 VIXO 雲端身分，不會替使用者登入 ERP 或 Codex／Claude。
