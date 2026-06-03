#!/usr/bin/env node
// ws-cli.mjs — control-plane do Piebald via WebSocket (validado na Fase 0).
//
// O backend do piebald-web (ws://127.0.0.1:7000/api/ws) expoe `update_setting`,
// que altera settings AO VIVO (memoria + DB) sem restart. O proximo LaunchSubagent
// captura o valor novo. Isso permite rotear subagentes por provider/model/profile
// dinamicamente, preservando a auth de assinatura (OAuth) legitima do Piebald.
//
// IMPORTANTE:
//   - Os valores de setting sao SEMPRE strings, inclusive IDs. Use "5", nao 5.
//   - O token rotaciona a cada relancamento do piebald-web. Recupere com:
//       grep -oE 'token=[A-Za-z0-9]{20,}' "$APPDATA/Piebald/logs/$(date +%F).log" | tail -1
//   - NUNCA commitar o token. Passe via argv ou env PIEBALD_WEB_TOKEN.
//
// Uso:
//   node ws-cli.mjs get [filtro]                 # le settings (filtro por substring)
//   node ws-cli.mjs set <key> <valor-string>     # update_setting (valor sempre string)
//   PIEBALD_WEB_TOKEN=... node ws-cli.mjs get subagent
//   node ws-cli.mjs --token <TOKEN> set subagent_provider_id 5

const argv = process.argv.slice(2);
let token = process.env.PIEBALD_WEB_TOKEN;
const ti = argv.indexOf("--token");
if (ti !== -1) { token = argv[ti + 1]; argv.splice(ti, 2); }
const port = process.env.PIEBALD_WEB_PORT || 7000;
const [action, arg1, arg2] = argv;

if (!token) { console.error("falta token (env PIEBALD_WEB_TOKEN ou --token)"); process.exit(2); }
if (!action || !["get", "set"].includes(action)) { console.error("uso: get [filtro] | set <key> <valor>"); process.exit(2); }
if (action === "set" && (arg1 === undefined || arg2 === undefined)) { console.error("set requer <key> <valor>"); process.exit(2); }

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
const done = (c) => { try { ws.close(); } catch {} process.exit(c); };

ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.msg === "web_access_required") { console.error("AUTH REJEITADO (token rotacionou?)"); done(3); }
  if (m.msg === "web_access_granted") {
    if (action === "get") {
      ws.send(JSON.stringify({ msg: "command", id: 1, name: "get_settings", request: {} }));
    } else {
      // valores de setting sao strings; envia como string crua (nao JSON-encoded)
      ws.send(JSON.stringify({ msg: "command", id: 1, name: "update_setting", request: { key: arg1, value: arg2 } }));
    }
    return;
  }
  if (m.msg === "command_response" && m.id === 1) {
    if (!m.success) { console.error("xx ERR:", m.error); done(4); }
    if (action === "get") {
      const s = m.response.settings || m.response;
      for (const [k, v] of Object.entries(s)) {
        if (!arg1 || k.includes(arg1)) console.log(`${k} = ${JSON.stringify(v)}`);
      }
    } else {
      console.log(`OK ${arg1} = ${arg2}`);
    }
    done(0);
  }
});
ws.addEventListener("error", (e) => { console.error("[error]", e.message || e); done(1); });
setTimeout(() => { console.error("timeout"); done(5); }, 8000);
