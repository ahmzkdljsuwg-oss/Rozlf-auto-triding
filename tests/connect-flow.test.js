'use strict';

process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-only-secret-key';
process.env.DASHBOARD_TOKEN = '';
process.env.ALLOW_INSECURE_DASHBOARD = 'true';
process.env.REAL_TRADING_APPROVED = 'false';
process.env.MT5_ENABLED = 'false';
process.env.EXPERTOPTION_ALLOW_REAL_READ = 'true';
delete process.env.EXPERTOPTION_BRIDGE_URL;
delete process.env.EXPERTOPTION_BRIDGE_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/db');
const { TradingEngine } = require('../src/engine');
const { TelegramNotifier } = require('../src/telegram');
const { createApp } = require('../src/app');
const pairing = require('../src/connect-pairing');
const { FakeMarket } = require('./helpers');

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-connect-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const engine = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
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
  return { base, db, engine };
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

test('capability report never claims an official API or direct Safari access', async (t) => {
  const { base } = await boot(t);
  const res = await call(base, '/api/connect/methods');
  assert.equal(res.status, 200);
  assert.equal(res.body.read_only, true);
  assert.equal(res.body.execution_enabled, false);
  assert.equal(res.body.methods.official_api.available, false);
  assert.equal(res.body.methods.safari_direct.available, false);
  assert.equal(res.body.methods.local_connector.available, true);
});

test('a pairing code is issued and the encrypted session reaches attachAccount', async (t) => {
  const { base, engine } = await boot(t);
  const issued = await call(base, '/api/connect/pair', { method: 'POST', body: {} });
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(issued.body.expires_in_seconds > 0);

  const captured = {};
  engine.attachAccount = async (payload) => {
    Object.assign(captured, payload);
    return { ok: true, platform: 'expertoption', account_type: 'demo' };
  };
  engine.expertOptionSession = { status: () => ({ verified: true, market_data_available: true }) };

  const blob = pairing.encryptPayload(issued.body.code, 'real-looking-token-123456');
  const res = await call(base, '/api/connect/session', {
    method: 'POST',
    body: { code: issued.body.code, payload: blob, account_type: 'demo', login: 'demo@example.com' },
  });
  assert.equal(res.status, 200);
  assert.equal(captured.sessionToken, 'real-looking-token-123456');
  assert.equal(captured.accountType, 'demo');
  assert.equal(captured.login, 'demo@example.com');
  assert.ok(!JSON.stringify(res.body).includes('real-looking-token'));

  const replay = await call(base, '/api/connect/session', {
    method: 'POST', body: { code: issued.body.code, payload: blob },
  });
  assert.equal(replay.status, 410);
  assert.match(String(replay.body.detail), /استُخدم/);
});

test('a wrong pairing code is refused and the real code still works', async (t) => {
  const { base, engine } = await boot(t);
  const issued = await call(base, '/api/connect/pair', { method: 'POST', body: {} });
  const blob = pairing.encryptPayload('ZZZZ-9999', 'token-abcdefgh');
  const wrong = await call(base, '/api/connect/session', {
    method: 'POST', body: { code: issued.body.code, payload: blob },
  });
  assert.equal(wrong.status, 422);

  let captured = null;
  engine.attachAccount = async (payload) => { captured = payload; return { ok: true }; };
  engine.expertOptionSession = { status: () => ({ verified: false, last_error: 'bridge offline' }) };
  const good = await call(base, '/api/connect/session', {
    method: 'POST',
    body: { code: issued.body.code, payload: pairing.encryptPayload(issued.body.code, 'token-abcdefgh') },
  });
  assert.equal(good.status, 200);
  assert.equal(captured.sessionToken, 'token-abcdefgh');
});

test('a bridge failure is reported, not swallowed, and no token leaks', async (t) => {
  const { base, engine } = await boot(t);
  const issued = await call(base, '/api/connect/pair', { method: 'POST', body: {} });
  engine.attachAccount = async () => { throw new Error('No ExpertOption WebSocket endpoint is reachable'); };
  const res = await call(base, '/api/connect/session', {
    method: 'POST',
    body: { code: issued.body.code, payload: pairing.encryptPayload(issued.body.code, 'token-abcdefgh') },
  });
  assert.equal(res.status, 502);
  assert.match(String(res.body.detail), /WebSocket endpoint/);
  assert.ok(!JSON.stringify(res.body).includes('token-abcdefgh'));
});

test('real account read is refused while EXPERTOPTION_ALLOW_REAL_READ is false', async (t) => {
  const { base, engine } = await boot(t);
  const config = require('../src/config');
  const previous = config.EXPERTOPTION_ALLOW_REAL_READ;
  config.EXPERTOPTION_ALLOW_REAL_READ = false;
  t.after(() => { config.EXPERTOPTION_ALLOW_REAL_READ = previous; });
  const issued = await call(base, '/api/connect/pair', { method: 'POST', body: {} });
  engine.attachAccount = async () => ({ ok: true });
  const res = await call(base, '/api/connect/session', {
    method: 'POST',
    body: {
      code: issued.body.code,
      payload: pairing.encryptPayload(issued.body.code, 'token-abcdefgh'),
      account_type: 'real',
    },
  });
  assert.equal(res.status, 403);
});

test('the connector script downloads only for the owner', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/rozlf_connect.py`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /ROZLF local consent connector/);
  assert.ok(!text.includes('APP_SECRET_KEY'));
});

test('sensitive connect routes reject an anonymous caller', async (t) => {
  const { base } = await boot(t);
  const config = require('../src/config');
  config.ALLOW_INSECURE_DASHBOARD = false;
  try {
    const res = await call(base, '/api/connect/pair', { method: 'POST', body: {} });
    assert.equal(res.status, 401);
  } finally {
    config.ALLOW_INSECURE_DASHBOARD = true;
  }
});
