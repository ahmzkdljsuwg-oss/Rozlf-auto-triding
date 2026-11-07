'use strict';

/*
 * ExpertOption data session (read-only).
 *
 * Market and account data come from the ROZLF ExpertOption bridge service
 * (`eo_bridge/`, EXPERTOPTION_BRIDGE_URL), which holds the user's ExpertOption
 * session token in memory and reads the account's own asset list, quotes and
 * candles over the platform WebSocket. The token is sent as X-EO-Token and is
 * never logged, stored in the browser, or forwarded anywhere else.
 *
 * Bridge contract (JSON; Authorization: Bearer <EXPERTOPTION_BRIDGE_KEY>):
 *   GET /session     -> { connected, verified, account: { login, balance, ... } }   + X-EO-Token
 *   GET /instruments -> { instruments: [ { id, symbol, name, otc, active, payout, timeframes } ] }
 *   GET /account     -> { login, type, currency, balance, equity, free_margin, used_margin }
 *   GET /candles?instrument_id=&timeframe=&limit= -> { candles: [ ... ] }
 *   GET /quote?instrument_id=&timeframe=          -> { price, time, source, age_ms }
 *   GET /instrument/{id}/expiries?timeframe=      -> { expiries: [ ... ] }
 *
 * A stored token is never taken as proof of a working connection: verify()
 * only succeeds after the bridge returns a live account record.
 * Nothing in this module can place an order.
 */
const config = require('./config');

const POLICY_REASON_EN =
  'ExpertOption Terms & Conditions section 6.2 strictly prohibits automated players '
  + '(bots) and any implantation in the client-server relationship. Automated execution '
  + 'cannot be implemented without written authorization from ExpertOption.';
const POLICY_REASON_AR =
  'البند 6.2 من شروط ExpertOption يمنع صراحةً استخدام اللاعبين الآليين (bots) وأي تدخل '
  + 'في علاقة العميل بالخادم. لا يمكن تنفيذ التداول الآلي دون موافقة كتابية من ExpertOption.';

const SOURCE_REASON_EN =
  'ExpertOption publishes no documented public API for candles, asset discovery or balances. '
  + 'ROZLF reads them from the connected account through its own bridge service, and never places orders.';
const SOURCE_REASON_AR =
  'ExpertOption لا تنشر واجهة برمجية موثقة لقراءة الشموع أو الأصول أو الأرصدة. '
  + 'يقرأها ROZLF من الحساب المتصل عبر خدمة الربط الخاصة به، ولا ينفذ أي أوامر.';

const GATEWAY_REASON_EN =
  'The ExpertOption bridge is not configured. Set EXPERTOPTION_BRIDGE_URL and '
  + 'EXPERTOPTION_BRIDGE_KEY on the server to read live session data.';
const GATEWAY_REASON_AR =
  'خدمة ربط ExpertOption غير مهيأة. أضف EXPERTOPTION_BRIDGE_URL وEXPERTOPTION_BRIDGE_KEY '
  + 'في متغيرات البيئة لقراءة بيانات الجلسة الحقيقية.';

