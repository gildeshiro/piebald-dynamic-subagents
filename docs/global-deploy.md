# Global deployment of native subagent routing (without piebald-web)

How to make the "native subagent with its own brain via `[[pbroute ...]]`" behavior
**global and local**, without depending on `piebald-web`, a token, or an extra process.

## Why piebald-web is NOT needed (proven 2026-06-14)
Piebald (the main app and piebald-web) **re-reads `subagent_provider_id`/`model`/
`profile_id` from `app.db` at the moment it creates the native subagent**. Proof: I
wrote those settings DIRECTLY into `app.db` via sqlite (zero WS) and the next native
subagent was created with the written brain (subs 551 and 554 = provider 4 / gpt-5.5,
baseline was Claude). Therefore `update_setting` via WS was never special — it was
just writing to that same table.

## The 3 components
1. **Hook** `hooks/pretooluse-route.mjs` (PreToolUse): on a native tool (`Agent`/
   `LaunchSubagent`/`Task`), reads `[[pbroute provider= model= profile=]]` from the
   prompt and performs `UPDATE settings ...` in `app.db` (with `busy_timeout`).
   WS fallback only if the write fails. PreToolUse **blocks** until exit 0 → the
   write commits BEFORE the subagent is created.
2. **Global hook**: registered in `~/.claude/settings.json` (PreToolUse, matcher
   `Agent|LaunchSubagent|Task` → `hooks\pretooluse-route.cmd`). Works in ANY project.
   Backup of settings.json at `~/.claude/settings.json.bak-pbroute-*`.
3. **Directive** in the Default profile's system prompt (`base_gen_cfg_data.system_prompt`,
   gen_cfg_id 135) — source in `docs/pbroute-directive.txt`. Row-level backup at
   `.pbroute-default-systemprompt.bak` (gitignored).

## Activation
Requires a **Piebald restart** (system prompt and global hooks are read at boot/chat creation).
The `.cmd` wrapper uses `C:\PROGRA~1\nodejs\node.exe` (Node 24, `node:sqlite` OK) because
the Piebald hook environment has a minimal PATH.

## Reverting
- Directive: `UPDATE base_gen_cfg_data SET system_prompt=<contents of .pbroute-default-systemprompt.bak> WHERE gen_cfg_id=135;`
- Global hook: restore `~/.claude/settings.json` from the `*.bak-pbroute-*` backup
  (or remove the entry with matcher `Agent|LaunchSubagent|Task`).

## Usage
In a native subagent's prompt: `[[pbroute provider=4 model=gpt-5.5]] <task>`.
Multiple different brains → launch SEQUENTIALLY (the setting is global; parallel launches race).
Valid model-ids per provider: `control-plane/catalog.json`.

## When piebald-web still matters
- **WS worker path** (`create_chat`/`send_message_streaming`, programmatic parallel).
- **piebald-mobile-mod** project (remote/web access; uses `bin/start-piebald-web.ps1`).
The native path (this doc) uses neither.
