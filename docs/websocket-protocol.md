# WebSocket Protocol — piebald-web.exe

O `piebald-web.exe` serve a interface web do Piebald em `http://127.0.0.1:7000`
(porta padrão). O backend **não é REST** — o único ponto de API real é um
WebSocket JSON-RPC.

Todo o conhecimento aqui foi obtido por:
1. Instrumentação do `WebSocket` global via `initScript` no chrome-devtools
2. Sessão de "capture-and-block" (interceptar frame antes de chegar ao backend)
3. Análise strings do binary `piebald-web.exe` (Rust/Rocket)

---

## Endpoint

```
ws://127.0.0.1:<port>/api/ws?token=<TOKEN>
```

| Propriedade | Valor |
|---|---|
| Host | `127.0.0.1` (loopback apenas) |
| Porta padrão | `7000` |
| Override de porta | env `PIEBALD_WEB_PORT` |
| Autenticação | query param `?token=<TOKEN>` |
| Bind | apenas loopback — não exposto na rede |

---

## Token de acesso (web ownership token)

O token é um **"server ownership token"** gerado no lançamento do `piebald-web.exe`.

**Propriedades críticas:**
- Gerado em runtime — **NÃO está armazenado no `app.db`**
- **ROTACIONA a cada relançamento** de `piebald-web.exe`
- Aparece na URL de lançamento: `http://127.0.0.1:7000/?token=<TOKEN>`
- Passar via `--token TOKEN` ou env `PIEBALD_WEB_TOKEN`
- **Nunca imprimir, logar, ou commitar o token**

Se uma conexão falhar com "auth not granted" (exit 3), o token foi rotacionado —
é necessário re-obtê-lo da URL de launch do piebald-web.

---

## Handshake de autenticação

Ao conectar, o servidor envia **imediatamente** um dos dois frames:

| Frame | Significado |
|---|---|
| `{"msg":"web_access_required"}` | Token ausente ou inválido — auth rejeitado |
| `{"msg":"web_access_granted"}` | Auth OK — pode enviar comandos |

**Regra:** aguardar `web_access_granted` antes de enviar qualquer comando.
Outros frames (push events) podem chegar antes do granted — ignorar.

---

## Protocolo de comandos

### Request (client → server)

```json
{
  "msg": "command",
  "id": <int>,
  "name": "<command_name>",
  "request": { ... }
}
```

- `id`: inteiro único para correlacionar response. Sugestão: `int(time.time() * 1000) % 1_000_000`
- `name`: nome do comando (ver §Comandos conhecidos)
- `request`: payload específico do comando

### Response (server → client)

```json
{
  "msg": "command_response",
  "id": <int>,
  "success": true,
  "response": { ... }
}
```

```json
{
  "msg": "command_response",
  "id": <int>,
  "success": false,
  "error": "<mensagem de erro>"
}
```

### Push events (server → client, não solicitados)

```json
{
  "msg": "event",
  "type": "...",
  "data": { ... }
}
```

Push events chegam assincronamente — ao esperar uma `command_response` específica,
filtrar por `msg == "command_response" AND id == <cmd_id>` e ignorar o resto.

---

## Comandos conhecidos

### `send_message_streaming` ⭐ (confirmado via capture-and-block)

Injeta uma mensagem de usuário em um chat e dispara um novo turno do modelo.
Funcionalmente equivalente ao usuário digitar e enviar uma mensagem na UI.

**Request schema exato** (capturado ao vivo 2026-06-02):

```json
{
  "msg": "command",
  "id": 58,
  "name": "send_message_streaming",
  "request": {
    "chat_id": 21,
    "parts": [
      {
        "type": "text",
        "text": {
          "nodes": [
            {
              "type": "text",
              "data": {
                "content": "MENSAGEM AQUI"
              }
            }
          ]
        }
      }
    ],
    "parent_message_id": 520,
    "branching_intended": false
  }
}
```

**Campos:**

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `chat_id` | int | ✅ | ID do chat alvo |
| `parts` | array | ✅ | Sempre 1 elemento para texto simples |
| `parts[0].type` | string | ✅ | Sempre `"text"` |
| `parts[0].text.nodes[0].type` | string | ✅ | Sempre `"text"` |
| `parts[0].text.nodes[0].data.content` | string | ✅ | Corpo da mensagem |
| `parent_message_id` | int | condicional | `MAX(id)` de `messages WHERE parent_chat_id=chat_id`; omitir se o chat não tem mensagens |
| `branching_intended` | bool | ✅ | Sempre `false` para wake autônomo |

