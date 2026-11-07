'use strict';

process.env.DASHBOARD_TOKEN = '';
process.env.REAL_TRADING_APPROVED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/db');
const { TradingEngine } = require('../src/engine');
const { TelegramNotifier } = require('../src/telegram');
const config = require('../src/config');
const { FakeMarket, makeCandles } = require('./helpers');

const TOKEN = 'bridge-test-token';
const SECRET = 'bridge-test-secret';

function createMockBridge() {
  const state = {
    balance: 2500, equity: 2490, marginFree: 2400, marginUsed: 100, marginLevel: 2490,
    position: null, failing: false, orders: [], signatureErrors: 0,
    nextTicket: 777001,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.length ? JSON.parse(raw.toString()) : {};
    const url = new URL(req.url, 'http://localhost');
    const pathWithQuery = url.pathname + (url.search || '');
    const stamp = req.headers['x-bridge-timestamp'] || '';
    const expected = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}\n${req.method.toUpperCase()}\n${pathWithQuery}\n${raw.toString()}`).digest('hex');
    if (req.headers['x-bridge-token'] !== TOKEN || req.headers['x-bridge-signature'] !== expected) {
      state.signatureErrors += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, detail: 'bad signature' }));
    }
    if (state.failing) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, detail: 'terminal offline' }));
    }
    const send = (payload, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/connect') return send({ ok: true, connected: true, login: '900123', is_demo: true });
    if (url.pathname === '/account') {
      return send({
        ok: true, connected: true, login: '900123', server: 'MetaQuotes-Demo',
        balance: state.balance, equity: state.equity, margin_free: state.marginFree,
        margin_used: state.marginUsed, margin_level: state.marginLevel,
        currency: 'USD', leverage: 100, is_demo: true, synced_at: new Date().toISOString(),
      });
    }
    if (url.pathname === '/positions') {
      return send({ ok: true, positions: state.position ? [state.position] : [] });
    }
    if (url.pathname === '/order') {
      const ticket = String(state.nextTicket++);
      state.position = {
        ticket, symbol: body.symbol, side: body.side, lot: body.lot,
        entry_price: 1.1010, current_price: 1.1010, stop_loss: body.stop_loss,
        take_profit: body.take_profit, pnl: 0, opened_at: new Date().toISOString(),
      };
      state.orders.push({ ticket, body });
      return send({
        ok: true, accepted: true, ticket, fill_price: 1.1010, message: 'accepted',
        account: {
          login: '900123', server: 'MetaQuotes-Demo', is_demo: true,
          balance: state.balance, equity: state.equity,
        },
      });
    }
    if (url.pathname === '/close') {
      state.position = null;
      return send({
        ok: true, accepted: true, ticket: body.order_id, fill_price: 1.1060,
        account: {
          login: '900123', server: 'MetaQuotes-Demo', is_demo: true,
          balance: state.balance, equity: state.equity,
        },
      });
    }
    if (url.pathname === '/history') {
      if (!state.closed) return send({ ok: true, found: false });
      return send({ ok: true, found: true, ...state.closed });
    }
    if (url.pathname === '/disconnect') return send({ ok: true, connected: false });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, detail: 'not found' }));
  });
  return { server, state };
}

async function boot(t, bridgePort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-mt5-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const market = new FakeMarket();
  const engine = await new TradingEngine({
    db, market, telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  fs.mkdirSync(path.join(dir, 'charts'), { recursive: true });
  t.after(async () => {
    await engine.shutdown();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { engine, db, market, dir, bridgePort };
}

test('MT5 account, execution, duplicate and close stay in sync', async (t) => {
  const { server, state } = createMockBridge();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previous = {
    enabled: config.MT5_ENABLED, url: config.MT5_BRIDGE_URL, token: config.MT5_BRIDGE_TOKEN,
    secret: config.MT5_BRIDGE_SECRET, cooldown: config.TRADE_REENTRY_COOLDOWN_SECONDS,
  };
  config.MT5_ENABLED = true;
  config.MT5_BRIDGE_URL = `http://127.0.0.1:${port}`;
  config.MT5_BRIDGE_TOKEN = TOKEN;
  config.MT5_BRIDGE_SECRET = SECRET;
  config.TRADE_REENTRY_COOLDOWN_SECONDS = 0;
  t.after(() => {
    config.MT5_ENABLED = previous.enabled;
    config.MT5_BRIDGE_URL = previous.url;
    config.MT5_BRIDGE_TOKEN = previous.token;
    config.MT5_BRIDGE_SECRET = previous.secret;
    config.TRADE_REENTRY_COOLDOWN_SECONDS = previous.cooldown;
  });

  const { engine } = await boot(t, port);
  const connected = await engine.attachAccount({
    platform: 'mt5', accountType: 'demo', login: '900123', password: 'demo-pass',
    server: 'MetaQuotes-Demo',
  });
  assert.equal(connected.execution_mode, 'live_bridge');
  assert.equal(connected.balance, 2500);
  assert.equal(connected.margin_free, 2400);
  assert.equal(connected.margin_used, 100);
  assert.equal(connected.margin_level, 2490);
  assert.equal(connected.account_synced, true);
  assert.equal(state.signatureErrors, 0);

  const signal = {
    symbol: 'EURUSD', timeframe: 'M15', side: 'BUY', entry: 1.1010,
    stop_loss: 1.0960, take_profit: 1.1110, confidence: 0.8, reason_en: 'test structure',
  };
  const snap = { candles: makeCandles('EURUSD', 'M15', 200, 1) };
  const trade = await engine.executeTrade({
    signal, snaps: { M15: snap, M5: snap, H1: snap, H4: snap, D1: snap },
    decision: { lot: 0.10, risk_amount: 10, rr: 2 }, spreadPips: 0.4,
  });
  assert.ok(trade && trade.broker_order_id);
  assert.equal(trade.broker_order_id, '777001');
  assert.equal(state.orders.length, 1);

  const duplicate = await engine.executeTrade({
    signal, snaps: { M15: snap, M5: snap, H1: snap, H4: snap, D1: snap },
    decision: { lot: 0.10, risk_amount: 10, rr: 2 }, spreadPips: 0.4,
  });
  assert.equal(duplicate, null);
  assert.equal(state.orders.length, 1);

  state.balance = 2512.4;
  state.equity = 2522.4;
  state.marginFree = 2412.4;
  await engine.syncAccount();
  const status = await engine.status();
  assert.equal(status.balance, 2512.4);
  assert.equal(status.equity, 2522.4);
  assert.equal(status.margin_free, 2412.4);
  assert.equal(status.account_synced, true);

  state.position = null;
  state.closed = {
    ticket: '777001', symbol: 'EURUSD', side: 'BUY', lot: 0.1,
    entry_price: 1.1010, close_price: 1.1060, pnl: 9.4,
    closed_at: new Date().toISOString(),
  };
  await engine.syncBrokerTrades();
  const closed = (await engine.db.recentTrades(10)).find((row) => row.broker_order_id === '777001');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.result, 'WIN');
  assert.equal(Number(closed.pnl), 9.4);
  assert.equal(closed.close_price, 1.1060);

  state.failing = true;
  await engine.syncAccount();
  const offline = await engine.status();
  assert.equal(offline.account_synced, false);
  assert.equal(offline.account_status, 'disconnected');
  assert.match(offline.account_sync_error, /503|offline/i);
  const blocked = await engine.executeTrade({
    signal: { ...signal, symbol: 'GBPUSD' },
    snaps: { M15: snap, M5: snap, H1: snap, H4: snap, D1: snap },
    decision: { lot: 0.10, risk_amount: 10, rr: 2 }, spreadPips: 0.4,
  });
  assert.equal(blocked, null);
  assert.equal(state.orders.length, 1);
});
