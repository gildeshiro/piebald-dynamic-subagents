# WebSocket Protocol — piebald-web.exe

`piebald-web.exe` serves Piebald's web interface at `http://127.0.0.1:7000`
(default port). The backend **is not REST** — the only real API endpoint is a
JSON-RPC WebSocket.

All knowledge here was obtained by:
1. Instrumenting the global `WebSocket` via `initScript` in chrome-devtools
2. A "capture-and-block" session (intercepting frames before they reach the backend)
3. String analysis of the `piebald-web.exe` binary (Rust/Rocket)

---

## Endpoint

```
ws://127.0.0.1:<port>/api/ws?token=<TOKEN>
```

| Property | Value |
|---|---|
| Host | `127.0.0.1` (loopback only) |
| Default port | `7000` |
| Port override | env `PIEBALD_WEB_PORT` |
| Authentication | query param `?token=<TOKEN>` |
| Bind | loopback only — not exposed on the network |

---

## Access token (web ownership token)

The token is a **"server ownership token"** generated at `piebald-web.exe` launch.

**Critical properties:**
- Generated at runtime — **NOT stored in `app.db`**
- **ROTATES on every relaunch** of `piebald-web.exe`
- Appears in the launch URL: `http://127.0.0.1:7000/?token=<TOKEN>`
- Pass via `--token TOKEN` or env `PIEBALD_WEB_TOKEN`
- **Never print, log, or commit the token**

If a connection fails with "auth not granted" (exit 3), the token was rotated —
you must re-obtain it from the piebald-web launch URL.

---

## Authentication handshake

On connect, the server **immediately** sends one of two frames:

| Frame | Meaning |
|---|---|
| `{"msg":"web_access_required"}` | Token missing or invalid — auth rejected |
| `{"msg":"web_access_granted"}` | Auth OK — commands can be sent |

**Rule:** wait for `web_access_granted` before sending any command.
Other frames (push events) may arrive before granted — ignore them.

---

## Command protocol

### Request (client → server)

```json
{
  "msg": "command",
  "id": <int>,
  "name": "<command_name>",
  "request": { ... }
}
```

- `id`: unique integer for correlating responses. Suggestion: `int(time.time() * 1000) % 1_000_000`
- `name`: command name (see §Known commands)
- `request`: command-specific payload

### Response (server → client)

```json
{
  "msg": "command_response",
  "id": <int>,
  "success": true,
  "response": { ... }
}
```

```json
{
  "msg": "command_response",
  "id": <int>,
  "success": false,
  "error": "<error message>"
}
```

### Push events (server → client, unsolicited)

```json
{
  "msg": "event",
  "type": "...",
  "data": { ... }
}
```

Push events arrive asynchronously — when waiting for a specific `command_response`,
filter by `msg == "command_response" AND id == <cmd_id>` and ignore the rest.

---

## Known commands

### `send_message_streaming` ⭐ (confirmed via capture-and-block)

Injects a user message into a chat and triggers a new model turn.
Functionally equivalent to the user typing and sending a message in the UI.

**Exact request schema** (captured live 2026-06-02):

```json
{
  "msg": "command",
  "id": 58,
  "name": "send_message_streaming",
  "request": {
    "chat_id": 21,
    "parts": [
      {
        "type": "text",
        "text": {
          "nodes": [
            {
              "type": "text",
              "data": {
                "content": "MESSAGE HERE"
              }
            }
          ]
        }
      }
    ],
    "parent_message_id": 520,
    "branching_intended": false
  }
}
```

**Fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `chat_id` | int | ✅ | Target chat ID |
| `parts` | array | ✅ | Always 1 element for plain text |
| `parts[0].type` | string | ✅ | Always `"text"` |
| `parts[0].text.nodes[0].type` | string | ✅ | Always `"text"` |
| `parts[0].text.nodes[0].data.content` | string | ✅ | Message body |
| `parent_message_id` | int | conditional | `MAX(id)` from `messages WHERE parent_chat_id=chat_id`; omit if the chat has no messages |
| `branching_intended` | bool | ✅ | Always `false` for autonomous wake |

