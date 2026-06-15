# PreToolUse hook test (native subagent + dynamic brain)

Objective: validate whether a **native subagent** (Piebald's native window) can have
a **per-subagent brain**, via a PreToolUse hook that sets the global JIT before creation.

## Setup (one-time)
1. Paste the Piebald Web UI token and save it to `.pbtoken` (gitignored):
   `echo YOUR_TOKEN > C:\Projects\piebald-dynamic-subagents\.pbtoken`
   (or export `PIEBALD_WEB_TOKEN` in the environment that Piebald sees).
2. **Open a NEW CHAT** in this project (Piebald caches hooks at chat creation;
   the hook does not load mid-session).

## Test (in the new chat)
Ask the agent to **launch 2 native subagents sequentially**, each with the tag
at the start of the prompt:
- Subagent A: `[[pbroute provider=3 model=claude-opus-4-8]] Reply only: AGENT-A`
- Subagent B: `[[pbroute provider=3 model=claude-haiku-4-5-20251001]] Reply only: AGENT-B`

(Use Piebald's native subagent tool, NOT orchestrate.mjs.)

## What to check (the 3 unknowns)
1. **Did it fire?** `hooks/route.log` has `fired tool=...` lines → reveals the real
   `tool_name` for the subagent and the shape of `tool_input` (which field holds the prompt).
2. **Did it route?** There is a `ROUTED OK -> ...` entry per subagent.
3. **Did it pick up the right brain + timing?** In app.db, the 2 subagent child-chats
   (`subagent_parent_chat_id` set) were created with distinct `model` (opus vs haiku):
   ```sql
   SELECT id, model, provider_id, subagent_parent_chat_id
   FROM chats WHERE subagent_parent_chat_id IS NOT NULL ORDER BY id DESC LIMIT 4;
   ```
   - If the models match the tags → **timing OK** (hook sets before creation).
   - If they come out equal → race; narrow the strategy (sequential/lock).

## After
- **Narrow the matcher**: replace `"*"` with the real `tool_name` discovered (less overhead).
- **Restore** the global: `node control-plane/ws-cli.mjs set subagent_provider_id "3"`
  and `... set subagent_model "claude-sonnet-4-6"` (the hook leaves the last set value).
- Windows gotchas: hook runs via `cmd /C` (minimal PATH) → the `.cmd` wrapper calls
  `C:\PROGRA~1\nodejs\node.exe`. Changed settings.json → **new chat** to reload.
