# VIXO Agent Teams Builder 1.12.0 測試報告

測試日期：2026-10-08（Asia/Taipei）；下方歷史版本各自保留原驗證範圍。

## v1.12.0 本地與雲端資料庫

- 本機全套 Node 測試：190 PASS、0 FAIL、1 SKIP（根目錄 78、Plugin 112 通過；原有需 live Codex CDP 的測試維持 SKIP）。涵蓋登入 gate、帳號隔離、排程／執行準備途中換帳號拒絕、持久佇列、跨 process 鎖與 crash recovery。
- 本地同步回歸驗證：連續 10 次乾淨讀取／同步沒有額外 Auth／REST 請求；metadata 更新只下載變更 revision；接近 5 MiB 的套件可持久保存；同步途中再編輯保留草稿；寫入回應遺失只透過確切版本、內容與 actor 對帳，不盲目重送。
- MCP 隔離回歸涵蓋：未登入拒絕、確認後本地佇列、Agent／Skill／Workflow 合併讀取與準備、CAS 衝突另存副本，以及切換帳號後拒絕存取其他帳號項目。測試不呼叫正式宿主執行業務。
- 安裝回歸驗證：替換前建立一次 legacy ownership 快照，候選身分僅採舊版已驗證 session；登入／重跑不改寫歸屬；未歸屬資料須確認匯入；symlink／特殊檔案拒絕；快照不含帳密／token，原 SOP 不變。
- 首頁瀏覽器 fixture 通過：登入前不請求私有資料、待審核、合併清單、完整 SOP 確認、衝突比較、nullable 舊本機內容唯讀、停用／跨頁登出清空畫面、舊回應拒收、離線私人草稿及 390px 版面。既有雲端管理頁、帳密／團隊／手機版回歸也通過。
- 真實 Supabase HTTP 驗證 13 組通過：三種套件本地保存後同步、第二裝置同帳號取得、10 次本地讀取零 HTTP、版本不變零套件下載、單一 revision 變更只下載一份、實際 CAS 409 的採用遠端／另存副本、成功寫入回應遺失後重啟對帳且不重送、同仁私人隔離，以及停用後舊快取不能準備執行。僅使用兩個既有 QA 帳號，最後皆停用；原管理員身分、權限與私人資產 checksum 不變。
- Windows／macOS CI、發行檔與安裝讀回以本版 commit 的發布紀錄為準。ERP 影片路由維持原規則；未新增正式 ERP 操作驗證。

### v1.12.0 驗證邊界

- 5 秒工作台重新讀取使用本機索引；同步器採 180 秒 metadata 檢查，登入、回到前景、手動同步與確認修改可提早檢查。開始／續跑仍即時查核帳號及原資產權限。
- 完全離線只支援曾驗證、session 尚有效的同一帳號編輯未連結雲端的私人本機草稿；執行及團隊操作須連線。待審核或停用不得以快取繞過。
- 本地儲存與雲端同步分開顯示；換裝置只能看到已同步內容。衝突保留本地不可變版本，使用者比較確認後採用遠端或另存副本。

## v1.11.0 自行註冊與管理員審核

- 本機全套 Node 測試：161 PASS、0 FAIL、1 SKIP（根目錄 70、Plugin 91 通過；原有 live Codex CDP 測試維持 SKIP）。註冊 Edge 13 項測試涵蓋專案 API key、欄位／權限注入、密碼 Unicode／UTF-8 上限、持久配額、重複帳號與建立結果不確定的處理。
- 隔離 PostgreSQL 共 255 項 SQL 斷言通過：001–005 的既有 125 項在升級前執行；006 的審核 69 項與配額 61 項在升級後執行。新兩份 rollback suites 也在正式 Supabase 通過，不留下 fixture。
- 真 PostgreSQL 並行測試確認：停用等待已進行的寫入完成，下一請求被拒；60 個全域註冊請求僅 50 個放行，同 IP 10 個僅 5 個放行。隔離升級核對同 UUID 的兩份原資產所有欄位不變；001–005 未修改。
- 006 migration 與 vixo-register 已部署。以兩個新 QA 帳號進行 8 組真實 HTTP 驗證：註冊 pending、禁止自行升權、角色注入／重名拒絕、管理員核准、不自動加入團隊、私人資料隔離、舊 session 停用後拒絕雲端與快取準備、恢復與密碼登入。QA 帳號最後停用，原管理員私人資產 checksum 不變。
- 完整瀏覽器 fixtures 通過：自行註冊、待審核／停用頁、三種管理篩選與核准／停用／恢復、焦點與離線清理、晚回應防護、未設定帳密的既有管理員／pending 身分，以及既有帳密、配對、版本、團隊與手機版回歸。
- 既有使用者的 Auth UUID 經可信操作端核對後，單獨設為唯一管理員；姓名、username 或可修改的 user metadata 均不能決定權限。未替使用者建立、讀取或修改密碼。

