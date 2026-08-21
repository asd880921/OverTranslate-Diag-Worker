# Operating this thing

Day-to-day first, because the setup is done and will not be done again. First-time setup is at the
bottom.

Every command runs from the root of this repository. Both `cmd` and PowerShell are shown where the
syntax differs, because the two disagree about environment variables and it is the first thing that
goes wrong.

繁體中文：[OPERATING.md](OPERATING.md)

---

## Getting the credentials into a shell

Nothing below works without these, and they last only as long as the window stays open. That is on
purpose: an API token in the permanent environment is a token that leaks with a screen share.

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

`CLOUDFLARE_API_TOKEN` is what wrangler reads; `CF_*` is what `tools/fetch-bundle.mjs` reads. They
are the same token.

Where they come from:

- **Token** — https://dash.cloudflare.com/profile/api-tokens, template **Edit Cloudflare Workers**.
  Shown once, so keep it somewhere. It covers both deploying and reading the store.
- **Account id** — `npx wrangler whoami`, or the right-hand column of the Cloudflare dashboard.
- **Namespace id** — already filled in above, and in `wrangler.toml`. It is not a secret.

Check it took:

```
npx wrangler whoami
```

> Do **not** use `npx wrangler login`. The OAuth callback goes to `localhost:8976`, and on this
> machine the browser grants permission while the CLI never hears about it and hangs forever. The
> token above is the working route.

---

## Somebody sent you a report code

```
node tools/fetch-bundle.mjs A3F-7K2
```

Writes `A3F7K2.zip` into the current directory and prints the size, upload time, app version, OS and
expiry. The dash is optional — half the people who retype a code will leave it out.

What is inside, and what to look at:

| File | |
|------|--|
| `environment.txt` | app version, OS, culture, whether verbose logging was on, where things live |
| `appsettings.redacted.json` | their settings; API keys appear as `<redacted:28>`, never in full |
| `logs/app.log` | the current log, plus the numbered older ones |

Paths in `environment.txt` read as `%APPDATA%\...` rather than `C:\Users\<name>\...`. That is
deliberate — the account name is the user's real name often enough that it should not travel — so
two bundles cannot be told apart by it. See "Is this the same person" below.

## Getting a Discord message when someone uploads

Configured, it sends automatically. Not configured, the feature is simply off and the worker
behaves exactly as it did before.

1. In Discord: **Server Settings -> Integrations -> Webhooks -> New Webhook**, pick the channel,
   then **Copy Webhook URL**.
