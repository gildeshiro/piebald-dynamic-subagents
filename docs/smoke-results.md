# Smoke test — todos os modelos × providers (2026-06-10)

Rodado via `control-plane/probe.mjs --concurrency 3` (task curtíssima "responda PROBE-OK"
por combo, auto-delete no sucesso). **20/37 OK.** O resultado VIROU a suposição antiga
("só Anthropic funciona") — hoje, via workers do piebald-web, é o **Claude que está down**.

## Resumo por provider
| Provider | OK | Falhas | Observação |
|---|---|---|---|
| ChatGPT Plus (4) | **4/4** | — | gpt-5.5, 5.4, 5.4-mini, codex-auto-review. (O "quebrado" de antes era quirk de PROFILE, não do provider.) |
| Google jean (5) | 5/8 | 404×2, 429×1 | OK: 3.1-pro-preview, 3-pro-preview, 3-flash-preview, 2.5-flash, 2.5-flash-lite |
| Google gildeshiro (1) | 6/8 | 404×1, 404×1 | OK: idem + 2.5-pro |
| Antigravity jean (2) | 5/6 | 400×1 | OK: 3.1-pro-low, 3-flash, claude-opus-4-6-thinking, claude-sonnet-4-6, gpt-oss-120b |
| Claude Max (3) | **0/11** | **401×11** | 🚨 todos `Invalid authentication credentials` |

## Taxonomia das falhas (quirks pro dev team)
- **Claude Max → HTTP 401 (todos os 11):** `authentication_error: Invalid authentication credentials`.
  **NÃO é rate-limit nem burst** (worker isolado também deu 401). Diagnóstico: o
  `piebald-web` é um **processo separado** do app principal e estava com a **OAuth do
  Claude Max STALE** — a sessão principal (mesmo provider 3) funciona com o token fresco;
  os workers via piebald-web pegaram o token velho → 401 só no Claude. Outros providers
  no piebald-web tinham token válido → passaram. **Provável fix: relançar piebald-web.**
  → Quirk relevante: *workers spawnados via piebald-web usam o contexto de auth do
  piebald-web, que pode divergir do app principal.*
- **Google 404:** model-ids não-serviveis nesta conta/engine: variantes `*-customtools`,
  `gemini-2.0-flash`. (Aparecem em `refresh_provider_models` mas não servem chat.)
- **Google 429:** `gemini-2.5-pro` na conta `jean` (quota); a MESMA model passou na conta
  `gildeshiro` → é quota por-conta, não do model.
- **Antigravity 400:** `gemini-3.1-pro-high` (problema de parâmetro no payload).

## Correção de código que o smoke revelou
`readResult` esperava 60s quando `working_status='error'` sem assistant (os 401 do Claude).
Fix: `working_status` em `{error, abandoned}` → falha **imediata**. (commitado)

## Implicações
- **Cross-provider de verdade JÁ funciona** (OpenAI + Google + Antigravity verdes) —
  derruba o "só Anthropic" que estava nas memórias antigas.
- O catálogo deve marcar status de **chat-time** (não só "lista") — os 404/400 são
  model-ids que listam mas não servem. Candidato a campo `chat_ok` no catalog via probe.
- Pro POC Piebald: anexar esta matriz como evidência de quirks reais por provider/model.
