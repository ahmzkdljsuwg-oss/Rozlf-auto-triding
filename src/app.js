'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const localBridge = require('./local-bridge');
const { createOwnerSession, verifyOwnerSession, encryptionReady } = require('./security');
const crypto = require('crypto');
const { RISK_KEYS } = require('./engine');
const { integrationStatus } = require('./expertoption-session');
const { normalizeExpertOptionToken } = require('./session-token');

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
    if (req.path.startsWith('/api') || req.path === '/telegram-connect.html') res.setHeader('Cache-Control', 'no-store');
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

  function ownerCookie(req) {
    const raw = String(req.headers.cookie || '');
    const item = raw.split(';').map((v) => v.trim()).find((v) => v.startsWith('rozlf_owner='));
    if (!item) return '';
    try { return decodeURIComponent(item.slice('rozlf_owner='.length)); } catch { return ''; }
  }

  function ownerAuthorized(req) {
    return Boolean(config.ALLOW_INSECURE_DASHBOARD) || verifyOwnerSession(ownerCookie(req));
  }

  app.get('/api/health', (req, res) => {
    const bridge = localBridge.status();
    res.json({
      ok: true, app: config.APP_NAME, version: config.APP_VERSION,
      runtime: 'node', uptime_seconds: Math.round(process.uptime()),
      expertoption_bridge: bridge,
    });
  });

  app.get('/api/public/status', async (req, res) => {
    const bot = engine.telegramBot;
    if (bot && !bot.botUsername && engine.telegram && engine.telegram.tokenConfigured) {
      const me = await engine.telegram.getMe().catch(() => null);
      if (me && me.ok && me.username) bot.botUsername = me.username;
    }
    const username = (bot && bot.botUsername) || config.TELEGRAM_BOT_USERNAME || '';
    const connector = app.locals.cloudConnector;
    const probe = connector ? connector.probeSummary() : null;
    res.json({
      authenticated: ownerAuthorized(req),
      telegram_configured: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
      telegram_bot_username: username,
      app: config.APP_NAME,
      cloud_connector: probe ? {
        enabled: probe.ran || connector.enabled(),
        chromium_runs: probe.browser_launch_ok,
        frames_ok: probe.frames_ok,
        input_ok: probe.input_ok,
        page_ok: probe.page_ok,
        page_title: probe.page_title,
        login_form: probe.page_password_fields > 0,
        login_form_ms: probe.login_form_ms,
        page_inputs: probe.page_inputs,
        page_text_len: probe.page_text_len,
        launch_ms: probe.launch_ms,
        frame_bytes: probe.frame_bytes,
        peak_rss_mb: probe.peak_rss_mb,
        peak_pss_mb: probe.peak_pss_mb,
        limit_mb: probe.limit_mb,
        server_rss_mb: probe.server_rss_mb,
        checked_at: probe.at,
        ok: probe.ok === true,
        error: probe.error,
      } : null,
    });
  });

  // One-time code created only by the owner's Telegram bot chat. The session
  // token is submitted over HTTPS here, never as a Telegram message.
  app.post('/api/telegram/link/complete', async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    const sessionToken = normalizeExpertOptionToken(body.session_token);
    if (!/^[a-f0-9]{64}$/i.test(code) || !isText(sessionToken, 1, 4096)) {
      return fail(res, 422, 'رابط الربط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً من البوت.');
    }
    if (!encryptionReady()) return fail(res, 503, 'APP_SECRET_KEY غير مضبوط؛ لا يمكن حفظ الجلسة بشكل مشفر.');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const key = `telegram.link.${codeHash}`;
    const record = await engine.db.getSetting(key, null);
    if (!record || !record.chat_id || Number(record.expires_at || 0) < Date.now()) {
      await engine.db.setSetting(key, null).catch(() => {});
      return fail(res, 410, 'انتهت صلاحية رابط الربط. ارجع إلى Telegram واكتب /connect للحصول على رابط جديد.');
    }
    const latestCodeHash = await engine.db.getSetting(`telegram.link.latest.${String(record.chat_id)}`, null);
    if (latestCodeHash !== codeHash) {
      await engine.db.setSetting(key, null).catch(() => {});
      return fail(res, 410, 'هذا رابط قديم. استخدم أحدث رابط أرسله لك بوت ROZLF.');
    }
    // Consume before contacting the broker to make the code strictly one-use.
    await engine.db.setSetting(key, null);
    await engine.db.setSetting(`telegram.link.latest.${String(record.chat_id)}`, null);
    try {
      const status = await engine.attachAccount({
        platform: 'expertoption', accountType: 'demo',
        login: `telegram-${String(record.chat_id).slice(-8)}`,
        sessionToken,
      });
      // attachAccount -> _wireExpertOptionAccount already performs one verification.
      // Do not immediately open a second WebSocket/profile request: on a cold bridge
      // that duplicate call can exceed the web request budget and report a false timeout.
      const verification = engine.expertOptionSession
        ? engine.expertOptionSession.status()
        : { verified: false, last_error: 'ExpertOption session was not initialized' };
      if (!verification.verified) {
        const message = String(verification.last_error || verification.reason_ar || 'تعذر التحقق من الجلسة').slice(0, 240);
        if (engine.telegram) await engine.telegram.api('sendMessage', {
          chat_id: record.chat_id,
          text: `⚠️ لم يكتمل ربط ExpertOption. السبب: ${message}\nاطلب رابطاً جديداً بكتابة /connect.`,
        }).catch(() => {});
        return res.status(409).json({ ok: false, verified: false, detail: message });
      }
      const cookieValue = createOwnerSession();
      if (!cookieValue) return fail(res, 503, 'تعذر إنشاء جلسة دخول آمنة؛ تحقق من APP_SECRET_KEY.');
      const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
      res.setHeader('Set-Cookie', `rozlf_owner=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
      if (engine.telegram) await engine.telegram.api('sendMessage', {
        chat_id: record.chat_id,
        text: '✅ <b>تم ربط حساب ExpertOption والتحقق من الجلسة بنجاح.</b> يمكنك الآن فتح موقع ROZLF واستخدام التحليل. وضع القراءة فقط مفعّل.',
        parse_mode: 'HTML',
      }).catch(() => {});
      return res.json({ ok: true, verified: true, account: status.account || null, redirect: '/' });
    } catch (err) {
      const message = String(err.message || 'Connection failed').slice(0, 240);
      await engine.db.addLog('warn', 'telegram-link', `ExpertOption link failed: ${message}`).catch(() => {});
      return fail(res, 502, message);
    }
  });

  app.use('/api', (req, res, next) => {
    if (ownerAuthorized(req)) return next();
    return fail(res, 401, 'افتح بوت ROZLF في Telegram واكتب /connect لربط الجلسة والدخول للموقع.');
  });

  // ---- Cloud connector: server-side isolated Chromium, driven from the phone --
  const { CloudConnector } = require('./cloud-connector');
  const cloudConnector = new CloudConnector({
    engine,
    logger: (line) => { engine.db.addLog('info', 'cloud_connector', line).catch(() => {}); },
  });
  app.locals.cloudConnector = cloudConnector;
  const cloudStarts = [];
  const cloudRateLimited = () => {
    const now = Date.now();
    while (cloudStarts.length && now - cloudStarts[0] > 60000) cloudStarts.shift();
    cloudStarts.push(now);
    return cloudStarts.length > 6;
  };

  app.get('/api/cloud-connector/status', async (req, res) => {
    const availability = await cloudConnector.availability();
    res.json({ ...cloudConnector.status(), availability });
  });

  app.post('/api/cloud-connector/start', async (req, res) => {
    if (cloudRateLimited()) return fail(res, 429, 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.');
    try {
      const session = await cloudConnector.start({ login: String((req.body || {}).login || '') });
      res.json({ ok: true, ...session, ...cloudConnector.status() });
    } catch (err) {
      if (err.code === 'session_active') return fail(res, 409, err.message);
      return fail(res, 503, err.message);
    }
  });

  app.post('/api/cloud-connector/input', async (req, res) => {
    try {
      const body = req.body || {};
      res.json(await cloudConnector.input(body));
    } catch (err) {
      res.status(409).json({ detail: err.message });
    }
  });

  app.post('/api/cloud-connector/stop', async (req, res) => {
    res.json(await cloudConnector.stop(String((req.body || {}).reason || 'user')));
  });

  app.get('/api/cloud-connector/frame', async (req, res) => {
    try {
      const frame = await cloudConnector.frame();
      if (!frame || !frame.jpeg) return res.status(404).end();
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'X-Cloud-Url': encodeURIComponent(frame.url || ''),
        'X-Cloud-State': frame.state || '',
      });
      res.end(frame.jpeg);
    } catch (err) {
      res.status(409).json({ detail: err.message });
    }
  });

  app.get('/api/config', (req, res) => {
    // MT5 is temporarily removed from the product surface (interface, menus,
    // connections and settings). The integration code stays in the tree.
    const platforms = ['expertoption'];
    const accountTypes = config.REAL_TRADING_APPROVED ? ['demo', 'real'] : ['demo'];
    res.json({
      app: config.APP_NAME,
      version: config.APP_VERSION,
      platforms,
      account_types: accountTypes,
      enabled_account_types: accountTypes,
      account_types_by_platform: {
        mt5: accountTypes,
        expertoption: (config.REAL_TRADING_APPROVED || config.EXPERTOPTION_ALLOW_REAL_READ)
          ? ['demo', 'real'] : ['demo'],
      },
      symbols: config.SYMBOLS,
      timeframes: config.TIMEFRAMES,
      market_data_provider: 'yahoo',
      mt5_enabled: false,
      mt5_available: false,
      expertoption_execution: false,
      expertoption_real_read: config.EXPERTOPTION_ALLOW_REAL_READ,
      session_restore_enabled: config.EXPERTOPTION_RESTORE_SESSION,
      encryption_ready: require('./security').encryptionReady(),
      storage: engine.db
        ? { driver: engine.db.driver, durable: engine.db.driver === 'postgres' }
        : null,
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
    if (body.platform === 'mt5') {
      return fail(res, 403, 'MT5 is temporarily disabled in ROZLF; ExpertOption analysis only.');
    }
    if (body.platform !== 'expertoption') errors.push('platform must be expertoption');
    if (!['demo', 'real'].includes(body.account_type)) errors.push('account_type must be demo or real');
    const isExpertOption = body.platform === 'expertoption';
    if (!isText(body.login, 2, 128)) errors.push('login must be 2-128 characters');
    const normalizedSessionToken = isExpertOption
      ? normalizeExpertOptionToken(body.session_token)
      : '';
    if (isExpertOption) {
      if (!isText(normalizedSessionToken, 1, 4096)) errors.push('A valid raw Session Token or cookie string containing token= is required');
    } else if (!isText(body.password, 1, 256)) {
      errors.push('password is required');
    }
    if (body.server !== undefined && String(body.server).length > 128) errors.push('server is too long');
    if (errors.length) return res.status(422).json({ detail: 'Validation error', errors });

    if (isExpertOption && !require('./security').encryptionReady()) {
      return fail(res, 409, 'APP_SECRET_KEY is not configured; the ExpertOption session token cannot be stored encrypted');
    }
    const eoRealRead = body.platform === 'expertoption' && body.account_type === 'real'
      && config.EXPERTOPTION_ALLOW_REAL_READ;
    if (body.account_type === 'real' && !config.REAL_TRADING_APPROVED && !eoRealRead) {
      return fail(res, 403, 'Real trading is disabled until explicitly approved');
    }
    try {
      const status = await engine.attachAccount({
        platform: body.platform,
        accountType: body.account_type,
        login: String(body.login),
        password: body.password ? String(body.password) : '',
        sessionToken: normalizedSessionToken,
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

  // ---- Connect via Safari / local consent connector -------------------------
  // No password and no cookie-store extraction: the user signs in to
  // m.expertoption.com themselves, and only the token already present in that
  // browser profile is encrypted on their machine with a one-time code.
  const pairAttempts = new Map();
  function pairRateLimited(ip) {
    const now = Date.now();
    const list = (pairAttempts.get(ip) || []).filter((t) => now - t < 60000);
    list.push(now);
    pairAttempts.set(ip, list);
    return list.length > 12;
  }

  app.get('/api/connect/methods', (req, res) => {
    const { connectionMethods } = require('./connect-pairing');
    res.json({
      methods: connectionMethods(),
      read_only: true,
      execution_enabled: false,
      encryption_ready: encryptionReady(),
      secure_context: req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https'),
    });
  });

  app.post('/api/connect/pair', async (req, res) => {
    if (!encryptionReady()) {
      return fail(res, 503, 'APP_SECRET_KEY غير مضبوط؛ لا يمكن حفظ الجلسة بشكل مشفر. أضف المتغير في Render أولاً.');
    }
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (pairRateLimited(ip)) return fail(res, 429, 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.');
    const { issuePairing } = require('./connect-pairing');
    const pairing = await issuePairing(engine.db, { ip });
    res.json({
      ...pairing,
      app_url: config.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`,
      connector: 'rozlf_connect.py',
      note_ar: 'الرمز صالح ١٠ دقائق ويُستهلك مرة واحدة. لا تُرسله إلى Telegram ولا إلى أي شخص.',
    });
  });

  app.post('/api/connect/session', async (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    if (!code || code.length > 16) return fail(res, 422, 'رمز الربط مطلوب.');
    if (!encryptionReady()) return fail(res, 503, 'APP_SECRET_KEY غير مضبوط؛ لا يمكن حفظ الجلسة.');

    const pairing = require('./connect-pairing');
    const consumed = await pairing.consumePairing(engine.db, code);
    if (!consumed.ok) {
      const messages = {
        invalid_code: 'صيغة الرمز غير صحيحة.',
        unknown_or_used: 'الرمز غير موجود أو استُخدم من قبل. أنشئ رمزاً جديداً.',
        expired: 'انتهت صلاحية الرمز. أنشئ رمزاً جديداً.',
        too_many_attempts: 'تم إغلاق هذا الرمز بعد محاولات فاشلة متعددة. أنشئ رمزاً جديداً.',
      };
      return fail(res, 410, messages[consumed.reason] || 'تعذر التحقق من الرمز.');
    }

    let token = '';
    try {
      token = normalizeExpertOptionToken(pairing.decryptPayload(code, body.payload));
    } catch {
      await pairing.markAttempt(engine.db, consumed.key, consumed.attempts);
      return fail(res, 422, 'تعذّر فك تشفير بيانات الجلسة. تأكد من صحة الرمز وأن الموصّل هو الذي أنشأ البيانات.');
    }
    if (!isText(token, 1, 4096)) {
      await pairing.markAttempt(engine.db, consumed.key, consumed.attempts);
      return fail(res, 422, 'لم يصل رمز جلسة صالح من الموصّل.');
    }
    await pairing.burnPairing(engine.db, consumed.key);

    const accountType = body.account_type === 'real' ? 'real' : 'demo';
    if (accountType === 'real' && !config.EXPERTOPTION_ALLOW_REAL_READ) {
      return fail(res, 403, 'قراءة الحساب الحقيقي معطّلة. الربط متاح لحساب Demo فقط.');
    }
    const login = isText(body.login, 2, 128)
      ? String(body.login)
      : `safari-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 8)}`;

    try {
      const status = await engine.attachAccount({
        platform: 'expertoption', accountType, login, sessionToken: token,
      });
      const verification = engine.expertOptionSession
        ? engine.expertOptionSession.status()
        : { verified: false, last_error: 'ExpertOption session was not initialized' };
      if (engine.telegram && engine.telegram.tokenConfigured) {
        engine.telegram.sendMessage(
          verification.verified
            ? '🔗 تم ربط جلسة ExpertOption عبر الموصّل المحلي وتحقق الاتصال. قراءة وتحليل فقط.'
            : `⚠️ وصل رمز الجلسة عبر الموصّل لكن التحقق فشل: ${String(verification.last_error || 'سبب غير معروف').slice(0, 160)}`,
        ).catch(() => {});
      }
      await engine.db.addLog('info', 'expertoption', `Session received from local connector (${accountType}), verified=${verification.verified}`);
      return res.json({ ...status, session: verification });
    } catch (err) {
      const message = String(err.message || 'Connection failed').slice(0, 300);
      await engine.db.addLog('warn', 'expertoption', `Connector session failed: ${message}`);
      return fail(res, 502, message);
    }
  });

  app.get('/rozlf_connect.py', (req, res) => {
    if (!ownerAuthorized(req)) return fail(res, 401, 'افتح الموقع من حساب المالك أولاً.');
    res.download(path.join(__dirname, '..', 'connector', 'rozlf_connect.py'), 'rozlf_connect.py');
  });

  app.get('/api/expertoption/session', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    res.json(engine.expertOptionSession.status());
  });

  app.get('/api/expertoption/sources', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    try {
      res.json({ ...(await engine.expertOptionSession.sources()), execution_allowed: false });
    } catch (err) {
      return fail(res, 502, err.message || 'Source registry unavailable');
    }
  });

  app.get('/api/expertoption/catalog', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    try {
      const data = await engine.expertOptionSession.catalog({
        q: String(req.query.q || ''),
        market: String(req.query.market || 'all'),
        onlyActive: String(req.query.only_active || '') === 'true',
      });
      res.json({ ...data, execution_allowed: false });
    } catch (err) {
      return fail(res, err.code === 'not_verified' ? 409 : 502, err.message || 'Catalog unavailable');
    }
  });

  app.get('/api/expertoption/verify', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    const timeframes = String(req.query.timeframes || '').split(',')
      .map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0);
    try {
      const report = await engine.expertOptionSession.verifyCoverage({ timeframes });
      res.json({ ...report, execution_allowed: false });
    } catch (err) {
      return fail(res, err.code === 'not_verified' ? 409 : 502, err.message || 'Verification unavailable');
    }
  });

  app.get('/api/expertoption/verify/:id', async (req, res) => {
    if (!engine.expertOptionSession) return fail(res, 409, 'No ExpertOption session is attached');
    const timeframes = String(req.query.timeframes || '').split(',')
      .map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0);
    try {
      const report = await engine.expertOptionSession.verifyInstrument(req.params.id, { timeframes });
      res.json({ ...report, execution_allowed: false });
    } catch (err) {
      return fail(res, err.code === 'not_verified' ? 409 : 502, err.message || 'Verification unavailable');
    }
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

  app.get('/api/expertoption/bridge-check', async (req, res) => {
    const session = engine.expertOptionSession;
    if (!session) return fail(res, 409, 'No ExpertOption session is attached');
    const bridge = session.diagnostics ? await session.diagnostics() : { configured: false };
    res.status(bridge.reachable ? 200 : 409).json({ ...bridge, execution_allowed: false });
  });

  app.get('/api/telegram/status', async (req, res) => {
    const bot = engine.telegramBot;
    const status = bot ? bot.status() : { configured: false, running: false, health: 'not_attached' };
    res.json({ ...status, notifications_enabled: Boolean(engine.telegram && engine.telegram.enabled) });
  });

  app.post('/api/telegram/test', async (req, res) => {
    const notifier = engine.telegram;
    if (!notifier || !notifier.tokenConfigured) {
      return fail(res, 409, 'TELEGRAM_BOT_TOKEN غير مهيأ على الخادم.');
    }
    if (!notifier.chatId) return fail(res, 409, 'TELEGRAM_CHAT_ID غير مهيأ على الخادم.');
    const me = await notifier.getMe();
    if (!me.ok) {
      await engine.db.addLog('warn', 'telegram', `Telegram getMe failed: ${me.error}`).catch(() => {});
      return res.status(502).json({ ok: false, step: 'getMe', error: me.error, error_code: me.error_code || 0 });
    }
    const chat = await notifier.getChat();
    if (!chat.ok) {
      return res.status(502).json({ ok: false, step: 'getChat', error: chat.error, bot_username: me.username || '' });
    }
    const sent = await notifier.sendMessage([
      '✅ <b>اختبار الاتصال</b>',
      'ROZLF AUTO TRADER متصل ببوت Telegram بنجاح.',
      `البوت: @${me.username || '—'}`,
      `المحادثة: ${chat.title || chat.result.id}`,
    ].join('\n'));
    if (!sent.ok) {
      return res.status(502).json({ ok: false, step: 'sendMessage', error: sent.error, bot_username: me.username || '' });
    }
    return res.json({
      ok: true,
      bot_username: me.username || '',
      chat_title: chat.title || '',
      chat_id_masked: notifier.chatId ? `${'*'.repeat(Math.max(0, String(notifier.chatId).length - 4))}${String(notifier.chatId).slice(-4)}` : '',
      notifications_enabled: notifier.enabled,
    });
  });

  app.get('/api/expertoption/diagnostics', async (req, res) => {
    const diagnosis = await engine.diagnoseExpertOption();
    res.status(diagnosis.ok ? 200 : 409).json({
      ...diagnosis,
      platform: engine.platform || null,
      account_login: engine.account ? engine.account.login : null,
      account_type: engine.accountType || null,
      session_restore: engine.sessionRestore || null,
      execution_allowed: false,
    });
  });

  app.get('/api/expertoption/assets', async (req, res) => {
    const result = await engine.expertOptionAssets();
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/expertoption/asset/:id', async (req, res) => {
    if (engine.platform !== 'expertoption' || !engine.expertOptionSession) {
      return fail(res, 409, 'ExpertOption session is not attached');
    }
    try {
      if (engine.expertOptionSession.configured && !engine.expertOptionSession.verified) {
        await engine.expertOptionSession.verify();
      }
      const detail = await engine.expertOptionSession.instrumentDetail(String(req.params.id), {
        timeframe: String(req.query.timeframe || 'M1'),
        probe: req.query.probe !== 'false',
      });
      return res.json({ ok: true, ...detail, execution_allowed: false });
    } catch (err) {
      return fail(res, err.status && err.status >= 400 ? err.status : 424, String(err.message || err.code || 'Asset probe failed'));
    }
  });

  app.get('/api/expertoption/quote', async (req, res) => {
    const asset = String(req.query.asset || '');
    const instrumentId = req.query.instrument_id !== undefined ? String(req.query.instrument_id) : null;
    if (!asset && !instrumentId) return fail(res, 422, 'اختر أصلاً من قائمة ExpertOption.');
    const timeframe = String(req.query.timeframe || 'M1').toUpperCase();
    const result = await engine.expertOptionQuote(asset, timeframe, instrumentId);
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
    const instrumentId = body.instrument_id !== undefined && body.instrument_id !== null && String(body.instrument_id) !== ''
      ? String(body.instrument_id)
      : null;
    if (!body.asset_id && !instrumentId) return fail(res, 422, 'اختر أصلاً من قائمة ExpertOption.');
    if (!allowedExpiries.has(String(body.expiry || ''))) return fail(res, 422, 'مدة التحليل غير مدعومة.');
    const result = await engine.expertOptionAnalyze(
      body.asset_id ? String(body.asset_id) : '',
      String(body.expiry),
      instrumentId,
    );
    const payload = {
      ...result,
      asset_id: String(body.asset_id || instrumentId || ''),
      instrument_id: instrumentId,
      expiry: String(body.expiry),
      execution_allowed: false,
      ai_reviewed: Boolean(result.ai && result.ai.reviewed),
    };
    if (result.chart_path) {
      try {
        const image = await fs.promises.readFile(result.chart_path);
        payload.chart_data_url = `data:image/png;base64,${image.toString('base64')}`;
      } catch (err) {
        await engine.db.addLog('warn', 'chart', `Analysis chart read failed: ${err.message}`).catch(() => {});
      }
      payload.chart_path = path.basename(result.chart_path);
    }
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
  app.get('/telegram-connect.html', (req, res) => res.sendFile(path.join(staticDir, 'telegram-connect.html')));
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
