'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ExpertOptionSession, ExpertOptionError, integrationStatus } = require('../src/expertoption-session');
const { analyzeAsset, describeAssets, resolveInstrument } = require('../src/expertoption-analysis');

const TF = { M1: 60_000, M5: 300_000 };

function makeCandles(count, { start = Date.now() - count * TF.M1, step = TF.M1, trend = 1, base = 1.1, strong = false } = {}) {
  const candles = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const drift = strong
      ? trend * 0.00003 + Math.sin(i / 20) * 0.0001
      : trend * (0.00004 + Math.sin(i / 6) * 0.000012);
    const close = open + drift;
    const high = Math.max(open, close) + 0.00002;
    const low = Math.min(open, close) - 0.00002;
    candles.push({ time: start + i * step, open, high, low, close, volume: 100 });
    price = close;
  }
  return candles;
}

function gatewayFetch({ instruments, candles, sessionStatus = 200, sessionBody = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);
    const json = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (parsed.pathname === '/session') {
      if (sessionStatus !== 200) return json(sessionStatus, { error: 'denied' });
      return json(200, sessionBody || {
        ok: true,
        account: { login: '900001', type: 'demo', currency: 'USD', balance: 10000, equity: 10120, free_margin: 9000, used_margin: 1000 },
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (parsed.pathname === '/account') {
      return json(200, { account: { login: '900001', type: 'demo', currency: 'USD', balance: 10055, equity: 10055, free_margin: 10055, used_margin: 0 } });
    }
    if (parsed.pathname === '/instruments') return json(200, { ok: true, instruments });
    if (parsed.pathname === '/candles') {
      const tf = parsed.searchParams.get('timeframe') || 'M1';
      if (typeof candles === 'function') return json(200, { ok: true, candles: candles(tf) });
      return json(200, { ok: true, candles: candles || [] });
    }
    return json(404, { error: 'not found' });
  };
  return { fetchImpl, calls };
}

const INSTRUMENTS = [
  { id: '240', symbol: 'SMARTY', name: 'Smarty', category: 'smarty', otc: false, active: true, payout: 82, timeframes: [60, 300] },
  { id: '179', symbol: 'EURUSD_OTC', name: 'EUR/USD OTC', category: 'otc', otc: true, active: true, payout: 78, timeframes: [60, 300] },
  { id: '276', symbol: 'CRICKET', name: 'Cricket Index', category: 'index', otc: false, active: true, payout: 80, timeframes: [60] },
  { id: '999', symbol: 'GER40', name: 'Germany 40', category: 'index', otc: false, active: true, payout: 80, timeframes: [60] },
];

function sessionFor(fake, overrides = {}) {
  return new ExpertOptionSession({
    login: '900001',
    baseUrl: 'https://bridge.test',
    apiKey: 'bridge-key',
    token: 'eo-session-token',
    fetchImpl: fake.fetchImpl,
    minIntervalMs: 0,
    retries: 0,
    candleCacheMs: 0,
    instrumentCacheMs: 0,
    ...overrides,
  });
}

test('an unconfigured session never reports itself as connected', async () => {
  const session = new ExpertOptionSession({ login: '900001', baseUrl: '', apiKey: '' });
  const status = await session.verify();
  assert.equal(status.verified, false);
  assert.equal(status.connected, false);
  assert.equal(status.connection_state, 'no_credentials');
  assert.equal(status.official_api_available, false);

  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.direction, 'NO TRADE');
  assert.equal(result.reason_code, 'not_connected');
  assert.equal(result.execution_allowed, false);
});

test('a stored token without a gateway is not treated as a connection', async () => {
  const session = new ExpertOptionSession({ login: '900001', baseUrl: '', apiKey: '', tokenPresent: true });
  const status = await session.verify();
  assert.equal(status.verified, false);
  assert.equal(status.connection_state, 'token_saved_unverified');
  assert.match(status.reason_en, /bridge|gateway/i);
});

test('verify reads the account from the gateway', async () => {
  const fake = gatewayFetch();
  const session = sessionFor(fake);
  const status = await session.verify();
  assert.equal(status.verified, true);
  assert.equal(status.connection_state, 'connected');
  assert.equal(status.account.balance, 10000);
  assert.equal(status.account.currency, 'USD');
  const info = await session.accountInfo();
  assert.equal(info.balance, 10055);
});

test('a rejected session is reported as expired, not connected', async () => {
  const fake = gatewayFetch({ sessionStatus: 401 });
  const session = sessionFor(fake);
  const status = await session.verify();
  assert.equal(status.verified, false);
  assert.equal(status.session_expired, true);
  assert.equal(status.connection_state, 'session_expired');
  await assert.rejects(
    () => session.candles({ instrumentId: '240', timeframe: 'M1', limit: 100 }),
    (err) => err instanceof ExpertOptionError && err.code === 'not_verified',
  );
});

test('asset ids are only trusted after matching the live instrument list', () => {
  const resolved = resolveInstrument(INSTRUMENTS, 'smarty');
  assert.ok(resolved);
  assert.equal(resolved.instrument.id, '240');
  assert.equal(resolved.resolved_by, 'name');

  const listed = describeAssets(INSTRUMENTS);
  const byKey = Object.fromEntries(listed.map((a) => [a.key, a]));
  assert.equal(byKey.smarty.available, true);
  assert.equal(byKey['eurusd-otc'].available, true);
  assert.equal(byKey['cricket-index'].available, true);
  assert.equal(byKey['usdjpy-otc'].available, false);
  assert.equal(byKey['usdjpy-otc'].id, null);
});

test('candles are normalized, sorted and de-duplicated', async () => {
  const candles = makeCandles(120);
  candles[10] = { ...candles[10], time: candles[9].time };
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles });
  const session = sessionFor(fake);
  await session.verify();
  const series = await session.candles({ instrumentId: '240', timeframe: 'M1', limit: 120 });
  assert.ok(series.length >= 119);
  for (let i = 1; i < series.length; i += 1) assert.ok(series[i].time > series[i - 1].time);
  assert.ok(series.every((c) => c.high >= c.low && c.close > 0));
});

