# Deploying

Everything below is a one-off. There is no server to keep alive afterwards.

## 0. Prerequisites

- A Cloudflare account (the free plan is enough).
- **R2 must be enabled on that account, which requires a payment method on file** even though the
  usage here stays inside the free allowance (10 GB stored, 1 000 000 writes/month; this endpoint
  sees single-digit uploads a day). This is the only step with a real barrier.
- Node.js, which you already have.

## 1. Sign in

```powershell
npx wrangler login
```

Opens a browser. This is the only interactive step.

## 2. Create the bucket

```powershell
npx wrangler r2 bucket create overtranslate-diagnostics
```

The name must match `bucket_name` in `wrangler.toml`.

## 3. Deploy the worker

```powershell
npx wrangler deploy
```

Wrangler prints the URL it published to:

```
https://overtranslate-diag.<your-subdomain>.workers.dev
```

**Write that host down** — it goes into `DiagnosticUploadService.DefaultEndpoint` in the OverTranslate
repository, with `/v1/bundle` on the end.

## 4. Set the 30-day lifecycle rule

Not expressible in `wrangler.toml`, and not optional — without it the bucket becomes a permanent
pile of other people's screen text.

```powershell
npx wrangler r2 bucket lifecycle add overtranslate-diagnostics `
  --name expire-30d --expire-days 30
```

Then confirm it took:

```powershell
npx wrangler r2 bucket lifecycle list overtranslate-diagnostics
```

If that subcommand is not in your wrangler version, do it in the dashboard instead:
**R2 → overtranslate-diagnostics → Settings → Object lifecycle rules → Add rule → delete objects
30 days after upload**, applied to the whole bucket (empty prefix).

## 5. Check it end to end

```powershell
# Should print the description, not an error
curl.exe https://overtranslate-diag.<your-subdomain>.workers.dev/

# Should be refused with 415: not a zip
curl.exe -X POST --data "hello" https://overtranslate-diag.<your-subdomain>.workers.dev/v1/bundle

# Should return {"code":"XXX-XXX"}
curl.exe -X POST -H "content-type: application/zip" `
  --data-binary "@$env:APPDATA\OverTranslate\diagnostics\<some>.zip" `
  https://overtranslate-diag.<your-subdomain>.workers.dev/v1/bundle
```

## Reading a bundle someone sent you

They give you `A3F-7K2`. Drop the dash and use it as a prefix:

```powershell
npx wrangler r2 object get overtranslate-diagnostics/A3F7K2/<full-key> --file bundle.zip
```

To find the full key, paste `A3F7K2/` into the prefix box in the R2 dashboard —
**R2 → overtranslate-diagnostics → Objects** — which lands on the single object.

## Working on the worker locally

```powershell
npx wrangler dev
```

Serves on `http://127.0.0.1:8787` against a local bucket. To point the app at it instead of
production, set the override before launching OverTranslate:

```powershell
$env:OVERTRANSLATE_DIAG_ENDPOINT = "http://127.0.0.1:8787/v1/bundle"
```

The rate limiting binding does not run under `wrangler dev`; the worker treats it as absent and
does not limit.
