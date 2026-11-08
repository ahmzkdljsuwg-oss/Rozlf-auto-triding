'use strict';

/**
 * Consent-based session intake for the "Connect via Safari" flow.
 *
 * The user signs in to ExpertOption in a browser window they control (their own
 * Safari, or the local connector's own browser). Nothing reads another app's
 * cookie store and no password is ever collected: the token that already exists
 * in that browser's localStorage is encrypted on the user's machine with a
 * one-time pairing code and only then posted to ROZLF.
 *
 * The pairing code is never stored in the clear (only its SHA-256) and is
 * consumed by the first successful upload, so a leaked link cannot be replayed.
 */
const crypto = require('crypto');

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const KDF_SALT = 'rozlf-connect-v1';
const KDF_ITERATIONS = 200000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codeKey(code) {
  return crypto.createHash('sha256').update(`rozlf-pair:${normalizeCode(code)}`).digest('hex');
}

function createCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function deriveKey(code) {
  return crypto.pbkdf2Sync(normalizeCode(code), KDF_SALT, KDF_ITERATIONS, 32, 'sha256');
}

/**
 * Decrypt the connector payload. The connector sends
 * { v: 1, iv, ct, tag, kdf: 'pbkdf2-sha256-200000' } as base64 fields.
 */
function decryptPayload(code, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (Number(data.v) !== 1) throw new Error('unsupported_payload_version');
  const iv = Buffer.from(String(data.iv || ''), 'base64');
  const tag = Buffer.from(String(data.tag || ''), 'base64');
  const ct = Buffer.from(String(data.ct || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0 || ct.length > 8192) {
    throw new Error('malformed_payload');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(code), iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from('rozlf-connect'));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong code and tampered ciphertext are indistinguishable by design.
    throw new Error('decrypt_failed');
  }
}

function encryptPayload(code, plaintext, iv) {
  const useIv = iv || crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(code), useIv);
  cipher.setAAD(Buffer.from('rozlf-connect'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kdf: 'pbkdf2-sha256-200000',
    iv: useIv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

async function issuePairing(db, meta = {}) {
  const code = createCode();
  const expiresAt = Date.now() + PAIR_TTL_MS;
  await db.setSetting(`connect.pair.${codeKey(code)}`, {
    expires_at: expiresAt,
    created_at: Date.now(),
    attempts: 0,
    ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
  });
  return { code, expires_at: new Date(expiresAt).toISOString(), expires_in_seconds: PAIR_TTL_MS / 1000 };
}

/**
 * Validate and consume a pairing code. Returns the stored record on success.
 * The record is deleted on success and after MAX_ATTEMPTS failures.
 */
async function consumePairing(db, code) {
  const normalized = normalizeCode(code);
  if (!/^[A-Z0-9]{8}$/.test(normalized)) return { ok: false, reason: 'invalid_code' };
  const key = `connect.pair.${codeKey(code)}`;
  const record = await db.getSetting(key, null);
  if (!record) return { ok: false, reason: 'unknown_or_used' };
  if (Number(record.expires_at || 0) < Date.now()) {
    await db.setSetting(key, null).catch(() => {});
    return { ok: false, reason: 'expired' };
  }
  const attempts = Number(record.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    await db.setSetting(key, null).catch(() => {});
    return { ok: false, reason: 'too_many_attempts' };
  }
  return { ok: true, key, record, attempts };
}

async function markAttempt(db, key, attempts) {
  const record = await db.getSetting(key, null);
  if (!record) return;
  if (attempts >= MAX_ATTEMPTS) {
    await db.setSetting(key, null).catch(() => {});
    return;
  }
  await db.setSetting(key, { ...record, attempts }).catch(() => {});
}

async function burnPairing(db, key) {
  await db.setSetting(key, null).catch(() => {});
}

/**
 * Capability report shown in the UI. Written as data, not marketing: if a
 * method cannot work on the current device, the reason travels with it.
 */
function connectionMethods() {
  return {
    official_api: {
      available: false,
      reason_ar: 'ExpertOption لا تنشر واجهة برمجة رسمية للأسعار أو التداول الآلي. الاتصال يستخدم جلسة المستخدم نفسه، للقراءة فقط.',
      reason_en: 'ExpertOption publishes no official public API for market data or automated trading. ROZLF uses the user own session, read-only.',
    },
    safari_direct: {
      available: false,
      reason_ar: 'Safari لا يسمح لموقع ويب بقراءة جلسة موقع آخر (منع cross-origin). لا توجد طريقة مصرّح بها لنقل الجلسة تلقائياً من Safari إلى ROZLF.',
      reason_en: 'Safari does not let one site read another site\'s session (cross-origin isolation). There is no authorized way to hand the session from Safari to ROZLF automatically.',
    },
    local_connector: {
      available: true,
      reason_ar: 'موصل محلي يفتح نافذة متصفح على m.expertoption.com، تسجّل الدخول بنفسك، ثم يشفّر رمز جلستك على جهازك ويرسله عبر HTTPS.',
      reason_en: 'A local connector opens a browser window at m.expertoption.com; you sign in yourself, then it encrypts your session token on your machine and posts it over HTTPS.',
    },
    manual_token: {
      available: true,
      reason_ar: 'إدخال يدوي لقيمة token من متصفحك. يعمل، لكنه عرضة لانتهاء الجلسة ولخطأ النسخ.',
      reason_en: 'Manual entry of the token value from your browser. Works, but is error-prone and expires with the session.',
    },
  };
}

module.exports = {
  PAIR_TTL_MS,
  MAX_ATTEMPTS,
  normalizeCode,
  codeKey,
  createCode,
  deriveKey,
  encryptPayload,
  decryptPayload,
  issuePairing,
  consumePairing,
  markAttempt,
  burnPairing,
  connectionMethods,
};
