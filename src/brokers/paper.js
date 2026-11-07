'use strict';

const config = require('../config');
const { BrokerError, accountInfo, executionResult } = require('./base');
const { pipSize, pipValuePerLot } = require('../market');

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class PaperBroker {
  constructor(balance = config.DEMO_START_BALANCE, market = null) {
    this.name = 'paper';
    this.supportsExecution = true;
    this.market = market;
    this.balance = Number(balance || config.DEMO_START_BALANCE);
    this.equity = this.balance;
    this.connected = false;
    this._nextId = 100001;
    this.login = '';
    this.server = '';
    this.currency = 'USD';
  }

  async connect(login, password, server = '') {
    if (!login || !password) throw new BrokerError('Login and password are required');
    if (!this.market) throw new BrokerError('Market data service unavailable');
    try {
      await this.market.latestPrice('EURUSD');
    } catch (err) {
      throw new BrokerError(`Live market data unavailable: ${err.message}`);
    }
    this.connected = true;
    this.login = String(login);
    this.server = String(server || 'ROZLF-PAPER');
    return this.accountInfo();
  }

  async disconnect() {
    this.connected = false;
  }

  async accountInfo() {
    return accountInfo({
      login: this.login, server: this.server, balance: this.balance, equity: this.equity,
      currency: this.currency, leverage: 100, broker: 'ROZLF Paper', is_demo: true,
    });
  }

  async price(symbol) {
    return this.market.latestPrice(symbol);
  }

  async openOrder(symbol, side, lot, stopLoss = 0, takeProfit = 0, referencePrice = null) {
    if (!this.connected) throw new BrokerError('Paper account not connected');
    if (side !== 'BUY' && side !== 'SELL') throw new BrokerError(`Invalid side ${side}`);
    const lotValue = Number(lot);
    if (!(lotValue >= 0.01)) throw new BrokerError('Lot size must be at least 0.01');

    let raw = referencePrice;
    if (!raw) {
      try {
        raw = await this.market.latestPrice(symbol);
      } catch (err) {
        throw new BrokerError(`No live price for ${symbol}: ${err.message}`);
      }
    }
    const pip = pipSize(symbol);
    const slippage = gaussian() * config.MAX_SLIPPAGE_PIPS * 0.25 * pip;
    const fill = side === 'BUY' ? raw + Math.abs(slippage) : raw - Math.abs(slippage);

    this._nextId += 1;
    return executionResult(true, `DM${this._nextId}`, fill, 'Paper order accepted');
  }

  async closeOrder(orderId, symbol, side, lot, referencePrice = null) {
    if (!this.connected) throw new BrokerError('Paper account not connected');
    let raw = referencePrice;
    if (!raw) {
      try {
        raw = await this.market.latestPrice(symbol);
      } catch (err) {
        throw new BrokerError(`No live price for ${symbol}: ${err.message}`);
      }
    }
    const pip = pipSize(symbol);
    const slippage = gaussian() * config.MAX_SLIPPAGE_PIPS * 0.25 * pip;
    const fill = side === 'BUY' ? raw - Math.abs(slippage) : raw + Math.abs(slippage);
    return executionResult(true, orderId, fill, 'Paper order closed');
  }

  realizedPnl(symbol, side, entryPrice, exitPrice, lot) {
    const pip = pipSize(symbol);
    const direction = side === 'BUY' ? 1 : -1;
    const pips = ((exitPrice - entryPrice) / pip) * direction;
    return Math.round(pips * Number(lot) * pipValuePerLot() * 100) / 100;
  }

  applyPnl(pnl) {
    this.balance = Math.round((this.balance + Number(pnl)) * 100) / 100;
    this.equity = this.balance;
    return this.balance;
  }
}

module.exports = { PaperBroker };
