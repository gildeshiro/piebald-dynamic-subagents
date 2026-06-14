# E2E nativo + hook JIT-routing — validação ao vivo (2026-06-14)

Sessão que provou o caminho **subagente NATIVO heterogêneo** via PreToolUse hook,
consertou o `readResult`, e dissecou o caso "Gemini travado".

## 1. Máquina de estados do `working_status` (chats) — descoberta no app.db

| estado | classe | ação no readResult |
|---|---|---|
| `working`, `backlog` | em progresso | continua poll |
| `done`, `finished`, `idle` | terminal OK | assenta (sucesso se houver texto) |
| `error`, `abandoned` | terminal FALHA | retorna erro na hora |
| `waiting_tool_call` | **pausado p/ tool** | normalmente TRANSITÓRIO; timeout secundário `stuckToolMs` só pra isso |

`messages.status`: `completed` / `interrupted` / `error`.
`message_part.part_type`: `tool_call` / `text` / `context_notification` / `image`.
`message_part_tool_call.tool_state`: `completed` / `error` / `interrupted` / `denied` / `pending` / `executing`.

## 2. O caso "Gemini travado" (chat 538, soft-deleted, ressuscitado do banco)

A msg assistant do worker tinha **2 `tool_call` e ZERO `text`**:
1. `TodoWrite` → *"Realizar brainstorming para o haiku..."*
2. `retrieve_tools` query=`"brainstorming"`

**Causa raiz:** o skill `brainstorming` auto-disparou (AGENTS.md/system prompt:
"MUST brainstorm before creative work"). Uma tarefa de 1 linha virou modo-ferramenta;
as tools ficaram `pending` → `waiting_tool_call` → travou os 180s.

Consequências:
- **Fix ingênuo errado**: "assistant=completed → pega texto" devolveria **""** (não há text part). Por isso o readResult agora retorna status `no_text` quando o assistant terminou só com tool_call.
- **Higiene de probe**: probe simples = *"responda em UMA linha, sem ferramentas"*. Mediu 2.7s (limpo) vs 59s (com detour de brainstorming).
- **Modelos mentem o próprio nome** (Gemini disse "Claude 3.5 Sonnet" num probe). Verificar cérebro SEMPRE por `messages.provider_id`/`model` no app.db, nunca pelo texto.

## 3. readResult v3 (control-plane/ws-client.mjs)

- `PROGRESS={working,backlog}` `DONE={done,finished,idle}` `FAIL={error,abandoned}`.
- `waiting_tool_call`: timeout SECUNDÁRIO `stuckToolMs` (default 30s) — não trava, mas
  não falso-positiva worker lento (validado: Gemini com detour completou em 59s sem disparar).
- Novos status de retorno: `paused_tool_call` (preso em tool) e `no_text` (terminou só com tool_call).
- `pendingToolCalls(chatId)` expõe as tools `pending/executing/denied` do último assistant.
- `orchestrate.runOne`: `ok = status==='completed'` (antes `!== 'error'` deixava passar `no_text`/`paused`).

## 4. Subagente NATIVO heterogêneo via hook — PROVADO LIMPO

Vetor: CHAT TESTE (chat 541, Claude Sonnet 4.6, YOLO) na UI web, dirigido via chrome-devtools.

**3 unknowns do hook → todos resolvidos:**
- PreToolUse dispara nos chats do projeto? **SIM** (route.log pega TODAS as tools).
- Dispara pro subagente nativo? **SIM** — o tool nativo se chama **`Agent`** neste runtime
  (`input_keys=prompt,description,subagent_type`), não "LaunchSubagent".
- Timing antes da criação? **SIM** — `ROUTED OK` sempre no mesmo segundo da criação do chat-filho.
- Corrida no paralelo? **Evitada** rodando **sequencial** (1 Agent por vez).

**Teste limpo (orquestrador PROIBIDO de rotear na mão; baseline global = Claude P3):**
os 4 subagentes nasceram cada um com o cérebro EXATO da tag (se o hook falhasse, sairiam
todos claude-sonnet):

| sub | tag | nasceu (app.db) | respondeu |
|---|---|---|---|
| 544 | P4 gpt-5.5 | prov 4 / gpt-5.5 | PONG gpt-5.5 |
| 545 | P5 gemini-3-flash-preview | prov 5 / gemini-3-flash-preview | PONG gemini-3-flash-preview |
| 546 | P2 gpt-oss-120b-medium | prov 2 / gpt-oss-120b-medium | PONG gpt-oss-120b-medium |
| 547 | P1 gemini-2.5-flash | prov 1 / gemini-2.5-flash | PONG Gemini 2.5 Flash |
| 548 | P3 claude-haiku-4-5 | prov 3 / claude-haiku-4-5 | PONG claude-haiku-4-5 |

→ **5 providers (P1–P5)** cobertos via subagente nativo, todos no app principal (auth fresca),
todos renderizando como subagente nativo na UI (`subagent_parent_chat_id=541`, botão "Open chat").
Print: `docs/native-subagents-ui.png`.

## 5. Bug do hook consertado (greedy → gated)

Antes: o hook roteava pra QUALQUER tool cujo input serializado contivesse `[[pbroute]]`
(falso-positivo: a própria chamada `fill()` do browser com a tag no texto roteou o global!).
Agora: **gate `tool ∈ {Agent, LaunchSubagent, Task}`** antes de qualquer ação.

## 6. Confound a lembrar

Se o chat orquestrador for um agente capaz primado pelo AGENTS.md do projeto, ele
**roteia na mão via WS** (lê o control-plane e faz `update_setting` sozinho), mascarando
o hook. Pra testar o hook isolado: instruir explicitamente "NÃO use Bash/WS/update_setting;
o roteamento é automático". Foi assim que a prova limpa (seção 4) foi obtida.

## Pendências / próximos
- Cobertura por-MODELO (37) no caminho nativo: a viabilidade por-modelo já está no smoke WS
  (mesma auth/model-ids); o nativo difere só no processo (app principal vs piebald-web).
- Continuação de worker em `waiting_tool_call`/`denied` (responder a tool call) — camada 2.
- (ideia) o hook poderia escrever no system do subagente via profile, não só reasoning.
