# Deploy global do roteamento de subagente nativo (sem piebald-web)

Como o comportamento "subagente nativo com cérebro próprio via `[[pbroute ...]]`"
fica **global e local**, sem depender do `piebald-web`, token ou processo extra.

## Por que NÃO precisa de piebald-web (provado 2026-06-14)
O Piebald (app principal e o piebald-web) **relê `subagent_provider_id`/`model`/
`profile_id` do `app.db` no momento em que cria o subagente nativo**. Prova: escrevi
esses settings DIRETO no `app.db` via sqlite (zero WS) e o subagente nativo seguinte
nasceu com o cérebro escrito (sub 551 e 554 = provider 4 / gpt-5.5, baseline era Claude).
Logo o `update_setting` via WS nunca foi especial — ele só escrevia essa mesma tabela.

## As 3 peças
1. **Hook** `hooks/pretooluse-route.mjs` (PreToolUse): no tool nativo (`Agent`/
   `LaunchSubagent`/`Task`), lê `[[pbroute provider= model= profile=]]` do prompt e faz
   `UPDATE settings ...` no `app.db` (com `busy_timeout`). Fallback WS só se o write falhar.
   O PreToolUse **bloqueia** até o exit 0 → o write commita ANTES da criação do subagente.
2. **Hook global**: registrado em `~/.claude/settings.json` (PreToolUse, matcher
   `Agent|LaunchSubagent|Task` → `hooks\pretooluse-route.cmd`). Funciona em QUALQUER projeto.
   Backup do settings.json em `~/.claude/settings.json.bak-pbroute-*`.
3. **Diretiva** no system prompt do profile Default (`base_gen_cfg_data.system_prompt`,
   gen_cfg_id 135) — fonte em `docs/pbroute-directive.txt`. Backup row-level em
   `.pbroute-default-systemprompt.bak` (gitignored).

## Ativação
Requer **restart do Piebald** (system prompt e hooks globais são lidos no boot/criação do chat).
O `.cmd` usa `C:\PROGRA~1\nodejs\node.exe` (Node 24, `node:sqlite` OK) porque o ambiente de
hook do Piebald tem PATH mínimo.

## Reverter
- Diretiva: `UPDATE base_gen_cfg_data SET system_prompt=<conteúdo de .pbroute-default-systemprompt.bak> WHERE gen_cfg_id=135;`
- Hook global: restaurar `~/.claude/settings.json` do backup `*.bak-pbroute-*` (ou remover a entrada com matcher `Agent|LaunchSubagent|Task`).

## Uso
No prompt de um subagente nativo: `[[pbroute provider=4 model=gpt-5.5]] <tarefa>`.
Vários cérebros distintos → lançar SEQUENCIALMENTE (o setting é global, paralelo corre).
model-ids válidos por provider: `control-plane/catalog.json`.

## Quando piebald-web AINDA importa
- Caminho de **workers WS** (`create_chat`/`send_message_streaming`, paralelo programático).
- Projeto **piebald-mobile-mod** (acesso remoto/web; usa `bin/start-piebald-web.ps1`).
O caminho nativo (este doc) não usa nenhum dos dois.
