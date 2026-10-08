# VIXO 共用技能：ERP 影片自動化工坊

這組技能來自「ERP影片自動化工坊.zip」，包含完整指令、程式、參考文件與空白流程表單，並隨 VIXO Agent Teams Builder Plugin 分發。

| 共用 Skill | 用途 |
|---|---|
| [erp-video-automation](../plugins/agent-teams-builder/skills/erp-video-automation/SKILL.md) | 整理 ERP 影片、抽影格、建立輸入契約／表單與獨立流程，依標籤驗證及執行 |
| [expense-claim-helper](../plugins/agent-teams-builder/skills/expense-claim-helper/SKILL.md) | Windows Cosmos ERP PCMI10 單筆員工收據請款、單次儲存、查回及最後畫面核對 |

兩個技能必須一起保留。共用 Plugin Skill 由 Codex／Claude Code 宿主使用，不會自動改寫員工 SOP 或加入每位員工的 Dashboard 技能卡片。需要將流程寫入某位員工時，另依既有的 SOP 預覽與 Double Check 流程處理。

## 更新與使用

在 VIXO Agents 頁面按「檢查更新」與「立即更新」，完成後開新 Session。已有一鍵安裝器的使用者也可再次執行安裝器，它會同步 GitHub `main`。本次新增共用 Skill 不需另外建立員工。

可在對話中說：

> 使用 $erp-video-automation，把這段 ERP 操作影片整理成有標籤、完整輸入表單及驗證流程的自動化。

> 使用 $erp-video-automation，列出我的自動化資料庫目前可用的標籤。

> 使用 $expense-claim-helper，依我提供的完整資料預填收據請款；這次不儲存。

影片、範例與過去的儲存畫面只是來源證據，不構成本次 ERP 操作授權。

## 工作資料庫

既有資料庫繼續使用原位置；不要用範本覆蓋原資料或刪掉執行紀錄。首次使用且沒有既有資料庫時，將 [automation-library](../plugins/agent-teams-builder/skills/erp-video-automation/assets/automation-library/) 複製到自己選定的工作目錄，再告知助理位置。開 `index.html` 可進入表單，所有待補值均為 `null`。

範本包含：

- `Key收據`：原環境校準的單筆 NTD、匯率 1、員工轉帳、無號碼收據；換設備仍須確認 Windows 與 ERP 版本。
- `查詢收據`：日期區間查詢尚未校準，固定回傳 `needs_calibration`，不操作 ERP。

資料庫的影片、影格、實際輸入、journal、銀行資料與核對圖保留在使用者工作目錄，不放進 Plugin 更新目錄或 GitHub。

複製資料庫到工作目錄後，將 `ERP_SKILLS_ROOT` 指向本次載入的 VIXO Plugin `skills/` 絕對路徑。adapter 也能尋找同一 Plugin 的相鄰技能，並相容獨立安裝的 `$CODEX_HOME/skills`（未設定時為 `~/.codex/skills`）。

```powershell
# 將下列兩個路徑換成自己的實際位置。
$env:ERP_SKILLS_ROOT = '本次載入的 VIXO Plugin skills 目錄絕對路徑'
$erpLibrary = '工作資料庫絕對路徑'
python "$env:ERP_SKILLS_ROOT/erp-video-automation/scripts/dispatch.py" list --library $erpLibrary
python "$env:ERP_SKILLS_ROOT/erp-video-automation/scripts/dispatch.py" schema --library $erpLibrary --key 'Key收據'
```

完整欄位與命令見 [輸入契約](../plugins/agent-teams-builder/skills/erp-video-automation/references/contracts.md)。缺欄時一次列出，不先開 ERP；允許留空也須明確填空字串。執行前確定本次授權；同一業務請求固定 ID，儲存結果不明時查原單，不換 ID 重建。

## 環境與驗證範圍

影片整理與離線契約工具需要 Python 3.10+；抽影格另需 Pillow，以及 PyAV 或 ffmpeg＋ffprobe。實際請款需要 Windows 桌面、Python、Pillow、Windows 本機繁中 OCR／PowerShell，並由使用者登入正確公司的 Cosmos ERP PCMI10 iGP2.0 16.0.2.1。macOS／Linux 可進行支援的離線工作，無法執行 Windows ERP 控制。

原包記載 2026-09-10 在原環境的 ERP 實單驗證及 2026-09-17 的離線驗證。本次封裝移除原電腦帳號路徑、具名歷史範例與實單號碼，修正技能尋址並執行離線測試；未新增、修改或獨立複驗 ERP 單據。產圖與 `awaiting_model_review` 都不代表 `verified`，仍須模型核對本次實際證據。
