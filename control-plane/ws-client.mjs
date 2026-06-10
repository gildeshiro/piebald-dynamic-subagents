#!/usr/bin/env node
// ws-client.mjs — cliente WS do Piebald + leitura de resultado via app.db.
// Fundação da Fase 1 (1.0 token-bootstrap + 1a transporte/shapes). Node 24+
// (WebSocket global nativo). NUNCA commitar token.
//
// Token (Fase 1.0): env PIEBALD_WEB_TOKEN ou --token. Sem ele -> falha rápida
// com instrução. (Sem as fontes mágicas; o token rotaciona por launch do
// piebald-web e só aparece na URL da Web UI.)
//
// CLI:
//   PIEBALD_WEB_TOKEN=... node ws-client.mjs smoke         # round-trip no-op (create->read->delete)
//   PIEBALD_WEB_TOKEN=... node ws-client.mjs providers     # list_providers
//   PIEBALD_WEB_TOKEN=... node ws-client.mjs profiles       # list_profiles
//   node ws-client.mjs read <chatId>                        # le resultado do app.db (sem token)

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = process.env.PIEBALD_WEB_PORT || 7000;
const DB_PATH = process.env.PIEBALD_APP_DB ||
  path.join(process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming"), "Piebald", "app.db");

// ---------- Token (1.0) ----------
export function getToken(argv = process.argv) {
  const i = argv.indexOf("--token");
  const tok = (i !== -1 && argv[i + 1]) || process.env.PIEBALD_WEB_TOKEN;
  if (!tok) {
    throw new Error(
      "Token ausente. Defina PIEBALD_WEB_TOKEN (ou --token <TOK>).\n" +
      "Como obter: abra a Web UI do Piebald e copie o `?token=` da URL " +
      "(http://127.0.0.1:7000/?token=XXXX). O token rotaciona a cada relançamento do piebald-web."
    );
  }
  return tok;
}

// ---------- Cliente WS (1a) ----------
export class PiebaldWS {
  constructor(token, { port = PORT } = {}) {
    this.url = `ws://127.0.0.1:${port}/api/ws?token=${token}`;
    this.ws = null;
    this.granted = false;
    this._id = 0;
    this._pending = new Map();      // id -> {resolve, reject, timer}
    this._listeners = new Map();    // eventType -> Set<cb>
  }

  connect({ timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("connect timeout (sem web_access_granted)")), timeoutMs);
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("message", (ev) => this._onMessage(ev));
      this.ws.addEventListener("error", (e) => { if (!this.granted) { clearTimeout(to); reject(new Error("WS error: " + (e.message || e))); } });
      this.ws.addEventListener("close", () => {
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error("WS fechou")); }
        this._pending.clear();
      });
      this._onGranted = () => { clearTimeout(to); resolve(this); };
      this._onRejected = () => { clearTimeout(to); reject(new Error("AUTH REJEITADO: token inválido/expirado (rotacionou?). Reobtenha da Web UI.")); };
    });
  }

  _onMessage(ev) {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.msg === "web_access_granted") { this.granted = true; this._onGranted?.(); return; }
    if (m.msg === "web_access_required") { this._onRejected?.(); return; }
    if (m.msg === "command_response") {
      const p = this._pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); this._pending.delete(m.id);
      if (m.success) p.resolve(m.response);
      else p.reject(new Error(`comando falhou: ${m.error}`));
      return;
    }
    if (m.msg === "event") {
      const set = this._listeners.get(m.type);
      if (set) for (const cb of set) cb(m.data, m);
    }
  }

  // call com timeout explícito + correlação de id (suporta múltiplos pendentes)
  call(name, request = {}, { timeoutMs = 15000 } = {}) {
    if (!this.granted) return Promise.reject(new Error("não autenticado (chame connect primeiro)"));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`timeout em '${name}' (${timeoutMs}ms)`)); }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ msg: "command", id, name, request }));
    });
  }

  on(eventType, cb) {
    if (!this._listeners.has(eventType)) this._listeners.set(eventType, new Set());
    this._listeners.get(eventType).add(cb);
    return () => this._listeners.get(eventType)?.delete(cb);
  }

  close() { try { this.ws?.close(); } catch {} }

  // -------- wrappers de comando (shapes confirmados) --------
  listProviders() { return this.call("list_providers"); }
  listProfiles() { return this.call("list_profiles"); }
  listChats() { return this.call("list_chats"); }
  getChat(chat_id) { return this.call("get_chat", { chat_id }); }

  // create_chat -> {chat:{id,...}, project}. chat_id = chat.id
  async createChat({ provider_id, model, profile_id, config_id, current_directory, title } = {}) {
    const model_config = {};
    if (provider_id != null) model_config.provider_id = provider_id;
    if (model != null) model_config.model = model;
    if (profile_id != null) model_config.profile_id = profile_id;
    if (config_id != null) model_config.config_id = config_id;
    const req = { model_config };
    if (current_directory) req.current_directory = current_directory;
    if (title) req.title = title;
    const r = await this.call("create_chat", req);
    return r.chat.id;
  }

  changeChatProfile(chat_id, profile_id) { return this.call("change_chat_profile", { chat_id, profile_id, force: true }); }

  // shape REAL do parts (árvore de nodes) — NÃO texto plano
  sendMessage(chat_id, content, { parent_message_id } = {}) {
    const req = {
      chat_id,
      parts: [{ type: "text", text: { nodes: [{ type: "text", data: { content } }] } }],
      branching_intended: false,
    };
    if (parent_message_id != null) req.parent_message_id = parent_message_id;
    return this.call("send_message_streaming", req);
  }

  deleteChat(chat_id) { return this.call("delete_chat", { chat_id }); }
}

