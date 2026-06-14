"""
python-client.py — Cliente Python para Piebald app.db + WebSocket
piebald-dynamic-subagents

Dois módulos principais:
  - PiebaldDB    : leitura read-only do app.db (quota, config, chats)
  - PiebaldWS    : cliente WebSocket para o piebald-web.exe

Dependências:
  - Python 3.12+
  - websockets >= 16.0  (pip install websockets)
  - sqlite3             (stdlib)

Uso rápido:
  python python-client.py quota           → painel de quota
  python python-client.py inject "texto"  → injeta no chat ativo (requer PIEBALD_WEB_TOKEN)
  python python-client.py info            → config/providers/chat ativo
"""

import argparse
import asyncio
import json
import os
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Constantes
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_DB   = "C:/Users/<you>/AppData/Roaming/Piebald/app.db"
DEFAULT_PORT = 7000

# ─────────────────────────────────────────────────────────────────────────────
# PiebaldDB — leitura do SQLite
# ─────────────────────────────────────────────────────────────────────────────

class PiebaldDB:
    """
    Acesso read-only ao Piebald app.db.

    Regras:
      - Sempre abrir com mode=ro
      - NUNCA usar immutable=1 para dados ao vivo (quota, requests recentes)
        → immutable=1 ignora o WAL e retorna valores stale
      - immutable=1 é OK para settings/providers (tabelas estáticas)
    """

    def __init__(self, db_path: str = DEFAULT_DB, *, static: bool = False):
        """
        db_path : caminho para o app.db
        static  : se True, adiciona immutable=1 (só para settings/providers)
        """
        self.db_path = db_path
        suffix = "&immutable=1" if static else ""
        self._uri = f"file:{db_path}?mode=ro{suffix}"

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self._uri, uri=True)

    # ── Quota ─────────────────────────────────────────────────────────────────

    def get_header(self, header_name: str) -> Optional[tuple[str, str]]:
        """
        Retorna (value, created_at) do header de response mais recente
        com o nome dado. Retorna None se não encontrado.
        """
        sql = """
            SELECT hh.value, r.created_at
            FROM http_headers hh
            JOIN http_requests r ON r.id = hh.http_request_id
            WHERE hh.is_request = 0
              AND lower(hh.name) = lower(?)
            ORDER BY r.created_at DESC
            LIMIT 1
        """
        with self._conn() as conn:
            row = conn.execute(sql, (header_name,)).fetchone()
        return (row[0], row[1]) if row else None

    def get_headers_matching(self, pattern: str) -> list[dict]:
        """
        Retorna lista de {name, value, as_of} para headers de response
        cujo nome contém o padrão (LIKE), pegando o mais recente de cada nome.
        """
        sql = """
            SELECT lower(hh.name) AS name, hh.value, r.created_at AS as_of
            FROM http_headers hh
            JOIN http_requests r ON r.id = hh.http_request_id
            WHERE hh.is_request = 0
              AND lower(hh.name) LIKE lower(?)
              AND r.id = (
                SELECT r2.id FROM http_requests r2
                JOIN http_headers hh2 ON hh2.http_request_id = r2.id
                WHERE hh2.is_request = 0
                  AND lower(hh2.name) LIKE lower(?)
                ORDER BY r2.created_at DESC
                LIMIT 1
              )
            ORDER BY hh.header_index
        """
        with self._conn() as conn:
            rows = conn.execute(sql, (pattern, pattern)).fetchall()
        return [{"name": r[0], "value": r[1], "as_of": r[2]} for r in rows]

    def quota_claude(self) -> dict:
        """
        Retorna dict com os headers de quota do Claude (anthropic-ratelimit-unified-*).
        Retorna {} se não houver chamadas recentes ao Claude via Piebald.
        """
        rows = self.get_headers_matching("anthropic-ratelimit%")
        if not rows:
            return {}
        result = {"as_of": rows[0]["as_of"]}
        for r in rows:
            key = r["name"].replace("anthropic-ratelimit-unified-", "")
            result[key] = r["value"]
        return result

    def quota_codex(self) -> dict:
        """
        Retorna dict com os headers de quota do Codex (x-codex-*).
        Retorna {} se não houver chamadas recentes ao Codex via Piebald.
        """
        rows = self.get_headers_matching("x-codex-%")
        if not rows:
            return {}
        result = {"as_of": rows[0]["as_of"]}
        for r in rows:
            key = r["name"].replace("x-codex-", "")
            result[key] = r["value"]
        return result

    def discover_ratelimit_headers(self) -> list[str]:
        """
        Descobre todos os headers de response que parecem ser rate-limit,
        de qualquer provider, nas últimas 48h.
        """
        sql = """
            SELECT DISTINCT lower(hh.name)
            FROM http_headers hh
            JOIN http_requests r ON r.id = hh.http_request_id
            WHERE hh.is_request = 0
              AND r.created_at > datetime('now', '-48 hours')
              AND (
                lower(hh.name) LIKE '%ratelimit%'
                OR lower(hh.name) LIKE '%rate-limit%'
                OR lower(hh.name) LIKE '%quota%'
                OR lower(hh.name) LIKE '%retry-after%'
                OR lower(hh.name) LIKE 'x-codex-%'
              )
            ORDER BY 1
        """
        with self._conn() as conn:
            return [r[0] for r in conn.execute(sql).fetchall()]

    # ── Config (static = True recomendado) ────────────────────────────────────

    def get_settings(self, keys: list[str] | None = None) -> dict:
        """
        Lê a tabela settings. Se keys fornecidas, filtra por elas.
        Usar PiebaldDB(static=True) para leitura de config.
        """
        if keys:
            placeholders = ",".join("?" * len(keys))
            sql = f"SELECT key, value FROM settings WHERE key IN ({placeholders})"
            with self._conn() as conn:
                rows = conn.execute(sql, keys).fetchall()
        else:
            with self._conn() as conn:
                rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return dict(rows)

    def get_providers(self) -> list[dict]:
        """Lista os providers configurados."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, name, provider_type FROM providers ORDER BY id"
            ).fetchall()
        return [{"id": r[0], "name": r[1], "type": r[2]} for r in rows]

    # ── Chats/mensagens (para wake injection) ─────────────────────────────────

    def get_active_chat_id(self) -> Optional[int]:
        """
        Retorna o ID do chat ativo mais recente (não deletado, não subagente).
        Retorna None se nenhum chat encontrado.
        """
        sql = """
            SELECT id FROM chats
            WHERE is_deleted = 0
              AND subagent_parent_chat_id IS NULL
            ORDER BY last_activity_at DESC
            LIMIT 1
        """
        with self._conn() as conn:
            row = conn.execute(sql).fetchone()
        return int(row[0]) if row else None

    def get_last_message_id(self, chat_id: int) -> Optional[int]:
        """
        Retorna o MAX(id) de messages WHERE parent_chat_id = chat_id.
        Retorna None se o chat não tem mensagens (novo chat).
        """
        sql = "SELECT MAX(id) FROM messages WHERE parent_chat_id = ?"
        with self._conn() as conn:
            row = conn.execute(sql, (chat_id,)).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def get_recent_chats(self, limit: int = 10) -> list[dict]:
        """Lista chats recentes com last_message_id resolvido."""
        sql = """
            SELECT
              c.id, c.title, c.last_activity_at,
              (SELECT MAX(m.id) FROM messages m WHERE m.parent_chat_id = c.id) AS last_msg_id
            FROM chats c
            WHERE c.is_deleted = 0
              AND c.subagent_parent_chat_id IS NULL
            ORDER BY c.last_activity_at DESC
            LIMIT ?
        """
        with self._conn() as conn:
            rows = conn.execute(sql, (limit,)).fetchall()
        return [
            {"id": r[0], "title": r[1], "last_activity_at": r[2], "last_message_id": r[3]}
            for r in rows
        ]

    # ── Traffic stats ──────────────────────────────────────────────────────────

    def traffic_by_provider(self, hours: int = 24) -> list[dict]:
        """Distribuição de chamadas de chat_message por provider."""
        sql = """
            SELECT
              CASE
                WHEN url LIKE '%anthropic.com%'        THEN 'claude'
                WHEN url LIKE '%openai.com%'            THEN 'codex'
                WHEN url LIKE '%daily-cloudcode-pa%'    THEN 'agy'
                WHEN url LIKE '%googleapis.com%'        THEN 'gemini'
                ELSE 'outros'
              END AS provider,
              COUNT(*) AS calls,
              ROUND(AVG(resp.response_time_ms)) AS avg_ms,
              COUNT(CASE WHEN resp.status_code >= 400 THEN 1 END) AS errors
            FROM http_requests r
            JOIN http_responses resp ON resp.http_request_id = r.id
            WHERE r.request_type = 'chat_message'
              AND r.created_at > datetime('now', ?)
            GROUP BY provider
            ORDER BY calls DESC
        """
        interval = f"-{hours} hours"
        with self._conn() as conn:
            rows = conn.execute(sql, (interval,)).fetchall()
        return [
            {"provider": r[0], "calls": r[1], "avg_ms": r[2], "errors": r[3]}
            for r in rows
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de formatação
# ─────────────────────────────────────────────────────────────────────────────

def _rel_epoch(epoch_str: str) -> str:
    """Converte epoch string → 'in Xh Ym' ou '(passed)'."""
    try:
        delta = int(epoch_str) - int(time.time())
        if delta <= 0:
            return "(passed)"
        if delta < 3600:
            return f"in {delta//60}m"
        if delta < 86400:
            return f"in {delta//3600}h {(delta%3600)//60}m"
        return f"in {delta//86400}d {delta%86400//3600}h"
    except (ValueError, TypeError):
        return "?"


def _rel_secs(secs_str: str) -> str:
    """Converte string de segundos → 'Xh Ym' ou 'Xd Yh'."""
    try:
        s = int(secs_str)
        if s < 3600:
            return f"{s}s"
        if s < 86400:
            return f"{s//3600}h {(s%3600)//60}m"
        return f"{s//86400}d {s%86400//3600}h"
    except (ValueError, TypeError):
        return "?"


def _pct(val_str: str) -> str:
    """Converte float 0..1 string → 'XX.X%'."""
    try:
        return f"{float(val_str)*100:.1f}%"
    except (ValueError, TypeError):
        return "?"


# ─────────────────────────────────────────────────────────────────────────────
# PiebaldWS — cliente WebSocket
# ─────────────────────────────────────────────────────────────────────────────

try:
    import websockets
    _WS_AVAILABLE = True
except ImportError:
    _WS_AVAILABLE = False


class PiebaldWS:
    """
    Cliente para o WebSocket do piebald-web.exe.

    Endpoint: ws://127.0.0.1:<port>/api/ws?token=<TOKEN>
    Token rotaciona a cada relaunch do piebald-web.exe.
    NUNCA imprimir ou logar o token.

    Exit semantics quando usado via CLI:
      0 = sucesso
      2 = token/text faltando
      3 = auth rejeitado (token stale)
      4 = comando rejeitado pelo server
      5 = chat não encontrado
    """

    def __init__(self, token: str, port: int = DEFAULT_PORT, timeout: int = 15):
        if not _WS_AVAILABLE:
            raise ImportError("websockets package not installed. pip install websockets")
        self.token = token
        self.port = port
        self.timeout = timeout
        # URI nunca é imprimida — apenas usada internamente
        self._uri = f"ws://127.0.0.1:{port}/api/ws?token={token}"

    def _build_frame(self, cmd_id: int, chat_id: int, text: str,
                     parent_message_id: Optional[int]) -> dict:
        """
        Constrói o frame send_message_streaming.
        Schema capturado ao vivo em 2026-06-02 — não simplificar a estrutura aninhada.
        """
        request = {
            "chat_id": chat_id,
            "parts": [
                {
                    "type": "text",
                    "text": {
                        "nodes": [
                            {
                                "type": "text",
                                "data": {"content": text}
                            }
                        ]
                    }
                }
            ],
            "branching_intended": False,  # SEMPRE False para wake autônomo
        }
        if parent_message_id is not None:
            request["parent_message_id"] = parent_message_id
        return {"msg": "command", "id": cmd_id, "name": "send_message_streaming",
                "request": request}

    async def _send_message(self, chat_id: int, text: str,
                             parent_message_id: Optional[int]) -> None:
        """Conecta, autentica, envia o frame e aguarda a response."""
        deadline = time.monotonic() + self.timeout
        cmd_id   = int(time.time() * 1000) % 1_000_000
        frame    = self._build_frame(cmd_id, chat_id, text, parent_message_id)

        async with websockets.connect(self._uri) as ws:
            # ── Handshake ──────────────────────────────────────────────────────
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    print("ERROR: timeout waiting for web_access_granted", file=sys.stderr)
                    sys.exit(3)
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    print("ERROR: timeout waiting for web_access_granted", file=sys.stderr)
                    sys.exit(3)
                msg = json.loads(raw)
                if msg.get("msg") == "web_access_granted":
                    break
                if msg.get("msg") == "web_access_required":
                    print("ERROR: auth rejected — token stale/invalid", file=sys.stderr)
                    sys.exit(3)
                # outros push events antes do granted → ignorar

            # ── Envio ─────────────────────────────────────────────────────────
            await ws.send(json.dumps(frame))

            # ── Aguarda response ──────────────────────────────────────────────
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    print("ERROR: timeout waiting for command_response", file=sys.stderr)
                    sys.exit(3)
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    print("ERROR: timeout waiting for command_response", file=sys.stderr)
                    sys.exit(3)
                msg = json.loads(raw)
                if (msg.get("msg") == "command_response"
                        and msg.get("id") == cmd_id):
                    if msg.get("success"):
                        return
                    err = msg.get("error", "(no error field)")
                    print(f"ERROR: server rejected command: {err}", file=sys.stderr)
                    sys.exit(4)
                # outros frames → ignorar

    def inject(self, chat_id: int, text: str,
               parent_message_id: Optional[int] = None) -> None:
        """
        Injeta uma mensagem no chat e dispara um novo turno.
        Sincrono — bloqueia até completar ou timeout.
        """
        asyncio.run(self._send_message(chat_id, text, parent_message_id))


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def cmd_quota(args):
    """Exibe painel de quota de Claude e Codex."""
    db = PiebaldDB(args.db)

    print("════════════════════════════════════════════════════════════")
    print(f"  QUOTA — Piebald app.db last-seen")
    print("════════════════════════════════════════════════════════════")

    # Claude
    print("\n  ┌─ CLAUDE ──────────────────────────────────────────────┐")
    c = db.quota_claude()
    if not c:
        print("  │  (sem chamadas Claude recentes via Piebald)")
    else:
        u5 = _pct(c.get("5h-utilization", ""))
        s5 = c.get("5h-status", "?")
        r5 = _rel_epoch(c.get("5h-reset", ""))
        u7 = _pct(c.get("7d-utilization", ""))
        s7 = c.get("7d-status", "?")
        r7 = _rel_epoch(c.get("7d-reset", ""))
        us = _pct(c.get("7d_sonnet-utilization", "")) if "7d_sonnet-utilization" in c else None
        print(f"  │  5h : {u5:>8} used  [{s5:<9}]  resets {r5}")
        print(f"  │  7d : {u7:>8} used  [{s7:<9}]  resets {r7}")
        if us:
            print(f"  │  7d/Sonnet: {us} used")
        print(f"  │  (as of {c.get('as_of', '?')})")
    print("  └───────────────────────────────────────────────────────┘")

    # Codex
    print("\n  ┌─ CODEX ───────────────────────────────────────────────┐")
    cx = db.quota_codex()
    if not cx:
        print("  │  (sem chamadas Codex recentes via Piebald)")
    else:
        pa  = _rel_epoch(cx.get("primary-reset-at", ""))
        ps  = _rel_secs(cx.get("primary-reset-after-seconds", ""))
        sec = _rel_secs(cx.get("secondary-reset-after-seconds", ""))
        lim = cx.get("active-limit", "?")
        unl = cx.get("credits-unlimited", "?")
        pct = cx.get("primary-over-secondary-limit-percent", None)
        print(f"  │  5h  : resets {pa}  (window: {ps})")
        print(f"  │  weekly: {sec} remaining")
        if pct:
            print(f"  │  5h/weekly: {pct}%")
        print(f"  │  plan: {lim:<12}  unlimited: {unl}")
        print(f"  │  (as of {cx.get('as_of', '?')})")
    print("  └───────────────────────────────────────────────────────┘")

    # Auto-discovery
    new_headers = db.discover_ratelimit_headers()
    known = {"anthropic", "codex", "x-codex"}
    extra = [h for h in new_headers
             if not any(h.startswith(k) for k in ["anthropic-ratelimit", "x-codex-"])]
    if extra:
        print(f"\n  ℹ️  Outros headers de rate-limit detectados (novos providers?):")
        for h in extra:
            print(f"      {h}")


def cmd_info(args):
    """Exibe config, providers e chat ativo."""
    db_static = PiebaldDB(args.db, static=True)
    db_live   = PiebaldDB(args.db)

    settings = db_static.get_settings([
        "subagent_model", "subagent_provider_id",
        "default_permission_mode", "api_server_port"
    ])
    providers = db_static.get_providers()
    chats     = db_live.get_recent_chats(5)
    traffic   = db_live.traffic_by_provider(24)

    print("=== Settings ===")
    for k, v in settings.items():
        print(f"  {k} = {v!r}")

    print("\n=== Providers ===")
    for p in providers:
        print(f"  id={p['id']}  {p['name']}  [{p['type']}]")

    print("\n=== Chats recentes (top 5) ===")
    for c in chats:
        title = (c["title"] or "(sem título)")[:50]
        print(f"  id={c['id']}  last_msg={c['last_message_id']}  {title}")
        print(f"      última atividade: {c['last_activity_at']}")

    print("\n=== Traffic últimas 24h (chat_message) ===")
    for t in traffic:
        print(f"  {t['provider']:<12}  calls={t['calls']}  avg={t['avg_ms']}ms  errors={t['errors']}")


def cmd_inject(args):
    """Injeta uma mensagem no chat ativo (ou --chat-id)."""
    token = args.token or os.environ.get("PIEBALD_WEB_TOKEN")
    if not token:
        print("ERROR: fornecer --token ou PIEBALD_WEB_TOKEN", file=sys.stderr)
        sys.exit(2)

    db = PiebaldDB(args.db)

    chat_id = args.chat_id
    if chat_id is None:
        chat_id = db.get_active_chat_id()
        if chat_id is None:
            print("ERROR: nenhum chat ativo encontrado", file=sys.stderr)
            sys.exit(5)
        print(f"Chat ativo: {chat_id}")

    parent_message_id = db.get_last_message_id(chat_id)
    print(f"parent_message_id: {parent_message_id}")

    if args.dry_run:
        ws = PiebaldWS.__new__(PiebaldWS)
        cmd_id = int(time.time() * 1000) % 1_000_000
        frame  = PiebaldWS._build_frame(ws, cmd_id, chat_id, args.text, parent_message_id)
        print(json.dumps(frame, indent=2))
        return

    ws = PiebaldWS(token, port=args.port, timeout=args.timeout)
    ws.inject(chat_id, args.text, parent_message_id)
    print(f"OK: mensagem injetada — chat_id={chat_id}  parent_message_id={parent_message_id}")


def main():
    p = argparse.ArgumentParser(description="Cliente Python para Piebald app.db + WebSocket")
    p.add_argument("--db", default=DEFAULT_DB, help="Caminho para app.db")
    sub = p.add_subparsers(dest="cmd", required=True)

    # quota
    sub.add_parser("quota", help="Exibe painel de quota de Claude e Codex")

    # info
    sub.add_parser("info", help="Exibe config, providers e chats recentes")

    # inject
    inj = sub.add_parser("inject", help="Injeta mensagem no chat ativo")
    inj.add_argument("text", help="Corpo da mensagem")
    inj.add_argument("--token",     default=None)
    inj.add_argument("--chat-id",   type=int, default=None)
    inj.add_argument("--port",      type=int, default=DEFAULT_PORT)
    inj.add_argument("--timeout",   type=int, default=15)
    inj.add_argument("--dry-run",   action="store_true")

    args = p.parse_args()

    dispatch = {"quota": cmd_quota, "info": cmd_info, "inject": cmd_inject}
    dispatch[args.cmd](args)


if __name__ == "__main__":
    main()
