'use strict';

// End-to-end check of the Telegram command listener against a local stand-in for
// the Bot API: real HTTP, real long-polling loop, real command dispatch.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

function startFakeTelegram(updates) {
  const calls = [];
  let served = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = url.pathname.split('/').pop();
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method, body });
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'getMe') return send({ ok: true, result: { id: 42, username: 'rozlf_e2e_bot' } });
      if (method === 'getUpdates') {
        if (!served) {
          served = true;
          return send({ ok: true, result: updates });
        }
        return setTimeout(() => send({ ok: true, result: [] }), 50);
      }
      return send({ ok: true, result: {} });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

test('the bot receives commands over real HTTP and applies them', async (t) => {
  const chatId = '5550001';
  const updates = [
    { update_id: 10, message: { message_id: 1, from: { id: Number(chatId) }, chat: { id: Number(chatId) }, text: '/ping' } },
    {
      update_id: 11,
      callback_query: {
        id: 'cb-1',
        from: { id: Number(chatId) },
        data: 'speed:fast',
        message: { message_id: 2, chat: { id: Number(chatId) } },
      },
    },
    { update_id: 12, message: { message_id: 3, from: { id: 999 }, chat: { id: 999 }, text: '/ping' } },
  ];
  const fake = await startFakeTelegram(updates);
  const saved = { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID, TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE, TELEGRAM_POLL_SECONDS: process.env.TELEGRAM_POLL_SECONDS };
  process.env.TELEGRAM_BOT_TOKEN = '123:fake';
  process.env.TELEGRAM_CHAT_ID = chatId;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fake.port}`;
  process.env.TELEGRAM_POLL_SECONDS = '1';

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${require('path').sep}src${require('path').sep}`)) delete require.cache[key];
  }
  const { TelegramNotifier } = require('../src/telegram');
  const { TelegramBotController } = require('../src/telegram_bot');

  const settings = new Map([['telegram.offset', 10]]);
  const logs = [];
  const engine = {
    speed: 'medium',
    running: false,
    platform: 'expertoption',
    db: {
      addLog: async (level, scope, message) => { logs.push(`${level}:${scope}:${message}`); },
      getSetting: async (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
      setSetting: async (key, value) => { settings.set(key, value); },
    },
    setSpeed: async (speed) => { engine.speed = speed; },
    status: () => ({
      platform: 'expertoption', running: false, speed: engine.speed,
      balance: 0, equity: 0, today_pnl: 0, today_trades: 0,
      risk: { risk_percent: 0.5, daily_loss_limit_percent: 3, max_open_trades: 3, max_daily_trades: 10 },
      expertoption: { connection_state: 'configured_unverified' },
    }),
    telegram: null,
  };
  const notifier = new TelegramNotifier({ token: '123:fake', chatId, apiBase: `http://127.0.0.1:${fake.port}` });
  engine.telegram = notifier;
  const bot = new TelegramBotController({ notifier, engine });

  try {
    await bot.start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(bot.health, 'ok');
    assert.equal(bot.botUsername, 'rozlf_e2e_bot');
    assert.equal(engine.speed, 'fast', 'the speed callback must reach the engine');

    const sent = fake.calls.filter((c) => c.method === 'sendMessage');
    assert.ok(sent.length >= 2, 'the bot must answer /ping and the speed callback');
    assert.ok(sent.some((c) => c.body.includes('البوت يستجيب')), 'the bot must answer /ping');
    assert.ok(fake.calls.some((c) => c.method === 'answerCallbackQuery'));
    assert.ok(logs.every((line) => !line.includes('123:fake')), 'the bot token must never reach the logs');
    assert.ok(!fake.calls.some((c) => c.body.includes(chatId) && c.body.includes('999')), 'foreign chats are ignored');
  } finally {
    await bot.stop();
    fake.server.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${require('path').sep}src${require('path').sep}`)) delete require.cache[key];
    }
  }
});
