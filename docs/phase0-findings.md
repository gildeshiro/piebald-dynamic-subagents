# Fase 0 — Achados de validação (recon ao vivo, 2026-06-03)

Validação empírica feita rodando dentro do Piebald, mexendo no app vivo
(reversível). Tudo confirmado com evidência, não suposição.

## Resultado central: o control-plane resolve o problema — sem MITM, sem restart

O subagente do Piebald lê provider/model/profile de **settings globais**
(`subagent_provider_id`, `subagent_model`, `subagent_profile_id`,
`subagent_use_custom_config`). Não existe config por-launch nativa — esse é o
gargalo. **Mas** dá pra trocar esses settings AO VIVO via WebSocket, e o próximo
`LaunchSubagent` captura o valor novo na criação do chat-filho.

### Comando `update_setting` (o mutador ao vivo)

`ws://127.0.0.1:7000/api/ws` expõe:

```json
{ "msg":"command", "id":1, "name":"update_setting",
  "request": { "key":"subagent_model", "value":"claude-sonnet-4-6" } }
```

- Atualiza **memória + DB** juntos → **sem restart**.
- **Valores são SEMPRE string**, inclusive IDs: `"5"`, não `5`
  (erro real: `invalid type: integer 5, expected a string`).
- Nomes que NÃO existem: `set_settings`, `update_settings`, `set_setting`,
  `save_settings`, `patch_settings`, `set_subagent_settings`. Só `update_setting`.

### Prova cabal (cross-provider ao vivo)

1. `update_setting subagent_provider_id="5"` (Google) + `subagent_model="gemini-3.5-flash"`.
2. Disparado um subagente trivial (tool Agent = `LaunchSubagent`).
3. O request do subagente foi para **`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`**
   (endpoint Google) — não `api.anthropic.com`.
4. → A troca de provider ao vivo foi honrada end-to-end pelo próximo launch.

> O subagente retornou HTTP 404 (`gemini-3.5-flash` não existe naquele endpoint
> cloudcode/conta) — quirk de disponibilidade de modelo, NÃO falha de protocolo.
> Validar catálogo de model-ids válido por provider é tarefa da Fase 1.

Settings restaurados ao default (provider 3 / claude-sonnet-4-6) ao fim do teste.

## Anatomia do request de subagente (alvo de qualquer rewrite futuro)

Corpo (Anthropic `/v1/messages?beta=true`), JSON limpo:

```json
{ "model":"claude-sonnet-4-6", "max_tokens":32000,
  "thinking":{"type":"adaptive","display":"summarized"},
  "system":[...], "messages":[...], "tools":[...], "stream":true }
```

- Auth = **OAuth de assinatura** (header `anthropic-beta` inclui `oauth-2025-04-20`).
  Confirma que a abordagem certa é preservar a chamada legítima (não API key).
- Effort/thinking viajam via beta flags (`effort-2025-11-24`,
  `interleaved-thinking-2025-05-14`) + campo `thinking`.

## Modelo de dados relevante (app.db)

- `messages`: tem `model`, `provider_id`, `profile_id`, `config_id` POR MENSAGEM.
- `chats`: subagente é chat-filho via `subagent_parent_chat_id`; tem
  `provider_id`/`model`/`profile_id`/`config_id` próprios + `default_subagent_profile_id`.
- `profiles` → `generation_configs` (+ overrides por engine:
  anthropic `effort`/`thinking_*`, openai `reasoning_effort`/`service_tier`,
  google `thinking_budget`).
- → A infra de heterogeneidade JÁ existe no schema; falta só *escolher* no launch.

## Implicação para a arquitetura

O **MITM/data-plane proxy fica deprioritizado** (provavelmente desnecessário no v1).
Espinha = control-plane: `update_setting` (set) → launch, por subagente, usando a
auth de assinatura legítima. Econômico, ban-safe, mínimo de código.

### Aberto p/ Fase 1
- Race do setting global no **paralelo heterogêneo**: precisa de set→launch sem
  corrida. Investigar comando WS para **criar/spawnar subagente com provider/model
  explícito** (bypassa o global) — ex.: `create_chat`/`spawn_subagent`.
- Catálogo de model-ids válidos por provider (evitar 404 tipo gemini-3.5-flash).

### POC p/ time Piebald
"Exponham override de generation-config por `LaunchSubagent`. O `update_setting`
global já aplica ao vivo; o DB já guarda provider/model/config por-chat e
por-mensagem. Só falta aceitar o override no launch." Protótipo = evidência.
