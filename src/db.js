'use strict';

const crypto = require('crypto');
const config = require('./config');

function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function todayStart() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SQLITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
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
  )`,
  `CREATE TABLE IF NOT EXISTS trades (
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
  )`,
  'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)',
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

const PG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    account_type TEXT NOT NULL,
    login TEXT NOT NULL,
    server TEXT,
    password_enc TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    equity DOUBLE PRECISION NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    connected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    stop_loss DOUBLE PRECISION NOT NULL,
    take_profit DOUBLE PRECISION NOT NULL,
    lot DOUBLE PRECISION NOT NULL,
    risk_amount DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    broker_order_id TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    close_price DOUBLE PRECISION,
    pnl DOUBLE PRECISION,
    result TEXT,
    chart_path TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)',
  `CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function normalizeRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of ['balance', 'equity', 'entry_price', 'stop_loss', 'take_profit', 'lot',
    'risk_amount', 'confidence', 'close_price', 'pnl']) {
    if (out[key] !== null && out[key] !== undefined) out[key] = Number(out[key]);
  }
  if (out.id !== null && out.id !== undefined) out.id = String(out.id);
  return out;
}

class Database {
  constructor(options = {}) {
    this.connectionString = options.connectionString ?? config.DATABASE_URL;
    this.path = options.path ?? config.DATABASE_PATH;
    this.driver = this.connectionString ? 'postgres' : 'sqlite';
    this.pool = null;
    this.sqlite = null;
  }