### v1.11.0 驗證邊界

- 帳號核准與團隊角色分開；管理員不因此取得他人的私人資產。所有雲端執行準備均須即時核准檢查，完全離線時不能以舊核准狀態執行雲端快取。
- 自訂註冊入口以公開專案 API key 識別客戶端，只建立 pending；此 key 不是使用者核准憑證。標準 Auth 公開 signUp 保持停用，不提供 SMTP／M365 或自助重設密碼。
- UI fixture 與真實 Supabase API 分別測試；GitHub Actions、Pages、發行檔及安裝後讀回以本版 commit 的發布紀錄為準。Agent／ERP 實際執行仍在本機，未執行正式 ERP 操作。

## v1.10.0 帳號密碼驗證

- 本機全套 Node 測試：138 PASS、0 FAIL、1 SKIP（根目錄 53、Plugin 85 通過；原有 live Codex CDP 測試維持 SKIP）。包含帳號設定驗證、原 UUID 保留、無明文密碼持久化、登入失敗與晚回應的 session 隔離。
- 真實 Supabase HTTP 的 12 項帳密檢查通過：既有 QA 身分綁定及新裝置登入、私人資產 ID／revision 保留、錯誤密碼不取代 session、拒絕再次綁定、匿名與指定其他 user ID 拒絕、受邀同仁、重複帳號拒絕後可設定其他名稱、同一身分並行設定僅一次成功。只使用隔離 QA 帳號，不替使用者設定或讀取密碼。
- 005 migration 與 `vixo-account` Edge Function 已部署；新 SQL suite 的 24 項斷言在本機及遠端 rollback 交易通過。五份 SQL suites 共 125 項斷言，並以兩條本地 PostgreSQL 連線驗證同 UUID／同帳號的並行衝突。
- 網站與本地表單的隔離瀏覽器回歸通過：帳密主入口、原身分設定、送出後清空密碼、部分成功提示、進階裝置碼、跨頁／延遲回應隔離、發布、回復、共享與手機版。UI fixtures 與真實 Supabase API 測試分別執行。
- 真實 API 測試發現 Auth 的 `code` 為數值 HTTP 狀態、`error_code` 才是語意錯誤；已修正登入與帳號設定的錯誤處理，並加入相同回應形狀的回歸。

### v1.10.0 驗證邊界

- 第一次須在已連線的外掛設定帳密，保留原 UUID；使用者自行輸入，發布流程不替真實使用者建立密碼。新同仁經團隊邀請加入後設定自己的帳密。
- 未設定 SMTP／M365，也沒有寄信重設密碼；帳密驗證與雜湊由 Supabase Auth 處理。成功或結果不確定的設定保留服務端 claim，避免重試覆寫密碼。
- GitHub Actions、Pages、發行檔及安裝後讀回以本版 commit 的發布記錄為準。Agent／ERP 執行仍在本機宿主，既有 SOP 與影片路由保持原行為。

## v1.9.0 雲端同步驗證

