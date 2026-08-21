#!/usr/bin/env node
/**
 * Pulls one uploaded bundle out of the KV namespace by the code the user quoted.
 *
 *   node tools/fetch-bundle.mjs A3F-7K2
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

const { CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN } = process.env;

const missing = ["CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_API_TOKEN"].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  fail(`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
}

// Accepted with or without the dash, because the dash is a reading aid printed by the app and the
// half of the time somebody retypes the code they will leave it out.
const code = (process.argv[2] ?? "").toUpperCase().replace(/-/g, "");
if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) {
  fail("Usage: node tools/fetch-bundle.mjs A3F-7K2");
}

const base = `${API}/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`;
const auth = { authorization: `Bearer ${CF_API_TOKEN}` };

const listed = await fetch(`${base}/keys?prefix=${code}/`, { headers: auth });
if (!listed.ok) fail(`Listing failed: HTTP ${listed.status} ${await listed.text()}`);

const { result } = await listed.json();
if (result.length === 0) {
  // Two quite different situations, and the maintainer needs to be able to tell them apart, so say
  // both rather than guessing.
  fail(`No bundle under ${code}. Either the code was misread, or it is more than 30 days old.`);
}

// One entry is the expected case — the worker refuses a code something is already stored under.
// The index is here so that the impossible second one does not silently overwrite the first.
for (const [index, entry] of result.entries()) {
  const meta = entry.metadata ?? {};
  const response = await fetch(`${base}/values/${encodeURIComponent(entry.name)}`, { headers: auth });
  if (!response.ok) fail(`Download failed: HTTP ${response.status} ${await response.text()}`);

  const file = result.length === 1 ? `${code}.zip` : `${code}-${index}.zip`;
  await writeFile(file, Buffer.from(await response.arrayBuffer()));

  console.log(`${file}  ${meta.bytes ?? "?"} bytes`);
  console.log(`  uploaded  ${meta.uploadedAt ?? "?"}`);
  console.log(`  app       v${meta.appVersion || "?"}`);
  console.log(`  os        ${meta.os || "?"}`);
  console.log(`  expires   ${entry.expiration ? new Date(entry.expiration * 1000).toISOString() : "?"}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