test('malformed candle payloads are rejected instead of invented', async () => {
  const rows = makeCandles(60).map((c) => ({ time: c.time, open: 'x', high: c.high, low: c.low, close: c.close }));
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: rows });
  const session = sessionFor(fake);
  await session.verify();
  await assert.rejects(() => session.candles({ instrumentId: '240', timeframe: 'M1', limit: 60 }), /malformed|no candles/i);
});

test('analysis produces a directional or NO TRADE verdict from real candles', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(260, { strong: true }) });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, true);
  assert.ok(['UP', 'DOWN', 'NO TRADE'].includes(result.direction));
  assert.equal(result.execution_allowed, false);
  assert.equal(result.data_verified, true);
  assert.ok(result.price > 0);
  assert.ok(result.indicators.rsi > 0);
  assert.ok(result.support_resistance.support < result.support_resistance.resistance);
  assert.ok(result.reason_ar);
  if (result.direction === 'NO TRADE') assert.ok(result.reason_code);
});

test('stale candles block the analysis', async () => {
  const old = makeCandles(260, { start: Date.now() - 6 * 3600_000 });
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: old });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'stale_data');
  assert.equal(result.direction, 'NO TRADE');
});

test('a one-minute chart two and a half minutes old is refused, not analysed', async () => {
  const count = 260;
  const start = Date.now() - 150_000 - (count - 1) * TF.M1;
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(count, { start }) });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'stale_data');
  assert.equal(result.direction, 'NO TRADE');
});

test('too few candles block the analysis', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(40) });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'insufficient_data');
});

test('an asset missing from the account is refused', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(260) });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'usdchf-otc', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'asset_not_found');
});

test('unknown asset and duration are refused before any request', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(260) });
  const session = sessionFor(fake);
  await session.verify();
  assert.equal((await analyzeAsset({ session, assetKey: 'gold', expiry: '1m' })).reason_code, 'bad_asset');
  assert.equal((await analyzeAsset({ session, assetKey: 'smarty', expiry: '7m' })).reason_code, 'bad_expiry');
});

test('an AI review that disagrees with the rules yields NO TRADE', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(260, { strong: true }) });
  const session = sessionFor(fake);
  await session.verify();
  const base = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.notEqual(base.rules.direction, 'NO TRADE');
  const opposite = base.rules.direction === 'UP' ? 'DOWN' : 'UP';
  const analyzer = {
    enabled: true,
    async analyzeMarketSnapshot() {
      return { direction: opposite, confidence: 0.9, reasons: ['تعارض اختباري'], expiry_note: null };
    },
  };
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m', analyzer });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'NO TRADE');
  assert.equal(result.reason_code, 'ai_conflict');
  assert.equal(result.ai.reviewed, true);
});

test('an agreeing AI review keeps a directional verdict', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(260, { strong: true }) });
  const session = sessionFor(fake);
  await session.verify();
  const base = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.notEqual(base.rules.direction, 'NO TRADE');
  const analyzer = {
    enabled: true,
    async analyzeMarketSnapshot() {
      return { direction: base.rules.direction, confidence: 0.8, reasons: ['تأكيد اختباري'], expiry_note: 'دقيقة' };
    },
  };
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m', analyzer });
  assert.equal(result.direction, base.rules.direction);
  assert.ok(result.confidence >= 0.55);
});

