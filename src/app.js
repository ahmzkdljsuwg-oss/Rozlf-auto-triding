'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const { dashboardTokenOk } = require('./security');
const { RISK_KEYS } = require('./engine');
const { integrationStatus } = require('./expertoption-session');

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
  app.use(express.json({ limit: '8mb' }));

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
      simulated_mt5_allowed: config.ALLOW_SIMULATED_MT5,
      speeds: ['slow', 'medium', 'fast'],
      default_speed: 'medium',
      ai_enabled: Boolean(config.MISTRAL_API_KEY),
      telegram_enabled: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
      disclaimer: config.DISCLAIMER,
    });
  });

  app.get('/api/session', async (req, res) => {
    res.json(await engine.status());
  });

  app.post('/api/account/sync', async (req, res) => {
    if (!engine.account) return fail(res, 409, 'No account is connected');
    await engine.syncAccount();
    if (engine.broker && engine.broker.supportsPositions) await engine.syncBrokerTrades();
    const status = await engine.status();
    status.open_trades = status.open_trades.map(safeChartName);
    res.json(status);
  });

  app.post('/api/connect', async (req, res) => {
    const body = req.body || {};
    const errors = [];
    if (!['expertoption', 'mt5'].includes(body.platform)) errors.push('platform must be expertoption or mt5');
    if (!['demo', 'real'].includes(body.account_type)) errors.push('account_type must be demo or real');
    const isExpertOption = body.platform === 'expertoption';
    if (!isText(body.login, 2, 128)) errors.push('login must be 2-128 characters');
    if (isExpertOption) {
      if (!isText(body.session_token, 1, 4096)) errors.push('session_token is required');
    } else if (!isText(body.password, 1, 256)) {
      errors.push('password is required');
    }
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
        password: body.password ? String(body.password) : '',
        sessionToken: body.session_token ? String(body.session_token) : '',
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

  app.get('/api/expertoption/session', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    res.json(engine.expertOptionSession.status());
  });

  app.get('/api/expertoption/integration', (req, res) => {
    res.json(integrationStatus());
  });

  app.post('/api/expertoption/verify', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    const status = await engine.expertOptionSession.verify();
    if (status.verified && status.account) {
      const synced = await engine.syncAccount().catch(() => null);
      return res.json({
        ok: true,
        verified: true,
        connection_state: status.connection_state,
        account: status.account,
        account_sync: synced ? { synced: true } : { synced: false },
        official_api_available: false,
        execution_allowed: false,
      });
    }
    return res.status(409).json({
      ok: false,
      detail: status.last_error || status.reason_en,
      connection_state: status.connection_state,
      gateway_configured: status.gateway_configured,
      bridge_configured: status.bridge_configured,
      token_present: status.token_present,
      verified: false,
      official_api_available: false,
      next_step_ar: integrationStatus().next_step_ar,
    });
  });

  app.get('/api/expertoption/assets', async (req, res) => {
    if (!engine.account || engine.platform !== 'expertoption') {
      return fail(res, 409, 'اتصل بجلسة ExpertOption أولاً.');
    }
    const result = await engine.expertOptionAssets();
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/expertoption/quote', async (req, res) => {
    if (!engine.account || engine.platform !== 'expertoption') {
      return fail(res, 409, 'اتصل بجلسة ExpertOption أولاً.');
    }
    const asset = String(req.query.asset || '');
    if (!asset) return fail(res, 422, 'اختر أصلاً من قائمة ExpertOption.');
    const timeframe = String(req.query.timeframe || 'M1').toUpperCase();
    const result = await engine.expertOptionQuote(asset, timeframe);
    res.status(result.ok ? 200 : 409).json({ ...result, execution_allowed: false });
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

  app.get('/api/settings', async (req, res) => {
    res.json(await engine.getSettings());
  });

  app.post('/api/settings', async (req, res) => {
    try {
      res.json(await engine.updateSettings(req.body || {}, { source: 'site' }));
    } catch (err) {
      return fail(res, 422, String(err.message));
    }
  });

  app.post('/api/mode', async (req, res) => {
    try {
      res.json(await engine.setTradingMode((req.body || {}).mode, { source: 'site' }));
    } catch (err) {
      return fail(res, 422, String(err.message));
    }
  });

  app.post('/api/expertoption/auto-analysis', async (req, res) => {
    const body = req.body || {};
    const allowedExpiries = new Set(['30s', '1m', '2m', '3m', '5m']);
    if (!body.asset_id) return fail(res, 422, 'اختر أصلاً من قائمة ExpertOption.');
    if (!allowedExpiries.has(String(body.expiry || ''))) return fail(res, 422, 'مدة التحليل غير مدعومة.');
    if (!engine.account || engine.platform !== 'expertoption') {
      return fail(res, 409, 'اتصل بجلسة ExpertOption أولاً.');
    }
    const result = await engine.expertOptionAnalyze(String(body.asset_id), String(body.expiry));
    const payload = {
      ...result,
      asset_id: String(body.asset_id),
      expiry: String(body.expiry),
      execution_allowed: false,
      ai_reviewed: Boolean(result.ai && result.ai.reviewed),
    };
    if (result.ok && result.direction !== 'NO TRADE' && engine.telegram) {
      engine.telegram
        .sendExpertOptionAnalysis(payload, { source: 'site' })
        .catch((err) => engine.db.addLog('warn', 'telegram', `ExpertOption analysis notification failed: ${err.message}`).catch(() => {}));
    }
    return res.status(result.ok ? 200 : 424).json(payload);
  });

  app.get('/api/scanner', async (req, res) => {
    res.json(engine.scanner.status());
  });

  app.post('/api/scanner/scan', async (req, res) => {
    if (!engine.account) return fail(res, 409, 'Connect a Demo analysis session first');
    if (engine.platform !== 'expertoption') {
      return fail(res, 409, 'The full market scanner is available on the ExpertOption analysis session');
    }
    const body = req.body || {};
    const continuous = body.continuous !== false;
    if (continuous) {
      engine.scanner.startAuto(Math.max(30, Number(body.interval_seconds) || 90) * 1000);
    } else {
      engine.scanner.startScan();
    }
    await engine.db.addLog('info', 'scanner', `Full market scan started (${continuous ? 'continuous' : 'single'})`);
    res.json(engine.scanner.status());
  });

  app.post('/api/scanner/stop', async (req, res) => {
    engine.scanner.stopAuto();
    await engine.db.addLog('info', 'scanner', 'Automatic market scanning stopped');
    res.json(engine.scanner.status());
  });

  app.post('/api/scanner/trade', async (req, res) => {
    const status = engine.scanner.status();
    await engine.db.addLog('warn', 'scanner', 'ExpertOption trade execution blocked: no approved API');
    return res.status(403).json({
      detail: status.execution.reason,
      can_trade: false,
      official_integration: false,
    });
  });

  app.post('/api/analysis/image', async (req, res) => {
    try {
      const body = req.body || {};
      const mimeType = String(body.mime_type || '');
      const imageBase64 = String(body.image_base64 || '');
      if (!imageBase64 || imageBase64.length > 7_000_000) {
        return fail(res, 422, 'اختر صورة واضحة لا يتجاوز حجمها 5 ميجابايت.');
      }
      const result = await engine.analyzer.analyzeChartImage({
        imageBase64, mimeType,
        marketType: String(body.market_type || 'unknown').slice(0, 40),
        symbol: String(body.symbol || 'unknown').slice(0, 80),
        timeframe: String(body.timeframe || 'unknown').slice(0, 40),
      });
      await engine.db.addLog('info', 'image_analysis', 'Chart image analyzed', {
        market_type: result.market_type, symbol: result.symbol_seen,
        direction: result.direction, confidence: result.confidence,
      });
      res.json(result);
    } catch (err) {
      return fail(res, 422, String(err.message || 'Image analysis failed').slice(0, 240));
    }
  });

  app.get('/api/stats', async (req, res) => {
    res.json(await engine.stats());
  });

  app.post('/api/analysis/run', async (req, res) => {
    try {
      res.json(await engine.analyzeNow());
    } catch (err) {
      return fail(res, 409, String(err.message));
    }
  });

  app.get('/api/analysis/chart', async (req, res) => {
    try {
      const chart = await engine.latestOpportunityChart();
      res.json({ url: `/api/charts/${path.basename(chart.path)}`, caption: chart.caption });
    } catch (err) {
      return fail(res, 404, String(err.message));
    }
  });

  app.post('/api/trades/close-all', async (req, res) => {
    try {
      res.json(await engine.closeAllTrades({ confirm: (req.body || {}).confirm === true }));
    } catch (err) {
      return fail(res, 422, String(err.message));
    }
  });

  app.get('/api/logs', async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const level = typeof req.query.level === 'string' ? req.query.level : '';
    let logs = await engine.db.recentLogs(Math.min(500, limit * 3));
    if (category) logs = logs.filter((row) => row.category === category);
    if (level) logs = logs.filter((row) => row.level === level);
    logs = logs.slice(0, limit);
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

  app.get('/api/speed', (req, res) => {
    res.json({ speed: engine.speed, preset: engine.speedPreset });
  });

  app.post('/api/speed', async (req, res) => {
    try {
      const mode = String((req.body || {}).speed || '');
      const preset = await engine.setSpeed(mode, { source: 'site' });
      res.json({ speed: preset.id, preset });
    } catch (err) {
      return fail(res, 422, String(err.message));
    }
  });

  app.get('/api/risk', async (req, res) => {
    await engine.ensureSettings();
    const risk = {};
    for (const key of RISK_KEYS) risk[key] = engine.risk.get(key);
    res.json(risk);
  });

  app.post('/api/risk', async (req, res) => {
    try {
      await engine.updateSettings(req.body || {}, { source: 'site' });
      const risk = {};
      for (const key of RISK_KEYS) risk[key] = engine.risk.get(key);
      res.json(risk);
    } catch (err) {
      return fail(res, 422, String(err.message));
    }
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
