'use strict';

process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-only-secret-key';

process.env.DASHBOARD_TOKEN = '';
process.env.ALLOW_INSECURE_DASHBOARD = 'true';
process.env.REAL_TRADING_APPROVED = 'false';
process.env.MT5_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Database } = require('../src/db');
const { TradingEngine } = require('../src/engine');
const { TelegramNotifier } = require('../src/telegram');
const { TelegramBotController } = require('../src/telegram_bot');
const { createApp } = require('../src/app');
const { SPEED_PRESETS, getSpeedPreset } = require('../src/speed');
const { FakeMarket } = require('./helpers');

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-speed-'));
  const db = await new Database({ path: path.join(dir, 'test.db'), connectionString: '' }).init();
  const engine = await new TradingEngine({
    db, market: new FakeMarket(), telegram: new TelegramNotifier('', ''),
    chartDir: path.join(dir, 'charts'),
  }).init();
  const app = createApp({ engine });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, engine };
}

async function call(base, route, options = {}) {
  const res = await fetch(base + route, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('speed presets keep slow the most selective', () => {
  assert.ok(SPEED_PRESETS.slow.min_confidence > SPEED_PRESETS.medium.min_confidence);
  assert.ok(SPEED_PRESETS.medium.min_confidence > SPEED_PRESETS.fast.min_confidence);
  assert.ok(SPEED_PRESETS.slow.scan_interval_seconds > SPEED_PRESETS.fast.scan_interval_seconds);
  assert.equal(SPEED_PRESETS.slow.require_h4, true);
  assert.equal(getSpeedPreset('unknown').id, 'medium');
});

test('MT5 demo connect fails instead of pretending to trade without a bridge', async (t) => {
  const { base } = await boot(t);
  const res = await call(base, '/api/connect', {
    method: 'POST',
    body: { platform: 'mt5', account_type: 'demo', login: '900001', password: 'demo-pass', server: 'demo' },
  });
  assert.equal(res.status, 502);
  assert.match(res.body.detail, /simulated MT5|bridge/i);
});

test('site speed endpoint persists the selected mode', async (t) => {
  const { base, engine } = await boot(t);
  const initial = await call(base, '/api/speed');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.speed, 'medium');

  const changed = await call(base, '/api/speed', { method: 'POST', body: { speed: 'fast' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.speed, 'fast');
  assert.equal(engine.speed, 'fast');
  assert.equal(await engine.db.getSetting('trading.speed'), 'fast');

  const invalid = await call(base, '/api/speed', { method: 'POST', body: { speed: 'turbo' } });
  assert.equal(invalid.status, 422);
});

test('telegram callback changes speed without echoing a duplicate notice', async (t) => {
  const { engine } = await boot(t);
  const calls = [];
  const notifier = {
    enabled: true,
    chatId: '42',
    api: async (method, payload) => { calls.push({ method, payload }); return { ok: true, result: [] }; },
    speedKeyboard: () => ({ inline_keyboard: [] }),
  };
  const bot = new TelegramBotController({ notifier, engine });
  await bot._handle({
    callback_query: {
      id: 'cb-1',
      data: 'speed:slow',
      message: { message_id: 10, chat: { id: 42 } },
    },
  });
  assert.equal(engine.speed, 'slow');
  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.match(answer.payload.text, /بطيء/);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.match(edit.payload.text, /بطيء/);
  assert.match(edit.payload.text, /الموقع/);
});
