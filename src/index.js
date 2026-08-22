/**
 * OverTranslate diagnostic bundle receiver.
 *
 * The whole service is one idea: take a zip somebody pressed a button to send, store it under a
 * name nobody can guess, and hand back a short code they can paste into a forum thread. There is no
 * account, no session and no download route — the code is an index for the maintainer, not a URL.
 *
 * The store is Workers KV rather than R2. KV is not what one would reach for to hold a five-megabyte
 * blob, and the reason it is here is worth stating plainly: R2 requires a payment method on the
 * account even inside its free allowance, and this endpoint exists so that reporting a bug costs
 * nobody anything. KV's ceilings — 25 MiB a value, a thousand writes a day — sit an order of
 * magnitude above what a handful of bug reports a day needs, and its per-key expiry does the job the
 * R2 lifecycle rule would have had to be remembered for.
 *
 * Nothing here runs unless a person pressed the button in the app. There is no automatic upload and
 * no crash reporter, by design: verbose logging puts text that was on the user's screen into the
 * log, and that is precisely the log worth sending, so the sending has to stay a deliberate act.
 */

/** Bigger than any bundle measured so far, small enough that abuse costs the sender something. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Crockford's base32: no I, L, O or U, so the code survives being read aloud down a phone line or
 * retyped from a screenshot without 1/I and 0/O turning into each other.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 32^6 ≈ 1.07e9 — long enough not to collide, short enough to say in one breath. */
const CODE_LENGTH = 6;

/**
 * Thirty days, in seconds. Set on each key as it is written rather than as a rule over the store, so
 * an upload cannot outlive it by having arrived before somebody remembered to add the rule.
 */
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** "PK\x03\x04" — the local file header every real zip starts with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** What the browser gets, because someone will paste this URL in to see what it is. */
const ABOUT =
  "OverTranslate diagnostic bundle receiver.\n" +
  "\n" +
  "It accepts one thing: a POST of a diagnostic zip, sent because a user pressed Upload in the\n" +
  "app's settings. It returns a short code. It cannot be read from — there is no download route.\n" +
  "Uploads are deleted automatically after 30 days.\n" +
  "\n" +
  "Source: https://github.com/asd880921/OverTranslate-Diag-Worker\n";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return text(200, ABOUT);
    }

    if (url.pathname !== "/v1/bundle") {
      return json(404, { error: "not_found" });
    }

    if (request.method !== "POST") {
      // Allow is required on a 405 and is genuinely useful here: it says the route exists and this
      // is the only thing it does.
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    // Before reading a byte. The point of a limit is not to be reached, and the cheapest place to
    // refuse an oversized body is the one where it has not been transferred yet.
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isFinite(declared) || declared <= 0) {
      return json(411, { error: "length_required" });
    }
    if (declared > MAX_BYTES) {
      return json(413, { error: "too_large", limit: MAX_BYTES });
    }

    if (await isRateLimited(env, request)) {
      return json(429, { error: "rate_limited" }, { "retry-after": "60" });
    }

    const body = new Uint8Array(await request.arrayBuffer());

    // Re-checked against what actually arrived: content-length is the sender's claim about the
    // sender's own body, and this endpoint is open to anyone.
    if (body.byteLength > MAX_BYTES) {
      return json(413, { error: "too_large", limit: MAX_BYTES });
    }
    if (!looksLikeZip(body)) {
      return json(415, { error: "not_a_zip" });
    }

    const code = await allocateCode(env.BUNDLES);
    if (!code) {
      return json(503, { error: "code_exhausted" });
    }

    const now = new Date();
    // The code leads the key so that listing by it as a prefix lands on the one entry; the random
    // tail is what stops the key itself being guessable from the code.
    const key = `${code}/${stamp(now)}-${randomHex(8)}.zip`;

    // Still no IP address, and still nothing derived from the machine or the person. What there is
    // now is `id`: a random value the app issues itself on first launch and keeps in its settings,
    // which says that two reports came from the same install and says nothing else at all. It
    // cannot be read backwards to anyone, it changes if they reinstall, and the user can see it in
    // the settings file that ships inside their own bundle.
    //
    // It is here because the alternative was worse. A second report from someone already being
    // helped used to arrive indistinguishable from a stranger's, so the maintainer either asked
    // them to identify themselves — which is a real name in a forum thread, and worse than a random
    // number by a distance — or answered the same first questions again.
    //
    // Absent on any build older than the one that started sending it, and that stays a working
    // state rather than a broken one: see how the notification renders it.
    //
    // Metadata comes back with a key listing without the value being read, which is what makes
    // finding one bundle among a month of them a listing rather than a run of downloads. The same
    // few fields are all the notification below carries, for the same reason.
    const metadata = {
      code,
      uploadedAt: now.toISOString(),
      id: header(request, "x-overtranslate-id"),
      appVersion: header(request, "x-overtranslate-version"),
      os: header(request, "x-overtranslate-os"),
      bytes: body.byteLength,
    };

    await env.BUNDLES.put(key, body, { expirationTtl: RETENTION_SECONDS, metadata });

    // After the put, and outside the response: the bundle is stored by this point, so whether a
    // chat service answered is not something the person reporting a bug should wait for or hear
    // about.
    ctx.waitUntil(notify(env, metadata));

    return json(200, { code: format(code) });
  },
};

