# 維運說明

日常操作寫在前面，因為架設已經做完、不會再做第二次。首次架設放在最後。

所有指令都在這個倉的根目錄執行。環境變數的寫法 `cmd` 與 PowerShell 不同，兩種都列出來——這是最常出錯的第一步。

English: [OPERATING.en.md](OPERATING.en.md)

---

## 先把憑證放進 shell

底下每件事都需要這些變數，而且它們只在這個視窗裡有效。這是刻意的：放進系統環境變數的 API Token，是一顆會隨著螢幕分享外流的 Token。

**cmd**

```
cd /d C:\Users\asd88\Desktop\Code\OverTranslate-Diag-Worker
set CLOUDFLARE_API_TOKEN=<token>
set CF_API_TOKEN=%CLOUDFLARE_API_TOKEN%
set CF_ACCOUNT_ID=<account id>
set CF_KV_NAMESPACE_ID=adaebcbe81d94a9bbdb683b2fa0570e0
```

**PowerShell**

```powershell
cd C:\Users\asd88\Desktop\Code\OverTranslate-Diag-Worker
$env:CLOUDFLARE_API_TOKEN = "<token>"
$env:CF_API_TOKEN         = $env:CLOUDFLARE_API_TOKEN
$env:CF_ACCOUNT_ID        = "<account id>"
$env:CF_KV_NAMESPACE_ID   = "adaebcbe81d94a9bbdb683b2fa0570e0"
```

`CLOUDFLARE_API_TOKEN` 是 wrangler 讀的，`CF_*` 是 `tools/fetch-bundle.mjs` 讀的。同一顆 Token。

從哪裡拿：

- **Token** — https://dash.cloudflare.com/profile/api-tokens ，範本選 **Edit Cloudflare Workers**。
  只會顯示一次，記得存起來。部署與讀取儲存空間都靠它。
- **Account ID** — `npx wrangler whoami`，或 Cloudflare dashboard 右側欄。
- **Namespace ID** — 上面已經填好了，`wrangler.toml` 裡也有。它不是機密。

確認有生效：

```
npx wrangler whoami
```

> **不要用 `npx wrangler login`。** OAuth 回呼會打到 `localhost:8976`，在這台機器上瀏覽器會顯示授權成功，
> 但 CLI 永遠收不到那個回呼、就這樣一直卡著。上面那條 Token 路線才是能走的。

---

## 有人給了你一組回報代碼

```
node tools/fetch-bundle.mjs A3F-7K2
```

會在當前目錄產出 `A3F7K2.zip`，並印出大小、上傳時間、App 版本、作業系統與到期日。中間那個破折號可加可不加——會自己重打代碼的人有一半不會打它。

裡面有什麼、該看什麼：

| 檔案 | |
|------|--|
| `environment.txt` | App 版本、作業系統、語言、當時有沒有開詳細記錄、各項路徑 |
| `appsettings.redacted.json` | 他的設定；API 金鑰會顯示成 `<redacted:28>`，不會有內容 |
| `logs/app.log` | 目前的記錄檔，編號的是較舊的 |

`environment.txt` 裡的路徑會是 `%APPDATA%\...` 而不是 `C:\Users\<帳號>\...`。這是刻意的——Windows 帳號名有相當高的比例就是本人姓名，不該跟著檔案跑——代價是**沒辦法靠它判斷兩包是不是同一個人**，見下面那節。

## 到底有沒有人上傳

```
node tools/fetch-bundle.mjs
```

列出儲存空間裡還在的每一筆，最新的在最上面，含代碼、上傳時間、App 版本、大小與到期日。

**值得定期自己跑一次。** 回報代碼是給回報者方便用的——省得他附檔案——但它不是找到上傳的途徑。那些按了上傳卻從來沒開串的人、或代碼抄錯的人，只會出現在這份清單裡。

## 這是不是上次那個人

儲存空間答不出來。上傳不存 IP、也沒有任何識別碼，包裡的路徑也不再帶 Windows 帳號名。

剩下的線索都在包裡而且是旁證：log 裡的顯示器快照（裝置名稱、精確解析度、DPI），以及設定的形狀（快捷鍵、配色、擷取目標）。足以形成「大概是同一台機器」的判斷，不足以當根據。

## 提前刪掉某一包

上傳的檔案 30 天後會自己過期。若要提早移除——例如有人誤傳並要求撤下：

