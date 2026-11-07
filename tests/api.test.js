'use strict';

process.env.DASHBOARD_TOKEN = '';
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
const config = require('../src/config');
const { createApp } = require('../src/app');
const { renderTradeChart } = require('../src/charts');
const { FakeMarket, makeCandles } = require('./helpers');

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-api-'));
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
  return { base, db, engine, dir };
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

test('health, config and auth surface behave', async (t) => {
  const { base } = await boot(t);
  const health = await call(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.app, 'ROZLF AUTO TRADER');

  const config = await call(base, '/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.platforms, ['expertoption', 'mt5']);
  assert.deepEqual(config.body.enabled_account_types, ['demo']);
  assert.equal(config.body.real_trading_approved, false);
  assert.equal(config.body.expertoption_execution, false);
});

test('validation, real-account block and analysis-only ExpertOption', async (t) => {
  const { base } = await boot(t);
  const invalid = await call(base, '/api/connect', { method: 'POST', body: { platform: 'x' } });
  assert.equal(invalid.status, 422);

  const real = await call(base, '/api/connect', {
    method: 'POST',
    body: { platform: 'mt5', account_type: 'real', login: '12345', password: 'secret' },
  });
  assert.equal(real.status, 403);

  const eo = await call(base, '/api/connect', {
    method: 'POST',
    body: { platform: 'expertoption', account_type: 'demo', login: '12345', password: 'secret' },
  });
  assert.equal(eo.status, 200);
  assert.equal(eo.body.account_status, 'analysis');
  assert.equal(eo.body.analysis_only, true);
});

test('demo connect, status, market test, risk and bot controls', async (t) => {
  const { base } = await boot(t);
  const connect = await call(base, '/api/connect', {
    method: 'POST',
    body: { platform: 'mt5', account_type: 'demo', login: '900001', password: 'demo-pass', server: 'demo' },
  });
  assert.equal(connect.status, 200);
  assert.equal(connect.body.execution_mode, 'simulated');
  assert.equal(connect.body.account_type, 'demo');
  assert.equal(connect.body.broker_connected, true);
  assert.equal(connect.body.balance, 10000);
  assert.equal(connect.body.running, false);

  const status = await call(base, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.account_login, '900001');
  assert.ok(Array.isArray(status.body.open_trades));

  const market = await call(base, '/api/market/test', { method: 'POST' });
  assert.equal(market.status, 200);
  assert.equal(market.body.connected, true);
  assert.equal(market.body.results.length, 7);

  const risk = await call(base, '/api/risk');
  assert.equal(risk.status, 200);
  assert.ok(risk.body.risk_percent > 0);

  const badRisk = await call(base, '/api/risk', { method: 'POST', body: { risk_percent: 99 } });
  assert.equal(badRisk.status, 422);

  const goodRisk = await call(base, '/api/risk', { method: 'POST', body: { risk_percent: 0.5, max_open_trades: 2 } });
  assert.equal(goodRisk.status, 200);
  assert.equal(goodRisk.body.risk_percent, 0.5);

  const start = await call(base, '/api/bot/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal(start.body.running, true);
  const stop = await call(base, '/api/bot/stop', { method: 'POST' });
  assert.equal(stop.body.running, false);

  const emergency = await call(base, '/api/bot/emergency', { method: 'POST' });
  assert.equal(emergency.body.emergency, true);
  const blocked = await call(base, '/api/bot/start', { method: 'POST' });
  assert.equal(blocked.status, 400);
  const reset = await call(base, '/api/bot/reset-emergency', { method: 'POST' });
  assert.equal(reset.body.emergency, false);

  const logs = await call(base, '/api/logs?limit=20');
  assert.equal(logs.status, 200);
  assert.ok(logs.body.logs.length > 0);
});

test('stale or failed feeds prevent trading and chart files are served safely', async (t) => {
  const { base, engine, dir } = await boot(t);
  await engine.attachAccount({
    platform: 'mt5', accountType: 'demo', login: '777', password: 'demo-pass',
  });
  engine.market.failSymbols = new Set(['EURUSD']);
  engine.market.staleSymbols = new Set(['GBPUSD']);
  engine.running = true;
  await engine.scanAndTrade();
  const failed = engine.opportunities.find((o) => o.symbol === 'EURUSD');
  const stale = engine.opportunities.find((o) => o.symbol === 'GBPUSD');
  assert.equal(failed, undefined);
  assert.equal(stale, undefined);
  assert.equal(engine.db.driver, 'sqlite');
  assert.equal((await engine.db.openTrades()).length, 0);

  const name = await renderTradeChart({
    symbol: 'EURUSD', timeframe: 'M5', side: 'BUY',
    candles: makeCandles('EURUSD', 'M5', 90),
    entry: 1.1, stopLoss: 1.098, takeProfit: 1.104,
    outputDir: config.CHART_DIR,
  });
  t.after(() => fs.rmSync(name, { force: true }));
  assert.ok(fs.existsSync(name));
  const served = await fetch(`${base}/api/charts/${encodeURIComponent(path.basename(name))}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') || '', /image\/png/);
  const traversal = await call(base, '/api/charts/..%2F..%2Fetc%2Fpasswd');
  assert.equal(traversal.status, 400);
});

test('demo lifecycle opens, blocks duplicates and closes with real P/L', async (t) => {
  const { engine, db } = await boot(t);
  await engine.attachAccount({
    platform: 'mt5', accountType: 'demo', login: '555', password: 'demo-pass',
  });
  const price = await engine.market.latestPrice('EURUSD');
  const signal = {
    symbol: 'EURUSD', timeframe: 'M5', side: 'BUY', entry: price,
    stop_loss: price - 0.002, take_profit: price + 0.002,
    confidence: 0.8, reason_en: 'test setup', reason_ar: 'اختبار', atr: 0.001,
  };
  const decision = { lot: 0.1, risk_amount: 20, rr: 2 };
  const snaps = {
    M5: await engine.market.get('EURUSD', 'M5'),
    M15: await engine.market.get('EURUSD', 'M15'),
  };

  const trade = await engine.executeTrade({ signal, snaps, decision, spreadPips: 1 });
  assert.ok(trade && trade.id);
  const duplicate = await engine.executeTrade({ signal, snaps, decision, spreadPips: 1 });
  assert.equal(duplicate, null);

  engine.market.get = async (symbol, timeframe) => {
    const candles = makeCandles(symbol, timeframe, 100, 1);
    candles[candles.length - 1] = {
      open: price, high: price + 0.005, low: price - 0.0005, close: price + 0.004,
    };
    return { symbol, timeframe, candles, price: price + 0.004, fetchedAt: Date.now(), isStale: false };
  };
  await engine.processOpenTrades();

  const [closed] = await db.recentTrades(10);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.result, 'WIN');
  assert.ok(closed.pnl > 0);
  assert.ok(engine.accountBalance > 10000);
});
