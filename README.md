# piebald-dynamic-subagents

Knowledge base e ponto de partida para construir ferramentas que aproveitam o
tráfego HTTP interno do Piebald — quota em tempo real, routing dinâmico de
subagentes, e injeção autônoma de mensagens.

---

## Descoberta central

O Piebald persiste **todo o tráfego HTTP** que ele faz para providers (Claude,
Codex, Gemini etc.) dentro de um SQLite local em:

```
%USERPROFILE%/AppData/Roaming/Piebald/app.db
```

Isso inclui **headers de rate-limit de resposta** — ou seja, quota de Claude e
Codex é consultável localmente, sem CLI, sem session logs, sem arqueologia.
Basta ler a tabela `http_headers` com `mode=ro`.

Além disso, o `piebald-web.exe` expõe um WebSocket autenticado que aceita
comandos programáticos — incluindo `send_message_streaming`, que injeta uma
mensagem em qualquer chat e dispara um novo turno do modelo.

---

## Estrutura do repositório

```
README.md                    ← este arquivo
docs/
  app-db.md                  ← schema completo do app.db
  http-traffic-types.md      ← request_type values e o que cada um significa
  rate-limit-headers.md      ← headers de rate-limit por provider
  websocket-protocol.md      ← protocolo WebSocket do web-mode (piebald-web.exe)
examples/
  queries.sql                ← SQL de referência para todos os casos de uso
  python-client.py           ← cliente Python: leitura de app.db + WebSocket
schema/
  (reservado para DDL extraído ou anotado em versões futuras)
```

---

## Casos de uso típicos

| Objetivo | Onde ver |
|---|---|
| Ler quota de Claude/Codex sem CLI | `docs/rate-limit-headers.md` + `examples/queries.sql` |
| Entender o schema do banco | `docs/app-db.md` |
| Ver que tipo de requests o Piebald faz | `docs/http-traffic-types.md` |
| Injetar mensagem num chat automaticamente | `docs/websocket-protocol.md` + `examples/python-client.py` |
| Query "qual provider foi mais chamado hoje?" | `examples/queries.sql` |
| Montar painel pré-run de subagentes | combinar `rate-limit-headers.md` + `python-client.py` |

---

## Regras de ouro ao acessar o app.db

1. **`mode=ro` sempre** — nunca abrir com acesso de escrita. O Piebald é o único writer.
2. **NÃO usar `immutable=1`** para dados ao vivo (headers de quota, requests recentes).
   `immutable=1` ignora o WAL e retorna valores stale.
   `immutable=1` *é* correto para tabelas estáticas de config (`settings`, `providers`).
3. **Janela de ~48h** — o app rotaciona e limpa automaticamente. Nada é eterno.
4. **Sem bloquear** — queries devem ter `LIMIT` e rodar rápido; o Piebald está
   escrevendo continuamente.

---

## Origem do conhecimento

Todo o conteúdo aqui foi adquirido por inspeção direta do banco de dados ao
vivo em `win-work` em 2026-06-02, combinado com análise do binary `piebald-web.exe`
e uma sessão de captura-e-bloqueio do tráfego WebSocket via chrome-devtools.
Não há documentação pública disponível; este repositório *é* a documentação.
