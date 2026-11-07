'use strict';

const crypto = require('crypto');
const config = require('./config');

function derive(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

let cached = null;
// The current key encrypts; the current key plus any rotated-out keys decrypt,
// so APP_SECRET_KEY can be changed without losing stored sessions.
function keyring() {
  const current = config.SECRET_KEY || '';
  const previous = config.SECRET_KEY_PREVIOUS || '';
  if (cached && cached.current === current && cached.previous === previous) return cached;
  const older = String(previous).split(',').map((k) => k.trim()).filter(Boolean);
  const list = [current, ...older].filter(Boolean).map(derive);
  cached = { current, previous, list, ready: Boolean(current) };
  return cached;
}

function encryptionReady() {
  return keyring().ready;
}

function encryptSecret(value) {
  if (!value) return '';
  const ring = keyring();
  if (!ring.ready) {
    throw new Error('APP_SECRET_KEY is not configured; refusing to store a secret without encryption');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ring.list[0], iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptSecret(token) {
  if (!token) return '';
  const parts = String(token).split('.');
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return '';
  for (const key of keyring().list) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      /* try the next rotation key */
    }
  }
  return '';
}

function maskAccount(login) {
  const value = String(login || '');
  if (!value) return '';
  if (value.length <= 4) return value[0] + '*'.repeat(Math.max(0, value.length - 1));
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}

function dashboardTokenOk(supplied) {
  const expected = config.DASHBOARD_TOKEN;
  if (!expected) return Boolean(config.ALLOW_INSECURE_DASHBOARD);
  if (!supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { encryptSecret, decryptSecret, encryptionReady, maskAccount, dashboardTokenOk };
