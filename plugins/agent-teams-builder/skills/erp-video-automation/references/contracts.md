# 輸入契約與执行

## 常用命令

使用本機 Python 3.10+；表單與 gate 僅標準函式庫，影格抽取另需工具依賴。

```text
python dispatch.py list --library <自動化資料庫>
python dispatch.py resolve --library <自動化資料庫> --key "Key收據"
python dispatch.py schema --library <自動化資料庫> --key "Key收據"
python dispatch.py validate --library <自動化資料庫> --key "Key收據" --input <本次資料.json>
python dispatch.py run --library <自動化資料庫> --key "Key收據" --input <本次資料.json> --run-id <固定本次ID>
python dispatch.py form --library <自動化資料庫> --key "Key收據"
```

Windows Codex Python 通常在 `%USERPROFILE%/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`，不存在就用環境的 workspace dependencies 找出 runtime。命令只傳路徑和結構參數，不把備註或帳號拼成 shell code。

`input.html` 是離線表單，下載 JSON，不自動呼叫 ERP。`validate` 及資料不全的 `run` 回傳 `ERP_touched:false` 和全部錯誤。`run_id` 由助理在資料完整後建立，同次重試保留，並對應 `runs/<run_id>.json`；不可刪除 journal 或換 ID 避開重複檢查。

## 每個影片／流程的檔案

| 檔案 | 內容 |
|---|---|
| source.json | 來源檔案、SHA256、片長、時間區間；不是執行指令 |
| workflow.md | 逐段時間、實際按鈕、欄位、跳窗、成功與錯誤跡象、未確定事項 |
| automation.json | id、title、tags、intent_pattern、action、status、entrypoint、验证范围 |
| input.schema.json | 欄位名稱、型別、必填、允許空白、選項、格式與跨欄位規則 |
| input.template.json | 空白待填資料；null 不可直接執行 |
| input.html | 依相同 schema 產生的完整輸入表單 |
| run.py | 驗證後才呼叫的獨立執行器；直接執行也須再次做相同 gate |
| media/ | 必要影格／接觸表；不要把客戶影像混入共用技能發佈包 |

`status` 使用 `draft`、`needs_calibration` 或 `ready`。只有 `ready` 可進入執行器；不可用單純編譯成功或單元測試通過宣稱 ERP 功能已實測。

## 契約格式（自訂 contract_version:1，不冒稱完整 JSON Schema）

`fields` 每個項目包含 `name`（巢狀用 detail.amount）、`label`、`type`（string/date/integer/number）、`required`、`help`。選用 `allow_empty`、`enum`、`pattern`、`pattern_message`、`minimum`、`exclusive_minimum`、`decimals`。未知欄位拒絕；null 不當成已確定的空白；布林值不能當數字。

日期值必須 YYYY-MM-DD 且合法；自然語言「9/1 到 9/30」缺年份時詢問，除非本次已明確確定年份。日期區間要指定依據：單據日、請款日或付款日，起日不可晚於迄日。

`rules` 支援 `{"kind":"date_order","start":"start_date","end":"end_date"}`。表單是便利工具，後端 gate 才是正式驗證；新增其他型別或規則時一起擴充驗證器及測試，不默默略過。

固定商業範圍需寫入 `fixed_behavior` 並在表單／說明顯示，例如只支援 NTD、轉帳、員工、單筆收據。系統號碼等寫入 `system_generated`、結果寫入 `outputs`，不混進使用者必填欄。

## 現有收據契約

必須確定：執行方式（save/prepare）、公司、單別、單據日、請款日、申請人、對象、預期部門、廠別、幣別、匯率、銀行行號、帳號、付款日、付款條件、兌現日、備註、憑證張數、費用代號、摘要、金額、憑證類別、收據號碼與專案。付款條件與兌現日可明確留空；現有流程僅支援無收據號碼。完整 schema 是唯一欄位依據。

資料可透過對話提供，不需要使用者填寫內部欄位名稱。助理可從明確授權設定補固定值，但須讓使用者能核對採用值，不能偷偷複製歷史銀行或日期。

## 搬移與備份

VIXO Plugin 隨附 `erp-video-automation` 及相依的 `expense-claim-helper`，兩個目錄必須放在同一 `skills/` 下；也可獨立安裝到新設備 `$CODEX_HOME/skills`（預設 ~/.codex/skills）。把自動化資料庫放到指定工作目錄並用 --library 指向它，不在 Plugin 更新目錄保存實際資料。

收據 adapter 優先使用明確指定的 `ERP_SKILLS_ROOT`，其次尋找流程所在目錄上方的同一套技能，再找 `$CODEX_HOME/skills` 或 `~/.codex/skills`。從 Plugin 範本複製資料庫到另一個位置後，將 `ERP_SKILLS_ROOT` 設為本次載入的 Plugin `skills/` 絕對路徑；不要指向員工的私有技能目錄或混用不同版本的配套技能。

新設備先確認 Python、Pillow、繁中 OCR 與 ERP 版本；實際畫面檢查只在本次輸入完整後進行。來源文件的 2026-09-10 實測只描述原環境，本次共用封裝的離線測試不代表新設備 ERP 已驗證。

共用技能包只含程式／文件／空表單。原影片、來源絕對路徑、真實 JSON、runs 和銀行資料另行保管，不混入發佈包。
