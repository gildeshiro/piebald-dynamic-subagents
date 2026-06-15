-- queries.sql — Reference queries for Piebald app.db
-- File: C:/Users/<you>/AppData/Roaming/Piebald/app.db
--
-- ALWAYS open as: file:<path>?mode=ro
-- NEVER use immutable=1 for live data (quota, recent requests)
-- immutable=1 is OK for settings/providers (static config tables)
--
-- Run via sqlite3:
--   sqlite3 "file:C:/Users/<you>/AppData/Roaming/Piebald/app.db?mode=ro" < queries.sql
-- Or in Python:
--   conn = sqlite3.connect("file:C:/Users/<you>/AppData/Roaming/Piebald/app.db?mode=ro", uri=True)


-- ═══════════════════════════════════════════════════════════════════════════
-- QUOTA / RATE-LIMIT — Claude (Anthropic)
-- ═══════════════════════════════════════════════════════════════════════════

-- Latest value of each Claude quota header
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

-- Only the 5h-utilization (most common — float 0..1)
SELECT hh.value AS utilization_5h, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = 'anthropic-ratelimit-unified-5h-utilization'
ORDER BY r.created_at DESC
LIMIT 1;

-- Full Claude dashboard: 5h + 7d + sonnet in one query
SELECT
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-5h-utilization'    THEN hh.value END) AS util_5h,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-5h-status'         THEN hh.value END) AS status_5h,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-5h-reset'          THEN hh.value END) AS reset_5h_epoch,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-7d-utilization'    THEN hh.value END) AS util_7d,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-7d-status'         THEN hh.value END) AS status_7d,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-7d-reset'          THEN hh.value END) AS reset_7d_epoch,
  MAX(CASE WHEN lower(hh.name) = 'anthropic-ratelimit-unified-7d_sonnet-utilization' THEN hh.value END) AS util_sonnet,
  r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) LIKE 'anthropic-ratelimit%'
  AND r.id = (
    SELECT r2.id FROM http_requests r2
    JOIN http_headers hh2 ON hh2.http_request_id = r2.id
    WHERE hh2.is_request = 0
      AND lower(hh2.name) LIKE 'anthropic-ratelimit%'
    ORDER BY r2.created_at DESC LIMIT 1
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- QUOTA / RATE-LIMIT — Codex (OpenAI)
-- ═══════════════════════════════════════════════════════════════════════════

-- Latest value of each Codex quota header
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

-- Full Codex dashboard in one query
SELECT
  MAX(CASE WHEN lower(hh.name) = 'x-codex-primary-reset-at'                      THEN hh.value END) AS primary_reset_at_epoch,
  MAX(CASE WHEN lower(hh.name) = 'x-codex-primary-reset-after-seconds'            THEN hh.value END) AS primary_reset_secs,
  MAX(CASE WHEN lower(hh.name) = 'x-codex-secondary-reset-after-seconds'          THEN hh.value END) AS secondary_reset_secs,
  MAX(CASE WHEN lower(hh.name) = 'x-codex-active-limit'                           THEN hh.value END) AS active_limit,
  MAX(CASE WHEN lower(hh.name) = 'x-codex-credits-unlimited'                      THEN hh.value END) AS credits_unlimited,
  MAX(CASE WHEN lower(hh.name) = 'x-codex-primary-over-secondary-limit-percent'   THEN hh.value END) AS pct_of_secondary,
  r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) LIKE 'x-codex-%'
  AND r.id = (
    SELECT r2.id FROM http_requests r2
    JOIN http_headers hh2 ON hh2.http_request_id = r2.id
    WHERE hh2.is_request = 0
      AND lower(hh2.name) LIKE 'x-codex-%'
    ORDER BY r2.created_at DESC LIMIT 1
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- DISCOVERY — Which rate-limit headers exist (any provider)
-- ═══════════════════════════════════════════════════════════════════════════

-- All unique response header names in the last 48h
SELECT DISTINCT lower(hh.name) AS header_name, COUNT(*) AS occurrences
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND r.created_at > datetime('now', '-48 hours')
GROUP BY lower(hh.name)
ORDER BY occurrences DESC
LIMIT 50;

-- Headers that look like rate-limit (any provider, auto-discovery)
SELECT DISTINCT lower(hh.name) AS header_name
FROM http_headers hh
WHERE hh.is_request = 0
  AND (
    lower(hh.name) LIKE '%ratelimit%'
    OR lower(hh.name) LIKE '%rate-limit%'
    OR lower(hh.name) LIKE '%quota%'
    OR lower(hh.name) LIKE '%retry-after%'
    OR lower(hh.name) LIKE '%x-ratelimit%'
    OR lower(hh.name) LIKE '%x-codex-%'
  )
ORDER BY 1;

-- Gemini/Google headers (discovery — may not have rate-limit but worth checking)
SELECT DISTINCT lower(hh.name) AS header_name, COUNT(*) AS n
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(r.url) LIKE '%googleapis.com%'
GROUP BY lower(hh.name)
ORDER BY n DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- HTTP TRAFFIC — General analysis
-- ═══════════════════════════════════════════════════════════════════════════

-- Distribution by request_type (last 24h)
SELECT request_type, COUNT(*) AS total
FROM http_requests
WHERE created_at > datetime('now', '-24 hours')
GROUP BY request_type
ORDER BY total DESC;

-- Distribution by provider via URL pattern
SELECT
  CASE
    WHEN url LIKE '%anthropic.com%'                        THEN 'claude'
    WHEN url LIKE '%openai.com%'                           THEN 'codex'
    WHEN url LIKE '%daily-cloudcode-pa%'                   THEN 'agy'
    WHEN url LIKE '%googleapis.com%'                       THEN 'gemini'
    ELSE 'other'
  END AS provider,
  request_type,
  COUNT(*) AS total,
  AVG(resp.response_time_ms) AS avg_ms,
  COUNT(CASE WHEN resp.status_code >= 400 THEN 1 END) AS errors
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.created_at > datetime('now', '-24 hours')
GROUP BY provider, request_type
ORDER BY total DESC;

-- Recent calls with errors (status >= 400)
SELECT r.id, r.request_type, r.url, resp.status_code, resp.response_time_ms, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE resp.status_code >= 400
  AND r.created_at > datetime('now', '-24 hours')
ORDER BY r.created_at DESC
LIMIT 20;

-- Average latency by provider (last 6h)
SELECT
  CASE
    WHEN url LIKE '%anthropic.com%'        THEN 'claude'
    WHEN url LIKE '%openai.com%'           THEN 'codex'
    WHEN url LIKE '%googleapis.com%'       THEN 'google'
    ELSE 'other'
  END AS provider,
  COUNT(*) AS calls,
  ROUND(AVG(resp.response_time_ms)) AS avg_ms,
  ROUND(MIN(resp.response_time_ms)) AS min_ms,
  ROUND(MAX(resp.response_time_ms)) AS max_ms
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'chat_message'
  AND r.created_at > datetime('now', '-6 hours')
GROUP BY provider;

-- MCP request volume by server (URL)
SELECT r.url, COUNT(*) AS calls, AVG(resp.response_time_ms) AS avg_ms
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'mcp_server_request'
  AND r.created_at > datetime('now', '-24 hours')
GROUP BY r.url
ORDER BY calls DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIG — Static read (can use immutable=1 here)
-- Open with: file:<path>?mode=ro&immutable=1
-- ═══════════════════════════════════════════════════════════════════════════

-- Relevant settings
SELECT key, value FROM settings
WHERE key IN (
  'subagent_model',
  'subagent_provider_id',
  'subagent_use_custom_config',
  'api_server_port',
  'default_permission_mode'
);

-- Configured providers
SELECT id, name, provider_type FROM providers ORDER BY id;

-- Custom models
SELECT * FROM provider_custom_models;


-- ═══════════════════════════════════════════════════════════════════════════
-- CHATS / MESSAGES — For wake injection
-- ═══════════════════════════════════════════════════════════════════════════

-- Most recent active chat (not deleted, not a subagent)
SELECT id, title, last_activity_at
FROM chats
WHERE is_deleted = 0
  AND subagent_parent_chat_id IS NULL
ORDER BY last_activity_at DESC
LIMIT 5;

-- Last message_id in a specific chat (for parent_message_id)
-- Replace <CHAT_ID> with the real ID
SELECT MAX(id) AS last_message_id
FROM messages
WHERE parent_chat_id = 21; -- <CHAT_ID>

-- Summary: chat_id + last_message_id + title (to choose a wake target)
SELECT
  c.id AS chat_id,
  c.title,
  c.last_activity_at,
  (SELECT MAX(m.id) FROM messages m WHERE m.parent_chat_id = c.id) AS last_message_id
FROM chats c
WHERE c.is_deleted = 0
  AND c.subagent_parent_chat_id IS NULL
ORDER BY c.last_activity_at DESC
LIMIT 10;


-- ═══════════════════════════════════════════════════════════════════════════
-- DIAGNOSTICS — Database health
-- ═══════════════════════════════════════════════════════════════════════════

-- Number of requests per day in the last 7 days
SELECT
  date(created_at) AS day,
  COUNT(*) AS total_requests,
  COUNT(CASE WHEN request_type = 'chat_message' THEN 1 END) AS chat_messages
FROM http_requests
WHERE created_at > datetime('now', '-7 days')
GROUP BY date(created_at)
ORDER BY day DESC;

-- Effective retention window (oldest timestamp in the database)
SELECT MIN(created_at) AS oldest_record, MAX(created_at) AS newest_record
FROM http_requests;

-- Largest tables (row counts)
SELECT 'http_requests'       AS tbl, COUNT(*) AS rows FROM http_requests
UNION ALL
SELECT 'http_responses',              COUNT(*) FROM http_responses
UNION ALL
SELECT 'http_headers',                COUNT(*) FROM http_headers
UNION ALL
SELECT 'http_streamed_chunks',        COUNT(*) FROM http_streamed_chunks
UNION ALL
SELECT 'messages',                    COUNT(*) FROM messages
UNION ALL
SELECT 'chats',                       COUNT(*) FROM chats;
