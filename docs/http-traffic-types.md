# HTTP Traffic Types — request_type values

O campo `request_type` em `http_requests` classifica semanticamente cada
chamada HTTP que o Piebald realiza. Este documento descreve cada tipo,
o que dispara, para onde vai, e o que observar.

---

## Tabela completa

| request_type | Quem dispara | Destino típico | Relevância |
|---|---|---|---|
| `chat_message` | Turno de chat (user → model) | Provider API (Claude, Codex, Gemini...) | ⭐⭐⭐ Alta — principal source de quota headers |
| `mcp_server_request` | Ferramenta MCP sendo chamada | MCP server local ou remoto | ⭐⭐ Média — diagnosticar MCP latência |
| `web_fetch` | Tool `WebFetch` no chat | URL externa | ⭐ Baixa — auditoria de fetch |
| `web_search` | Tool `WebSearch` | Motor de busca | ⭐ Baixa |
| `model_listing` | Piebald listando modelos disponíveis | Provider API | ⭐ Baixa — detectar quando Piebald refaz discovery |
| `title_generation` | Geração automática de título do chat | Provider API (geralmente modelo rápido) | ⭐ Baixa |
| `context_compaction` | Compactação de contexto longo | Provider API | ⭐⭐ Média — consome quota; útil identificar |
| `claude_code_other` | Chamadas Claude Code internas | Anthropic API | ⭐⭐ Média — contribui para quota Claude |
| `embedding` | Geração de embedding (busca semântica) | Embedding endpoint | ⭐ Baixa |
| `oauth` | Flow OAuth (autenticação provider) | OAuth endpoint do provider | ⭐ Baixa — só no auth/refresh |
| `system_service` | Serviço interno do Piebald | Varia | ⭐ Baixa |
| `http_api_server` | API server local do Piebald (se habilitado) | localhost | ⭐ Baixa — raro (api_server_port desabilitado por padrão) |

---

## Detalhes por tipo

### `chat_message` — O mais importante

Toda mensagem enviada no chat gera um registro `chat_message`. A request body
contém o **histórico completo** da conversa (não apenas a última mensagem) —
isso é por design do Piebald e explica por que `http_requests.request_body`
domina o tamanho do banco (~810 MB).

**O que a response traz:**
- Body: stream SSE com a resposta do modelo (chunks em `http_streamed_chunks`)
- Headers de response (`is_request=0` em `http_headers`):
  - Para Claude: `anthropic-ratelimit-unified-*` (quota)
  - Para Codex: `x-codex-*` (quota)
  - Para outros providers: depende do provider

**Tabela auxiliar:** `http_request_chat_message_data`
```sql
-- Achar o http_request_id correspondente a uma messages.id específica
SELECT http_request_id
FROM http_request_chat_message_data
WHERE message_id = <messages.id>;
```

**Query: listar chamadas de chat recentes com provider e status**
```sql
SELECT r.id, r.url, resp.status_code, resp.response_time_ms, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'chat_message'
ORDER BY r.created_at DESC
LIMIT 20;
```

---

### `mcp_server_request` — Ferramentas MCP

Cada vez que o modelo chama uma ferramenta MCP (ex: `chrome-devtools`, `github`,
`whatsapp`), o Piebald registra um `mcp_server_request`.

**Tabela auxiliar:** `http_request_mcp_server_request_data`
(provavelmente contém tool name + server name)

**Também existe:** `mcp_traffic_logs` — tabela separada com log de tráfego MCP
de baixo nível (mensagens JSON-RPC de ida e volta).

**Útil para:**
- Diagnosticar latência de MCP servers
- Identificar quais ferramentas consomem mais tempo
- Detectar falhas de MCP (status_code ≠ 200)

```sql
-- MCP requests mais lentos
SELECT r.url, resp.response_time_ms, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'mcp_server_request'
ORDER BY resp.response_time_ms DESC
LIMIT 10;
```

---

### `context_compaction` — Compactação de contexto

Quando o contexto da conversa fica muito longo, o Piebald dispara uma chamada
de compactação automática (resume/summarize).

**Relevância:** consome quota Claude/Codex e pode afetar o estado do chat de
forma inesperada. Útil identificar quando isso ocorreu.

```sql
-- Detectar compactações nas últimas 24h
SELECT r.id, r.url, resp.status_code, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'context_compaction'
  AND r.created_at > datetime('now', '-24 hours')
ORDER BY r.created_at DESC;
```

---

### `web_fetch` e `web_search`

Gerados pelas tools `WebFetch` e `WebSearch` respectivamente.

```sql
-- URLs buscadas hoje
SELECT r.url, resp.status_code, r.created_at
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type IN ('web_fetch', 'web_search')
  AND r.created_at > datetime('now', '-24 hours')
ORDER BY r.created_at DESC;
```

---

### `model_listing` — Discovery de modelos

Piebald periodicamente lista os modelos disponíveis em cada provider configurado.
Útil para detectar quando um provider foi re-autenticado ou teve modelos alterados.

---

### `claude_code_other`

Chamadas feitas pelo runtime do Claude Code para a Anthropic API que não são
chat turns (ex: algumas operações internas, subagent spawns). Contribuem para
a quota `anthropic-ratelimit-unified-*` da mesma forma que `chat_message`.

---

## Como identificar o provider de uma request

O campo `url` em `http_requests` revela o provider:

| Pattern na URL | Provider |
|---|---|
| `api.anthropic.com` | Claude (Anthropic) |
| `api.openai.com` | Codex/GPT (OpenAI) |
| `generativelanguage.googleapis.com` | Gemini (Google) |
| `daily-cloudcode-pa.sandbox.googleapis.com` | Antigravity/agy (Google internal) |
| `api.deepseek.com` | DeepSeek (mas DeepSeek via cmdc NÃO passa pelo Piebald) |

```sql
-- Distribuição de chamadas por provider (últimas 48h)
SELECT
  CASE
    WHEN url LIKE '%anthropic.com%'      THEN 'claude'
    WHEN url LIKE '%openai.com%'         THEN 'codex'
    WHEN url LIKE '%googleapis.com%'     THEN 'gemini/agy'
    ELSE 'outros'
  END AS provider,
  COUNT(*) AS total,
  COUNT(CASE WHEN resp.status_code = 200 THEN 1 END) AS ok,
  COUNT(CASE WHEN resp.status_code >= 400 THEN 1 END) AS errors
FROM http_requests r
JOIN http_responses resp ON resp.http_request_id = r.id
WHERE r.request_type = 'chat_message'
GROUP BY provider
ORDER BY total DESC;
```

---

## Notas importantes

- **DeepSeek via cmdc NÃO aparece aqui.** O cmdc roda como proxy local (`:8089`)
  e não é proxiado pelo Piebald. Para quota DeepSeek: usar a API direta.
- **Gemini-cli vs agy:** ambos podem aparecer com URLs `googleapis.com`, mas
  endpoints distintos. agy usa `daily-cloudcode-pa.sandbox.googleapis.com`.
- **Subagente Piebald (gemini-3-flash-preview):** quando o modelo interno do
  Piebald spawna um subagente, ele também gera `chat_message` requests. Estes
  aparecem nas tabelas normalmente e contribuem para quota do provider configurado
  como subagent.
