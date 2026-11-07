'use strict';

process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-only-secret-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { ExpertOptionSession } = require('../src/expertoption-session');
const { analyzeAsset, describeAccountAssets } = require('../src/expertoption-analysis');
const { TelegramNotifier } = require('../src/telegram');

const BRIDGE_KEY = 'test-key';
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

async function startBridge(t) {
  const port = await freePort();
  const child = spawn('python3', [path.join(__dirname, 'fixtures', 'fake_eo_bridge.py')], {
    env: { ...process.env, PORT: String(port), EO_BRIDGE_API_KEY: BRIDGE_KEY, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill('SIGTERM'));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return base;
    } catch {
      /* bridge still booting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`fake bridge did not start: ${stderr.slice(-400)}`);
}

function sessionFor(base, overrides = {}) {
  return new ExpertOptionSession({
    login: '900001',
    baseUrl: base,
    apiKey: BRIDGE_KEY,
    token: 'demo-session-token',
    tokenPresent: true,
    minIntervalMs: 0,
    retries: 0,
    candleCacheMs: 0,
    instrumentCacheMs: 0,
    timeoutMs: 10000,
    ...overrides,
  });
}

test('the backend talks to a real HTTP bridge: session, assets, candles, quote and expiries', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base);

  const status = await session.verify();
  assert.equal(status.verified, true, session.lastError || 'session verification failed');
  assert.equal(status.account.balance, 10000);
  assert.equal(String(status.account.type).toLowerCase(), 'demo');

  const instruments = await session.markets();
  assert.deepEqual(instruments.map((i) => i.symbol).sort(), ['BTCUSD', 'CRICKET', 'EURUSD_OTC', 'SMARTY']);

  const rows = await session.candles({ instrumentId: '240', timeframe: 'M1', limit: 120 });
  assert.equal(rows.length, 120);
  const ageSeconds = (Date.now() - rows[rows.length - 1].time) / 1000;
  assert.ok(ageSeconds < 120, `last candle age is ${ageSeconds.toFixed(1)}s`);

  const price = await session.quote({ instrumentId: '240', timeframe: 'M1' });
  assert.ok(price.price > 0);

  const expiries = await session.expiries({ instrumentId: '240', timeframe: 'M1' });
  assert.deepEqual(expiries.expiries, [30, 60, 120, 180, 300]);
});

test('diagnostics report the bridge as reachable', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base);
  const diag = await session.diagnostics();
  assert.equal(diag.configured, true);
  assert.equal(diag.reachable, true);
  assert.equal(diag.trading_enabled, false);
  assert.equal(diag.session_connected, true);
  assert.ok(diag.latency_ms >= 0);
});

test('analysis produces a signal from live bridge candles and refuses unknown assets', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base);
  await session.verify();

  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.data_verified, true, result.reason_en || result.reason_code);
  assert.ok(['UP', 'DOWN', 'NO TRADE'].includes(result.direction));
  assert.ok(result.candles >= 80);
  assert.ok(result.price > 0);
  assert.ok(result.age_seconds < 120);
  assert.equal(result.timeframe, 'M1');
  assert.equal(result.execution_allowed, false);

  const otc = await analyzeAsset({ session, assetKey: 'eurusd-otc', expiry: '1m' });
  assert.equal(otc.data_verified, true);
  assert.equal(otc.asset.otc, true);

  const inactive = await analyzeAsset({ session, assetKey: 'cricket-index', expiry: '1m' });
  assert.equal(inactive.direction, 'NO TRADE');
  assert.equal(inactive.reason_code, 'asset_inactive');

  const missing = sessionFor(base);
  await missing.verify();
  const absent = await analyzeAsset({ session: missing, assetKey: 'football-index', expiry: '1m' });
  assert.equal(absent.direction, 'NO TRADE');
  assert.equal(absent.reason_code, 'asset_not_found');
});

test('the account asset list is built from every active bridge instrument', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base);
  await session.verify();
  const instruments = await session.markets({ force: true });
  const described = describeAccountAssets(instruments);

  assert.equal(described.total, 4);
  assert.equal(described.assets.length, 3, 'inactive Cricket must not be listed');
  assert.equal(described.inactive_count, 1);
  assert.equal(described.otc_count, 1);
  assert.deepEqual(described.assets.map((a) => a.id).sort(), ['179', '240', '500']);
  assert.ok(described.assets.every((a) => a.available && a.active));
  assert.equal(described.assets[0].key, 'smarty', 'requested assets keep their key and sort first');
  const crypto = described.assets.find((a) => a.id === '500');
  assert.equal(crypto.key, 'asset-500');
  assert.equal(crypto.category, 'crypto');

  const emptyish = describeAccountAssets([]);
  assert.equal(emptyish.assets.length, 0);
  assert.equal(describeAccountAssets(null).total, 0);
});

test('an account instrument outside the priority list can still be analysed by id', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base);
  await session.verify();

  const result = await analyzeAsset({ session, assetKey: '', instrumentId: '500', expiry: '1m' });
  assert.equal(result.data_verified, true, result.reason_en || result.reason_code);
  assert.equal(result.asset.id, '500');
  assert.equal(result.asset.key, 'asset-500');
  assert.equal(result.asset.name, 'BTC/USD');
  assert.equal(result.execution_allowed, false);

  const unknown = await analyzeAsset({ session, assetKey: '', instrumentId: '424242', expiry: '1m' });
  assert.equal(unknown.direction, 'NO TRADE');
  assert.equal(unknown.reason_code, 'asset_not_found');
  assert.equal(unknown.requested_instrument_id, '424242');

  const noId = await analyzeAsset({ session, assetKey: '', expiry: '1m' });
  assert.equal(noId.direction, 'NO TRADE');
  assert.equal(noId.reason_code, 'bad_asset');
});

test('a bad bridge key is reported, never treated as connected', async (t) => {
  const base = await startBridge(t);
  const session = sessionFor(base, { apiKey: 'wrong-key' });
  const status = await session.verify();
  assert.equal(status.verified, false);
  assert.equal(status.connected, false);
  assert.match(String(session.lastError), /401|rejected|key|expired|unauthorized/i);
});

test('analysis never runs when the bridge is down', async (t) => {
  const port = await freePort();
  const session = sessionFor(`http://127.0.0.1:${port}`, { timeoutMs: 1500 });
  const diag = await session.diagnostics();
  assert.equal(diag.reachable, false);
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.direction, 'NO TRADE');
  assert.equal(result.data_verified, false);
});

test('the notifier refuses to send when no token is configured', async () => {
  const notifier = new TelegramNotifier('', '');
  const res = await notifier.sendMessage('x');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /token is not configured/);
});

test('no fixture file leaks a real credential', () => {
  const file = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'fake_eo_bridge.py'), 'utf8');
  assert.equal(/Hdiedjdjdjxnx|EXPERTOPTION_SESSION_TOKEN=/.test(file), false);
});