test('integration status stays analysis-only', () => {
  const status = integrationStatus();
  assert.equal(status.official_api_available, false);
  assert.equal(status.execution_supported, false);
  assert.equal(status.analysis_only, true);
  assert.equal(status.policy_allows_bots, false);
});

test('a login that differs from the gateway account is a warning, not a hard failure', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: [] });
  const session = sessionFor(fake, { login: 'demo@example.com' });
  const status = await session.verify();
  assert.equal(status.verified, true);
  assert.equal(status.account.login, '900001');
  assert.match(status.account_login_warning, /differs/);
});

test('the gateway account is pinned when EXPERTOPTION_API_ACCOUNT is set', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: [] });
  const session = sessionFor(fake, { account: '555000' });
  const status = await session.verify();
  assert.equal(status.verified, false);
  assert.match(status.last_error, /different account login/);
});

test('account info refreshes from the gateway instead of reusing the session snapshot', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: [] });
  const session = sessionFor(fake);
  await session.verify();
  const info = await session.accountInfo();
  assert.equal(info.balance, 10055);
  assert.equal(info.equity, 10055);
});

test('the bridge key and the session token travel in different headers', async () => {
  const seen = [];
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: [] });
  const session = sessionFor(fake, {
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return fake.fetchImpl(url);
    },
  });
  await session.verify();
  assert.equal(seen[0].Authorization, 'Bearer bridge-key');
  assert.equal(seen[0]['X-EO-Token'], 'eo-session-token');
  assert.equal(seen[0]['X-EO-Demo'], '1');
});

test('a duration the asset does not offer is refused before any analysis', async () => {
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(200) });
  const session = sessionFor(fake, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/expiries')) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ expiries: [60] }) };
      }
      return fake.fetchImpl(url, init);
    },
  });
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '5m' });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'expiry_unsupported');
  assert.equal(result.execution_allowed, false);
});

test('a live quote is attached to the analysis when the bridge returns one', async () => {
  const now = Date.now();
  const fake = gatewayFetch({ instruments: INSTRUMENTS, candles: makeCandles(200, { start: now - 200 * TF.M1 }) });
  const session = sessionFor(fake, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/quote') {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ price: 1.23456, time: now, source: 'candles+stream', age_ms: 250 }) };
      }
      return fake.fetchImpl(url, init);
    },
  });
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, true);
  assert.equal(result.live_price, 1.23456);
  assert.equal(result.timeframe, 'M1');
});

test('an inactive asset is analysed read-only with an explicit warning', async () => {
  const instruments = INSTRUMENTS.map((i) => (i.id === '240' ? { ...i, active: false } : i));
  const fake = gatewayFetch({ instruments, candles: makeCandles(200) });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, true);
  assert.equal(result.asset_active, false);
  assert.equal(result.warnings[0].code, 'asset_inactive');
  assert.equal(result.execution_allowed, false);
});

test('an inactive asset without candles yields NO TRADE with an explicit reason', async () => {
  const instruments = INSTRUMENTS.map((i) => (i.id === '240' ? { ...i, active: false } : i));
  const fake = gatewayFetch({ instruments, candles: [] });
  const session = sessionFor(fake);
  await session.verify();
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.ok, false);
  assert.equal(result.direction, 'NO TRADE');
  assert.equal(result.reason_code, 'asset_inactive');
});

test('a bridge that lost the broker connection stops the analysis with connect_failed', async () => {
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/session' || parsed.pathname === '/account') {
      return reply(200, {
        ok: true,
        account: { login: '900001', type: 'demo', currency: 'USD', balance: 10000, equity: 10000 },
      });
    }
    if (parsed.pathname === '/instruments') return reply(200, { ok: true, instruments: INSTRUMENTS });
    return reply(502, { error: { code: 'connect_failed', message: 'Could not connect to ExpertOption' } });
  };
  const session = new ExpertOptionSession({
    login: '900001', baseUrl: 'https://bridge.test', apiKey: 'bridge-key', token: 'eo-session-token',
    fetchImpl, minIntervalMs: 0, retries: 0, candleCacheMs: 0, instrumentCacheMs: 0,
  });
  await session.verify();
  await assert.rejects(
    () => session.candles({ instrumentId: 240, timeframe: 60, limit: 10 }),
    (err) => err.code === 'connect_failed',
  );
  const result = await analyzeAsset({ session, assetKey: 'smarty', expiry: '1m' });
  assert.equal(result.direction, 'NO TRADE');
  assert.equal(session.verified, false);
  assert.ok(['connect_failed', 'not_connected'].includes(result.reason_code));
});
