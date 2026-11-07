'use strict';

/*
 * ExpertOption does not publish a documented API for account-scoped market
 * data or trading. A session token supplied by the user is kept only as an
 * encrypted credential and is never treated as proof of a working connection.
 * This module is the single place where an officially approved integration
 * would be added; until then every data call fails explicitly instead of
 * falling back silently or touching undocumented endpoints.
 */
const OFFICIAL_API_AVAILABLE = false;

const SOURCE_REASON_EN =
  'ExpertOption does not publish a documented API for account-scoped candles, '
  + 'asset discovery, balances or orders. No unofficial endpoint is called.';
const SOURCE_REASON_AR =
  'ExpertOption لا تنشر واجهة برمجية موثقة لقراءة شموع الحساب أو أصوله أو رصيده أو تنفيذ الأوامر. '
  + 'لا يتم استدعاء أي واجهة داخلية غير موثقة.';

class ExpertOptionSession {
  constructor({ login, tokenPresent = false, accountType = 'demo' } = {}) {
    this.login = login || '';
    this.accountType = accountType;
    this.tokenPresent = Boolean(tokenPresent);
    this.connected = false;
    this.verified = false;
    this.verifiedAt = null;
    this.lastError = null;
    this.createdAt = new Date().toISOString();
  }

  status() {
    return {
      platform: 'expertoption',
      account_type: this.accountType,
      login: this.login,
      token_present: this.tokenPresent,
      token_stored_encrypted: this.tokenPresent,
      connection_state: this.tokenPresent ? 'token_saved_unverified' : 'no_credentials',
      connected: this.connected,
      verified: this.verified,
      verified_at: this.verifiedAt,
      official_api_available: OFFICIAL_API_AVAILABLE,
      account_data_available: false,
      market_data_available: false,
      last_error: this.lastError,
      reason_en: this.tokenPresent ? SOURCE_REASON_EN : 'No ExpertOption credential was supplied.',
      reason_ar: this.tokenPresent ? SOURCE_REASON_AR : 'لم يتم إدخال بيانات اعتماد ExpertOption.',
      created_at: this.createdAt,
    };
  }

  async verify() {
    this.connected = false;
    this.verified = false;
    this.lastError = OFFICIAL_API_AVAILABLE ? 'Official verification endpoint is not configured' : SOURCE_REASON_EN;
    return this.status();
  }

  async markets() {
    throw new Error(SOURCE_REASON_EN);
  }

  async candles() {
    throw new Error(SOURCE_REASON_EN);
  }

  async accountInfo() {
    throw new Error(SOURCE_REASON_EN);
  }
}

module.exports = { ExpertOptionSession, OFFICIAL_API_AVAILABLE, SOURCE_REASON_EN, SOURCE_REASON_AR };