- 本機全套 Node 自動化測試：113 PASS、0 FAIL、1 SKIP；包含 34 項根目錄測試及 79 項 Plugin 測試。SKIP 為原有需 live Codex CDP 的側欄測試。
- 真實 Supabase HTTP 驗證 12 項通過：裝置配對、一次性碼不可重播、第二裝置同身分、私人隔離、viewer 唯讀、editor 更新、CAS 版本衝突、不可改寫歷史、回復產生新 revision、固定舊版執行準備、移除成員即撤權、匿名拒絕。使用獨立 QA 身分與虛構套件。
- Migration 001–004 已套用至 VIXO Agent Teams；四份 SQL suites 在隔離 PostgreSQL 通過 101 項斷言，遠端以 rollback suites 再驗證 RLS、RPC、裝置碼與 CAS。`vixo-device-pair` Edge Function 已部署並由 HTTP 測試驗證。
- 實際 HTTP 測試發現 PostgREST 對 SQLSTATE `40001` 會重試到逾時；004 migration 改用 `PT409`，並確認 HTTP 409 可保留衝突稿、不覆蓋目前版本。
- 雲端管理頁有 11 項控制器測試；隔離瀏覽器使用合成 API 資料驗證發布、歷史回復、複製、匯出、團隊與換機入口，以及 390px／320px 窄畫面。這些是 UI fixtures，與上述真實 Supabase API 測試分開記錄。
- Agent、Skill、Workflow 套件保留 SOP／程式資源，排除私人 memory 與執行輸出；驗證路徑可攜性、秘密、快取 hash、固定版本、跨身分隔離與已知撤權後拒絕離線。排程測試涵蓋慢速雲端驗權不重複啟動，並保留既有本地排程來源。
- 兩位既有本地 Agent 已原樣複製到使用者的私人雲端；逐一核對 SOP 與本地 agent.json 保持一致。私人套件、session、配對碼及遷移記錄均不納入 Git 或安裝包。

### v1.9.0 驗證邊界

