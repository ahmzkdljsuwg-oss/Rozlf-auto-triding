'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { tokenFromText, mask } = require('../src/cloud-connector');

test('token extraction reads only real session shapes', () => {
  assert.equal(tokenFromText('token=short'), '');
  assert.equal(tokenFromText('theme=dark\nlang=ar'), '');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.equal(tokenFromText(`token=${jwt}`), jwt);
  assert.equal(tokenFromText(`Cookie: foo=1; token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`), 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(tokenFromText('{"access_token":"Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7X"}'), 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7X');
});

test('masked tokens never reveal the middle', () => {
  const masked = mask('abcdefghijklmnopqrstuvwxyz012345');
  assert.ok(!masked.includes('ijklmnop'));
  assert.ok(masked.startsWith('abcd'));
});

function chromiumAvailable() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return true;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].some((p) => fs.existsSync(p));
}

function startLoginPage(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>Fake ExpertOption login</title>
        <input id="login" /> <button id="go">login</button>
        <script>
          localStorage.setItem('token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.cloud-token-body');
          localStorage.setItem('login', 'Hdiedjdjdjxnx@gmail.com');
        </script>`);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startBlankPage(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>probe target</title><h1>probe</h1>');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('the host probe separates browser capability from a real account connection', { timeout: 120000 }, async (t) => {
  if (!chromiumAvailable()) {
    t.skip('no chromium on this host');
    return;
  }
  const port = 9451;
  const page = await startBlankPage(port);
  const { CloudConnector } = require('../src/cloud-connector');
  const connector = new CloudConnector({ engine: null });
  t.after(async () => {
    await connector.stop('test');
    await new Promise((r) => page.close(r));
  });

  const result = await connector.runProbe({ url: `http://127.0.0.1:${port}/` });
  assert.equal(result.ok, true, `probe failed: ${result.error}`);
  assert.ok(result.launch_ms > 0, 'browser launch was measured');
  assert.ok(result.frames > 0, 'at least one JPEG frame was captured');
  assert.ok(result.frame_bytes > 1000, 'the JPEG frame has real content');
  assert.equal(result.input_ok, true, 'touch input and typing were accepted');
  assert.ok(typeof result.peak_rss_mb === 'number', 'peak memory was sampled');

  const status = connector.status();
  assert.equal(status.probe.browser_launch_ok, true);
  assert.equal(status.probe.frames_ok, true);
  assert.equal(status.probe.input_ok, true);
  assert.equal(status.account_verified, false, 'a working browser is not an account connection');
  assert.equal(status.state, 'idle');
  assert.equal(status.execution_enabled, false);
});

test('cloud connector streams frames, accepts input and links a verified session', { timeout: 120000 }, async (t) => {
  if (!chromiumAvailable()) {
    t.skip('no chromium on this host');
    return;
  }
  const port = 8123;
  const loginServer = await startLoginPage(port);
  process.env.CLOUD_CONNECTOR_LOGIN_URL = `http://127.0.0.1:${port}/`;
  delete require.cache[require.resolve('../src/cloud-connector')];
  const { CloudConnector } = require('../src/cloud-connector');

  const calls = [];
  const engine = {
    attachAccount: async (args) => {
      calls.push(args);
      return { session: { verified: true, login: args.login, connection_state: 'verified' } };
    },
    expertOptionSession: { status: () => ({ verified: true }) },
    telegram: { sendMessage: async () => {} },
    db: { addLog: async () => {} },
  };

  const connector = new CloudConnector({ engine, logger: () => {} });
  t.after(() => connector.stop('test').catch(() => {}));
  const availability = await connector.availability();
  assert.equal(availability.available, true, availability.reason_ar || '');

  const started = await connector.start();
  assert.ok(started.sid);
  assert.equal(connector.status().state, 'live');

  const frame = await connector.frame();
  assert.ok(frame.jpeg && frame.jpeg.length > 1000, 'a real screenshot was captured');
  assert.equal(frame.jpeg[0], 0xff);
  assert.equal(frame.jpeg[1], 0xd8);

  await connector.input({ type: 'click', x: 40, y: 60 });
  await connector.input({ type: 'text', text: 'demo' });
  await connector.input({ type: 'key', key: 'Enter' });
  await assert.rejects(() => connector.input({ type: 'navigate', url: 'https://evil.example.com' }), /expertoption/i);

  const profileDir = connector.session.profileDir;
  await connector.pollSession(connector.session);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(calls.length, 1, 'attachAccount was called once with the captured token');
  assert.match(calls[0].sessionToken, /^eyJ/);
  assert.equal(calls[0].accountType, 'demo');
  assert.equal(connector.status().state, 'success');
  assert.equal(connector.status().token_detected, true);
  assert.ok(!JSON.stringify(connector.status()).includes('cloud-token-body'), 'status must not leak the token');
  assert.equal(fs.existsSync(profileDir), false, 'the throwaway profile is destroyed');

  loginServer.close();
});

test('a session that ExpertOption rejects is reported as a failure, not a connection', { timeout: 120000 }, async (t) => {
  if (!chromiumAvailable()) {
    t.skip('no chromium on this host');
    return;
  }
  const port = 8124;
  const loginServer = await startLoginPage(port);
  process.env.CLOUD_CONNECTOR_LOGIN_URL = `http://127.0.0.1:${port}/`;
  delete require.cache[require.resolve('../src/cloud-connector')];
  const { CloudConnector } = require('../src/cloud-connector');

  const engine = {
    attachAccount: async () => ({
      session: { verified: false, last_error: 'ExpertOption rejected the session token (ERROR_INCORRECT_TOKEN)' },
    }),
    expertOptionSession: { status: () => ({}) },
    db: { addLog: async () => {} },
  };
  const connector = new CloudConnector({ engine, logger: () => {} });
  t.after(() => connector.stop('test').catch(() => {}));
  await connector.start();
  const profileDir = connector.session.profileDir;
  await connector.pollSession(connector.session);
  await new Promise((r) => setTimeout(r, 300));

  const status = connector.status();
  assert.equal(status.state, 'error');
  assert.match(status.last_error, /ERROR_INCORRECT_TOKEN|rejected/i);
  assert.equal(fs.existsSync(profileDir), false);
  loginServer.close();
  loginServer.closeAllConnections && loginServer.closeAllConnections();
});
