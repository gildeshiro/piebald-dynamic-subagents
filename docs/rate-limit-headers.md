# Rate-Limit Headers por Provider

O Piebald é um proxy para as APIs de provider — toda response de API passa por
ele antes de chegar ao frontend. Isso significa que os **headers de rate-limit
das responses ficam armazenados em `http_headers`** (campo `is_request=0`).

Esta é a forma mais simples de consultar quota: sem CLI, sem session logs,
sem chamada de API extra — basta um `SELECT`.

---

## Regra de leitura (sempre mode=ro, nunca immutable=1)

```sql
-- Pattern universal: último valor de um header por created_at
SELECT hh.value, r.created_at AS as_of
FROM http_headers hh
JOIN http_requests r ON r.id = hh.http_request_id
WHERE hh.is_request = 0
  AND lower(hh.name) = '<header-name-lowercase>'
ORDER BY r.created_at DESC
LIMIT 1;
```

Abrir com: `file:%USERPROFILE%/AppData/Roaming/Piebald/app.db?mode=ro`

⚠️ **NÃO adicionar `immutable=1`** — o banco está em modo WAL ativo.
`immutable=1` ignora o WAL e devolve valores stale (da última checkpoint, não do presente).

⚠️ **Limitação "last-seen"** — os valores só são atualizados quando uma request
real passa pelo provider. Se a última chamada ao Claude foi há 3 horas, os
valores refletem o estado de 3 horas atrás. Para uso pré-run isso é aceitável.

---

## CLAUDE (Anthropic)

Headers presentes em responses para `api.anthropic.com`.

### Headers de quota (response headers, `is_request=0`)

| Header | Tipo | Descrição |
|---|---|---|
| `anthropic-ratelimit-unified-5h-utilization` | float (0.0–1.0) | % da janela de 5h consumida |
| `anthropic-ratelimit-unified-5h-status` | string | `allowed` \| outros |
| `anthropic-ratelimit-unified-5h-reset` | int (Unix epoch) | Quando a janela de 5h reseta |
| `anthropic-ratelimit-unified-7d-utilization` | float (0.0–1.0) | % da janela semanal consumida |
| `anthropic-ratelimit-unified-7d-status` | string | `allowed` \| outros |
| `anthropic-ratelimit-unified-7d-reset` | int (Unix epoch) | Quando a janela semanal reseta |
| `anthropic-ratelimit-unified-7d_sonnet-utilization` | float (0.0–1.0) | % semanal específica do Sonnet |

### Valores observados ao vivo (2026-06-02 23:28 UTC)

```
anthropic-ratelimit-unified-5h-utilization        = 0.03   → 3% da janela 5h
anthropic-ratelimit-unified-5h-status             = allowed
anthropic-ratelimit-unified-5h-reset              = 1780459800  → 2026-06-03 04:10 UTC
anthropic-ratelimit-unified-7d-utilization        = 0.3    → 30% semanal
anthropic-ratelimit-unified-7d-status             = allowed
anthropic-ratelimit-unified-7d-reset              = 1780570800  → 2026-06-04 11:00 UTC
anthropic-ratelimit-unified-7d_sonnet-utilization = 0.17   → 17% semanal (Sonnet específico)
```

### Interpretação

- **5h-utilization × 100** = percentual do budget de 5 horas consumido
- **7d-utilization × 100** = percentual do budget semanal consumido
- **5h-reset** e **7d-reset** são Unix timestamps; converter para tempo relativo:
  ```python
  import time
  delta = int(reset_epoch) - int(time.time())
  # delta > 0: "resets in Xh Ym"
  ```
- `7d_sonnet-utilization`: Anthropic impõe sub-limites por modelo; o Sonnet
  tem tracking separado além do limite unificado.

### SQL completo — todos os headers Claude de uma vez

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

Headers presentes em responses para `api.openai.com` via Codex.

### Headers de quota (response headers, `is_request=0`)

| Header | Tipo | Descrição |
|---|---|---|
| `x-codex-primary-reset-at` | int (Unix epoch) | Quando a janela primária (5h) reseta |
| `x-codex-primary-reset-after-seconds` | int | Segundos até reset da janela de 5h |
| `x-codex-secondary-reset-after-seconds` | int | Segundos até reset da janela semanal |
| `x-codex-active-limit` | string | Tier do plano (`premium`, `free`, etc.) |
| `x-codex-credits-unlimited` | string | `True` \| `False` |
| `x-codex-primary-over-secondary-limit-percent` | int | % do limite 5h em relação ao semanal |

### Valores observados ao vivo (2026-06-02)

```
x-codex-primary-reset-after-seconds          = 18000   → janela 5h (= 5×3600)
x-codex-primary-reset-at                     = 1780460204
x-codex-secondary-reset-after-seconds        = 410167  → ~4d 17h (weekly)
x-codex-active-limit                         = premium
x-codex-credits-unlimited                    = False
x-codex-primary-over-secondary-limit-percent = 0
```

### Interpretação

- **`primary-reset-after-seconds`** = quantos segundos faltam para a janela de 5h
  fechar/zerar. Se = 18000, está no início da janela.
- **`secondary-reset-after-seconds`** ≈ 410k segundos = ~4.7 dias restantes na
  janela semanal.
- **`primary-over-secondary-limit-percent = 0`** = a janela 5h não está
  "mordendo" o semanal (uso baixo).
- **`credits-unlimited = False`** = conta tem limite finito de créditos/calls.

### SQL — headers Codex mais recentes

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

Até 2026-06-02, o tráfego Gemini-cli e agy **não apresentou headers de
rate-limit** observáveis em `http_headers`. Possíveis razões:
- Google pode retornar rate-limit via body JSON em vez de headers
- O endpoint agy (`daily-cloudcode-pa.sandbox.googleapis.com`) pode usar
  mecanismo diferente
- Headers podem existir com nome diferente

**Status:** `TUI-only` — verificar `/usage` na interface web do agy ou Gemini.

**Future-proof:** se a Google passar a incluir headers de rate-limit nas responses
roteadas pelo Piebald, eles aparecerão automaticamente em `http_headers`.
Para checar, usar:
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

DeepSeek **não passa pelo Piebald**. Roda via `cmdc` (cmd-proxy em `:8089`) de
forma independente. Não há headers DeepSeek em `http_headers`.

**Alternativa:** consultar créditos diretamente via API:
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

## Headers de request (`is_request=1`) — o que há de interessante

Além dos headers de response, os headers de request também são armazenados.
Podem ser úteis para:

- Ver qual `anthropic-beta` feature foi ativada por turno
- Verificar o `content-type` da request (application/json vs. multipart)
- Auditar tokens de autenticação enviados (⚠️ NÃO logar nem expor — contêm Bearer tokens)

```sql
-- Headers de request para chamadas Claude (não imprimir valores se contêm auth)
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

## Extensibilidade automática

Qualquer provider novo que seja roteado pelo Piebald e que retorne headers de
rate-limit aparece automaticamente em `http_headers`. Por exemplo:
- **OpenRouter** (quando integrado): se devolver headers de quota, eles estarão aqui
- **Outros providers custom**: mesma regra

Isso torna o `app.db` uma fonte de quota auto-extensível para qualquer provider
que passe pelo Piebald.
