'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const { dashboardTokenOk } = require('./security');
const { RISK_KEYS } = require('./engine');

function fail(res, status, detail) {
  return res.status(status).json({ detail });
}

function isText(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function safeChartName(trade) {
  if (!trade) return trade;
  return { ...trade, chart_path: trade.chart_path ? path.basename(trade.chart_path) : '' };
}

function createApp({ engine }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; " +
      "script-src 'self'; connect-src 'self'",
    );
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true, app: config.APP_NAME, version: config.APP_VERSION,
      runtime: 'node', uptime_seconds: Math.round(process.uptime()),
    });
  });

  app.use('/api', (req, res, next) => {
    if (dashboardTokenOk(req.get('X-Dashboard-Token'))) return next();
    return fail(res, 401, 'Dashboard access token required');
  });

  app.get('/api/config', (req, res) => {
    const platforms = ['expertoption', 'mt5'];
    const accountTypes = config.REAL_TRADING_APPROVED ? ['demo', 'real'] : ['demo'];
    res.json({
      app: config.APP_NAME,
      version: config.APP_VERSION,
      platforms,
      account_types: accountTypes,
      enabled_account_types: accountTypes,
      symbols: config.SYMBOLS,
      timeframes: config.TIMEFRAMES,
      market_data_provider: 'yahoo',
      mt5_enabled: config.MT5_ENABLED && Boolean(config.MT5_BRIDGE_URL),
      expertoption_execution: false,
      real_trading_approved: config.REAL_TRADING_APPROVED,
      ai_enabled: Boolean(config.GEMINI_API_KEY),
      telegram_enabled: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
      disclaimer: config.DISCLAIMER,
    });
  });

  app.get('/api/session', async (req, res) => {
    res.json(await engine.status());
  });

  app.post('/api/connect', async (req, res) => {
    const body = req.body || {};
    const errors = [];
    if (!['expertoption', 'mt5'].includes(body.platform)) errors.push('platform must be expertoption or mt5');
    if (!['demo', 'real'].includes(body.account_type)) errors.push('account_type must be demo or real');
    if (!isText(body.login, 2, 64)) errors.push('login must be 2-64 characters');
    if (!isText(body.password, 1, 256)) errors.push('password is required');
    if (body.server !== undefined && String(body.server).length > 128) errors.push('server is too long');
    if (errors.length) return res.status(422).json({ detail: 'Validation error', errors });

    if (body.account_type === 'real' && !config.REAL_TRADING_APPROVED) {
      return fail(res, 403, 'Real trading is disabled until explicitly approved');
    }
    try {
      const status = await engine.attachAccount({
        platform: body.platform,
        accountType: body.account_type,
        login: String(body.login),
        password: String(body.password),
        server: body.server ? String(body.server) : '',
      });
      return res.json(status);
    } catch (err) {
      const message = String(err.message || 'Connection failed').slice(0, 300);
      await engine.db.addLog('warn', 'broker', `Connection failed: ${message}`);
      if (/Real trading is disabled|no approved public trading API/i.test(message)) return fail(res, 403, message);
      return fail(res, 502, message);
    }
  });

  app.post('/api/disconnect', async (req, res) => {
    res.json(await engine.disconnect());
  });

  app.get('/api/status', async (req, res) => {
    const status = await engine.status();
    status.open_trades = status.open_trades.map(safeChartName);
    res.json(status);
  });

  app.get('/api/trades', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const trades = await engine.db.recentTrades(limit);
    res.json({ trades: trades.map(safeChartName) });
  });

  app.get('/api/logs', async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const logs = await engine.db.recentLogs(limit);
    res.json({
      logs: logs.map((row) => {
        let meta = row.meta;
        try { meta = JSON.parse(row.meta || '{}'); } catch { meta = {}; }
        return { ...row, meta };
      }),
    });
  });

  app.post('/api/bot/start', async (req, res) => {
    try {
      res.json(await engine.start());
    } catch (err) {
      return fail(res, 400, String(err.message));
    }
  });

  app.post('/api/bot/stop', async (req, res) => {
    await engine.stop('user');
    res.json(await engine.status());
  });

  app.post('/api/bot/emergency', async (req, res) => {
    res.json(await engine.emergencyStop());
  });

  app.post('/api/bot/reset-emergency', async (req, res) => {
    engine.emergency = false;
    await engine.db.addLog('info', 'risk', 'Emergency stop cleared by operator');
    res.json(await engine.status());
  });

  app.get('/api/risk', async (req, res) => {
    res.json(await engine.ensureSettings());
  });

  app.post('/api/risk', async (req, res) => {
    const body = req.body || {};
    const bounds = {
      risk_percent: [0.1, 2.0],
      daily_loss_limit_percent: [0.5, 10.0],
      max_open_trades: [1, 10],
      max_daily_trades: [1, 50],
      min_confidence: [0.5, 0.95],
      max_spread_pips: [0.5, 10.0],
    };
    const values = {};
    for (const key of RISK_KEYS) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      const [lo, hi] = bounds[key];
      if (!Number.isFinite(value) || value < lo || value > hi) {
        return fail(res, 422, `${key} must be between ${lo} and ${hi}`);
      }
      values[key] = value;
    }
    if (!Object.keys(values).length) return fail(res, 422, 'No risk settings supplied');
    res.json(await engine.updateRiskSettings(values));
  });

  app.post('/api/market/test', async (req, res) => {
    const result = await engine.market.testConnections(config.SYMBOLS);
    engine.marketConnected = result.connected;
    res.json(result);
  });

  app.post('/api/telegram/test', async (req, res) => {
    if (!engine.telegram.enabled) return fail(res, 400, 'Telegram is not configured');
    const sent = await engine.telegram.sendMessage(
      '<b>ROZLF AUTO TRADER</b>\n✅ Telegram connection test successful.',
    );
    if (!sent.ok) return fail(res, 400, `Telegram error: ${sent.error}`);
    res.json({ ok: true });
  });

  app.get('/api/charts/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return fail(res, 400, 'invalid file');
    }
    const resolved = path.resolve(config.CHART_DIR, filename);
    if (!resolved.startsWith(path.resolve(config.CHART_DIR) + path.sep) || !fs.existsSync(resolved)) {
      return fail(res, 404, 'chart not found');
    }
    res.sendFile(resolved);
  });

  app.use('/api', (req, res) => fail(res, 404, 'Not found'));

  const staticDir = path.join(config.BASE_DIR, 'app', 'static');
  app.use('/static', express.static(staticDir, { maxAge: '1h', index: false }));
  app.get('/manifest.webmanifest', (req, res) => res.sendFile(path.join(staticDir, 'manifest.webmanifest')));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(staticDir, 'favicon.svg')));
  app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status === 400 ? 400 : 500;
    fail(res, status, status === 400 ? 'Malformed request' : 'Internal server error');
    if (status === 500 && engine.db) {
      engine.db.addLog('error', 'api', err.message).catch(() => {});
    }
  });

  return app;
}

module.exports = { createApp };
