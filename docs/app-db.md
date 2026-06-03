# app.db — Schema Completo

**Arquivo:** `%USERPROFILE%/AppData/Roaming/Piebald/app.db`
**Tamanho observado:** ~3.68 GB (2026-06-02)
**Formato:** SQLite com WAL (Write-Ahead Logging)
**Janela de retenção:** ~48 horas (rotação automática)
**Acesso:** read-only via `file:<path>?mode=ro`

---

## Tabelas principais — HTTP Traffic

### `http_requests`

Cada chamada HTTP que o Piebald faz sai/entra registrada aqui.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | ID único da request |
| `request_type` | TEXT | Tipo semântico (ver `http-traffic-types.md`) |
| `method` | TEXT | HTTP method (GET, POST...) |
| `url` | TEXT | URL completa da chamada |
| `request_body` | TEXT/BLOB | Body da request (pode ser grande — chat_message especialmente) |
| `num_headers` | INTEGER | Contagem de headers |
| `created_at` | TEXT | Timestamp ISO-8601 UTC |

**Volume:** `chat_message` bodies dominam (~810 MB) porque o Piebald reenvia o
histórico completo da conversa a cada turno.

---

### `http_responses`

Relação 1:1 com `http_requests` (mesmo `http_request_id` = PK).

| Coluna | Tipo | Descrição |
|---|---|---|
| `http_request_id` | INTEGER PK/FK | Liga a `http_requests.id` |
| `status_code` | INTEGER | HTTP status (200, 400, 404...) |
| `response_body` | TEXT/BLOB | Body da resposta |
| `response_time_ms` | INTEGER | Latência em ms |
| `created_at` | TEXT | Timestamp ISO-8601 UTC |

---

### `http_headers`

Headers tanto da request quanto da response, indexados por posição.
**Esta tabela é a fonte de quota.** (ver `rate-limit-headers.md`)

| Coluna | Tipo | Descrição |
|---|---|---|
| `http_request_id` | INTEGER FK | Liga a `http_requests.id` |
| `header_index` | INTEGER | Posição do header (0-based) |
| `name` | TEXT | Nome do header (lowercase) |
| `value` | TEXT | Valor do header |
| `is_request` | INTEGER | **1 = header de request, 0 = header de response** |

**Chave composta:** `(http_request_id, header_index, is_request)`

**Pattern de leitura para quota (último valor de um header):**
```sql
SELECT hh.value, r.created_at
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = 'anthropic-ratelimit-unified-5h-utilization'
ORDER BY r.created_at DESC
LIMIT 1;
```

> ⚠️ Abrir como `file:<path>?mode=ro` — **NÃO adicionar `immutable=1`**.
> O Piebald é um WAL writer ativo; `immutable=1` ignora o WAL e devolve stale.

---

### `http_streamed_chunks`

SSE (Server-Sent Events) chunks de respostas streaming.
Cada chunk = uma linha do stream SSE.

| Coluna | Tipo | Descrição |
|---|---|---|
| `http_request_id` | INTEGER FK | Liga a `http_requests.id` |
| `chunk_index` | INTEGER | Posição no stream |
| `chunk_data` | TEXT | Conteúdo do chunk (ex: `data: {...}`) |
| `created_at` | TEXT | Timestamp ISO-8601 UTC |

---

## Tabelas tipadas (detail tables)

Para cada `request_type` especializado, existe uma tabela auxiliar que adiciona
metadados específicos.

### `http_request_chat_message_data`

| Coluna | Tipo | Descrição |
|---|---|---|
| `http_request_id` | INTEGER FK | Liga a `http_requests.id` |
| `message_id` | INTEGER FK | Liga a `messages.id` (tabela principal de mensagens) |

Usado para correlacionar um request HTTP com a mensagem do chat que o originou.

### Outras tabelas tipadas (estrutura análoga)

