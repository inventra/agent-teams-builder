# ERP 視窗與輸入故障處理

## 先判斷問題

- 已開 ERP 不代表 Computer Use 已列出可控制視窗。先查工具回傳清單、畫面、標題與當前焦點，勿直接歸因「螢幕權限不足」。
- 舊設備曾有 MainMenu 的外層 TApplication 為 0×0；真正主視窗為可見的 DSC_Conductor_MainMenu.UnicodeClass。程序存在不等於已取得畫面。
- 視窗被其他程式遮住或擷取內容不符時，啟用目標後重取畫面。不要依錯誤截圖點擊。
- PCMI10 未最大化且部分在螢幕外時曾有點擊偏移；透過 `Alt_L+space` 開系統選單，觀察後按 `x` 最大化，再擷取最新畫面定位。
- 明細表消失可能只是面板高度為零。拖曳費用資料與明細表的分隔線使明細可見；回頭核對表頭備註時可再調整。不要為此重開或取消有資料的單據。
- UIA focused_element 有時落後畫面一拍；以最新可見游標及再一次擷取確認。`set_value` 在此版本曾報 CacheRequest 錯誤，改用可見欄位點選及鍵盤。

## 隱藏於工具清單的 owned 對話窗

查詢條件對話窗原生標題曾是 **DSForm**，畫面標題為「設定查詢條件」，類別 TQBEForm，屬 LeaderWorkCenter。應從 `list_windows` 取得該對話窗並單獨操作。對父視窗送出輸入曾導致焦點錯誤。

本技能附 [../scripts/Repair-ErpWindow.ps1](../scripts/Repair-ErpWindow.ps1)，為既有已驗證的視窗相容性修復工具。它只讀取或切換目標視窗 WS_EX_APPWINDOW 位元，讓被清單篩選的 owned 視窗可被列出；不提供滑鼠鍵盤輸入、不更改 ERP 資料或 Windows 安全權限。只在當前環境允許本機修復、已確認目標，且此故障確實出現時使用，不作為每次新增的必要步驟。

使用 Windows PowerShell 64-bit / .NET Framework。以下 `<...>` 必須換成本次實際絕對路徑：

```powershell
& '<技能資料夾>\scripts\Repair-ErpWindow.ps1' -Mode Inspect -ProcessName LeaderWorkCenter -WindowTitle 'DSForm' -StatePath '<本次工作目錄>\erp-dialog-backup.json'
```

Inspect 確認匹配唯一可見對話窗後，必要時以同參數 `-Mode Enable` 修復，備份檔應是未使用過的本次路徑。腳本拒絕多個同名程序、非唯一視窗、已有備份檔。遇到此類拒絕先重新辨認，不擴大匹配或猜測。

Enable 後重新呼叫 `list_windows`，**只能用工具實際回傳的視窗物件**取得與控制目標，不能直接塞入腳本找到的 HWND。已驗證 DSForm style 從 0x10101 變為 0x50101 後即可列出、填值及點按。

需要回復時，以同參數 `-Mode Restore` 讀原備份。程序 PID、啟動時間及 HWND 不符時腳本會拒絕過期還原；重開 ERP 後不要套用舊備份。預設 MainMenu 模式僅匹配 DSC_Conductor_MainMenu 類別，需按實際問題選用。曾測試主視窗已是 APPWINDOW，因此該次主視窗 Enable 沒有改動，不能聲稱此操作解決所有主視窗問題。

如果執行政策或環境限制阻擋腳本，遵守當前工具及環境要求，不擅自關閉安全設定。只有在目前規則允許且已審閱腳本時，才可在已允許的 PowerShell 中使用相同程式碼；若仍不允許，回報確切限制。

## 換電腦

複製整個 expense-claim-helper 資料夾至新設備 `$CODEX_HOME/skills`，未設定時使用使用者家目錄下 `.codex/skills`。新設備需有可用 Cosmos ERP、公司連線及 Windows Computer Use；技能不會安裝 ERP 或自動取得權限。重新發現視窗與欄位，不攜帶備份 JSON、舊 HWND 或固定座標。若只需擷取主畫面且已安裝 open-erp-screen，可使用該技能；其唯讀擷取成功不代表填單控制已修復。
