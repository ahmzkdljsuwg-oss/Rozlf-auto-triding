'use strict';

const config = require('./config');
const { DEFAULTS } = require('./risk');

const RISK_BOUNDS = {
  risk_percent: { min: 0.1, max: 2, step: 0.1 },
  daily_loss_limit_percent: { min: 0.5, max: 10, step: 0.5 },
  max_open_trades: { min: 1, max: 10, step: 1 },
  max_daily_trades: { min: 1, max: 50, step: 1 },
  min_confidence: { min: 0.5, max: 0.95, step: 0.01 },
  max_spread_pips: { min: 0.5, max: 10, step: 0.1 },
  stop_loss_pips: { min: 0, max: 500, step: 1 },
  take_profit_pips: { min: 0, max: 1000, step: 1 },
};

const MODES = ['analysis', 'demo', 'live'];
const NOTIFICATION_KEYS = [
  'bot_started', 'opportunity', 'trade_open', 'trade_close', 'charts', 'daily_report',
];
const NOTIFICATION_DEFAULTS = Object.fromEntries(NOTIFICATION_KEYS.map((key) => [key, true]));

const RISK_KEYS = Object.keys(DEFAULTS);

function clampNumber(key, value) {
  const bounds = RISK_BOUNDS[key];
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${key} must be a number`);
  if (number < bounds.min || number > bounds.max) {
    throw new Error(`${key} must be between ${bounds.min} and ${bounds.max}`);
  }
  return Math.round(number * 1000) / 1000;
}

function normalizeSymbols(value) {
  const allowed = new Set(config.SYMBOLS);
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const symbols = [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter((s) => allowed.has(s)))];
  if (!symbols.length) throw new Error('At least one configured symbol is required');
  return symbols;
}

function normalizeTimeframe(value) {
  const timeframe = String(value || '').toUpperCase();
  if (!config.TIMEFRAMES.includes(timeframe)) {
    throw new Error(`Timeframe must be one of ${config.TIMEFRAMES.join(', ')}`);
  }
  return timeframe;
}

function normalizeMode(value) {
  const mode = String(value || '').toLowerCase();
  if (!MODES.includes(mode)) throw new Error('Mode must be analysis, demo or live');
  if (mode === 'live' && !config.REAL_TRADING_APPROVED) {
    throw new Error('Real trading is disabled until it is approved separately');
  }
  return mode;
}

function normalizeNotifications(value = {}) {
  const out = { ...NOTIFICATION_DEFAULTS };
  for (const key of NOTIFICATION_KEYS) {
    if (value[key] !== undefined) out[key] = Boolean(value[key]);
  }
  return out;
}

function validateValues(values, current = {}) {
  const out = {};
  for (const key of RISK_KEYS) {
    if (values[key] !== undefined) out[key] = clampNumber(key, values[key]);
  }
  if (values.symbols !== undefined) out.symbols = normalizeSymbols(values.symbols);
  if (values.timeframe !== undefined) out.timeframe = normalizeTimeframe(values.timeframe);
  if (values.mode !== undefined) out.mode = normalizeMode(values.mode);
  if (values.notifications !== undefined) out.notifications = normalizeNotifications(values.notifications);

  const merged = { ...DEFAULTS, ...current, ...out };
  if (merged.stop_loss_pips > 0 && merged.take_profit_pips > 0) {
    const rr = merged.take_profit_pips / merged.stop_loss_pips;
    if (rr < 1.4) throw new Error('Take profit must be at least 1.4x the stop loss');
  }
  return out;
}

module.exports = {
  RISK_BOUNDS, RISK_KEYS, MODES, NOTIFICATION_KEYS, NOTIFICATION_DEFAULTS,
  validateValues, normalizeSymbols, normalizeTimeframe, normalizeMode, normalizeNotifications,
};
