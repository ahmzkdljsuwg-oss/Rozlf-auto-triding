'use strict';

process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-only-secret-key';
process.env.DASHBOARD_TOKEN = '';
process.env.ALLOW_INSECURE_DASHBOARD = 'true';
process.env.REAL_TRADING_APPROVED = 'false';
process.env.TELEGRAM_POLL_SECONDS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TelegramNotifier, escapeHtml } = require('../src/telegram');
const { TelegramBotController } = require('../src/telegram_bot');

const CHAT_ID = '777001';
const TOKEN = 'TEST-TOKEN-123';

// Minimal Telegram Bot API stand-in: records every call and replays queued updates.
class MockTelegram {
  constructor() {
    this.calls = [];
    this.updates = [];
    this.nextUpdateId = 100;
    this.webhookConflicts = 0;
    this.rateLimitOnce = new Set();
    this.server = http.createServer((req, res) => this._route(req, res));
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  pushMessage(text, chatId = CHAT_ID) {
    const update = {
      update_id: this.nextUpdateId++,
      message: { message_id: this.nextUpdateId, chat: { id: Number(chatId), type: 'private' }, text },
    };
    this.updates.push(update);
    return update;
  }

  pushCallback(data, chatId = CHAT_ID) {
    const update = {
      update_id: this.nextUpdateId++,
      callback_query: {
        id: `cb-${this.nextUpdateId}`,
        data,
        message: { message_id: 42, chat: { id: Number(chatId), type: 'private' } },
      },
    };
    this.updates.push(update);
    return update;
  }

  methodCalls(method) {
    return this.calls.filter((c) => c.method === method);
  }

  _json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  _route(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const method = String(req.url || '').split('/').pop().split('?')[0];
      let body = {};
      if (String(req.headers['content-type'] || '').includes('application/json')) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = {}; }
      }
      this.calls.push({ method, body, headers: req.headers, bytes: raw.length });

      if (this.rateLimitOnce.has(method)) {
        this.rateLimitOnce.delete(method);
        return this._json(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
      }
      if (method === 'getUpdates') {
        if (this.webhookConflicts > 0) {
          this.webhookConflicts -= 1;
          return this._json(res, 409, { ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' });
        }
        const offset = Number(body.offset || 0);
        const result = this.updates.filter((u) => (offset <= 0 || u.update_id >= offset));
        this.updates = this.updates.filter((u) => !result.includes(u));
        return this._json(res, 200, { ok: true, result });
      }
      if (method === 'getMe') {
        return this._json(res, 200, { ok: true, result: { id: 900001, is_bot: true, username: 'rozlf_test_bot', first_name: 'ROZLF' } });
      }
      if (method === 'getChat') {
        return this._json(res, 200, { ok: true, result: { id: Number(CHAT_ID), type: 'private', title: 'Owner Chat' } });
      }
      if (method === 'deleteWebhook') return this._json(res, 200, { ok: true, result: true });
      if (method === 'answerCallbackQuery' || method === 'editMessageText' || method === 'sendMessage') {
        return this._json(res, 200, { ok: true, result: { message_id: 55, text: body.text || '' } });
      }
      if (method === 'sendPhoto') return this._json(res, 200, { ok: true, result: { message_id: 56 } });
      return this._json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    });
  }
}