  async init() {
    if (this.driver === 'postgres') {
      const { Pool } = require('pg');
      const needsSsl = /sslmode=require/i.test(this.connectionString) ||
        String(process.env.PGSSL || '').toLowerCase() === 'true';
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        max: 8,
      });
      for (const statement of PG_SCHEMA) await this.pool.query(statement);
    } else {
      const BetterSqlite3 = require('better-sqlite3');
      this.sqlite = new BetterSqlite3(this.path);
      this.sqlite.pragma('journal_mode = WAL');
      for (const statement of SQLITE_SCHEMA) this.sqlite.exec(statement);
    }
    return this;
  }

  async close() {
    if (this.pool) await this.pool.end();
    if (this.sqlite) this.sqlite.close();
  }

  async all(sql, params = []) {
    if (this.driver === 'postgres') {
      const result = await this.pool.query(toPgPlaceholders(sql), params);
      return result.rows.map(normalizeRow);
    }
    return this.sqlite.prepare(sql).all(...params).map(normalizeRow);
  }

  async run(sql, params = []) {
    if (this.driver === 'postgres') {
      return this.pool.query(toPgPlaceholders(sql), params);
    }
    return this.sqlite.prepare(sql).run(...params);
  }

  // ---------- accounts ----------
  async upsertAccount(platform, accountType, login, server, passwordEnc, balance = null) {
    const existing = await this.all(
      'SELECT * FROM accounts WHERE platform=? AND account_type=? AND login=?',
      [platform, accountType, login],
    );
    const now = utcnow();
    if (existing.length) {
      const acc = existing[0];
      await this.run(
        "UPDATE accounts SET server=?, password_enc=?, status='connected', balance=COALESCE(?, balance), " +
        'equity=COALESCE(?, equity), connected_at=?, updated_at=? WHERE id=?',
        [server, passwordEnc, balance, balance, now, now, acc.id],
      );
      return this.getAccount(acc.id);
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    const bal = Number(balance || 0);
    await this.run(
      'INSERT INTO accounts (id,platform,account_type,login,server,password_enc,status,balance,equity,' +
      "currency,connected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'connected',?,?,'USD',?,?,?)",
      [id, platform, accountType, login, server, passwordEnc, bal, bal, now, now, now],
    );
    return this.getAccount(id);
  }

  async getAccount(accountId) {
    const rows = await this.all('SELECT * FROM accounts WHERE id=?', [accountId]);
    return rows[0] || null;
  }

  async latestAccount(platform = null, accountType = null) {
    let sql = 'SELECT * FROM accounts WHERE 1=1';
    const params = [];
    if (platform) { sql += ' AND platform=?'; params.push(platform); }
    if (accountType) { sql += ' AND account_type=?'; params.push(accountType); }
    sql += ' ORDER BY updated_at DESC LIMIT 1';
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async setAccountStatus(accountId, status, balance = null) {
    if (balance === null || balance === undefined) {
      await this.run('UPDATE accounts SET status=?, updated_at=? WHERE id=?', [status, utcnow(), accountId]);
    } else {
      await this.run(
        'UPDATE accounts SET status=?, balance=?, equity=?, updated_at=? WHERE id=?',
        [status, balance, balance, utcnow(), accountId],
      );
    }
  }

  // ---------- trades ----------
  async createTrade(data) {
    const id = data.id || crypto.randomUUID().replace(/-/g, '');
    await this.run(
      'INSERT INTO trades (id,account_id,platform,symbol,timeframe,side,entry_price,stop_loss,take_profit,' +
      'lot,risk_amount,confidence,reason,status,broker_order_id,opened_at,chart_path) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id, data.account_id, data.platform, data.symbol, data.timeframe, data.side,
        data.entry_price, data.stop_loss, data.take_profit, data.lot, data.risk_amount,
        data.confidence || 0, data.reason || '', data.status || 'OPEN',
        data.broker_order_id || '', data.opened_at || utcnow(), data.chart_path || '',
      ],
    );
    return this.getTrade(id);
  }

  async getTrade(tradeId) {
    const rows = await this.all('SELECT * FROM trades WHERE id=?', [tradeId]);
    return rows[0] || null;
  }

  async updateTradeChart(tradeId, chartPath) {
    await this.run('UPDATE trades SET chart_path=? WHERE id=?', [chartPath, tradeId]);
  }

  async closeTrade(tradeId, closePrice, pnl, result) {
    await this.run(
      "UPDATE trades SET status='CLOSED', close_price=?, pnl=?, result=?, closed_at=? WHERE id=?",
      [closePrice, pnl, result, utcnow(), tradeId],
    );
    return this.getTrade(tradeId);
  }

  async openTrades(accountId = null) {
    if (accountId) {
      return this.all("SELECT * FROM trades WHERE status='OPEN' AND account_id=? ORDER BY opened_at DESC", [accountId]);
    }
    return this.all("SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC");
  }

  async recentTrades(limit = 50) {
    return this.all('SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?', [limit]);
  }

  async tradesToday(accountId) {
    return this.all(
      'SELECT * FROM trades WHERE account_id=? AND opened_at>=? ORDER BY opened_at DESC',
      [accountId, todayStart()],
    );
  }

  async closedToday(accountId) {
    return this.all(
      "SELECT * FROM trades WHERE account_id=? AND status='CLOSED' AND closed_at>=?",
      [accountId, todayStart()],
    );
  }

  // ---------- settings ----------
  async getSetting(key, defaultValue = null) {
    const rows = await this.all('SELECT value FROM settings WHERE key=?', [key]);
    if (!rows.length) return defaultValue;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return rows[0].value;
    }
  }

  async setSetting(key, value) {
    await this.run(
      'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, JSON.stringify(value)],
    );
  }

  // ---------- logs ----------
  async addLog(level, category, message, meta = null) {
    await this.run(
      'INSERT INTO logs (level,category,message,meta,created_at) VALUES (?,?,?,?,?)',
      [level, category, String(message).slice(0, 2000), JSON.stringify(meta || {}), utcnow()],
    );
  }

  async recentLogs(limit = 100) {
    return this.all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', [limit]);
  }

  async purgeOldLogs(days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    await this.run('DELETE FROM logs WHERE created_at<?', [cutoff]);
  }
}

module.exports = { Database, utcnow, todayStart };
