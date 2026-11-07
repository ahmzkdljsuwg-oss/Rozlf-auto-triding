'use strict';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const { encryptSecret, decryptSecret, encryptionReady } = require('../src/security');

test('a secret encrypted with the current key decrypts with the same key', () => {
  config.SECRET_KEY = 'first-key-aaaa';
  config.SECRET_KEY_PREVIOUS = '';
  const token = encryptSecret('eo-token-123');
  assert.notEqual(token, 'eo-token-123');
  assert.match(token, /^v1\./);
  assert.equal(decryptSecret(token), 'eo-token-123');
});

test('rotating APP_SECRET_KEY keeps old sessions readable through APP_SECRET_KEY_PREVIOUS', () => {
  config.SECRET_KEY = 'old-key-bbbb';
  config.SECRET_KEY_PREVIOUS = '';
  const token = encryptSecret('session-before-rotation');

  config.SECRET_KEY = 'new-key-cccc';
  config.SECRET_KEY_PREVIOUS = 'old-key-bbbb';
  assert.equal(decryptSecret(token), 'session-before-rotation');

  const fresh = encryptSecret('session-after-rotation');
  assert.equal(decryptSecret(fresh), 'session-after-rotation');

  config.SECRET_KEY_PREVIOUS = '';
  assert.equal(decryptSecret(token), '', 'the old key is the only thing that can read old ciphertext');
  assert.equal(decryptSecret(fresh), 'session-after-rotation');
});

test('without APP_SECRET_KEY nothing is encrypted and nothing is guessed', () => {
  config.SECRET_KEY = '';
  config.SECRET_KEY_PREVIOUS = '';
  assert.equal(encryptionReady(), false);
  assert.throws(() => encryptSecret('must-not-be-stored'), /APP_SECRET_KEY/);
  assert.equal(decryptSecret('v1.a.b.c'), '');
});

test('a tampered ciphertext is rejected', () => {
  config.SECRET_KEY = 'third-key-dddd';
  const token = encryptSecret('abc');
  const parts = token.split('.');
  const broken = [parts[0], parts[1], parts[2], Buffer.from('other').toString('base64')].join('.');
  assert.equal(decryptSecret(broken), '');
});
