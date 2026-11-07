'use strict';

const config = require('./config');
const { pipSize, pipValuePerLot } = require('./market');

const DEFAULTS = {
  risk_percent: config.DEFAULT_RISK_PERCENT,
  daily_loss_limit_percent: config.DEFAULT_DAILY_LOSS_LIMIT_PERCENT,
  max_open_trades: config.DEFAULT_MAX_OPEN_TRADES,
  max_daily_trades: config.DEFAULT_MAX_DAILY_TRADES,
  min_confidence: config.DEFAULT_MIN_CONFIDENCE,
  max_spread_pips: config.MAX_SPREAD_PIPS,
};

class RiskManager {
  constructor(settings = {}) {
    this.settings = { ...DEFAULTS, ...(settings || {}) };
  }

  get(key) {
    const value = Number(this.settings[key]);
    return Number.isFinite(value) ? value : DEFAULTS[key];
  }

  dailyLossLimit(balance) {
    return (Number(balance || 0) * this.get('daily_loss_limit_percent')) / 100;
  }

  evaluate({
    signal, balance, equity, openTrades = [], todayTrades = [],
    todayPnl = 0, spreadPips = 0, dataFresh = true, connected = true,
    accountSynced = true, freeMargin = null, marginLevel = null,
    emergencyStop = false, running = true, minConfidence = null,
  }) {
    const riskPercent = this.get('risk_percent');
    const reject = (reason) => ({
      allowed: false, reason, lot: 0, risk_amount: 0,
      risk_percent: riskPercent, stop_pips: 0, rr: 0,
    });

    if (!running) return reject('Bot is not running');
    if (emergencyStop) return reject('Emergency stop active');
    if (!connected) return reject('Trading account not connected');
    if (!accountSynced) return reject('MT5 account is not synced');
    if (!dataFresh) return reject('Market data is stale');
    if (marginLevel !== null && Number.isFinite(Number(marginLevel)) && Number(marginLevel) < 100) {
      return reject(`Margin level ${Number(marginLevel).toFixed(0)}% is too low`);
    }

    const confidence = Number(signal.confidence || 0);
    const threshold = Math.max(
      this.get('min_confidence'),
      Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0,
    );
    if (signal.side !== 'BUY' && signal.side !== 'SELL') return reject('Signal is NO TRADE');
    if (confidence < threshold) {
      return reject(`Confidence ${confidence.toFixed(2)} below ${threshold}`);
    }

    if (openTrades.length >= this.get('max_open_trades')) {
      return reject(`Max open trades reached (${this.get('max_open_trades')})`);
    }
    if (openTrades.some((t) => t.symbol === signal.symbol)) {
      return reject(`A trade on ${signal.symbol} is already open`);
    }
    if (todayTrades.length >= this.get('max_daily_trades')) {
      return reject(`Max daily trades reached (${this.get('max_daily_trades')})`);
    }
    if (Number(spreadPips) > this.get('max_spread_pips')) {
      return reject(`Spread ${Number(spreadPips).toFixed(2)} exceeds ${this.get('max_spread_pips')}`);
    }

    const limit = this.dailyLossLimit(balance);
    if (todayPnl <= -limit) {
      return reject(`Daily loss limit reached (${limit.toFixed(2)})`);
    }

    const entry = Number(signal.entry);
    const stop = Number(signal.stop_loss);
    const target = Number(signal.take_profit);
    if (!(entry > 0) || !(stop > 0) || !(target > 0)) return reject('Invalid price levels');

    const riskDistance = Math.abs(entry - stop);
    const rewardDistance = Math.abs(target - entry);
    const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    if (rr < 1.4) return reject(`Reward/risk ${rr.toFixed(2)} below 1.4`);

    const pip = pipSize(signal.symbol);
    const stopPips = riskDistance / pip;
    const riskAmount = (Number(balance || 0) * riskPercent) / 100;
    let lot = riskAmount / Math.max(stopPips * pipValuePerLot(), 1e-9);
    lot = Math.floor(lot / 0.01) * 0.01;
    lot = Math.min(lot, 10);
    lot = Math.round(lot * 100) / 100;

    if (lot < 0.01) return reject('Account balance too small for minimum lot at this risk');
    if (riskAmount > Number(balance || 0) * 0.05) return reject('Risk per trade exceeds 5% guard');
    if (freeMargin !== null && Number.isFinite(Number(freeMargin)) && Number(freeMargin) < riskAmount) {
      return reject('Free margin is below the risk amount');
    }

    return {
      allowed: true,
      reason: 'All risk checks passed',
      lot,
      risk_amount: Math.round(riskAmount * 100) / 100,
      risk_percent: riskPercent,
      stop_pips: Math.round(stopPips * 10) / 10,
      rr: Math.round(rr * 100) / 100,
    };
  }
}

module.exports = { RiskManager, DEFAULTS };
