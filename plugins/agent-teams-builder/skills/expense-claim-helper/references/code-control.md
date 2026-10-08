# 程式控制及驗證範圍

## 執行方式

執行 `scripts/erp_native.py`，不必把程式碼載入模型上下文。程式透過 Windows 控制項、滑鼠及鍵盤操作 ERP，沒有連資料庫或繞過 ERP 驗證。表頭用 `WM_GETTEXT` 讀回，輸入用標準剪貼簿貼上及按鍵，因此會使用系統剪貼簿。

需求：Windows 桌面、Python 3.10 以上；明細及截圖需 Pillow，明細辨識需 Windows 本機繁體中文 OCR。ERP 已登入並開啟正確公司的 PCMI10。執行時保持 ERP 在前景，避免同時人工操作鍵盤滑鼠。

`Invoke-ErpClaim.ps1` 優先找使用者的 Codex Python runtime，再找一般 Python，也可用 `-PythonPath` 指定。缺 runtime 時由 Codex 的 workspace dependencies 工具定位。OCR 在本機執行，不上傳圖像到辨識服務。

PowerShell 範例：

```powershell
$erpSkill = '本次載入的 expense-claim-helper 技能目錄絕對路徑'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$erpSkill\scripts\Invoke-ErpClaim.ps1" -Command inspect -Company '實際公司全名'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$erpSkill\scripts\Invoke-ErpClaim.ps1" -Command validate -RequestFile '.\request.json'
```

`-ExecutionPolicy Bypass` 只作用於該次 PowerShell 程序，不改永久設定。若組織策略禁止執行，依組織允許的方式處理，勿改安全策略。

VIXO 共用技能位於 Plugin 的 `skills/` 內，路徑以本次宿主載入的技能為準，不假定一定在 `.codex/skills`。獨立安裝時才使用 `$CODEX_HOME/skills/expense-claim-helper`（未設定 CODEX_HOME 時使用使用者家目錄下 `.codex/skills/expense-claim-helper`）。

新增預填（會開一張新單，不能拿既有單當測試重跑）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$erpSkill\scripts\Invoke-ErpClaim.ps1" -Command create -RequestFile '.\request.json'
```

已授權新增及儲存時，預設使用一次執行、最後模型核對：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$erpSkill\scripts\Invoke-ErpClaim.ps1" -Command create -RequestFile '.\request.json' -Save -ReviewAtEnd
```

此命令自行驗證輸入及即時狀態，不必在正常新單前另外執行 validate 或 inspect。完成後短 JSON 包含實際單號、表頭、journal 路徑及兩張圖：`header.png` 和 `details.png`。模型最後一次查看兩圖並比對本次 JSON，再報告成功。`awaiting_model_review` 不等於 `verified`。

直接執行 Python 的命令：

```text
python erp_native.py create --request request.json --save --review-at-end --journal-dir erp-runs
python erp_native.py review --request request.json --number "本次已儲存單號" --journal-dir erp-runs
python erp_native.py query --company "實際公司全名" --document-type I502 --number "本次ERP產生的單號"
python erp_native.py dialogs --company "實際公司全名"
python erp_native.py probe-grid --company "實際公司全名"
python erp_native.py snapshot --company "實際公司全名" --out current.png
```

`query` 只接受瀏覽狀態，也可接續已開啟的標準 `TQBEForm`。程式檢查兩個條件都是 `=`，輸入單別、單號後按確定，最長等 45 秒查回指定號碼；沒查到就回錯誤。

`review` 是唯讀業務操作：精確查回、核對表頭及產圖；只調整版面，不新增或儲存，不改既有 journal。適合重新擷取畫面或測試最後核對。若有未儲存草稿會停止保留資料。

## 輸入 JSON

可先複製 `assets/request.template.json` 到工作區再填寫。空白範本不能通過驗證，不會直接拿來建立單據。

以下是格式示例，須用本次資料替換，不能直接送入實際請款：

```json
{
  "request_id": "unique-business-request-id",
  "company": "實際公司全名",
  "document_type": "I502",
  "document_date": "2026-09-10",
  "claim_date": "2026-09-10",
  "applicant": "本次申請人代碼",
  "department": "已核對的部門代碼",
  "counterparty": "本次對象代碼",
  "bank_code": "001",
  "bank_account": "本次銀行帳號",
  "payment_condition": "",
  "payment_date": "2026-09-30",
  "cash_date": "",
  "note": "本次表頭備註",
  "receipt_count": 1,
  "factory": "1",
  "currency": "NTD",
  "rate": "1",
  "detail": {
    "expense_code": "已核對的費用代號",
    "summary": "本次摘要",
    "amount": 1235,
    "voucher": "receipt",
    "project": "本次專案代號",
    "receipt_number": ""
  }
}
```

`payment_condition`、`cash_date` 必須明確填值或 `""`，不能省略／null 後保留未知帶入值。`factory`、`currency`、`rate` 也須先明確設定。部門、日期、專案與憑證張數使用本次資料或已確認設定，缺欄先問清楚，不先操作 ERP。`detail.receipt_number` 目前僅支援明確空字串；非空號碼需另行校準。費用名稱及會計科目由 ERP 帶出。

