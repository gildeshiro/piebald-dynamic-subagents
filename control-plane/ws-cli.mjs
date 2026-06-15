#!/usr/bin/env node
// ws-cli.mjs — Piebald control-plane via WebSocket (validated in Phase 0).
//
// The piebald-web backend (ws://127.0.0.1:7000/api/ws) exposes `update_setting`,
// which modifies settings LIVE (memory + DB) without a restart. The next LaunchSubagent
// picks up the new value. This enables dynamic per-subagent provider/model/profile
// routing while preserving Piebald's legitimate subscription auth (OAuth).
//
// IMPORTANT:
//   - Setting values are ALWAYS strings, including IDs. Use "5", not 5.
//   - The token rotates on every piebald-web relaunch. Retrieve it with:
//       grep -oE 'token=[A-Za-z0-9]{20,}' "$APPDATA/Piebald/logs/$(date +%F).log" | tail -1
//   - NEVER commit the token. Pass it via argv or env PIEBALD_WEB_TOKEN.
//
// Usage:
//   node ws-cli.mjs get [filter]                 # read settings (filter by substring)
//   node ws-cli.mjs set <key> <string-value>     # update_setting (value always a string)
//   PIEBALD_WEB_TOKEN=... node ws-cli.mjs get subagent
//   node ws-cli.mjs --token <TOKEN> set subagent_provider_id 5

const argv = process.argv.slice(2);
let token = process.env.PIEBALD_WEB_TOKEN;
const ti = argv.indexOf("--token");
if (ti !== -1) { token = argv[ti + 1]; argv.splice(ti, 2); }
const port = process.env.PIEBALD_WEB_PORT || 7000;
const [action, arg1, arg2] = argv;

if (!token) { console.error("missing token (env PIEBALD_WEB_TOKEN or --token)"); process.exit(2); }
if (!action || !["get", "set"].includes(action)) { console.error("usage: get [filter] | set <key> <value>"); process.exit(2); }
if (action === "set" && (arg1 === undefined || arg2 === undefined)) { console.error("set requires <key> <value>"); process.exit(2); }

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
const done = (c) => { try { ws.close(); } catch {} process.exit(c); };

ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.msg === "web_access_required") { console.error("AUTH REJECTED (token rotated?)"); done(3); }
  if (m.msg === "web_access_granted") {
    if (action === "get") {
      ws.send(JSON.stringify({ msg: "command", id: 1, name: "get_settings", request: {} }));
    } else {
      // setting values are strings; send as a raw string (not JSON-encoded)
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