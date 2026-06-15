# Dynamic subagent orchestrator — usage instructions

> **Portable.** This block works both as an `AGENTS.md` in the root of the
> `piebald-dynamic-subagents` project (Piebald auto-loads AGENTS.md from the current
> folder) and pasted into a **profile's system prompt** (maximum adherence, `system`
> field). Choose one. No router-LLM required: YOU (the model in this chat) are the
> orchestrator.

## When to activate
When the user asks, in natural language, to run one or more tasks in
**subagents/workers** — especially specifying **provider, model, reasoning
or parallelism** (e.g. *"have a gpt-5.5 xhigh review session A while 2
sonnets implement session B"*).

## How to execute (4 steps)

1. **Resolve names** by reading `control-plane/catalog.json` (source of truth for
   model-ids; regenerate with `node control-plane/discover-models.mjs`). Map the
   phrase → `{provider_id, model, profile_id}`:
   - "claude/opus/sonnet/haiku" → provider **3** (Claude Max) + the `model` from the catalog.
     ⚠️ **Claude via WS worker is returning 401** (stale Anthropic OAuth in memory in
     `piebald-web.exe`; the main app has fresh auth → 200). For Claude: either **restart
     piebald-web** (refreshes the auth from the DB, rotates the token) or run Claude as
     a **native subagent** (LaunchSubagent runs in the main app = fresh auth = ✅).
     GPT (P4) and Gemini (P5/1) run normally via WS.
   - "gpt-5.5/5.4/codex" → provider **4** (ChatGPT Plus). List models; chat-time may
     have quirks (`service_tier`/`store`) — warn if not yet validated by probe.
   - "gemini" → provider **5/1** (Google) or **2** (Antigravity, aggregates Claude/Gemini/gpt-oss).
     Use the REAL model-ids from the catalog (e.g. `gemini-3-pro-preview`, not `gemini-3.5-flash`).
   - **Reliability**: catalog `status:"ok"` = the provider LISTS the model; whether a worker
     actually runs is what `control-plane/probe.mjs` validates. Chat-time proven via WS:
     **GPT-5.5 (P4) ✅, Gemini (P5) ✅; Claude (P3) ❌ 401 via worker** (see warning above).
   - **reasoning** ("high/xhigh/low/max") → choose the `profile_id` whose effort matches
     (reasoning is ALWAYS via profile, all engines). Today: **Default (id 1)** =
     anthropic max / openai xhigh; **test (id 4)** = anthropic max / openai high. If the
     requested effort has no profile, **materialize one on the fly** (idempotent):
     `node control-plane/profiles.mjs ensure <name> --anth <low|medium|high|max> --oai <low|medium|high|xhigh> --google <int>`
     — creates the profile and FORKS the config (copy-on-write, Default unchanged), returning
     the `profile_id` for the spec. (Profile system_prompt is not settable here yet —
     only reasoning overrides; persona via system_prompt = future discovery.)

2. **Build the specs.** Each worker:
   ```json
   { "provider_id": 3, "model": "claude-sonnet-4-6", "profile_id": 1,
     "task": "<complete self-contained worker prompt>", "keep": false }
   ```
   - `task` must be self-contained (the worker is a new chat, without this history).
   - `keep: true` retains the chat (for auditing); default deletes on success.

3. **Dispatch** (cwd = project root; requires `PIEBALD_WEB_TOKEN` in env):
   ```bash
   echo '{"specs":[ ...specs... ]}' | node control-plane/orchestrate.mjs
   ```
   - If `PIEBALD_WEB_TOKEN` is not set, **ask the user** for the Piebald
     Web UI token (`http://127.0.0.1:7000/?token=…`). It rotates on each piebald-web relaunch.
   - Runs in parallel (default ceiling 3). Output = `{"results":[{ok,chatId,text,status,ms},...]}`.

4. **Report** each worker to the user: the `text` (result) + `status` + time.
   For failures (`ok:false`), show the `error` and the `chatId` (it was not deleted).

## Safety (defaults)
- **Only Anthropic (provider 3) is verified.** For providers 4/5, warn that it may
  fail before spending the call.
- Workers are created in **permission_mode `yolo`** (Piebald default) — they
  can run tools and write files. **Do not** give a worker destructive tasks unless
  the user explicitly requests it. For read-only/analysis tasks this is harmless;
  for implementation tasks, confirm the scope.
- The orchestrator performs **orphan cleanup** (chats with prefix `pbsub/`) at the
  start of each `runMany` via `cleanupOrphans`.

## Note on system prompt × profile (the hook)
Because the worker's `profile_id` carries the **system prompt** (the `system` field,
the highest-adherence placement) **and** the reasoning, choosing the profile =
choosing the worker's "soul" + effort in one shot. This is the foundation for dynamic
personas: a "skeptical reviewer xhigh" profile, a "fast implementer low" profile, etc.,
selectable by phrase.
