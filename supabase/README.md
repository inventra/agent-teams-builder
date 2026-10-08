# VIXO 雲端資料與權限

這裡提供 migration、SQL 回滾測試與裝置配對 Edge Function。SQL 測試只使用交易內的虛構資料並回滾，不寄信；Edge Function 在有效配對碼兌換時建立或恢復內部 Auth 身分。第一版以 Codex 外掛搭配配對碼連到雲端，不要求使用者操作登入或 M365。

依序套用 `migrations/202610080001_vixo_cloud.sql`、`migrations/202610080002_vixo_device_pairing.sql`、`migrations/202610080003_vixo_runtime_hardening.sql`、`migrations/202610080004_vixo_cas_http_conflict.sql`。使用具備建立 schema／function／policy 權限的 migration 身份；第二檔需要 Supabase 既有的 `auth.role()` 與 `service_role`。`vixo_private` 不加入 PostgREST exposed schemas；公開 API 在 `public`。第三檔是 forward migration：使用即時時鐘核對 capability 到期、限制 file 驗證成本，並在既有 `public.rls_auto_enable` 確實為 event-trigger function 時收回客戶端 EXECUTE，保留 event trigger。第四檔只將業務 CAS 衝突改用自訂 HTTP SQLSTATE `PT409`，保留鎖行、版本與 ACL。

## 存取與版本契約

