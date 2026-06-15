#!/usr/bin/env node
// probe.mjs — harness for the DEDICATED probe session (not run day-to-day).
// Iterates provider × model from catalog.json, fires 1 trivial task per combo,
// and captures status/error/quirk. Results are used to complete the catalog and
// report quirks to the Piebald dev team.
//
// Usage:  PIEBALD_WEB_TOKEN=... node control-plane/probe.mjs [--keep] [--concurrency N]
//
// NOTE: effort/reasoning per combo requires effort-specific profiles (not yet created).
// This probe v1 covers provider×model with the default profile. Effort probe =
// next iteration (create profiles or find an inline override).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiebaldWS, getToken } from "./ws-client.mjs";
import { runMany } from "./orchestrate.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(__dir, "catalog.json"), "utf8"));
const keep = process.argv.includes("--keep");
const ci = process.argv.indexOf("--concurrency");
const maxConcurrency = ci !== -1 ? Number(process.argv[ci + 1]) : 2;

// provider × model matrix
const specs = [];
for (const p of catalog.providers) {
  for (const m of p.models || []) {
    specs.push({
      provider_id: p.id, model: m.id,
      task: "Reply with exactly this and nothing else: PROBE-OK. Do not use tools.",
      keep, title: `pbprobe/${p.id}-${m.id}`,
      _provider: p.name, _status_hint: p.status,
    });
  }
}

console.error(`Probe: ${specs.length} combos (provider×model), concurrency ${maxConcurrency}.`);
const pb = new PiebaldWS(getToken());
await pb.connect();
try {
  const results = await runMany(pb, specs, { maxConcurrency, resultTimeoutMs: 60000 });
  const rows = results.map((r, i) => ({
    provider: specs[i]._provider, model: specs[i].model,
    hint: specs[i]._status_hint,
    ok: r.ok, status: r.status || "—",
    got: (r.text || "").slice(0, 40),
    error: (r.error || "").slice(0, 80),
    chatId: r.chatId, ms: r.ms,
  }));
  console.log(JSON.stringify({ probe: rows }, null, 2));
  const okN = rows.filter((r) => r.ok).length;
  console.error(`\n${okN}/${rows.length} OK. (chats ${keep ? "KEPT for inspection" : "deleted on success"})`);
} finally { pb.close(); }
