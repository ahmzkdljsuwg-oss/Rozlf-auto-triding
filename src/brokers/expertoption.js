'use strict';

const { BrokerError } = require('./base');

/*
 * ExpertOption has no approved public trading API. This adapter deliberately
 * never executes; it only lets the engine run analysis and alerts for the
 * platform. Claiming execution here would be dishonest.
 */
class ExpertOptionBroker {
  constructor() {
    this.name = 'expertoption';
    this.supportsExecution = false;
    this.connected = false;
  }

  async connect() {
    throw new BrokerError(
      'ExpertOption has no approved public trading API. Analysis and Telegram alerts only.',
    );
  }

  async disconnect() {
    this.connected = false;
  }

  async accountInfo() {
    throw new BrokerError('ExpertOption execution is not available');
  }

  async price(symbol) {
    throw new BrokerError('ExpertOption price feed is not available through an approved API');
  }

  async openOrder() {
    throw new BrokerError('ExpertOption execution is disabled: no approved API');
  }

  async closeOrder() {
    throw new BrokerError('ExpertOption execution is disabled: no approved API');
  }
}

module.exports = { ExpertOptionBroker };
