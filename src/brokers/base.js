'use strict';

class BrokerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrokerError';
  }
}

function accountInfo(fields = {}) {
  return {
    login: fields.login || '',
    server: fields.server || '',
    balance: Number(fields.balance || 0),
    equity: Number(fields.equity ?? fields.balance ?? 0),
    margin_free: Number(fields.margin_free ?? fields.free_margin ?? 0),
    margin_used: Number(fields.margin_used ?? fields.used_margin ?? 0),
    margin_level: fields.margin_level === null || fields.margin_level === undefined
      ? null : Number(fields.margin_level),
    currency: fields.currency || 'USD',
    leverage: Number(fields.leverage || 100),
    broker: fields.broker || '',
    is_demo: fields.is_demo !== false,
    synced_at: fields.synced_at || null,
  };
}

function executionResult(accepted, orderId = '', fillPrice = 0, message = '') {
  return { accepted, order_id: orderId, fill_price: Number(fillPrice || 0), message };
}

module.exports = { BrokerError, accountInfo, executionResult };
