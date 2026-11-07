'use strict';

/*
 * ExpertOption data session.
 *
 * ExpertOption publishes no public API for account-scoped market data, so this
 * module talks to an *authorized* gateway that the operator configures through
 * EXPERTOPTION_API_BASE_URL / EXPERTOPTION_API_KEY. Nothing is scraped, no
 * undocumented endpoint is called, and a stored cookie or token is never taken
 * as proof of a working connection: verify() only succeeds after the gateway
 * returns a live account record.
 *
 * Documented gateway contract (all JSON, Bearer auth):
 *   GET /session     -> { ok, account: { login, type, currency, balance, ... }, expires_at }
 *   GET /instruments -> { instruments: [ { id, symbol, name, category, otc, expiries } ] }
 *   GET /account     -> { account: { ... } }
 *   GET /candles?instrument_id=&timeframe=&limit= -> { candles: [ ... ] }
 *
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
  'ExpertOption does not publish a documented API for account-scoped candles, '
  + 'asset discovery, balances or orders. No unofficial endpoint is called.';
const SOURCE_REASON_AR =
  'ExpertOption لا تنشر واجهة برمجية موثقة لقراءة شموع الحساب أو أصوله أو رصيده أو تنفيذ الأوامر. '
  + 'لا يتم استدعاء أي واجهة داخلية غير موثقة.';

const GATEWAY_REASON_EN =
  'No authorized ExpertOption data gateway is configured. Set EXPERTOPTION_API_BASE_URL '
  + 'and EXPERTOPTION_API_KEY in the server environment to enable live session data.';
const GATEWAY_REASON_AR =
  'لا توجد بوابة بيانات ExpertOption مصرح بها ومهيأة. أضف EXPERTOPTION_API_BASE_URL '
  + 'وEXPERTOPTION_API_KEY في متغيرات البيئة لتفعيل بيانات الجلسة الحقيقية.';

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
  '30s': 30_000, M1: 60_000, M2: 120_000, M5: 300_000, M15: 900_000,
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
    baseUrl = config.EXPERTOPTION_API_BASE_URL,
    apiKey = config.EXPERTOPTION_API_KEY,
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
    this.token = token || apiKey || '';
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

  get configured() { return Boolean(this.baseUrl && this.token); }

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
            Authorization: `Bearer ${this.token}`,
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
        this.connected = false;
        this.verified = false;
        this.sessionExpired = true;
        this.lastError = 'ExpertOption session rejected by the gateway (expired or unauthorized)';
        throw new ExpertOptionError(this.lastError, 'session_expired', { status: response.status });
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
        throw new ExpertOptionError(`ExpertOption gateway returned HTTP ${response.status}`, 'bad_response', { status: response.status });
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
      return {
        id: String(id),
        symbol: String(row.symbol || name).slice(0, 40),
        name: name.slice(0, 80),
        category: String(row.category || (row.otc ? 'otc' : 'forex')).toLowerCase(),
        otc: Boolean(row.otc) || /otc/i.test(name),
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

  clearCache() {
    this._instruments = null;
    this._instrumentsAt = 0;
    this._candleCache.clear();
  }
}

function integrationStatus() {
  const configured = Boolean(config.EXPERTOPTION_API_BASE_URL && config.EXPERTOPTION_API_KEY);
  return {
    platform: 'expertoption',
    official_api_available: false,
    documented_api_found: false,
    authorized_gateway_configured: configured,
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
      ? 'Data access uses the configured authorized gateway. Trading stays disabled: no execution endpoint exists.'
      : 'Configure EXPERTOPTION_API_BASE_URL and EXPERTOPTION_API_KEY with an authorized data gateway. Trading stays disabled.',
    next_step_ar: configured
      ? 'قراءة البيانات تعتمد على البوابة المصرح بها المهيأة. التداول يبقى معطلاً لعدم وجود واجهة تنفيذ.'
      : 'أضف EXPERTOPTION_API_BASE_URL وEXPERTOPTION_API_KEY لبوابة بيانات مصرح بها. التداول يبقى معطلاً.',
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
