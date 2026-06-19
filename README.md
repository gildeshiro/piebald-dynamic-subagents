# piebald-dynamic-subagents

**Heterogeneous** native subagents for **Piebald**: give each native subagent a
**different brain** (provider + model) and its **own profile** (reasoning +
system prompt) at launch time — something Claude Code does via the subagent's
`model:` frontmatter field, but which Piebald does not expose natively.

Piebald routes **all** subagents to the same default provider/model/profile.
There is no "this subagent uses Opus, that one uses Gemini, the other uses Haiku"
field. This project adds per-subagent routing without forking Piebald: a **`PreToolUse`
hook** reads a routing directive from the subagent's prompt and writes the route into
`app.db` **just-in-time**, before the subagent is created.

> Replicates the `model:`/per-subagent-persona feature of Claude Code within the
> constraints of Piebald (which has no public per-subagent routing API). The route
> is a global state flipped per launch — hence the ordering rules below.

---

## The directive

In the subagent's prompt, an optional prefix selects the brain and profile:

```
[[pbroute provider=<id> model=<model-id> profile=<id>]]
```

Any subset of the three fields is valid; only the present ones are applied. Without
the tag, the subagent inherits the current default (Claude). Examples:

```
[[pbroute provider=2 model=gemini-3.1-pro-low]]             Research this API and summarize…
[[pbroute provider=3 model=claude-opus-4-8 profile=4]]        Perform the security audit…
[[pbroute provider=4 model=gpt-5.5]]                          Critique this plan…
```

Valid `provider`/`model` values live in `control-plane/catalog.json` (generated live).
`profile` points to a Piebald Profile (default provider/model + **reasoning
effort** + system prompt) — it carries the persona + reasoning level.

> **Safety (prefix-only + validated).** The directive is honored **only as a prefix**
> (the leading token of the prompt). A directive that merely appears mid-prompt — in
> an example, a quote, documentation being processed, or untrusted content — is
> **ignored**, so handling text that mentions the tag can't hijack routing. Every
> field is also **validated against `catalog.json`** before it is written; an unknown
> or placeholder value (e.g. `model=<model-id>`) is **rejected** and the launch falls
> back to the baseline (default brain) instead of poisoning the global route and
> crashing subagent creation. See `test/pbroute-route.test.mjs`.

---

## Components

| Component | What it does | Covers | File |
| --- | --- | --- | --- |
| **Hook** | `PreToolUse` hook that detects the routing directive and JIT-writes the route into `app.db` before the subagent is created | "apply the route" | `hooks/pretooluse-route.mjs` · `.cmd` |
| **Guard** | Anti-misroute: baseline + changes-guard (prevents a route from leaking across launches) | "no silent misrouting" | `hooks/pretooluse-route.mjs` (A1/A2) · `control-plane/pbroute-baseline.json` |
| **Catalog** | Live discovery of providers/models/profiles | "what can be routed" | `control-plane/catalog.json` · `discover-models.mjs` |
| **Profiles** | Create/edit/remove Profiles via Piebald's legitimate API | "personas + reasoning" | `control-plane/profiles.mjs` |
| **Probe** | Validates that a model actually runs as a worker (`status ok` ≠ actually runs) | "no ghost routes" | `control-plane/probe.mjs` |
| **WS client** | WebSocket client for web-mode (`readResult v3`) used by the control-plane | "talk to the engine" | `control-plane/ws-client.mjs` · `ws-cli.mjs` |

---

## Golden rule: heterogeneous in parallel causes a race

The route is a **global state** that the hook flips per launch. Therefore:

- Subagents that need **different** brains → launch **sequentially**
  (one at a time; one route must not leak into another).
- Subagents with the **same** brain in parallel → fine.
- No tag → inherits the default; use the tag only when the subagent **truly** needs
  a different brain.

Validation: proven end-to-end across all providers; 41 models probed (25 run, 16 list-only —
see `control-plane/catalog.json` `probe` flags + `_meta.probe`; `docs/native-hook-e2e.md`,
`docs/smoke-results.md`).

---

## Installation

The hook is wired in `.claude/settings.json` (PreToolUse). See `docs/global-deploy.md`
for global host wiring and `docs/pbroute-directive.txt` for the directive text
that goes into the profile's system prompt (trains the agent to use the tag by instinct).

> Hooks in Piebald are cached at **chat creation** — if you modify the wiring, open a
> new chat (global → restart the app).

---

## Foundation (how this is possible)

Everything rests on three discoveries about Piebald's `app.db`
(`C:/Users/<you>/AppData/Roaming/Piebald/app.db`), documented in `docs/`:

1. **Subagent routing is persisted** — `subagent_provider_id` / `model` /
   `profile_id` live in the database; the hook writes to them before the subagent is created.
2. **Profiles live in the database** (`profiles` → `generation_configs` →
   `override_gen_cfg_data.system_prompt` + per-engine effort) — hence `profiles.mjs`
   can create/edit them programmatically.
3. **Web-mode exposes an authenticated WebSocket** for engine commands.

Rules for accessing `app.db`: always use `mode=ro` (Piebald is the sole writer); **do not**
use `immutable=1` for live data (bypasses the WAL → stale reads); ~48-hour retention window;
use `LIMIT` on queries. Full schema in `docs/app-db.md`.

---

## Roadmap / open items

- **Improve the routing mesh** subagent ↔ provider ↔ model ↔ profile: today the
  route is a sequential global state; the ideal is per-launch routing without a race.
- Pitch to upstream: **official per-subagent routing API/field** (equivalent to
  Claude Code's frontmatter `model:` field), which would make the hook unnecessary.

---

## Layout

```
piebald-dynamic-subagents/
├── README.md
├── hooks/
│   ├── pretooluse-route.mjs / .cmd     # the JIT routing hook (+ guard A1/A2)
│   └── route.log                       # routing trail (runtime)
├── control-plane/
│   ├── catalog.json                    # providers/models/profiles (live)
│   ├── discover-models.mjs             # regenerates the catalog
│   ├── profiles.mjs                    # Profile CRUD via API
│   ├── probe.mjs                       # validates a real worker
│   ├── pbroute-baseline.json           # changes-guard baseline
│   ├── orchestrate.mjs                 # launch orchestration
│   └── ws-client.mjs / ws-cli.mjs      # WebSocket client (readResult v3)
├── docs/
│   ├── native-hook-e2e.md              # end-to-end proof (5 providers)
│   ├── smoke-results.md                # 37 models probed
│   ├── pbroute-directive.txt           # directive text (system prompt)
│   ├── global-deploy.md                # host-level hook wiring
│   ├── app-db.md                       # app.db schema (foundation)
│   └── websocket-protocol.md           # web-mode WS protocol (foundation)
└── examples/
    ├── queries.sql                     # reference SQL queries
    └── python-client.py                # app.db reader + WebSocket client
```
