// pretooluse-route.mjs — PreToolUse hook: roteia o cérebro do subagente NATIVO
// just-in-time, escrevendo subagent_provider_id/model/profile_id DIRETO no app.db
// (tabela settings) ANTES da criação do subagente. SEMPRE permite a tool (exit 0).
//
// POR QUE DB E NÃO WS (provado 2026-06-14): o Piebald (app principal E piebald-web)
// relê subagent_* do app.db no momento em que cria o subagente nativo. Um UPDATE
// local de milissegundos basta — SEM piebald-web, SEM token, SEM liveness. O
// PreToolUse bloqueia até o exit 0, então o write commita ANTES da criação.
// WS fica como fallback best-effort só se o write no DB falhar.
//
// Tag no prompt do subagente:  [[pbroute provider=4 model=gpt-5.5 profile=7]]
// (qualquer subconjunto; só os campos presentes são setados.)
// Log de diagnóstico em hooks/route.log.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "..");
const LOG = path.join(__dir, "route.log");
const TOKEN_FILE = path.join(ROOT, ".pbtoken");
const CURRENT_TOKEN = path.join(os.homedir(), ".piebald-remote", "current-token");
const DB_PATH = process.env.PIEBALD_APP_DB ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Piebald", "app.db");

const KEY = { provider: "subagent_provider_id", model: "subagent_model", profile: "subagent_profile_id" };

function log(line) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch {} }

// ---- caminho principal: write direto no app.db ----
function writeDb(updates) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout=4000");
    const stmt = db.prepare("UPDATE settings SET value=? WHERE key=?");
    for (const [k, v] of Object.entries(updates)) stmt.run(String(v), KEY[k]);
  } finally { db.close(); }
}

// ---- fallback dormente: WS update_setting (só se o DB write estourar) ----
function dayLogTokens() {
  try {
    const d = new Date();
    const f = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.log`;
    const p = path.join(process.env.APPDATA || "", "Piebald", "logs", f);
    if (!existsSync(p)) return [];
    return [...new Set([...readFileSync(p, "utf8").matchAll(/token=([A-Za-z0-9_-]{20,})/g)].map((m) => m[1]).reverse())];
  } catch { return []; }
}
function tokenCandidates() {
  const c = [];
  const rd = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } };
  if (process.env.PIEBALD_WEB_TOKEN) c.push(process.env.PIEBALD_WEB_TOKEN.trim());
  if (existsSync(CURRENT_TOKEN)) c.push(rd(CURRENT_TOKEN));
  if (existsSync(TOKEN_FILE)) c.push(rd(TOKEN_FILE));
  c.push(...dayLogTokens());
  return [...new Set(c.filter(Boolean))];
}
async function wsFallback(updates) {
  const { PiebaldWS } = await import("../control-plane/ws-client.mjs");
  for (const tok of tokenCandidates()) {
    try {
      const pb = new PiebaldWS(tok);
      await pb.connect({ timeoutMs: 3500, waitReadyMs: 6000 });
      for (const [k, v] of Object.entries(updates)) await pb.call("update_setting", { key: KEY[k], value: String(v) });
      pb.close();
      return true;
    } catch { /* próximo candidato */ }
  }
  throw new Error("nenhum token WS vivo");
}

async function main() {
  let raw = ""; try { raw = readFileSync(0, "utf8"); } catch {}
  let ev = {}; try { ev = JSON.parse(raw); } catch {}
  const tool = ev.tool_name || "?";
  const input = ev.tool_input || {};
  log(`fired tool=${tool} input_keys=${Array.isArray(input) ? "array" : Object.keys(input).join(",")}`);

  // GATE: só age no tool de subagente NATIVO (neste runtime = `Agent`).
  const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "LaunchSubagent", "Task"]);
  if (!NATIVE_SUBAGENT_TOOLS.has(tool)) return;

  const promptText = input.prompt || input.description || input.task || input.instructions ||
    (typeof input === "string" ? input : JSON.stringify(input));
  const m = String(promptText).match(/\[\[pbroute([^\]]*)\]\]/i);
  if (!m) return; // sem tag -> subagente herda o global atual, não mexe em nada

  const args = m[1];
  const get = (k) => { const r = args.match(new RegExp(k + "\\s*=\\s*([^\\s\\]]+)")); return r ? r[1] : undefined; };
  const updates = {};
  for (const k of ["provider", "model", "profile"]) { const v = get(k); if (v !== undefined) updates[k] = v; }
  if (!Object.keys(updates).length) { log("pbroute sem campos válidos -> nada"); return; }
  log(`pbroute DETECTED ${JSON.stringify(updates)} tool=${tool}`);

  try {
    writeDb(updates);
    log(`ROUTED OK (db) -> ${JSON.stringify(updates)}`);
  } catch (e) {
    log(`DB write falhou (${e.message}) -> WS fallback`);
    try { await wsFallback(updates); log(`ROUTED OK (ws) -> ${JSON.stringify(updates)}`); }
    catch (e2) { log(`ROUTE ERRO (db+ws): ${e2.message}`); }
  }
}
main().finally(() => process.exit(0)); // nunca bloqueia a tool