/**
 * Per-IP, using the Workers rate limiting binding so there is no extra namespace or Durable Object
 * to provision.
 *
 * Permissive by design, and measured to be so: a hundred requests from one address got a third of
 * them refused, while a dozen spread over half a minute got none. The counters are cached per
 * machine within a location and reconciled asynchronously, so this catches a flood and does not
 * catch a trickle. That is the right shape for what it guards — the honest client sends one request
 * per button press and must never be refused, and what is worth stopping is the volume that would
 * fill the store, not the eleventh request.
 *
 * An absent binding means no limit rather than no service: an endpoint that stops accepting bug
 * reports over its own limiter is worse than one that is briefly floodable, and the size cap plus
 * KV's own write quota still bound the damage. The binding not arriving is a real failure mode
 * rather than a hypothetical — see the note in wrangler.toml about the two spellings.
 */
async function isRateLimited(env, request) {
  if (!env.RATE_LIMITER) return false;

  // The docs advise against keying on an address because users share them. Here there is nothing
  // else to key on: no account, no session, no installation id — and adding one to improve a rate
  // limit would mean giving every reporter an identifier they did not have before.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}

/**
 * Says in Discord that an upload landed, so that finding out one did stops depending on the
 * maintainer remembering to run the listing. `tools/fetch-bundle.mjs` with no arguments is still
 * the answer to "what is in the store" — this is a nudge, not a record of anything.
 *
 * An absent binding means no notification rather than no service, and so does a refusal from
 * Discord: the same reasoning as the rate limiter, one step further along. By the time this runs
 * the bundle is stored and listable, and nothing here can change the response the uploader gets.
 *
 * What the message carries is exactly what the key metadata carries. The bundle does not go with
 * it: it is text that was on somebody's screen, and it stays in the store, where getting it out is
 * a deliberate act rather than something that lands in a chat client's cache on several machines.
 */
async function notify(env, metadata) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const payload = {
    // Overrides the name Discord shows against the message. Without it every notification arrives
    // under whatever the webhook happened to be called in the channel settings, which is a name
    // nobody chose for this purpose and can be changed from Discord without anyone here knowing.
    username: "OverTranslate",
    // avatar_url: "https://example.com/overtranslate.png",

    embeds: [
      {
        title: "Cloudflare KV Logs",
        color: 0x5865f2,

        // The identifier leads, and the code follows it, because between them they are what decides
        // whether this message needs opening at all: a familiar identifier turns a new report into
        // the next message in a conversation, and the code is what every reply about it quotes.
        //
        // `inline` is what puts fields side by side, three to a row, and neither of these two takes
        // it. Fifty-one characters do not fit a third of an embed — sharing a row with the code they
        // wrapped onto three lines, which is harder to compare at a glance than the one thing anyone
        // does with an identifier deserves.
        //
        // The command is a field rather than the embed's `description` for the same reason the two
        // above are not: a description always renders above every field, and none of the three
        // belongs at the very top.
        fields: [
          { name: "ID", value: identity(metadata.id) },
          { name: "回報代碼", value: inline(format(metadata.code)) },
          { name: "版本", value: inline(metadata.appVersion), inline: true },
          { name: "系統", value: inline(metadata.os), inline: true },
          { name: "大小", value: size(metadata.bytes), inline: true },
          {
            name: "取檔",
            value: inline(`node tools/fetch-bundle.mjs ${format(metadata.code)}`),
          },
        ],

        // Worth the line it takes: it says this is a thing that expires rather than an archive,
        // which is the difference between reading a report next week and finding it gone.
        footer: { text: "30 天後自動刪除" },

        // The upload's own time rather than the moment Discord received the message. They are
        // normally a second apart, and are not when a retry or a slow queue put them further so.
        timestamp: metadata.uploadedAt,
      },
    ],

    // The version and OS strings arrived in headers from a client anyone can impersonate. They
    // are stripped to printable ASCII on the way in, which still leaves `@everyone` — so they go
    // in as code spans, and mentions are switched off for the message as a whole rather than that
    // escaping being the only thing between a bug report and a ping to everyone in the channel.
    allowed_mentions: { parse: [] },
  };

  try {
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Nothing to be done about a failure except leave it where `wrangler tail` will show it.
    if (!response.ok) console.warn(`discord webhook: ${response.status}`);
  } catch (error) {
    console.warn(`discord webhook: ${error}`);
  }
}

