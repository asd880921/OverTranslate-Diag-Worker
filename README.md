# OverTranslate-Diag-Worker

The endpoint behind the **Export and upload diagnostics** button in
[OverTranslate](https://github.com/asd880921/OverTranslate).

It is a Cloudflare Worker in front of a Workers KV namespace, and it does one thing: accept a
diagnostic zip, store it under an unguessable name, and return a short code. The user quotes that
code in a forum thread instead of hunting for a file to attach.

This repository is public on purpose. The button sends a log that can contain text that was on
someone's screen, and "trust me, it only keeps it for a month" is worth less than being able to read
the hundred lines that decide it.

## Why KV and not R2

R2 is the obvious store for a five-megabyte blob and this is not using it, so the reason should be
on the record: **R2 requires a payment method on the Cloudflare account even within its free
allowance.** This endpoint exists so that reporting a bug costs nobody anything, and that had to
include the person running it.

KV's ceilings sit an order of magnitude above what this needs — 25 MiB a value against a 5 MB cap,
a thousand writes a day against single-digit uploads — and its per-key expiry replaces the R2
lifecycle rule with something that cannot be forgotten, because it is set by the same line that
writes the value.

What is given up is the ability to click a bundle out of a storage browser. That is what
`tools/fetch-bundle.mjs` is for.

## What it accepts

```
POST /v1/bundle
content-type: application/zip
x-overtranslate-version: 1.2.3      (optional, recorded as metadata)
x-overtranslate-os: Windows 11 ...  (optional, recorded as metadata)

<zip bytes, at most 5 MB>
```

```json
{ "code": "A3F-7K2" }
```

Anything else is refused:

| Status | When |
|--------|------|
| 404 | any path other than `/v1/bundle` (`GET /` returns a plain-text description) |
| 405 | `/v1/bundle` with a method other than POST |
| 411 | no `Content-Length` |
| 413 | body larger than 5 MB, declared or actual |
| 415 | the body does not begin with a zip's `PK\x03\x04` header |
| 429 | sustained uploads from one IP — see below |

## What it stores

One key per upload, at `<CODE>/<timestamp>-<random>`, with metadata recording the code, the upload
time, the reported app version and OS, and the size.

**No IP address is stored, and there is no identifier that could link two uploads to the same
person.** The client IP is used for rate limiting within a single request and is never written down.

## What the rate limit actually does

It is configured at five requests a minute per IP, and it should be read as a flood guard rather
than a threshold. Measured against the deployed worker: a hundred requests from one address had a
third refused, while a dozen spread over half a minute had none. Cloudflare's rate limiting binding
caches its counters per machine within a location and reconciles them asynchronously, which is
documented and is why it behaves this way.

That is the right shape for this endpoint. A client sends one request per button press and must
never be turned away; what is worth stopping is the volume that would fill the store.

The code leads the key so that listing by it as a prefix lands on the one entry; the random tail is
what stops the key being guessable from the code. There is no route that reads from the store — the
code is an index for the maintainer, not a URL, and retrieving a bundle means holding an API token
for this account.

## What it deletes

Every key is written with a 30-day expiry. Nothing has to be run, and no rule has to have been
remembered, for an upload to go away.

## What it deliberately does not do

- No automatic upload and no crash reporting. Bytes leave a machine only because a person pressed a
  button on it.
- No accounts, no sessions, no upload history, no "the one I sent last time".
- No download or browse route.

## Running it

See [OPERATING.md](OPERATING.md) — reading a bundle somebody sent, seeing what has been uploaded,
redeploying, and first-time setup.
