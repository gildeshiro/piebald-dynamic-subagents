#!/usr/bin/env node
// discover-models.mjs — descobre AO VIVO todos os modelos de todos os providers
// e (re)gera o catalog.json. Fonte de verdade: refresh_provider_models (bate no
// provider) + list_profiles + app.db (effort dos profiles).
//
// Uso:  PIEBALD_WEB_TOKEN=... node control-plane/discover-models.mjs
//        [--out catalog.json] [--cached]   (--cached usa list_available_models, não bate no provider)

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiebaldWS, getToken } from "./ws-client.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PIEBALD_APP_DB || path.join(process.env.APPDATA, "Piebald", "app.db");
const outArg = process.argv.indexOf("--out");
const OUT = path.join(__dir, outArg !== -1 ? process.argv[outArg + 1] : "catalog.json");
const CACHED = process.argv.includes("--cached");

function sql(q) { return execFileSync("sqlite3", [DB_PATH, q], { encoding: "utf8" }).trim(); }

// effort por profile (todos os engines vivem no MESMO config do profile)
function profileEfforts() {
  const rows = sql(`SELECT p.id||'|'||p.name||'|'||p.config_id||'|'||
    COALESCE(oa.effort,'')||'|'||COALESCE(oa.thinking_mode,'')||'|'||
    COALESCE(orp.reasoning_effort,'')||'|'||COALESCE(og.thinking_budget,'')
    FROM profiles p
    LEFT JOIN override_gen_cfg_data_anthropic oa ON oa.gen_cfg_id=p.config_id
    LEFT JOIN override_gen_cfg_data_openai_responses orp ON orp.gen_cfg_id=p.config_id
    LEFT JOIN override_gen_cfg_data_google og ON og.gen_cfg_id=p.config_id
    ORDER BY p.id;`);
  return rows.split("\n").filter(Boolean).map((r) => {
    const [id, name, config_id, anthropic_effort, thinking_mode, openai_reasoning_effort, google_thinking_budget] = r.split("|");
    return { id: Number(id), name, config_id: Number(config_id),
      anthropic_effort: anthropic_effort || null, thinking_mode: thinking_mode || null,
      openai_reasoning_effort: openai_reasoning_effort || null,
      google_thinking_budget: google_thinking_budget === "" ? null : Number(google_thinking_budget) };
  });
}

// extrai campos úteis de um objeto-modelo (shape varia por engine)
function slimModel(m) {
  if (typeof m === "string") return { id: m };
  const out = { id: m.id || m.slug, display: m.display_name || m.display || undefined };
  if (m.context_limits) out.context = m.context_limits;
  if (m.context_window) out.context_window = m.context_window;
  const rl = m.supported_reasoning_levels || m.reasoning_levels;
  if (rl) out.reasoning_levels = rl.map((x) => x.effort || x);
  if (m.default_reasoning_level) out.default_reasoning = m.default_reasoning_level;
  if (m.support_verbosity != null) out.supports_verbosity = m.support_verbosity;
  return out;
}

const pb = new PiebaldWS(getToken());
await pb.connect();
const out = {
  _meta: {
    generated: new Date().toISOString(),
    source: CACHED ? "list_available_models (cache)" : "refresh_provider_models (ao vivo)",
    regenerate: "node control-plane/discover-models.mjs",
    reasoning_note: "No esquema Piebald, reasoning de TODOS os engines é controlado pelo PROFILE (o generation_config do profile guarda anthropic.effort + openai.reasoning_effort + google.thinking_budget juntos). Selecionar profile = selecionar reasoning. É o único lever de reasoning no nosso setup.",
    status_semantics: "status 'ok' = o provider LISTA modelos. NÃO garante que um worker roda de fato (auth/quirk de chat-time). Validar com control-plane/probe.mjs.",
    openai_reasoning_levels: ["low", "medium", "high", "xhigh"],
    openai_default_reasoning: "medium",
  },
  providers: [],
  profiles: [],
};

try {
  const { providers } = await pb.listProviders();
  for (const p of providers) {
    const entry = { id: p.id, name: p.name, engine_type: p.engine_type, type: p.type };
    try {
      const r = CACHED
        ? await pb.call("list_available_models", { provider_id: p.id }, { timeoutMs: 20000 })
        : await pb.call("refresh_provider_models", { provider_id: p.id }, { timeoutMs: 25000 });
      const models = r.models || [];
      entry.status = models.length ? "ok" : "empty";
      entry.model_count = models.length;
      entry.models = models.map(slimModel);
    } catch (e) {
      entry.status = "error";
      entry.error = e.message;
      entry.models = [];
    }
    out.providers.push(entry);
    console.error(`provider ${p.id} ${p.name}: ${entry.status} (${entry.model_count || 0})`);
  }
  out.profiles = profileEfforts();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const total = out.providers.reduce((a, p) => a + (p.model_count || 0), 0);
  console.error(`\nEscrito ${path.basename(OUT)}: ${out.providers.length} providers, ${total} modelos, ${out.profiles.length} profiles.`);
} finally { pb.close(); }
