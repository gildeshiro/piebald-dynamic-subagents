# Rate-Limit Headers by Provider

Piebald is a proxy for provider APIs — every API response passes through it
before reaching the frontend. This means **provider rate-limit response headers
are stored in `http_headers`** (field `is_request=0`).

This is the simplest way to query quota: no CLI, no session logs,
no extra API calls — just a `SELECT`.

---

## Reading rule (always mode=ro, never immutable=1)

```sql
-- Universal pattern: latest value of a header by created_at
SELECT hh.value, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = '<header-name-lowercase>'
ORDER BY r.created_at DESC
LIMIT 1;
```

Open with: `file:C:/Users/<you>/AppData/Roaming/Piebald/app.db?mode=ro`

⚠️ **Do NOT add `immutable=1`** — the database is in active WAL mode.
`immutable=1` bypasses the WAL and returns stale values (from the last checkpoint, not the present).

⚠️ **"Last-seen" limitation** — values are only updated when a real request
goes through the provider. If the last Claude call was 3 hours ago, the
values reflect the state from 3 hours ago. For pre-run usage this is acceptable.

---

## CLAUDE (Anthropic)

Headers present in responses to `api.anthropic.com`.

### Quota headers (response headers, `is_request=0`)

| Header | Type | Description |
|---|---|---|
| `anthropic-ratelimit-unified-5h-utilization` | float (0.0–1.0) | % of the 5-hour window consumed |
| `anthropic-ratelimit-unified-5h-status` | string | `allowed` \| others |
| `anthropic-ratelimit-unified-5h-reset` | int (Unix epoch) | When the 5-hour window resets |
| `anthropic-ratelimit-unified-7d-utilization` | float (0.0–1.0) | % of the weekly window consumed |
| `anthropic-ratelimit-unified-7d-status` | string | `allowed` \| others |
| `anthropic-ratelimit-unified-7d-reset` | int (Unix epoch) | When the weekly window resets |
| `anthropic-ratelimit-unified-7d_sonnet-utilization` | float (0.0–1.0) | Sonnet-specific weekly % |

### Live observed values (2026-06-02 23:28 UTC)

```
anthropic-ratelimit-unified-5h-utilization        = 0.03   → 3% of 5h window
anthropic-ratelimit-unified-5h-status             = allowed
anthropic-ratelimit-unified-5h-reset              = 1780459800  → 2026-06-03 04:10 UTC
anthropic-ratelimit-unified-7d-utilization        = 0.3    → 30% weekly
anthropic-ratelimit-unified-7d-status             = allowed
anthropic-ratelimit-unified-7d-reset              = 1780570800  → 2026-06-04 11:00 UTC
anthropic-ratelimit-unified-7d_sonnet-utilization = 0.17   → 17% weekly (Sonnet-specific)
```

### Interpretation

- **5h-utilization × 100** = percentage of the 5-hour budget consumed
- **7d-utilization × 100** = percentage of the weekly budget consumed
- **5h-reset** and **7d-reset** are Unix timestamps; convert to relative time:
  ```python
  import time
  delta = int(reset_epoch) - int(time.time())
  # delta > 0: "resets in Xh Ym"
  ```
- `7d_sonnet-utilization`: Anthropic enforces per-model sub-limits; Sonnet
  has separate tracking in addition to the unified limit.

### Full SQL — all Claude headers at once

```sql
SELECT lower(hh.name) AS header, hh.value, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) LIKE 'anthropic-ratelimit%'
  AND r.id = (
    SELECT r2.id FROM http_requests r2
    JOIN http_headers hh2 ON hh2.http_request_id = r2.id
    WHERE hh2.is_request = 0
      AND lower(hh2.name) LIKE 'anthropic-ratelimit%'
    ORDER BY r2.created_at DESC
    LIMIT 1
  )
ORDER BY hh.header_index;
```

---

## CODEX (OpenAI)

Headers present in responses to `api.openai.com` via Codex.

### Quota headers (response headers, `is_request=0`)

