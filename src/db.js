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
    margin_free REAL NOT NULL DEFAULT 0,
    margin_used REAL NOT NULL DEFAULT 0,
    margin_level REAL,
    synced_at TEXT,
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
    chart_path TEXT,
    current_price REAL,
    unrealized_pnl REAL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_broker_order ON trades(account_id, broker_order_id) WHERE broker_order_id <> ''",
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
    margin_free DOUBLE PRECISION NOT NULL DEFAULT 0,
    margin_used DOUBLE PRECISION NOT NULL DEFAULT 0,
    margin_level DOUBLE PRECISION,
    synced_at TEXT,
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
    chart_path TEXT,
    current_price REAL,
    unrealized_pnl REAL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_broker_order ON trades(account_id, broker_order_id) WHERE broker_order_id <> ''",
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
  for (const key of ['balance', 'equity', 'margin_free', 'margin_used', 'margin_level',
    'entry_price', 'stop_loss', 'take_profit', 'lot', 'risk_amount', 'confidence',
    'close_price', 'pnl', 'current_price', 'unrealized_pnl']) {
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
      const pgAdditions = [
        'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS margin_free DOUBLE PRECISION NOT NULL DEFAULT 0',
        'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS margin_used DOUBLE PRECISION NOT NULL DEFAULT 0',
        'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS margin_level DOUBLE PRECISION',
        'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS synced_at TEXT',
        'ALTER TABLE trades ADD COLUMN IF NOT EXISTS current_price DOUBLE PRECISION',
        'ALTER TABLE trades ADD COLUMN IF NOT EXISTS unrealized_pnl DOUBLE PRECISION',
      ];
      for (const statement of pgAdditions) await this.pool.query(statement);
    } else {
      const BetterSqlite3 = require('better-sqlite3');
      this.sqlite = new BetterSqlite3(this.path);
      this.sqlite.pragma('journal_mode = WAL');
      for (const statement of SQLITE_SCHEMA) this.sqlite.exec(statement);
      this.migrateSqlite();
    }
    return this;
  }

  migrateSqlite() {
    const columns = (table) => this.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const accounts = columns('accounts');
    const tradeColumns = columns('trades');
    const additions = [
      ['accounts', 'margin_free', 'REAL NOT NULL DEFAULT 0', accounts],
      ['accounts', 'margin_used', 'REAL NOT NULL DEFAULT 0', accounts],
      ['accounts', 'margin_level', 'REAL', accounts],
      ['accounts', 'synced_at', 'TEXT', accounts],
      ['trades', 'current_price', 'REAL', tradeColumns],
      ['trades', 'unrealized_pnl', 'REAL', tradeColumns],
    ];
    for (const [table, name, type, existing] of additions) {
      if (!existing.includes(name)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
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

  async setAccountSync(accountId, snapshot = {}) {
    await this.run(
      'UPDATE accounts SET status=?, balance=?, equity=?, margin_free=?, margin_used=?, ' +
      'margin_level=?, currency=COALESCE(?, currency), synced_at=?, updated_at=? WHERE id=?',
      [
        snapshot.status || 'connected', Number(snapshot.balance || 0), Number(snapshot.equity || 0),
        Number(snapshot.margin_free || 0), Number(snapshot.margin_used || 0),
        snapshot.margin_level === null || snapshot.margin_level === undefined ? null : Number(snapshot.margin_level),
        snapshot.currency || null, snapshot.synced_at || utcnow(), utcnow(), accountId,
      ],
    );
    return this.getAccount(accountId);
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

  async findOpenTradeByBrokerOrder(accountId, brokerOrderId) {
    if (!brokerOrderId) return null;
    const rows = await this.all(
      "SELECT * FROM trades WHERE account_id=? AND broker_order_id=? AND status='OPEN' LIMIT 1",
      [accountId, String(brokerOrderId)],
    );
    return rows[0] || null;
  }

  async tradeByBrokerOrder(accountId, brokerOrderId) {
    if (!brokerOrderId) return null;
    const rows = await this.all(
      'SELECT * FROM trades WHERE account_id=? AND broker_order_id=? LIMIT 1',
      [accountId, String(brokerOrderId)],
    );
    return rows[0] || null;
  }

  async updateTradeLive(tradeId, currentPrice, unrealizedPnl) {
    await this.run(
      'UPDATE trades SET current_price=?, unrealized_pnl=? WHERE id=? AND status=\'OPEN\'',
      [Number(currentPrice || 0), Number(unrealizedPnl || 0), tradeId],
    );
  }

  async updateTradeStops(tradeId, stopLoss, takeProfit) {
    await this.run('UPDATE trades SET stop_loss=?, take_profit=? WHERE id=?', [stopLoss, takeProfit, tradeId]);
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

  async tradeStats(accountId) {
    const rows = await this.all(
      "SELECT COUNT(*) AS total, " +
      "SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS wins, " +
      "SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) AS losses, " +
      'COALESCE(SUM(pnl),0) AS total_pnl, ' +
      'COALESCE(AVG(pnl),0) AS avg_pnl ' +
      "FROM trades WHERE account_id=? AND status='CLOSED'",
      [accountId],
    );
    const row = rows[0] || {};
    const total = Number(row.total || 0);
    const wins = Number(row.wins || 0);
    const losses = Number(row.losses || 0);
    return {
      total, wins, losses,
      total_pnl: Math.round(Number(row.total_pnl || 0) * 100) / 100,
      avg_pnl: Math.round(Number(row.avg_pnl || 0) * 100) / 100,
      win_rate: total ? Math.round((wins / total) * 1000) / 10 : 0,
    };
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
