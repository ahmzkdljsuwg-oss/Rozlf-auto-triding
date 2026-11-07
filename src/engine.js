'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { MarketDataService, MarketDataError, pipSize } = require('./market');
const { MarketScanner, EXECUTION_BLOCKED_REASON } = require('./scanner');
const { buildSignal } = require('./strategy');
const { RiskManager, DEFAULTS } = require('./risk');
const { PaperBroker } = require('./brokers/paper');
const { MT5Broker } = require('./brokers/mt5');
const { ExpertOptionBroker } = require('./brokers/expertoption');
const { ExpertOptionSession, SOURCE_REASON_EN, SOURCE_REASON_AR, GATEWAY_REASON_EN, GATEWAY_REASON_AR } = require('./expertoption-session');
const { describeAssets, describeAccountAssets, analyzeAsset, resolveInstrument, EXPIRY_KEYS, ASSET_KEYS } = require('./expertoption-analysis');
const { RozlfAnalyzer } = require('./ai');
const { TelegramNotifier } = require('./telegram');
const { renderTradeChart, renderResultChart, renderAnalysisChart } = require('./charts');
const { utcnow } = require('./db');
const { getSpeedPreset, isSpeedMode, DEFAULT_SPEED } = require('./speed');
const settingsUtil = require('./settings');

const RISK_KEYS = Object.keys(DEFAULTS);
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

class TradingEngine {
  constructor(options = {}) {
    this.db = options.db;
    this.market = options.market || new MarketDataService();
    this.scanner = new MarketScanner({ market: this.market });
    this.telegram = options.telegram || new TelegramNotifier();
    this.analyzer = options.analyzer || new RozlfAnalyzer();
    this.chartDir = options.chartDir || config.CHART_DIR;

    this.account = null;
    this.broker = null;
    this.expertOptionSession = null;
    this.executionMode = 'none';
    this.platform = null;
    this.accountType = null;
    this.running = false;
    this.emergency = false;
    this.speed = DEFAULT_SPEED;
    this.tradingMode = 'demo';
    this.symbols = [...config.SYMBOLS];
    this.timeframe = 'M5';
    this.notifications = { ...settingsUtil.NOTIFICATION_DEFAULTS };
    this.analysisOnly = false;
    this._lastDailyReport = null;
    this._lastOpportunityNotice = new Map();
    this.lastScanAt = null;
    this.lastError = null;
    this.marketConnected = false;
    this.scanCount = 0;
    this.opportunities = [];
    this.risk = new RiskManager();
    this.accountBalance = 0;
    this.accountEquity = 0;
    this.accountCurrency = 'USD';
    this.marginFree = 0;
    this.marginUsed = 0;
    this.marginLevel = null;
    this.accountSynced = false;
    this.accountSyncAt = null;
    this.accountSyncError = null;
    this.positionSyncAt = null;
    this.positionSyncError = null;
    this.brokerPositions = 0;
    this._lastTradeAt = new Map();
    this._nextDelayMs = null;

    this._timer = null;
    this._busy = false;
    this._started = false;
    this._alerted = new Map();
  }

  async init() {
    await this.ensureSettings();
    try {
      await this.restoreExpertOptionSession();
    } catch (err) {
      this.sessionRestore = { restored: false, reason: 'restore_failed', error: String(err.message || err).slice(0, 200) };
      try { await this.db.addLog('warn', 'broker', `ExpertOption session restore failed: ${this.sessionRestore.error}`); } catch { /* ignore */ }
    }
    return this;
  }

  async ensureSettings() {
    const stored = {};
    for (const key of RISK_KEYS) {
      const value = await this.db.getSetting(`risk.${key}`, null);
      stored[key] = value === null ? DEFAULTS[key] : value;
      if (value === null) await this.db.setSetting(`risk.${key}`, DEFAULTS[key]);
    }
    this.risk = new RiskManager(stored);
    const speed = await this.db.getSetting('trading.speed', null);
    this.speed = isSpeedMode(speed) ? speed : DEFAULT_SPEED;
    if (speed === null) await this.db.setSetting('trading.speed', this.speed);

    const storedSymbols = await this.db.getSetting('trading.symbols', null);
    try {
      this.symbols = storedSymbols === null ? [...config.SYMBOLS] : settingsUtil.normalizeSymbols(storedSymbols);
    } catch {
      this.symbols = [...config.SYMBOLS];
    }
    if (storedSymbols === null) await this.db.setSetting('trading.symbols', this.symbols);

    const storedTimeframe = await this.db.getSetting('trading.timeframe', null);
    try {
      this.timeframe = storedTimeframe === null ? config.TIMEFRAMES[0] : settingsUtil.normalizeTimeframe(storedTimeframe);
    } catch {
      this.timeframe = config.TIMEFRAMES[0];
    }
    if (storedTimeframe === null) await this.db.setSetting('trading.timeframe', this.timeframe);

    const storedMode = await this.db.getSetting('trading.mode', null);
    try {
      this.tradingMode = storedMode === null ? 'demo' : settingsUtil.normalizeMode(storedMode);
    } catch {
      this.tradingMode = 'demo';
    }
    if (storedMode === null) await this.db.setSetting('trading.mode', this.tradingMode);

    const storedNotifications = await this.db.getSetting('notifications.settings', null);
    this.notifications = settingsUtil.normalizeNotifications(storedNotifications || {});
    if (storedNotifications === null) {
      await this.db.setSetting('notifications.settings', this.notifications);
    }
    return stored;
  }

  async getSettings() {
    const risk = {};
    for (const key of RISK_KEYS) risk[key] = this.risk.get(key);
    return {
      ...risk,
      symbols: [...this.symbols],
      timeframe: this.timeframe,
      mode: this.tradingMode,
      notifications: { ...this.notifications },
      available_symbols: [...config.SYMBOLS],
      available_timeframes: [...config.TIMEFRAMES],
      modes: settingsUtil.MODES,
      live_enabled: config.REAL_TRADING_APPROVED,
      analysis_only: this.analysisOnly,
    };
  }

  async updateSettings(values, { source = 'site' } = {}) {
    const current = await this.getSettings();
    const clean = settingsUtil.validateValues(values || {}, current);
    for (const key of RISK_KEYS) {
      if (clean[key] !== undefined) await this.db.setSetting(`risk.${key}`, clean[key]);
    }
    if (clean.symbols !== undefined) {
      this.symbols = clean.symbols;
      await this.db.setSetting('trading.symbols', this.symbols);
    }
    if (clean.timeframe !== undefined) {
      this.timeframe = clean.timeframe;
      await this.db.setSetting('trading.timeframe', this.timeframe);
    }
    if (clean.mode !== undefined) {
      if (clean.mode === 'live' && !config.REAL_TRADING_APPROVED) {
        throw new Error('Real trading is disabled until explicitly approved');
      }
      this.tradingMode = clean.mode;
      await this.db.setSetting('trading.mode', this.tradingMode);
    }
    if (clean.notifications !== undefined) {
      this.notifications = clean.notifications;
      await this.db.setSetting('notifications.settings', this.notifications);
    }
    await this.ensureSettings();
    await this.db.addLog('info', 'settings', 'Bot settings updated', { source });
    return this.getSettings();
  }

  async setTradingMode(mode, { source = 'site' } = {}) {
    const clean = settingsUtil.normalizeMode(mode);
    if (clean === 'live' && !config.REAL_TRADING_APPROVED) {
      throw new Error('Real trading is disabled until explicitly approved');
    }
    this.tradingMode = clean;
    await this.db.setSetting('trading.mode', clean);
    await this.db.addLog('info', 'engine', `Trading mode set to ${clean}`, { source });
    return this.getSettings();
  }

  get speedPreset() {
    return getSpeedPreset(this.speed);
  }