2. Store it as a secret — **not in `wrangler.toml`**, which is in the repository:

   ```
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

   Paste at the prompt and press Enter. The command redeploys by itself.
3. Upload from the app, or POST a real zip at the endpoint, and watch the channel.

The message looks like this:

```
OverTranslate                        今天 23:55
┃
┃  Cloudflare KV Logs
┃
┃  代碼
┃  A3F-7K2
┃
┃  版本          系統               大小
┃  1.4.2        Windows 11 24H2    1.2 MB
┃
┃  取檔
┃  node tools/fetch-bundle.mjs A3F-7K2
┃
┃  30 天後自動刪除
```

**That URL is posting rights**, with nothing else guarding it. If it leaks, delete the webhook on
Discord's side, create a new one, and run `wrangler secret put` again. To turn the whole thing off:

```
npx wrangler secret delete DISCORD_WEBHOOK_URL
```

The message carries the code, version, OS and size — the key metadata and nothing beyond it, so no
IP and no identifier of any kind. **The bundle itself does not go with it**: it is text that was on
somebody's screen, and it stays in the store, where getting it out means running the fetch script.

The version and OS strings come from a client anyone can impersonate, so they go into the message
as code spans, and mentions are switched off for the message — otherwise `@everyone` in a header
would ping the channel.

A failure to send cannot affect an upload: the bundle is already stored by then, and the error only
shows up in `npx wrangler tail`.

## Did anyone upload anything

```
node tools/fetch-bundle.mjs
```

Lists everything still in the store, newest first, with code, upload time, app version, size and
expiry.

Worth running on its own schedule. The report code is a convenience for the reporter — it saves them
attaching a file — but it is not how uploads are found. Somebody who pressed the button and then
never opened a thread, or who quoted the code wrongly, only ever appears here.

## Is this the same person as last time

There is no answer the store can give you. No IP and no identifier is stored with an upload, and the
paths inside the bundle no longer carry the Windows account name.

What is left is circumstantial and inside the bundle: the display topology in the log (monitor device
names, exact resolutions, DPI), and the shape of their settings (hotkeys, colours, capture target).
Enough to form an opinion about "probably the same machine", not enough to rely on.

## Deleting something before its time

Uploads expire on their own after 30 days. To remove one sooner — someone sent a bundle by mistake
and asked:

```
npx wrangler kv key list --namespace-id=%CF_KV_NAMESPACE_ID% --prefix=A3F7K2/ --remote
npx wrangler kv key delete "<the full key>" --namespace-id=%CF_KV_NAMESPACE_ID% --remote
```

(PowerShell: `$env:CF_KV_NAMESPACE_ID` instead of `%CF_KV_NAMESPACE_ID%`.)

**`--remote` is not optional.** Wrangler v4's KV commands work against the local store by default,
the same one `wrangler dev` uses. Without it the listing comes back `[]` and the delete reports
success while the live key sits there untouched. Nothing errors; it quietly operates on an empty
local store. This section exists for the case where somebody uploaded by mistake and asked for it
to come down, which is the last place a silent no-op belongs.

Check with `node tools/fetch-bundle.mjs` afterwards. That script goes through the REST API, so
what it prints is the live store.

---

## Changing the worker

```
npx wrangler deploy
```

**Read the bindings table it prints.** It is the only place a broken binding shows up, and a broken
one here does not fail — it goes quiet:

```
env.BUNDLES (adaebcbe81d94a9bbdb683b2fa0570e0)           KV Namespace
env.RATE_LIMITER (5 requests/60s)                        Rate Limit
```

If `RATE_LIMITER` says **`Unsafe Metadata`** instead of **`Rate Limit`**, the rate limiter is not
running. The deploy still succeeds, `limit()` still answers, and it answers "allowed" every time.
That happens when the binding is declared as `[[unsafe.bindings]]`, which is where it used to live;
it belongs under a top-level `[[ratelimits]]`. This has already caught us once.

Then check it end to end:

```
curl.exe https://overtranslate-diag.overtranslate.workers.dev/
curl.exe -i -X POST -H "content-type: application/zip" --data "hello" https://overtranslate-diag.overtranslate.workers.dev/v1/bundle
```

The first prints the description. The second is refused with 415.

### Do not test the rate limit with a dozen requests

It will not trip, and nothing is wrong. Cloudflare's rate limiting binding caches its counters per
machine within a location and reconciles them asynchronously, so it catches volume and lets a
trickle through. Measured against this deployment: 12 requests over 33 seconds were all allowed;
100 requests had 32 refused. Treat it as a flood gate, not a threshold.

### Working on it locally

```
npx wrangler dev
```

Serves on `http://127.0.0.1:8787` against a **local** KV store, so nothing you do lands in front of a
real report. To point a local build of the app at it, before launching OverTranslate:

```
set OVERTRANSLATE_DIAG_ENDPOINT=http://127.0.0.1:8787/v1/bundle
```

The rate limiting binding does not run under `wrangler dev`. The worker treats it as absent and does
not limit.

To watch the deployed worker instead:

```
npx wrangler tail
```

---

## If the endpoint has to move

The address is compiled into the app, so moving it means shipping a release.

1. Deploy the worker at its new address.
2. Change `DiagnosticUploadService.DefaultEndpoint` in the OverTranslate repository.
3. Ship.

Old builds keep posting to the old address until their users update. Leave the old worker running
until that stops mattering.

An app whose endpoint does not parse as an `http(s)` address falls back to exporting only, and the
button says so. That is the deliberate off switch, and it is also what protects a typo: a mistyped
address turns the feature off rather than sending someone's log wherever that string resolves to.

---

## First-time setup

Kept because a second maintainer, or a rebuild after losing the account, needs it. It has been done
for `overtranslate-diag.overtranslate.workers.dev`.

Prerequisites: a Cloudflare account on the free plan, and Node.js. **No payment method is required**
— that is the whole reason this uses KV rather than R2, see README.md.

1. Get a token into the shell, as above.
2. Create the namespace and note the id it prints:

   ```
   npx wrangler kv namespace create BUNDLES
   ```

3. Put that id — the 32-character hex string, not the title — into `wrangler.toml` as
   `kv_namespaces[0].id`.
4. `npx wrangler deploy`, and check the bindings table as described above.
5. Take the `https://overtranslate-diag.<subdomain>.workers.dev` it prints, add `/v1/bundle`, and put
   it in `DiagnosticUploadService.DefaultEndpoint` in the OverTranslate repository.

There is no step for retention. The worker sets a 30-day expiry on every key as it writes it, so
there is no rule anyone has to remember to add, and no rule that can be dropped in a rebuild.
