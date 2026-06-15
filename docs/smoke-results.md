# Smoke test — all models × providers (2026-06-10)

Run via `control-plane/probe.mjs --concurrency 3` (very short task "reply PROBE-OK"
per combo, auto-delete on success). **20/37 OK.** The result OVERTURNED the old assumption
("only Anthropic works") — today, via piebald-web workers, it is **Claude that is down**.

## Summary by provider
| Provider | OK | Failures | Notes |
|---|---|---|---|
| ChatGPT Plus (4) | **4/4** | — | gpt-5.5, 5.4, 5.4-mini, codex-auto-review. (The former "broken" was a PROFILE quirk, not the provider.) |
| Google work (5) | 5/8 | 404×2, 429×1 | OK: 3.1-pro-preview, 3-pro-preview, 3-flash-preview, 2.5-flash, 2.5-flash-lite |
| Google personal (1) | 6/8 | 404×1, 404×1 | OK: same + 2.5-pro |
| Antigravity work (2) | 5/6 | 400×1 | OK: 3.1-pro-low, 3-flash, claude-opus-4-6-thinking, claude-sonnet-4-6, gpt-oss-120b |
| Claude Max (3) | **0/11** | **401×11** | 🚨 all `Invalid authentication credentials` |

## Failure taxonomy (quirks for the dev team)
- **Claude Max → HTTP 401 (all 11):** `authentication_error: Invalid authentication credentials`.
  **NOT rate-limit or burst** (an isolated worker also returned 401). Diagnosis: `piebald-web`
  is a **separate process** from the main app and had **stale Claude Max OAuth** — the main
  session (same provider 3) works with a fresh token; workers via piebald-web got the old
  token → 401 for Claude only. Other providers in piebald-web had a valid token → passed.
  **Likely fix: relaunch piebald-web.**
  → Relevant quirk: *workers spawned via piebald-web use piebald-web's auth context,
  which may diverge from the main app.*
- **Google 404:** model-ids not serviceable on this account/engine: `*-customtools` variants,
  `gemini-2.0-flash`. (They appear in `refresh_provider_models` but don't serve chat.)
- **Google 429:** `gemini-2.5-pro` on the `work` account (quota); the SAME model passed
  on the `personal` account → it is per-account quota, not a model issue.
- **Antigravity 400:** `gemini-3.1-pro-high` (payload parameter issue).

## Code fix revealed by the smoke test
`readResult` was waiting 60s when `working_status='error'` with no assistant (the Claude 401s).
Fix: `working_status` in `{error, abandoned}` → **immediate** failure. (committed)

## Implications
- **Real cross-provider ALREADY works** (OpenAI + Google + Antigravity green) —
  overturns the "Anthropic only" claim that was in old memories.
- The catalog should mark **chat-time** status (not just "lists") — the 404/400 failures are
  model-ids that list but don't serve. Candidate field `chat_ok` in the catalog via probe.
- For the Piebald POC: attach this matrix as evidence of real per-provider/model quirks.
