# VIXO Agent Teams 雲端版本

v1.10.0 以 VIXO 帳號密碼作為雲端登入的主要入口，沿用 v1.9.0 的 Supabase Agent、Skill、Workflow 版本與團隊權限。已連線的 VIXO 從雲端查詢、驗證權限並同步指定版本，由目前裝置上的 Codex／Claude 與本地工具執行。換機同步的是角色定義、SOP、程式與流程，不是模型權重或另一台電腦的登入狀態。

## Git、Supabase 與本地裝置

| 位置 | 負責內容 |
| --- | --- |
| GitHub | 外掛原始碼、公用 Skill、migration、測試、可追溯的 commit、版本安裝包，以及雲端管理頁的發布。 |
| Supabase | 個人／團隊身分與權限、Agent／Skill／Workflow 套件、不可改寫的歷史版本、裝置連線碼及邀請碼的雜湊。 |
| 本地 VIXO | 裝置 session、按身分與版本隔離的快取、Codex／Claude 執行，以及 ERP 所需的本地工具與環境。 |

Git commit 是程式版本；Supabase revision 是每個共享資產的內容版本，兩者分開管理。已連線時 Supabase 是 Agent 的正式資料來源；雲端無法連線或權限不符時，不會改用本地同名員工執行。未連線的舊安裝仍可使用原本本地 Agent。

雲端管理頁位址由 `plugins/agent-teams-builder/web/cloud-config.json` 的 `portalUrl` 指定。前端設定只包含 Supabase 公開 URL／publishable key；service-role key 只留在服務端。發布狀態請以 GitHub Release、Pages deployment 與 Supabase migration／Edge Function 的實際結果為準。

## 帳號設定與登入

