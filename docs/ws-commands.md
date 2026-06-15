# WebSocket — discovered command surface (Phase 0/1, validated 2026-06-03)

Endpoint: `ws://127.0.0.1:<PIEBALD_WEB_PORT|7000>/api/ws?token=<TOK>`
Handshake: wait for `{"msg":"web_access_granted"}` before sending a command.
Envelope: `{"msg":"command","id":N,"name":"<cmd>","request":{...}}` →
response `{"msg":"command_response","id":N,"success":bool,"response"|"error"}`.

> Token rotates on every relaunch of `piebald-web.exe` and **only appears in the log
> when the browser opens the URL** (`GET /?token=`). Not in cmdline or state file.
> Robust token getter = open Phase 1 item.

## CONFIRMED commands

| Command | Request | Response / effect |
|---|---|---|
| `get_settings` | `{}` | `{settings:{...}}` (typed settings) |
| `update_setting` | `{key, value}` | **value is ALWAYS a string** (`"5"` not `5`). Applies memory+DB **live, without restart** |
| `list_providers` | `{}` | `{providers:[{id,name,type,engine_type,...}]}` |
| `get_all_rate_limit_info` | `{}` | quota for all providers (seen in a previous session) |
| `list_chats` | `{}` | `{chats:[...]}` |
| `get_chat` | `{chat_id}` | `{chat:{...}}` (includes provider_id/model/config_id/profile_id/current_directory/project_id) |
| `create_chat` | `{model_config:{provider_id,model,config_id,profile_id}, current_directory, title}` | `{chat, project}` — **creates an independent worker with a chosen brain** |
| `update_chat` | `{chat_id, model_config:{provider_id,model}}` | `{success}` — swaps the brain of an existing chat |
| `delete_chat` | `{chat_id}` | soft delete (`is_deleted=1`) |
| `duplicate_chat` | `{chat_id, ...}` | exists (clones chat) |
| `list_profiles` | `{}` | `{profiles:[{id,name,config_id,is_system,is_ootb}]}` |
| `create_profile` | `{name, ...}` | exists (creates profile = named config) |
| `send_message_streaming` | `{chat_id, parts:[{type:"text",text:{nodes:[{type:"text",data:{content}}]}}], parent_message_id?, branching_intended:false}` | injects message + triggers turn (proven) |

## Commands that do NOT exist
`set_settings`, `update_settings`, `set_setting`, `save_settings`, `patch_settings`,
`spawn_subagent`, `create_subagent`, `launch_subagent`, `get_messages`,
`get_chat_messages`, `archive_chat`, `remove_chat`.
→ An "official" subagent only spawns via the model's `LaunchSubagent` tool. For
programmatic orchestration we use `create_chat` + `send_message_streaming`.

## Recipe: race-free heterogeneous parallel (the goal)

Without MITM, without restart, using legitimate subscription auth. For each worker
`{provider_id, model, effort→config_id/profile_id, task, dir}`:

1. `create_chat {model_config:{provider_id, model, config_id|profile_id}, current_directory: <project>, title}`
   → the brain is fixed **at chat creation** → **no race on the global setting**.
2. `send_message_streaming {chat_id, parts:[task text]}` → triggers the turn.
3. Run N in parallel (independent chats, distinct brains simultaneously).
4. Read result from `app.db` (`message_parts`→text where `parent_chat_id=chat_id`,
   role=assistant, final status); track via `chats.working_status`.
5. `delete_chat {chat_id}` to clean up, or keep as an audit trail.

Effort/reasoning: point `config_id`/`profile_id` to a `generation_config`
with the engine override (anthropic `effort`/`thinking_*`, openai
`reasoning_effort`/`service_tier`, google `thinking_budget`). Pre-create
effort-specific profiles with `create_profile`.

## Open for Phase 1
- **Robust token getter** (rotates, only logged when opening the UI).
- **Worker output reading** without a dedicated WS command (use app.db / polling
  `working_status`; or find a message-reading command).
- **Catalog of valid model-ids per provider** (avoid 404 like gemini-3.5-flash):
  via `list_providers` + `provider_custom_models` + `model_listing` requests in app.db.
