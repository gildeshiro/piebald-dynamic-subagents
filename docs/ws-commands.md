# WebSocket — surface de comandos descoberto (Fase 0/1, validado 2026-06-03)

Endpoint: `ws://127.0.0.1:<PIEBALD_WEB_PORT|7000>/api/ws?token=<TOK>`
Handshake: aguardar `{"msg":"web_access_granted"}` antes de enviar comando.
Envelope: `{"msg":"command","id":N,"name":"<cmd>","request":{...}}` →
resposta `{"msg":"command_response","id":N,"success":bool,"response"|"error"}`.

> Token rotaciona a cada relançamento do `piebald-web.exe` e **só aparece no log
> quando o browser abre a URL** (`GET /?token=`). Não está em cmdline nem arquivo
> de estado. Getter robusto do token = item aberto da Fase 1.

## Comandos CONFIRMADOS

| Comando | Request | Resposta / efeito |
|---|---|---|
| `get_settings` | `{}` | `{settings:{...}}` (settings tipados) |
| `update_setting` | `{key, value}` | **valor SEMPRE string** (`"5"` não `5`). Aplica memória+DB **ao vivo, sem restart** |
| `list_providers` | `{}` | `{providers:[{id,name,type,engine_type,...}]}` |
| `get_all_rate_limit_info` | `{}` | quota de todos providers (visto em sessão anterior) |
| `list_chats` | `{}` | `{chats:[...]}` |
| `get_chat` | `{chat_id}` | `{chat:{...}}` (inclui provider_id/model/config_id/profile_id/current_directory/project_id) |
| `create_chat` | `{model_config:{provider_id,model,config_id,profile_id}, current_directory, title}` | `{chat, project}` — **cria worker independente com cérebro escolhido** |
| `update_chat` | `{chat_id, model_config:{provider_id,model}}` | `{success}` — troca o cérebro de um chat existente |
| `delete_chat` | `{chat_id}` | soft delete (`is_deleted=1`) |
| `duplicate_chat` | `{chat_id, ...}` | existe (clona chat) |
| `list_profiles` | `{}` | `{profiles:[{id,name,config_id,is_system,is_ootb}]}` |
| `create_profile` | `{name, ...}` | existe (cria profile = config nomeada) |
| `send_message_streaming` | `{chat_id, parts:[{type:"text",text:{nodes:[{type:"text",data:{content}}]}}], parent_message_id?, branching_intended:false}` | injeta msg + dispara turno (proven) |

## Comandos que NÃO existem
`set_settings`, `update_settings`, `set_setting`, `save_settings`, `patch_settings`,
`spawn_subagent`, `create_subagent`, `launch_subagent`, `get_messages`,
`get_chat_messages`, `archive_chat`, `remove_chat`.
→ Subagente "oficial" só nasce via o tool `LaunchSubagent` do modelo. Para
orquestração programática usamos `create_chat` + `send_message_streaming`.

## Receita: paralelo heterogêneo **race-free** (o sonho)

Sem MITM, sem restart, usando auth de assinatura legítima. Para cada worker
`{provider_id, model, effort→config_id/profile_id, task, dir}`:

1. `create_chat {model_config:{provider_id, model, config_id|profile_id}, current_directory: <projeto>, title}`
   → o cérebro é fixado **na criação** do chat → **sem corrida no setting global**.
2. `send_message_streaming {chat_id, parts:[texto da task]}` → dispara o turno.
3. Rodar N em paralelo (são chats independentes, brains distintos simultâneos).
4. Ler resultado do `app.db` (`message_parts`→texto onde `parent_chat_id=chat_id`,
   role=assistant, status final); acompanhar via `chats.working_status`.
5. `delete_chat {chat_id}` pra limpar, ou manter como trilha de auditoria.

Effort/reasoning: apontar `config_id`/`profile_id` para uma `generation_config`
com o override do engine (anthropic `effort`/`thinking_*`, openai
`reasoning_effort`/`service_tier`, google `thinking_budget`). Pré-criar profiles
por effort com `create_profile`.

## Aberto p/ Fase 1
- **Getter de token robusto** (rotaciona, só loga ao abrir UI).
- **Leitura de output do worker** sem comando WS dedicado (usar app.db / polling
  de `working_status`; ou achar comando de leitura de mensagens).
- **Catálogo de model-ids válidos por provider** (evitar 404 tipo gemini-3.5-flash):
  via `list_providers` + `provider_custom_models` + requests `model_listing` no app.db.
