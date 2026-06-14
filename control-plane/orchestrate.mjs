#!/usr/bin/env node
// orchestrate.mjs — Fase 1b/1c. Despacha workers (1 chat por worker, cérebro
// próprio) e coleta resultados. Erro por-worker é ISOLADO (try/catch). Usa os
// primitivos validados em ws-client.mjs.
//
// spec = {
//   provider_id, model, profile_id?, config_id?,   // o cérebro
//   task,                                            // o prompt (string)
//   dir?, title?, keep?                              // dir do chat, título, manter chat (não deletar)
// }
//
// Interface (definida antes do AGENTS.md):
//   echo '{"specs":[...]}' | node orchestrate.mjs            # lê specs do stdin, escreve results JSON no stdout
//   node orchestrate.mjs --file specs.json
//   node orchestrate.mjs one "<task>" [provider_id] [model] [profile_id]   # atalho 1-worker
// Exit: 0 se todos ok; 1 se algum worker falhou; 2 erro de setup/token.

import { readFileSync } from "node:fs";
import { PiebaldWS, getToken, readResult } from "./ws-client.mjs";

const PROJECT_DIR = "C:\\Projects\\piebald-dynamic-subagents";
const TITLE_PREFIX = "pbsub/"; // marcador p/ cleanup de órfãos
let _seq = 0; // contador p/ títulos únicos em creates simultâneos

export async function runOne(pb, spec, { resultTimeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  const title = spec.title || `${TITLE_PREFIX}${spec.model || "?"}-${Date.now() % 100000}-${++_seq}`;
  let chatId = null;
  try {
    chatId = await pb.createChat({
      provider_id: spec.provider_id,
      model: spec.model,
      profile_id: spec.profile_id,
      config_id: spec.config_id,
      current_directory: spec.dir || PROJECT_DIR,
      title,
    });
    await pb.sendMessage(chatId, spec.task);
    const r = await readResult(chatId, { timeoutMs: resultTimeoutMs, stuckToolMs: spec.stuckToolMs });
    const ok = r.status === "completed"; // só 'completed' com texto é sucesso real
    if (!spec.keep && ok) await pb.deleteChat(chatId).catch(() => {});
    return { ok, chatId, title, model: spec.model, provider_id: spec.provider_id, status: r.status, text: r.text, pendingTools: r.pendingTools, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, chatId, title, model: spec.model, provider_id: spec.provider_id, error: e.message, ms: Date.now() - t0 };
  }
}

// pool com teto de concorrência (1c)
export async function runMany(pb, specs, { maxConcurrency = 3, resultTimeoutMs = 180000 } = {}) {
  const results = new Array(specs.length);
  let next = 0;
  async function worker() {
    while (next < specs.length) {
      const i = next++;
      results[i] = await runOne(pb, specs[i], { resultTimeoutMs });
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, specs.length) }, worker));
  return results;
}

// cleanup de chats órfãos de runs anteriores (título com TITLE_PREFIX, não deletados)
export async function cleanupOrphans(pb) {
  const { chats } = await pb.listChats();
  const orphans = (chats || []).filter((c) => !c.is_deleted && typeof c.title === "string" && c.title.startsWith(TITLE_PREFIX));
  for (const c of orphans) await pb.deleteChat(c.id).catch(() => {});
  return orphans.map((c) => c.id);
}

// ---------- CLI ----------
const isMain = process.argv[1]?.endsWith("orchestrate.mjs");
if (isMain) {
  (async () => {
    const [, , cmd] = process.argv;
    let specs;
    if (cmd === "one") {
      const [, , , task, provider_id, model, profile_id] = process.argv;
      specs = [{ task, provider_id: provider_id ? Number(provider_id) : 3, model: model || "claude-sonnet-4-6", profile_id: profile_id ? Number(profile_id) : undefined, keep: false }];
    } else if (cmd === "--file") {
      specs = JSON.parse(readFileSync(process.argv[3], "utf8")).specs;
    } else {
      const raw = readFileSync(0, "utf8"); // stdin
      specs = JSON.parse(raw).specs;
    }
    if (!Array.isArray(specs) || !specs.length) { console.error("sem specs"); process.exit(2); }

    const pb = new PiebaldWS(getToken());
    await pb.connect();
    try {
      const results = await runMany(pb, specs);
      console.log(JSON.stringify({ results }, null, 2));
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    } finally { pb.close(); }
  })().catch((e) => { console.error("ERRO:", e.message); process.exit(2); });
}
