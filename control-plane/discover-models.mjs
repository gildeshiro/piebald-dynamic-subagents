#!/usr/bin/env node
// discover-models.mjs — discovers ALL models from ALL providers LIVE and
// (re)generates catalog.json. Source of truth: refresh_provider_models (hits the
// provider) + list_profiles + app.db (profile effort levels).
//
// Usage:  PIEBALD_WEB_TOKEN=... node control-plane/discover-models.mjs
//          [--out catalog.json] [--cached]   (--cached uses list_available_models, doesn't hit the provider)
//          [--with-probe]   (after listing, fire a worker per model and tag each runs|lists-only
//                            with the real HTTP cause; failures cleaned up; adds _meta.probe)

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiebaldWS, getToken } from "./ws-client.mjs";
import { runMany } from "./orchestrate.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PIEBALD_APP_DB || path.join(process.env.APPDATA, "Piebald", "app.db");
const outArg = process.argv.indexOf("--out");
const OUT = path.join(__dir, outArg !== -1 ? process.argv[outArg + 1] : "catalog.json");
const CACHED = process.argv.includes("--cached");
const WITH_PROBE = process.argv.includes("--with-probe");

function sql(q) { return execFileSync("sqlite3", [DB_PATH, q], { encoding: "utf8" }).trim(); }

// effort per profile (all engines live in the SAME config of the profile)
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

// extracts useful fields from a model object (shape varies by engine)
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

// --with-probe: fire a trivial worker per (provider,model), mark each model
// `probe: runs | lists-only` (catalog "lists" != "actually runs"). Successes auto-delete;
// failures are kept just long enough to read their real HTTP cause (403/404/400) from
// app.db, then deleted (no leftover pbprobe chats). Adds out._meta.probe. Costs a little
// quota + time — that's why it's opt-in via the flag.
async function probeAndAnnotate(pb, out) {
  const specs = [];
  for (const p of out.providers) {
    for (const m of p.models || []) {
      specs.push({
        provider_id: p.id, model: m.id,
        task: "Reply with exactly this and nothing else: PROBE-OK. Do not use tools.",
        keep: false, title: `pbprobe/${p.id}-${m.id}`, _ref: m,
      });
    }
  }
  if (!specs.length) return;
  console.error(`\n--with-probe: probing ${specs.length} models (concurrency 2)...`);
  const results = await runMany(pb, specs, { maxConcurrency: 2, resultTimeoutMs: 60000 });
  let runs = 0, lists = 0;
  for (let i = 0; i < specs.length; i++) {
    const r = results[i], m = specs[i]._ref;
    if (r.ok) { m.probe = "runs"; delete m.probe_note; runs++; continue; }
    m.probe = "lists-only"; lists++;
    let note = r.error ? String(r.error).slice(0, 120) : `status=${r.status || "error"}`;
    if (r.chatId) {
      try {
        const row = sql(`SELECT resp.status_code||'|||'||substr(resp.response_body,1,500)
          FROM messages mm JOIN http_request_chat_message_data d ON d.message_id=mm.id
          JOIN http_responses resp ON resp.http_request_id=d.http_request_id
          WHERE mm.parent_chat_id=${Number(r.chatId)} AND resp.status_code>=400
          ORDER BY resp.http_request_id DESC LIMIT 1;`);
        if (row) {
          const sep = row.indexOf("|||");
          const code = row.slice(0, sep);
          const body = row.slice(sep + 3);
          const msg = (body.match(/"message"\s*:\s*"([^"]+)"/) || [])[1]
            || body.replace(/\s+/g, " ").trim().slice(0, 100);
          note = `HTTP ${code}: ${msg}`;
        }
      } catch { /* best-effort */ }
      await pb.deleteChat(r.chatId).catch(() => {});
    }
    m.probe_note = note;
  }
  out._meta.probe = {
    date: new Date().toISOString().slice(0, 10),
    source: "discover-models.mjs --with-probe (provider×model worker probe, default profile)",
    summary: `${runs}/${runs + lists} models actually run (200/completed); ${lists} list-only (error at generation)`,
    semantics: "probe=runs => a worker completed with text. probe=lists-only => provider lists the model but it errors at generation (see probe_note). Snapshot; re-run with --with-probe to refresh. The pbroute hook validates EXISTENCE only, NOT probe status.",
  };
  console.error(`--with-probe: ${runs} runs / ${lists} lists-only.`);
}

const pb = new PiebaldWS(getToken());
await pb.connect();
const out = {
  _meta: {
    generated: new Date().toISOString(),
    source: CACHED ? "list_available_models (cache)" : "refresh_provider_models (live)",
    regenerate: "node control-plane/discover-models.mjs",
    reasoning_note: "In the Piebald schema, reasoning for ALL engines is controlled by the PROFILE (the profile's generation_config stores anthropic.effort + openai.reasoning_effort + google.thinking_budget together). Selecting a profile = selecting reasoning. It is the only reasoning lever in our setup.",
    status_semantics: "status 'ok' = the provider LISTS models. Does NOT guarantee that a worker actually runs (auth/chat-time quirks). Validate with control-plane/probe.mjs.",
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
  if (WITH_PROBE) await probeAndAnnotate(pb, out);
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const total = out.providers.reduce((a, p) => a + (p.model_count || 0), 0);
  const probed = WITH_PROBE ? ` (probed: ${out._meta.probe?.summary || "—"})` : "";
  console.error(`\nWritten ${path.basename(OUT)}: ${out.providers.length} providers, ${total} models, ${out.profiles.length} profiles.${probed}`);
} finally { pb.close(); }
