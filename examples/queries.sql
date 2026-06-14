-- queries.sql — Referência de queries para Piebald app.db
-- Arquivo: C:/Users/<you>/AppData/Roaming/Piebald/app.db
--
-- SEMPRE abrir como: file:<path>?mode=ro
-- NUNCA usar immutable=1 para dados ao vivo (quota, requests recentes)
-- immutable=1 é OK para settings/providers (tabelas estáticas de config)
--
-- Executar via sqlite3:
--   sqlite3 "file:C:/Users/<you>/AppData/Roaming/Piebald/app.db?mode=ro" < queries.sql
-- Ou em Python:
--   conn = sqlite3.connect("file:C:/Users/<you>/AppData/Roaming/Piebald/app.db?mode=ro", uri=True)


-- ═══════════════════════════════════════════════════════════════════════════
-- QUOTA / RATE-LIMIT — Claude (Anthropic)
-- ═══════════════════════════════════════════════════════════════════════════

-- Último valor de cada header Claude de quota
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

-- Só o 5h-utilization (mais comum — float 0..1)
SELECT hh.value AS utilization_5h, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = 'anthropic-ratelimit-unified-5h-utilization'
ORDER BY r.created_at DESC
LIMIT 1;

-- Painel completo Claude: 5h + 7d + sonnet em uma query
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

-- Último valor de cada header Codex de quota
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

-- Painel completo Codex em uma query
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
-- DISCOVERY — Que headers de rate-limit existem (qualquer provider)
-- ═══════════════════════════════════════════════════════════════════════════

-- Todos os nomes de header de response únicos nas últimas 48h
SELECT DISTINCT lower(hh.name) AS header_name, COUNT(*) AS occurrences
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND r.created_at > datetime('now', '-48 hours')
GROUP BY lower(hh.name)
ORDER BY occurrences DESC
LIMIT 50;

-- Headers que parecem ser rate-limit (qualquer provider, auto-discovery)
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

-- Headers Gemini/Google (descoberta — pode não ter rate-limit mas vale verificar)
SELECT DISTINCT lower(hh.name) AS header_name, COUNT(*) AS n
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(r.url) LIKE '%googleapis.com%'
GROUP BY lower(hh.name)
ORDER BY n DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- HTTP TRAFFIC — Análise geral
-- ═══════════════════════════════════════════════════════════════════════════

-- Distribuição por request_type (últimas 24h)
SELECT request_type, COUNT(*) AS total
FROM http_requests
WHERE created_at > datetime('now', '-24 hours')
GROUP BY request_type
ORDER BY total DESC;

-- Distribuição por provider via URL pattern
SELECT
  CASE
    WHEN url LIKE '%anthropic.com%'                        THEN 'claude'
    WHEN url LIKE '%openai.com%'                           THEN 'codex'
    WHEN url LIKE '%daily-cloudcode-pa%'                   THEN 'agy'
    WHEN url LIKE '%googleapis.com%'                       THEN 'gemini'
    ELSE 'outros'
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

-- Chamadas recentes com erros (status >= 400)
SELECT r.id, r.request_type, r.url, resp.status_code, resp.response_time_ms, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE resp.status_code >= 400
  AND r.created_at > datetime('now', '-24 hours')
ORDER BY r.created_at DESC
LIMIT 20;

-- Latência média por provider (últimas 6h)
SELECT
  CASE
    WHEN url LIKE '%anthropic.com%'        THEN 'claude'
    WHEN url LIKE '%openai.com%'           THEN 'codex'
    WHEN url LIKE '%googleapis.com%'       THEN 'google'
    ELSE 'outros'
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

-- Volume de MCP requests por server (URL)
SELECT r.url, COUNT(*) AS calls, AVG(resp.response_time_ms) AS avg_ms
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'mcp_server_request'
  AND r.created_at > datetime('now', '-24 hours')
GROUP BY r.url
ORDER BY calls DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- CONFIG — Leitura estática (pode usar immutable=1 aqui)
-- Abrir com: file:<path>?mode=ro&immutable=1
-- ═══════════════════════════════════════════════════════════════════════════

-- Settings relevantes
SELECT key, value FROM settings
WHERE key IN (
  'subagent_model',
  'subagent_provider_id',
  'subagent_use_custom_config',
  'api_server_port',
  'default_permission_mode'
);

-- Providers configurados
SELECT id, name, provider_type FROM providers ORDER BY id;

-- Modelos customizados
SELECT * FROM provider_custom_models;


-- ═══════════════════════════════════════════════════════════════════════════
-- CHATS / MENSAGENS — Para wake injection
-- ═══════════════════════════════════════════════════════════════════════════

-- Chat ativo mais recente (não deletado, não subagente)
SELECT id, title, last_activity_at
FROM chats
WHERE is_deleted = 0
  AND subagent_parent_chat_id IS NULL
ORDER BY last_activity_at DESC
LIMIT 5;

-- Último message_id de um chat específico (para parent_message_id)
-- Substituir <CHAT_ID> pelo ID real
SELECT MAX(id) AS last_message_id
FROM messages
WHERE parent_chat_id = 21; -- <CHAT_ID>

-- Resumo: chat_id + last_message_id + título (para escolher alvo de wake)
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
-- DIAGNÓSTICO — Saúde do banco
-- ═══════════════════════════════════════════════════════════════════════════

-- Número de requests por dia nos últimos 7 dias
SELECT
  date(created_at) AS day,
  COUNT(*) AS total_requests,
  COUNT(CASE WHEN request_type = 'chat_message' THEN 1 END) AS chat_messages
FROM http_requests
WHERE created_at > datetime('now', '-7 days')
GROUP BY date(created_at)
ORDER BY day DESC;

-- Janela efetiva de retenção (timestamp mais antigo no banco)
SELECT MIN(created_at) AS oldest_record, MAX(created_at) AS newest_record
FROM http_requests;

-- Tabelas maiores (contagem de rows)
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
