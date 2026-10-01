# VIXO Docs 工作台（v1.7.0）

Docs 位於 VIXO 自己的導覽中，不會新增 Codex 全域圖示。預設進入經典首頁，保留原員工總覽；可切換像素辦公室、介面樣式、功能層、系統層及執行中心。

## 畫面與資料

首頁預設九張卡片：今日工作、常用工作流程 Agent、待確認及審核、異常警示、行事曆固定工作、各項任務專案、最近工作、單位健康儀表板及單位成果儀表板。

Agent、Skills、Workflows、排程與紀錄都讀取使用者自己的 VIXO 資料。首次安裝沒有員工時顯示空狀態，不建立虛構員工。像素人物依 Agent ID 維持座位；底圖人物只是裝飾，並非員工或真實工作狀態。

今天／本週／本月統計讀取完整執行紀錄。原生 Codex 模式只顯示「已建立 Codex 任務」，後續進度在該任務內查看，不計為完成；沒有節點證據時不製造完成百分比。

## 操作

- 從常用流程或員工詳情開啟 Play，選任務、宿主、背景／原生位置與 Codex 專案。
- 可設定每日排程，或在執行詳情补資料、核准／拒絕、查看結果及開啟對應 Codex 任務。
- 使用「自訂首頁」設定卡片新增／移除、寬高、顏色及排序；也可直接拖曳排序／縮放。鍵盤可使用配置表單完成相同設定。
- 偏好包含明暗主題、經典／像素介面、卡片與常用流程，保存於 VIXO 的 `.system/workbench-preferences.json`。
- 搜尋涵蓋 Agent、Skill、Workflow 與可用紀錄；不假裝搜尋尚未串接的信件或檔案。

## 尚未串接

Outlook、Teams、SharePoint／OneDrive、ERP、BI、KPI、企業權限與外部通知是後續藍圖。未連線來源顯示「未串接」；沒有工時基準或費用資訊時顯示「尚無資料」。其他介面風格不等於已串接對應產品。

完整範圍見 [173 節點對照表](VIXO-Docs-功能對照表.md) 及 [CSV](VIXO-Docs-功能對照表.csv)。員工建立／修改仍須預覽完整 SOP、使用者 Double Check 後才提交。

## API 與安全邊界

- `GET /api/workbench?period=today|week|month`：期間彙總與模組狀態。
- `GET /api/runs/:id`：安全結果摘要，排除 token、內部日誌路徑及憑證。
- `GET /api/preferences/workbench`、`POST /api/preferences/workbench`：工作台偏好。

沿用本機 loopback 與 token 保護。VIXO 與 LazyOffice 的資料、Plugin、偏好與分派規則獨立。前端圖示使用本機 inline SVG，不依賴外部 CDN 或 icon font。

## 維護測試

`npm test` 是跨平台程式回歸。`npm run test:embed-lifecycle`、`npm run test:workbench-icons`、`node scripts/test-workbench-browser.mjs` 是隔離 Chromium 測試，不連接使用者桌面 CDP 或正式員工工作。

瀏覽器測試可透過 `WORKBENCH_BROWSER_PACKAGE_ROOT` 指定含 Playwright 的 package.json，透過 `WORKBENCH_CHROME_PATH` 指定 Chrome 執行檔。雙 Plugin 點擊測試另需提供另一套 Plugin 的來源；沒有該來源的獨立 VIXO 安裝不應假裝此項已通過。
