// pbroute-route.test.mjs — drives the REAL hook (hooks/pretooluse-route.mjs) as a
// child process against an ISOLATED app.db (via PIEBALD_APP_DB), with crafted
// PreToolUse events on stdin. Exercises the actual route/validate/write code path
// without touching the live Piebald app.db and without needing Piebald to reload.
//
// Run:  node test/pbroute-route.test.mjs
//
// NOTE: this validates the hook LOGIC end-to-end (regex anchoring, catalog
// validation, fail-safe baseline reset, db write). The only link it cannot prove
// is Piebald re-reading the setting at subagent-creation time — that needs a new
// chat / app restart because Piebald caches hooks at chat creation.

import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "..");
const HOOK = path.join(ROOT, "hooks", "pretooluse-route.mjs");
const TEST_DB = path.join(__dir, "_pbroute-test.db");
const LOG = path.join(ROOT, "hooks", "route.log");

const SEED = { provider: "99", model: "__seed__", profile: "99" };
const BASE = JSON.parse(readFileSync(path.join(ROOT, "control-plane", "pbroute-baseline.json"), "utf8"));

function seedDb() {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  const db = new DatabaseSync(TEST_DB);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  const ins = db.prepare("INSERT INTO settings (key,value) VALUES (?,?)");
  ins.run("subagent_provider_id", SEED.provider);
  ins.run("subagent_model", SEED.model);
  ins.run("subagent_profile_id", SEED.profile);
  db.close();
}
function readRoute() {
  const db = new DatabaseSync(TEST_DB);
  const g = (k) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? r.value : null; };
  const out = { provider: g("subagent_provider_id"), model: g("subagent_model"), profile: g("subagent_profile_id") };
  db.close();
  return out;
}
function runHook(event) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    env: { ...process.env, PIEBALD_APP_DB: TEST_DB },
    cwd: ROOT, encoding: "utf8",
  });
  return r;
}
function logTail(n = 6) {
  try { return readFileSync(LOG, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return ""; }
}

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function ev(prompt, tool = "Agent") { return { tool_name: tool, tool_input: { prompt } }; }

console.log("=== pbroute hook tests (isolated db) ===");

// T1 — valid PREFIX directive => routes to those values
seedDb();
runHook(ev("[[pbroute provider=3 model=claude-opus-4-8 profile=1]] Do the task."));
let r = readRoute();
check("T1 valid prefix routes provider", r.provider === "3", JSON.stringify(r));
check("T1 valid prefix routes model", r.model === "claude-opus-4-8", JSON.stringify(r));
check("T1 valid prefix routes profile", r.profile === "1", JSON.stringify(r));

// T2 — directive MID-PROMPT (not a prefix) => must be IGNORED (anchored) -> baseline
seedDb();
runHook(ev("Please translate this doc which mentions [[pbroute provider=3 model=claude-opus-4-8 profile=1]] as an example."));
r = readRoute();
check("T2 mid-prompt directive NOT applied (model)", r.model !== "claude-opus-4-8", JSON.stringify(r));
check("T2 mid-prompt -> baseline model", r.model === BASE.model, JSON.stringify(r));

// T3 — valid prefix but BOGUS model => REJECTED, fail-safe baseline, no crash
seedDb();
runHook(ev("[[pbroute provider=3 model=__does_not_exist__ profile=1]] task"));
r = readRoute();
check("T3 bogus model NOT written", r.model !== "__does_not_exist__", JSON.stringify(r));
check("T3 bogus -> baseline model", r.model === BASE.model, JSON.stringify(r));
check("T3 REJECT logged", /REJECT/i.test(logTail()), logTail());

// T3b — placeholder model <model-id> (the exact crash we hit) => REJECTED
seedDb();
runHook(ev("[[pbroute provider=3 model=<model-id> profile=1]] task"));
r = readRoute();
check("T3b placeholder model NOT written", r.model !== "<model-id>", JSON.stringify(r));

// T4 — no directive => baseline reset
seedDb();
runHook(ev("just a normal task with no routing tag"));
r = readRoute();
check("T4 no directive -> baseline provider", r.provider === BASE.provider, JSON.stringify(r));

// T5 — non-subagent tool => hook returns early, settings untouched
seedDb();
runHook({ tool_name: "Bash", tool_input: { command: "echo [[pbroute provider=3 model=claude-opus-4-8]]" } });
r = readRoute();
check("T5 non-subagent tool leaves seed untouched", r.model === SEED.model && r.provider === SEED.provider, JSON.stringify(r));

// cleanup
if (existsSync(TEST_DB)) rmSync(TEST_DB);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
