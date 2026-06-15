# app.db — Full Schema

**File:** `C:/Users/<you>/AppData/Roaming/Piebald/app.db`
**Observed size:** ~3.68 GB (2026-06-02)
**Format:** SQLite with WAL (Write-Ahead Logging)
**Retention window:** ~48 hours (automatic rotation)
**Access:** read-only via `file:<path>?mode=ro`

---

## Core tables — HTTP Traffic

### `http_requests`

Every HTTP call Piebald makes is recorded here.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Unique request ID |
| `request_type` | TEXT | Semantic type (see `http-traffic-types.md`) |
| `method` | TEXT | HTTP method (GET, POST…) |
| `url` | TEXT | Full URL of the call |
| `request_body` | TEXT/BLOB | Request body (can be large — `chat_message` especially) |
| `num_headers` | INTEGER | Header count |
| `created_at` | TEXT | ISO-8601 UTC timestamp |

**Volume:** `chat_message` bodies dominate (~810 MB) because Piebald resends the
full conversation history on every turn.

---

### `http_responses`

1:1 relationship with `http_requests` (same `http_request_id` = PK).

| Column | Type | Description |
|---|---|---|
| `http_request_id` | INTEGER PK/FK | Links to `http_requests.id` |
| `status_code` | INTEGER | HTTP status (200, 400, 404…) |
| `response_body` | TEXT/BLOB | Response body |
| `response_time_ms` | INTEGER | Latency in ms |
| `created_at` | TEXT | ISO-8601 UTC timestamp |

---

### `http_headers`

Headers for both requests and responses, indexed by position.
**This table is the quota source.** (see `rate-limit-headers.md`)

| Column | Type | Description |
|---|---|---|
| `http_request_id` | INTEGER FK | Links to `http_requests.id` |
| `header_index` | INTEGER | Header position (0-based) |
| `name` | TEXT | Header name (lowercase) |
| `value` | TEXT | Header value |
| `is_request` | INTEGER | **1 = request header, 0 = response header** |

**Composite key:** `(http_request_id, header_index, is_request)`

**Pattern for reading quota (latest value of a header):**
```sql
SELECT hh.value, r.created_at
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = 'anthropic-ratelimit-unified-5h-utilization'
ORDER BY r.created_at DESC
LIMIT 1;
```

> ⚠️ Open as `file:<path>?mode=ro` — **do NOT add `immutable=1`**.
> Piebald is an active WAL writer; `immutable=1` bypasses the WAL and returns stale data.

---

### `http_streamed_chunks`

SSE (Server-Sent Events) chunks from streaming responses.
Each chunk = one line of the SSE stream.

| Column | Type | Description |
|---|---|---|
| `http_request_id` | INTEGER FK | Links to `http_requests.id` |
| `chunk_index` | INTEGER | Position in the stream |
| `chunk_data` | TEXT | Chunk content (e.g. `data: {...}`) |
| `created_at` | TEXT | ISO-8601 UTC timestamp |

---

## Typed tables (detail tables)

For each specialized `request_type`, an auxiliary table adds type-specific metadata.

### `http_request_chat_message_data`

| Column | Type | Description |
|---|---|---|
| `http_request_id` | INTEGER FK | Links to `http_requests.id` |
| `message_id` | INTEGER FK | Links to `messages.id` (main messages table) |

Used to correlate an HTTP request with the chat message that triggered it.

### Other typed tables (analogous structure)

| Table | For request_type |
|---|---|
| `http_request_oauth_data` | `oauth` |
| `http_request_mcp_server_request_data` | `mcp_server_request` |
| `http_request_web_fetch_data` | `web_fetch` |
| `http_request_web_search_data` | `web_search` |
| `http_request_model_listing_data` | `model_listing` |
| `http_request_title_generation_data` | `title_generation` |

### `mcp_traffic_logs`

Traffic log specific to MCP (Model Context Protocol) calls.
Separate from `http_requests` — records the MCP protocol layer over HTTP.

---

## Configuration tables

These tables are **static** (they change only when the user modifies settings in the TUI).
For them, `immutable=1` *is* safe and improves concurrent read performance.

### `settings`

Key-value store for Piebald configuration.

```sql
-- Example keys relevant to subagents/providers:
SELECT key, value FROM settings
WHERE key IN (
  'subagent_model',           -- e.g. "gemini-3-flash-preview"
  'subagent_provider_id',     -- e.g. "1"
  'subagent_use_custom_config',
  'api_server_port',          -- empty if disabled
  'default_permission_mode'   -- e.g. "yolo"
);
```

**win-work (confirmed 2026-05-31):**

| key | value |
|---|---|
| `subagent_model` | `gemini-3-flash-preview` |
| `subagent_provider_id` | `1` |
| `subagent_use_custom_config` | `1` |
| `default_permission_mode` | `yolo` |
| `api_server_port` | `""` (disabled) |

### `providers`

Providers configured in the TUI.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Provider ID |
| `name` | TEXT | Display name |
| `provider_type` | TEXT | Internal type (gemini, agy, claude, codex…) |
| … | … | Other config fields |

**win-work (confirmed):**

| id | name | provider_type |
|---|---|---|
| 1 | google/gemini-cli | gemini |
| 2 | antigravity | agy |
| 3 | claude_code | claude |
| 4 | openai_responses | codex |

### `provider_custom_models`

Custom models added via the TUI.
Useful for detecting Antigravity (agy) endpoints that are configured.

---

## Chat/message tables

> ⚠️ Contain sensitive data (conversation history). Access only when
> necessary — e.g. resolving `chat_id` and `parent_message_id` for wake injection.

### `chats`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Chat ID |
| `is_deleted` | INTEGER | 1 = deleted |
| `subagent_parent_chat_id` | INTEGER | NULL = top-level chat; ≠NULL = subagent chat |
| `last_activity_at` | TEXT | Last activity timestamp |
| `title` | TEXT | Chat title |
| … | … | Other fields |

**Query — most recent active chat (for wake injection):**
```sql
SELECT id FROM chats
WHERE is_deleted = 0
  AND subagent_parent_chat_id IS NULL
ORDER BY last_activity_at DESC
LIMIT 1;
```

### `messages`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Message ID |
| `parent_chat_id` | INTEGER FK | Links to `chats.id` (**NOT `chat_id`** — exact name) |
| `role` | TEXT | `user` \| `assistant` \| `system` |
| … | … | Other fields |

**Query — last message_id in a chat (for parent_message_id in wake injection):**
```sql
SELECT MAX(id) FROM messages
WHERE parent_chat_id = <chat_id>;
-- NULL = chat with no messages (omit the field from the request)
```

---

## Size and performance notes

| Table | Approximate size | Notes |
|---|---|---|
| `http_requests` (request_body) | ~810 MB | chat_message bodies (full history resent on every turn) |
| `http_streamed_chunks` | variable | SSE chunks from long responses |
| `http_headers` | moderate | thousands of headers per session |
| `settings`, `providers` | negligible | a few hundred rows |

**Tip for queries on `http_headers`:** always filter with `lower(hh.name) = '...'`
(header names are case-insensitive by HTTP convention) and use `LIMIT` to avoid
full-scans on the large table.
