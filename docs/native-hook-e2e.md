# Native end-to-end + JIT-routing hook — live validation (2026-06-14)

Session that proved the **native heterogeneous subagent** path via PreToolUse hook,
fixed `readResult`, and dissected the "frozen Gemini" case.

## 1. `working_status` state machine (chats) — discovery in app.db

| state | class | action in readResult |
|---|---|---|
| `working`, `backlog` | in progress | keep polling |
| `done`, `finished`, `idle` | terminal OK | settle (success if there is text) |
| `error`, `abandoned` | terminal FAIL | return error immediately |
| `waiting_tool_call` | **paused for tool** | normally TRANSIENT; secondary timeout `stuckToolMs` for this state only |

`messages.status`: `completed` / `interrupted` / `error`.
`message_part.part_type`: `tool_call` / `text` / `context_notification` / `image`.
`message_part_tool_call.tool_state`: `completed` / `error` / `interrupted` / `denied` / `pending` / `executing`.

## 2. The "frozen Gemini" case (chat 538, soft-deleted, resurrected from the DB)

The worker's assistant message had **2 `tool_call` parts and ZERO `text`**:
1. `TodoWrite` → *"Brainstorm for the haiku..."*
2. `retrieve_tools` query=`"brainstorming"`

**Root cause:** the `brainstorming` skill auto-triggered (AGENTS.md/system prompt:
"MUST brainstorm before creative work"). A 1-line task turned into tool mode;
the tools stayed `pending` → `waiting_tool_call` → froze for 180s.

Consequences:
- **Naive wrong fix**: "assistant=completed → get text" would return **""** (no text part exists). That's why readResult now returns status `no_text` when the assistant completed with tool_call only.
- **Probe hygiene**: simple probe = *"reply in ONE line, no tools"*. Measured 2.7s (clean) vs 59s (with brainstorming detour).
- **Models lie about their own name** (Gemini said "Claude 3.5 Sonnet" in a probe). Always verify the brain via `messages.provider_id`/`model` in app.db, never by the text response.

## 3. readResult v3 (control-plane/ws-client.mjs)

- `PROGRESS={working,backlog}` `DONE={done,finished,idle}` `FAIL={error,abandoned}`.
- `waiting_tool_call`: secondary timeout `stuckToolMs` (default 30s) — does not block, but
  does not false-positive a slow worker (validated: Gemini with detour completed in 59s without triggering).
- New return statuses: `paused_tool_call` (stuck in tool) and `no_text` (completed with tool_call only, zero text).
- `pendingToolCalls(chatId)` exposes the `pending/executing/denied` tools of the last assistant.
- `orchestrate.runOne`: `ok = status==='completed'` (previously `!== 'error'` let `no_text`/`paused` through).

## 4. Native heterogeneous subagent via hook — PROVEN CLEAN

Vector: TEST CHAT (chat 541, Claude Sonnet 4.6, YOLO) in the web UI, directed via chrome-devtools.

**3 unknowns of the hook → all resolved:**
- Does PreToolUse fire in project chats? **YES** (route.log captures ALL tools).
- Does it fire for the native subagent? **YES** — the native tool is called **`Agent`** in this runtime
  (`input_keys=prompt,description,subagent_type`), not "LaunchSubagent".
- Timing before creation? **YES** — `ROUTED OK` always in the same second as the child-chat creation.
- Race on parallel? **Avoided** by running **sequentially** (1 Agent at a time).

**Clean test (orchestrator PROHIBITED from routing manually; global baseline = Claude P3):**
all 4 subagents were created with the EXACT brain from the tag (if the hook had failed, they would all come out as claude-sonnet):

| sub | tag | created (app.db) | responded |
|---|---|---|---|
| 544 | P4 gpt-5.5 | prov 4 / gpt-5.5 | PONG gpt-5.5 |
| 545 | P5 gemini-3-flash-preview | prov 5 / gemini-3-flash-preview | PONG gemini-3-flash-preview |
| 546 | P2 gpt-oss-120b-medium | prov 2 / gpt-oss-120b-medium | PONG gpt-oss-120b-medium |
| 547 | P1 gemini-2.5-flash | prov 1 / gemini-2.5-flash | PONG Gemini 2.5 Flash |
| 548 | P3 claude-haiku-4-5 | prov 3 / claude-haiku-4-5 | PONG claude-haiku-4-5 |

→ **5 providers (P1–P5)** covered via native subagent, all in the main app (fresh auth),
all rendering as native subagents in the UI (`subagent_parent_chat_id=541`, "Open chat" button).
Screenshot: `docs/native-subagents-ui.png`.

## 5. Hook bug fixed (greedy → gated)

Before: the hook routed for ANY tool whose serialized input contained `[[pbroute]]`
(false positive: the browser's own `fill()` call with the tag in the text re-routed the global!).
Now: **gate `tool ∈ {Agent, LaunchSubagent, Task}`** before any action.

## 6. Confound to remember

If the orchestrator chat is a capable agent primed by the project's AGENTS.md, it
**routes manually via WS** (reads the control-plane and does `update_setting` on its own),
masking the hook. To test the hook in isolation: explicitly instruct "DO NOT use Bash/WS/update_setting;
routing is automatic." That is how the clean proof (section 4) was obtained.

## Pending / next steps
- Per-MODEL coverage (37) on the native path: per-model viability is already in the WS smoke
  (same auth/model-ids); native differs only in the process (main app vs piebald-web).
- Continuing a worker in `waiting_tool_call`/`denied` (responding to a tool call) — layer 2.
- (idea) the hook could write to the subagent's system prompt via a profile, not just reasoning.
