'use strict';

process.env.DASHBOARD_TOKEN = '';
process.env.ALLOW_INSECURE_DASHBOARD = 'false';
process.env.REAL_TRADING_APPROVED = 'false';
process.env.MT5_ENABLED = 'false';
process.env.EXPERTOPTION_BRIDGE_URL = '';
process.env.EXPERTOPTION_BRIDGE_KEY = '';
process.env.EXPERTOPTION_SESSION_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/db');
const { TradingEngine } = require('../src/engine');
const { createApp } = require('../src/app');
const { TelegramNotifier } = require('../src/telegram');
const { encryptSecret } = require('../src/security');
const { FakeMarket } = require('./helpers');

const TOKEN = 'eo-restore-token-abc';

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-restore-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const engine = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  t.after(async () => {
    await engine.stop(null);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, engine, dir };
}

test('the ExpertOption token is stored encrypted, never as plain text', async (t) => {
  const { db, engine } = await boot(t);
  await engine.attachAccount({
    platform: 'expertoption', accountType: 'demo', login: 'demo@example.com', sessionToken: TOKEN,
  });
  const row = await db.latestAccount('expertoption');
  assert.ok(row, 'account row exists');
  assert.match(String(row.password_enc), /^v1\./);
  assert.ok(!String(row.password_enc).includes(TOKEN), 'stored value must not contain the token');
  assert.equal(engine.sessionRestore.restored, false);
});

test('a restarted engine restores the session from the encrypted store', async (t) => {
  const { db, dir } = await boot(t);
  const first = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  await first.attachAccount({
    platform: 'expertoption', accountType: 'demo', login: 'demo@example.com', sessionToken: TOKEN,
  });
  await first.stop(null);

  const second = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  assert.ok(second.expertOptionSession, 'session rebuilt after restart');
  assert.equal(second.sessionRestore.restored, true);
  assert.equal(second.expertOptionSession.token, TOKEN);
  assert.equal(second.platform, 'expertoption');
  assert.equal(second.analysisOnly, true);
  const status = await second.status();
  assert.equal(status.session_restore.restored, true);
  assert.equal(JSON.stringify(status).includes(TOKEN), false, 'the token never leaves the server state');
  await second.stop(null);
});

test('an unreadable stored token asks for a new token instead of guessing', async (t) => {
  const { db, dir } = await boot(t);
  const row = await db.upsertAccount('expertoption', 'demo', 'demo@example.com', 'ExpertOption', encryptSecret(TOKEN), 0);
  await db.run('UPDATE accounts SET password_enc=? WHERE id=?', ['v1.bad.bad.bad', row.id]);

  const engine = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''), chartDir: path.join(dir, 'charts'),
  }).init();
  assert.equal(engine.expertOptionSession, null);
  assert.equal(engine.sessionRestore.restored, false);
  assert.equal(engine.sessionRestore.reason, 'stored_token_unreadable');
  await engine.stop(null);
});

test('the dashboard API is locked when no DASHBOARD_TOKEN is configured', async (t) => {
  const { engine } = await boot(t);
  const app = createApp({ engine });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const locked = await fetch(`${base}/api/status`);
  assert.equal(locked.status, 401);
  const noToken = await fetch(`${base}/api/expertoption/assets`);
  assert.equal(noToken.status, 401);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});
