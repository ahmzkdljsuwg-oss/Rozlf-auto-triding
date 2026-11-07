'use strict';

process.env.REAL_TRADING_APPROVED = 'false';
process.env.MT5_ENABLED = 'false';
process.env.ALLOW_SIMULATED_MT5 = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/db');
const { TradingEngine } = require('../src/engine');
const { TelegramNotifier } = require('../src/telegram');
const { createApp } = require('../src/app');
const { MarketScanner } = require('../src/scanner');
const { CATALOG, CATEGORIES } = require('../src/market-catalog');
const { FakeMarket } = require('./helpers');

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-scan-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const market = new FakeMarket();
  const engine = await new TradingEngine({
    db, market, telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  fs.mkdirSync(path.join(dir, 'charts'), { recursive: true });
  const app = createApp({ engine });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await engine.stop(null);
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, engine, market };
}

async function call(base, route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body };
}

test('scanner covers the full catalog without inventing OTC or Smarty', () => {
  const scanner = new MarketScanner({ market: new FakeMarket() });
  const status = scanner.status();
  assert.equal(status.scan.total, CATALOG.length);
  assert.equal(status.categories.length, CATEGORIES.length);
  assert.equal(status.execution.can_trade, false);
  assert.equal(status.execution.official_integration, false);
  assert.equal(status.expertoption_assets.otc_smarty_available, false);
  assert.equal(status.expertoption_assets.discovered_from_account, false);
  assert.equal(status.source.kind, 'public_reference');
  assert.equal(status.source.account_session_data, false);
  assert.equal(status.connection.verified, false);
  assert.ok(status.categories.find((c) => c.id === 'otc').unavailable_reason);
  assert.ok(status.categories.find((c) => c.id === 'smarty').unavailable_reason);
  assert.equal(status.markets.filter((r) => r.category === 'otc').length, 0);
  assert.equal(status.markets.filter((r) => r.category === 'smarty').length, 0);
});

test('scanNow reads every catalog market and never fabricates a price', async () => {
  const market = new FakeMarket({ failSymbols: ['AAPL'], staleSymbols: ['TSLA'] });
  const scanner = new MarketScanner({ market, concurrency: 4 });
  const status = await scanner.scanNow();
  assert.equal(status.scan.running, false);
  assert.equal(status.scan.scanned, CATALOG.length);
  assert.equal(status.scan.failed, 1);
  assert.equal(status.scan.stale, 1);
  const aapl = status.markets.find((r) => r.symbol === 'AAPL');
  const tsla = status.markets.find((r) => r.symbol === 'TSLA');
  assert.equal(aapl.status, 'unavailable');
  assert.equal(aapl.price, null);
  assert.equal(tsla.status, 'stale');
  assert.equal(tsla.price, null);
  const eurusd = status.markets.find((r) => r.symbol === 'EURUSD');
  assert.ok(Number(eurusd.price) > 0);
  assert.equal(eurusd.broker_verified, false);
  // Every row must carry a signal and a numeric strength, even NO TRADE.
  for (const row of status.markets) {
    assert.ok(['BUY', 'SELL', 'NO TRADE'].includes(row.signal));
    assert.ok(Number.isFinite(row.strength));
  }
});

test('opportunities are ranked by confidence and only qualified rows pass', () => {
  const scanner = new MarketScanner({ market: new FakeMarket() });
  const boost = (symbol, extra) => {
    const base = scanner.rows.get(symbol);
    scanner.rows.set(symbol, { ...base, status: 'qualified', signal: 'BUY', ...extra });
  };
  boost('EURUSD', { confidence: 0.71, adx: 30, strength: 71 });
  boost('XAUUSD', { confidence: 0.88, adx: 22, strength: 88 });
  boost('USDJPY', { confidence: 0.88, adx: 34, strength: 88, signal: 'SELL' });
  scanner.rows.set('GBPUSD', { ...scanner.rows.get('GBPUSD'), confidence: 0.99 });
  const opportunities = scanner.opportunities();
  assert.equal(opportunities.length, 3);
  assert.equal(opportunities[0].symbol, 'USDJPY');
  assert.equal(opportunities[1].symbol, 'XAUUSD');
  assert.equal(opportunities[2].symbol, 'EURUSD');
});

test('scanner API is analysis-only on ExpertOption and blocked elsewhere', async (t) => {
  const { base, engine } = await boot(t);
  const before = await call(base, '/api/scanner/scan', { method: 'POST', body: { continuous: false } });
  assert.equal(before.status, 409);
  assert.equal((await call(base, '/api/scanner/trade', { method: 'POST' })).status, 403);

  const connect = await call(base, '/api/connect', {
    method: 'POST',
    body: { platform: 'expertoption', account_type: 'demo', login: 'demo@example.com', session_token: 'x' },
  });
  assert.equal(connect.status, 200);
  assert.equal(connect.body.analysis_only, true);

  const scanner = await call(base, '/api/scanner');
  assert.equal(scanner.status, 200);
  assert.equal(scanner.body.scan.total, CATALOG.length);
  assert.equal(scanner.body.execution.can_trade, false);

  await engine.scanner.scanNow();
  const scanned = await call(base, '/api/scanner');
  assert.equal(scanned.body.scan.scanned, CATALOG.length);
  assert.ok(scanned.body.markets.every((r) => r.price === null || r.price > 0));

  const stop = await call(base, '/api/scanner/stop', { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.auto, false);

  const trade = await call(base, '/api/scanner/trade', { method: 'POST' });
  assert.equal(trade.status, 403);
  assert.equal(trade.body.can_trade, false);
  assert.match(trade.body.detail, /approved trading API/);
});

test('ExpertOption session never reports a token as a verified connection', async () => {
  const { ExpertOptionSession } = require('../src/expertoption-session');
  const session = new ExpertOptionSession({ login: 'demo@example.com', tokenPresent: true });
  const before = session.status();
  assert.equal(before.connection_state, 'token_saved_unverified');
  assert.equal(before.connected, false);
  assert.equal(before.verified, false);
  assert.equal(before.official_api_available, false);
  const after = await session.verify();
  assert.equal(after.verified, false);
  await assert.rejects(() => session.markets(), /documented API/);
  await assert.rejects(() => session.candles(), /documented API/);
  await assert.rejects(() => session.accountInfo(), /documented API/);
});
