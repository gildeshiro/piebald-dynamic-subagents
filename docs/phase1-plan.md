# Fase 1 — Plano de implementação (o orquestrador)

> Estado: recon COMPLETO (Fase 0 + descoberta de comandos WS + UI capture).
> Tudo abaixo se apoia em primitivos JÁ VALIDADOS ao vivo. Sem MITM, sem restart,
> usando a auth de assinatura legítima do Piebald.

## Resumo de uma linha
Um orquestrador que recebe uma frase em linguagem natural, decompõe em N
"workers", cria um chat por worker com **provider + modelo + profile (=reasoning)**
próprios, dispara a tarefa em cada um (em paralelo), coleta os resultados e limpa.

## Modelo conceitual (o que aprendemos)
- **worker = { provider_id, model, profile_id, task, dir }**
  - `provider_id` + `model` → o backend (Claude/OpenAI/Google).
  - `profile_id` → carrega **reasoning/effort** (anthropic `effort`, openai
    `reasoning_effort`, google `thinking_budget`) + system prompt + tuning.
    Reasoning é HERDADO do profile; não há controle por-mensagem.
- Cada worker é um **chat independente** → sem corrida no setting global →
  paralelo heterogêneo de verdade.

## Comandos WS usados (todos confirmados)
| Ação | Comando |
|---|---|
| Criar worker com cérebro | `create_chat {model_config:{provider_id,model,config_id,profile_id}, current_directory, title}` |
| Trocar profile de um chat | `change_chat_profile {chat_id, profile_id, force}` |
| Trocar provider/model | `update_chat {chat_id, model_config:{provider_id,model}}` |
| Disparar tarefa | `send_message_streaming {chat_id, parts:[texto]}` |
| Ler resultado | `get_full_chat_history {chat_id}` + eventos `StreamedChunk`/`FinishSession` |
| Catálogo | `list_providers {}`, `list_profiles {}` |
| Limpar | `delete_chat {chat_id}` |
| Setting global ao vivo | `update_setting {key, value-STRING}` |

## Arquitetura (enxuta — 1 lib + 1 catálogo + 1 protocolo)

```
piebald-dynamic-subagents/
  control-plane/
    ws-cli.mjs          (já existe — get/set settings)
    ws-client.mjs       (NOVO) cliente WS reutilizável: connect+auth, RPC por id,
                                subscribe de eventos, token getter
    catalog.mjs         (NOVO) lê list_providers + list_profiles + model ids válidos
                                -> mapa {provider, models[], profiles[+effort]}
    orchestrate.mjs     (NOVO) recebe specs[] -> create_chat -> send -> collect -> report
  docs/ ...             (recon — já existe)
  AGENTS.md             (NOVO) protocolo NL: como o agente do chat traduz a frase
                                em specs[] e chama orchestrate.mjs
```

A camada de **linguagem natural fica no próprio modelo do chat** (orquestrador) —
sem router-LLM. O AGENTS.md ensina o agente a: (a) ler o catálogo, (b) mapear
"gpt-5.5 xhigh" -> {provider_id, model, profile_id}, (c) chamar orchestrate.mjs.

## Sub-fases (bite-sized)

### 1a — Fundação read-only
- [ ] `ws-client.mjs`: connect(`?token`), espera `web_access_granted`, RPC
      `call(name, request)` com correlação de `id` + timeout; `on(eventType, cb)`.
- [ ] **Token getter** (3 fontes, em ordem): env `PIEBALD_WEB_TOKEN` → ler da
      página aberta no browser (chrome-devtools) → grep do log do dia →
      `~/.piebald-remote/current-token`. (Token rotaciona por launch do piebald-web.)
- [ ] `catalog.mjs`: `list_providers` + `list_profiles` (+ effort de cada profile
      via app.db) + model ids válidos por provider (app.db `provider_custom_models`
      + requests `model_listing`). Saída = JSON do que dá pra rotear hoje.
- [ ] Smoke: imprime o catálogo. **Checkpoint de review.**

### 1b — Worker único ponta-a-ponta
- [ ] `orchestrate.mjs runOne(spec)`: `create_chat` (brain) → `send_message_streaming`
      (task) → aguarda `FinishSession` (via evento) ou poll `get_full_chat_history`
      → extrai texto final → opcional `delete_chat`.
- [ ] Testa com 1 worker Claude (provider 3) numa task trivial. **Checkpoint.**

### 1c — Paralelo heterogêneo
- [ ] `runMany(specs[])`: dispara N em paralelo, coleta todos, devolve array.
- [ ] Testa o caso do sonho: 1 worker A (review) + 2 workers B/C (impl), brains
      distintos, simultâneos. **Checkpoint.**

### 1d — Camada NL (o "por linguagem natural")
- [ ] `AGENTS.md`: protocolo de tradução frase → specs[] usando o catálogo;
      regras de fallback (effort sem profile correspondente → profile mais próximo
      ou avisa).
- [ ] Teste: dar a frase real e ver o agente orquestrar.

### 1e — Robustez / polish
- [ ] Validação de model-id por provider (evitar 404 tipo gemini-3.5-flash;
      lembrar service_tier/store que quebram gpt-5.5 no codex).
- [ ] Tratamento de erro por worker (um falhar não derruba os outros).
- [ ] Limpeza opcional (`delete_chat`) vs manter como trilha de auditoria.
- [ ] Permission mode dos workers: `create_chat` default = `yolo`. Decidir política
      (workers autônomos precisam, mas é poderoso — tornar explícito/configurável).

## Decisões em aberto (não bloqueiam o começo)
1. **Profiles de reasoning**: v1 assume profiles pré-criados por você na UI
   (ex.: "claude-high", "gpt5-xhigh", "gemini-low"). Criar profile via código
   (`create_profile` + gravar override de effort) é stretch — deixar pra depois.
2. **Onde o orquestrador roda**: script Node chamado pelo agente do chat (eu),
   token via env/getter. (Alternativa futura: daemon.)
3. **POC pro time Piebald**: cai naturalmente — "exponham create-subagent com
   {provider, model, profile} no LaunchSubagent". Nosso orquestrador é a evidência.

## O que NÃO vamos fazer (anti-escopo)
- MITM / proxy de tráfego (desnecessário).
- Router-LLM separado (o agente do chat já faz o parse).
- Tradução cross-provider de payload (o Piebald já fala com todos nativamente).
