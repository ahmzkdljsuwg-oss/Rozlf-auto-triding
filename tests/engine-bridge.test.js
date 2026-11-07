'use strict';

// Exercises the real backend wiring (Database -> TradingEngine -> HTTP bridge)
// against a local FastAPI stand-in. Config is loaded lazily inside the tests so
// the bridge URL picked at runtime is the one the engine sees.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE_KEY = 'engine-test-key';
const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const state = { bridge: null };

test.before(async () => {
  state.bridge = await startBridge(BRIDGE_KEY);
});

test.after(() => {
  if (state.bridge && state.bridge.child) state.bridge.child.kill('SIGTERM');
});

async function startBridge(key = BRIDGE_KEY) {
  const port = await freePort();
  const child = spawn('python3', [path.join(__dirname, 'fixtures', 'fake_eo_bridge.py')], {
    env: { ...process.env, PORT: String(port), EO_BRIDGE_API_KEY: key, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) return { base, child };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('bridge did not start');
}

async function bootEngine(t, { bridgeUrl, bridgeKey = BRIDGE_KEY } = {}) {
  process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-only-secret-key';
  process.env.EXPERTOPTION_BRIDGE_URL = bridgeUrl;
  process.env.EXPERTOPTION_BRIDGE_KEY = bridgeKey;
  process.env.REAL_TRADING_APPROVED = 'false';
  process.env.MT5_ENABLED = 'false';

  const { Database } = require('../src/db');
  const { TradingEngine } = require('../src/engine');
  const { TelegramNotifier } = require('../src/telegram');
  const { FakeMarket } = require('./helpers');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-engine-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const engine = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  fs.mkdirSync(path.join(dir, 'charts'), { recursive: true });
  t.after(async () => {
    await engine.stop(null);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { engine, db, dir };
}

async function connectDemo(engine) {
  await engine.attachAccount({
    platform: 'expertoption',
    accountType: 'demo',
    login: 'Hdiedjdjdjxnx@gmail.com',
    password: '',
    sessionToken: 'session-token-for-tests',
    server: '',
  });
}

test('engine loads the real account asset list through the bridge', async (t) => {
  const { engine, db } = await bootEngine(t, { bridgeUrl: state.bridge.base });
  await connectDemo(engine);

  const diag = await engine.diagnoseExpertOption();
  assert.equal(diag.ok, true, `${diag.cause}: ${diag.message_en}`);
  assert.equal(diag.stage, 'ready');
  assert.equal(diag.assets.active, 3);
  assert.equal(diag.execution_allowed, false);

  const listing = await engine.expertOptionAssets();
  assert.equal(listing.ok, true, listing.detail_en || listing.cause);
  assert.deepEqual(listing.assets.map((a) => a.id).sort(), ['179', '240', '500']);
  assert.equal(listing.otc_count, 1);
  assert.equal(listing.by_category.otc, 1);
  assert.equal(listing.by_category.smarty, 1);
  assert.equal(listing.by_category.crypto, 1);
  assert.equal(listing.execution_allowed, false);
  assert.equal(listing.inactive, 1);
  const cricket = listing.priority.find((a) => a.key === 'cricket-index');
  assert.equal(cricket.available, true);
  assert.equal(cricket.active, false);

  const status = await engine.status();
  assert.equal(status.expertoption.connected, true);
  assert.equal(status.expertoption.gateway_configured, true);

  const stored = await db.latestAccount('expertoption');
  assert.ok(stored && stored.password_enc, 'session token must be stored encrypted, never in clear');
  assert.notEqual(stored.password_enc, 'session-token-for-tests');
});

test('engine analyses an account instrument by id and never invents a signal', async (t) => {
  const { engine } = await bootEngine(t, { bridgeUrl: state.bridge.base });
  await connectDemo(engine);

  const result = await engine.expertOptionAnalyze('', '1m', '500');
  assert.equal(result.data_verified, true, result.reason_en || result.reason_code);
  assert.ok(['UP', 'DOWN', 'NO TRADE'].includes(result.direction));
  assert.equal(result.asset.id, '500');
  assert.equal(result.execution_allowed, false);

  const unknown = await engine.expertOptionAnalyze('', '1m', '424242');
  assert.equal(unknown.direction, 'NO TRADE');
  assert.equal(unknown.reason_code, 'asset_not_found');
  assert.equal(unknown.execution_allowed, false);

  const quote = await engine.expertOptionQuote('', 'M1', '500');
  assert.equal(quote.ok, true, quote.reason_code);
  assert.ok(quote.price > 0);
  assert.equal(quote.execution_allowed, undefined);
});

test('a wrong bridge key surfaces as bridge_auth_failed with the exact fix', async (t) => {
  const { engine } = await bootEngine(t, { bridgeUrl: state.bridge.base });
  await connectDemo(engine);
  engine.expertOptionSession.bridgeKey = 'wrong-key';

  const diag = await engine.diagnoseExpertOption();
  assert.equal(diag.ok, false);
  assert.equal(diag.cause, 'bridge_auth_failed');
  assert.match(diag.next_step_en, /EO_BRIDGE_API_KEY/);
  assert.equal(diag.execution_allowed, false);

  const listing = await engine.expertOptionAssets();
  assert.equal(listing.ok, false);
  assert.equal(listing.cause, 'bridge_auth_failed');
  assert.deepEqual(listing.assets, []);
});

test('an unreachable bridge is reported as bridge_unreachable, not as a missing session', async (t) => {
  const deadPort = await freePort();
  const { engine } = await bootEngine(t, { bridgeUrl: state.bridge.base });
  await connectDemo(engine);
  engine.expertOptionSession.baseUrl = `http://127.0.0.1:${deadPort}`;
  engine.expertOptionSession.timeoutMs = 1500;

  const diag = await engine.diagnoseExpertOption();
  assert.equal(diag.ok, false);
  assert.equal(diag.cause, 'bridge_unreachable');
  assert.equal(diag.stage, 'bridge');
  assert.ok(diag.next_step_ar.length > 0);
  assert.equal(diag.execution_allowed, false);
});
