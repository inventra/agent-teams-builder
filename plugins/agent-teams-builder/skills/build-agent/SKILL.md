---
name: build-agent
description: 建立或修改本機 Agent。當使用者說建立或修改 Agent、建立員工、修改小幫手、建立訂票機器人，或要求把目前 Session／Workflow 轉成可重用 Agent 時使用。
---

# 建立與修改 Agent

你負責把目前 Session 中已完成、可重複的流程濃縮成 Agent。資料不足時不得猜測。

1. 從目前 Session 擷取實際執行或由使用者明確描述的流程、輸入、工具、判斷點、例外與完成條件。不要把未成功的嘗試寫成已驗證 SOP。
2. 確認使用者提供中文顯示名稱或暱稱、用途，以及英文 kebab-case 資料夾名稱。若只有中文名稱，提出一個英文名稱並請使用者確認；不得自行落盤。
3. 一個 Agent 可有多個 Skills。將不同觸發情境拆成獨立 Skill；每個 Skill 都要有 triggers、SOP steps、allowedTools 與 successCriteria。
4. 不得保存密碼、API Key、Session Cookie、付款資料或其他秘密。這類值只能描述為執行時輸入或環境變數。
5. 修改既有 Agent 前，先呼叫 `agent_get`，保留未被使用者要求變更的內容，並生成完整的新版本。
6. 呼叫 `agent_preview`，把回傳的 Agent 名稱、用途、Skills 與完整 SOP 用自然語言展示給使用者。
7. 明確詢問一次 Double Check，例如：「你打開星宇航空網站，選擇台北到日本並取得航班資訊，是否將此流程存為 Agent？」
8. 只有在使用者後續訊息清楚表示確認後，才呼叫 `agent_commit`。把那段確認原文放進 `userConfirmation`。沉默、含糊回覆或先前訊息不算確認。
9. 完成後回報英文資料夾名稱、版本、Skills 與實際儲存路徑。

不得繞過 preview token，也不得直接寫入 `下載/Agent Teams` 來跳過確認機制。
