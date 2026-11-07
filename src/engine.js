'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { MarketDataService, MarketDataError, pipSize } = require('./market');
const { buildSignal } = require('./strategy');
const { RiskManager, DEFAULTS } = require('./risk');
const { PaperBroker } = require('./brokers/paper');
const { MT5Broker } = require('./brokers/mt5');
const { ExpertOptionBroker } = require('./brokers/expertoption');
const { GeminiAnalyzer } = require('./ai');
const { TelegramNotifier } = require('./telegram');
const { renderTradeChart, renderResultChart } = require('./charts');
const { utcnow } = require('./db');
const { getSpeedPreset, isSpeedMode, DEFAULT_SPEED } = require('./speed');

const RISK_KEYS = Object.keys(DEFAULTS);
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

class TradingEngine {
  constructor(options = {}) {
    this.db = options.db;
    this.market = options.market || new MarketDataService();
    this.telegram = options.telegram || new TelegramNotifier();
    this.analyzer = options.analyzer || new GeminiAnalyzer();
    this.chartDir = options.chartDir || config.CHART_DIR;

    this.account = null;
    this.broker = null;
    this.executionMode = 'none';
    this.platform = null;
    this.accountType = null;
    this.running = false;
    this.emergency = false;
    this.speed = DEFAULT_SPEED;
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
    return stored;
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

  async attachAccount({ platform, accountType, login, password, server = '' }) {
    if (!['mt5', 'expertoption'].includes(platform)) throw new Error('Unsupported platform');
    if (!['demo', 'real'].includes(accountType)) throw new Error('Unsupported account type');
    if (platform === 'expertoption') {
      throw new Error(
        'ExpertOption has no approved public trading API. This platform is analysis and alerts only, so no login is performed.',
      );
    }
    if (accountType === 'real' && !config.REAL_TRADING_APPROVED) {
      throw new Error('Real trading is disabled until explicitly approved');
    }
    if (this.broker) {
      try { await this.broker.disconnect(); } catch { /* ignore */ }
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
    if (this.broker) {
      try { await this.broker.disconnect(); } catch { /* ignore */ }
    }
    if (this.account) await this.db.setAccountStatus(this.account.id, 'disconnected');
    this.broker = null;
    this.account = null;
    this.running = false;
    this.executionMode = 'none';
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
    await this.db.addLog('info', 'broker', 'Account disconnected');
    return { ok: true };
  }

  async start() {
    if (!this.account || !this.broker) throw new Error('Connect a demo account first');
    if (this.emergency) throw new Error('Emergency stop is active; reconnect the account to resume');
    await this.syncAccount();
    if (!this.accountSynced) throw new Error('Account sync failed; trading cannot start');
    this.running = true;
    this._started = true;
    await this.db.addLog('info', 'engine', 'Bot started');
    if (this.telegram.enabled) {
      const sent = await this.telegram.notifyBotStarted({
        accountType: this.accountType,
        login: this.account ? this.account.login : '',
        server: this.account ? this.account.server : '',
        speed: this.speed,
        executionMode: this.executionMode,
        connected: this.accountFresh(),
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
      await this.syncAccount();
      await this.processOpenTrades();
      await this.scanAndTrade();
      await this.syncAccount();
    } finally {
      this._busy = false;
    }
  }

  accountFresh(maxAge = config.MT5_ACCOUNT_SYNC_MAX_AGE_SECONDS) {
    if (!this.accountSynced || !this.accountSyncAt) return false;
    return (Date.now() - new Date(this.accountSyncAt).getTime()) / 1000 <= Number(maxAge);
  }

  async syncAccount() {
    if (!this.broker || !this.account) return;
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
      account_login: this.account ? this.account.login : '',
      account_type: this.accountType,
      account_synced: this.accountSynced,
      account_data_fresh: this.accountFresh(),
      account_sync_at: this.accountSyncAt,
      account_sync_error: this.accountSyncError,
      account_status: this.accountSynced ? 'connected' : 'disconnected',
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
      if (this.telegram.enabled) {
        const sent = await this.telegram.notifyClose({ ...closedTrade, account_type: this.accountType }, chartPath);
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
      if (this.telegram.enabled) {
        const sent = await this.telegram.notifyClose({ ...closed, account_type: this.accountType }, chartPath);
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

  async scanAndTrade() {
    if (!this.account || !this.broker) return;
    if (!this.accountFresh()) {
      this.lastError = 'Account sync is stale; no new trades are allowed';
      await this.db.addLog('warn', 'risk', this.lastError);
      return;
    }
    const candidates = [];
    const errors = [];
    let fetched = 0;
    this.opportunities = [];

    for (const symbol of config.SYMBOLS) {
      try {
        const snaps = await this.loadSnapshots(symbol);
        fetched += 1;
        const signal = buildSignal(symbol, 'M5', snaps, {
          minConfidence: this.speedPreset.min_confidence,
          requireH4: this.speedPreset.require_h4,
        });
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

    if (!candidates.length || !this.running || this.emergency) return;
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
        await this.db.addLog('info', 'ai', `Gemini ${review.verdict}: ${review.rationale}`);
        if (review.verdict === 'REJECT') {
          await this.db.addLog('warn', 'ai', `Trade blocked by Gemini on ${signal.symbol}`);
          await this.sendAnalysisAlert(signal, 'Gemini rejected the setup', spreadPips);
          continue;
        }
      }

      await this.executeTrade({ signal, snaps, decision, spreadPips });
      return;
    }
  }

  async notifyOpportunity(signal, spreadPips) {
    if (!this.telegram.enabled) return;
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
    if (!this.telegram.enabled) return;
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

  async executeTrade({ signal, snaps, decision, spreadPips }) {
    if (!this.account || !this.broker) return null;
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
    if (this.telegram.enabled) {
      const sent = await this.telegram.notifyOpen({ ...trade, account_type: this.accountType }, chartPath);
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