| Tabela | Para request_type |
|---|---|
| `http_request_oauth_data` | `oauth` |
| `http_request_mcp_server_request_data` | `mcp_server_request` |
| `http_request_web_fetch_data` | `web_fetch` |
| `http_request_web_search_data` | `web_search` |
| `http_request_model_listing_data` | `model_listing` |
| `http_request_title_generation_data` | `title_generation` |

### `mcp_traffic_logs`

Log de tráfego específico para chamadas MCP (Model Context Protocol).
Separado de `http_requests` — registra a camada de protocol MCP sobre HTTP.

---

## Tabelas de configuração

Estas tabelas são **estáticas** (mudam apenas quando o usuário altera settings na TUI).
Para elas, `immutable=1` *é* seguro e melhora performance de leitura concorrente.

### `settings`

Key-value store de configurações do Piebald.

```sql
-- Exemplo de keys relevantes para subagents/providers:
SELECT key, value FROM settings
WHERE key IN (
  'subagent_model',           -- ex: "gemini-3-flash-preview"
  'subagent_provider_id',     -- ex: "1"
  'subagent_use_custom_config',
  'api_server_port',          -- vazio se desabilitado
  'default_permission_mode'   -- ex: "yolo"
);
```

**win-work (2026-05-31 confirmado):**

| key | value |
|---|---|
| `subagent_model` | `gemini-3-flash-preview` |
| `subagent_provider_id` | `1` |
| `subagent_use_custom_config` | `1` |
| `default_permission_mode` | `yolo` |
| `api_server_port` | `""` (desabilitado) |

### `providers`

Providers configurados na TUI.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | ID do provider |
| `name` | TEXT | Nome exibido |
| `provider_type` | TEXT | Tipo interno (gemini, agy, claude, codex...) |
| ... | ... | Outros campos de config |

**win-work (confirmado):**

| id | name | provider_type |
|---|---|---|
| 1 | google/gemini-cli | gemini |
| 2 | antigravity | agy |
| 3 | claude_code | claude |
| 4 | openai_responses | codex |

### `provider_custom_models`

Modelos customizados adicionados via TUI.
Útil para detectar endpoints Antigravity (agy) configurados.

---

## Tabelas de chat/mensagens

> ⚠️ Contêm dados sensíveis (histórico de conversas). Acessar apenas quando
> necessário — ex: resolver `chat_id` e `parent_message_id` para wake injection.

### `chats`

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | ID do chat |
| `is_deleted` | INTEGER | 1 = deletado |
| `subagent_parent_chat_id` | INTEGER | NULL = chat top-level; ≠NULL = chat de subagente |
| `last_activity_at` | TEXT | Timestamp da última atividade |
| `title` | TEXT | Título do chat |
| ... | ... | Outros campos |

**Query — chat ativo mais recente (para wake injection):**
```sql
SELECT id FROM chats
WHERE is_deleted = 0
  AND subagent_parent_chat_id IS NULL
ORDER BY last_activity_at DESC
LIMIT 1;
```

### `messages`

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | ID da mensagem |
| `parent_chat_id` | INTEGER FK | Liga a `chats.id` (**NÃO `chat_id`** — nome exato) |
| `role` | TEXT | `user` \| `assistant` \| `system` |
| ... | ... | Outros campos |

**Query — último message_id de um chat (para parent_message_id em wake injection):**
```sql
SELECT MAX(id) FROM messages
WHERE parent_chat_id = <chat_id>;
-- NULL = chat sem mensagens (omitir o campo na request)
```

---

## Notas de tamanho e performance

| Tabela | Peso aproximado | Observação |
|---|---|---|
| `http_requests` (request_body) | ~810 MB | chat_message bodies (histórico reenviado inteiro a cada turno) |
| `http_streamed_chunks` | variável | SSE chunks de respostas longas |
| `http_headers` | moderado | milhares de headers por sessão |
| `settings`, `providers` | negligível | poucas centenas de linhas |

**Dica para queries em `http_headers`:** sempre filtrar por `lower(hh.name) = '...'`
(os nomes são case-insensitive por convenção HTTP) e usar `LIMIT` para evitar
full-scans na tabela grande.
