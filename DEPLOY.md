# Deploying

Everything below is a one-off. There is no server to keep alive afterwards, and no payment method on
the account — see the note in README.md about why this uses KV rather than R2.

## 0. Prerequisites

- A Cloudflare account on the free plan.
- Node.js, which you already have.

## 1. Sign in

```powershell
npx wrangler login
```

Opens a browser. This is the only interactive step.

## 2. Point wrangler.toml at the namespace

If the namespace does not exist yet:

```powershell
npx wrangler kv namespace create BUNDLES
```

Either way, get its id:

```powershell
npx wrangler kv namespace list
```

Put that id — the 32-character hex string, not the title — into `wrangler.toml`, replacing
`REPLACE_WITH_NAMESPACE_ID`.

## 3. Deploy

```powershell
npx wrangler deploy
```

Wrangler prints the URL it published to:

```
https://overtranslate-diag.<your-subdomain>.workers.dev
```

**Write that host down** — it goes into `DiagnosticUploadService.DefaultEndpoint` in the
OverTranslate repository, with `/v1/bundle` on the end.

## 4. Check it end to end

```powershell
$host_ = "https://overtranslate-diag.<your-subdomain>.workers.dev"

# Should print the description, not an error
curl.exe $host_/

# Should be refused with 415: not a zip
curl.exe -i -X POST -H "content-type: application/zip" --data "hello" $host_/v1/bundle

# Should return {"code":"XXX-XXX"}
curl.exe -X POST -H "content-type: application/zip" `
  --data-binary "@$env:APPDATA\OverTranslate\diagnostics\<some>.zip" $host_/v1/bundle
```

There is no step for retention: the worker sets a 30-day expiry on each key as it writes it. To see
it, list the keys after an upload — `expiration` is a Unix timestamp 30 days out.

## Reading a bundle someone sent you

They quote `A3F-7K2`.

```powershell
$env:CF_ACCOUNT_ID      = "..."   # dashboard, right-hand column
$env:CF_KV_NAMESPACE_ID = "..."   # npx wrangler kv namespace list
$env:CF_API_TOKEN       = "..."   # a token with Workers KV Storage:Read

node tools/fetch-bundle.mjs A3F-7K2
```

Writes `A3F7K2.zip` into the current directory and prints what the metadata says about it.

`npx wrangler kv key get` is the obvious alternative and is the wrong tool here: it writes the value
to stdout, and a zip that goes through PowerShell's redirection comes out re-encoded.

## Working on the worker locally

```powershell
npx wrangler dev
```

Serves on `http://127.0.0.1:8787` against a local KV store rather than the deployed one, so nothing
you do here lands in front of a real report. To point a local build of the app at it:

```powershell
$env:OVERTRANSLATE_DIAG_ENDPOINT = "http://127.0.0.1:8787/v1/bundle"
```

The rate limiting binding does not run under `wrangler dev`; the worker treats it as absent and does
not limit.
