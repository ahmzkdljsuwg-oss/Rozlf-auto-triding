'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { encryptSecret, decryptSecret, maskAccount, dashboardTokenOk } = require('../src/security');
const { analyzeCandles, rsi, ema } = require('../src/indicators');
const { analyzeStructure } = require('../src/smc');
const { buildSignal } = require('../src/strategy');
const { RiskManager, DEFAULTS } = require('../src/risk');
const { PaperBroker } = require('../src/brokers/paper');
const { MT5Broker } = require('../src/brokers/mt5');
const { ExpertOptionBroker } = require('../src/brokers/expertoption');
const { humanDuration } = require('../src/telegram');
const { FakeMarket, makeCandles } = require('./helpers');

test('credentials are encrypted with a random IV and decrypt back', () => {
  const first = encryptSecret('SuperSecret!23');
  const second = encryptSecret('SuperSecret!23');
  assert.notEqual(first, second);
  assert.match(first, /^v1\./);
  assert.equal(decryptSecret(first), 'SuperSecret!23');
  assert.equal(decryptSecret('broken'), '');
  assert.equal(maskAccount('12345678'), '12****78');
  if (config.DASHBOARD_TOKEN) {
    assert.equal(dashboardTokenOk(config.DASHBOARD_TOKEN), true);
    assert.equal(dashboardTokenOk('nope'), false);
  } else {
    assert.equal(dashboardTokenOk(''), false, 'without a configured token /api must stay locked');
    assert.equal(dashboardTokenOk('anything'), false);
    const previous = config.ALLOW_INSECURE_DASHBOARD;
    config.ALLOW_INSECURE_DASHBOARD = true;
    assert.equal(dashboardTokenOk(''), true, 'explicit local override opens it');
    config.ALLOW_INSECURE_DASHBOARD = previous;
  }
});

test('indicator output stays inside sane bounds', () => {
  const candles = makeCandles('EURUSD', 'M5', 200, 1);
  const analysis = analyzeCandles(candles);
  assert.ok(analysis.rsi > 0 && analysis.rsi <= 100);
  assert.ok(analysis.ema20 > 0);
  assert.ok(analysis.atr > 0);
  assert.equal(rsi(candles.map((c) => c.close)).length, candles.length);
  assert.equal(ema(candles.map((c) => c.close), 20).length, candles.length);
});

test('SMC structure returns swings and note fields', () => {
  const structure = analyzeStructure(makeCandles('GBPUSD', 'M15', 200, 1));
  assert.ok(Array.isArray(structure.swings));
  assert.ok(['bullish', 'bearish', 'neutral'].includes(structure.structure.bias));
  assert.ok(Array.isArray(structure.notes));
});

test('strategy yields a sized signal with stop and target', () => {
  const market = new FakeMarket();
  return market.get('EURUSD', 'M5').then(async () => {
    const snaps = {};
    for (const timeframe of ['D1', 'H1', 'M15', 'M5']) snaps[timeframe] = await market.get('EURUSD', timeframe);
    const signal = buildSignal('EURUSD', 'M5', snaps);
    assert.equal(signal.symbol, 'EURUSD');
    assert.ok(['BUY', 'SELL', 'NO TRADE'].includes(signal.side));
    assert.ok(signal.confidence >= 0 && signal.confidence <= 1);
    assert.ok(signal.reason_en.length > 0);
    assert.ok(signal.reason_ar.length > 0);
  });
});

test('risk manager blocks bad conditions and sizes small lots', () => {
  const risk = new RiskManager();
  const signal = {
    symbol: 'EURUSD', side: 'BUY', confidence: 0.9, entry: 1.1,
    stop_loss: 1.098, take_profit: 1.105, atr: 0.0002,
  };
  const base = {
    signal, balance: 10000, equity: 10000, openTrades: [], todayTrades: [], todayPnl: 0,
    spreadPips: 0.5, dataFresh: true, connected: true, emergencyStop: false, running: true,
  };
  const ok = risk.evaluate(base);
  assert.equal(ok.allowed, true);
  assert.ok(ok.lot >= 0.01);
  assert.ok(ok.risk_amount <= (10000 * DEFAULTS.risk_percent) / 100 + 0.0001);

  assert.equal(risk.evaluate({ ...base, running: false }).allowed, false);
  assert.equal(risk.evaluate({ ...base, connected: false }).allowed, false);
  assert.equal(risk.evaluate({ ...base, dataFresh: false }).allowed, false);
  assert.equal(risk.evaluate({ ...base, emergencyStop: true }).allowed, false);
  assert.equal(risk.evaluate({ ...base, spreadPips: 99 }).allowed, false);
  assert.equal(risk.evaluate({ ...base, openTrades: [{ symbol: 'EURUSD' }] }).allowed, false);
  assert.equal(risk.evaluate({ ...base, signal: { ...signal, confidence: 0.2 } }).allowed, false);
  assert.equal(risk.evaluate({ ...base, todayPnl: -10000 }).allowed, false);
});

test('paper broker fills with slippage and books real P/L', async () => {
  const broker = new PaperBroker(10000, new FakeMarket());
  const info = await broker.connect('demo1', 'secret');
  assert.equal(info.is_demo, true);
  const order = await broker.openOrder('EURUSD', 'BUY', 0.10, 1.095, 1.105, 1.1);
  assert.equal(order.accepted, true);
  assert.ok(order.order_id);
  const entry = order.fill_price;
  const close = await broker.closeOrder(order.order_id, 'EURUSD', 'BUY', 0.10, entry + 0.002);
  const pnl = broker.realizedPnl('EURUSD', 'BUY', entry, close.fill_price, 0.10);
  assert.ok(pnl > 0);
  broker.applyPnl(pnl);
  assert.ok((await broker.accountInfo()).balance > 10000);
});

test('MT5 and ExpertOption refuse execution without approved access', async () => {
  const mt5 = new MT5Broker();
  await assert.rejects(() => mt5.connect('1', 'x'), /bridge|enabled/i);
  const eo = new ExpertOptionBroker();
  assert.equal(eo.supportsExecution, false);
  await assert.rejects(() => eo.connect('1', 'x'), /no approved public trading API/);
});

test('MT5 execution account guard rejects wrong login, server and real accounts', () => {
  const broker = new MT5Broker();
  broker.isDemo = true;
  broker.expectedLogin = '900123';
  broker.expectedServer = 'MetaQuotes-Demo';
  const ok = { account: { login: '900123', server: 'MetaQuotes-Demo', is_demo: true } };
  assert.doesNotThrow(() => broker.checkExecutionAccount(ok));
  assert.throws(() => broker.checkExecutionAccount({}), /account snapshot/);
  assert.throws(
    () => broker.checkExecutionAccount({ account: { login: '111', server: 'MetaQuotes-Demo' } }),
    /expected 900123/,
  );
  assert.throws(
    () => broker.checkExecutionAccount({ account: { login: '900123', server: 'Other-Demo' } }),
    /expected MetaQuotes-Demo/,
  );
  assert.throws(
    () => broker.checkExecutionAccount({ account: { login: '900123', server: 'MetaQuotes-Demo', is_demo: false } }),
    /real account/,
  );
});

test('human duration is readable', () => {
  const start = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  assert.match(humanDuration(start), /^1h 30m$/);
});
