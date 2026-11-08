'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CdpClient } = require('./cdp-client');

const VIEWPORT = { width: 430, height: 760 };
const LOGIN_URL = process.env.CLOUD_CONNECTOR_LOGIN_URL || 'https://m.expertoption.com';
const TTL_MS = Math.max(60000, Number(process.env.CLOUD_CONNECTOR_TTL_MS || 10 * 60 * 1000));
const FRAME_MIN_MS = 200;
const POLL_MS = 1500;
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

const TOKEN_KEYS = /^(token|access_token|auth_token|jwt|session|sessiontoken)$/i;

function tokenFromText(text) {
  if (!text) return '';
  const json = String(text).match(/["'](token|access_token|auth_token|jwt|sessionToken)["']\s*:\s*["']([^"']{20,})["']/i);
  if (json) return json[2];
  for (const chunk of String(text).split(/[\n;]/)) {
    const kv = chunk.match(/^\s*([A-Za-z0-9_.-]{2,40})\s*[=:]\s*"?([^";,\s]+)"?\s*$/);
    if (kv && TOKEN_KEYS.test(kv[1]) && kv[2].length >= 40) return kv[2];
    if (kv && kv[1].toLowerCase() === 'token' && kv[2].length >= 20) return kv[2];
  }
  const bearer = String(text).match(/Bearer\s+([A-Za-z0-9_\-.=]{40,})/);
  if (bearer) return bearer[1];
  const jwt = String(text).match(/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/);
  return jwt ? jwt[1] : '';
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length})`;
}


function memLimitMb() {
  const files = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (raw && raw !== 'max') {
        const bytes = Number(raw);
        if (Number.isFinite(bytes) && bytes > 0 && bytes < 1e15) return Math.round(bytes / 1048576);
      }
    } catch { /* ignore */ }
  }
  return null;
}

function groupMem(pgid) {
  const out = { rss: 0, pss: 0 };
  if (!pgid) return out;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      if (Number(fields[2]) !== pgid) continue;
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m);
      if (rss) out.rss += Number(rss[1]);
      try {
        const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
        const pss = rollup.match(/^Pss:\s+(\d+) kB/m);
        if (pss) out.pss += Number(pss[1]);
        else if (rss) out.pss += Number(rss[1]);
      } catch { if (rss) out.pss += Number(rss[1]); }
    } catch { /* process vanished */ }
  }
  out.rss = Math.round(out.rss / 1024);
  out.pss = Math.round(out.pss / 1024);
  return out;
}

function groupRssMb(pgid) { return groupMem(pgid).rss; }

function selfRssMb() {
  try {
    const m = fs.readFileSync('/proc/self/status', 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

const READ_STATE_JS = `(() => {
  const out = [String(document.cookie || '')];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      out.push(k + '=' + String(localStorage.getItem(k) || ''));
    }
  } catch (e) { /* ignore */ }
  try {
    if (location.href) out.push('href=' + location.href);
    if (document.title) out.push('title=' + document.title);
    const email = document.querySelector('input[type=email], input[name*=mail i], input[name*=login i]');
    if (email && email.value) out.push('login=' + email.value);
  } catch (e) { /* ignore */ }
  return out.join('\\n');
})()`;

function navTarget(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return LOGIN_URL; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return LOGIN_URL;
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)expertoption\.com$/.test(host)) return parsed.href;
  if (host === '127.0.0.1' || host === 'localhost') return parsed.href;
  return LOGIN_URL;
}

function findSystemChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

class CloudConnector {
  constructor({ engine, logger } = {}) {
    this.engine = engine;
    this.log = logger || (() => {});
    this.session = null;
    this.lastError = '';
    this.lastOutcome = null;
    this.lastLaunchMs = null;
    this.binary = '';
    this.probe = null;
    this.probing = false;
  }

  enabled() {
    return String(process.env.CLOUD_CONNECTOR_ENABLED || 'true').toLowerCase() !== 'false';
  }

  async resolveBinary() {
    if (this.binary) return this.binary;
    const system = findSystemChromium();
    if (system) { this.binary = system; return system; }
    try {
      const chromium = require('@sparticuz/chromium');
      const exe = await chromium.executablePath();
      if (exe && fs.existsSync(exe)) { this.binary = exe; return exe; }
    } catch (err) {
      throw new Error(`لا يوجد Chromium صالح على هذا الخادم: ${err.message}`);
    }
    throw new Error('لم يُعثر على Chromium. اضبط CHROMIUM_PATH أو ثبّت @sparticuz/chromium.');
  }

  async availability() {
    if (!this.enabled()) {
      return { available: false, enabled: false, reason_ar: 'الموصّل السحابي معطّل بهذا الإعداد (CLOUD_CONNECTOR_ENABLED=false).' };
    }
    try {
      const exe = await this.resolveBinary();
      return {
        available: true, enabled: true, executable: exe,
        last_launch_ms: this.lastLaunchMs, last_error: this.lastError || null,
      };
    } catch (err) {
      return { available: false, enabled: true, reason_ar: err.message, reason_en: err.message, last_error: err.message };
    }
  }

  status() {
    const s = this.session;
    return {
      enabled: this.enabled(),
      state: s ? s.state : (this.lastOutcome ? this.lastOutcome.state : 'idle'),
      started_at: s ? new Date(s.startedAt).toISOString() : null,
      expires_at: s ? new Date(s.startedAt + TTL_MS).toISOString() : null,
      elapsed_ms: s ? Date.now() - s.startedAt : 0,
      url: s ? s.url : (this.lastOutcome ? this.lastOutcome.url : null),
      title: s ? s.title : (this.lastOutcome ? this.lastOutcome.title : null),
      viewport: VIEWPORT,
      token_detected: s ? Boolean(s.tokenSeen) : Boolean(this.lastOutcome && this.lastOutcome.token_seen),
      token_masked: null,
      last_error: this.lastError || null,
      verification: s ? s.verification : null,
      read_only: true,
      execution_enabled: false,
      probe: this.probeSummary(),
      account_verified: Boolean(s && s.verification && s.verification.verified),
    };
  }


  probeSummary() {
    const p = this.probe;
    const limit = memLimitMb();
    const base = {
      ran: Boolean(p),
      at: p ? p.at : null,
      browser_launch_ok: p ? Boolean(p.launch_ms) : false,
      frames_ok: p ? p.frames > 0 : false,
      input_ok: p ? Boolean(p.input_ok) : false,
      page_ok: p ? Boolean(p.page_ok) : false,
      page_title: p ? (p.page_title || '') : '',
      page_password_fields: p ? (p.page_password_fields || 0) : 0,
      page_text_len: p ? (p.page_text_len || 0) : 0,
      launch_ms: p ? p.launch_ms : null,
      frame_bytes: p ? p.frame_bytes : null,
      peak_rss_mb: p ? p.peak_rss_mb : null,
      peak_pss_mb: p ? (p.peak_pss_mb || null) : null,
      server_rss_mb: selfRssMb(),
      limit_mb: limit,
      error: p && p.error ? String(p.error).slice(0, 300) : null,
    };
    if (!p) return base;
    return { ...base, ok: Boolean(p.ok) };
  }

  async runProbe({ url = LOGIN_URL } = {}) {
    if (this.probing) return this.probe;
    if (this.session) {
      this.log('cloud connector probe skipped: a session is active');
      return this.probe;
    }
    this.probing = true;
    const limit = memLimitMb();
    const result = {
      at: new Date().toISOString(), ok: false, launch_ms: null, frames: 0, frame_bytes: 0,
      input_ok: false, page_ok: false, page_url: '', page_title: '',
      peak_rss_mb: 0, peak_pss_mb: 0, limit_mb: limit, server_rss_mb_before: selfRssMb(), error: null,
    };
    let sample = null;
    try {
      const exe = await this.resolveBinary();
      result.executable_basename = path.basename(exe);
      result.executable_from = exe === findSystemChromium() ? 'system' : 'bundled';
      const started = await this.start({});
      result.launch_ms = this.lastLaunchMs;
      const pgid = this.session && this.session.child ? this.session.child.pid : 0;
      sample = setInterval(() => {
        const mem = groupMem(pgid);
        if (mem.rss > result.peak_rss_mb) result.peak_rss_mb = mem.rss;
        if (mem.pss > (result.peak_pss_mb || 0)) result.peak_pss_mb = mem.pss;
      }, 400);
      if (sample.unref) sample.unref();

      const s = this.session;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        if (!this.session) break;
        const href = String(s.url || '');
        if (/expertoption\.com/i.test(href) && href !== url) { result.page_ok = true; break; }
      }
      if (!this.session) throw new Error('أُغلقت الجلسة أثناء الفحص.');

      for (let i = 0; i < 3; i += 1) {
        const shot = await this.frame();
        if (shot.jpeg && shot.jpeg.length > 0) {
          result.frames += 1;
          result.frame_bytes = shot.jpeg.length;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      result.page_url = String(s.url || '');
      result.page_title = String(s.title || '').slice(0, 160);
      result.page_ok = /^https?:/i.test(result.page_url);
      // Public, non-secret shape of the page: proves whether the login form actually rendered.
      try {
        const shape = await s.cdp.send('Runtime.evaluate', {
          expression: "JSON.stringify({title:document.title||'',pw:document.querySelectorAll('input[type=password]').length,txt:(document.body?document.body.innerText.trim().length:0)})",
          returnByValue: true,
        });
        const parsed = JSON.parse((shape && shape.result && shape.result.value) || '{}');
        result.page_password_fields = Number(parsed.pw || 0);
        result.page_text_len = Number(parsed.txt || 0);
        if (parsed.title && !result.page_title) result.page_title = String(parsed.title).slice(0, 160);
      } catch { /* diagnostics only */ }

      await this.input({ type: 'scroll', x: 200, y: 400, dy: 240 });
      await this.input({ type: 'text', text: 'rozlf-probe' });
      await this.input({ type: 'key', key: 'Escape' });
      await this.input({ type: 'click', x: 20, y: 300 });
      result.input_ok = true;

      result.peak_rss_mb = Math.max(result.peak_rss_mb, groupRssMb(pgid));
      result.server_rss_mb_after = selfRssMb();
      result.ok = Boolean(result.launch_ms) && result.frames > 0 && result.input_ok;
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
      if (sample) clearInterval(sample);
      try { await this.stop('probe_failed'); } catch { /* ignore */ }
    } finally {
      if (sample) clearInterval(sample);
    }
    if (this.session) { try { await this.stop('probe'); } catch { /* ignore */ } }
    this.probe = result;
    this.probing = false;
    this.log(`cloud connector probe: ok=${result.ok} launch=${result.launch_ms}ms frames=${result.frames} peak_rss=${result.peak_rss_mb}MB peak_pss=${result.peak_pss_mb}MB limit=${result.limit_mb}MB${result.error ? ' error=' + result.error.slice(0, 120) : ''}`);
    return result;
  }

  async start({ login = '', url = '' } = {}) {
    if (!this.enabled()) throw new Error('الموصّل السحابي معطّل على هذا الخادم.');
    if (this.session) {
      if (this.session.state === 'live') {
        const err = new Error('توجد جلسة موصّل نشطة بالفعل.');
        err.code = 'session_active';
        throw err;
      }
      await this.stop('replaced');
    }

    const exe = await this.resolveBinary();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozlf-cc-'));
    const args = [
      '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--password-store=basic', '--use-mock-keychain',
      '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
    ];
    const t0 = Date.now();
    const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    const session = {
      sid: require('crypto').randomBytes(12).toString('hex'),
      child, profileDir, cdp: null, page: null,
      state: 'launching', startedAt: Date.now(), url: '', title: '',
      tokenSeen: false, tokenMasked: '', verification: null,
      lastFrame: null, lastFrameAt: 0, pollTimer: null, ttlTimer: null, stderr: '',
    };
    this.session = session;
    if (child.unref) child.unref();
    child.stderr.on('data', (d) => { session.stderr = (session.stderr + d).slice(-4000); });
    child.on('exit', (code, signal) => {
      if (this.session === session && session.state !== 'idle') {
        this.lastError = session.stderr.split('\n').filter(Boolean).slice(-1)[0] || `chromium exited (${code || signal})`;
        session.state = 'error';
      }
    });

    try {
      const port = await this.waitForPort(profileDir, 20000);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (!page) throw new Error('Chromium لم يفتح صفحة قابلة للتحكم.');
      const cdp = await new CdpClient(page.webSocketDebuggerUrl).connect(12000);
      session.cdp = cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: true,
      });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Linux armv8l' });
      await cdp.send('Page.navigate', { url: navTarget(url) });
      this.lastLaunchMs = Date.now() - t0;
      this.lastError = '';
      session.state = 'live';
      session.pollTimer = setInterval(() => { this.pollSession(session).catch(() => {}); }, POLL_MS);
      session.ttlTimer = setTimeout(() => {
        this.lastError = 'انتهت مدة الجلسة المؤقتة (10 دقائق) وأُغلقت.';
        this.stop('expired').catch(() => {});
      }, TTL_MS);
      for (const t of [session.pollTimer, session.ttlTimer]) if (t.unref) t.unref();
      this.log(`cloud connector started (${this.lastLaunchMs} ms, ${path.basename(exe)})`);
      return { sid: session.sid, expires_at: new Date(session.startedAt + TTL_MS).toISOString(), viewport: VIEWPORT };
    } catch (err) {
      this.lastError = err.message;
      session.state = 'error';
      await this.stop('launch_failed');
      throw err;
    }
  }

  waitForPort(profileDir, timeoutMs) {
    const file = path.join(profileDir, 'DevToolsActivePort');
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          if (fs.existsSync(file)) {
            const [port] = fs.readFileSync(file, 'utf8').split('\n');
            if (port && Number(port) > 0) return resolve(Number(port));
          }
        } catch { /* ignore */ }
        if (Date.now() - started > timeoutMs) {
          const s = this.session;
          const tail = s ? s.stderr.split('\n').filter(Boolean).slice(-3).join(' | ') : '';
          return reject(new Error(`Chromium لم يبدأ خلال ${Math.round(timeoutMs / 1000)}ث ${tail ? ': ' + tail.slice(0, 200) : ''}`));
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  async evaluate(expression) {
    const s = this.session;
    if (!s || !s.cdp) throw new Error('لا توجد جلسة موصّل.');
    const res = await s.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    return res && res.result ? res.result.value : undefined;
  }

  async pollSession(session) {
    if (this.session !== session || session.state !== 'live') return;
    let text = '';
    try { text = String(await this.evaluate(READ_STATE_JS) || ''); } catch { return; }
    const href = (text.match(/href=(.*)/) || [])[1] || '';
    const title = (text.match(/title=(.*)/) || [])[1] || '';
    if (href) session.url = href.trim();
    if (title) session.title = title.trim();
    if (session.tokenSeen) return;
    const token = tokenFromText(text);
    if (!token) return;
    session.tokenSeen = true;
    session.tokenMasked = mask(token);
    session.state = 'verifying';
    const login = ((text.match(/login=(.*)/) || [])[1] || '').trim();
    this.log('cloud connector captured a session token (value never logged)');
    try {
      const result = await this.engine.attachAccount({
        platform: 'expertoption', accountType: 'demo', login, sessionToken: token,
      });
      const status = (result && result.session) || (this.engine.expertOptionSession && this.engine.expertOptionSession.status()) || {};
      session.verification = {
        verified: Boolean(status.verified),
        account_login: status.login || login || null,
        last_error: status.last_error || null,
        connection_state: status.connection_state || null,
      };
      if (session.verification.verified) {
        session.state = 'success';
        this.lastError = '';
        this.log('cloud connector verified the ExpertOption session');
        this.notifyVerified(session).catch(() => {});
      } else {
        session.state = 'error';
        this.lastError = status.last_error || 'تم استلام الجلسة لكن ExpertOption لم يقبلها.';
      }
      await this.stop(session.state === 'success' ? 'linked' : 'verify_failed');
    } catch (err) {
      session.state = 'error';
      this.lastError = err.message;
      await this.stop('attach_failed');
    }
  }

  async notifyVerified(session) {
    const notifier = this.engine && this.engine.telegram;
    if (!notifier || typeof notifier.sendMessage !== 'function') return;
    const login = (session.verification && session.verification.account_login) || 'ExpertOption';
    await notifier.sendMessage(`🔗 تم ربط جلسة ExpertOption عبر المتصفح السحابي\nالحساب: ${login}\nالوضع: قراءة وتحليل فقط — لا تنفيذ صفقات.`);
  }

  async frame() {
    const s = this.session;
    if (!s || !s.cdp) throw new Error('لا توجد جلسة موصّل نشطة.');
    // Never capture the screen after a session token exists: the UI only needs the
    // pre-login view, and a verified account screen must not be stored or streamed.
    if (s.tokenSeen) return { jpeg: s.lastFrame, at: s.lastFrameAt, url: s.url, title: s.title, state: s.state };
    const now = Date.now();
    if (!s.lastFrame || now - s.lastFrameAt > FRAME_MIN_MS) {
      let shot = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          shot = await s.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: false }, 10000);
          break;
        } catch (err) {
          if (attempt === 2) {
            if (s.lastFrame) break;
            throw err;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (shot && shot.data) {
        s.lastFrame = Buffer.from(shot.data, 'base64');
        s.lastFrameAt = now;
      }
    }
    return { jpeg: s.lastFrame, at: s.lastFrameAt, url: s.url, title: s.title, state: s.state };
  }

  async input(event = {}) {
    const s = this.session;
    if (!s || !s.cdp || s.state !== 'live') throw new Error('لا توجد جلسة موصّل نشطة.');
    const clamp = (v, max) => Math.max(1, Math.min(max, Number(v) || 1));
    const x = clamp(event.x, VIEWPORT.width);
    const y = clamp(event.y, VIEWPORT.height);
    const type = String(event.type || '');
    if (type === 'click') {
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (type === 'scroll') {
      const dy = Math.max(-1200, Math.min(1200, Number(event.dy) || 0));
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    } else if (type === 'text') {
      const text = String(event.text || '').slice(0, 400);
      if (text) await s.cdp.send('Input.insertText', { text });
    } else if (type === 'key') {
      const key = String(event.key || '');
      const map = {
        Enter: [13, 'Enter'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'],
        Escape: [27, 'Escape'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'],
        Delete: [46, 'Delete'],
      };
      const hit = map[key];
      if (!hit) throw new Error('مفتاح غير مدعوم');
      const [keyCode, code] = hit;
      await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, key, code });
      await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, key, code });
    } else if (type === 'navigate') {
      const url = String(event.url || '');
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('رابط غير صالح'); }
      if (parsed.protocol !== 'https:' || !/(^|\.)expertoption\.com$/i.test(parsed.hostname)) {
        throw new Error('التنقل مسموح داخل expertoption.com فقط.');
      }
      await s.cdp.send('Page.navigate', { url: parsed.href });
    } else {
      throw new Error('نوع إدخال غير معروف');
    }
    return { ok: true };
  }

  async stop(reason = 'stopped') {
    const s = this.session;
    if (!s) return { stopped: false };
    const terminal = s.state === 'success' || s.state === 'error' ? s.state : 'idle';
    this.lastOutcome = {
      state: terminal, error: this.lastError || null, reason, at: new Date().toISOString(),
      token_seen: Boolean(s.tokenSeen), token_masked: null, url: s.url || null, title: s.title || null,
    };
    this.session = null;
    if (s.pollTimer) clearInterval(s.pollTimer);
    if (s.ttlTimer) clearTimeout(s.ttlTimer);
    try { if (s.cdp) await s.cdp.send('Browser.close', {}, 2000).catch(() => {}); } catch { /* ignore */ }
    try { if (s.cdp) s.cdp.close(); } catch { /* ignore */ }
    try { process.kill(-s.child.pid, 'SIGKILL'); } catch { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
    try { if (s.child.stderr) s.child.stderr.destroy(); } catch { /* ignore */ }
    // The throwaway profile holds the login session; delete it so nothing persists.
    for (let i = 0; i < 8; i += 1) {
      try { fs.rmSync(s.profileDir, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    this.log(`cloud connector stopped (${reason})`);
    return { stopped: true, reason };
  }
}

module.exports = { CloudConnector, VIEWPORT, tokenFromText, mask };
