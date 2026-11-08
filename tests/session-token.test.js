'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExpertOptionToken } = require('../src/session-token');

test('accepts a raw ExpertOption session token unchanged', () => {
  assert.equal(normalizeExpertOptionToken('abc123XYZ'), 'abc123XYZ');
});

test('extracts only token from a copied cookie string', () => {
  const cookie = 'pwaInstallSkipped=true; language=ar; profileSessionKey=private-id; token=FreshToken123; isPWA=1';
  assert.equal(normalizeExpertOptionToken(cookie), 'FreshToken123');
});

test('decodes a URL-encoded token cookie value', () => {
  assert.equal(normalizeExpertOptionToken('token=abc%2B123%3D'), 'abc+123=');
});

test('rejects a cookie string without a token field', () => {
  assert.equal(normalizeExpertOptionToken('language=ar; profileSessionKey=private-id'), '');
});

test('rejects an empty token cookie', () => {
  assert.equal(normalizeExpertOptionToken('token='), '');
});