/**
 * The install identifier, or the word for there not being one.
 *
 * "None" rather than the dash every other empty field gets, because this blank means something the
 * others do not: the upload came from a build made before the app had an identifier to send. That
 * is a fact about the client worth reading at a glance — it dates the report on its own — where a
 * dash would read as a value that went missing. Plain text rather than a code span for the same
 * reason: it is this message's own word, not the client's.
 */
function identity(value) {
  return value ? inline(value) : "None";
}

/** A code span, with the one character that could break out of it taken out. */
function inline(value) {
  return value ? `\`${value.replace(/`/g, "'")}\`` : "—";
}

/**
 * Bytes below a kilobyte rather than a rounded-down `0 KB`, which reads as a bug at exactly the
 * moment the number matters: a real bundle is megabytes, so anything this small is a test upload or
 * a zip with nothing in it, and the actual count is what says which.
 */
function size(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A code nothing is stored under yet. Collisions at a billion codes and a handful of uploads a day
 * are theoretical, but the check is one listing and the alternative is silently filing two different
 * users' bundles under one code.
 *
 * KV listings are eventually consistent, so this can miss a write from the last few seconds. That is
 * accepted rather than worked around: closing it would mean reaching for a strongly consistent
 * store, and the window it leaves is two uploads landing on the same one-in-a-billion code within a
 * minute of each other.
 */
async function allocateCode(store) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const existing = await store.list({ prefix: `${code}/`, limit: 1 });
    if (existing.keys.length === 0) return code;
  }
  return null;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    // 256 is a whole multiple of 32, so the modulo is uniform.
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

function randomHex(byteCount) {
  return [...crypto.getRandomValues(new Uint8Array(byteCount))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** "A3F7K2" reads as one word; "A3F-7K2" reads as something to copy down. */
function format(code) {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function looksLikeZip(bytes) {
  return (
    bytes.byteLength > ZIP_MAGIC.length &&
    ZIP_MAGIC.every((expected, index) => bytes[index] === expected)
  );
}

/**
 * Header values end up in object metadata, so they are trimmed to something printable and short.
 * They come from a client anyone can impersonate; they are a hint when reading a report, never a
 * credential.
 */
function header(request, name) {
  const raw = request.headers.get(name) ?? "";
  return raw.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function text(status, payload) {
  return new Response(payload, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