- `vixo_workspaces`、`vixo_members`、`vixo_assets`、`vixo_asset_revisions` 只授 `authenticated` SELECT。所有客戶端寫入經 security definer RPC，固定空 `search_path` 並由 `auth.uid()` 取得身份；匿名不具有表格讀寫或 RPC 執行權限。
- 私人資產僅 owner 可讀寫；團隊成員可讀，owner／editor 可儲存，viewer 無寫入權限。團隊權限依當下 membership，原建立者被移除也不能讀寫原團隊資產。membership 的私有 helper 避免遞迴 RLS。
- `vixo_create_workspace(p_name)` 回傳 workspace。`vixo_create_invite(p_workspace_id,p_role='viewer')` 僅 owner，回傳 `{code,expires_at}`；role 可為 editor／viewer，不能另建 owner。`vixo_join_workspace(p_code)` 回傳 workspace。`vixo_remove_member(p_workspace_id,p_user_id)` 僅 owner，回傳 `{removed}`，不能移除 owner。
- `vixo_save_asset` 接收既定的 `p_id/p_kind/p_slug/p_title/p_description/p_bundle/p_workspace_id/p_expected_revision/p_message` 並回傳完整 asset。新增用 `p_id=null,p_expected_revision=0`；更新必須傳回原 workspace（私人為 null）及當前 revision。鎖住 asset 後執行 CAS；不符會回 SQLSTATE **PT409**、message **revision_conflict**，由 PostgREST 直接回 HTTP 409。客戶端應重新取得版本，不能自動蓋掉他人修改。舊的 001–003 使用 40001；它是資料庫 serialization error，不能拿來代表業務衝突。[PostgREST 官方錯誤說明](https://docs.postgrest.org/en/v16/references/errors.html#raise-errors-with-http-status-codes)
- 每次儲存原子追加一筆 revision。kind、owner、workspace 不可變；restore 由客戶端讀取舊 revision.bundle 後以當前 revision 再 save，產生新版本。舊 revisions 有防更新／刪除 trigger。未提供 archive、workspace 刪除或 owner 轉移 RPC。
- slug 使用 1–128 字元的小寫 ASCII 字母／數字／`_`／`-`，同一 owner 的私人或同一 workspace 的同 kind／slug 不可重複。workspace name 上限 120 字元；title 1–200 字元且不含首尾空白；description 上限 4000、revision message 上限 2000。

## Bundle

bundle 必須為 JSON object，具有 `formatVersion:1`、與資產相同的 `kind`、`spec` object、`files` array、`dependencies` array、`requirements` object。`files` 最多 1000 項以限制驗證成本，每項為 `{path,content}` 文字欄位；path 必須為不重複的相對 POSIX 路徑，禁止 `..`／`.` 段、絕對路徑、Windows drive／反斜線與空段。內部 Agent／Skill／Workflow spec 的細節由外掛驗證，SQL 不猜測其格式。

上限 **5 MiB（5,242,880 bytes）**，以 PostgreSQL `jsonb::text` 序列化後的 UTF-8 bytes 判定。這是單份 bundle 的上限；每個 immutable revision 各自保存快照。不得放入憑證、token、原影片、銀行資料、執行 journal 或客戶私密畫面；SQL 的形狀驗證不代替客戶端的內容審查。

## 邀請與配對

邀請採 32-byte 隨機資料轉成 64 hex 字元，只保存 SHA-256 hash，預設 **7 天／10 次**。`authenticated` 完全不能 SELECT `vixo_invites`。兌換時鎖 invite／workspace 行；同一成員重複加入不耗次數，也不因另一個較高權限邀請而升權。移除 membership 是撤銷當下存取，並不是永久封鎖；仍掌握有效且未耗盡邀請碼的人可重新加入。需要永久封鎖或個別邀請撤銷時，應另定契約，不用改 owner／viewer 的判斷來代替。

`vixo_create_device_code()` 僅 authenticated，綁定自己的 `auth.uid()`，回傳 `{code,expires_at}`，期限 **10 分鐘**；沒有可以指定另一個 user_id 的參數。`vixo_device_codes` 不開放任何 authenticated／anon 讀寫。

`vixo_claim_device_code(p_code)` 與 `vixo_claim_invite(p_code,p_user_id)` **僅 service_role 可執行**，並檢查 `auth.role()`。前者鎖行一次兌換，回傳 `{user_id}`；user_id 為 null 時代表 Edge／root 預先產生的 bootstrap capability，SQL 不建立 auth user。後者只替服務端指定、已存在的 auth user 兌換邀請，保留邀請角色並耗次，不建立帳戶或寄信。claim 失敗要由 Edge 回報／處理，不能因失敗自動建立身份。

service_role 可 SELECT／INSERT `vixo_device_codes`，供 Edge／root 預先保存 hash 與期限；不能直接 UPDATE claimed_at，須使用 claim RPC。service_role 可讀取邀請 hash／期限做服務端 preflight，兌換時仍由 RPC 原子檢查。service-role key 只留在 Edge／服務端，不傳給外掛、Dashboard、瀏覽器或 bundle。

## 回滾測試

`tests/rls-rpc.sql`、`tests/device-pairing.sql`、`tests/runtime-hardening.sql`、`tests/cas-http-conflict.sql` 自行 BEGIN／ROLLBACK，只使用隨機 UUID 與虛構資料；驗證私人隔離、匿名拒絕、viewer／editor 差異、CAS／還原歷史、scope 不變、撤權、bundle／路徑 gate、一次配對、service-only claim 與 invite 使用上限。hardening 測試額外覆蓋同一交易開始後才到期的 capability、1000／1001 檔案邊界及既有平台 helper ACL。CAS HTTP 測試嚴格要求 `PT409/revision_conflict`，一般 RLS 測試兼容舊的 40001 與新的 PT409。以 migration 管理身份執行，`ON_ERROR_STOP` 使任一斷言失敗立即報錯。

```text
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/rls-rpc.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/device-pairing.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/runtime-hardening.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/cas-http-conflict.sql
```

`tests/local-bootstrap.sql` **只給一次性的本機 PostgreSQL cluster**，模擬 Supabase auth schema／角色與寬鬆的 public 預設授權。不能套用到 Supabase；在本機依序執行 bootstrap、四個 migrations、四份回滾測試。回滾測試都是純 SQL，可直接交給 SQL Editor 或 Supabase execute，保留 BEGIN／ROLLBACK 與全部斷言。
