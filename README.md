# piebald-dynamic-subagents

Subagentes **heterogêneos** para o **Piebald**: dar a cada subagente nativo um
**cérebro diferente** (provider + modelo) e um **profile próprio** (reasoning +
system prompt) no momento do disparo — algo que o Claude Code faz via frontmatter
`model:` do subagente, mas que o Piebald não expõe.

O Piebald roteia **todos** os subagentes para o mesmo provider/modelo/profile default.
Não há campo "este subagente usa Opus, aquele usa Gemini, o outro usa Haiku". Este
projeto adiciona esse roteamento por subagente sem fork do Piebald: um **hook
`PreToolUse`** lê uma diretiva `[[pbroute …]]` no prompt do subagente e grava a rota
no `app.db` **just-in-time**, antes do subagente nascer.

> Replica o `model:`/persona-por-subagente do Claude Code dentro das limitações do
> Piebald (que não tem API pública de roteamento por subagente). A rota é um estado
> global flipado por launch — daí as regras de ordem abaixo.

---

## A diretiva

No prompt do subagente, um prefixo opcional escolhe o cérebro e o profile:

```
[[pbroute provider=<id> model=<model-id> profile=<id>]]
```

Qualquer subconjunto dos três campos vale; só os presentes são aplicados. Sem tag,
o subagente herda o default atual (Claude). Exemplos:

```
[[pbroute provider=5 model=gemini-3-pro-preview]]            Pesquisa esta API e resuma…
[[pbroute provider=3 model=claude-opus-4-8 profile=4]]        Faça a auditoria de segurança…
[[pbroute provider=4 model=gpt-5.5]]                          Critique este plano…
```

`provider`/`model` válidos vivem em `control-plane/catalog.json` (gerado ao vivo).
`profile` aponta para um Profile do Piebald (provider/model default + **reasoning
effort** + system prompt) — é o que carrega a persona + o nível de raciocínio.

---

## As peças

| Peça | O quê | Cobre | Arquivo |
| --- | --- | --- | --- |
| **Hook** | `PreToolUse` que detecta `[[pbroute]]` e faz JIT-write da rota no `app.db` antes da criação do subagente | "aplicar a rota" | `hooks/pretooluse-route.mjs` · `.cmd` |
| **Guard** | Anti-mis-route: baseline + changes-guard (não vaza rota de um launch pro próximo) | "não roteia errado em silêncio" | `hooks/pretooluse-route.mjs` (A1/A2) · `control-plane/pbroute-baseline.json` |
| **Catálogo** | Descoberta ao vivo de providers/modelos/profiles | "o que dá pra rotear" | `control-plane/catalog.json` · `discover-models.mjs` |
| **Profiles** | Criar/editar/remover Profiles via API legítima do Piebald | "personas + reasoning" | `control-plane/profiles.mjs` |
| **Probe** | Valida que um modelo de fato roda como worker (status `ok` ≠ roda) | "rota não-fantasma" | `control-plane/probe.mjs` |
| **WS client** | Cliente WebSocket do web-mode (`readResult v3`) usado pelo control-plane | "falar com o engine" | `control-plane/ws-client.mjs` · `ws-cli.mjs` |

---

## Regra de ouro: heterogêneo em paralelo dá race

A rota é um **estado global** que o hook flipa por launch. Logo:

- Subagentes que precisam de cérebros **diferentes** → lançar **sequencialmente**
  (um por vez; a rota de um não pode vazar pro outro).
- Subagentes com o **mesmo** cérebro em paralelo → ok.
- Sem tag → herda o default; use a tag só quando o subagente **realmente** precisa
  de outro cérebro.

Validação: provado e2e nos 5 providers; 37 modelos probados (`docs/native-hook-e2e.md`,
`docs/smoke-results.md`).

---

## Instalação

O hook é fiado no `.claude/settings.json` (PreToolUse). Ver `docs/global-deploy.md`
para a fiação global no host e `docs/pbroute-directive.txt` para o texto da diretiva
que vai no system prompt do profile (treina o agente a usar a tag por instinto).

> Hooks no Piebald são cacheados na **criação do chat** — mexeu na fiação, abra um
> chat novo (global → restart do app).

---

## Fundação (como foi possível)

Tudo se apoia em três descobertas sobre o `app.db` do Piebald
(`C:/Users/<you>/AppData/Roaming/Piebald/app.db`), documentadas em `docs/`:

1. **Roteamento de subagente é persistido** — `subagent_provider_id` / `model` /
   `profile_id` ficam no banco; o hook escreve neles antes do subagente nascer.
2. **Profiles vivem no banco** (`profiles` → `generation_configs` →
   `override_gen_cfg_data.system_prompt` + effort por engine) — daí `profiles.mjs`
   poder criá-los/editá-los programaticamente.
3. **O web-mode expõe um WebSocket** autenticado para comandos do engine.

Regras de acesso ao `app.db`: `mode=ro` sempre (o Piebald é o único writer); **não**
usar `immutable=1` para dados ao vivo (ignora o WAL → stale); janela de ~48h; queries
com `LIMIT`. Schema completo em `docs/app-db.md`.

---

## Roadmap / em aberto

- **Melhorar a malha de roteamento** subagente ↔ provider ↔ modelo ↔ profile: hoje a
  rota é um estado global sequencial; o ideal é roteamento por-launch sem race.
- Pitch ao upstream: **API/campo oficial de roteamento por subagente** (equivalente
  ao `model:` do frontmatter do Claude Code), que tornaria o hook desnecessário.

---

## Layout

```
piebald-dynamic-subagents/
├── README.md
├── hooks/
│   ├── pretooluse-route.mjs / .cmd     # o hook de roteamento JIT (+ guard A1/A2)
│   └── route.log                       # trilha de roteamento (runtime)
├── control-plane/
│   ├── catalog.json                    # providers/modelos/profiles (ao vivo)
│   ├── discover-models.mjs             # regenera o catálogo
│   ├── profiles.mjs                    # CRUD de Profiles via API
│   ├── probe.mjs                       # valida worker real
│   ├── pbroute-baseline.json           # baseline do changes-guard
│   ├── orchestrate.mjs                 # orquestração de launches
│   └── ws-client.mjs / ws-cli.mjs      # cliente WebSocket (readResult v3)
├── docs/
│   ├── native-hook-e2e.md              # prova e2e (5 providers)
│   ├── smoke-results.md                # 37 modelos probados
│   ├── pbroute-directive.txt           # texto da diretiva (system prompt)
│   ├── global-deploy.md                # fiação do hook no host
│   ├── app-db.md                       # schema do app.db (fundação)
│   └── websocket-protocol.md           # protocolo WS do web-mode (fundação)
└── examples/
    ├── queries.sql                     # SQL de referência
    └── python-client.py                # leitura app.db + WebSocket
```
