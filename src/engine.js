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
    this.lastScanAt = null;
    this.lastError = null;
    this.marketConnected = false;
    this.scanCount = 0;
    this.opportunities = [];
    this.risk = new RiskManager();
    this.accountBalance = 0;
    this.accountEquity = 0;
    this.accountCurrency = 'USD';

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
    return stored;
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
    } else {
      broker = new PaperBroker(config.DEMO_START_BALANCE, this.market);
      mode = 'simulated';
    }

    const info = await broker.connect(login, password, server);
    const existing = await this.db.latestAccount(platform, accountType);
    const startingBalance = existing && existing.login === login ? existing.balance : info.balance;
    if (broker instanceof PaperBroker) {
      broker.balance = Number(startingBalance || config.DEMO_START_BALANCE);
      broker.equity = broker.balance;
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
    this.accountBalance = startingBalance;
    this.accountEquity = startingBalance;
    this.accountCurrency = info.currency || 'USD';
    this.emergency = false;
    this.lastError = null;
    this.opportunities = [];

    await this.db.setAccountStatus(accountRow.id, 'connected', startingBalance);
    await this.db.addLog('info', 'broker', `Connected ${platform} ${accountType} ${login}`, {
      mode, server: server || info.server || '',
    });
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
    await this.db.addLog('info', 'broker', 'Account disconnected');
    return { ok: true };
  }

  async start() {
    if (!this.account || !this.broker) throw new Error('Connect a demo account first');
    if (this.emergency) throw new Error('Emergency stop is active; reconnect the account to resume');
    this.running = true;
    this._started = true;
    await this.db.addLog('info', 'engine', 'Bot started');
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
      if (this.running) this._schedule(config.SCAN_INTERVAL_SECONDS * 1000);
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

  async syncAccount() {
    if (!this.broker || !this.account) return;
    try {
      const info = await this.broker.accountInfo();
      this.accountBalance = Number(info.balance || 0);
      this.accountEquity = Number(info.equity || info.balance || 0);
      this.accountCurrency = info.currency || 'USD';
      await this.db.setAccountStatus(this.account.id, 'connected', this.accountBalance);
      this.account.balance = this.accountBalance;
      this.account.equity = this.accountEquity;
    } catch (err) {
      this.lastError = `Account sync: ${err.message}`.slice(0, 300);
      await this.db.addLog('warn', 'broker', this.lastError);
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
      telegram_enabled: this.telegram.enabled,
      today_pnl: todayPnl,
      today_trades: todayTrades.length,
    };
  }

  async processOpenTrades() {
    if (!this.account || !this.broker) return;
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
    const candidates = [];
    const errors = [];
    let fetched = 0;
    this.opportunities = [];

    for (const symbol of config.SYMBOLS) {
      try {
        const snaps = await this.loadSnapshots(symbol);
        fetched += 1;
        const signal = buildSignal(symbol, 'M5', snaps);
        this.publishOpportunity(signal);
        if (signal.side === 'BUY' || signal.side === 'SELL') candidates.push({ signal, snaps });
      } catch (err) {
        errors.push(`${symbol}: ${err.message}`);
        await this.db.addLog('warn', 'market', `Scan skipped ${symbol}: ${err.message}`);
      }
    }

    this.scanCount += 1;
    this.lastScanAt = utcnow();
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
        emergencyStop: this.emergency,
        running: this.running,
      });

      if (!decision.allowed) {
        await this.sendAnalysisAlert(signal, decision.reason, spreadPips);
        continue;
      }

      if (this.analyzer.enabled) {
        const review = await this.analyzer.review(signal, {
          spread_pips: spreadPips,
          atr: signal.atr,
          checks: signal.checks,
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
      this.lastError = `Order error ${signal.symbol}: ${err.message}`.slice(0, 300);
      await this.db.addLog('error', 'trade', this.lastError);
      return null;
    }
    if (!order.accepted) {
      await this.db.addLog('warn', 'trade', `Broker rejected ${signal.symbol}: ${order.message}`);
      return null;
    }

    const entryPrice = Number(order.fill_price || signal.entry);
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
    if (this.telegram.enabled) {
      const sent = await this.telegram.notifyOpen({ ...trade, account_type: this.accountType }, chartPath);
      if (!sent.ok) await this.db.addLog('warn', 'telegram', `Open notification failed: ${sent.error}`);
    }
    await this.syncAccount();
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