同一業務請求重試保留原 `request_id`。journal 已存在時，程式在新增之前拒絕再次執行；不要刪紀錄或換 ID 避開。已預填後要儲存，先核對該張未儲存單並接續；再次 `create` 不是 resume。

## 視窗及表格處理

- 每次動作前檢查前景視窗、ERP 程序身分、遮擋與可用狀態。
- `EnumWindows` 發現掛在隱藏 `TApplication` 下的對話框，也處理同一 HWND 隱藏後再次開啟。
- 查詢窗依 `TQBEForm`、兩個 `TDBEdit`、等號條件及「確定」按鈕定位。其他類別先用 `dialogs` 或 Computer Use 校準，不猜錯誤窗的按鈕。
- `TcxControlPopupScrollBar` 及提示框不視為業務對話框。明細水平捲軸是自繪或 popup，不能假設 `GetScrollInfo` 可讀。
- 以實際控制項尺寸校正縮放，不保存舊 HWND 或絕對螢幕座標；仍依賴該 ERP 版本的版面，換電腦先跑 `inspect`、`probe-grid`。
- 明細不公開 UIA 值。程式展開表格，用本機 OCR 找欄名，確認編輯器後才輸入並原生讀回。每次 Tab 都重新辨識欄名及焦點。
- 最後模型核對模式：儲存前原生讀回五個明細值；儲存後表頭用原生值核對，明細只以本機 OCR 定位欄名並擷取原始畫面，模型檢查數值。長摘要截斷、圖像模糊或欄位不符需補查，不能猜測。未加 `--review-at-end` 的舊模式仍使用嚴格明細 OCR，可能因字形誤識停止。

## 2026-09-10 驗證紀錄

以下是來源文件對原 Windows 環境的歷史紀錄，未在本次 VIXO 共用封裝或新设备獨立複驗。共用封裝的離線測試不能作為 ERP 實單完成證據。

| 功能 | 狀態 |
|---|---|
| 主視窗、公司與縮放辨識 | 已實測；ERP 回報 96 DPI、實際 150%，以控制項高度校正 |
| 原生讀取單號、申請人、付款日、銀行、合計 | 已實測成功 |
| 查詢窗輸入、按確定、查回已存在單據 | 已實測成功；內容存於工作區，未打包 |
| 查不到指定單號時停止 | 已實測 |
| 展開明細、向左捲動、辨識費用代號等欄名 | 已實測 |
| 明細值 OCR | 能讀取，但曾把數字 0 識別成 Q；嚴格比對不符就停止，仍需校準 |
| 完整新增、明細輸入、儲存及查回 | 2026-09-10 已完成單一 create 命令執行新實單；儲存、精確查回及模型最後核對成功 |
| 一次查回及產生兩張模型核對圖 | 已在既有已存單據實測成功；表頭、費用摘要、金額、收據及專案均清楚可核對，測試沒有新增或儲存 |
| 離線測試 | 14 項通過；包含單次儲存後等待模型檢查、產圖失敗保留已存單、明細不符禁止儲存、重試不重送、必填與未知欄位 gate |

原 Computer Use 流程保留於 `manual-workflow.md`；其歷史實際操作紀錄不代表新程式完成同等驗證。

## 成本與故障處理

正常一個命令內完成多次 UI 動作，只輸出短 JSON，最後模型一次檢查兩張圖。固定等待、原生讀回、局部 OCR 都在本機，沒有每步模型截圖呼叫。不要每 5 秒輪詢或每欄重新叫模型；等待程序時可用 30–60 秒的工具等待並適時簡短報進度。尚未量測新整合模式的 Token 用量，不承諾降低百分比。

失敗先看 `error`、journal `stage` 和實際 ERP。已點儲存就先查原單號。未知窗用 `dialogs`；需要看畫面再用 `snapshot` 或 Computer Use，不為省 Token 略過核對。

換電腦攜帶整個技能資料夾。不要打包 `erp-runs`、請款 JSON、真實單據截圖或銀行帳號。`scripts/test_erp_native.py` 完全離線，不操作 ERP；`probe-grid` 會改變版面與水平位置，但不輸入或儲存單據。


## 實單校準補充

2026-09-10 已用程式分階段完成一筆員工收據請款並精確查回。過程未重開第二張待填單；最終原生表頭及儲存後的明細畫面核對一致。真實資料及核對截圖只保留工作區，未包入技能。

- 新增狀態的合計面板會啟用，不能以 disabled 當定位條件；改用 10 個直接 TFDBEdit 子項辨識。
- 下拉選單先點箭頭展開，再 Home、方向鍵及 Enter。
- F2 是查找視窗，不是編輯捷徑。明細先選取儲存格，再點一次開啟編輯器；必須確認編輯器父項矩形涵蓋所選欄位，不能只看焦點是 Edit。
- TfrmF2Window 可能沒有 owner；以主作業被停用、相同程序及啟用中的額外視窗辨識。
- 憑證類別的欄名 OCR 曾把「證」讀成其他字，欄名定位允許「憑?類別」這個已核實的結構；實際欄位值仍須精確讀回「3.收據」，不對金額或代碼做模糊替換。
- 喚回前景後等待子控制項恢復，避免瞬間漏列明細表。
