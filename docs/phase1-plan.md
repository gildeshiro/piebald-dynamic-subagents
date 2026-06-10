# Fase 1 — Plano de implementação v2 (revisado pós-review crítico)

> v1 passou por review crítico de um modelo diferente (claude-sonnet). Esta v2
> incorpora os ajustes. Trail no fim do doc. Tudo se apoia em primitivos JÁ
> VALIDADOS ao vivo. Sem MITM, sem restart, auth de assinatura legítima.

## Resumo de uma linha
Orquestrador que recebe uma frase NL, decompõe em N workers, cria 1 chat por
worker com **provider + modelo + profile (=reasoning)** próprios, dispara a tarefa
(paralelo com teto de concorrência), coleta resultados e limpa.

## Modelo conceitual
- **worker = { provider_id, model, profile_id, permission_mode, task, dir, title }**
  - `profile_id` carrega reasoning/effort (herdado do profile). Reasoning NÃO é
    por-mensagem.
- Cada worker = chat independente → paralelo heterogêneo sem corrida no global.

## Shapes confirmados (do recon — corrige imprecisões da v1)
- `create_chat` → resposta `{chat:{id,...}, project:{...}}` → **`chat_id = chat.id`**
  (provado: chats 215, 217).
- `send_message_streaming.parts` (shape REAL, não `[texto]`):
  ```json
  parts: [{ "type":"text", "text":{ "nodes":[{ "type":"text", "data":{ "content":"<task>" }}]}}]
  ```
  + `branching_intended:false` (e `parent_message_id` só se o chat já tem msgs).
- **Leitura de resultado (PRIMÁRIA, já provada): app.db.** `message_parts` →
  texto onde `messages.parent_chat_id=chat_id`, role=assistant, status final;
  completude via `chats.working_status` (idle). DB: `%APPDATA%\Piebald\app.db`
  (abrir `file:...?mode=ro`).
- Leitura SECUNDÁRIA (bônus, do piebald-remote/PROTOCOL.md, re-verificar nesta
  versão): `get_full_chat_history {chat_id}` + eventos `StreamedChunk`
  (variantes `TextDelta`/`FinishMessage`/`FinishSession{finish_reason,
  total_generations}`) + `ChatUpdated{working_status}`.
- **A confirmar empiricamente em 1a:** `config_id` vs `profile_id` no `create_chat`
  — hipótese: passar só `profile_id` basta (Piebald deriva o config do profile,
  como o `change_chat_profile` faz); `config_id` é opcional/derivado.

## Comandos WS usados (confirmados)
`create_chat`, `change_chat_profile {chat_id,profile_id,force}`, `update_chat`,
`send_message_streaming`, `delete_chat`, `list_providers`, `list_profiles`,
`list_chats`, `get_chat`. (Removido `update_setting` — era resíduo da Fase 0; o
orquestrador NÃO usa o setting global.)

## Sub-fases (reordenadas pelo review)

### 1.0 — Bootstrap do TOKEN [BLOQUEANTE, isolado]
Critério binário: o token conecta e recebe `web_access_granted`.
- [ ] ws-client lê **`PIEBALD_WEB_TOKEN`** (env). Sem ele → falha rápida com
      instrução: "abra a Web UI do Piebald e copie o `?token=` da URL".
- [ ] Fallback best-effort (conveniência, não confiável): grep do log do dia em
      `%APPDATA%\Piebald\logs\<YYYY-MM-DD>.log` por `token=<...>` — MAS validar
      contra `web_access_granted` (token velho do log → rejeita → erro claro, não
      obscuro). **Sem** as 4 fontes mágicas da v1.
- [ ] (Pós-v1) avaliar usar o launcher do `piebald-remote` que escreve
      `~/.piebald-remote/current-token` quando ele gerencia o piebald-web.

### 1a — ws-client + validação de shapes [fundação]
- [ ] `ws-client.mjs`: connect+auth; `call(name, req, {timeoutMs})` com correlação
      de `id` + **timeout explícito por chamada** (default 15s p/ comandos rápidos);
      `on(eventType, cb)`; detectar `web_access_required` no meio → erro
      "token expirou" (não genérico).
