'use strict';

/**
 * Keeps a local ExpertOption bridge alive inside this service.
 *
 * The bridge ships in eo_bridge/ and runs on the Python standard library only,
 * so the backend does not depend on a second deploy target or extra packages.
 * When EXPERTOPTION_BRIDGE_URL points at an external bridge, this module stays
 * idle.
 */

const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');

let child = null;
let stopped = false;
let restarts = 0;
let lastExit = null;
let ready = false;

function log(message) {
  console.log(`[eo-bridge] ${message}`);
}

function spawnBridge() {
  const script = path.join(config.BASE_DIR, 'eo_bridge', 'standalone.py');
  const env = {
    ...process.env,
    EO_BRIDGE_API_KEY: config.EXPERTOPTION_BRIDGE_KEY,
    EO_BRIDGE_PORT: String(config.EO_LOCAL_BRIDGE_PORT),
    EO_BRIDGE_HOST: '127.0.0.1',
    EO_BRIDGE_ALLOW_REAL_READ: config.EXPERTOPTION_ALLOW_REAL_READ ? 'true' : 'true',
    EO_BRIDGE_DEMO_ONLY: 'true',
    PYTHONUNBUFFERED: '1',
  };
  child = spawn(config.EO_PYTHON, ['-u', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(`[eo-bridge] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[eo-bridge] ${chunk}`));
  child.on('error', (err) => {
    lastExit = `spawn failed: ${err.message}`;
    log(`cannot start ${config.EO_PYTHON}: ${err.message}. Set EXPERTOPTION_BRIDGE_URL to an external bridge.`);
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopped) return;
    restarts += 1;
    lastExit = `exit ${code ?? signal}`;
    const delay = Math.min(30000, 1500 * restarts);
    log(`bridge exited (${lastExit}); restarting in ${delay} ms`);
    const timer = setTimeout(() => { if (!stopped) spawnBridge(); }, delay);
    timer.unref();
  });
}

async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${config.EO_LOCAL_BRIDGE_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

async function externalHealthy() {
  try {
    const res = await fetch(`${config.EXPERTOPTION_BRIDGE_URL.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function switchToLocal() {
  // An unreachable external bridge (stale URL after a deleted service) must not
  // leave the app permanently blind: fall back to the in-service bridge.
  config.EO_USE_LOCAL_BRIDGE = true;
  config.EXPERTOPTION_BRIDGE_URL = `http://127.0.0.1:${config.EO_LOCAL_BRIDGE_PORT}`;
  config.EXPERTOPTION_BRIDGE_KEY = require('crypto').randomBytes(24).toString('hex');
}

async function ensureLocalBridge() {
  if (!config.EO_USE_LOCAL_BRIDGE) {
    if (await externalHealthy()) return { mode: 'external', url: config.EXPERTOPTION_BRIDGE_URL };
    log(`external bridge ${config.EXPERTOPTION_BRIDGE_URL} is unreachable; starting the in-service bridge instead`);
    switchToLocal();
  }
  if (stopped) return { mode: 'stopped' };
  if (!child) spawnBridge();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await probe()) {
      ready = true;
      if (attempt > 0) log(`bridge ready on port ${config.EO_LOCAL_BRIDGE_PORT}`);
      return { mode: 'local', ready: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`bridge did not answer on port ${config.EO_LOCAL_BRIDGE_PORT} (${lastExit || 'still starting'})`);
  return { mode: 'local', ready: false, lastExit };
}

function stopLocalBridge() {
  stopped = true;
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

function status() {
  if (!config.EO_USE_LOCAL_BRIDGE) {
    return { mode: 'external', url: config.EXPERTOPTION_BRIDGE_URL, ready: null };
  }
  return { mode: 'local', port: config.EO_LOCAL_BRIDGE_PORT, ready, restarts, last_exit: lastExit };
}

module.exports = { ensureLocalBridge, stopLocalBridge, status };