class ExpertOptionError extends Error {
  constructor(message, code, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ExpertOptionError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const TIMEFRAME_MS = {
  S5: 5_000, S10: 10_000, S15: 15_000, '30s': 30_000, S30: 30_000,
  M1: 60_000, M2: 120_000, M3: 180_000, M5: 300_000, M15: 900_000,
  M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};

function normalizeCandle(row, timeframe) {
  let time;
  let open;
  let high;
  let low;
  let close;
  let volume = 0;
  if (Array.isArray(row)) {
    [time, open, high, low, close, volume = 0] = row;
  } else if (row && typeof row === 'object') {
    time = row.time ?? row.timestamp ?? row.t ?? row.date;
    open = row.open ?? row.o;
    high = row.high ?? row.h;
    low = row.low ?? row.l;
    close = row.close ?? row.c;
    volume = row.volume ?? row.v ?? 0;
  } else {
    return null;
  }
  if (typeof time === 'string' && !/^\d+(\.\d+)?$/.test(time)) time = Date.parse(time);
  else time = Number(time);
  if (time !== null && time < 1e11) time *= 1000; // seconds -> ms
  const values = [open, high, low, close].map(Number);
  if (!Number.isFinite(time) || values.some((v) => !Number.isFinite(v))) return null;
  const [o, h, l, c] = values;
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  if (h < l || h < Math.max(o, c) * 0.999999 || l > Math.min(o, c) * 1.000001) return null;
  return {
    time,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: Number.isFinite(Number(volume)) ? Number(volume) : 0,
    timeframe: timeframe || null,
  };
}

class ExpertOptionSession {
  constructor({
    login, tokenPresent = false, accountType = 'demo', token = '',
    baseUrl = config.EXPERTOPTION_BRIDGE_URL || config.EXPERTOPTION_API_BASE_URL,
    apiKey = config.EXPERTOPTION_BRIDGE_KEY || config.EXPERTOPTION_API_KEY,
    account = config.EXPERTOPTION_API_ACCOUNT,
    fetchImpl = global.fetch,
    timeoutMs = config.EXPERTOPTION_API_TIMEOUT_MS,
    minIntervalMs = config.EXPERTOPTION_API_MIN_INTERVAL_MS,
    retries = config.EXPERTOPTION_API_RETRIES,
    candleCacheMs = config.EXPERTOPTION_CANDLE_CACHE_MS,
    instrumentCacheMs = config.EXPERTOPTION_INSTRUMENT_CACHE_MS,
  } = {}) {
    this.login = login || account || '';
    this.accountType = accountType;
    this.token = token || config.EXPERTOPTION_SESSION_TOKEN || '';
    this.bridgeKey = apiKey || '';
    this.tokenPresent = Boolean(tokenPresent || this.token);
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.account = account || '';
    this.accountLoginWarning = null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.retries = retries;
    this.candleCacheMs = candleCacheMs;
    this.instrumentCacheMs = instrumentCacheMs;

    this.connected = false;
    this.verified = false;
    this.verifiedAt = null;
    this.lastError = null;
    this.sessionExpired = false;
    this.accountInfoCache = null;
    this._instruments = null;
    this._instrumentsAt = 0;
    this._candleCache = new Map();
    this._lastRequestAt = 0;
    this.createdAt = new Date().toISOString();
  }

  get configured() { return Boolean(this.baseUrl && this.token && this.bridgeKey); }
  get demo() { return this.accountType !== 'real'; }

  _state() {
    if (!this.configured) return this.tokenPresent ? 'token_saved_unverified' : 'no_credentials';
    if (this.sessionExpired) return 'session_expired';
    if (this.connected && this.verified) return 'connected';
    return 'configured_unverified';
  }

  status() {
    return {
      platform: 'expertoption',
      account_type: this.accountType,
      login: this.login,
      token_present: this.tokenPresent,
      token_stored_encrypted: this.tokenPresent,
      gateway_configured: this.configured,
      bridge_configured: this.configured,
      connection_state: this._state(),
      connected: this.connected,
      verified: this.verified,
      verified_at: this.verifiedAt,
      session_expired: this.sessionExpired,
      official_api_available: false,
      official_integration: integrationStatus(),
      account_data_available: Boolean(this.configured && this.connected),
      market_data_available: Boolean(this.configured && this.connected && this._instruments && this._instruments.length),
      instruments_cached: this._instruments ? this._instruments.length : 0,
      account: this.accountInfoCache,
      account_login_warning: this.accountLoginWarning,
      last_error: this.lastError,
      reason_en: this.configured ? this.lastError : (this.tokenPresent ? GATEWAY_REASON_EN : 'No ExpertOption credential was supplied.'),
      reason_ar: this.configured ? null : GATEWAY_REASON_AR,
      created_at: this.createdAt,
    };
  }

  // Reachability probe for the bridge service itself (no secrets, no market data).
  async diagnostics() {
    let host = '';
    try { host = this.baseUrl ? new URL(this.baseUrl).host : ''; } catch { host = ''; }
    const base = { configured: this.configured, bridge_host: host, reachable: false };
    if (!this.baseUrl) return { ...base, error: 'EXPERTOPTION_BRIDGE_URL is not set' };
    const startedAt = Date.now();
    try {
      const headers = { Accept: 'application/json' };
      if (this.bridgeKey) headers.Authorization = `Bearer ${this.bridgeKey}`;
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET', headers, signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10000)),
      });
      const latency = Date.now() - startedAt;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const authFailed = response.status === 401 || response.status === 403;
        return {
          ...base, latency_ms: latency, status: response.status,
          auth_failed: authFailed,
          error: authFailed
            ? `Bridge rejected the key (HTTP ${response.status} unauthorized/invalid key)`
            : `Bridge health returned HTTP ${response.status}`,
        };
      }
      return {
        ...base,
        reachable: true,
        latency_ms: latency,
        service: data.service || null,
        version: data.version || null,
        demo_only: Boolean(data.demo_only),
        trading_enabled: Boolean(data.trading_enabled),
        read_any_account: Boolean(data.read_any_account),
        key_configured: Boolean(data.key_configured),
        session_connected: Boolean(data.session_connected ?? data.connected),
        upstream: data.upstream || null,
      };
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        ...base,
        latency_ms: Date.now() - startedAt,
        error: timedOut ? 'Bridge health check timed out' : `Bridge unreachable: ${err.message}`,
      };
    }
  }

  async _throttle() {
    if (!this.minIntervalMs) return;
    const wait = this._lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastRequestAt = Date.now();
  }

  async _request(path, { query, retries = this.retries } = {}) {
    if (!this.configured) throw new ExpertOptionError(GATEWAY_REASON_EN, 'not_configured');
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let attempt = 0;
    for (;;) {
      await this._throttle();
      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.bridgeKey}`,
            'X-EO-Token': this.token,
            'X-EO-Demo': this.demo ? '1' : '0',
            Accept: 'application/json',
            ...(this.account ? { 'X-Account-Login': this.account } : {}),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (attempt < retries) { attempt += 1; await new Promise((r) => setTimeout(r, 200 * attempt)); continue; }
        throw new ExpertOptionError(
          timedOut ? 'ExpertOption gateway timed out' : `ExpertOption gateway unreachable: ${err.message}`,
          timedOut ? 'timeout' : 'network',
        );
      }
      if (response.status === 401 || response.status === 403) {
        const detail = await response.json().catch(() => null);
        const detailText = typeof detail?.detail === 'string'
          ? detail.detail
          : String(detail?.detail?.message || detail?.detail?.code || '');
        const keyRejected = /unauthorized(?!.*token)|bridge key|api key/i.test(detailText)
          && !/x-eo-token|session/i.test(detailText);
        this.connected = false;
        this.verified = false;
        this.sessionExpired = !keyRejected;
        this.lastError = keyRejected
          ? 'The bridge rejected EO_BRIDGE_API_KEY (401 Unauthorized); ExpertOption was never contacted'
          : 'ExpertOption session rejected by the gateway (expired or unauthorized)';
        throw new ExpertOptionError(this.lastError, keyRejected ? 'bridge_auth_failed' : 'session_expired', {
          status: response.status,
        });
      }
      if (response.status === 502) {
        this.connected = false;
        this.verified = false;
        const detail = await response.json().catch(() => null);
        const inner = detail && (detail.error || detail);
        const upstream = inner && typeof inner === 'object' ? String(inner.code || '') : '';
        const text = inner && typeof inner === 'object' ? String(inner.message || '') : '';
        if (upstream === 'connect_failed') {
          this.lastError = text || 'The bridge could not reach ExpertOption';
          throw new ExpertOptionError(this.lastError.slice(0, 200), 'connect_failed', { status: 502 });
        }
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = Number(response.headers?.get?.('retry-after') || 0) * 1000;
        if (attempt < retries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(retryAfterMs || 300 * attempt, 5000)));
          continue;
        }
        throw new ExpertOptionError(
          response.status === 429 ? 'ExpertOption gateway rate limit reached' : `ExpertOption gateway error ${response.status}`,
          response.status === 429 ? 'rate_limited' : 'upstream_error',
          { status: response.status, retryAfterMs: retryAfterMs || null },
        );
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const inner = detail && (detail.error || detail);
        const code = inner && typeof inner === 'object' ? String(inner.code || '') : '';
        const message = inner && typeof inner === 'object'
          ? String(inner.message || inner.error || `HTTP ${response.status}`)
          : `ExpertOption gateway returned HTTP ${response.status}`;
        if (code === 'stale_data') {
          throw new ExpertOptionError(message.slice(0, 200), 'stale_data', { status: response.status });
        }
        if (code === 'no_candles') {
          throw new ExpertOptionError(message.slice(0, 200), 'no_candles', { status: response.status });
        }
        if (code === 'timeframe_unsupported') {
          throw new ExpertOptionError(message.slice(0, 200), 'timeframe_unsupported', { status: response.status });
        }
        if (code === 'real_read_disabled') {
          throw new ExpertOptionError(message.slice(0, 200), 'real_read_disabled', { status: response.status });
        }
        if (code === 'connect_failed' || response.status === 502) {
          throw new ExpertOptionError(message.slice(0, 200), 'connect_failed', { status: response.status });
        }
        if (response.status === 401 || response.status === 403) {
          throw new ExpertOptionError(message.slice(0, 200), 'bridge_unauthorized', { status: response.status });
        }
        throw new ExpertOptionError(message.slice(0, 200), 'bad_response', { status: response.status });
      }
      let data;
      try { data = await response.json(); } catch { throw new ExpertOptionError('ExpertOption gateway returned invalid JSON', 'bad_payload'); }
      if (data && data.ok === false) {
        throw new ExpertOptionError(String(data.error || data.detail || 'ExpertOption gateway refused the request').slice(0, 200), 'upstream_refused');
      }
      return data;
    }
  }

  async verify() {
    this.lastError = null;
    if (!this.configured) {
      this.connected = false;
      this.verified = false;
      this.sessionExpired = false;
      this.lastError = GATEWAY_REASON_EN;
      return this.status();
    }
    try {
      const data = await this._request('/session', { retries: 0 });
      const account = data?.account || data?.data?.account || null;
      if (!account || account.login === undefined || account.login === null) {
        throw new ExpertOptionError('ExpertOption gateway response is missing the account record', 'bad_payload');
      }
      // The entered login may be an email while the gateway reports a numeric account id,
      // so only the operator-pinned EXPERTOPTION_API_ACCOUNT is treated as a hard match.
      if (this.account && String(account.login) !== String(this.account)) {
        throw new ExpertOptionError('ExpertOption gateway returned a different account login', 'account_mismatch');
      }
      this.accountLoginWarning = this.login && String(account.login) !== String(this.login)
        ? 'The entered login differs from the account id reported by the gateway; the gateway account is used.'
        : null;
      const balance = Number(account.balance);
      this.accountInfoCache = {
        login: String(account.login),
        type: String(account.type || account.account_type || this.accountType),
        currency: String(account.currency || 'USD'),
        balance: Number.isFinite(balance) ? balance : null,
        equity: Number.isFinite(Number(account.equity)) ? Number(account.equity) : (Number.isFinite(balance) ? balance : null),
        free_margin: Number.isFinite(Number(account.free_margin ?? account.freeMargin)) ? Number(account.free_margin ?? account.freeMargin) : null,
        used_margin: Number.isFinite(Number(account.used_margin ?? account.usedMargin)) ? Number(account.used_margin ?? account.usedMargin) : null,
        expires_at: data?.expires_at || null,
      };
      this.connected = true;
      this.verified = true;
      this.sessionExpired = false;
      this.verifiedAt = new Date().toISOString();
      return this.status();
    } catch (err) {
      this.connected = false;
      this.verified = false;
      this.lastError = String(err.message || 'ExpertOption verification failed').slice(0, 240);
      return this.status();
    }
  }

  async accountInfo() {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    try {
      const data = await this._request('/account');
      const account = data?.account || data || {};
      const balance = Number(account.balance);
      if (!Number.isFinite(balance)) throw new ExpertOptionError('ExpertOption gateway returned no balance', 'bad_payload');
      return {
        login: String(account.login || this.login),
        type: String(account.type || account.account_type || this.accountType),
        currency: String(account.currency || 'USD'),
        balance,
        equity: Number(account.equity ?? balance),
        free_margin: Number(account.free_margin ?? account.freeMargin ?? 0),
        used_margin: Number(account.used_margin ?? account.usedMargin ?? 0),
        read_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err.code === 'session_expired') throw err;
      if (this.accountInfoCache) return { ...this.accountInfoCache, cached: true, read_at: new Date().toISOString() };
      throw err;
    }
  }

  async markets({ force = false } = {}) {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    const fresh = Date.now() - this._instrumentsAt < this.instrumentCacheMs;
    if (!force && this._instruments && fresh) return this._instruments;
    const data = await this._request('/instruments');
    const rows = data?.instruments || data?.data || [];
    if (!Array.isArray(rows)) throw new ExpertOptionError('ExpertOption gateway returned no instrument list', 'bad_payload');
    const instruments = rows.map((row) => {
      const id = row.id ?? row.instrument_id ?? row.asset_id;
      const name = String(row.name ?? row.symbol ?? '').trim();
      if (id === undefined || id === null || !name) return null;
      const otc = Boolean(row.otc) || /otc/i.test(name);
      return {
        id: String(id),
        symbol: String(row.symbol || name).slice(0, 40),
        name: name.slice(0, 80),
        category: String(row.category || (otc ? 'otc' : 'forex')).toLowerCase(),
        otc,
        active: row.active === undefined ? true : Boolean(row.active),
        payout: Number.isFinite(Number(row.payout)) ? Number(row.payout) : null,
        timeframes: Array.isArray(row.timeframes) ? row.timeframes.map(Number).filter(Number.isFinite) : [],
        expiries: Array.isArray(row.expiries) ? row.expiries.map(String) : null,
      };
    }).filter(Boolean);
    this._instruments = instruments;
    this._instrumentsAt = Date.now();
    return instruments;
  }

  async candles({ instrumentId, timeframe = 'M1', limit = 200 }) {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    if (instrumentId === undefined || instrumentId === null || instrumentId === '') {
      throw new ExpertOptionError('instrumentId is required', 'bad_request');
    }
    const tf = String(timeframe || 'M1').toUpperCase();
    const count = Math.max(20, Math.min(1000, Number(limit) || 200));
    const cacheKey = `${instrumentId}:${tf}:${count}`;
    const cached = this._candleCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.candleCacheMs) return cached.candles;

    const data = await this._request('/candles', { query: { instrument_id: instrumentId, timeframe: tf, limit: count } });
    const rows = data?.candles || data?.data || [];
    if (!Array.isArray(rows) || rows.length === 0) throw new ExpertOptionError('ExpertOption gateway returned no candles', 'no_data');
    const candles = rows.map((row) => normalizeCandle(row, tf)).filter(Boolean);
    if (candles.length < rows.length * 0.8) {
      throw new ExpertOptionError('ExpertOption candle payload is malformed', 'bad_payload');
    }
    candles.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const candle of candles) {
      if (deduped.length && deduped[deduped.length - 1].time === candle.time) deduped[deduped.length - 1] = candle;
      else deduped.push(candle);
    }
    const step = TIMEFRAME_MS[tf];
    if (step && deduped.length > 10) {
      const gaps = deduped.filter((c, i) => i > 0 && c.time - deduped[i - 1].time > step * 3).length;
      if (gaps > deduped.length * 0.2) {
        throw new ExpertOptionError('ExpertOption candle series has too many gaps', 'bad_payload');
      }
    }
    this._candleCache.set(cacheKey, { at: Date.now(), candles: deduped });
    return deduped;
  }

  async quote({ instrumentId, timeframe = 'M1', stream = false } = {}) {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    if (instrumentId === undefined || instrumentId === null || instrumentId === '') {
      throw new ExpertOptionError('instrumentId is required', 'bad_request');
    }
    const tf = String(timeframe || 'M1').toUpperCase();
    const data = await this._request('/quote', {
      query: { instrument_id: instrumentId, timeframe: tf, stream: stream ? 1 : undefined },
      retries: 1,
    });
    const price = Number(data?.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new ExpertOptionError('ExpertOption bridge returned no live price', 'no_data');
    }
    return {
      instrument_id: String(instrumentId),
      timeframe: tf,
      price,
      time: Number.isFinite(Number(data?.time)) ? Number(data.time) : null,
      source: String(data?.source || 'candles'),
      age_ms: Number.isFinite(Number(data?.age_ms)) ? Number(data.age_ms) : null,
      read_at: new Date().toISOString(),
    };
  }

  async expiries({ instrumentId, timeframe = 'M1' } = {}) {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    const tf = String(timeframe || 'M1').toUpperCase();
    const data = await this._request(`/instrument/${encodeURIComponent(instrumentId)}/expiries`, {
      query: { timeframe: tf },
      retries: 0,
    });
    const rows = Array.isArray(data?.expiries) ? data.expiries.map(Number).filter((v) => Number.isFinite(v) && v > 0) : [];
    return { expiries: rows, source: String(data?.source || 'unavailable') };
  }

  async instrumentDetail(instrumentId, { timeframe = 'M1', probe = true } = {}) {
    if (!this.verified) throw new ExpertOptionError('ExpertOption session is not verified', 'not_verified');
    if (instrumentId === undefined || instrumentId === null || instrumentId === '') {
      throw new ExpertOptionError('instrumentId is required', 'bad_request');
    }
    return this._request(`/instrument/${encodeURIComponent(instrumentId)}`, {
      query: { timeframe: String(timeframe || 'M1').toUpperCase(), probe: probe ? 'true' : 'false' },
      retries: 0,
    });
  }

  clearCache() {
    this._instruments = null;
    this._instrumentsAt = 0;
    this._candleCache.clear();
  }
}

function integrationStatus() {
  const configured = Boolean(
    (config.EXPERTOPTION_BRIDGE_URL || config.EXPERTOPTION_API_BASE_URL)
    && (config.EXPERTOPTION_BRIDGE_KEY || config.EXPERTOPTION_API_KEY),
  );
  return {
    platform: 'expertoption',
    official_api_available: false,
    documented_api_found: false,
    authorized_gateway_configured: configured,
    bridge_configured: configured,
    read_only: true,
    trading_api_available: false,
    account_data_api_available: configured,
    market_data_api_available: configured,
    policy_allows_bots: false,
    execution_supported: false,
    analysis_only: true,
    policy_clause: '6.2',
    policy_url: 'https://expertoption.com/company/policy/terms/',
    policy_reason_en: POLICY_REASON_EN,
    policy_reason_ar: POLICY_REASON_AR,
    source_reason_en: configured ? null : SOURCE_REASON_EN,
    source_reason_ar: configured ? null : SOURCE_REASON_AR,
    next_step_en: configured
      ? 'Analysis reads the connected account through the ROZLF bridge. Execution stays disabled (read-only).'
      : 'Deploy eo_bridge and set EXPERTOPTION_BRIDGE_URL + EXPERTOPTION_BRIDGE_KEY. Execution stays disabled (read-only).',
    next_step_ar: configured
      ? 'التحليل يقرأ الحساب المتصل عبر خدمة الربط. التنفيذ يبقى معطلاً (قراءة فقط).'
      : 'شغّل خدمة eo_bridge واضبط EXPERTOPTION_BRIDGE_URL وEXPERTOPTION_BRIDGE_KEY. التنفيذ يبقى معطلاً (قراءة فقط).',
  };
}

const INTEGRATION_STATUS = Object.freeze(integrationStatus());
const OFFICIAL_API_AVAILABLE = false;

module.exports = {
  ExpertOptionSession,
  ExpertOptionError,
  OFFICIAL_API_AVAILABLE,
  INTEGRATION_STATUS,
  integrationStatus,
  normalizeCandle,
  TIMEFRAME_MS,
  POLICY_REASON_EN,
  POLICY_REASON_AR,
  SOURCE_REASON_EN,
  SOURCE_REASON_AR,
  GATEWAY_REASON_EN,
  GATEWAY_REASON_AR,
};
