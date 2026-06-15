# Phase 1 — Implementation plan v2 (revised after critical review)

> v1 went through a critical review by a different model (claude-sonnet). This v2
> incorporates those adjustments. Trail at the end of the doc. Everything relies on
> primitives ALREADY VALIDATED live. No MITM, no restart, legitimate subscription auth.

## One-line summary
An orchestrator that receives an NL phrase, decomposes it into N workers, creates 1 chat
per worker with its own **provider + model + profile (=reasoning)**, fires the task
(parallel with a concurrency ceiling), collects results, and cleans up.

## Conceptual model
- **worker = { provider_id, model, profile_id, permission_mode, task, dir, title }**
  - `profile_id` carries reasoning/effort (inherited from the profile). Reasoning is NOT
    per-message.
- Each worker = independent chat → heterogeneous parallel without a global race.

## Confirmed shapes (from recon — corrects v1 inaccuracies)
- `create_chat` → response `{chat:{id,...}, project:{...}}` → **`chat_id = chat.id`**
  (proven: chats 215, 217).
- `send_message_streaming.parts` (REAL shape, not `[text]`):
  ```json
  parts: [{ "type":"text", "text":{ "nodes":[{ "type":"text", "data":{ "content":"<task>" }}]}}]
  ```
  + `branching_intended:false` (and `parent_message_id` only if the chat already has messages).
- **Result reading (PRIMARY, already proven): app.db.** `message_parts` →
  text where `messages.parent_chat_id=chat_id`, role=assistant, final status;
  completeness via `chats.working_status` (idle). DB: `%APPDATA%\Piebald\app.db`
  (open as `file:...?mode=ro`).
- SECONDARY reading (bonus, from piebald-remote/PROTOCOL.md, re-verify in this
  version): `get_full_chat_history {chat_id}` + events `StreamedChunk`
  (variants `TextDelta`/`FinishMessage`/`FinishSession{finish_reason,
  total_generations}`) + `ChatUpdated{working_status}`.
- **To confirm empirically in 1a:** `config_id` vs `profile_id` in `create_chat`
  — hypothesis: passing only `profile_id` is sufficient (Piebald derives the config
  from the profile, as `change_chat_profile` does); `config_id` is optional/derived.

## WS commands used (confirmed)
`create_chat`, `change_chat_profile {chat_id,profile_id,force}`, `update_chat`,
`send_message_streaming`, `delete_chat`, `list_providers`, `list_profiles`,
`list_chats`, `get_chat`. (Removed `update_setting` — it was a Phase 0 residue;
the orchestrator does NOT use the global setting.)

## Sub-phases (reordered by review)

### 1.0 — TOKEN bootstrap [BLOCKING, isolated]
Binary criterion: the token connects and receives `web_access_granted`.
- [ ] ws-client reads **`PIEBALD_WEB_TOKEN`** (env). Without it → fast fail with
      instruction: "open the Piebald Web UI and copy the `?token=` from the URL".
- [ ] Best-effort fallback (convenience, not reliable): grep today's log at
      `%APPDATA%\Piebald\logs\<YYYY-MM-DD>.log` for `token=<...>` — BUT validate
      against `web_access_granted` (old token from log → rejected → clear error, not
      obscure). **Without** the 4 magic sources from v1.
- [ ] (Post-v1) evaluate using the `piebald-remote` launcher which writes
      `~/.piebald-remote/current-token` when it manages piebald-web.

### 1a — ws-client + shape validation [foundation]
- [ ] `ws-client.mjs`: connect+auth; `call(name, req, {timeoutMs})` with id correlation
      + **explicit per-call timeout** (default 15s for fast commands);
      `on(eventType, cb)`; detect `web_access_required` mid-session → error
      "token expired" (not generic).
- [ ] `readResult(chatId, {timeoutMs})`: poll `app.db` (working_status idle +
      last assistant text). DB path + query documented and tested via Node
      (sqlite3 CLI or driver).
- [ ] Validate/document live: `create_chat` response (chat.id), `parts` shape,
      and `profile_id` vs `config_id`.
- [ ] **Checkpoint:** no-op round-trip — `create_chat` → `readResult` (empty) →
      `delete_chat`. Confirm `delete_chat` is idempotent (calling twice doesn't break).

### 1b — runOne(spec) WITH error handling [no longer 1e]
- [ ] `runOne(spec)`: `create_chat` → `send_message_streaming` → `readResult`
      (timeout, default 180s) → `{ok, text|error, chatId, ms}`. **try/catch per
      worker** — isolated failure, never propagates.
- [ ] `permission_mode` is an **explicit spec field** [DECISION BEFORE CODING]:
      default `'default'` (safe; review/read tasks). `'yolo'` only when the
      caller explicitly opts in (implementation tasks). Document the risk.
- [ ] **Checkpoint:** 1 Claude worker (provider 3) on a trivial task, end-to-end.

### 1c — runMany with concurrency + cleanup [executable TODAY]
- [ ] `runMany(specs[], {maxConcurrency=3})`: parallel with ceiling; simple backoff on
      rate-limit/429 (reliability, not economy).
- [ ] **Orphan cleanup at start:** `list_chats` → `delete_chat` for chats with the
      orchestrator title prefix (e.g. `pbsub/`) not cleaned up from past runs.
- [ ] **Checkpoint (TODAY, no cross-provider):** 3 **Claude** workers with **distinct
      reasoning profiles** (e.g. high / low / default) in parallel; prove simultaneity
      via timestamps. Cross-provider (gpt/gemini) = separate task, gated on fixing
      OpenAI/Google (service_tier/store/model-id).

### 1d — catalog.json + interface + NL protocol
- [ ] `catalog.json` STATIC (manually maintained in v1): providers, valid models,
      profiles+effort. (Dynamic DB lookup = post-POC.)
- [ ] **`orchestrate.mjs` interface DEFINED here (before AGENTS.md):**
      reads `specs` JSON via stdin (or `--file`), writes `results` JSON to stdout,
      exit codes (0 ok, !=0 error).
- [ ] `AGENTS.md`: NL → `specs[]` protocol using catalog.json; fallback rules
      (nonexistent provider/effort → closest match or warning).

### 1e — hardening
- [ ] Reconnection / robust expired-token detection.
- [ ] Provider health-check (skip broken ones; use `get_all_rate_limit_info`).
- [ ] Fix OpenAI/Google (service_tier=flex, store, model-ids) → enable real cross-provider.
- [ ] (Optional) dynamic catalog from app.db; create profiles programmatically.

## Resolved decisions (were "open")
1. **Token v1**: env `PIEBALD_WEB_TOKEN` only, fail-fast.
2. **Result**: app.db is the primary read (proven); WS history is a bonus.
3. **permission_mode**: per-spec, safe default.
4. **catalog**: static JSON in v1.
5. **config_id/profile_id**: validate in 1a; default = pass only profile_id.

## Anti-scope
MITM/proxy; separate router-LLM; cross-provider payload translation; 4 token sources;
dynamic catalog in v1.

---
### Trail (v1 → v2, via critical review from a different model — claude-sonnet)
Accepted changes: token getter→env-only/isolated in 1.0; corrected `parts` shape;
per-worker error moved to 1b; explicit permission_mode before 1b; 1c redefined
for 3 Claude workers with distinct reasoning (cross-provider gated); orphan cleanup;
timeouts+concurrency+backoff; static catalog; orchestrate interface before AGENTS.md;
removed `update_setting` from orchestrator. Rejected/corrected: `create_chat` shape
(already known = chat.id) and result reading (non-blocking, via app.db already proven).