function makeEngine() {
  const settings = new Map();
  const state = {
    settings,
    logs: [],
    stoppedWith: null,
    emergency: 0,
    started: 0,
    mgmt: [],
  };
  const db = {
    addLog: async (level, scope, message) => { state.logs.push({ level, scope, message }); },
    getSetting: async (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    setSetting: async (key, value) => { settings.set(key, value); },
  };
  const engine = {
    db,
    speed: 'medium',
    symbols: ['EURUSD'],
    timeframe: 'M15',
    notifications: {},
    account: null,
    platform: 'expertoption',
    expertOptionAssets: async () => ({
      ok: true,
      available: 1,
      assets: [{ key: 'smarty', label_ar: 'Smarty', label_en: 'Smarty', available: true }],
    }),
    expertOptionAnalyze: async () => ({ ok: false, detail_ar: 'الشموع غير متاحة من البوابة.', detail: 'Candles unavailable' }),
    emergencyStop: async () => { state.emergency += 1; return { ok: true }; },
    start: async () => { state.started += 1; return { ok: true }; },
    stop: async (source) => { state.stoppedWith = source; return { ok: true }; },
    status: async () => ({
      account_login: 'demo-1', account_type: 'demo', account_status: 'analysis', running: false,
      speed: 'medium', balance: 0, currency: 'USD', open_trades: [], today_trades: 0,
      analysis_only: true, trading_mode: 'analysis',
    }),
    updateSettings: async (patch) => {
      state.mgmt.push(patch);
      if (patch.notifications) engine.notifications = patch.notifications;
      return {};
    },
    getSettings: async () => ({ risk_percent: 1 }),
    setTradingMode: async (mode) => ({ ok: true, mode }),
  };
  return { engine, state };
}

async function waitForAsync(predicate, timeoutMs = 8000, label = 'condition') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitFor(predicate, timeoutMs = 8000, label = 'condition') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function bootBot(t, { webhookConflicts = 0 } = {}) {
  const mock = await new MockTelegram().listen();
  mock.webhookConflicts = webhookConflicts;
  t.after(() => mock.close());
  const { engine, state } = makeEngine();
  const notifier = new TelegramNotifier(TOKEN, CHAT_ID, mock.base);
  const bot = new TelegramBotController({ notifier, engine });
  engine.telegramBot = bot;
  await bot.start();
  t.after(() => bot.stop());
  await waitFor(() => mock.methodCalls('getUpdates').length > 0, 8000, 'first poll');
  return { mock, bot, engine, state, notifier };
}

test('notifier polls with the configured base URL and answers /ping', async (t) => {
  const { mock, bot } = await bootBot(t);
  assert.equal(bot.botUsername, 'rozlf_test_bot', 'bot username is read from getMe');
  mock.pushMessage('/ping');
  await waitFor(() => mock.methodCalls('sendMessage').some((c) => /البوت يستجيب/.test(c.body.text || '')), 8000, 'ping reply');
  const reply = mock.methodCalls('sendMessage').find((c) => /البوت يستجيب/.test(c.body.text || ''));
  assert.equal(String(reply.body.chat_id), CHAT_ID);
  assert.equal(bot.health, 'ok');
  assert.ok(bot.lastUpdateAt, 'last update timestamp recorded');
});

test('the offset is persisted so a restart does not replay old commands', async (t) => {
  const { mock, bot, engine } = await bootBot(t);
  const update = mock.pushMessage('/status');
  await waitFor(() => bot.offset === update.update_id + 1, 8000, 'offset advance');
  await waitForAsync(async () => Number(await engine.db.getSetting('telegram.offset', 0)) > 0, 4000, 'offset persisted');
  assert.equal(Number(await engine.db.getSetting('telegram.offset', 0)), update.update_id + 1);

  const restarted = new TelegramBotController({ notifier: bot.notifier, engine });
  await restarted.start();
  t.after(() => restarted.stop());
  await waitFor(() => restarted.offset === update.update_id + 1, 8000, 'restored offset');
  assert.equal(restarted.status().offset, update.update_id + 1);
});

test('a non-owner chat is refused and told its chat id', async (t) => {
  const { mock, state } = await bootBot(t);
  mock.pushMessage('/stop', '424242');
  await waitFor(() => mock.methodCalls('sendMessage').some((c) => String(c.body.chat_id) === '424242'), 8000, 'denial reply');
  const denial = mock.methodCalls('sendMessage').find((c) => String(c.body.chat_id) === '424242');
  assert.match(denial.body.text, /424242/);
  assert.equal(state.stoppedWith, null, 'unauthorized chat cannot stop the bot');
});

test('callbacks drive the menus and the emergency stop', async (t) => {
  const { mock, state } = await bootBot(t);
  mock.pushCallback('menu:main');
  await waitFor(() => mock.methodCalls('editMessageText').length > 0, 8000, 'menu edit');
  assert.match(mock.methodCalls('editMessageText')[0].body.text, /ROZLF/);

  mock.pushCallback('action:emergency');
  await waitFor(() => state.emergency === 1, 8000, 'emergency stop');
  const answer = mock.methodCalls('answerCallbackQuery').pop();
  assert.equal(String(answer.body.callback_query_id).startsWith('cb-'), true);
});

test('ExpertOption callbacks use the account asset list and refuse a signal without candles', async (t) => {
  const { mock } = await bootBot(t);
  mock.pushCallback('menu:eo');
  await waitFor(() => mock.methodCalls('editMessageText').some((c) => /ExpertOption/.test(c.body.text || '')), 8000, 'eo menu');
  const menu = mock.methodCalls('editMessageText').find((c) => /ExpertOption/.test(c.body.text || ''));
  const buttons = JSON.stringify(menu.body.reply_markup || {});
  assert.match(buttons, /eoasset:smarty/);

  mock.pushCallback('eoasset:smarty');
  mock.pushCallback('eoexpiry:30s');
  await waitFor(() => mock.methodCalls('sendMessage').some((c) => /NO TRADE/.test(c.body.text || '')), 8000, 'no-trade notice');
  assert.ok(mock.methodCalls('sendMessage').every((c) => !/BUY|SELL/.test(c.body.text || '') || /NO TRADE/.test(c.body.text || '')),
    'no trade signal is announced when candles are unavailable');
});

test('a webhook conflict is cleared automatically and polling resumes', async (t) => {
  // two conflicts: one for the backlog cursor probe, one for the polling loop
  const { mock, bot } = await bootBot(t, { webhookConflicts: 2 });
  await waitFor(() => mock.methodCalls('deleteWebhook').length === 1, 8000, 'deleteWebhook');
  await waitFor(() => bot.health === 'ok', 8000, 'polling healthy again');
  mock.pushMessage('/ping');
  await waitFor(() => mock.methodCalls('sendMessage').some((c) => /البوت يستجيب/.test(c.body.text || '')), 8000, 'reply after recovery');
});

test('429 rate limits are retried once using retry_after', async () => {
  const mock = await new MockTelegram().listen();
  try {
    const notifier = new TelegramNotifier(TOKEN, CHAT_ID, mock.base);
    mock.rateLimitOnce.add('sendMessage');
    const startedAt = Date.now();
    const sent = await notifier.sendMessage('hello');
    assert.equal(sent.ok, true);
    assert.ok(Date.now() - startedAt >= 900, 'retry_after was honoured');
    assert.equal(mock.methodCalls('sendMessage').length, 2);
  } finally {
    await mock.close();
  }
});

test('an invalid token halts polling and is logged as unauthorized', async (t) => {
  const mock = await new MockTelegram().listen();
  t.after(() => mock.close());
  const original = mock._route.bind(mock);
  mock._route = (req, res) => {
    if (String(req.url).includes('getUpdates')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
    }
    return original(req, res);
  };
  const { engine, state } = makeEngine();
  const bot = new TelegramBotController({ notifier: new TelegramNotifier(TOKEN, CHAT_ID, mock.base), engine });
  await bot.start();
  t.after(() => bot.stop());
  await waitFor(() => bot.health === 'unauthorized' && bot.running === false, 8000, 'unauthorized stop');
  assert.ok(state.logs.some((l) => l.level === 'error' && /rejected the bot token/.test(l.message)));
});

test('charts are uploaded as multipart photos', async (t) => {
  const mock = await new MockTelegram().listen();
  t.after(() => mock.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozzlf-tg-'));
  const file = path.join(dir, 'chart.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  const notifier = new TelegramNotifier(TOKEN, CHAT_ID, mock.base);
  const sent = await notifier.sendPhoto(file, '📈 <b>EURUSD</b>');
  assert.equal(sent.ok, true);
  const photo = mock.methodCalls('sendPhoto')[0];
  assert.match(String(photo.headers['content-type']), /multipart\/form-data/);
  assert.ok(photo.bytes > 100, 'photo body contains the file and caption');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('escapeHtml keeps Telegram HTML safe', () => {
  assert.equal(escapeHtml('<b>&x</b>'), '&lt;b&gt;&amp;x&lt;/b&gt;');
});