  async setSpeed(mode, { source = 'site', notify = true } = {}) {
    if (!isSpeedMode(mode)) throw new Error('Speed must be slow, medium or fast');
    this.speed = mode;
    await this.db.setSetting('trading.speed', mode);
    await this.db.addLog('info', 'engine', `Trading speed set to ${mode}`, { source });
    this._nextDelayMs = getSpeedPreset(mode).scan_interval_seconds * 1000;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      if (this.running) this._schedule(0);
    }
    if (notify && source !== 'telegram' && this.telegram.enabled) {
      await this.telegram.notifySpeedChanged(mode);
    }
    return this.speedPreset;
  }

  async updateRiskSettings(values) {
    for (const key of RISK_KEYS) {
      if (values[key] !== undefined) await this.db.setSetting(`risk.${key}`, values[key]);
    }
    await this.ensureSettings();
    await this.db.addLog('info', 'risk', 'Risk settings updated', this.risk.settings);
    return this.risk.settings;
  }

  async _wireExpertOptionAccount({ accountId, login, accountType, token, stored, restored }) {
    this.account = await this.db.getAccount(accountId);
    if (!this.account) throw new Error('ExpertOption account record is missing');
    this.expertOptionSession = new ExpertOptionSession({
      login,
      tokenPresent: Boolean(token || config.EXPERTOPTION_SESSION_TOKEN),
      accountType,
      token: token || config.EXPERTOPTION_SESSION_TOKEN || '',
    });
    this.broker = null;
    this.executionMode = 'analysis_only';
    this.platform = 'expertoption';
    this.accountType = accountType;
    this.analysisOnly = true;
    this.tradingMode = 'analysis';
    await this.db.setSetting('trading.mode', 'analysis');
    this.accountBalance = 0;
    this.accountEquity = 0;
    this.marginFree = 0;
    this.marginUsed = 0;
    this.marginLevel = null;
    this.accountCurrency = 'USD';
    this.accountSynced = false;
    this.accountSyncAt = null;
    this.accountSyncError = this.expertOptionSession.configured
      ? (restored
        ? 'Stored ExpertOption session restored; waiting for verification.'
        : 'ExpertOption bridge configured; waiting for session verification.')
      : 'No ExpertOption session token: open the bridge with the token from the connected account.';
    this.emergency = false;
    this.lastError = null;
    this.opportunities = [];
    this._lastTradeAt.clear();
    this.scanner.reset();
    this.scanner.bindAccount(this.account);
    this.sessionRestore = {
      restored,
      restored_at: new Date().toISOString(),
      account_id: accountId,
      token_stored: stored,
      bridge_configured: this.expertOptionSession.configured,
    };
    await this.db.addLog('info', 'broker',
      restored
        ? `ExpertOption session restored from encrypted store for ${login}`
        : `ExpertOption token received for ${login}`,
      { mode: 'analysis_only', token_stored: stored, bridge_configured: this.expertOptionSession.configured });

    if (!this.expertOptionSession.configured) return this.status();
    const verified = await this.expertOptionSession.verify();
    if (verified.verified && verified.account) {
      this.accountSynced = true;
      this.accountSyncAt = new Date().toISOString();
      this.accountSyncError = null;
      this.accountBalance = Number(verified.account.balance) || 0;
      this.accountEquity = Number(verified.account.equity) || this.accountBalance;
      this.marginFree = Number(verified.account.free_margin) || 0;
      this.marginUsed = Number(verified.account.used_margin) || 0;
      this.accountCurrency = verified.account.currency || 'USD';
      await this.db.setAccountStatus(this.account.id, 'connected');
      await this.db.addLog('info', 'broker', 'ExpertOption session verified through the authorized gateway', {
        balance: this.accountBalance, currency: this.accountCurrency,
      });
    } else {
      await this.db.setAccountStatus(this.account.id, 'token_unverified');
      this.accountSyncError = verified.last_error || 'ExpertOption session verification failed';
      await this.db.addLog('warn', 'broker', `ExpertOption session not verified: ${this.accountSyncError}`);
    }
    return this.status();
  }

  async restoreExpertOptionSession() {
    if (!config.EXPERTOPTION_RESTORE_SESSION) {
      this.sessionRestore = { restored: false, reason: 'restore_disabled' };
      return null;
    }
    let row = null;
    try {
      row = await this.db.latestAccount('expertoption');
    } catch (err) {
      this.sessionRestore = { restored: false, reason: 'account_lookup_failed' };
      return null;
    }
    if (!row) {
      this.sessionRestore = { restored: false, reason: 'no_stored_account' };
      return null;
    }
    const { decryptSecret } = require('./security');
    const decrypted = row.password_enc ? decryptSecret(row.password_enc) : '';
    const token = decrypted || config.EXPERTOPTION_SESSION_TOKEN || '';
    if (!token) {
      this.sessionRestore = { restored: false, reason: 'stored_token_unreadable', account_id: row.id };
      await this.db.addLog('warn', 'broker',
        'Stored ExpertOption token could not be decrypted (APP_SECRET_KEY changed?); enter the token again from the UI');
      return null;
    }
    const storedType = row.account_type || 'demo';
    if (storedType === 'real' && !config.EXPERTOPTION_ALLOW_REAL_READ) {
      this.sessionRestore = { restored: false, reason: 'real_read_disabled', account_id: row.id };
      await this.db.addLog('warn', 'broker',
        'A stored ExpertOption real-account session was not restored: EXPERTOPTION_ALLOW_REAL_READ is false');
      return null;
    }
    return this._wireExpertOptionAccount({
      accountId: row.id,
      login: row.login,
      accountType: storedType,
      token,
      stored: true,
      restored: true,
    });
  }

  async attachAccount({ platform, accountType, login, password, sessionToken = '', server = '' }) {
    if (!['mt5', 'expertoption'].includes(platform)) throw new Error('Unsupported platform');
    if (!['demo', 'real'].includes(accountType)) throw new Error('Unsupported account type');
    const eoRealRead = platform === 'expertoption' && accountType === 'real'
      && config.EXPERTOPTION_ALLOW_REAL_READ;
    if (accountType === 'real' && !config.REAL_TRADING_APPROVED && !eoRealRead) {
      throw new Error('Real trading is disabled until explicitly approved');
    }
    if (this.broker) {
      try { await this.broker.disconnect(); } catch { /* ignore */ }
    }

    if (platform === 'expertoption') {
      const secret = sessionToken || password || '';
      const accountRow = await this.db.upsertAccount(
        platform, accountType, login, server || 'ExpertOption',
        require('./security').encryptSecret(secret), 0,
      );
      await this.db.setAccountStatus(accountRow.id, 'token_unverified');
      return this._wireExpertOptionAccount({
        accountId: accountRow.id,
        login,
        accountType,
        token: sessionToken || config.EXPERTOPTION_SESSION_TOKEN || '',
        stored: Boolean(secret),
        restored: false,
      });
    }

    let broker;
    let mode;
    if (accountType === 'real') {
      if (!MT5Broker.enabled()) {
        throw new Error('MT5 real trading needs MT5_ENABLED=true and a reachable Windows MT5 bridge');
      }
      broker = new MT5Broker({ isDemo: false });
      mode = 'live_bridge';
    } else if (platform === 'mt5' && MT5Broker.enabled()) {
      broker = new MT5Broker({ isDemo: true });
      mode = 'live_bridge';
    } else if (platform === 'mt5' && config.ALLOW_SIMULATED_MT5) {
      broker = new PaperBroker(config.DEMO_START_BALANCE, this.market);
      mode = 'simulated';
    } else if (platform === 'mt5') {
      throw new Error(
        'MT5 execution needs MT5_ENABLED=true and a reachable Windows MT5 bridge. '
        + 'No simulated MT5 trades are recorded unless ALLOW_SIMULATED_MT5=true is set deliberately.',
      );
    } else {
      broker = new PaperBroker(config.DEMO_START_BALANCE, this.market);
      mode = 'simulated';
    }

    let info = await broker.connect(login, password, server);
    info = await broker.accountInfo();
    if (!Number.isFinite(Number(info.balance)) || !Number.isFinite(Number(info.equity))) {
      throw new Error('Broker did not return a valid account snapshot; trading is blocked');
    }
    const existing = await this.db.latestAccount(platform, accountType);
    let startingBalance = Number(info.balance);
    if (broker instanceof PaperBroker) {
      startingBalance = Number(existing && existing.login === login ? existing.balance : config.DEMO_START_BALANCE);
      broker.balance = startingBalance;
      broker.equity = startingBalance;
      info = await broker.accountInfo();
    }

    const accountRow = await this.db.upsertAccount(
      platform, accountType, login, server || info.server || '',
      require('./security').encryptSecret(password), startingBalance,
    );

    this.account = accountRow;
    this.broker = broker;
    this.executionMode = mode;
    this.platform = platform;
    this.accountType = accountType;
    this.analysisOnly = false;
    this.accountBalance = Number(info.balance);
    this.accountEquity = Number(info.equity);
    this.marginFree = Number(info.margin_free || 0);
    this.marginUsed = Number(info.margin_used || 0);
    this.marginLevel = info.margin_level === null ? null : Number(info.margin_level);
    this.accountCurrency = info.currency || 'USD';
    this.accountSynced = true;
    this.accountSyncAt = info.synced_at || utcnow();
    this.accountSyncError = null;
    this.emergency = false;
    this.lastError = null;
    this.opportunities = [];
    this._lastTradeAt.clear();

    await this.db.setAccountSync(accountRow.id, {
      status: 'connected', balance: this.accountBalance, equity: this.accountEquity,
      margin_free: this.marginFree, margin_used: this.marginUsed, margin_level: this.marginLevel,
      currency: this.accountCurrency, synced_at: this.accountSyncAt,
    });
    this.account = { ...accountRow, ...(await this.db.getAccount(accountRow.id)) };
    await this.db.addLog('info', 'broker', `Connected ${platform} ${accountType} ${login}`, {
      mode, server: server || info.server || '', balance: this.accountBalance,
      equity: this.accountEquity, free_margin: this.marginFree,
    });
    if (broker.supportsPositions) await this.syncBrokerTrades();
    return this.status();
  }

  async disconnect() {
    await this.stop('disconnect');
    this.scanner.stopAuto();
    if (this.broker) {
      try { await this.broker.disconnect(); } catch { /* ignore */ }
    }
    if (this.account) await this.db.setAccountStatus(this.account.id, 'disconnected');
    this.broker = null;
    this.account = null;
    this.expertOptionSession = null;
    this.running = false;
    this.executionMode = 'none';
    this.analysisOnly = false;
    this.accountBalance = 0;
    this.accountEquity = 0;
    this.marginFree = 0;
    this.marginUsed = 0;
    this.marginLevel = null;
    this.accountSynced = false;
    this.accountSyncAt = null;
    this.accountSyncError = null;
    this.positionSyncAt = null;
    this.positionSyncError = null;
    this.brokerPositions = 0;
    this._lastTradeAt.clear();
    this.scanner.reset();
    await this.db.addLog('info', 'broker', 'Account disconnected');
    return { ok: true };
  }

  async start() {
    if (!this.account) throw new Error('Connect a demo account first');
    if (this.emergency) throw new Error('Emergency stop is active; reconnect the account to resume');
    if (!this.analysisOnly) {
      if (!this.broker) throw new Error('Connect a demo account first');
      await this.syncAccount();
      if (!this.accountSynced) throw new Error('Account sync failed; trading cannot start');
    }
    this.running = true;
    this._started = true;
    await this.db.addLog('info', 'engine', 'Bot started');
    if (this.telegram.enabled && this.notifications.bot_started) {
      const sent = await this.telegram.notifyBotStarted({
        accountType: this.accountType,
        login: this.account ? this.account.login : '',
        server: this.account ? this.account.server : '',
        speed: this.speed,
        executionMode: this.executionMode,
        connected: this.analysisOnly ? true : this.accountFresh(),
        platform: this.platform,
        tradingMode: this.tradingMode,
      });
      if (!sent.ok) await this.db.addLog('warn', 'telegram', `Start notification failed: ${sent.error}`);
    }
    if (!this._timer) {
      this._schedule(0);
    }
    return this.status();
  }

  async stop(reason = 'user') {
    this.running = false;
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (reason) await this.db.addLog('info', 'engine', `Bot stopped (${reason})`);
    return { ok: true };
  }

  async emergencyStop() {
    this.emergency = true;
    this.scanner.stopAuto();
    this.running = false;
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this.db.addLog('warn', 'engine', 'EMERGENCY STOP engaged');
    if (this.telegram.enabled) {
      await this.telegram.notifyError('Emergency stop engaged. Open trades were left untouched for manual review.');
    }
    return this.status();
  }

  _schedule(delay) {
    this._timer = setTimeout(async () => {
      this._timer = null;
      if (!this.running) return;
      try {
        await this.runCycle();
      } catch (err) {
        this.lastError = String(err.message).slice(0, 300);
        await this.db.addLog('error', 'engine', `Cycle failed: ${err.message}`).catch(() => {});
      }
      if (this.running) this._schedule(this._nextDelayMs || config.SCAN_INTERVAL_SECONDS * 1000);
      this._nextDelayMs = null;
    }, delay);
  }

  async runCycle() {
    if (this._busy || !this.running) return;
    this._busy = true;
    try {
      if (!this.analysisOnly) {
        await this.syncAccount();
        await this.processOpenTrades();
      }
      await this.scanAndTrade();
      if (!this.analysisOnly) await this.syncAccount();
      await this.maybeDailyReport();
    } finally {
      this._busy = false;
    }
  }

  accountFresh(maxAge = config.MT5_ACCOUNT_SYNC_MAX_AGE_SECONDS) {
    if (!this.accountSynced || !this.accountSyncAt) return false;
    return (Date.now() - new Date(this.accountSyncAt).getTime()) / 1000 <= Number(maxAge);
  }

  async syncAccount() {
    if (this.platform === 'expertoption' && this.expertOptionSession) {
      return this.syncExpertOptionAccount();
    }
    if (!this.broker || !this.account || this.analysisOnly) return;
    try {
      const info = await this.broker.accountInfo();
      const balance = Number(info.balance);
      const equity = Number(info.equity);
      if (!Number.isFinite(balance) || !Number.isFinite(equity)) {
        throw new Error('broker returned an invalid account snapshot');
      }
      this.accountBalance = balance;
      this.accountEquity = equity;
      this.marginFree = Number(info.margin_free || 0);
      this.marginUsed = Number(info.margin_used || 0);
      this.marginLevel = info.margin_level === null || info.margin_level === undefined
        ? null : Number(info.margin_level);
      this.accountCurrency = info.currency || 'USD';
      this.accountSynced = true;
      this.accountSyncAt = info.synced_at || utcnow();
      this.accountSyncError = null;
      await this.db.setAccountSync(this.account.id, {
        status: 'connected', balance: this.accountBalance, equity: this.accountEquity,
        margin_free: this.marginFree, margin_used: this.marginUsed, margin_level: this.marginLevel,
        currency: this.accountCurrency, synced_at: this.accountSyncAt,
      });
      this.account.balance = this.accountBalance;
      this.account.equity = this.accountEquity;
      this.account.margin_free = this.marginFree;
      this.account.margin_used = this.marginUsed;
      this.account.margin_level = this.marginLevel;
      this.account.synced_at = this.accountSyncAt;
    } catch (err) {
      this.accountSynced = false;
      this.accountSyncError = String(err.message).slice(0, 300);
      this.lastError = `Account sync: ${this.accountSyncError}`.slice(0, 300);
      if (this.broker) this.broker.connected = false;
      await this.db.setAccountStatus(this.account.id, 'disconnected').catch(() => {});
      await this.db.addLog('warn', 'broker', this.lastError).catch(() => {});
    }
  }

  async syncExpertOptionAccount() {
    const session = this.expertOptionSession;
    if (!this.account) return null;
    try {
      if (!session || !session.configured) throw new Error(GATEWAY_REASON_EN);
      if (!session.verified) await session.verify();
      const info = await session.accountInfo();
      this.accountBalance = Number(info.balance);
      this.accountEquity = Number(info.equity);
      this.marginFree = Number(info.free_margin || 0);
      this.marginUsed = Number(info.used_margin || 0);
      this.marginLevel = null;
      this.accountCurrency = info.currency || 'USD';
      this.accountSynced = true;
      this.accountSyncAt = info.read_at || utcnow();
      this.accountSyncError = null;
      await this.db.setAccountSync(this.account.id, {
        status: 'connected', balance: this.accountBalance, equity: this.accountEquity,
        margin_free: this.marginFree, margin_used: this.marginUsed, margin_level: null,
        currency: this.accountCurrency, synced_at: this.accountSyncAt,
      });
      this.account.balance = this.accountBalance;
      this.account.equity = this.accountEquity;
      this.account.synced_at = this.accountSyncAt;
      return info;
    } catch (err) {
      this.accountSynced = false;
      this.accountSyncError = String(err.message || 'account sync failed').slice(0, 300);
      await this.db.setAccountStatus(this.account.id, 'disconnected').catch(() => {});
      return null;
    }
  }

  async loadSnapshots(symbol, maxAge = 45) {
    const snaps = {};
    for (const timeframe of config.TIMEFRAMES) {
      const snap = await this.market.get(symbol, timeframe, maxAge);
      if (snap.isStale) {
        throw new MarketDataError(`stale data for ${symbol} ${timeframe}`);
      }
      snaps[timeframe] = snap;
    }
    return snaps;
  }

  scannerSummary() {
    const scanner = this.scanner.status();
    return {
      running: scanner.scan.running,
      auto: scanner.auto,
      scanned: scanner.scan.scanned,
      total: scanner.scan.total,
      qualified: scanner.scan.qualified,
      buys: scanner.scan.buys,
      sells: scanner.scan.sells,
      failed: scanner.scan.failed,
      stale: scanner.scan.stale,
      finished_at: scanner.scan.finished_at,
      execution_can_trade: false,
      execution_reason: EXECUTION_BLOCKED_REASON,
    };
  }

  expertOptionEnvState() {
    return {
      bridge_url_configured: Boolean(config.EXPERTOPTION_BRIDGE_URL || config.EXPERTOPTION_API_BASE_URL),
      bridge_key_configured: Boolean(config.EXPERTOPTION_BRIDGE_KEY || config.EXPERTOPTION_API_KEY),
      env_session_token_configured: Boolean(config.EXPERTOPTION_SESSION_TOKEN),
      database_url_configured: Boolean(config.DATABASE_URL),
      restore_enabled: Boolean(config.EXPERTOPTION_RESTORE_SESSION),
      real_read_allowed: Boolean(config.EXPERTOPTION_ALLOW_REAL_READ),
    };
  }

  async diagnoseExpertOption({ deep = true } = {}) {
    const env = this.expertOptionEnvState();
    const diag = {
      ok: false,
      cause: null,
      stage: 'env',
      ready: false,
      message_ar: '',
      message_en: '',
      next_step_ar: '',
      next_step_en: '',
      env,
      account_attached: false,
      session: null,
      bridge: null,
      assets: null,
      checked_at: new Date().toISOString(),
      execution_allowed: false,
    };
    const set = (cause, stage, ar, en, nextAr, nextEn) => {
      diag.cause = cause;
      diag.stage = stage;
      diag.message_ar = ar;
      diag.message_en = en;
      diag.next_step_ar = nextAr;
      diag.next_step_en = nextEn;
      return diag;
    };

    if (!env.bridge_url_configured) {
      return set('bridge_unconfigured', 'env',
        'EXPERTOPTION_BRIDGE_URL غير مضبوط على الخادم، لذلك لا يوجد مصدر لبيانات الحساب.',
        'EXPERTOPTION_BRIDGE_URL is not set on the server, so there is no account data source.',
        'من لوحة Render أضف EXPERTOPTION_BRIDGE_URL برابط خدمة rozlf-eo-bridge الفعلي.',
        'In the Render dashboard set EXPERTOPTION_BRIDGE_URL to the live rozlf-eo-bridge URL.');
    }
    if (!env.bridge_key_configured) {
      return set('bridge_key_unconfigured', 'env',
        'EXPERTOPTION_BRIDGE_KEY غير مضبوط على الخادم.',
        'EXPERTOPTION_BRIDGE_KEY is not set on the server.',
        'انسخ نفس قيمة EO_BRIDGE_API_KEY من خدمة الربط إلى EXPERTOPTION_BRIDGE_KEY في خدمة الباك اند.',
        'Copy the same EO_BRIDGE_API_KEY value from the bridge service into EXPERTOPTION_BRIDGE_KEY on the backend.');
    }
    if (!this.platform || this.platform !== 'expertoption' || !this.expertOptionSession) {
      return set('session_missing', 'account',
        'لا توجد جلسة ExpertOption محفوظة على الخادم الآن (لم يُستعَد أي حساب بعد إعادة التشغيل).',
        'No ExpertOption session is attached on the server right now (no account was restored after the restart).',
        env.database_url_configured
          ? 'أدخل Session Token من لوحة التحكم مرة أخرى (زر «اتصال») وسيُحفظ مشفراً في PostgreSQL.'
          : 'أضف DATABASE_URL (PostgreSQL) في Render ثم أدخل Session Token من الواجهة؛ بدون قاعدة بيانات تُفقد الجلسة عند كل إعادة تشغيل.',
        env.database_url_configured
          ? 'Re-enter the Session Token from the dashboard (Connect). It is stored encrypted in PostgreSQL.'
          : 'Add DATABASE_URL (PostgreSQL) in Render, then enter the Session Token in the UI; without a database the session is lost on every restart.');
    }

    const session = this.expertOptionSession;
    diag.account_attached = true;
    diag.session = {
      login: session.login || '',
      account_type: session.accountType || null,
      token_present: Boolean(session.token || session.tokenPresent),
      bridge_configured: Boolean(session.configured),
      verified: Boolean(session.verified),
      state: typeof session.status === 'function' ? session.status().connection_state : null,
      last_error: session.lastError || null,
    };

    if (!session.baseUrl) {
      return set('bridge_unconfigured', 'bridge',
        'الجلسة موجودة لكن رابط خدمة الربط غير متاح لهذه الجلسة.',
        'The session exists but the bridge URL is not available to it.',
        'أعد تشغيل خدمة الباك اند بعد ضبط EXPERTOPTION_BRIDGE_URL.',
        'Restart the backend service after setting EXPERTOPTION_BRIDGE_URL.');
    }
    if (!session.token) {
      return set('token_missing', 'session',
        'الجلسة محفوظة بلا Token صالح (تعذّر فك التشفير أو انتهى).',
        'The stored session has no usable token (decryption failed or it expired).',
        'أدخل Session Token جديداً من لوحة التحكم؛ سيُشفر بمفتاح APP_SECRET_KEY الحالي.',
        'Enter a fresh Session Token in the dashboard; it will be encrypted with the current APP_SECRET_KEY.');
    }

    if (!deep) return diag;

    let bridge = null;
    if (typeof session.diagnostics === 'function') bridge = await session.diagnostics();
    diag.bridge = bridge;
    if (bridge && bridge.reachable === false) {
      const authFailed = bridge.auth_failed === true
        || /401|403|unauthorized|invalid.*key|key rejected/i.test(String(bridge.error || ''));
      return set(authFailed ? 'bridge_auth_failed' : 'bridge_unreachable', 'bridge',
        authFailed
          ? 'خدمة الربط تعمل لكنها رفضت المفتاح (401/403): قيمة EXPERTOPTION_BRIDGE_KEY لا تطابق EO_BRIDGE_API_KEY.'
          : `تعذر الوصول إلى خدمة الربط: ${bridge.error || 'بدون استجابة'}.`,
        authFailed
          ? 'The bridge is up but rejected the key (401/403): EXPERTOPTION_BRIDGE_KEY does not match EO_BRIDGE_API_KEY.'
          : `The bridge is unreachable: ${bridge.error || 'no response'}.`,
        authFailed
          ? 'اجعل القيمتين متطابقتين في Render ثم أعد تشغيل خدمة الباك اند.'
          : 'تأكد أن خدمة rozlf-eo-bridge تعمل (Live) وأن الرابط منقول كما هو من Render.',
        authFailed
          ? 'Make the two values identical in Render, then restart the backend service.'
          : 'Confirm rozlf-eo-bridge is Live and that the URL was copied exactly from Render.');
    }
    diag.stage = 'session';

    const status = await session.verify().catch((err) => ({ verified: false, last_error: err.message }));
    diag.session.verified = Boolean(status.verified);
    diag.session.last_error = status.last_error || session.lastError || null;
    if (!session.verified) {
      const err = String(session.lastError || '');
      if (/EO_BRIDGE_API_KEY|bridge key/i.test(err)) {
        return set('bridge_auth_failed', 'bridge',
          'خدمة الربط تعمل لكنها رفضت المفتاح: قيمة EXPERTOPTION_BRIDGE_KEY لا تطابق EO_BRIDGE_API_KEY على خدمة rozlf-eo-bridge.',
          'The bridge is up but rejected the key: EXPERTOPTION_BRIDGE_KEY does not match EO_BRIDGE_API_KEY on rozlf-eo-bridge.',
          'انسخ EO_BRIDGE_API_KEY من خدمة rozlf-eo-bridge والصقه في EXPERTOPTION_BRIDGE_KEY على الباك اند، ثم أعد تشغيله.',
          'Copy EO_BRIDGE_API_KEY from rozlf-eo-bridge into EXPERTOPTION_BRIDGE_KEY on the backend, then restart it.');
      }
      const expired = /session_expired|expired|expir|unauthor|401|403|rejected/i.test(err);
      return set(expired ? 'session_expired' : 'session_rejected', 'session',
        expired
          ? 'الجلسة منتهية أو مرفوضة من خدمة الربط: أعد إدخال Session Token جديد من حساب ExpertOption.'
          : `تعذر التحقق من الجلسة: ${err || 'سبب غير معروف'}.`,
        expired
          ? 'The session expired or was rejected by the bridge: enter a fresh Session Token from the ExpertOption account.'
          : `Session verification failed: ${err || 'unknown reason'}.`,
        'من الواجهة: اتصال ← ExpertOption ← Demo ← الصق Session Token جديداً ← اختبار الاتصال.',
        'In the UI: Connect → ExpertOption → Demo → paste a fresh Session Token → test connection.');
    }

    try {
      diag.stage = 'instruments';
      const instruments = await session.markets({ force: true });
      const described = describeAccountAssets(instruments);
      diag.assets = {
        total: described.total,
        active: described.assets.length,
        inactive: described.inactive_count,
        otc: described.otc_count,
        by_category: described.by_category,
      };
      if (!described.assets.length) {
        return set('no_instruments', 'instruments',
          'الجلسة متصلة لكنها لم تُرجع أي أصل نشط من الحساب.',
          'The session is connected but returned no active instruments for the account.',
          'تأكد أن الحساب يحتوي أصولاً نشطة، أو أعد تسجيل الدخول لجلسة جديدة.',
          'Confirm the account has active assets, or sign in again for a fresh session.');
      }
      diag.ok = true;
      diag.ready = true;
      diag.stage = 'ready';
      diag.message_ar = `الاتصال سليم: ${described.assets.length} أصل نشط متاح من الحساب.`;
      diag.message_en = `Connection healthy: ${described.assets.length} active account assets available.`;
      return diag;
    } catch (err) {
      return set(err.code === 'session_expired' ? 'session_expired' : 'instruments_failed', 'instruments',
        `تعذر قراءة قائمة الأصول: ${err.message}`,
        `Instrument list failed: ${err.message}`,
        'أعد المحاولة بعد لحظات، وإن تكرر فأعد إدخال Session Token.',
        'Retry shortly; if it repeats, re-enter the Session Token.');
    }
  }

  async expertOptionAssets() {
    const diagnosis = await this.diagnoseExpertOption();
    if (!this.platform || this.platform !== 'expertoption' || !this.expertOptionSession) {
      return {
        ok: false,
        detail: diagnosis.message_ar,
        detail_ar: diagnosis.message_ar,
        detail_en: diagnosis.message_en,
        cause: diagnosis.cause,
        next_step_ar: diagnosis.next_step_ar,
        next_step_en: diagnosis.next_step_en,
        env: diagnosis.env,
        assets: [],
        priority: describeAssets([]),
        source_ready: false,
        listed: false,
        execution_allowed: false,
      };
    }
    const session = this.expertOptionSession;
    if (!session.configured) {
      return {
        ok: false,
        detail: diagnosis.message_ar || GATEWAY_REASON_EN,
        detail_ar: diagnosis.message_ar || GATEWAY_REASON_AR,
        detail_en: diagnosis.message_en || GATEWAY_REASON_EN,
        cause: diagnosis.cause,
        next_step_ar: diagnosis.next_step_ar,
        next_step_en: diagnosis.next_step_en,
        assets: [],
        priority: describeAssets([]),
        source_ready: false,
        listed: false,
        execution_allowed: false,
      };
    }
    if (!diagnosis.ok) {
      return {
        ok: false,
        detail: diagnosis.message_ar,
        detail_ar: diagnosis.message_ar,
        detail_en: diagnosis.message_en,
        cause: diagnosis.cause,
        next_step_ar: diagnosis.next_step_ar,
        next_step_en: diagnosis.next_step_en,
        assets: [],
        priority: describeAssets([]),
        source_ready: false,
        listed: false,
        reconnect_required: diagnosis.cause === 'session_expired',
        execution_allowed: false,
      };
    }
    try {
      const instruments = await session.markets();
      const described = describeAccountAssets(instruments);
      return {
        ok: true,
        detail: null,
        cause: null,
        assets: described.assets,
        all_assets: described.all_assets,
        priority: describeAssets(instruments),
        instruments: instruments.length,
        available: described.assets.length,
        inactive: described.inactive_count,
        by_category: described.by_category,
        otc_count: described.otc_count,
        source_ready: true,
        listed: true,
        source: { provider: 'ExpertOption account session (ROZLF bridge)', verified: true },
        execution_allowed: false,
      };
    } catch (err) {
      const keyRejected = err.code === 'bridge_auth_failed' || /EO_BRIDGE_API_KEY|bridge key/i.test(String(err.message || ''));
      const expired = err.code === 'session_expired';
      if (!keyRejected && /not_verified|session_expired|bridge/i.test(String(err.code || ''))) {
        const fresh = await this.diagnoseExpertOption().catch(() => null);
        if (fresh && !fresh.ok && fresh.cause) {
          return {
            ok: false,
            detail: fresh.message_ar,
            detail_ar: fresh.message_ar,
            detail_en: fresh.message_en,
            cause: fresh.cause,
            next_step_ar: fresh.next_step_ar,
            next_step_en: fresh.next_step_en,
            assets: [],
            priority: describeAssets([]),
            source_ready: false,
            listed: false,
            reconnect_required: fresh.cause === 'session_expired',
            execution_allowed: false,
          };
        }
      }
      return {
        ok: false,
        detail: String(err.message || 'تعذر قراءة قائمة الأصول'),
        detail_ar: keyRejected
          ? 'خدمة الربط رفضت المفتاح: EXPERTOPTION_BRIDGE_KEY لا يطابق EO_BRIDGE_API_KEY.'
          : `تعذر قراءة قائمة الأصول: ${err.message}`,
        detail_en: keyRejected
          ? 'The bridge rejected the key: EXPERTOPTION_BRIDGE_KEY does not match EO_BRIDGE_API_KEY.'
          : `Instrument list failed: ${err.message}`,
        cause: keyRejected ? 'bridge_auth_failed' : (expired ? 'session_expired' : 'instruments_failed'),
        next_step_ar: keyRejected
          ? 'انسخ EO_BRIDGE_API_KEY من خدمة rozlf-eo-bridge إلى EXPERTOPTION_BRIDGE_KEY ثم أعد تشغيل الباك اند.'
          : (expired ? 'أدخل Session Token جديداً من الواجهة.' : 'أعد المحاولة؛ وإن تكرر راجع سجل خدمة الربط.'),
        next_step_en: keyRejected
          ? 'Copy EO_BRIDGE_API_KEY from rozlf-eo-bridge into EXPERTOPTION_BRIDGE_KEY, then restart the backend.'
          : (expired ? 'Enter a fresh Session Token in the dashboard.' : 'Retry; if it repeats, check the bridge logs.'),
        assets: [],
        priority: describeAssets([]),
        source_ready: false,
        listed: false,
        reconnect_required: expired,
        execution_allowed: false,
      };
    }
  }

  async expertOptionQuote(assetKey, timeframe = 'M1', instrumentId = null) {
    if (this.platform !== 'expertoption' || !this.expertOptionSession) {
      return { ok: false, reason_code: 'no_session' };
    }
    const byInstrument = instrumentId !== null && instrumentId !== undefined && String(instrumentId) !== '';
    if (!byInstrument && !ASSET_KEYS.has(String(assetKey))) return { ok: false, reason_code: 'bad_asset' };
    const session = this.expertOptionSession;
    if (session.configured && !session.verified) await session.verify();
    if (!session.verified) return { ok: false, reason_code: 'not_connected', reason: session.lastError || null };
    try {
      const instruments = await session.markets();
      const resolved = byInstrument
        ? (instruments.find((i) => String(i.id) === String(instrumentId)) ? { instrument: instruments.find((i) => String(i.id) === String(instrumentId)) } : null)
        : resolveInstrument(instruments, String(assetKey));
      if (!resolved) return { ok: false, reason_code: 'asset_not_found' };
      const quote = await session.quote({ instrumentId: resolved.instrument.id, timeframe });
      return { ok: true, ...quote, asset: resolved.instrument.name, instrument_id: resolved.instrument.id };
    } catch (err) {
      return { ok: false, reason_code: err.code || 'quote_failed', reason: String(err.message || 'quote failed').slice(0, 200) };
    }
  }

  async expertOptionAnalyze(assetKey, expiry, instrumentId = null) {
    if (this.platform !== 'expertoption' || !this.expertOptionSession) {
      const diagnosis = await this.diagnoseExpertOption({ deep: false });
      return {
        ok: false, direction: 'NO TRADE', reason_code: diagnosis.cause || 'no_session',
        reason_ar: diagnosis.message_ar || 'اتصل بجلسة ExpertOption أولاً.',
        reason_en: diagnosis.message_en || 'Attach an ExpertOption session first.',
        next_step_ar: diagnosis.next_step_ar || null, next_step_en: diagnosis.next_step_en || null,
        execution_allowed: false,
      };
    }
    const byInstrument = instrumentId !== null && instrumentId !== undefined && String(instrumentId) !== '';
    if (!byInstrument && !ASSET_KEYS.has(String(assetKey))) {
      return { ok: false, direction: 'NO TRADE', reason_code: 'bad_asset', reason_ar: 'أصل غير معروف.', execution_allowed: false };
    }
    if (!EXPIRY_KEYS.has(String(expiry))) {
      return { ok: false, direction: 'NO TRADE', reason_code: 'bad_expiry', reason_ar: 'مدة غير مدعومة.', execution_allowed: false };
    }
    if (this.expertOptionSession.configured && !this.expertOptionSession.verified) {
      await this.expertOptionSession.verify();
    }
    const result = await analyzeAsset({
      session: this.expertOptionSession,
      assetKey: String(assetKey || ''),
      instrumentId: byInstrument ? String(instrumentId) : undefined,
      expiry: String(expiry),
      analyzer: this.analyzer,
    });
    if (result.ok && result.chart && Array.isArray(result.chart.candles) && result.chart.candles.length >= 10) {
      try {
        result.chart_path = await renderAnalysisChart({
          symbol: result.asset?.name || result.asset?.symbol || 'ExpertOption',
          timeframe: result.timeframe,
          direction: result.direction,
          candles: result.chart.candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })),
          price: result.live_price || result.price,
          outputDir: this.chartDir,
          expiryLabel: result.expiry_label_en || result.expiry,
          confidence: result.confidence,
        });
      } catch (err) {
        await this.db.addLog('warn', 'chart', `Analysis chart failed: ${err.message}`).catch(() => {});
      }
    }
    if (result.ok) await this.syncExpertOptionAccount().catch(() => {});
    await this.db.addLog(result.ok ? 'info' : 'warn', 'expertoption_analysis',
      `Automatic analysis ${result.ok ? result.direction : `blocked: ${result.reason_code}`}`, {
        asset: String(assetKey || instrumentId || ''), expiry: String(expiry),
        direction: result.direction, reason_code: result.reason_code || null,
        price: result.price || null, ai_reviewed: Boolean(result.ai?.reviewed),
      });
    return result;
  }

  async status() {
    const risk = this.risk.settings;
    let openTrades = [];
    let todayTrades = [];
    let closedToday = [];
    if (this.account) {
      [openTrades, todayTrades, closedToday] = await Promise.all([
        this.db.openTrades(this.account.id),
        this.db.tradesToday(this.account.id),
        this.db.closedToday(this.account.id),
      ]);
    }
    const todayPnl = Math.round(closedToday.reduce((sum, t) => sum + Number(t.pnl || 0), 0) * 100) / 100;
    const balance = this.accountBalance || 0;
    return {
      connected: Boolean(this.account),
      account_login: this.account ? this.account.login : '',
      account_type: this.accountType,
      account_synced: this.accountSynced,
      account_data_fresh: this.accountFresh(),
      account_sync_at: this.accountSyncAt,
      account_sync_error: this.accountSyncError,
      account_status: this.analysisOnly ? 'analysis' : (this.accountSynced ? 'connected' : 'disconnected'),
      expertoption: this.expertOptionSession ? this.expertOptionSession.status() : null,
      session_restore: this.sessionRestore || { restored: false, reason: 'not_attempted' },
      market_data_source: this.platform === 'expertoption'
        ? (this.expertOptionSession && this.expertOptionSession.verified
          ? {
              provider: 'ExpertOption authorized gateway',
              kind: 'account_session',
              account_session_data: true,
              broker_approved: false,
              available: true,
              reason_en: null,
              reason_ar: null,
              note_en: 'Candles come from the configured ExpertOption data gateway for this account.',
              note_ar: 'الشموع تأتي من بوابة بيانات ExpertOption المهيأة لهذا الحساب.',
            }
          : {
              provider: 'Yahoo Finance',
              kind: 'public_reference',
              account_session_data: false,
              broker_approved: false,
              available: true,
              reason_en: SOURCE_REASON_EN,
              reason_ar: SOURCE_REASON_AR,
              note_en: 'ExpertOption session data is not verified; the scanner uses public reference candles only.',
              note_ar: 'بيانات جلسة ExpertOption غير متحققة؛ الماسح يستخدم شموعاً مرجعية عامة فقط.',
            })
        : {
            provider: 'Yahoo Finance',
            kind: 'public_reference',
            account_session_data: false,
            broker_approved: false,
            available: true,
          },
      scanner: this.scannerSummary(),
      analysis_only: this.analysisOnly,
      margin_free: this.marginFree,
      margin_used: this.marginUsed,
      margin_level: this.marginLevel,
      position_sync_at: this.positionSyncAt,
      position_sync_error: this.positionSyncError,
      broker_positions: this.brokerPositions,
      ai_enabled: this.analyzer.enabled,
      balance,
      equity: this.accountEquity || balance,
      broker_connected: Boolean(this.broker && this.broker.connected),
      currency: this.accountCurrency,
      daily_loss_limit: Math.round(((balance * Number(risk.daily_loss_limit_percent || 0)) / 100) * 100) / 100,
      emergency: this.emergency,
      execution_mode: this.executionMode,
      last_error: this.lastError,
      last_scan_at: this.lastScanAt,
      market_connected: this.marketConnected,
      open_trades: openTrades,
      opportunities: this.opportunities,
      platform: this.platform,
      real_trading_approved: config.REAL_TRADING_APPROVED,
      risk,
      running: this.running,
      scan_count: this.scanCount,
      scanning: this._busy,
      speed: this.speed,
      speed_preset: this.speedPreset,
      telegram_enabled: this.telegram.enabled,
      today_pnl: todayPnl,
      today_trades: todayTrades.length,
      trading_mode: this.tradingMode,
      timeframe: this.timeframe,
      symbols: [...this.symbols],
      notifications: { ...this.notifications },
      notifications_enabled: this.telegram.enabled,
    };
  }

  async syncBrokerTrades() {
    if (!this.account || !this.broker || !this.broker.supportsPositions) return;
    this._lastPositionNotice = this._lastPositionNotice || new Map();
    let positions;
    try {
      positions = await this.broker.positions();
    } catch (err) {
      this.positionSyncError = String(err.message).slice(0, 300);
      this.lastError = `Position sync: ${this.positionSyncError}`.slice(0, 300);
      await this.db.addLog('warn', 'broker', this.lastError);
      return;
    }
    this.positionSyncError = null;
    this.positionSyncAt = utcnow();
    this.brokerPositions = positions.length;
    const openTrades = await this.db.openTrades(this.account.id);
    const byTicket = new Map(openTrades.filter((t) => t.broker_order_id).map((t) => [String(t.broker_order_id), t]));

    for (const position of positions) {
      const trade = byTicket.get(position.ticket);
      if (trade) {
        await this.db.updateTradeLive(trade.id, position.current_price, position.pnl);
        const stopsChanged = (position.stop_loss > 0 && Number(position.stop_loss) !== Number(trade.stop_loss)) ||
          (position.take_profit > 0 && Number(position.take_profit) !== Number(trade.take_profit));
        if (stopsChanged) {
          await this.db.updateTradeStops(
            trade.id,
            position.stop_loss > 0 ? position.stop_loss : trade.stop_loss,
            position.take_profit > 0 ? position.take_profit : trade.take_profit,
          );
        }
        const fingerprint = `${position.stop_loss}|${position.take_profit}`;
        if (stopsChanged && this._lastPositionNotice.get(position.ticket) !== fingerprint && this.telegram.enabled) {
          this._lastPositionNotice.set(position.ticket, fingerprint);
          const sent = await this.telegram.notifyUpdate(trade, {
            current_price: position.current_price, stop_loss: position.stop_loss,
            take_profit: position.take_profit, unrealized_pnl: position.pnl,
          });
          if (!sent.ok) await this.db.addLog('warn', 'telegram', `Update notification failed: ${sent.error}`);
        }
        continue;
      }

      const duplicate = await this.db.tradeByBrokerOrder(this.account.id, position.ticket);
      if (duplicate) {
        if (duplicate.status === 'OPEN') continue;
        await this.db.addLog('warn', 'broker', `Ticket ${position.ticket} is already closed on the site`);
        continue;
      }

      let chartPath = '';
      try {
        const snap = await this.market.get(position.symbol, 'M15', 120);
        chartPath = await renderTradeChart({
          symbol: position.symbol, timeframe: 'M15', side: position.side,
          candles: snap.candles.slice(-90), entry: position.entry_price,
          stopLoss: position.stop_loss, takeProfit: position.take_profit,
          outputDir: this.chartDir,
        });
      } catch (err) {
        await this.db.addLog('warn', 'chart', `Imported trade chart failed: ${err.message}`);
      }
      const imported = await this.db.createTrade({
        account_id: this.account.id,
        platform: this.platform,
        symbol: position.symbol,
        timeframe: 'M15',
        side: position.side,
        entry_price: position.entry_price,
        stop_loss: position.stop_loss,
        take_profit: position.take_profit,
        lot: position.lot,
        risk_amount: 0,
        confidence: null,
        reason: 'Imported from an existing MetaTrader 5 position',
        status: 'OPEN',
        broker_order_id: position.ticket,
        opened_at: position.opened_at || utcnow(),
        chart_path: chartPath,
      });
      await this.db.updateTradeLive(imported.id, position.current_price, position.pnl);
      await this.db.addLog('info', 'broker', `Imported MT5 ticket ${position.ticket} ${position.symbol}`, {
        side: position.side, lot: position.lot, source: 'mt5',
      });
      if (this.telegram.enabled) {
        const sent = await this.telegram.notifyImported({ ...imported, account_type: this.accountType }, chartPath);
        if (!sent.ok) await this.db.addLog('warn', 'telegram', `Import notification failed: ${sent.error}`);
      }
    }

    const ticketSet = new Set(positions.map((p) => p.ticket));
    for (const trade of openTrades) {
      if (!trade.broker_order_id || ticketSet.has(String(trade.broker_order_id))) continue;
      let closed;
      try {
        closed = await this.broker.history(trade.broker_order_id);
      } catch (err) {
        await this.db.addLog('warn', 'broker', `History lookup failed for ${trade.broker_order_id}: ${err.message}`);
        continue;
      }
      if (!closed || !(closed.close_price > 0)) {
        await this.db.addLog('warn', 'broker', `Ticket ${trade.broker_order_id} missing from MT5 positions and history; left open`);
        continue;
      }
      const pnl = Number(closed.pnl || 0);
      const resultTag = pnl >= 0 ? 'WIN' : 'LOSS';
      const closedTrade = await this.db.closeTrade(trade.id, closed.close_price, pnl, resultTag);
      let snap = null;
      try { snap = await this.market.get(trade.symbol, 'M5', 180); } catch { /* chart is optional */ }
      let chartPath = '';
      if (snap) {
        try {
          chartPath = await renderResultChart({
            symbol: trade.symbol, timeframe: trade.timeframe, side: trade.side,
            candles: snap.candles.slice(-90), entry: trade.entry_price,
            stopLoss: trade.stop_loss, takeProfit: trade.take_profit,
            exitPrice: closed.close_price, pnl, result: resultTag, outputDir: this.chartDir,
          });
        } catch (err) {
          await this.db.addLog('warn', 'chart', `Result chart failed: ${err.message}`);
        }
      }
      await this.db.addLog('info', 'trade', `MT5 closed ${trade.symbol} ${resultTag} ${pnl}`, {
        ticket: trade.broker_order_id, exit: closed.close_price,
      });
      if (this.telegram.enabled && this.notifications.trade_close) {
        const seenChart = this.notifications.charts ? chartPath : '';
        const sent = await this.telegram.notifyClose({ ...closedTrade, account_type: this.accountType }, seenChart);
        if (!sent.ok) await this.db.addLog('warn', 'telegram', `Close notification failed: ${sent.error}`);
      }
      this.opportunities = this.opportunities.filter((o) => o.symbol !== trade.symbol);
    }
    await this.syncAccount();
  }

  async processOpenTrades() {
    if (!this.account || !this.broker) return;
    // MT5 closes are driven by the terminal and reconciled from positions/history.
    if (this.broker.supportsPositions) return;
    const trades = await this.db.openTrades(this.account.id);
    for (const trade of trades) {
      let snap;
      try {
        snap = await this.market.get(trade.symbol, 'M5', 60);
      } catch (err) {
        await this.db.addLog('warn', 'trade', `Cannot price open trade ${trade.symbol}: ${err.message}`);
        continue;
      }
      const candle = snap.candles[snap.candles.length - 1];
      let exitLevel = null;
      if (trade.side === 'BUY') {
        if (candle.low <= trade.stop_loss) exitLevel = trade.stop_loss;
        else if (candle.high >= trade.take_profit) exitLevel = trade.take_profit;
      } else if (candle.high >= trade.stop_loss) {
        exitLevel = trade.stop_loss;
      } else if (candle.low <= trade.take_profit) {
        exitLevel = trade.take_profit;
      }
      if (exitLevel === null) continue;

      const before = Number(this.accountBalance || 0);
      let fillPrice;
      let pnl;
      try {
        const result = await this.broker.closeOrder(
          trade.broker_order_id, trade.symbol, trade.side, trade.lot, exitLevel,
        );
        fillPrice = Number(result.fill_price || exitLevel);
        if (this.broker instanceof PaperBroker) {
          pnl = this.broker.realizedPnl(trade.symbol, trade.side, trade.entry_price, fillPrice, trade.lot);
          this.broker.applyPnl(pnl);
        } else {
          const info = await this.broker.accountInfo();
          pnl = Math.round((Number(info.balance || 0) - before) * 100) / 100;
        }
      } catch (err) {
        this.lastError = `Close failed for ${trade.symbol}: ${err.message}`.slice(0, 300);
        await this.db.addLog('error', 'trade', this.lastError);
        continue;
      }

      const resultTag = pnl >= 0 ? 'WIN' : 'LOSS';
      const closed = await this.db.closeTrade(trade.id, fillPrice, pnl, resultTag);
      this.accountBalance = Math.round((before + pnl) * 100) / 100;
      this.accountEquity = this.accountBalance;

      let chartPath = '';
      try {
        chartPath = await renderResultChart({
          symbol: trade.symbol, timeframe: trade.timeframe, side: trade.side,
          candles: snap.candles.slice(-90), entry: trade.entry_price,
          stopLoss: trade.stop_loss, takeProfit: trade.take_profit,
          exitPrice: fillPrice, pnl, result: resultTag, outputDir: this.chartDir,
        });
      } catch (err) {
        await this.db.addLog('warn', 'chart', `Result chart failed: ${err.message}`);
      }

      await this.db.addLog('info', 'trade', `Closed ${trade.symbol} ${trade.side} ${resultTag} ${pnl}`, {
        entry: trade.entry_price, exit: fillPrice,
      });
      if (this.telegram.enabled && this.notifications.trade_close) {
        const seenChart = this.notifications.charts ? chartPath : '';
        const sent = await this.telegram.notifyClose({ ...closed, account_type: this.accountType }, seenChart);
        if (!sent.ok) await this.db.addLog('warn', 'telegram', `Close notification failed: ${sent.error}`);
      }
      this.opportunities = this.opportunities.filter((o) => o.symbol !== trade.symbol);
    }
  }

  publishOpportunity(signal) {
    const item = {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      side: signal.side,
      confidence: signal.confidence,
      entry: signal.entry,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      reason: signal.reason_en,
      reason_ar: signal.reason_ar,
      updated_at: utcnow(),
    };
    const index = this.opportunities.findIndex((o) => o.symbol === signal.symbol);
    if (index >= 0) this.opportunities[index] = item;
    else this.opportunities.push(item);
    this.opportunities = this.opportunities.slice(0, 12);
  }

  applyConfiguredStops(signal) {
    const stopPips = Number(this.risk.get('stop_loss_pips'));
    const targetPips = Number(this.risk.get('take_profit_pips'));
    if (!(stopPips > 0) && !(targetPips > 0)) return signal;
    const pip = pipSize(signal.symbol);
    const digits = pip >= 0.1 ? 2 : pip >= 0.01 ? 3 : 5;
    const entry = Number(signal.entry);
    if (stopPips > 0) {
      const raw = signal.side === 'BUY' ? entry - stopPips * pip : entry + stopPips * pip;
      signal.stop_loss = Number(raw.toFixed(digits));
    }
    if (targetPips > 0) {
      const raw = signal.side === 'BUY' ? entry + targetPips * pip : entry - targetPips * pip;
      signal.take_profit = Number(raw.toFixed(digits));
    }
    return signal;
  }

  async scanAndTrade({ execute = true } = {}) {
    if (!this.account && !this.analysisOnly) return;
    const canExecute = Boolean(
      execute && this.account && this.broker && !this.analysisOnly && this.running
      && !this.emergency && this.tradingMode === 'demo' && this.accountFresh(),
    );
    const candidates = [];
    const errors = [];
    let fetched = 0;
    this.opportunities = [];

    for (const symbol of this.symbols) {
      try {
        const snaps = await this.loadSnapshots(symbol);
        fetched += 1;
        const signal = buildSignal(symbol, this.timeframe, snaps, {
          minConfidence: this.speedPreset.min_confidence,
          requireH4: this.speedPreset.require_h4,
        });
        this.applyConfiguredStops(signal);
        this.publishOpportunity(signal);
        if (signal.side === 'BUY' || signal.side === 'SELL') {
          candidates.push({ signal, snaps });
          await this.notifyOpportunity(signal, this.market.spreadPips(signal.symbol, signal.atr));
        }
      } catch (err) {
        errors.push(`${symbol}: ${err.message}`);
        await this.db.addLog('warn', 'market', `Scan skipped ${symbol}: ${err.message}`);
      }
    }

    this.scanCount += 1;
    this.lastScanAt = utcnow();
    this._nextDelayMs = this.speedPreset.scan_interval_seconds * 1000;
    this.marketConnected = fetched > 0;
    this.lastError = fetched === 0
      ? `No fresh market data. ${errors.slice(0, 2).join('; ')}`.slice(0, 300)
      : null;

    if (!candidates.length || !canExecute) return;
    candidates.sort((a, b) => b.signal.confidence - a.signal.confidence);

    const open = await this.db.openTrades(this.account.id);
    const today = await this.db.tradesToday(this.account.id);
    const closed = await this.db.closedToday(this.account.id);
    const todayPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);

    for (const candidate of candidates) {
      const { signal, snaps } = candidate;
      const spreadPips = this.market.spreadPips(signal.symbol, signal.atr);
      const decision = this.risk.evaluate({
        signal,
        balance: this.accountBalance,
        equity: this.accountEquity,
        openTrades: open,
        todayTrades: today,
        todayPnl,
        spreadPips,
        dataFresh: true,
        connected: Boolean(this.broker.connected),
        accountSynced: this.accountFresh(),
        freeMargin: this.marginFree,
        marginLevel: this.marginLevel,
        emergencyStop: this.emergency,
        running: this.running,
        minConfidence: this.speedPreset.min_confidence,
      });

      if (!decision.allowed) {
        await this.sendAnalysisAlert(signal, decision.reason, spreadPips);
        continue;
      }

      if (this.analyzer.enabled) {
        const review = await this.analyzer.review(signal, {
          spread_pips: spreadPips,
          atr: signal.atr,
          balance: this.accountBalance,
          free_margin: this.marginFree,
          margin_level: this.marginLevel,
          open_trades: open.length,
          today_trades: today.length,
          today_pnl: todayPnl,
        });
        await this.db.addLog('info', 'ai', `AI ${review.verdict}: ${review.rationale}`);
        if (review.verdict === 'REJECT') {
          await this.db.addLog('warn', 'ai', `Trade blocked by AI on ${signal.symbol}`);
          await this.sendAnalysisAlert(signal, 'Gemini rejected the setup', spreadPips);
          continue;
        }
      }

      await this.executeTrade({ signal, snaps, decision, spreadPips });
      return;
    }
  }

  async notifyOpportunity(signal, spreadPips) {
    if (!this.telegram.enabled || !this.notifications.opportunity) return;
    const fingerprint = `${signal.side}|${signal.entry}|${signal.stop_loss}|${signal.take_profit}|${signal.timeframe}`;
    const previous = this._lastOpportunityNotice.get(signal.symbol);
    if (previous && previous.fingerprint === fingerprint && Date.now() - previous.at < 15 * 60 * 1000) {
      return;
    }
    this._lastOpportunityNotice.set(signal.symbol, { fingerprint, at: Date.now() });
    const sent = await this.telegram.notifyOpportunity(signal, spreadPips);
    if (!sent.ok) await this.db.addLog('warn', 'telegram', `Opportunity notification failed: ${sent.error}`);
  }

  async notifyExecutionFailure(signal, reason) {
    const message = String(reason || 'MT5 did not confirm the order').slice(0, 300);
    this.lastError = message;
    await this.db.addLog('error', 'trade', `Execution failed ${signal.symbol}: ${message}`).catch(() => {});
    if (this.telegram.enabled) {
      const sent = await this.telegram.notifyExecutionFailure(signal, message);
      if (!sent.ok) await this.db.addLog('warn', 'telegram', `Failure notification failed: ${sent.error}`);
    }
  }

  async sendAnalysisAlert(signal, reason, spreadPips) {
    if (!this.telegram.enabled || !this.notifications.opportunity) return;
    const last = this._alerted.get(signal.symbol) || 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;
    this._alerted.set(signal.symbol, Date.now());
    const text = [
      `<b>ROZLF analysis — ${signal.symbol} ${signal.timeframe}</b>`,
      `Signal: ${signal.side} | Confidence: ${Math.round(signal.confidence * 100)}%`,
      `Entry: ${signal.entry} | SL: ${signal.stop_loss} | TP: ${signal.take_profit}`,
      `Spread: ${spreadPips} pips`,
      `Not executed: ${reason}`,
      `Analysis only for ExpertOption accounts.`,
    ].join('\n');
    const sent = await this.telegram.sendMessage(text);
    if (!sent.ok) await this.db.addLog('warn', 'telegram', `Analysis alert failed: ${sent.error}`);
  }

  async analyzeNow() {
    if (this._busy) throw new Error('A market scan is already running');
    if (!this.account && !this.analysisOnly) throw new Error('Connect an account or analysis session first');
    this._busy = true;
    try {
      await this.scanAndTrade({ execute: false });
    } finally {
      this._busy = false;
    }
    return { scan_count: this.scanCount, opportunities: this.opportunities, last_scan_at: this.lastScanAt };
  }

  async stats() {
    if (!this.account) {
      return { total: 0, wins: 0, losses: 0, total_pnl: 0, avg_pnl: 0, win_rate: 0, open: 0, today: 0, today_pnl: 0 };
    }
    const [aggregate, openTrades, todayTrades, closedToday] = await Promise.all([
      this.db.tradeStats(this.account.id),
      this.db.openTrades(this.account.id),
      this.db.tradesToday(this.account.id),
      this.db.closedToday(this.account.id),
    ]);
    const todayPnl = Math.round(closedToday.reduce((sum, t) => sum + Number(t.pnl || 0), 0) * 100) / 100;
    return { ...aggregate, open: openTrades.length, today: todayTrades.length, today_pnl: todayPnl };
  }

  async latestOpportunityChart() {
    const opportunity = this.opportunities.find((o) => o.side === 'BUY' || o.side === 'SELL');
    if (!opportunity) throw new Error('No active BUY or SELL opportunity to chart');
    const snap = await this.market.get(opportunity.symbol, opportunity.timeframe, 120);
    const chartPath = await renderTradeChart({
      symbol: opportunity.symbol,
      timeframe: opportunity.timeframe,
      side: opportunity.side,
      candles: snap.candles.slice(-90),
      entry: opportunity.entry,
      stopLoss: opportunity.stop_loss,
      takeProfit: opportunity.take_profit,
      outputDir: this.chartDir,
    });
    return {
      path: chartPath,
      caption: [
        `<b>${opportunity.symbol} ${opportunity.timeframe} — ${opportunity.side}</b>`,
        `Entry: <code>${opportunity.entry}</code>`,
        `SL: <code>${opportunity.stop_loss}</code> | TP: <code>${opportunity.take_profit}</code>`,
        `Confidence: ${Math.round(Number(opportunity.confidence || 0) * 100)}%`,
        `Reason: ${opportunity.reason || opportunity.reason_ar || ''}`,
      ].join('\n'),
    };
  }

  async closeAllTrades({ confirm = false } = {}) {
    if (!confirm) throw new Error('Closing all trades requires explicit confirmation');
    if (!this.account || !this.broker || this.analysisOnly) {
      throw new Error('No execution account is connected');
    }
    const trades = await this.db.openTrades(this.account.id);
    if (!trades.length) return { closed: 0, failed: 0, results: [] };
    const results = [];
    for (const trade of trades) {
      try {
        const before = Number(this.accountBalance || 0);
        let reference = null;
        try { reference = await this.market.latestPrice(trade.symbol); } catch { /* broker price is used */ }
        const result = await this.broker.closeOrder(
          trade.broker_order_id, trade.symbol, trade.side, trade.lot, reference,
        );
        let fillPrice = Number(result.fill_price || reference || trade.entry_price);
        let pnl = 0;
        if (this.broker.supportsPositions) {
          const history = await this.broker.history(trade.broker_order_id);
          if (!history || !(history.close_price > 0)) {
            throw new Error('MT5 did not confirm the closed position in history');
          }
          fillPrice = Number(history.close_price);
          pnl = Number(history.pnl || 0);
        } else {
          pnl = this.broker.realizedPnl(trade.symbol, trade.side, trade.entry_price, fillPrice, trade.lot);
          this.broker.applyPnl(pnl);
        }
        const resultTag = pnl >= 0 ? 'WIN' : 'LOSS';
        const closed = await this.db.closeTrade(trade.id, fillPrice, pnl, resultTag);
        this.accountBalance = Math.round((before + pnl) * 100) / 100;
        this.accountEquity = this.accountBalance;
        await this.db.addLog('info', 'trade', `Closed by user ${trade.symbol} ${trade.side} ${resultTag} ${pnl}`);
        if (this.telegram.enabled && this.notifications.trade_close) {
          await this.telegram.notifyClose({ ...closed, account_type: this.accountType }, '');
        }
        results.push({ id: trade.id, symbol: trade.symbol, result: resultTag, pnl });
      } catch (err) {
        await this.db.addLog('error', 'trade', `Manual close failed ${trade.symbol}: ${err.message}`);
        results.push({ id: trade.id, symbol: trade.symbol, result: 'FAILED', error: err.message });
      }
    }
    if (this.broker.supportsPositions) await this.syncBrokerTrades();
    return {
      closed: results.filter((r) => r.result !== 'FAILED').length,
      failed: results.filter((r) => r.result === 'FAILED').length,
      results,
    };
  }

  async sendDailyReport() {
    const stats = await this.stats();
    if (this.telegram.enabled) {
      await this.telegram.notifyDailyReport({
        ...stats,
        balance: this.accountBalance,
        currency: this.accountCurrency,
        mode: this.tradingMode,
        speed: this.speed,
      });
    }
    return stats;
  }

  async maybeDailyReport() {
    if (!this.telegram.enabled || !this.notifications.daily_report) return;
    const today = utcnow().slice(0, 10);
    const last = await this.db.getSetting('notifications.last_daily_report', null);
    if (last === today) return;
    await this.db.setSetting('notifications.last_daily_report', today);
    await this.sendDailyReport();
  }

  async executeTrade({ signal, snaps, decision, spreadPips }) {
    if (!this.account || !this.broker || this.analysisOnly) return null;
    if (this.tradingMode !== 'demo') {
      await this.db.addLog('warn', 'trade', `Execution blocked in ${this.tradingMode} mode`);
      return null;
    }
    if (!this.accountFresh()) {
      await this.db.addLog('warn', 'trade', 'Order blocked: account snapshot is stale');
      return null;
    }
    const lastAt = this._lastTradeAt.get(signal.symbol) || 0;
    if (Date.now() - lastAt < config.TRADE_REENTRY_COOLDOWN_SECONDS * 1000) {
      await this.db.addLog('warn', 'trade', `Re-entry cooldown active for ${signal.symbol}`);
      return null;
    }
    const fresh = await this.db.openTrades(this.account.id);
    if (fresh.some((t) => t.symbol === signal.symbol)) {
      await this.db.addLog('warn', 'trade', `Duplicate blocked for ${signal.symbol}`);
      return null;
    }

    let order;
    try {
      order = await this.broker.openOrder(
        signal.symbol, signal.side, decision.lot, signal.stop_loss, signal.take_profit, signal.entry,
      );
    } catch (err) {
      await this.notifyExecutionFailure(signal, `Order error: ${err.message}`);
      return null;
    }
    if (!order.accepted) {
      await this.notifyExecutionFailure(signal, order.message || 'Broker rejected the order');
      return null;
    }
    if (!order.order_id) {
      await this.notifyExecutionFailure(signal, 'Broker accepted without a ticket; trade not recorded');
      return null;
    }
    if (this.broker.supportsPositions) {
      const verified = await this.broker.verifyPosition(order.order_id);
      if (!verified) {
        await this.notifyExecutionFailure(
          signal, `MT5 did not confirm ticket ${order.order_id}; trade not recorded`,
        );
        return null;
      }
      const mismatch = String(verified.symbol || '').toUpperCase() !== String(signal.symbol).toUpperCase()
        || String(verified.side || '').toUpperCase() !== String(signal.side).toUpperCase();
      if (mismatch) {
        await this.notifyExecutionFailure(
          signal, `MT5 confirmed ticket ${order.order_id} with unexpected ${verified.symbol} ${verified.side}`,
        );
        return null;
      }
    }
    const duplicateTicket = await this.db.tradeByBrokerOrder(this.account.id, order.order_id);
    if (duplicateTicket) {
      await this.db.addLog('warn', 'trade', `Duplicate ticket blocked: ${order.order_id}`);
      return null;
    }
    const entryPrice = Number(order.fill_price || signal.entry);
    this._lastTradeAt.set(signal.symbol, Date.now());
    let chartPath = '';
    try {
      chartPath = await renderTradeChart({
        symbol: signal.symbol, timeframe: signal.timeframe, side: signal.side,
        candles: (snaps.M15 || snaps.M5).candles.slice(-90),
        entry: entryPrice, stopLoss: signal.stop_loss, takeProfit: signal.take_profit,
        outputDir: this.chartDir,
      });
    } catch (err) {
      await this.db.addLog('warn', 'chart', `Trade chart failed: ${err.message}`);
    }

    const trade = await this.db.createTrade({
      account_id: this.account.id,
      platform: this.platform,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      side: signal.side,
      entry_price: entryPrice,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      lot: decision.lot,
      risk_amount: decision.risk_amount,
      confidence: signal.confidence,
      reason: `${signal.reason_en} | spread ${spreadPips}p | ${decision.rr}R`,
      status: 'OPEN',
      broker_order_id: order.order_id,
      opened_at: utcnow(),
      chart_path: chartPath,
    });

    await this.db.addLog('info', 'trade', `Opened ${signal.symbol} ${signal.side} ${decision.lot} at ${entryPrice}`, {
      order_id: order.order_id, confidence: signal.confidence, mode: this.executionMode,
    });
    if (this.broker.supportsPositions) {
      await this.syncAccount();
      await this.syncBrokerTrades();
    }
    if (this.telegram.enabled && this.notifications.trade_open) {
      const seenChart = this.notifications.charts ? chartPath : '';
      const sent = await this.telegram.notifyOpen({ ...trade, account_type: this.accountType }, seenChart);
      if (!sent.ok) await this.db.addLog('warn', 'telegram', `Open notification failed: ${sent.error}`);
    }
    return trade;
  }

  async shutdown() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this.broker) {
      try { await this.broker.disconnect(); } catch { /* ignore */ }
    }
  }
}

module.exports = { TradingEngine, RISK_KEYS };
