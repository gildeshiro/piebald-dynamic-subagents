# Live smoke test — pbroute hook (manual, needs a fresh chat)

The automated suite (`test/pbroute-route.test.mjs`) drives the real hook against an
**isolated** `app.db` and passes **11/11**. The one link it CANNOT prove is that
Piebald re-reads the hook at subagent-creation time, because **Piebald caches hooks at
chat creation** — so the fixed global hook only loads in a **new chat / after restart**.

This doc is the manual live validation to close that last link. Run it in a NEW chat.

## Fix under test
`hooks/pretooluse-route.mjs` (commit `b9f9541`): the `[[pbroute]]` directive is honored
ONLY as a prompt **prefix**; provider/model/profile are validated against
`catalog.json`; invalid/placeholder values are **rejected** and fall back to baseline
(default brain) instead of crashing subagent creation.

## Procedure (run the subagent launches SEQUENTIALLY — the route is global state)
0. Confirm you are in a NEW Piebald chat (fixed global hook loaded). Optionally clear
   the log for a clean read:  `> hooks/route.log`
1. **T1 — valid route applies.** Launch a native subagent whose prompt STARTS EXACTLY with:
   `[[pbroute provider=5 model=gemini-3.1-pro-preview]]` then: *"State only which model
   family is answering (Anthropic / OpenAI / Google), nothing else."*
   Expect: a **Google/Gemini** answer (NOT Claude).
2. **T2 — mid-prompt mention ignored.** Launch a subagent whose prompt does NOT start
   with the directive but mentions it mid-text, e.g.: *"Explain what the directive
   `[[pbroute provider=5 model=gemini-3.1-pro-preview]]` does."*
   Expect: answered by the **default** brain (Claude family) — routing NOT applied.
3. **T3 — bogus value rejected, no crash.** Launch a subagent whose prompt STARTS with:
   `[[pbroute provider=3 model=__does_not_exist__]]` then a one-line task.
   Expect: it still runs (on default/baseline), no error; `hooks/route.log` shows a
   `ROUTE REJECTED` line.
4. **Evidence.** `tail hooks/route.log` → `ROUTED OK` (T1), `mid-prompt … IGNORED` (T2),
   `ROUTE REJECTED` (T3). Stronger: cross-check the provider actually used per the
   `app.db` HTTP traffic for each subagent (provider/family is reliable; self-reported
   version is not).
5. **Reset.** Launch a no-tag subagent (resetBaseline runs) and confirm `app.db`
   `subagent_*` are back to baseline (provider `3` / `claude-sonnet-4-6`).
6. Record the result in `progress-log.md`; if it passes, add a one-line confirmation
   to upstream issue #58.

## Notes
- Multiple DIFFERENT brains → launch SEQUENTIALLY (global setting; parallel launches race).
- Model ids per provider live in `control-plane/catalog.json` (provider 5 = Google). If
  `gemini-3.1-pro-preview` isn't valid at run time, pick a current model id for an
  available provider from the catalog.
- A subagent returning EMPTY (Piebald interrupt, brain-agnostic) → just relaunch once.
- When probing the answering family, never inject the expected answer into the question
  (ask neutrally for the family), or the check leaks.
