'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pairing = require('../src/connect-pairing');

function memoryDb() {
  const store = new Map();
  return {
    store,
    async getSetting(key, fallback = null) {
      return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : fallback;
    },
    async setSetting(key, value) {
      store.set(key, value === null ? null : JSON.parse(JSON.stringify(value)));
    },
  };
}

test('pairing codes are 4-4 and unambiguous', () => {
  const code = pairing.createCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!/[IO01]/.test(code));
  assert.equal(pairing.normalizeCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(pairing.normalizeCode('abcd 2345'), 'ABCD2345');
});

test('payload encryption round-trips and rejects a wrong code', () => {
  const blob = pairing.encryptPayload('ABCD-2345', 'token-value-123');
  assert.deepEqual(Object.keys(blob).sort(), ['ct', 'iv', 'kdf', 'tag', 'v']);
  assert.ok(!JSON.stringify(blob).includes('token-value-123'));
  assert.equal(pairing.decryptPayload('ABCD-2345', blob), 'token-value-123');
  assert.throws(() => pairing.decryptPayload('ZZZZ-9999', blob), /decrypt_failed/);
});

test('tampered ciphertext is rejected', () => {
  const blob = pairing.encryptPayload('ABCD-2345', 'token-value-123');
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 0xff;
  assert.throws(
    () => pairing.decryptPayload('ABCD-2345', { ...blob, ct: ct.toString('base64') }),
    /decrypt_failed/,
  );
  assert.throws(() => pairing.decryptPayload('ABCD-2345', { v: 2 }), /unsupported_payload_version/);
  assert.throws(() => pairing.decryptPayload('ABCD-2345', { v: 1 }), /malformed_payload/);
});

test('a pairing code is single use', async () => {
  const db = memoryDb();
  const issued = await pairing.issuePairing(db, { ip: '127.0.0.1' });
  const first = await pairing.consumePairing(db, issued.code);
  assert.equal(first.ok, true);
  await pairing.burnPairing(db, first.key);
  const second = await pairing.consumePairing(db, issued.code);
  assert.deepEqual(second, { ok: false, reason: 'unknown_or_used' });
});

test('expired and malformed codes are refused', async () => {
  const db = memoryDb();
  const issued = await pairing.issuePairing(db);
  const key = `connect.pair.${pairing.codeKey(issued.code)}`;
  await db.setSetting(key, { expires_at: Date.now() - 1000, created_at: 0, attempts: 0 });
  assert.deepEqual(await pairing.consumePairing(db, issued.code), { ok: false, reason: 'expired' });
  assert.deepEqual(await pairing.consumePairing(db, 'nope'), { ok: false, reason: 'invalid_code' });
  assert.deepEqual(await pairing.consumePairing(db, 'AAAA1111'), { ok: false, reason: 'unknown_or_used' });
});

test('a code is burned after the attempt limit', async () => {
  const db = memoryDb();
  const issued = await pairing.issuePairing(db);
  let current = await pairing.consumePairing(db, issued.code);
  for (let i = 1; i <= pairing.MAX_ATTEMPTS - 1; i += 1) {
    await pairing.markAttempt(db, current.key, current.attempts);
    current = await pairing.consumePairing(db, issued.code);
    assert.equal(current.ok, true);
  }
  await pairing.markAttempt(db, current.key, current.attempts);
  assert.deepEqual(await pairing.consumePairing(db, issued.code), { ok: false, reason: 'unknown_or_used' });
});

test('capability report is honest about what cannot work', () => {
  const methods = pairing.connectionMethods();
  assert.equal(methods.official_api.available, false);
  assert.equal(methods.safari_direct.available, false);
  assert.equal(methods.local_connector.available, true);
  assert.ok(methods.safari_direct.reason_ar.includes('Safari'));
  assert.ok(methods.safari_direct.reason_en.length > 20);
});
