# Phase 0 — Validation findings (live recon, 2026-06-03)

Empirical validation performed by running inside Piebald and modifying the live app
(reversible). Everything confirmed with evidence, not assumptions.

## Central finding: the control-plane solves the problem — no MITM, no restart

Piebald's subagent reads provider/model/profile from **global settings**
(`subagent_provider_id`, `subagent_model`, `subagent_profile_id`,
`subagent_use_custom_config`). There is no native per-launch config — that is the
bottleneck. **But** those settings can be swapped LIVE via WebSocket, and the next
`LaunchSubagent` picks up the new value when the child-chat is created.

### `update_setting` command (the live mutator)

`ws://127.0.0.1:7000/api/ws` exposes:

```json
{ "msg":"command", "id":1, "name":"update_setting",
  "request": { "key":"subagent_model", "value":"claude-sonnet-4-6" } }
```

- Updates **memory + DB** together → **no restart**.
- **Values are ALWAYS strings**, including IDs: `"5"`, not `5`
  (real error: `invalid type: integer 5, expected a string`).
- Names that do NOT exist: `set_settings`, `update_settings`, `set_setting`,
  `save_settings`, `patch_settings`, `set_subagent_settings`. Only `update_setting`.

### Full proof (cross-provider live)

1. `update_setting subagent_provider_id="5"` (Google) + `subagent_model="gemini-3.5-flash"`.
2. Triggered a trivial subagent (tool Agent = `LaunchSubagent`).
3. The subagent's request went to **`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`**
   (Google endpoint) — not `api.anthropic.com`.
4. → The live provider swap was honored end-to-end by the next launch.

> The subagent returned HTTP 404 (`gemini-3.5-flash` does not exist at that
> cloudcode/account endpoint) — a model availability quirk, NOT a protocol failure.
> Validating the catalog of valid model-ids per provider is a Phase 1 task.

Settings restored to default (provider 3 / claude-sonnet-4-6) at the end of the test.

## Anatomy of a subagent request (target of any future rewrite)

Body (Anthropic `/v1/messages?beta=true`), clean JSON:

```json
{ "model":"claude-sonnet-4-6", "max_tokens":32000,
  "thinking":{"type":"adaptive","display":"summarized"},
  "system":[...], "messages":[...], "tools":[...], "stream":true }
```

- Auth = **subscription OAuth** (header `anthropic-beta` includes `oauth-2025-04-20`).
  Confirms that the right approach is to preserve the legitimate call (not an API key).
- Effort/thinking travel via beta flags (`effort-2025-11-24`,
  `interleaved-thinking-2025-05-14`) + the `thinking` field.

## Relevant data model (app.db)

- `messages`: has `model`, `provider_id`, `profile_id`, `config_id` PER MESSAGE.
- `chats`: subagent is a child-chat via `subagent_parent_chat_id`; has its own
  `provider_id`/`model`/`profile_id`/`config_id` + `default_subagent_profile_id`.
- `profiles` → `generation_configs` (+ per-engine overrides:
  anthropic `effort`/`thinking_*`, openai `reasoning_effort`/`service_tier`,
  google `thinking_budget`).
- → The heterogeneity infrastructure ALREADY exists in the schema; only the *choosing* at
  launch time is missing.

## Architecture implication

The **MITM/data-plane proxy is deprioritized** (likely unnecessary for v1).
The backbone is the control-plane: `update_setting` (set) → launch, per subagent, using
the legitimate subscription auth. Economic, ban-safe, minimal code.

### Open for Phase 1
- Global setting race in **heterogeneous parallel**: needs set→launch without a race.
  Investigate WS command to **create/spawn a subagent with an explicit provider/model**
  (bypasses the global) — e.g. `create_chat`/`spawn_subagent`.
- Catalog of valid model-ids per provider (avoid 404 like gemini-3.5-flash).

### POC for the Piebald team
"Expose a generation-config override per `LaunchSubagent`. `update_setting`
already applies live; the DB already stores provider/model/config per-chat and
per-message. Only the override at launch time is missing." Prototype = evidence.
