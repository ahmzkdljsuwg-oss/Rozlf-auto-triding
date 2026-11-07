'use strict';

const crypto = require('crypto');
const config = require('../config');
const { BrokerError, accountInfo, executionResult } = require('./base');

/*
 * The official MetaTrader 5 runtime is Windows-only. This client talks to the
 * ROZLF MT5 bridge that runs beside the terminal, and never reports a fill
 * unless the bridge returns an accepted order with a real ticket.
 */

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const ms = numeric > 1e11 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class MT5Broker {
  constructor(options = {}) {
    this.name = 'mt5';
    this.supportsExecution = true;
    this.supportsPositions = true;
    this.baseUrl = String(options.baseUrl || config.MT5_BRIDGE_URL || '').replace(/\/+$/, '');
    this.token = options.token ?? config.MT5_BRIDGE_TOKEN;
    this.secret = options.secret ?? config.MT5_BRIDGE_SECRET;
    this.timeout = options.timeout || config.MT5_BRIDGE_TIMEOUT_MS;
    this.connected = false;
    this.isDemo = options.isDemo !== false;
    this.login = '';
    this.server = '';
  }

  static enabled() {
    return config.MT5_ENABLED && Boolean(config.MT5_BRIDGE_URL);
  }

  static transportError() {
    if (!config.MT5_ENABLED) return 'MT5 is disabled (MT5_ENABLED=false)';
    if (!config.MT5_BRIDGE_URL) return 'MT5_BRIDGE_URL is not configured';
    if (!config.MT5_BRIDGE_TOKEN) return 'MT5_BRIDGE_TOKEN / MT5_BRIDGE_API_KEY is not configured';
    let parsed;
    try { parsed = new URL(config.MT5_BRIDGE_URL); } catch { return 'MT5_BRIDGE_URL is not a valid URL'; }
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !local) {
      return 'MT5_BRIDGE_URL must use HTTPS outside localhost';
    }
    return '';
  }

  _signature(timestamp, method, path, bodyText) {
    if (!this.secret) return '';
    return crypto.createHmac('sha256', this.secret)
      .update(`${timestamp}\n${method}\n${path}\n${bodyText}`)
      .digest('hex');
  }

  async request(method, path, body = null) {
    if (!this.baseUrl) throw new BrokerError('MT5 bridge URL is not configured (MT5_BRIDGE_URL)');
    if (!this.token) throw new BrokerError('MT5 bridge token is not configured');
    const bodyText = body ? JSON.stringify(body) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'X-Bridge-Token': this.token,
      'X-Bridge-Timestamp': timestamp,
    };
    const signature = this._signature(timestamp, method.toUpperCase(), path, bodyText);
    if (signature) headers['X-Bridge-Signature'] = signature;

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: bodyText || undefined,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      this.connected = false;
      throw new BrokerError(`MT5 bridge unreachable: ${err.message}`);
    }
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok || data.ok === false) {
      throw new BrokerError(`MT5 bridge error ${response.status}: ${data.detail || data.error || 'unknown'}`);
    }
    return data;
  }

  async connect(login, password, server = '') {
    const transportError = MT5Broker.transportError();
    if (transportError) throw new BrokerError(transportError);
    if (!login || !password) throw new BrokerError('Login and password are required');
    const data = await this.request('POST', '/connect', {
      login: String(login), password: String(password), server: String(server),
      account_type: this.isDemo ? 'demo' : 'real',
    });
    if (data.connected === false) throw new BrokerError(data.message || 'MT5 connection rejected');
    if (data.is_demo === false && this.isDemo) {
      throw new BrokerError('The MT5 account is a real account; only demo accounts are enabled');
    }
    this.connected = true;
    this.login = String(login);
    this.server = String(server || data.server || '');
    return this.accountInfo();
  }

  async disconnect() {
    if (this.connected && this.baseUrl) {
      try { await this.request('POST', '/disconnect', {}); } catch { /* best effort */ }
    }
    this.connected = false;
  }

  async accountInfo() {
    const data = await this.request('GET', '/account');
    if (data.connected === false) {
      this.connected = false;
      throw new BrokerError(data.message || 'MT5 terminal is not connected');
    }
    const balance = Number(data.balance);
    const equity = Number(data.equity);
    if (!Number.isFinite(balance) || !Number.isFinite(equity)) {
      throw new BrokerError('MT5 bridge returned an invalid account snapshot');
    }
    this.connected = true;
    return accountInfo({
      login: data.login || this.login, server: data.server || this.server,
      balance, equity,
      margin_free: data.margin_free, margin_used: data.margin_used,
      margin_level: data.margin_level,
      currency: data.currency, leverage: data.leverage,
      broker: 'MetaTrader 5', is_demo: data.is_demo !== false && this.isDemo,
      synced_at: new Date().toISOString(),
    });
  }

  async positions() {
    const data = await this.request('GET', '/positions');
    if (!Array.isArray(data.positions)) throw new BrokerError('MT5 bridge returned invalid positions');
    return data.positions.map((p) => ({
      ticket: String(p.ticket || p.order_id || ''),
      symbol: String(p.symbol || ''),
      side: String(p.side || p.type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      lot: Number(p.lot || p.volume || 0),
      entry_price: Number(p.entry_price || p.price_open || 0),
      current_price: Number(p.current_price || p.price_current || 0),
      stop_loss: Number(p.stop_loss || p.sl || 0),
      take_profit: Number(p.take_profit || p.tp || 0),
      pnl: Number(p.pnl || p.profit || 0),
      opened_at: toIsoDate(p.opened_at ?? p.time),
    })).filter((p) => p.ticket && p.symbol);
  }

  async history(orderId) {
    const data = await this.request('GET', `/history?ticket=${encodeURIComponent(orderId)}`);
    if (!data.found) return null;
    return {
      ticket: String(data.ticket || orderId),
      symbol: String(data.symbol || ''),
      side: String(data.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      lot: Number(data.lot || 0),
      entry_price: Number(data.entry_price || 0),
      close_price: Number(data.close_price || 0),
      pnl: Number(data.pnl || 0),
      closed_at: data.closed_at || null,
    };
  }

  async price(symbol) {
    const data = await this.request('GET', `/price?symbol=${encodeURIComponent(symbol)}`);
    const price = Number(data.price || data.bid || 0);
    if (!(price > 0)) throw new BrokerError(`No MT5 price for ${symbol}`);
    return price;
  }

  async openOrder(symbol, side, lot, stopLoss = 0, takeProfit = 0, referencePrice = null) {
    if (!this.connected) throw new BrokerError('MT5 account not connected');
    const data = await this.request('POST', '/order', {
      symbol, side, lot: Number(lot),
      stop_loss: Number(stopLoss), take_profit: Number(takeProfit),
    });
    if (data.accepted === false) {
      return executionResult(false, '', 0, data.message || 'MT5 rejected the order');
    }
    const ticket = String(data.ticket || data.order_id || '');
    const fill = Number(data.fill_price || data.price || 0);
    if (!ticket || !(fill > 0)) {
      return executionResult(false, '', 0, 'MT5 did not confirm a ticket and fill price');
    }
    return executionResult(true, ticket, fill, data.message || 'MT5 order accepted');
  }

  async verifyPosition(orderId, attempts = 3, delayMs = 700) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const positions = await this.positions();
        const found = positions.find((p) => p.ticket === String(orderId));
        if (found) return found;
      } catch { /* the next attempt decides */ }
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  }

  async closeOrder(orderId, symbol, side, lot, referencePrice = null) {
    if (!this.connected) throw new BrokerError('MT5 account not connected');
    const data = await this.request('POST', '/close', {
      order_id: String(orderId), symbol, side, lot: Number(lot),
    });
    if (data.accepted === false) {
      throw new BrokerError(data.message || 'MT5 rejected the close');
    }
    const closePrice = Number(data.fill_price || data.price || 0);
    if (!(closePrice > 0)) throw new BrokerError('MT5 did not confirm a close price');
    return executionResult(true, String(orderId), closePrice, 'MT5 close accepted');
  }
}

module.exports = { MT5Broker };
