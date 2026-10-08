# ChaiPhoto-Web

## Android 測試網站部署準備

本分支從 `main` 的 `a0d387023bcae35a5d7df55b5cf3876bb319f640` 建立。Android 網頁、API 與後台共用現有 Worker／D1，但 Android 回報只寫入 `android_feedback`，不讀寫 iOS 的 `feedback` 或 `feedback_tracking`。`BETA-*` 編號及原有 iOS API 不變。

### D1 migration（使用者手動執行）

1. 備份正式 D1，確認目前資料庫結構與 `migrations/0001_create_feedback.sql` 及 Worker 執行時建立的既有欄位相容。
2. 檢查 [0002_android_test.sql](migrations/0002_android_test.sql)。它只新增 `android_feedback`、`android_release`、`android_release_history`、`android_downloads`、`android_installations`、`android_rate_limits` 及索引；不刪表、不修改 iOS 資料或編號。
3. 在正式部署新 Worker **之前**，由你手動執行 `npx wrangler d1 migrations apply DB --remote`，確認 0002 成功。勿透過自動部署流程執行正式 migration。`npm run deploy` 已調整為只部署 Worker，不會套用 migration。
4. 將新 Worker／Static Assets 部署至正式環境；之後檢查下列網址。

本地檢查：`npm run test:android`，使用記憶體 SQLite 套用 0001、0002 並測試隔離、回報查詢、公開欄位、刪除／復原及安裝去重。它不是正式 D1 驗證。

### R2 與環境變數

目前沒有 APK，也沒有已知 R2 bucket 名稱，因此 `wrangler.jsonc` 不預設綁定。準備發布時，請你在 Cloudflare 建立或選定官方私有 R2 bucket，將 `ANDROID_APK_BUCKET` 加入 Worker 的 R2 binding。每個 APK 使用專屬路徑 `android/<版本>/build-<Build>/<SHA-256>.apk`，發布後不要覆蓋該物件；更新版本請使用新路徑。發布用物件必須有 R2 SHA-256 checksum；Worker 在發布及每次下載時都比對 checksum 與檔案大小。若檔案被替換或缺少 checksum，下載會被拒絕。請另外人工驗證 APK 簽章指紋，再在 Android 後台填入版本、Build、R2 路徑、大小、SHA-256、指紋與更新紀錄。簽章私鑰不得提交到 GitHub 或 R2。

Dashboard 沿用原有 Cloudflare Access 應用程式，Worker 現在也會驗證 Access JWT 的簽章、issuer、有效期限及應用程式 audience。部署前由你在 Worker 環境設定 `CF_ACCESS_TEAM_DOMAIN`（例如 `https://<team>.cloudflareaccess.com`）及 `CF_ACCESS_AUD`（該 `/dashboard` Access 應用程式的 Audience Tag）。這兩個值缺少或錯誤時，整個 `/dashboard` 會拒絕存取，包含 iOS 管理；因此必須在部署前設定並於部署後實際登入驗證。不要只填入使用者 Email 標頭，該標頭不再構成授權。Cloudflare Access 原有登入與策略仍需保留。

將 `ANDROID_HASH_SECRET` 設為長而隨機的 Worker Secret。它用於 Android 安裝識別碼與短期 IP 限流鍵的 HMAC，不能放在前端或 Git。Secret 缺少時 Android 回報會保守拒絕；Android 首次開啟 API 回傳 503。現有 iOS API 不依賴此 Secret。`android_rate_limits` 中到期資料可定期刪除（`DELETE FROM android_rate_limits WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`），不影響統計。

### Android App 日後整合

Android App 首次成功啟動時產生並本機保存隨機 UUID，向 `POST /api/android/open` 傳 `{"installationId":"<uuid>"}`。後續啟動用同一 UUID 再傳一次。服務端只儲存加密雜湊值及首次／最後啟動時間；相同安裝不重複計入首次開啟。近 30 天活躍數依最後啟動時間估計。安裝識別碼由 App 重新安裝時重置，因此三種統計都不能當作精確人數。目前沒有 Android App 整合，這兩項安裝數據不應宣稱已有實測值。

### 部署後手動檢查

- `/`：照片、App Store、原有 iOS 回報連結及頁尾 Android 入口。
- `/android`：無 APK 時顯示尚未提供下載；發布後比對版本、大小與驗證資訊。
- `/android/report`：問題、建議、AND 編號、個別查詢與公開進度。
- `/report`：BETA 編號及既有 iOS 流程。
- `/dashboard`：Cloudflare Access 保護、iOS／Android Tab、資料隔離、刪除及復原。
- `/api/android/release`、`/api/android/download`：未發布時不返回假下載。

本地測試使用自產 RSA 簽章與模擬 R2 checksum；正式 Cloudflare Access JWT、JWKS 輪換、R2 物件 checksum 與下載串流仍須在測試或正式環境確認。

正式 Cloudflare Access 規則、D1 實際資料、R2 物件、APK 簽章與 Android App 實機行為需要由你在正式環境核對；本地程式檢查不能代替這些驗證。
