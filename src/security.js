'use strict';

const crypto = require('crypto');
const config = require('./config');

const KEY = crypto.createHash('sha256')
  .update(config.SECRET_KEY || 'rozzlf-local-dev-secret')
  .digest();

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptSecret(token) {
  if (!token) return '';
  try {
    const [version, ivB64, tagB64, dataB64] = String(token).split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function maskAccount(login) {
  const value = String(login || '');
  if (!value) return '';
  if (value.length <= 4) return value[0] + '*'.repeat(Math.max(0, value.length - 1));
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}

function dashboardTokenOk(supplied) {
  const expected = config.DASHBOARD_TOKEN;
  if (!expected) return true;
  if (!supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { encryptSecret, decryptSecret, maskAccount, dashboardTokenOk };
