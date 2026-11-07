'use strict';

const { CATALOG, CATEGORIES, UNAVAILABLE_CATEGORIES } = require('./market-catalog');
const { buildSignal } = require('./strategy');

const EXECUTION_BLOCKED_REASON =
  'ExpertOption does not publish an approved trading API. The scanner is analysis-only; '
  + 'no Demo or Real order can be executed on this platform.';

const DEFAULT_TIMEFRAMES = ['M15', 'H1'];
const TIMEFRAME_MINUTES = { M5: 20, M15: 60, H1: 240, H4: 960, D1: 5760 };

const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
};

function durationEstimate(timeframe, adx) {
  const base = TIMEFRAME_MINUTES[timeframe] || 60;
  const factor = Number(adx) >= 25 ? 1.5 : Number(adx) >= 18 ? 1.15 : 0.8;
  return Math.round(base * factor);
}

class MarketScanner {
  constructor({ market, concurrency = 6, cacheMs = 60000 } = {}) {
    if (!market) throw new Error('MarketScanner requires a market data service');
    this.market = market;
    this.concurrency = Math.max(1, Math.min(10, Number(concurrency) || 6));
    this.cacheMs = Math.max(15000, Number(cacheMs) || 60000);
    this.rows = new Map();
    this.scan = this._emptyScan();
    this._promise = null;
    this._timer = null;
    this._auto = false;
    this._autoIntervalMs = 90000;
    this._account = null;
    this._ensureRows();
  }

  _emptyScan() {
    return {
      running: false,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      last_error: null,
      total: CATALOG.length,
      scanned: 0,
      available: 0,
      stale: 0,
      failed: 0,
      qualified: 0,
      buys: 0,
      sells: 0,
      no_trade: 0,
    };
  }

  _ensureRows() {
    for (const item of CATALOG) {
      if (this.rows.has(item.symbol)) continue;
      this.rows.set(item.symbol, {
        ...item,
        price: null,
        change_percent: null,
        trend: 'unknown',
        signal: 'NO TRADE',
        confidence: 0,
        strength: 0,
        adx: null,
        rsi: null,
        atr: null,
        support: null,
        resistance: null,
        structure: { bos: null, choch: null, bias: 'neutral' },
        reason_en: '',
        reason_ar: '',
        duration_minutes: null,
        timeframe: 'M15',
        status: 'pending',
        source: 'yahoo',
        broker_verified: false,
        last_updated: null,
        error: null,
      });
    }
  }

  reset() {
    this.stopAuto();
    this.rows.clear();
    this._ensureRows();
    this.scan = this._emptyScan();
    this._account = null;
  }

  bindAccount(account) {
    this._account = account
      ? { id: account.id, login: account.login, platform: account.platform, account_type: account.account_type }
      : null;
  }

  startScan() {
    if (this.scan.running) return this.status();
    this.scan = {
      ...this._emptyScan(),
      running: true,
      started_at: new Date().toISOString(),
    };
    this._promise = this._runScan()
      .catch(() => {})
      .finally(() => {
        this.scan.running = false;
        this._promise = null;
      });
    return this.status();
  }

  async scanNow() {
    if (this.scan.running && this._promise) {
      await this._promise;
      return this.status();
    }
    this.startScan();
    await this._promise;
    return this.status();
  }