**Observações:**
- `branching_intended` é o nome correto — NÃO `branching_initiated`
- A estrutura `parts > text > nodes > data > content` é duplamente aninhada — não simplificar
- O campo é `parent_message_id` (não `parent_chat_id` — esses são diferentes)
- Uma response `success: true` significa que o turno foi aceito; o modelo então processa

### Outros comandos (identificados via instrumentação WebSocket, não testados diretamente)

| Comando | Provável função |
|---|---|
| `get_all_rate_limit_info` | Retorna info de rate-limit de todos os providers (!) |
| `list_providers` | Lista providers configurados |
| `get_chats_with_folders` | Lista chats agrupados por pasta |
| `get_projects` | Lista projetos |
| `get_user_info` | Info do usuário logado |
| `get_settings` | Settings atuais do Piebald |
| `get_subscription` | Info da assinatura |
| `update_chat_draft` | Atualiza rascunho do chat (auto-save) |

> ⚠️ Os nomes de comando **não aparecem como literals no bundle `main-*.js`**
> (são montados em runtime). Para descobrir novos comandos: instrumentar o
> WebSocket global no browser e capturar frames reais da UI.
> Ver `§Como descobrir novos comandos` abaixo.

---

## Verificado ao vivo: end-to-end wake injection (2026-06-02)

Teste realizado:
1. Chat 21 (throwaway), `parent_message_id = 520` (confirmado via `MAX(id)` no `app.db`)
2. Token obtido da URL de launch do `piebald-web.exe`
3. Frame `send_message_streaming` enviado
4. Response: `success: true`
5. Novo turno do modelo iniciado (visível no app.db — nova mensagem de user + row de assistant)
6. O turno do modelo falhou com `HTTP 404` do endpoint `daily-cloudcode-pa.sandbox.googleapis.com`
   (provider `antigravity` com configuração quebrada no chat de teste)

**Conclusão:** o mecanismo de injeção funciona end-to-end. O erro foi de provider
no chat de teste, não do protocolo.

---

## Como descobrir novos comandos

### Método 1: Instrumentação de WebSocket no browser

```javascript
// Executar no DevTools Console com a página do Piebald aberta
const _orig = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed.msg === 'command') {
        console.log('[WS SEND command]', parsed.name, JSON.stringify(parsed.request));
      }
    } catch(e) {}
  }
  return _orig.apply(this, arguments);
};
```

Depois: interagir com a UI normalmente e observar os logs.

### Método 2: Captura via `initScript` (chrome-devtools MCP)

O `chrome-devtools` MCP tem um parâmetro `initScript` que injeta JavaScript
antes da página carregar — permite capturar o handshake completo desde o início.

### Método 3: Capture-and-block

Para capturar o schema exato de um comando sem executá-lo de verdade:
1. Abrir DevTools
2. Injetar interceptor que armazena o frame em `window.__capturedFrames`
3. Realizar a ação na UI
4. Ler `window.__capturedFrames` antes que o frame seja enviado

---

## `wake-inject.py` — cliente implementado

O script `C:\Projects\octo-fullstep-forge\skills\octo-fullstep\scripts\wake-inject.py`
implementa um cliente WebSocket completo para `send_message_streaming`.

**Uso:**
```bash
# Dry-run (sem envio — imprime o frame que seria enviado)
python wake-inject.py --text "mensagem" --dry-run

# Envio real para chat ativo
PIEBALD_WEB_TOKEN=<token> python wake-inject.py --text "mensagem"

# Envio para chat específico
PIEBALD_WEB_TOKEN=<token> python wake-inject.py \
    --text "mensagem" \
    --chat-id 21 \
    --port 7000
```

Exit codes: 0=ok, 2=token/text faltando, 3=auth rejeitado, 4=comando rejeitado, 5=chat não encontrado.

---

## Observações sobre o binary `piebald-web.exe`

- Runtime: **Rust** com framework **Rocket** (HTTP server)
- As rotas `/api/*` são catch-alls do SPA frontend — o único endpoint real é o WebSocket
- O binary tem o parâmetro `--port`
- App versão **0.4.0** (identificado via WebSocket frame de `web_access_granted`)
- Não expõe Swagger/OpenAPI
- A lógica de comandos é construída em runtime — os nomes não aparecem em strings literais
