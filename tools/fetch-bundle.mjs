#!/usr/bin/env node
/**
 * Lists what has been uploaded, or pulls one bundle down by the code the user quoted.
 *
 *   node tools/fetch-bundle.mjs            every bundle still in the store, newest first
 *   node tools/fetch-bundle.mjs A3F-7K2    download that one
 *
 * The listing is the point of having both modes. A code is a convenience for the reporter — it saves
 * them attaching a file — but it is not how uploads are found, and a report that arrives with no
 * code at all, or a user who pressed the button and then never came back, still has to be visible.
 * That is also the honest reading of the privacy policy: whoever holds this account can see every
 * upload, and the code is an index rather than a lock.
 *
 * This exists rather than a download route on the worker. A route would have to be guarded by a
 * secret, and a public URL that will hand over any bundle to whoever holds a token is a worse thing
 * to own than a script that runs on the maintainer's machine with the maintainer's credentials.
 *
 * `wrangler kv key get` would nearly do the job, but it writes the value to stdout, and a zip that
 * goes through a shell's redirection comes out the other side re-encoded on Windows. The REST API
 * hands back bytes.
 *
 * Needs three environment variables:
 *
 *   CF_ACCOUNT_ID        Cloudflare dashboard, right-hand column
 *   CF_KV_NAMESPACE_ID   `npx wrangler kv namespace list`
 *   CF_API_TOKEN         a token with Workers KV Storage:Read on this account
 */

import { writeFile } from "node:fs/promises";

const API = "https://api.cloudflare.com/client/v4";

const missing = ["CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_API_TOKEN"].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  fail(`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
}

const base =
  `${API}/accounts/${process.env.CF_ACCOUNT_ID}` +
  `/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
const auth = { authorization: `Bearer ${process.env.CF_API_TOKEN}` };

const argument = process.argv[2];

if (argument === undefined) {
  await list();
} else {
  // Accepted with or without the dash, because the dash is a reading aid printed by the app, and
  // half the time somebody retypes the code they will leave it out.
  const code = argument.toUpperCase().replace(/-/g, "");
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) {
    fail("Usage: node tools/fetch-bundle.mjs [A3F-7K2]");
  }
  await download(code);
}

/** Everything in the store, newest first. */
async function list() {
  const entries = await keys();
  if (entries.length === 0) {
    console.log("Nothing uploaded. (Bundles are deleted 30 days after upload.)");
    return;
  }

  // Newest first: the reason to run this without a code is almost always "did anything come in", and
  // the answer to that is at the top.
  entries.sort((a, b) => uploadedAt(b).localeCompare(uploadedAt(a)));

  console.log(`${entries.length} bundle${entries.length === 1 ? "" : "s"}:\n`);
  for (const entry of entries) {
    const meta = entry.metadata ?? {};
    console.log(
      [
        format(meta.code ?? entry.name.split("/")[0]).padEnd(9),
        (meta.uploadedAt ?? "?").replace("T", " ").slice(0, 19).padEnd(20),
        `v${meta.appVersion || "?"}`.padEnd(12),
        `${meta.bytes ?? "?"} bytes`.padEnd(14),
        `expires ${stamp(entry.expiration)}`,
      ].join(" "),
    );
    if (meta.os) console.log(`          ${meta.os}`);
  }
  console.log("\nDownload one with: node tools/fetch-bundle.mjs <code>");
}

/** The one bundle filed under a code, written into the current directory. */
async function download(code) {
  const entries = await keys(`${code}/`);
  if (entries.length === 0) {
    // Two quite different situations, and the maintainer needs to be able to tell them apart, so say
    // both rather than guessing.
    fail(`No bundle under ${format(code)}. Either the code was misread, or it is over 30 days old.`);
  }

  // One entry is the expected case — the worker refuses a code something is already stored under.
  // The index is here so that the impossible second one does not silently overwrite the first.
  for (const [index, entry] of entries.entries()) {
    const meta = entry.metadata ?? {};
    const response = await fetch(`${base}/values/${encodeURIComponent(entry.name)}`, {
      headers: auth,
    });
    if (!response.ok) fail(`Download failed: HTTP ${response.status} ${await response.text()}`);

    const file = entries.length === 1 ? `${code}.zip` : `${code}-${index}.zip`;
    await writeFile(file, Buffer.from(await response.arrayBuffer()));

    console.log(`${file}  ${meta.bytes ?? "?"} bytes`);
    console.log(`  uploaded  ${meta.uploadedAt ?? "?"}`);
    console.log(`  app       v${meta.appVersion || "?"}`);
    console.log(`  os        ${meta.os || "?"}`);
    console.log(`  expires   ${stamp(entry.expiration)}`);
  }
}

/**
 * Every key, or every key under one prefix. Paginated because a listing that silently stopped at the
 * first page would answer "has anyone uploaded anything" with a confident half-truth.
 */
async function keys(prefix = "") {
  const found = [];
  let cursor = "";

  do {
    const query = new URLSearchParams({ limit: "1000" });
    if (prefix) query.set("prefix", prefix);
    if (cursor) query.set("cursor", cursor);

    const response = await fetch(`${base}/keys?${query}`, { headers: auth });
    if (!response.ok) fail(`Listing failed: HTTP ${response.status} ${await response.text()}`);

    const body = await response.json();
    found.push(...body.result);
    cursor = body.result_info?.cursor ?? "";
  } while (cursor);

  return found;
}

const uploadedAt = (entry) => entry.metadata?.uploadedAt ?? "";

const format = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

const stamp = (expiration) =>
  expiration ? new Date(expiration * 1000).toISOString().replace("T", " ").slice(0, 16) : "?";

function fail(message) {
  console.error(message);
  process.exit(1);
}
