'use strict';

const config = require('../config');
const { BrokerError, accountInfo, executionResult } = require('./base');

/*
 * MT5 execution is only possible through a Windows host running the official
 * MetaTrader 5 terminal and the ROZLF MT5 bridge. This client never pretends
 * to trade when the bridge is missing.
 */
class MT5Broker {
  constructor(options = {}) {
    this.name = 'mt5';
    this.supportsExecution = true;
    this.baseUrl = String(options.baseUrl || config.MT5_BRIDGE_URL || '').replace(/\/+$/, '');
    this.token = options.token || config.MT5_BRIDGE_TOKEN;
    this.timeout = options.timeout || config.MT5_BRIDGE_TIMEOUT_MS;
    this.connected = false;
    this.isDemo = options.isDemo !== false;
    this.login = '';
    this.server = '';
  }

  static enabled() {
    return config.MT5_ENABLED && Boolean(config.MT5_BRIDGE_URL);
  }

  async request(method, path, body = null) {
    if (!this.baseUrl) {
      throw new BrokerError('MT5 bridge URL is not configured (MT5_BRIDGE_URL)');
    }
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Bridge-Token': this.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      throw new BrokerError(`MT5 bridge unreachable: ${err.message}`);
    }
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      throw new BrokerError(`MT5 bridge error ${response.status}: ${data.detail || data.error || 'unknown'}`);
    }
    return data;
  }

  async connect(login, password, server = '') {
    if (!config.MT5_ENABLED) {
      throw new BrokerError('MT5 execution is disabled. Set MT5_ENABLED=true and run the bridge on Windows.');
    }
    if (!this.baseUrl) {
      throw new BrokerError('MT5 bridge URL is not configured. Run the bridge on a Windows VPS with MetaTrader 5.');
    }
    if (!login || !password) throw new BrokerError('Login and password are required');
    const data = await this.request('POST', '/connect', {
      login: String(login), password: String(password), server: String(server),
    });
    if (data.connected === false) throw new BrokerError(data.message || 'MT5 connection rejected');
    this.connected = true;
    this.login = String(login);
    this.server = String(server || data.server || '');
    return accountInfo({
      login: this.login, server: this.server,
      balance: data.balance, equity: data.equity, currency: data.currency,
      leverage: data.leverage, broker: 'MetaTrader 5', is_demo: this.isDemo,
    });
  }

  async disconnect() {
    if (this.connected && this.baseUrl) {
      try { await this.request('POST', '/disconnect', {}); } catch { /* best effort */ }
    }
    this.connected = false;
  }

  async accountInfo() {
    const data = await this.request('GET', '/account');
    return accountInfo({
      login: data.login || this.login, server: data.server || this.server,
      balance: data.balance, equity: data.equity, currency: data.currency,
      leverage: data.leverage, broker: 'MetaTrader 5', is_demo: this.isDemo,
    });
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
    return executionResult(
      true,
      String(data.order_id || data.ticket || ''),
      Number(data.fill_price || data.price || referencePrice || 0),
      data.message || 'MT5 order accepted',
    );
  }

  async closeOrder(orderId, symbol, side, lot, referencePrice = null) {
    if (!this.connected) throw new BrokerError('MT5 account not connected');
    const data = await this.request('POST', '/close', {
      order_id: String(orderId), symbol, side, lot: Number(lot),
    });
    if (data.accepted === false) {
      throw new BrokerError(data.message || 'MT5 rejected the close');
    }
    return executionResult(true, String(orderId), Number(data.fill_price || referencePrice || 0), 'MT5 close accepted');
  }
}

module.exports = { MT5Broker };
