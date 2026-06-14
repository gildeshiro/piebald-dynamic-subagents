// pretooluse-route.mjs — PreToolUse hook: roteia o cérebro do subagente NATIVO
// just-in-time, lendo uma tag no prompt do LaunchSubagent e setando o global via
// update_setting (WS) ANTES da criação. SEMPRE permite a tool (exit 0).
//
// Tag no prompt do subagente:  [[pbroute provider=4 model=gpt-5.5 profile=7]]
// (qualquer subconjunto; só os campos presentes são setados.)
//
// Log de diagnóstico em hooks/route.log (pra validar disparo + timing + shape).
// Token: env PIEBALD_WEB_TOKEN ou arquivo <raiz>/.pbtoken (gitignored).

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiebaldWS } from "../control-plane/ws-client.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "..");
const LOG = path.join(__dir, "route.log");
const TOKEN_FILE = path.join(ROOT, ".pbtoken");

function log(line) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch {} }

async function main() {
  let raw = ""; try { raw = readFileSync(0, "utf8"); } catch {}
  let ev = {}; try { ev = JSON.parse(raw); } catch {}
  const tool = ev.tool_name || "?";
  const input = ev.tool_input || {};
  // DIAGNÓSTICO: registra todo disparo (descobre tool_name e shape do input do subagente)
  log(`fired tool=${tool} input_keys=${Array.isArray(input) ? "array" : Object.keys(input).join(",")}`);

  // GATE: só roteia se for o tool de subagente NATIVO. Sem isto o hook é greedy —
  // roteava pra QUALQUER tool cujo input serializado contivesse a tag (ex.: uma
  // chamada de browser/Bash que mencione [[pbroute]]). Descoberto 2026-06-14:
  // neste runtime o tool nativo se chama `Agent` (também aceitamos LaunchSubagent).
  const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "LaunchSubagent", "Task"]);
  if (!NATIVE_SUBAGENT_TOOLS.has(tool)) return;

  const promptText = input.prompt || input.description || input.task || input.instructions ||
    (typeof input === "string" ? input : JSON.stringify(input));
  const m = String(promptText).match(/\[\[pbroute([^\]]*)\]\]/i);
  if (!m) return; // sem tag -> não mexe em nada

  const args = m[1];
  const get = (k) => { const r = args.match(new RegExp(k + "\\s*=\\s*([^\\s\\]]+)")); return r ? r[1] : undefined; };
  const provider = get("provider"), model = get("model"), profile = get("profile");
  log(`pbroute DETECTED provider=${provider} model=${model} profile=${profile} tool=${tool}`);

  const token = process.env.PIEBALD_WEB_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : null);
  if (!token) { log("SEM TOKEN (.pbtoken ausente) -> nao roteou"); return; }
  try {
    const pb = new PiebaldWS(token);
    await pb.connect({ waitReadyMs: 6000 });
    if (provider) await pb.call("update_setting", { key: "subagent_provider_id", value: String(provider) });
    if (model)    await pb.call("update_setting", { key: "subagent_model", value: String(model) });
    if (profile)  await pb.call("update_setting", { key: "subagent_profile_id", value: String(profile) });
    pb.close();
    log(`ROUTED OK -> provider=${provider} model=${model} profile=${profile}`);
  } catch (e) { log(`ROUTE ERRO: ${e.message}`); }
}
main().finally(() => process.exit(0)); // nunca bloqueia a tool