VIXO 雲端使用自己的帳號密碼；Codex／Claude 仍使用原有宿主登入。帳號為 3–32 個字元，以英文字母開頭，只接受小寫英文字母、數字、底線 `_` 與連字號 `-`；輸入的英文字母會轉成小寫。密碼至少 12 個字元，UTF-8 編碼最多 **72 bytes**；英文字母、數字等 ASCII 字元最多 72 個，中文字與其他非 ASCII 字元會占用更多 bytes。上限依 [Supabase Auth 的密碼驗證](https://github.com/supabase/auth/blob/master/internal/api/password.go)。請直接在登入或設定表單輸入，勿貼到對話、SOP 或共享套件。外掛保存裝置 session，不保存密碼。

### 已連線的既有裝置

1. 更新至 v1.10.0，開新 Session，呼叫 `dashboard_open`，進入「雲端同步」。
2. 若尚未設定帳號，選擇「設定帳號密碼」，直接在表單設定。
3. 設定會綁定目前已連線的身分，保留原有 UUID、私人 Agent、歷史版本與團隊權限；不另外建立一個空白帳號。
4. 之後在外掛或[雲端管理中心](https://inventra.github.io/agent-teams-builder/)用這組帳號密碼登入。以 `cloud_status` 確認目前身分，`agent_list` 查看 Agent，`cloud_list` 查看全部可存取的 Agent、Skill、Workflow。

### 同仁第一次使用

目前不開放自行註冊。請先取得團隊管理者的邀請碼，在「雲端同步」的進階連線入口完成配對，再設定自己的帳號密碼。這會沿用此次配對取得的身分與團隊權限；不要使用其他人的換機碼加入團隊。已有帳號的同仁可直接登入，再透過「加入團隊」使用邀請碼。

忘記密碼請聯絡管理員；目前沒有寄送重設密碼信或自助重設功能。若另有仍已連線的自己的裝置，可先從該裝置產生短效換機碼連接新裝置。VIXO 不要求 M365、SMTP 或電子郵件驗證。

## 管理者建立首台連線

首台裝置還沒有既有身分，需由專案管理者透過已授權的 Supabase 管理連線建立一次 bootstrap：在本機產生 32 bytes 隨機值，轉為 64 字元 hex 連線碼；僅將它的 SHA-256 hash、`user_id: null` 與短有效期限寫入 `vixo_device_codes`。原始碼只交給首台裝置兌換，不寫入 Git、migration、SQL 歷史、文件或一般日誌。

管理連線的 seed 只應包含 hash，例如以下結構；`<SHA256_HEX_FROM_LOCAL>` 是佔位符，不是可用的連線碼：

```sql
insert into public.vixo_device_codes (code_hash, user_id, expires_at)
values ('<SHA256_HEX_FROM_LOCAL>', null, clock_timestamp() + interval '10 minutes');
```

Edge Function `vixo-device-pair` 驗證並一次兌換有效碼後建立首台身分，再由已連線使用者設定帳號密碼。bootstrap 過期或已使用就失效；客戶端不能直接建立 bootstrap，也不能指定另一位使用者的身分。之後使用帳密登入或正常換機／團隊邀請流程。管理者 seed 與實際配對是不同步驟，完成 seed 不等於裝置已連線。

## 把本地訓練成果放到雲端

1. 呼叫 `cloud_preview_publish`，指定本地 `agent`，以及 `kind: agent`、`skill` 或 `workflow`。單一 Skill／Workflow 分別傳 `skillId`／`workflowId`。`workspaceId: null` 為私人空間；指定團隊 ID 為共享空間。
2. 工具整理完整套件並回傳預覽 token。展示角色用途、完整 SOP、檔案、Workflow 節點、依賴與發布空間，讓使用者 Double Check。
3. 收到使用者對該預覽的明確確認後，呼叫 `agent_commit`，傳入 token 與確認原文 `userConfirmation`。
4. 回報雲端資產 ID、revision 與位置。再次以 `agent_get`／`cloud_list` 讀回，區別「預覽完成」與「已發布」。

本地 Dashboard 的「把本地訓練成果上傳」提供相同的預覽／確認操作。原本的本地員工檔案保留，連線後的查詢與執行使用雲端內容。日後建立／修改 Agent，仍走 `agent_preview` → 展示完整 SOP → 明確 Double Check → `agent_commit`；已連線時工具會儲存到雲端。

更新既有雲端套件需指定 `id` 與讀取時的 `expectedRevision`。若版本已被同仁更新，系統保留衝突內容並要求重新讀取、比較；不會自動覆蓋較新版本。

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

已連線後，`agent_prepare_run`／`workflow_prepare_run` 會取得授權的雲端版本。獨立 Skill、Workflow 或需要指定 revision 時，使用：

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

正式 MCP、Dashboard 的雲端執行預設要求本次連線驗權。斷線、session 過期、遭撤權或找不到資產時，會明確失敗，不自動回退到其他身分的快取或同名本地員工。

同步模組提供內部 `allowOfflineCache: true` 選項，供明確選擇離線的整合使用；這不是目前 MCP 的預設或公開參數。只有可確認為同一身分、曾線上驗證且尚未過期的 session，加上符合 hash／revision 的快取，才可在純網路失敗時讀取；401／403／404 或已知撤權不適用。離線結果必須標記「未能重新確認雲端權限及最新版本」，不宣稱已完成最新同步。

## 管理與維運

資料庫 migration、RLS／RPC 與測試見 [Supabase 說明](../supabase/README.md)。部署時依序套用 migration，部署裝置配對與帳號設定／登入所需的 Edge Function，配置前端公開設定並發布 Pages；service-role 僅保存在 Edge Function 執行環境。GitHub Release 的安裝包要包含同版 cloud client、設定、技能與本地執行程式。

帳號回歸至少涵蓋：既有已配對身分設定帳密後 UUID、Agent 資產 ID 與 revision 保持不變；新裝置帳密登入可讀到同一內容；錯誤登入不取代目前 session；並發刷新與切換帳號不能讓舊回應覆寫新 session，舊帳號的列表、預覽、執行紀錄及排程不顯示在新帳號下。並發綁定不能把同一身分改綁另一個帳號。

共享驗收至少涵蓋：A 裝置發布完整 Agent → B 裝置帳密登入或換機碼同步同一版本 → 同仁以 viewer 使用但無法覆寫 → editor 新增版本 → 舊版本回復產生新 revision → 移除成員後不能再下載或續跑。測試使用獨立虛構資料，不以測試成功代替真實 ERP 的操作驗證。