  async _runScan() {
    const started = Date.now();
    const items = [...this.rows.values()];
    let cursor = 0;
    const results = new Array(items.length);

    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this._scanOne(items[index]);
      }
    };
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, () => worker());
    await Promise.all(workers);

    for (const row of results) {
      if (!row) continue;
      this.rows.set(row.symbol, row);
    }

    const rows = [...this.rows.values()];
    this.scan = {
      running: false,
      started_at: this.scan.started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      last_error: null,
      total: rows.length,
      scanned: rows.filter((r) => r.status !== 'pending').length,
      available: rows.filter((r) => r.status === 'qualified' || r.status === 'no_trade').length,
      stale: rows.filter((r) => r.status === 'stale').length,
      failed: rows.filter((r) => r.status === 'unavailable').length,
      qualified: rows.filter((r) => r.status === 'qualified').length,
      buys: rows.filter((r) => r.signal === 'BUY').length,
      sells: rows.filter((r) => r.signal === 'SELL').length,
      no_trade: rows.filter((r) => r.signal === 'NO TRADE' && r.status !== 'unavailable').length,
    };
  }

  async _scanOne(item) {
    try {
      const snaps = {};
      for (const timeframe of DEFAULT_TIMEFRAMES) {
        const snap = await this.market.get(item.symbol, timeframe, this.cacheMs / 1000);
        if (!snap || snap.isStale) {
          return {
            ...item,
            price: null,
            status: 'stale',
            signal: 'NO TRADE',
            confidence: 0,
            strength: 0,
            reason_en: 'Stale feed: no reliable update for this instrument.',
            reason_ar: 'بيانات قديمة: لا يوجد تحديث موثوق لهذا الأصل.',
            last_updated: new Date().toISOString(),
            error: 'stale market data',
          };
        }
        snaps[timeframe] = snap;
      }
      const signal = buildSignal(item.symbol, 'M15', snaps, {
        minConfidence: 0.62,
        requireH4: false,
      });
      const ind = signal.analysis?.indicators?.M15 || {};
      const h1 = signal.analysis?.indicators?.H1 || {};
      const structure = signal.structure?.H1?.structure || { bos: null, choch: null, bias: 'neutral' };
      const qualified = signal.side === 'BUY' || signal.side === 'SELL';
      const price = snaps.M15.price;
      const previous = snaps.M15.previousClose;
      return {
        ...item,
        price: round(price, price >= 1000 ? 2 : price >= 10 ? 3 : 5),
        change_percent: previous ? round(((price - previous) / previous) * 100, 2) : null,
        trend: ind.trend || h1.trend || 'unknown',
        signal: qualified ? signal.side : 'NO TRADE',
        confidence: signal.confidence,
        strength: Math.round(signal.confidence * 100),
        adx: round(ind.adx, 2),
        rsi: round(ind.rsi, 2),
        atr: round(ind.atr, 8),
        support: signal.analysis?.support ?? signal.support ?? null,
        resistance: signal.analysis?.resistance ?? signal.resistance ?? null,
        structure,
        reason_en: signal.reason_en,
        reason_ar: signal.reason_ar,
        duration_minutes: qualified ? durationEstimate('M15', ind.adx) : null,
        timeframe: 'M15',
        status: qualified ? 'qualified' : 'no_trade',
        source: 'yahoo',
        broker_verified: false,
        last_updated: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      return {
        ...item,
        price: null,
        status: 'unavailable',
        signal: 'NO TRADE',
        confidence: 0,
        strength: 0,
        trend: 'unknown',
        reason_en: 'No reliable market data; this instrument is excluded.',
        reason_ar: 'لا تتوفر بيانات موثوقة؛ تم استبعاد هذا الأصل.',
        last_updated: new Date().toISOString(),
        error: String(err.message || err).slice(0, 160),
      };
    }
  }

  startAuto(intervalMs = 90000) {
    this.stopAuto();
    this._auto = true;
    this._autoIntervalMs = Math.max(30000, Number(intervalMs) || 90000);
    const tick = () => {
      if (!this._auto) return;
      this.startScan();
    };
    tick();
    this._timer = setInterval(tick, this._autoIntervalMs);
    if (this._timer.unref) this._timer.unref();
    return this.status();
  }

  stopAuto() {
    this._auto = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this.status();
  }

  opportunities() {
    return [...this.rows.values()]
      .filter((row) => row.status === 'qualified' && (row.signal === 'BUY' || row.signal === 'SELL'))
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return Number(b.adx || 0) - Number(a.adx || 0);
      })
      .slice(0, 20);
  }

  status() {
    const rows = [...this.rows.values()].sort((a, b) => {
      const rank = (row) => (row.status === 'qualified' ? 0 : row.status === 'no_trade' ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.symbol.localeCompare(b.symbol);
    });
    const categories = CATEGORIES.map((category) => {
      const count = category.id === 'all'
        ? rows.length
        : rows.filter((row) => row.category === category.id).length;
      const available = category.id === 'all'
        ? rows.filter((row) => row.status !== 'pending').length
        : rows.filter((row) => row.category === category.id && row.status !== 'pending').length;
      return {
        ...category,
        count,
        available,
        unavailable_reason: UNAVAILABLE_CATEGORIES[category.id] || null,
      };
    });
    return {
      scan: { ...this.scan },
      source: 'Yahoo Finance public reference data',
      account: this._account,
      auto: this._auto,
      auto_interval_seconds: Math.round(this._autoIntervalMs / 1000),
      categories,
      markets: rows,
      opportunities: this.opportunities(),
      execution: {
        can_trade: false,
        official_integration: false,
        reason: EXECUTION_BLOCKED_REASON,
      },
      expertoption_assets: {
        official_discovery: false,
        account_specific: true,
        otc_smarty_available: false,
        reason: 'No approved ExpertOption asset endpoint. OTC and Smarty instruments are account-specific '
          + 'and are not invented here; the catalog covers public reference markets only.',
      },
    };
  }
}

module.exports = { MarketScanner, EXECUTION_BLOCKED_REASON };
