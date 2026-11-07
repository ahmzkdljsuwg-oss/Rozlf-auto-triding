'use strict';

const { MarketDataService } = require('../src/market');

function makeCandles(symbol, timeframe, count = 320, trend = 1) {
  const stepSeconds = { M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 }[timeframe] || 300;
  const base = symbol === 'USDJPY' ? 150 : symbol === 'XAUUSD' ? 2000 : 1.1;
  const pip = symbol === 'USDJPY' ? 0.01 : symbol === 'XAUUSD' ? 0.1 : 0.0001;
  const now = Math.floor(Date.now() / 1000);
  const candles = [];
  let price = base;
  for (let i = count - 1; i >= 0; i -= 1) {
    const wave = Math.sin(i / 7) * pip * 4;
    const drift = trend * pip * 0.9;
    const open = price;
    const close = open + drift + wave * 0.15;
    const high = Math.max(open, close) + pip * 2.5 + Math.abs(wave) * 0.2;
    const low = Math.min(open, close) - pip * 2.5 - Math.abs(wave) * 0.2;
    candles.push({
      time: now - i * stepSeconds,
      open, high, low, close, volume: 1000 + (i % 50) * 10,
    });
    price = close;
  }
  return candles;
}

class FakeMarket extends MarketDataService {
  constructor(options = {}) {
    super(options);
    this.failSymbols = new Set(options.failSymbols || []);
    this.staleSymbols = new Set(options.staleSymbols || []);
    this.trends = options.trends || {};
  }

  async get(symbol, timeframe) {
    if (this.failSymbols.has(symbol)) throw new Error(`simulated feed failure for ${symbol}`);
    const candles = makeCandles(symbol, timeframe, 320, this.trends[symbol] ?? 1);
    return {
      symbol, timeframe, candles, price: candles[candles.length - 1].close,
      previousClose: candles[0].open, fetchedAt: Date.now(), source: 'fake',
      isStale: this.staleSymbols.has(symbol),
    };
  }

  async latestPrice(symbol) {
    const snap = await this.get(symbol, 'M5');
    return snap.price;
  }

  async testConnections(symbols) {
    const results = [];
    for (const symbol of symbols) {
      try {
        const snap = await this.get(symbol, 'M5');
        results.push({ symbol, ok: true, price: snap.price, candles: snap.candles.length, stale: snap.isStale });
      } catch (err) {
        results.push({ symbol, ok: false, error: err.message });
      }
    }
    return { connected: results.some((r) => r.ok), results };
  }
}

module.exports = { FakeMarket, makeCandles };
