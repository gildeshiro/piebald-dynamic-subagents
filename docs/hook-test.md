# Teste do hook PreToolUse (subagente nativo + cérebro dinâmico)

Objetivo: validar se dá pra ter **subagente nativo** (janela nativa do Piebald) com
**cérebro por-subagente**, via um PreToolUse hook que seta o global JIT antes da criação.

## Setup (1x)
1. Cola o token da Web UI do Piebald e grava em `.pbtoken` (gitignored):
   `echo SEU_TOKEN > C:\Projects\piebald-dynamic-subagents\.pbtoken`
   (ou exporta `PIEBALD_WEB_TOKEN` no ambiente que o Piebald enxerga).
2. **Abre um CHAT NOVO** nesse projeto (o Piebald cacheia hooks na criação do chat;
   hook não carrega mid-sessão).

## Teste (no chat novo)
Peça ao agente para **disparar 2 subagentes nativos em sequência**, cada um com a tag
no início do prompt:
- Subagente A: `[[pbroute provider=3 model=claude-opus-4-8]] Responda só: AGENTE-A`
- Subagente B: `[[pbroute provider=3 model=claude-haiku-4-5-20251001]] Responda só: AGENTE-B`

(Use o tool nativo de subagente do Piebald, NÃO o orchestrate.mjs.)

## O que checar (os 3 unknowns)
1. **Disparou?** `hooks/route.log` tem linhas `fired tool=...` → descobre o `tool_name`
   real do subagente e o shape do `tool_input` (em qual campo está o prompt).
2. **Roteou?** Tem `ROUTED OK -> ...` por subagente.
3. **Pegou o cérebro certo + timing?** No app.db, os 2 chats-filho de subagente
   (`subagent_parent_chat_id` setado) nasceram com `model` distinto (opus vs haiku):
   ```sql
   SELECT id, model, provider_id, subagent_parent_chat_id
   FROM chats WHERE subagent_parent_chat_id IS NOT NULL ORDER BY id DESC LIMIT 4;
   ```
   - Se os models batem com as tags → **timing OK** (hook seta antes da criação).
   - Se vierem iguais → corrida; aí narrow a estratégia (sequencial/lock).

## Depois
- **Narrow o matcher**: trocar `"*"` pelo `tool_name` real descoberto (menos overhead).
- **Restaurar** o global: `node control-plane/ws-cli.mjs set subagent_provider_id "3"`
  e `... set subagent_model "claude-sonnet-4-6"` (o hook deixa o último valor setado).
- Gotchas Windows: hook roda via `cmd /C` (PATH mínimo) → wrapper `.cmd` chama
  `C:\PROGRA~1\nodejs\node.exe`. Mudou settings.json → **chat novo** pra recarregar.
