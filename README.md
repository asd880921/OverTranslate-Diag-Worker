# overtranslate-diag-worker

The endpoint behind the **Export and upload diagnostics** button in
[OverTranslate](https://github.com/asd880921/OverTranslate).

It is a Cloudflare Worker in front of an R2 bucket, and it does one thing: accept a diagnostic zip,
store it under an unguessable name, and return a short code. The user pastes that code into a forum
thread instead of hunting for a file to attach.

This repository is public on purpose. The button sends a log that can contain text that was on
someone's screen, and "trust me, it only keeps it for a month" is worth less than being able to read
the thirty lines that decide it.

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
| 429 | more than five uploads a minute from one IP |

## What it stores

One object per upload, at `<CODE>/<timestamp>-<random>.zip`, with metadata recording the code, the
upload time, the reported app version and OS, and the size.

**No IP address is stored, and there is no identifier that could link two uploads to the same
person.** The client IP is used for rate limiting inside a single request and is never written down.

The code leads the key so that pasting it into R2's prefix filter finds the object; the random tail
is what stops the key being guessable from the code. There is no route that reads from the bucket —
the code is an index for the maintainer, not a URL, and retrieving a bundle means signing in to
Cloudflare.

## What it deletes

A lifecycle rule deletes every object 30 days after upload. See `DEPLOY.md`.

## What it deliberately does not do

- No automatic upload and no crash reporting. Bytes leave a machine only because a person pressed a
  button on it.
- No accounts, no sessions, no upload history, no "the one I sent last time".
- No download or browse route.

## Deploying

See [DEPLOY.md](DEPLOY.md).