**Notes:**
- `branching_intended` is the correct name — NOT `branching_initiated`
- The `parts > text > nodes > data > content` structure is doubly nested — do not flatten it
- The field is `parent_message_id` (not `parent_chat_id` — those are different)
- A `success: true` response means the turn was accepted; the model then processes it

### Other commands (identified via WebSocket instrumentation, not directly tested)

| Command | Likely function |
|---|---|
| `get_all_rate_limit_info` | Returns rate-limit info for all providers (!) |
| `list_providers` | Lists configured providers |
| `get_chats_with_folders` | Lists chats grouped by folder |
| `get_projects` | Lists projects |
| `get_user_info` | Logged-in user info |
| `get_settings` | Current Piebald settings |
| `get_subscription` | Subscription info |
| `update_chat_draft` | Updates the chat draft (auto-save) |

> ⚠️ Command names **do not appear as literals in the `main-*.js` bundle**
> (they are assembled at runtime). To discover new commands: instrument the
> global WebSocket in the browser and capture real UI frames.
> See `§How to discover new commands` below.

---

## Verified live: end-to-end wake injection (2026-06-02)

Test performed:
1. Chat 21 (throwaway), `parent_message_id = 520` (confirmed via `MAX(id)` in `app.db`)
2. Token obtained from the `piebald-web.exe` launch URL
3. `send_message_streaming` frame sent
4. Response: `success: true`
5. New model turn started (visible in app.db — new user message + assistant row)
6. The model turn failed with `HTTP 404` from `daily-cloudcode-pa.sandbox.googleapis.com`
   (`antigravity` provider with broken configuration in the test chat)

**Conclusion:** the injection mechanism works end-to-end. The error was a provider
issue in the test chat, not a protocol issue.

---

## How to discover new commands

### Method 1: WebSocket instrumentation in the browser

```javascript
// Run in DevTools Console with the Piebald page open
const _orig = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed.msg === 'command') {
        console.log('[WS SEND command]', parsed.name, JSON.stringify(parsed.request));
      }
    } catch(e) {}
  }
  return _orig.apply(this, arguments);
};
```

Then: interact with the UI normally and observe the logs.

### Method 2: Capture via `initScript` (chrome-devtools MCP)

The `chrome-devtools` MCP has an `initScript` parameter that injects JavaScript
before the page loads — allowing you to capture the full handshake from the start.

### Method 3: Capture-and-block

To capture the exact schema of a command without actually executing it:
1. Open DevTools
2. Inject an interceptor that stores the frame in `window.__capturedFrames`
3. Perform the action in the UI
4. Read `window.__capturedFrames` before the frame is sent

---

## `wake-inject.py` — implemented client

The script `C:\Projects\octo-fullstep-forge\skills\octo-fullstep\scripts\wake-inject.py`
implements a full WebSocket client for `send_message_streaming`.

**Usage:**
```bash
# Dry-run (no send — prints the frame that would be sent)
python wake-inject.py --text "message" --dry-run

# Live send to active chat
PIEBALD_WEB_TOKEN=<token> python wake-inject.py --text "message"

# Send to specific chat
PIEBALD_WEB_TOKEN=<token> python wake-inject.py \
    --text "message" \
    --chat-id 21 \
    --port 7000
```

Exit codes: 0=ok, 2=token/text missing, 3=auth rejected, 4=command rejected, 5=chat not found.

---

## Notes on the `piebald-web.exe` binary

- Runtime: **Rust** with **Rocket** framework (HTTP server)
- The `/api/*` routes are SPA frontend catch-alls — the only real endpoint is the WebSocket
- The binary accepts the `--port` parameter
- App version **0.4.0** (identified via `web_access_granted` WebSocket frame)
- No Swagger/OpenAPI exposed
- Command logic is built at runtime — names do not appear as literal strings
