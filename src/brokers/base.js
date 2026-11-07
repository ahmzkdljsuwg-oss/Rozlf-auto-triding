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
    equity: Number(fields.equity || fields.balance || 0),
    currency: fields.currency || 'USD',
    leverage: Number(fields.leverage || 100),
    broker: fields.broker || '',
    is_demo: fields.is_demo !== false,
  };
}

function executionResult(accepted, orderId = '', fillPrice = 0, message = '') {
  return { accepted, order_id: orderId, fill_price: Number(fillPrice || 0), message };
}

module.exports = { BrokerError, accountInfo, executionResult };
