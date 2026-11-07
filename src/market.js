'use strict';

const config = require('./config');
const { CATALOG } = require('./market-catalog');

const CATALOG_BY_SYMBOL = new Map(CATALOG.map((item) => [item.symbol, item]));

const YAHOO_SYMBOLS = Object.fromEntries(
  CATALOG.map((item) => [item.symbol, item.yahoo]),
);
// Keep the seven default symbols working even if the catalog changes.
for (const symbol of config.SYMBOLS) {
  const item = CATALOG_BY_SYMBOL.get(symbol);
  if (item && !YAHOO_SYMBOLS[symbol]) YAHOO_SYMBOLS[symbol] = item.yahoo;
}

const INTERVAL_MAP = { M5: '5m', M15: '15m', H1: '1h', H4: '1h', D1: '1d' };
const RANGE_MAP = { M5: '5d', M15: '5d', H1: '1mo', H4: '1mo', D1: '6mo' };
const TF_SECONDS = { M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 };

const PIP_SIZE = Object.fromEntries(CATALOG.map((item) => [item.symbol, item.pip]));
for (const symbol of config.SYMBOLS) {
  if (!PIP_SIZE[symbol]) PIP_SIZE[symbol] = /JPY$/.test(symbol) ? 0.01 : 0.0001;
}

const BASE_SPREAD_PIPS = {
  EURUSD: 0.8, GBPUSD: 1.1, USDJPY: 0.9, AUDUSD: 1.0,
  USDCAD: 1.3, NZDUSD: 1.5, XAUUSD: 2.5,
};

class MarketDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketDataError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MarketDataService {
  constructor(options = {}) {
    this.timeout = options.timeout || 12000;
    this.cache = new Map();
    this.connected = false;
    this.lastError = null;
  }

  async close() {}

  async fetchYahoo(symbol, timeframe) {
    const ysym = YAHOO_SYMBOLS[symbol];
    if (!ysym) throw new MarketDataError(`Unsupported symbol: ${symbol}`);
    const interval = INTERVAL_MAP[timeframe];
    const range = RANGE_MAP[timeframe];
    if (!interval || !range) throw new MarketDataError(`Unsupported timeframe: ${timeframe}`);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}` +
      `?interval=${interval}&range=${range}&includePrePost=false`;
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RozlfAutoTrader/2.0)' },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (response.status === 429) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new MarketDataError(`HTTP ${response.status}`);

        const payload = await response.json();
        const result = payload?.chart?.result;
        if (!Array.isArray(result) || !result.length) {
          throw new MarketDataError(payload?.chart?.error?.description || 'no data');
        }
        const data = result[0];
        const timestamps = data.timestamp || [];
        const quote = (data.indicators?.quote || [{}])[0];
        const opens = quote.open || [];
        const highs = quote.high || [];
        const lows = quote.low || [];
        const closes = quote.close || [];
        const volumes = quote.volume || [];

        let candles = [];
        for (let i = 0; i < timestamps.length; i += 1) {
          const o = opens[i];
          const h = highs[i];
          const l = lows[i];
          const c = closes[i];
          if ([o, h, l, c].some((v) => v === null || v === undefined || !Number.isFinite(Number(v)))) continue;
          const v = Number.isFinite(Number(volumes[i])) ? Number(volumes[i]) : 0;
          candles.push({
            time: Number(timestamps[i]), open: Number(o), high: Number(h),
            low: Number(l), close: Number(c), volume: v,
          });
        }
        if (candles.length < 60) {
          throw new MarketDataError(`insufficient candles for ${symbol} ${timeframe}`);
        }
        if (timeframe === 'H4') candles = aggregate(candles, 4);

        const meta = data.meta || {};
        const price = Number(meta.regularMarketPrice || candles[candles.length - 1].close);
        const previousClose = Number(meta.chartPreviousClose || meta.previousClose || candles[0].open);
        const fetchedAt = Date.now();
        const isStale = (fetchedAt / 1000 - candles[candles.length - 1].time) > TF_SECONDS[timeframe] * 4;

        this.connected = true;
        this.lastError = null;
        return {
          symbol, timeframe, candles, price, previousClose, fetchedAt,
          source: 'yahoo', isStale,
          extra: { marketTime: meta.regularMarketTime, exchange: meta.exchangeName },
        };
      } catch (err) {
        lastError = err;
        if (err.name === 'MarketDataError' && /unsupported/i.test(err.message)) throw err;
        await sleep(800 * (attempt + 1));
      }
    }

    this.connected = false;
    this.lastError = lastError ? lastError.message : 'unknown error';
    throw new MarketDataError(`${symbol} ${timeframe}: ${this.lastError}`);
  }

  async get(symbol, timeframe, maxAgeSeconds = 20) {
    const key = `${symbol}:${timeframe}`;
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) / 1000 < maxAgeSeconds) return cached;
    const snapshot = await this.fetchYahoo(symbol, timeframe);
    this.cache.set(key, snapshot);
    return snapshot;
  }

  async latestPrice(symbol) {
    const snapshot = await this.get(symbol, 'M5', 15);
    return snapshot.price;
  }

  spreadPips(symbol, atr = null) {
    let base = BASE_SPREAD_PIPS[symbol] || 1.0;
    if (atr) {
      const pip = PIP_SIZE[symbol] || 0.0001;
      base = Math.min(base * 3, Math.max(base, base * (atr / (pip * 15))));
    }
    return Math.round(base * 100) / 100;
  }

  async testConnections(symbols) {
    const results = [];
    for (const symbol of symbols) {
      try {
        const snap = await this.get(symbol, 'M5', 5);
        results.push({
          symbol, ok: true, price: snap.price,
          candles: snap.candles.length, stale: snap.isStale,
        });
      } catch (err) {
        results.push({ symbol, ok: false, error: String(err.message).slice(0, 120) });
      }
    }
    this.connected = results.some((r) => r.ok);
    return { connected: this.connected, results };
  }
}

function aggregate(candles, factor) {
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}

function pipSize(symbol) {
  return PIP_SIZE[symbol] || 0.0001;
}

function pipValuePerLot() {
  return 10.0;
}

function catalogEntry(symbol) {
  return CATALOG_BY_SYMBOL.get(symbol) || null;
}

module.exports = {
  MarketDataService, MarketDataError, pipSize, pipValuePerLot, catalogEntry,
  PIP_SIZE, YAHOO_SYMBOLS, CATALOG_BY_SYMBOL,
};