```
npx wrangler kv key list --namespace-id=%CF_KV_NAMESPACE_ID% --prefix=A3F7K2/
npx wrangler kv key delete "<完整的 key>" --namespace-id=%CF_KV_NAMESPACE_ID%
```

（PowerShell 請把 `%CF_KV_NAMESPACE_ID%` 換成 `$env:CF_KV_NAMESPACE_ID`。）

---

## 修改 Worker 之後

```
npx wrangler deploy
```

**一定要看它印出來的 bindings 表。** 那是壞掉的 binding 唯一會現形的地方，而且它壞掉不會報錯——它會安靜地失效：

```
env.BUNDLES (adaebcbe81d94a9bbdb683b2fa0570e0)           KV Namespace
env.RATE_LIMITER (5 requests/60s)                        Rate Limit
```

如果 `RATE_LIMITER` 顯示的是 **`Unsafe Metadata`** 而不是 **`Rate Limit`**，代表限流器根本沒在跑。部署照樣成功、`limit()` 照樣有回應，而且每次都回「放行」。原因是 binding 被宣告成 `[[unsafe.bindings]]`（那是它以前的位置），現在應該寫在頂層的 `[[ratelimits]]`。**這個坑已經害我們白測過一輪。**

接著做端對端檢查：

```
curl.exe https://overtranslate-diag.overtranslate.workers.dev/
curl.exe -i -X POST -H "content-type: application/zip" --data "hello" https://overtranslate-diag.overtranslate.workers.dev/v1/bundle
```

第一行會印出說明文字，第二行會被以 415 拒絕。

### 不要用十來發請求去測限流

**打不出反應，而且不代表壞了。** Cloudflare 的限流 binding 是每台機器本地計數、非同步同步的，所以它擋得住洪水、放得過涓流。針對這個部署實測過：12 發散在 33 秒內——全部放行；100 發連續——擋掉 32 發。把它當成洪水閘門，不是精確門檻。

### 在本機開發

```
npx wrangler dev
```

服務跑在 `http://127.0.0.1:8787`，對應的是**本機的** KV，所以在這裡做什麼都不會擋在真實回報前面。要讓本機建置的 App 指向它，啟動 OverTranslate 之前：

```
set OVERTRANSLATE_DIAG_ENDPOINT=http://127.0.0.1:8787/v1/bundle
```

限流 binding 在 `wrangler dev` 底下不會運作，Worker 會當它不存在、不做限制。

想看線上那隻的即時記錄：

```
npx wrangler tail
```

---

## 如果端點要搬家

位址是編進 App 的，所以搬家等於要發一版。

1. 在新位址部署 Worker。
2. 改 OverTranslate 倉的 `DiagnosticUploadService.DefaultEndpoint`。
3. 發版。

**舊版使用者會繼續打舊位址**，直到他們更新為止。舊的 Worker 要留到那件事不再重要為止。

若 App 拿到的端點無法解析成 `http(s)` 位址，它會退回成只匯出不上傳，按鈕文字也會跟著變。這是刻意留的開關，同時也是打錯字時的保險：位址寫錯會讓功能關閉，而不是把某人的記錄檔送到那串字碰巧解析到的地方。

---

## 首次架設

保留這節是為了換人接手，或帳號沒了要重建。針對 `overtranslate-diag.overtranslate.workers.dev` 這次已經做完了。

前提：一個免費方案的 Cloudflare 帳號，以及 Node.js。**不需要綁定付款方式**——這正是這裡用 KV 而不用 R2 的全部理由，見 README.md。

1. 依照最前面那節把 Token 放進 shell。
2. 建立 namespace，記下它印出來的 id：

   ```
   npx wrangler kv namespace create BUNDLES
   ```

3. 把那個 id——32 位十六進位字串，不是標題——填進 `wrangler.toml` 的 `kv_namespaces[0].id`。
4. `npx wrangler deploy`，並依照前面所述檢查 bindings 表。
5. 把它印出的 `https://overtranslate-diag.<子網域>.workers.dev` 加上 `/v1/bundle`，填進 OverTranslate 倉的 `DiagnosticUploadService.DefaultEndpoint`。

**沒有設定保存期限這一步。** Worker 在寫入每一筆 key 的同時就設好 30 天過期，所以沒有規則需要有人記得去加，也沒有規則會在重建時被漏掉。
