# VIXO Agent Teams 雲端版本

v1.12.0 先登入，再以同一份資料庫查看目前帳號擁有的本地草稿與雲端 Agent、Skill、Workflow。完整預覽經 Double Check 後預設僅保存本機。明確開啟雲端同步的項目才加入持久佇列，每 180 秒嘗試同步；立即同步也不會上傳僅存本機的草稿。新帳號仍待 Kevin 審核；執行由目前裝置上的 Codex／Claude 與本地工具完成，開始／續跑時需線上查核核准與資產權限。換機同步的是已同步的角色定義、SOP、程式與流程，不是模型權重或另一台電腦的登入狀態。

## Git、Supabase 與本地裝置

| 位置 | 負責內容 |
| --- | --- |
| GitHub | 外掛原始碼、公用 Skill、migration、測試、可追溯的 commit、版本安裝包，以及雲端管理頁的發布。 |
| Supabase | 個人／團隊身分與權限、已同步的 Agent／Skill／Workflow 套件、不可改寫的歷史版本、裝置連線碼及邀請碼的雜湊。 |
| 本地 VIXO | 裝置 session、按帳號隔離的本地定義與同步佇列、固定版本快取、Codex／Claude 執行，以及 ERP 所需的本地工具與環境。 |

Git commit 是程式版本；Supabase revision 是每個雲端資產的內容版本，本地版本另以 localHash 判斷內容變化。登入後的清單合併本人本地草稿與授權雲端內容，分別顯示「僅存本機／本機＋雲端」與「未開啟同步／待同步／已同步／衝突」。未上傳的本人草稿仍可在帳號線上核准後執行。未登入不能以同名本地檔案替代帳號資料；離線可保留本人草稿，但不能開始或續跑任務。

雲端管理頁位址由 `plugins/agent-teams-builder/web/cloud-config.json` 的 `portalUrl` 指定。前端設定只包含 Supabase 公開 URL／publishable key；service-role key 只留在服務端。發布狀態請以 GitHub Release、Pages deployment 與 Supabase migration／Edge Function 的實際結果為準。

## 公用 Skills 與執行位置

左側「公用 Skills」及資料庫 Skill 分頁都顯示 `erp-video-automation`、`expense-claim-helper`、`vixo-video-intake`。這些是 GitHub 共用套件，隨外掛安裝到本機，讀取技能不需每次下載。可以查看版本、完整技能與配套文件，取得提示後交由目前 Codex／Claude Session 執行。它們不是某個人的 Supabase 私人資產。

新的本人草稿使用 `syncMode: local-only`，確認回傳 `saved-local`；要上傳時，以 `library_enable_sync` 傳入 id、目前 bundleHash（expectedHash）、localHash（expectedLocalHash）及明確確認。也可在首次完整預覽中選擇 `syncMode: cloud`。已同步項目編輯後仍同步，不能用切換顯示方式刪除或隱藏既有雲端副本。雲端保存與分享內容，實際工作一律由當前裝置執行。

## 帳號設定與登入