- 本版提供雲端儲存、同步、分享、權限與版本；實際工作仍由目前電腦的 Codex／Claude 與本地工具執行，沒有新增全天候雲端運算 worker。排程仍依賴本機服務。
- 使用裝置配對，未設定 M365 登入或 SMTP。內部 Supabase Auth 身分只用於 session／RLS；沒有另開註冊或寄信介面。
- Supabase advisor 所列 invites／device_codes「RLS 無 policies」為刻意僅服務端存取；authenticated security-definer RPC 明確檢查身分／角色。未啟用 leaked-password protection；本版不提供密碼登入。這些項目不是零告警掃描結果。參考 [RLS advisories](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) 與 [password security](https://supabase.com/docs/guides/auth/password-security)。
- 未實際操作 ERP 實單或以新影片完成模型端到端操作；既有 ERP 影片共用技能與授權界線保留。Windows／macOS CI、GitHub Pages 與安裝包發布狀態以對應 commit 的 Actions／Release 為準。

## v1.8.0 本機驗證

- `npm test`：71 PASS、0 FAIL、1 SKIP；包含 13 項安裝／更新、7 項 ZIP 檔名編碼與 51 項 Plugin 回歸。SKIP 仍是需 live Codex CDP 的實機側欄測試。
- ERP 共用工具：43 項離線測試通過，涵蓋完整輸入 gate、影片登錄、假桌面請款、防重送及搬移後技能尋址；不操作 ERP。
- 新增 6 項影片規則整合測試，涵蓋兩位不同 Agent、普通／明確共用技能選擇、Workflow 手動／自動核准、既有紀錄的 reply／approve 續跑，以及含空白路徑的 Plugin 搬移。Agent 私人檔案逐項讀回，確認共用路由沒有修改它們。
- 新入口 `vixo-video-intake` 保持自動技能選擇；影片與 ERP 有關即轉交 `erp-video-automation`。實際檔案路徑由目前 Plugin 位置解析，不寫死開發機或員工技能目錄。
- 全部 6 個 Skill 的 YAML 前言與相對文件連結、7 個版本欄位（含 lockfile 根 package）及 Git whitespace 檢查通過。

- 修正 macOS 包裝工具漏標中文檔名 UTF-8 的問題。先完整核對封裝與 staging，再只調整對應 local／central header 的編碼旗標；不改壓縮資料、檔案內容、執行權限或 offset。7 項 ZIP 回歸包含標準 Python reader、不同 header／編碼／comment、不完整格式拒絕及不修改其他位元組。

### v1.8.0 驗證邊界

- 分類由目前 Codex／Claude Code 宿主查看影片內容後完成。本次驗證涵蓋共用規則、路徑、Prompt 傳遞與續跑整合；未用新真實影片完成「分類 → 自動化程式碼」的模型端到端實跑，也未新增或修改 ERP 實單。
- Dashboard 既有任務／續跑欄位仍接收文字；影片可附在原生宿主對話，背景任務／排程則提供可讀取的影片檔案路徑或連結。
- ERP 關聯性與操作證據完整性分開判斷。ERP 產品介紹／訓練仍交由技能評估，缺少可辨識步驟時保留 `draft/needs_calibration`，不得虛構可執行結果。日期區間收據查詢仍未校準。
- 發行檔對應固定來源 commit，包含三個配套共用技能與程式／空表單；GitHub Windows／macOS 回歸及真實宿主 CLI 安裝結果，以該版本 commit 對應的 Actions 紀錄為準。

## v1.7.0 已通過

- 本機 `npm test`：58 PASS、0 FAIL、1 SKIP；SKIP 是需 live Codex CDP 的實機測試。
- 新增完整執行紀錄期間統計、偏好儲存、安全結果白名單、授權與 173 節點來源對照回歸。
- 9 組隔離瀏覽器工作台回歸：真實程式搭配合成員工／假 CLI，覆蓋 Play、每日排程、補資料／核准／拒絕、重開、表單保留、座位、搜尋文字安全、拖曳與縮放，以及窄視窗。
- 圖示回歸先重現缺少 SVG，再驗證本機向量、明暗主題、鍵盤、390px 視窗及無外部圖示／字型依賴；另有不受信任圖示識別字不可插入 markup 的測試。
- 正式嵌入程式在私人 Chromium／合成宿主中跑 3 組生命週期測試，覆蓋早期 DOM、重新載入、宿主替換及 opaque sandbox 中的 SVG 呈現。
- 7 組合成雙側欄點擊回歸。停止回歸使用合成 HTTP／WebSocket peers 與精確建立的子程序，不操作使用者的 Codex App。
- 正式庫在獨立浏览器只讀驗證，員工／Skills／Workflows 與像素身分一致，沒有 page error；不執行正式員工工作、不寫入正式偏好。
- 发行包僅取 Git 已追蹤來源，不包含本機截圖、私人工作輸出、員工資料或本機專用修補腳本；保留舊版發行檔。
- 發布前 macOS CI 已通過；首輪 Windows CI 找出停止測試把強制終止誤當 exitCode=0 的平台假設。回歸改為驗證 signalCode／Windows 強制退出、精確子程序真的結束，以及正式 controller 安全清理死程序紀錄；API／POSIX 正常退出仍嚴格要求 0，沒有跳過 Windows 停止測試。

### v1.7.0 驗證邊界

- 使用者截圖已確認新版 Docs 工作台可開啟；最後的新版圖示／桌面重載驗收尚待使用者確認，不能把隔離橋接當作實機通過。
- 這一版不增加企業 OAuth、ERP／BI、信件／檔案串接，也不修改員工 SOP 或 LazyOffice 分派規則。
- 新版 macOS／Windows 發布 CI 以此版本 GitHub Actions 紀錄為準；下方是歷史版本驗證，不代表本版實機安裝結果。

## v1.6.2 已通過

- 修正 `ChatGPT.app` 或 `Codex.app` 已經開啟、但沒有帶 CDP 啟動參數時，Bridge 過早回退成 `codex-browser-panel` 的問題；現在會啟動受管理的桌面 Renderer，再注入 `VIXO Agents` 側欄。
- macOS 同時支援系統與使用者 Applications 內的 `ChatGPT.app`、`Codex.app`，兩者並存時優先選擇正在執行的 App；Windows 保留 ChatGPT／Codex 雙套件偵測。
- 新增雙 App 候選排序與「已開啟但無 CDP 仍啟動 Bridge」測試。
- 目前共 36 個自動化測試，35 通過，1 個需 live Codex CDP 的環境測試標記 skip。

## v1.6.1 已通過

- Claude Code 2.1.270 已登入，`agent-teams-builder@agent-teams-local` v1.6.0 安裝且啟用；全新 Claude Code Session 實際載入 3 個 Skills、連上本機 MCP，並成功呼叫一次 `agent_list`，回傳 `execution host=Claude Code, agents=2`。
- 一鍵安裝器現在即使 GitHub 版本相同或暫時離線，也會重新檢查登入、修復每個已偵測且相容的 Codex／Claude Code Plugin 註冊，再用兩邊的 `plugin list --json` 讀回驗證安裝與啟用狀態。
- 新增同版重跑修復測試；目前共 34 個自動化測試，33 通過，1 個需 live Codex CDP 的環境測試標記 skip。
- Claude Code strict validator 通過；Codex 與 Claude Code 現機修復及讀回驗證均通過。

## v1.6.0 已通過

- 33 個自動化測試包含安裝、登入、安全更新、Dashboard 更新提示、固定更新執行器、更新後快取失效、MCP、Double Check、秘密掃描、多 Skill、Workflow 與 Dashboard。
- Dashboard 啟動時與手動按鈕可檢查 GitHub `main`；遠端 commit 不同時顯示新版版本、立即更新按鈕與更新中／成功／失敗狀態。
- 頁面更新只會執行安裝於 `下載/Agent Teams/.system/updater/install.mjs` 的固定更新器，不接受任意 repo、URL 或執行檔路徑。
- 更新沿用固定 commit SHA、50 MB 上限、archive SHA-256、安裝後 SHA 讀回證明與失敗保留上一版機制；成功時整包替換 Plugin、Dashboard、Skills 與執行功能並重新啟動。
- 發行包內含 `release-metadata.json`，第一次安裝即記錄來源 commit，避免安裝後誤判同一版為新版。
- 實機首次按頁面更新時，更新器安全失敗並保留舊版；定位為安裝階段的一次性 `SKIP_UPDATE` 被背景服務繼承。已在 Dashboard、獨立 runner 與子更新器三層清除／覆寫該旗標，並納入後續實機重測。
- 修正後的頁面更新實機重測通過：Dashboard 從 commit `5597442054f9` 偵測到 `4d4c630f5a5a`，API 回傳 202 後由獨立 runner 完成更新；狀態為 `succeeded`，Codex 與 Claude Code 均安裝成功，Runtime Doctor 通過，Dashboard 與 Codex sidebar Bridge 重新啟動且 `frameLoaded=true`。
- 更新後再次查詢，安裝版本為 `1.6.0+codex.20260923192303-4d4c630f5a5a`，本機與 GitHub 完整 commit SHA 相同，`available=false`，證明不會反覆提示同一版。
- Windows CI log 複查發現：EXE 安裝成功，但傳統 Windows PowerShell 5 會錯誤解碼無 BOM 的中文 `.ps1` 訊息；已將 PowerShell 備援入口改為 ASCII 訊息，並在 CI 加上非零 exit code 強制失敗檢查，避免假通過。
- 嚴格檢查進一步發現 Windows 第二次執行安裝器時，背景 Dashboard 仍占用已安裝的 `node.exe`，導致 Runtime 取代出現 `EPERM`。安裝順序已改為先使用既有 Runtime 停止 Dashboard／Bridge，再替換 Runtime 與 Plugin。

## v1.6.0 已知邊界

- v1.5.0 與更舊版本的頁面沒有「立即更新」按鈕，必須先用 v1.6.0 安裝包更新一次；之後才能完全從頁面更新。
- GitHub 無法連線時，頁面會保留目前版本並顯示檢查失敗；不會以舊檔覆蓋。
- Windows EXE 與 macOS App 尚未簽章，Gatekeeper 或 SmartScreen 可能顯示安全確認。

## v1.5.0 歷史驗證

- 30 個自動化測試包含安裝、登入、自動更新、MCP、Double Check、秘密掃描、多 Skill、Workflow 與 Dashboard。
- Codex 原生 Play 實機驗證：選擇專案後建立新 Session，任務內容成功執行，並從 `thread-project-assignments` 讀回與選擇專案相同的 Project ID。
- Dashboard 將原生 Session ID 保存於執行紀錄，可用「在 Codex 開啟」回到該任務；偽造或尚未成立的 client thread ID 會被拒絕。
- Workflow 執行狀態可區分 `waiting-input`、`waiting-approval`、`completed`、`failed` 與 `rejected`。
- 手動核准模式實測：到達 Approval 節點後暫停，Dashboard 呼叫 approve API，沿用原 Codex Session 完成後續節點。
- 自動核准模式實測：Workflow 內建 Approval 不再暫停，但宿主工具權限仍保留。
- Codex 側欄實機穩定性檢查：Dashi Taskboard 與 VIXO Agents 順序固定，1.5 秒內 0 次換位。
- 發行包含 macOS arm64、macOS Intel、Windows x64 的 Node.js Runtime，macOS `.app` / `.command` 與 Windows `.exe` / `.cmd` / PowerShell 入口。
- Codex Plugin validator：通過。
- Claude Code `plugin validate --strict --json`：通過，0 errors、0 warnings。

### v1.5.0 已知邊界

- Codex 正式 Plugin manifest 仍沒有自訂左側頁面欄位；本版側欄是桌面 CDP/DOM Bridge，不是官方側欄 API，並有原生瀏覽器面板回退。
- 排程由 Dashboard 背景服務觸發；電腦關機或服務停止時不會補跑。
- 自動核准是「單次執行」或「單筆排程」設定，不會改變 Agent 永久安全規則，也不繞過 Codex／Claude Code 的工具權限。
- 舊版已結束且沒有記錄 Session ID 的 `waiting-approval` 紀錄無法原地續跑，需從新版 Play 重新啟動。
- Codex 原生 Play 的進度、工具核准與最終輸出在新建的 Codex 任務內查看；Dashboard 只顯示「已建立 Codex 任務」與開啟按鈕。
- 背景 Play 會載入使用者現有 Codex/Claude Code 設定與工具；其他外掛的登入錯誤可能出現在 run log，但本次真實 Play 仍完成。
- macOS App 與 Windows EXE 未簽章；Gatekeeper 或 SmartScreen 可能顯示安全確認。

## v1.4.0 歷史驗證

- 28 個自動化測試、Workflow 手動／自動核准、Codex 側欄與 Taskboard 共存穩定性檢查通過。

## v1.3.0 歷史驗證

- 23 個自動化測試、雙宿主實機安裝、Dashboard Play 真實 Codex E2E 與 macOS/Windows GitHub Actions 均通過。
- GitHub Actions 紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35765604515>。

## v1.2.0 歷史驗證

### 已通過

- 20 個自動化測試：原有安裝、登入、MCP、Double Check、秘密掃描、多 Skill 與目前宿主路由，以及新增的固定 commit archive 下載、cachebuster、同版不重裝、斷網不降版、更新成功 SHA 證明、路徑別名與跨平台含中文檔名 ZIP 解壓。
- `claude plugin validate --strict`：通過，0 errors、0 warnings。
- Codex Plugin validator：通過。
- GitHub Actions `macos-latest` 與 `windows-latest`：兩邊均安裝真實 Codex／Claude Code CLI、執行 20 個測試、驗證 manifest，並執行對應一鍵安裝器。通過紀錄：<https://github.com/inventra/agent-teams-builder/actions/runs/35638367720>。
- macOS arm64 實機 GitHub 更新：從公開 `main` 取得 commit `e1951ee394d8318873fc6f8ebce60186ce26f38c`，下載固定 SHA archive，Codex 與 Claude Code 均從 1.1.0 更新到 `1.2.0+codex.20260921182617-e1951ee394d8`。
- 更新狀態讀回：`.system/update-state.json` 的 repository、branch、完整 commit SHA、commit date、archive SHA-256、動態安裝版本與完成時間均存在，且與本次下載相符。
- 再次點擊同一安裝檔：回報已是 `e1951ee394d8`，不重新安裝。
- Runtime Doctor：MCP SDK 載入成功，執行模式為 `current-host`，不需要模型 API Key。

### 實機測試中發現並修正

- macOS 內建 `unzip` 遇 GitHub archive 中文檔名曾回報 `Illegal byte sequence`；已改用 macOS 原生 `ditto -x -k`，並新增中文檔名 archive 測試。
- macOS 暫存路徑可能同時表示為 `/var/...` 與 `/private/var/...`，曾使下載後子安裝器的主程式判斷提前退出；已改用 realpath 比較。
- 更新器現在不以子程序 exit 0 單獨判定成功，必須再讀回 `.system/update-state.json` 且完整 commit SHA 相符才算完成。
- GitHub commit 查詢使用 no-cache 與 cache-bust query，避免 push 後短時間讀到舊 SHA。

### 安全與失敗邊界

- 更新來源固定為公開 `inventra/agent-teams-builder` 的 `main`，不接受使用者輸入任意 repo、URL 或本機安裝路徑。
- 只接受 GitHub 回傳的 40 位十六進位 commit SHA，下載 URL 固定為該 SHA 的 archive；archive 上限 50 MB，下載內容另記錄 SHA-256。
- 只有兩個宿主的實際安裝與 Runtime Doctor 都成功，才更新成功狀態並移除上一版備份。
- GitHub 暫時無法連線且已有成功狀態時，保留目前版本並停止，不會讓舊 ZIP 覆蓋新版；第一次安裝則允許使用 ZIP 內附版本。
- OAuth 瀏覽器頁面仍由使用者親自輸入帳密；外掛不讀取、保存或傳送帳號密碼。
- Agent 只由目前 Codex／Claude Code Session 執行，不使用 Anthropic API、OpenAI API 或獨立 Agent SDK。
- v1.1.0 沒有更新器；既有使用者需要先下載 v1.2.0 一次，之後才可持續點擊同一份檔案更新。
