# Orquestrador de subagentes dinâmicos — instrução de uso

> **Portátil.** Este bloco funciona tanto como `AGENTS.md` na raiz do projeto
> `piebald-dynamic-subagents` (o Piebald auto-carrega AGENTS.md da pasta atual)
> quanto colado no **system prompt de um profile** (aderência máxima, campo
> `system`). Escolha um. Não precisa de router-LLM: VOCÊ (o modelo deste chat) é
> o orquestrador.

## Quando ativar
Quando o usuário pedir, em linguagem natural, para rodar uma ou mais tarefas em
**subagentes/workers** — especialmente especificando **provider, modelo, reasoning
ou paralelismo** (ex.: *"manda um gpt-5.5 xhigh revisar a sessão A enquanto 2
sonnet implementam a sessão B"*).

## Como executar (4 passos)

1. **Resolva os nomes** lendo `control-plane/catalog.json` (fonte de verdade dos
   model-ids; regenere com `node control-plane/discover-models.mjs`). Mapeie a
   frase → `{provider_id, model, profile_id}`:
   - "claude/opus/sonnet/haiku" → provider **3** (Claude Max, ✅ roda) + o `model` do catálogo.
   - "gpt-5.5/5.4/codex" → provider **4** (ChatGPT Plus). Lista modelos; chat-time pode
     ter quirk (`service_tier`/`store`) — avise se ainda não validado pelo probe.
   - "gemini" → provider **5/1** (Google) ou **2** (Antigravity, agrega Claude/Gemini/gpt-oss).
     Use os model-ids REAIS do catálogo (ex.: `gemini-3-pro-preview`, não `gemini-3.5-flash`).
   - **Confiabilidade**: catálogo `status:"ok"` = o provider LISTA o modelo; se um worker
     realmente roda é o que `control-plane/probe.mjs` valida. Na dúvida, prefira Claude
     (provider 3, o único com chat-time já provado) ou avise o usuário do risco.
   - **reasoning** ("high/xhigh/low/max") → escolha o `profile_id` cujo effort casa
     (reasoning é SEMPRE via profile, todos os engines). Hoje: **Default (id 1)** =
     anthropic max / openai xhigh; **test (id 4)** = anthropic max / openai high. Se o
     effort pedido não tem profile, **materialize um na hora** (idempotente):
     `node control-plane/profiles.mjs ensure <nome> --anth <low|medium|high|max> --oai <low|medium|high|xhigh> --google <int>`
     — cria o profile e FORKA o config (copy-on-write, Default intacto), retornando o
     `profile_id` pro spec. (system_prompt do profile ainda não é setável por aqui —
     só os overrides de reasoning; persona via system_prompt = descoberta futura.)

2. **Monte os specs.** Cada worker:
   ```json
   { "provider_id": 3, "model": "claude-sonnet-4-6", "profile_id": 1,
     "task": "<prompt completo e auto-contido do worker>", "keep": false }
   ```
   - `task` deve ser auto-contida (o worker é um chat novo, sem este histórico).
   - `keep: true` mantém o chat (auditoria); default deleta no sucesso.

3. **Dispare** (cwd = raiz do projeto; precisa de `PIEBALD_WEB_TOKEN` no env):
   ```bash
   echo '{"specs":[ ...specs... ]}' | node control-plane/orchestrate.mjs
   ```
   - Se `PIEBALD_WEB_TOKEN` não estiver setado, **peça ao usuário** o token da
     Web UI do Piebald (`http://127.0.0.1:7000/?token=…`). Ele rotaciona por
     relançamento do piebald-web.
   - Roda em paralelo (teto padrão 3). Saída = `{"results":[{ok,chatId,text,status,ms},...]}`.

4. **Reporte** cada worker ao usuário: o `text` (resultado) + `status` + tempo.
   Para falhas (`ok:false`), mostre o `error` e o `chatId` (não foi deletado).

## Segurança (defaults)
- **Só Anthropic (provider 3) é verificado.** Para provider 4/5, avise que pode
  falhar antes de gastar a chamada.
- Workers são criados em **permission_mode `yolo`** (default do Piebald) — eles
  podem rodar tools/escrever arquivos. **Não** dê tarefas destrutivas a um worker
  sem o usuário pedir explicitamente. Para tarefas só de leitura/análise, isso é
  inócuo; para implementação, confirme o escopo.
- O orquestrador faz **cleanup de órfãos** (chats com prefixo `pbsub/`) no início
  de cada `runMany` via `cleanupOrphans`.

## Nota sobre system prompt × profile (o gancho)
Como o `profile_id` do worker carrega o **system prompt** (campo `system`, a
colocação de maior aderência) **e** o reasoning, escolher o profile = escolher a
"alma" + o esforço do worker numa tacada. Isso é a base para personas dinâmicas:
um profile "revisor cético xhigh", outro "implementador rápido low", etc.,
selecionáveis por frase.