VIXO 雲端使用自己的帳號密碼；Codex／Claude 仍使用原有宿主登入。帳號為 3–32 個字元，以英文字母開頭，只接受小寫英文字母、數字、底線 `_` 與連字號 `-`；輸入的英文字母會轉成小寫。密碼至少 12 個字元，UTF-8 編碼最多 **72 bytes**；英文字母、數字等 ASCII 字元最多 72 個，中文字與其他非 ASCII 字元會占用更多 bytes。上限依 [Supabase Auth 的密碼驗證](https://github.com/supabase/auth/blob/master/internal/api/password.go)。請直接在登入或設定表單輸入，勿貼到對話、SOP 或共享套件。外掛保存裝置 session，不保存密碼。

### 已連線的既有裝置

1. 更新至 v1.12.0，開新 Session，呼叫 `dashboard_open`，進入「團隊與雲端管理」。
2. 若尚未設定帳號，選擇「設定帳號密碼」，直接在表單設定。
3. 設定會綁定目前已連線的身分，保留原有 UUID、私人 Agent、歷史版本與團隊權限；不另外建立一個空白帳號。
4. 之後在外掛或[雲端管理中心](https://inventra.github.io/agent-teams-builder/)用這組帳號密碼登入。以 `cloud_status` 確認目前身分，`agent_list` 查看合併的 Agent，`cloud_list` 查看本地／雲端合併的 Agent、Skill、Workflow。

### 舊本地資料的歸屬

安裝器在停止舊程式與替換外掛前建立一次 `.system/cloud/legacy-owner.json`，只保存 formatVersion、候選 UUID、原本地 Agent IDs 與 createdAt，不保存 token、密碼或 SOP。只有可確認為 v1.12 之前的安裝、session 有 UUID 與曾驗證標記，才記錄候選 UUID；其餘記錄為未歸屬，空清單也保留。安裝／重跑不改寫既有記錄，原 Agent 檔案不搬移或修改。

候選 UUID 仍須與本次雲端 Auth 驗證一致，才可讀取其舊 Agent。未歸屬資料必須先由使用者明確確認匯入；登入另一個帳號不會自動取得這批檔案。一般本地草稿、佇列及雲端快取也按 userId 隔離。退出或切換帳號不會把未同步草稿轉給其他人。

### 同仁第一次使用

1. 打開外掛首頁，或在[雲端管理中心](https://inventra.github.io/agent-teams-builder/)選擇註冊，填寫帳號、密碼與顯示名稱。顯示名稱為去除首尾空白後的 1–80 個字元，勿放入憑證。
2. 註冊後可登入查看「待審核」狀態；等待 Kevin 核准。核准前不能查詢、發布或執行雲端 Agent／Skill／Workflow，也不能使用團隊功能或舊快取繞過審核。
3. Kevin 核准後，重新確認目前狀態即可使用雲端功能；收到團隊邀請碼時，再透過「加入團隊」加入該空間。團隊角色與帳號核准分開管理，邀請碼不能將帳號自行核准。

進階邀請配對仍保留：同仁可先以團隊邀請碼取得自己的身分，再設定帳密，但新身分仍須 Kevin 核准。既有使用者請登入或綁定原本身分，不要另外註冊成另一個帳號；他人的換機碼會取得他人的身分，不應用來加入團隊。

忘記密碼請聯絡管理員；目前沒有寄送重設密碼信或自助重設功能。若另有仍已連線的自己的裝置，可先從該裝置產生短效換機碼連接新裝置。VIXO 不要求 M365、SMTP 或電子郵件驗證。

### Kevin 的審核

具備管理員權限的 Kevin 可查看帳號審核列表，將新帳號核准或停用。一般使用者只能查看自己的狀態，不能指定管理員、核准者或自行變更狀態。核准僅開放 VIXO 雲端功能，不額外取得其他人的私人資產或團隊角色；停用後不能新增雲端操作或從快取準備／續跑任務。已執行中的本地外部操作不因雲端狀態變更而自動回滾。

## 管理者建立首台連線

首台裝置還沒有既有身分，需由專案管理者透過已授權的 Supabase 管理連線建立一次 bootstrap：在本機產生 32 bytes 隨機值，轉為 64 字元 hex 連線碼；僅將它的 SHA-256 hash、`user_id: null` 與短有效期限寫入 `vixo_device_codes`。原始碼只交給首台裝置兌換，不寫入 Git、migration、SQL 歷史、文件或一般日誌。

管理連線的 seed 只應包含 hash，例如以下結構；`<SHA256_HEX_FROM_LOCAL>` 是佔位符，不是可用的連線碼：

```sql
insert into public.vixo_device_codes (code_hash, user_id, expires_at)
values ('<SHA256_HEX_FROM_LOCAL>', null, clock_timestamp() + interval '10 minutes');
```

Edge Function `vixo-device-pair` 驗證並一次兌換有效碼後建立首台身分，再由已連線使用者設定帳號密碼。bootstrap 過期或已使用就失效；客戶端不能直接建立 bootstrap，也不能指定另一位使用者的身分。之後使用帳密登入或正常換機／團隊邀請流程。管理者 seed 與實際配對是不同步驟，完成 seed 不等於裝置已連線。

## 確認後保存與同步

1. 登入後用 `agent_get`／資料庫入口讀取目前內容。建立／修改 Agent 使用 `agent_preview`，獨立 Skill／Workflow 使用 `library_preview`；完整展示角色、SOP、附檔、依賴、流程及私人／團隊目的地。
2. 使用者明確 Double Check 後，以預覽 token 與確認原文呼叫 `agent_commit`／`library_commit`。確認的內容先保存為本人本地定義與持久佇列，回傳穩定 `local:<uuid>`，不直接改寫舊私人 SOP 資料夾。
3. 同步器每 180 秒嘗試同步，或呼叫 `library_sync` 手動同步。發布使用讀取時的遠端 revision；本地再次修改需目前 localHash，防止舊預覽覆蓋較新內容。
4. 回報目前狀態：本地保存不等於雲端已儲存。同步失敗時草稿留在本機；換裝置只能取得已同步的版本。雲端成功後仍以資產 ID／revision 讀回驗證。

更新衝突會保留本地與遠端內容，停止覆寫。完整比較後使用 `library_resolve` 選「採用遠端」或「另存副本」，並傳入目前項目的 bundleHash（`expectedHash`）及遠端 revision（`remoteRevision`）核對選擇；同步器另外核對本地 localHash，不能強制覆蓋。採用遠端會保留衝突稿供查閱；另存副本建立自己的獨立內容。私人同步不代表分享給同仁，團隊發布需要明確選擇目標空間並確認權限。

完全離線只可保存本人草稿與確認後的修改；草稿不是執行核准憑證。待審核或停用身分不得發布、開始或續跑任務；網路恢復後重新驗權再同步與執行。

## 既有本地內容與明確分享

1. 呼叫 `cloud_preview_publish`，指定本地 `agent`，以及 `kind: agent`、`skill` 或 `workflow`。單一 Skill／Workflow 分別傳 `skillId`／`workflowId`。`workspaceId: null` 為私人空間；指定團隊 ID 為共享空間。
2. 工具整理完整套件並回傳預覽 token。展示角色用途、完整 SOP、檔案、Workflow 節點、依賴與發布空間，讓使用者 Double Check。
3. 收到使用者對該預覽的明確確認後，呼叫 `agent_commit`，傳入 token 與確認原文 `userConfirmation`。
4. 回報穩定本地 ID 與待同步狀態。同步完成後，再以 `agent_get`／`cloud_list` 讀回雲端資產 ID、revision 與位置，區別「本地已保存」與「雲端已儲存」。

本地 Dashboard 的資料庫提供預覽／確認操作。原本的本地員工檔案保留，只有目前身分已驗證歸屬的舊資料可匯入。日後建立／修改 Agent，仍走 `agent_preview` → 展示完整 SOP → 明確 Double Check → `agent_commit`；確認後先保存本地，排入同步佇列。

明確發布至私人或團隊雲端空間時，更新需指定 `id` 與讀取時的 `expectedRevision`。若版本已被同仁更新，系統保留衝突內容，不會自動覆蓋較新版本。團隊 viewer 可以使用／複製；修改團隊版本須 editor／owner，私人副本不改變原分享資產。

## 換裝置與分享給同仁

| 需求 | 使用方式 | 身分與權限 |
| --- | --- | --- |
| 自己換電腦／瀏覽器 | 直接以 VIXO 帳號密碼登入；也可用 `cloud_create_device_code` 或「連接另一台裝置」產生一次性碼。 | 使用相同身分，可讀取同一份私人內容及團隊空間。進階換機碼有效 10 分鐘，只能使用一次。 |
| 分享給同仁 | `cloud_create_workspace` 建立團隊；owner 以 `cloud_create_invite` 產生邀請碼，指定 `viewer`／`editor`。 | 同仁使用自己的身分加入指定團隊，不取得你的私人空間。 |
| 已連線者加入其他團隊 | 雲端管理頁的「加入團隊」。 | 保留現有身分，新增該團隊 membership。 |

`viewer` 可檢視、下載、使用及複製資產到自己可寫入的空間；`editor` 另外可發布團隊版本。只有 owner 可邀請或移除成員。團隊邀請預設有效 7 天、最多使用 10 次；同一成員重複加入不會自動升權。移除成員會撤銷當下存取權；仍有效的邀請碼可再次用來加入，因此它不是永久封鎖功能。

換機碼等同允許另一台裝置使用你的身分，不能拿來分享給同仁。工具只把邀請碼回傳給使用者，由使用者自行分享，不會自動聯絡同仁。

雲端管理頁可以「複製到空間」建立獨立副本，或下載／匯入 JSON。副本擁有自己的版本紀錄，後續修改不會自動修改原資產。

## 實際執行

登入且線上核准後，`agent_prepare_run`／`workflow_prepare_run` 可從本人本地定義或授權雲端內容準備任務；本地草稿若源自雲端／團隊資產，仍查核目前原資產的存取／membership。穩定本地 ID 為 `local:<uuid>`，雲端 ID 為 `cloud:<asset-id>`，同名項目必須用 ID 區別。尚未同步的獨立本地 Skill／Workflow 也可將本地 ID 交給這兩個 prepare 工具。獨立雲端 Skill、Workflow 或需要指定 revision 時，使用：

```json
{
  "assetId": "<cloud-asset-uuid>",
  "revision": 3,
  "task": "本次使用者要求完成的工作"
}
```

將上面的參數交給 `cloud_prepare_run`。工具驗權、下載、檢查平台與套件後，回傳 `prompt`、固定 revision、需求與本地資源路徑。收到結果的 Agent **必須在目前 Codex／Claude Session 實際執行 `prepared.prompt`**，使用目前可用且已獲授權的工具，不能只回報「已準備好」或「已分派」。下載套件本身不會執行其中程式。

遇到影片，沿用 VIXO 共用影片判斷；與 ERP 有關就調用 `erp-video-automation`，依實際影格及本次需求產生自動化程式碼、輸入表單與驗證流程。原生 Windows ERP 操作仍需在具備相應 ERP、工具及有效權限的 Windows 裝置執行。

外部 OAuth、網站登入、ERP 公司別、付款與操作權限不會隨套件搬到新裝置。新裝置應使用自己的環境與既有授權。Agent SOP 與共享程式不擴張本次使用者授權，也不另行呼叫模型 API。

## 套件與內容邊界

套件格式為 `formatVersion: 1`，包含 `kind`、`spec`、文字 `files`、固定版本的 `dependencies` 及 `requirements`。資料庫單份 bundle 上限為 **5 MiB（5,242,880 bytes）**；外掛另限制最多 512 個檔案、單檔 1 MiB，並檢查可攜相對路徑與完整 Skill 資源。資料庫使用 `jsonb::text` 的 UTF-8 大小計算，接近上限時仍可能因序列化差異被拒絕。

本地匯出排除私人 memory、歷史對話、執行 journal、影片、截圖、輸出與憑證檔案；共享文字也會檢查明顯秘密及本地絕對路徑。這些檢查不等於自動理解每一份業務資料，發布前仍要檢視完整預覽。不要把 token、密碼、API key、客戶資料或 ERP 實際輸入塞進共用套件。

原始影片、ERP 輸入、執行 journal 與輸出存放在使用者工作區；版本快取用來保存定義與程式，不能當作可覆寫的工作目錄。工具會重新驗證目前身分、版本及快取內容，無權限的套件不能靠舊快取繼續執行。

## 版本回復與離線行為

「歷史版本 → 預覽回復」會讀取舊內容，以目前 revision 為基礎發布一個**新版本**；先展示完整內容並確認，再儲存。舊版與目前版本都會保留。

正式 MCP、Dashboard 的雲端執行要求本次可驗證帳號已核准，並驗證資產權限。待審核、停用、無法取得即時核准狀態、session 過期、遭撤權或找不到資產時，會明確失敗，不自動回退到其他身分的快取或同名本地員工。

離線只保存本人本地草稿，不提供一般使用者離線執行入口。開始、續跑及排程都要即時確認目前帳號核准與原資產／membership，不能用固定 revision、舊 session 或本地複本省略此檢查。內部快取選項也不能擴張上述產品入口的執行權限。

## 註冊服務的技術邊界

`vixo-register` 是允許未登入使用者的自訂註冊端點，部署時設定 `verify_jwt=false`，由函式精確驗證目前專案公開 API key；它只識別專案客戶端，不核准使用者。部署需包含與外掛公開設定一致的 `public-config.json`，輪替公開 key 時同步更新網站、外掛與 Edge 設定。標準 Supabase 公開 `signUp` 保持停用，不啟用 SMTP 或寄信確認。自訂端點只接受 `username`、`password`、`displayName`；服務端建立 Auth 使用者後，006 的 Auth INSERT trigger 將帳號固定為 `pending`、非管理員。前端可取得 session 查看自己的狀態，業務 RLS／RPC 與本地執行入口仍要求目前核准。

每次有效註冊嘗試先透過 service-only `vixo_claim_registration_quota` 使用資料庫時鐘原子扣除配額：全域每小時最多 50 次，另加 IP 提示雜湊每 15 分鐘最多 5 次；重複帳號或建立失敗不退還配額。IP 提示只取有長度限制的 `X-Forwarded-For` 最後一段合法 IP，再以服務端金鑰做 HMAC-SHA-256；資料庫不存明文 IP 或密碼。不假定外部代理已清理該標頭；缺少、無效或遭偽造的 IP 提示也必須經過全域配額。這是目前限制建立成本的邊界，未部署 CAPTCHA，也不宣稱完全防止濫用。

確定重複帳號回傳 `username_unavailable`；建立回應遺失或結果不確定回傳 `account_registration_unconfirmed`，先嘗試新帳密登入或聯絡管理員，不宣稱已建立。確認帳號已建立但無法取得 session 時，回傳 `account_registered_session_unavailable`，引導登入。兩種部分失敗都不刪除帳號、不重設密碼，也不重試建立來覆蓋既有身分。

## 管理與維運

資料庫 migration、RLS／RPC 與測試見 [Supabase 說明](../supabase/README.md)。部署時依序套用 migration（包含 006 帳號審核與註冊配額），部署裝置配對、帳號設定與註冊 Edge Functions，配置前端公開設定並發布 Pages；service-role 僅保存在 Edge Function 執行環境。GitHub Release 的安裝包要包含同版 cloud client、設定、技能與本地執行程式。

帳號回歸至少涵蓋：既有已配對身分設定帳密後 UUID、Agent 資產 ID 與 revision 保持不變；新裝置帳密登入可讀到同一內容；錯誤登入不取代目前 session；並發刷新與切換帳號不能讓舊回應覆寫新 session，舊帳號的列表、預覽、執行紀錄及排程不顯示在新帳號下。並發綁定不能把同一身分改綁另一個帳號。

註冊／審核回歸涵蓋：匿名自訂註冊建立 pending → pending 可登入看自己狀態但不能使用業務資料 → Kevin 核准 → 可執行自己的授權資產 → 停用後無法新執行、續跑或使用快取；偽造 role／status 與公開 Auth signUp 不能跳過審核。另驗證字元／UTF-8 byte 邊界、同名重複、跨 Edge 配額、IP 標頭偽造、建立結果不確定與 session 取得失敗。

共享驗收至少涵蓋：A 裝置發布完整 Agent → B 裝置帳密登入或換機碼同步同一版本 → 同仁以 viewer 使用但無法覆寫 → editor 新增版本 → 舊版本回復產生新 revision → 移除成員後不能再下載或續跑。測試使用獨立虛構資料，不以測試成功代替真實 ERP 的操作驗證。