// ---------- Leitura de resultado via app.db (1a, PROVADO) ----------
function sql(query) {
  if (!existsSync(DB_PATH)) throw new Error("app.db não encontrado em " + DB_PATH);
  return execFileSync("sqlite3", [DB_PATH, query], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function chatStatus(chatId) {
  return sql(`SELECT working_status FROM chats WHERE id=${Number(chatId)};`);
}

// texto final do assistant (sem thinking), concatenado em ordem
export function lastAssistantText(chatId) {
  const id = Number(chatId);
  return sql(`SELECT group_concat(content,'') FROM (
    SELECT mnt.content
    FROM messages m
    JOIN message_parts mp ON mp.parent_chat_message_id=m.id
    JOIN message_part_text mpt ON mpt.message_part_id=mp.id
    JOIN message_content_nodes mcn ON mcn.parent_text_part_id=mpt.message_part_id
    JOIN message_node_text mnt ON mnt.node_id=mcn.id
    WHERE m.id=(SELECT MAX(id) FROM messages WHERE parent_chat_id=${id} AND role='assistant')
      AND mpt.is_thinking=0
    ORDER BY mp.part_index, mcn.node_index);`);
}

// status final do último assistant (pra distinguir done vs error)
export function lastAssistantStatus(chatId) {
  return sql(`SELECT status FROM messages WHERE parent_chat_id=${Number(chatId)} AND role='assistant' ORDER BY id DESC LIMIT 1;`);
}

// poll até working_status=idle (resultado pronto) com timeout
export async function readResult(chatId, { timeoutMs = 180000, pollMs = 2500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const st = chatStatus(chatId);
    if (st === "idle") {
      return { status: lastAssistantStatus(chatId), text: lastAssistantText(chatId), ms: Date.now() - t0 };
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`readResult timeout (${timeoutMs}ms), working_status=${st}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------- CLI ----------
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ws-client.mjs");
if (isMain) {
  const [, , cmd, arg] = process.argv;
  (async () => {
    if (cmd === "read") {
      console.log(JSON.stringify({ status: chatStatus(arg), result: lastAssistantText(arg) }, null, 2));
      return;
    }
    const token = getToken();
    const pb = new PiebaldWS(token);
    await pb.connect();
    try {
      if (cmd === "providers") console.log(JSON.stringify(await pb.listProviders(), null, 2));
      else if (cmd === "profiles") console.log(JSON.stringify(await pb.listProfiles(), null, 2));
      else if (cmd === "smoke") {
        const id = await pb.createChat({ provider_id: 3, model: "claude-sonnet-4-6", current_directory: process.cwd(), title: "pbsub/smoke" });
        console.log("created chat", id, "status:", chatStatus(id));
        await pb.deleteChat(id);
        await pb.deleteChat(id); // idempotência
        console.log("deleted chat", id, "-> is_deleted:", sql(`SELECT is_deleted FROM chats WHERE id=${id};`));
      } else {
        console.log("uso: smoke | providers | profiles | read <chatId>");
      }
    } finally { pb.close(); }
  })().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
}
