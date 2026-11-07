import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    account_type TEXT NOT NULL,
    login TEXT NOT NULL,
    server TEXT,
    password_enc TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    balance REAL NOT NULL DEFAULT 0,
    equity REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    connected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    take_profit REAL NOT NULL,
    lot REAL NOT NULL,
    risk_amount REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    broker_order_id TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_price REAL,
    pnl REAL,
    result TEXT,
    chart_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path=None):
        self.path = str(path or config.DATABASE_PATH)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    def _exec(self, sql: str, params: tuple = ()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            cur = self._conn.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    # ---------- accounts ----------
    def upsert_account(self, platform, account_type, login, server, password_enc, balance=None):
        existing = self._query(
            "SELECT * FROM accounts WHERE platform=? AND account_type=? AND login=?",
            (platform, account_type, login),
        )
        now = utcnow()
        if existing:
            acc = existing[0]
            self._exec(
                "UPDATE accounts SET server=?, password_enc=?, status='connected', balance=COALESCE(?, balance),"
                " equity=COALESCE(?, equity), connected_at=?, updated_at=? WHERE id=?",
                (server, password_enc, balance, balance, now, now, acc["id"]),
            )
            return self.get_account(acc["id"])
        acc_id = uuid.uuid4().hex
        bal = float(balance if balance is not None else 0)
        self._exec(
            "INSERT INTO accounts (id,platform,account_type,login,server,password_enc,status,balance,equity,"
            "currency,connected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'connected',?,?,'USD',?,?,?)",
            (acc_id, platform, account_type, login, server, password_enc, bal, bal, now, now, now),
        )
        return self.get_account(acc_id)

    def get_account(self, account_id):
        rows = self._query("SELECT * FROM accounts WHERE id=?", (account_id,))
        return rows[0] if rows else None

    def latest_account(self, platform=None, account_type=None):
        sql = "SELECT * FROM accounts WHERE 1=1"
        params: list[Any] = []
        if platform:
            sql += " AND platform=?"
            params.append(platform)
        if account_type:
            sql += " AND account_type=?"
            params.append(account_type)
        sql += " ORDER BY updated_at DESC LIMIT 1"
        rows = self._query(sql, tuple(params))
        return rows[0] if rows else None

    def set_account_status(self, account_id, status, balance=None):
        if balance is None:
            self._exec("UPDATE accounts SET status=?, updated_at=? WHERE id=?", (status, utcnow(), account_id))
        else:
            self._exec(
                "UPDATE accounts SET status=?, balance=?, equity=?, updated_at=? WHERE id=?",
                (status, balance, balance, utcnow(), account_id),
            )

    def update_balance(self, account_id, delta):
        self._exec(
            "UPDATE accounts SET balance=balance+?, equity=balance+?, updated_at=? WHERE id=?",
            (delta, delta, utcnow(), account_id),
        )

    # ---------- trades ----------
    def create_trade(self, **kw) -> dict:
        trade_id = kw.get("id") or uuid.uuid4().hex
        self._exec(
            "INSERT INTO trades (id,account_id,platform,symbol,timeframe,side,entry_price,stop_loss,take_profit,"
            "lot,risk_amount,confidence,reason,status,broker_order_id,opened_at,chart_path) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                trade_id, kw["account_id"], kw["platform"], kw["symbol"], kw["timeframe"], kw["side"],
                kw["entry_price"], kw["stop_loss"], kw["take_profit"], kw["lot"], kw["risk_amount"],
                kw.get("confidence", 0), kw.get("reason", ""), kw.get("status", "OPEN"),
                kw.get("broker_order_id", ""), kw.get("opened_at", utcnow()), kw.get("chart_path", ""),
            ),
        )
        return self.get_trade(trade_id)

    def get_trade(self, trade_id):
        rows = self._query("SELECT * FROM trades WHERE id=?", (trade_id,))
        return rows[0] if rows else None

    def update_trade_chart(self, trade_id, chart_path):
        self._exec("UPDATE trades SET chart_path=? WHERE id=?", (chart_path, trade_id))

    def close_trade(self, trade_id, close_price, pnl, result):
        self._exec(
            "UPDATE trades SET status='CLOSED', close_price=?, pnl=?, result=?, closed_at=? WHERE id=?",
            (close_price, pnl, result, utcnow(), trade_id),
        )
        return self.get_trade(trade_id)

    def open_trades(self, account_id=None, platform=None):
        sql = "SELECT * FROM trades WHERE status='OPEN'"
        params: list[Any] = []
        if account_id:
            sql += " AND account_id=?"
            params.append(account_id)
        if platform:
            sql += " AND platform=?"
            params.append(platform)
        sql += " ORDER BY opened_at DESC"
        return self._query(sql, tuple(params))

    def recent_trades(self, limit=50, platform=None):
        sql = "SELECT * FROM trades"
        params: list[Any] = []
        if platform:
            sql += " WHERE platform=?"
            params.append(platform)
        sql += " ORDER BY opened_at DESC LIMIT ?"
        params.append(limit)
        return self._query(sql, tuple(params))

    def trades_today(self, account_id):
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        return self._query(
            "SELECT * FROM trades WHERE account_id=? AND opened_at>=? ORDER BY opened_at DESC",
            (account_id, start),
        )

    def closed_today(self, account_id):
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        return self._query(
            "SELECT * FROM trades WHERE account_id=? AND status='CLOSED' AND closed_at>=?",
            (account_id, start),
        )

    # ---------- settings ----------
    def get_setting(self, key, default=None):
        rows = self._query("SELECT value FROM settings WHERE key=?", (key,))
        if not rows:
            return default
        try:
            return json.loads(rows[0]["value"])
        except (json.JSONDecodeError, TypeError):
            return rows[0]["value"]

    def set_setting(self, key, value):
        self._exec(
            "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )

    # ---------- logs ----------
    def add_log(self, level, category, message, meta=None):
        self._exec(
            "INSERT INTO logs (level,category,message,meta,created_at) VALUES (?,?,?,?,?)",
            (level, category, message[:2000], json.dumps(meta or {}, ensure_ascii=False), utcnow()),
        )

    def recent_logs(self, limit=100):
        return self._query("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,))

    def purge_old_logs(self, days=14):
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        self._exec("DELETE FROM logs WHERE created_at<?", (cutoff,))


db = Database()
