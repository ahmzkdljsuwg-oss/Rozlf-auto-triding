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

const POLICY_REASON_EN =
  'ExpertOption Terms & Conditions section 6.2 strictly prohibits automated players '
  + '(bots) and any implantation in the client-server relationship. Automated execution '
  + 'cannot be implemented without written authorization from ExpertOption.';
const POLICY_REASON_AR =
  'البند 6.2 من شروط ExpertOption يمنع صراحةً استخدام اللاعبين الآليين (bots) وأي تدخل '
  + 'في علاقة العميل بالخادم. لا يمكن تنفيذ التداول الآلي دون موافقة كتابية من ExpertOption.';

const SOURCE_REASON_EN =
  'ExpertOption does not publish a documented API for account-scoped candles, '
  + 'asset discovery, balances or orders. No unofficial endpoint is called.';
const SOURCE_REASON_AR =
  'ExpertOption لا تنشر واجهة برمجية موثقة لقراءة شموع الحساب أو أصوله أو رصيده أو تنفيذ الأوامر. '
  + 'لا يتم استدعاء أي واجهة داخلية غير موثقة.';

const INTEGRATION_STATUS = Object.freeze({
  platform: 'expertoption',
  official_api_available: false,
  documented_api_found: false,
  trading_api_available: false,
  account_data_api_available: false,
  market_data_api_available: false,
  policy_allows_bots: false,
  execution_supported: false,
  analysis_only: true,
  policy_clause: '6.2',
  policy_url: 'https://expertoption.com/company/policy/terms/',
  policy_reason_en: POLICY_REASON_EN,
  policy_reason_ar: POLICY_REASON_AR,
  source_reason_en: SOURCE_REASON_EN,
  source_reason_ar: SOURCE_REASON_AR,
  next_step_en: 'A written API/automation authorization from ExpertOption is required before any execution code can be added.',
  next_step_ar: 'يلزم الحصول على تفويض كتابي من ExpertOption لاستخدام API أو التداول الآلي قبل إضافة أي كود تنفيذ.',
});

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
      official_integration: INTEGRATION_STATUS,
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

module.exports = {
  ExpertOptionSession,
  OFFICIAL_API_AVAILABLE,
  INTEGRATION_STATUS,
  POLICY_REASON_EN,
  POLICY_REASON_AR,
  SOURCE_REASON_EN,
  SOURCE_REASON_AR,
};