| Header | Type | Description |
|---|---|---|
| `x-codex-primary-reset-at` | int (Unix epoch) | When the primary window (5h) resets |
| `x-codex-primary-reset-after-seconds` | int | Seconds until the 5h window resets |
| `x-codex-secondary-reset-after-seconds` | int | Seconds until the weekly window resets |
| `x-codex-active-limit` | string | Plan tier (`premium`, `free`, etc.) |
| `x-codex-credits-unlimited` | string | `True` \| `False` |
| `x-codex-primary-over-secondary-limit-percent` | int | % of 5h limit relative to weekly |

### Live observed values (2026-06-02)

```
x-codex-primary-reset-after-seconds          = 18000   → 5h window (= 5×3600)
x-codex-primary-reset-at                     = 1780460204
x-codex-secondary-reset-after-seconds        = 410167  → ~4d 17h (weekly)
x-codex-active-limit                         = premium
x-codex-credits-unlimited                    = False
x-codex-primary-over-secondary-limit-percent = 0
```

### Interpretation

- **`primary-reset-after-seconds`** = seconds remaining until the 5h window closes/resets.
  If = 18000, the window just started.
- **`secondary-reset-after-seconds`** ≈ 410k seconds = ~4.7 days remaining in
  the weekly window.
- **`primary-over-secondary-limit-percent = 0`** = the 5h window is not
  "eating into" the weekly (low usage).
- **`credits-unlimited = False`** = account has a finite credit/call limit.

### SQL — most recent Codex headers

```sql
SELECT lower(hh.name) AS header, hh.value, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) LIKE 'x-codex-%'
  AND r.id = (
    SELECT r2.id FROM http_requests r2
    JOIN http_headers hh2 ON hh2.http_request_id = r2.id
    WHERE hh2.is_request = 0
      AND lower(hh2.name) LIKE 'x-codex-%'
    ORDER BY r2.created_at DESC
    LIMIT 1
  )
ORDER BY hh.header_index;
```

---

## GEMINI / AGY (Google)

As of 2026-06-02, Gemini-cli and agy traffic **showed no observable
rate-limit headers** in `http_headers`. Possible reasons:
- Google may return rate-limit info via JSON body instead of headers
- The agy endpoint (`daily-cloudcode-pa.sandbox.googleapis.com`) may use
  a different mechanism
- Headers may exist under a different name

**Status:** `TUI-only` — check `/usage` in the agy or Gemini web interface.

**Future-proof:** if Google starts including rate-limit headers in responses
routed through Piebald, they will appear automatically in `http_headers`.
To check, use:
```sql
SELECT DISTINCT lower(hh.name)
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(r.url) LIKE '%googleapis.com%'
ORDER BY 1;
```

---

## DEEPSEEK

DeepSeek **does not go through Piebald**. It runs via `cmdc` (cmd-proxy on `:8089`)
independently. There are no DeepSeek headers in `http_headers`.

**Alternative:** query credits directly via the API:
```bash
DS_KEY=$(python3 -c "import json; d=json.load(open('$HOME/.commandcode/auth.json')); print(d.get('api_key',''))")
curl -s -H "Authorization: Bearer $DS_KEY" https://api.deepseek.com/user/balance
```

Response format:
```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "...",
      "granted_balance": "...",
      "topped_up_balance": "..."
    }
  ]
}
```

---

## Request headers (`is_request=1`) — what is interesting

In addition to response headers, request headers are also stored.
They can be useful for:

- Seeing which `anthropic-beta` feature was activated per turn
- Verifying the `content-type` of the request (application/json vs. multipart)
- Auditing authentication tokens sent (⚠️ do NOT log or expose — they contain Bearer tokens)

```sql
-- Request headers for Claude calls (do not print values if they contain auth)
SELECT hh.name
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 1
  AND lower(r.url) LIKE '%anthropic.com%'
GROUP BY hh.name
ORDER BY COUNT(*) DESC
LIMIT 20;
```

---

## Automatic extensibility

Any new provider routed through Piebald that returns rate-limit headers will appear
automatically in `http_headers`. For example:
- **OpenRouter** (when integrated): if it returns quota headers, they will be here
- **Other custom providers**: same rule

This makes `app.db` a self-extending quota source for any provider that passes through Piebald.
