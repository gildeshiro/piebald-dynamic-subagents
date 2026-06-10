#!/usr/bin/env node
// probe.mjs — harness p/ a SESSÃO DEDICADA de probe (não roda no dia-a-dia).
// Itera provider × modelo do catalog.json, dispara 1 task trivial por combo,
// e captura status/erro/quirk. Resultado serve p/ completar o catálogo e
// reportar quirks ao dev team do Piebald.
//
// Uso:  PIEBALD_WEB_TOKEN=... node control-plane/probe.mjs [--keep] [--concurrency N]
//
// NOTA: effort/reasoning por combo exige profiles por effort (ainda não existem).
// Este probe v1 cobre provider×modelo com o profile default. Probe de effort =
// próxima iteração (criar profiles ou achar override inline).

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

// matriz provider × modelo
const specs = [];
for (const p of catalog.providers) {
  for (const m of p.models || []) {
    specs.push({
      provider_id: p.id, model: m.id,
      task: "Responda com exatamente isto e nada mais: PROBE-OK. Nao use ferramentas.",
      keep, title: `pbprobe/${p.id}-${m.id}`,
      _provider: p.name, _status_hint: p.status,
    });
  }
}

console.error(`Probe: ${specs.length} combos (provider×modelo), concorrência ${maxConcurrency}.`);
const pb = new PiebaldWS(getToken());
await pb.connect();
try {
  const results = await runMany(pb, specs, { maxConcurrency, resultTimeoutMs: 120000 });
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
  console.error(`\n${okN}/${rows.length} OK. (chats ${keep ? "MANTIDOS p/ inspeção" : "deletados no sucesso"})`);
} finally { pb.close(); }
