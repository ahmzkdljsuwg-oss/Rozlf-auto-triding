'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const BASE_DIR = path.resolve(__dirname, '..');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const DATA_DIR = path.resolve(env('DATA_DIR', path.join(BASE_DIR, 'data')));
const CHART_DIR = path.join(DATA_DIR, 'charts');
fs.mkdirSync(CHART_DIR, { recursive: true });

const config = {
  BASE_DIR,
  DATA_DIR,
  CHART_DIR,
  APP_NAME: 'ROZLF AUTO TRADER',
  APP_VERSION: '2.2.0',
  PORT: Number(env('PORT', 8000)),

  SECRET_KEY: env('APP_SECRET_KEY', ''),
  SECRET_KEY_PREVIOUS: env('APP_SECRET_KEY_PREVIOUS', ''),
  DASHBOARD_TOKEN: env('DASHBOARD_TOKEN', ''),
  // Fail closed: when no dashboard token is configured, /api stays locked unless
  // this is explicitly switched on for local development only.
  ALLOW_INSECURE_DASHBOARD: bool('ALLOW_INSECURE_DASHBOARD', false),
  DATABASE_URL: env('DATABASE_URL', ''),
  DATABASE_PATH: path.resolve(env('DATABASE_PATH', path.join(DATA_DIR, 'rozzlf.db'))),

  GEMINI_API_KEY: env('GEMINI_API_KEY', ''),
  GEMINI_MODEL: env('GEMINI_MODEL', 'gemini-2.0-flash'),
  MISTRAL_API_KEY: env('MISTRAL_API_KEY', ''),
  MISTRAL_MODEL: env('MISTRAL_MODEL', 'mistral-small-latest'),
  TELEGRAM_BOT_TOKEN: env('TELEGRAM_BOT_TOKEN', ''),
  TELEGRAM_CHAT_ID: env('TELEGRAM_CHAT_ID', ''),
  // Optional private session cookie. Never expose it to the browser or logs.
  EXPERTOPTION_SESSION_COOKIE: env('EXPERTOPTION_SESSION_COOKIE', ''),

  // Authorized gateway for ExpertOption account/market data. ExpertOption itself
  // publishes no public API, so data access only works when an authorized
  // gateway implementing the documented contract is configured here. Leaving
  // these empty keeps the integration in its honest "not configured" state.
  EXPERTOPTION_BRIDGE_URL: env('EXPERTOPTION_BRIDGE_URL', env('EXPERTOPTION_API_BASE_URL', '')),
  EXPERTOPTION_BRIDGE_KEY: env('EXPERTOPTION_BRIDGE_KEY', env('EXPERTOPTION_API_KEY', '')),
  EXPERTOPTION_SESSION_TOKEN: env('EXPERTOPTION_SESSION_TOKEN', ''),
  EXPERTOPTION_RESTORE_SESSION: bool('EXPERTOPTION_RESTORE_SESSION', true),
  EXPERTOPTION_ALLOW_REAL_READ: bool('EXPERTOPTION_ALLOW_REAL_READ', false),
  EXPERTOPTION_API_BASE_URL: env('EXPERTOPTION_API_BASE_URL', ''),
  EXPERTOPTION_API_KEY: env('EXPERTOPTION_API_KEY', ''),
  EXPERTOPTION_API_ACCOUNT: env('EXPERTOPTION_API_ACCOUNT', ''),
  EXPERTOPTION_API_TIMEOUT_MS: Math.max(1000, num('EXPERTOPTION_API_TIMEOUT_MS', 10000)),
  EXPERTOPTION_API_MIN_INTERVAL_MS: Math.max(0, num('EXPERTOPTION_API_MIN_INTERVAL_MS', 250)),
  EXPERTOPTION_API_RETRIES: Math.max(0, Math.min(5, num('EXPERTOPTION_API_RETRIES', 2))),
  EXPERTOPTION_CANDLE_CACHE_MS: Math.max(0, num('EXPERTOPTION_CANDLE_CACHE_MS', 4000)),
  EXPERTOPTION_INSTRUMENT_CACHE_MS: Math.max(0, num('EXPERTOPTION_INSTRUMENT_CACHE_MS', 60000)),
  EXPERTOPTION_MAX_CANDLE_AGE_SECONDS: Math.max(30, num('EXPERTOPTION_MAX_CANDLE_AGE_SECONDS', 120)),
  EXPERTOPTION_MIN_CANDLES: Math.max(40, num('EXPERTOPTION_MIN_CANDLES', 80)),

  // Two names are accepted so an older Render service keeps working; both
  // default to false and neither enables live trading on its own.
  REAL_TRADING_APPROVED: bool('REAL_TRADING_APPROVED', false) || bool('ENABLE_REAL_TRADING', false),
  MT5_ENABLED: bool('MT5_ENABLED', false),
  MT5_BRIDGE_URL: env('MT5_BRIDGE_URL', ''),
  MT5_BRIDGE_TOKEN: env('MT5_BRIDGE_TOKEN', env('MT5_BRIDGE_API_KEY', '')),
  MT5_BRIDGE_SECRET: env('MT5_BRIDGE_SECRET', ''),
  MT5_BRIDGE_TIMEOUT_MS: num('MT5_BRIDGE_TIMEOUT_MS', 15000),
  MT5_ACCOUNT_SYNC_MAX_AGE_SECONDS: Math.max(5, num('MT5_ACCOUNT_SYNC_MAX_AGE_SECONDS', 30)),
  TRADE_REENTRY_COOLDOWN_SECONDS: Math.max(0, num('TRADE_REENTRY_COOLDOWN_SECONDS', 300)),
  // A deliberate opt-in for UI demos only. With the default false, MT5 demo
  // login fails instead of silently recording paper trades that never reach MT5.
  ALLOW_SIMULATED_MT5: bool('ALLOW_SIMULATED_MT5', false),

  SCAN_INTERVAL_SECONDS: Math.max(5, num('SCAN_INTERVAL_SECONDS', 30)),
  SYMBOLS: env('SYMBOLS', 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,NZDUSD,XAUUSD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  TIMEFRAMES: env('TIMEFRAMES', 'M5,M15,H1,H4,D1')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  DEFAULT_RISK_PERCENT: num('DEFAULT_RISK_PERCENT', 0.5),
  DEFAULT_DAILY_LOSS_LIMIT_PERCENT: num('DEFAULT_DAILY_LOSS_LIMIT_PERCENT', 3.0),
  DEFAULT_MAX_OPEN_TRADES: num('DEFAULT_MAX_OPEN_TRADES', 3),
  DEFAULT_MAX_DAILY_TRADES: num('DEFAULT_MAX_DAILY_TRADES', 10),
  DEFAULT_MIN_CONFIDENCE: num('DEFAULT_MIN_CONFIDENCE', 0.62),
  MAX_SPREAD_PIPS: num('MAX_SPREAD_PIPS', 3.0),
  DEFAULT_STOP_LOSS_PIPS: Math.max(0, num('DEFAULT_STOP_LOSS_PIPS', 0)),
  DEFAULT_TAKE_PROFIT_PIPS: Math.max(0, num('DEFAULT_TAKE_PROFIT_PIPS', 0)),
  MAX_SLIPPAGE_PIPS: num('MAX_SLIPPAGE_PIPS', 2.0),
  DEMO_START_BALANCE: num('DEMO_START_BALANCE', 10000),

  DISCLAIMER:
    'ROZLF AUTO TRADER is analytical software. Trading involves substantial risk; ' +
    'no profit is guaranteed. Real-money execution is disabled until explicitly approved. ' +
    'Demo execution is simulated against live market prices. ExpertOption is analysis-only ' +
    'because it has no approved public trading API. MT5 requires a Windows host running the ' +
    'official terminal behind the MT5 bridge.',
};

module.exports = config;