- [ ] `readResult(chatId, {timeoutMs})`: poll `app.db` (working_status idle +
      último assistant text). Caminho do DB + query documentados e testados via Node
      (sqlite3 CLI ou driver).
- [ ] Validar/documentar ao vivo: resposta de `create_chat` (chat.id), shape de
      `parts`, e `profile_id` vs `config_id`.
- [ ] **Checkpoint:** round-trip no-op — `create_chat` → `readResult` (vazio) →
      `delete_chat`. Confirmar `delete_chat` idempotente (chamar 2x não quebra).

### 1b — runOne(spec) COM tratamento de erro [não é mais 1e]
- [ ] `runOne(spec)`: `create_chat` → `send_message_streaming` → `readResult`
      (timeout, default 180s) → `{ok, text|error, chatId, ms}`. **try/catch por
      worker** — falha isolada, nunca propaga.
- [ ] `permission_mode` é **campo explícito do spec** [DECISÃO ANTES DE CODAR]:
      default `'default'` (seguro; tasks de review/leitura). `'yolo'` só quando o
      caller opta explicitamente (tasks de implementação). Documentar o risco.
- [ ] **Checkpoint:** 1 worker Claude (provider 3) numa task trivial, ponta-a-ponta.

### 1c — runMany com concorrência + cleanup [executável HOJE]
- [ ] `runMany(specs[], {maxConcurrency=3})`: paralelo com teto; backoff simples em
      rate-limit/429 (confiabilidade, não economia).
- [ ] **Cleanup de órfãos no início:** `list_chats` → `delete_chat` nos chats com
      prefixo de título do orquestrador (ex.: `pbsub/`) não limpos em runs passados.
- [ ] **Checkpoint (HOJE, sem cross-provider):** 3 workers **Claude** com **profiles
      de reasoning distintos** (ex.: high / low / default) em paralelo; provar
      simultaneidade por timestamps. Cross-provider (gpt/gemini) = tarefa separada,
      gated em consertar OpenAI/Google (service_tier/store/model-id).

### 1d — catalog.json + interface + protocolo NL
- [ ] `catalog.json` ESTÁTICO (mantido à mão no v1): providers, models válidos,
      profiles+effort. (Busca dinâmica no app.db = pós-POC.)
- [ ] **Interface do `orchestrate.mjs` DEFINIDA aqui (antes do AGENTS.md):**
      lê `specs` JSON via stdin (ou `--file`), escreve `results` JSON em stdout,
      exit codes (0 ok, !=0 erro). 
- [ ] `AGENTS.md`: protocolo NL → `specs[]` usando o catalog.json; regras de
      fallback (provider/effort inexistente → mais próximo ou avisa).

### 1e — hardening
- [ ] Reconexão / detecção de token expirado robusta.
- [ ] Health-check de provider (pular os quebrados; usar `get_all_rate_limit_info`).
- [ ] Consertar OpenAI/Google (service_tier=flex, store, model-ids) → habilitar
      cross-provider de verdade.
- [ ] (Opcional) catálogo dinâmico do app.db; criar profile por código.

## Decisões resolvidas (eram "em aberto")
1. **Token v1**: só env `PIEBALD_WEB_TOKEN`, fail-fast.
2. **Resultado**: app.db é a leitura primária (provada); WS history é bônus.
3. **permission_mode**: por-spec, default seguro.
4. **catalog**: json estático no v1.
5. **config_id/profile_id**: validar em 1a; default = passar só profile_id.

## Anti-escopo
MITM/proxy; router-LLM separado; tradução cross-provider de payload; 4 fontes de
token; busca dinâmica de catálogo no v1.

---
### Trail (v1 → v2, via review crítico de modelo diferente — claude-sonnet)
Mudanças aceitas: token getter→env-only/isolado em 1.0; corrigido shape de `parts`;
erro-por-worker movido p/ 1b; permission_mode explícito antes de 1b; 1c redefinido
p/ 3 Claude com reasoning distinto (cross-provider gated); cleanup de órfãos;
timeouts+concorrência+backoff; catalog estático; interface do orchestrate antes do
AGENTS.md; removido `update_setting` do orquestrador. Rejeitado/corrigido: shape do
`create_chat` (já conhecido = chat.id) e leitura de resultado (não-bloqueante, via
app.db já provada).
