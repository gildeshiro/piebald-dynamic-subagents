// pretooluse-route.mjs — PreToolUse hook: routes the native subagent's brain
// just-in-time by writing subagent_provider_id/model/profile_id DIRECTLY into app.db
// (settings table) BEFORE the subagent is created. ALWAYS allows the tool (exit 0).
//
// WHY DB AND NOT WS (proven 2026-06-14): Piebald (both the main app and piebald-web)
// re-reads subagent_* from app.db at the moment it creates a native subagent. A local
// UPDATE taking milliseconds is sufficient — NO piebald-web, NO token, NO liveness check.
// PreToolUse blocks until exit 0, so the write commits BEFORE the subagent is created.
// WS remains as a best-effort fallback only if the DB write fails.
//
// Tag in the subagent's prompt:  [[pbroute provider=4 model=gpt-5.5 profile=7]]
// (any subset; only the present fields are set.)
// Diagnostic log at hooks/route.log.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "..");
const LOG = path.join(__dir, "route.log");
const TOKEN_FILE = path.join(ROOT, ".pbtoken");
const BASELINE_FILE = path.join(ROOT, "control-plane", "pbroute-baseline.json");
const CURRENT_TOKEN = path.join(os.homedir(), ".piebald-remote", "current-token");
const DB_PATH = process.env.PIEBALD_APP_DB ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Piebald", "app.db");

const KEY = { provider: "subagent_provider_id", model: "subagent_model", profile: "subagent_profile_id" };

function log(line) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch {} }

// ---- main path: direct write into app.db ----
function writeDb(updates) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout=4000");
    const stmt = db.prepare("UPDATE settings SET value=? WHERE key=?");
    let totalChanges = 0;
    const failedKeys = [];
    const entries = Object.entries(updates);
    for (const [k, v] of entries) {
      const dbKey = KEY[k];
      const result = stmt.run(String(v), dbKey);
      totalChanges += result.changes;
      if (result.changes === 0) failedKeys.push(dbKey);
    }
    if (totalChanges < entries.length) throw new Error(`route key(s) matched 0 rows: ${failedKeys.join(", ")}`);
  } finally { db.close(); }
}

// ---- dormant fallback: WS update_setting (only if DB write fails) ----
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
    } catch { /* try next candidate */ }
  }
  throw new Error("no live WS token");
}

async function resetBaseline(tool, reason) {
  let baseline;
  try { baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")); }
  catch { log("no baseline file, skip reset"); return; }
  const updates = {};
  for (const k of ["provider", "model", "profile"]) if (baseline[k] !== undefined) updates[k] = baseline[k];
  if (!Object.keys(updates).length) { log("baseline has no valid fields -> nothing to do"); return; }
  log(`${reason} -> reset baseline ${JSON.stringify(updates)} tool=${tool}`);
  try {
    writeDb(updates);
    log(`RESET OK (db) -> ${JSON.stringify(updates)}`);
  } catch (e) {
    log(`DB reset failed (${e.message}) -> WS fallback`);
    try { await wsFallback(updates); log(`RESET OK (ws) -> ${JSON.stringify(updates)}`); }
    catch (e2) { log(`RESET ERROR (db+ws): ${e2.message}`); }
  }
}

async function main() {
  let raw = ""; try { raw = readFileSync(0, "utf8"); } catch {}
  let ev = {}; try { ev = JSON.parse(raw); } catch {}
  const tool = ev.tool_name || "?";
  const input = ev.tool_input || {};
  log(`fired tool=${tool} input_keys=${Array.isArray(input) ? "array" : Object.keys(input).join(",")}`);

  // GATE: only acts on the NATIVE subagent tool (in this runtime = `Agent`).
  const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "LaunchSubagent", "Task"]);
  if (!NATIVE_SUBAGENT_TOOLS.has(tool)) return;

  const promptText = input.prompt || input.description || input.task || input.instructions ||
    (typeof input === "string" ? input : JSON.stringify(input));
  const m = String(promptText).match(/\[\[pbroute([^\]]*)\]\]/i);
  if (!m) { await resetBaseline(tool, "pbroute absent"); return; }
  const args = m[1];
  const get = (k) => { const r = args.match(new RegExp(k + "\\s*=\\s*([^\\s\\]]+)")); return r ? r[1] : undefined; };
  const updates = {};
  for (const k of ["provider", "model", "profile"]) { const v = get(k); if (v !== undefined) updates[k] = v; }
  if (!Object.keys(updates).length) { await resetBaseline(tool, "pbroute with no valid fields"); return; }
  log(`pbroute DETECTED ${JSON.stringify(updates)} tool=${tool}`);

  try {
    writeDb(updates);
    log(`ROUTED OK (db) -> ${JSON.stringify(updates)}`);
  } catch (e) {
    log(`DB write failed (${e.message}) -> WS fallback`);
    try { await wsFallback(updates); log(`ROUTED OK (ws) -> ${JSON.stringify(updates)}`); }
    catch (e2) { log(`ROUTE ERROR (db+ws): ${e2.message}`); }
  }
}
main().finally(() => process.exit(0)); // never blocks the tool
