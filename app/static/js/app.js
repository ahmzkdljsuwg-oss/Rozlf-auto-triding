(function () {
  'use strict';

  const I18N = window.RozlfI18n;
  const t = (k, v) => I18N.t(k, v);
  const EXPIRIES = [
    { id: '30s', ar: '٣٠ ثانية', en: '30s' },
    { id: '1m', ar: 'دقيقة', en: '1m' },
    { id: '2m', ar: 'دقيقتان', en: '2m' },
    { id: '3m', ar: '٣ دقائق', en: '3m' },
    { id: '5m', ar: '٥ دقائق', en: '5m' },
  ];

  const state = {
    session: null,
    assets: [],
    assetsError: null,
    category: 'all',
    search: '',
    selected: null,
    expiry: '1m',
    last: null,
    busy: false,
    stats: { analyzed: 0, buy: 0, sell: 0, none: 0 },
  };

  const $ = (id) => document.getElementById(id);
  const ar = () => I18N.lang === 'ar';

  function setText(el, text) {
    if (!el) return;
    el.removeAttribute('data-i18n');
    el.textContent = text;
  }

  function num(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const d = digits === undefined ? Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 6 : digits;
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function clock(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString(ar() ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function ago(iso) {
    const d = new Date(iso).getTime();
    if (!Number.isFinite(d)) return '—';
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return ar() ? `قبل ${s} ث` : `${s}s ago`;
    if (s < 3600) return ar() ? `قبل ${Math.round(s / 60)} د` : `${Math.round(s / 60)}m ago`;
    return ar() ? `قبل ${Math.round(s / 3600)} س` : `${Math.round(s / 3600)}h ago`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- toast ---------------- */

  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 4200);
  }

  /* ---------------- owner session ---------------- */
  async function api(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {}, credentials: 'same-origin' }, options || {});
    opts.headers = Object.assign({}, opts.headers);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    let res;
    try { res = await fetch(path, opts); }
    catch (err) { throw new Error(t('toast.offline')); }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const message = (data && (data.detail_ar || data.detail || data.error || data.message)) || `HTTP ${res.status}`;
      const err = new Error(String(message));
      err.status = res.status;
      err.data = data;
      if (res.status === 401) showTelegramGate();
      throw err;
    }
    return data;
  }

  function showTelegramGate(status) {
    const gate = $('telegram-gate');
    if (gate) gate.classList.remove('hidden');
    const username = status && status.telegram_bot_username ? String(status.telegram_bot_username).replace(/^@/, '') : '';
    const href = username ? `https://t.me/${encodeURIComponent(username)}?start=connect` : 'https://t.me/';
    ['telegram-connect-link', 'telegram-gate-link'].forEach((id) => {
      const link = $(id);
      if (link) link.href = href;
    });
    const text = $('telegram-gate-text');
    if (text) text.textContent = username
      ? `افتح @${username} واضغط Start أو اكتب /connect للحصول على رابط ربط آمن.`
      : 'افتح بوت ROZLF في Telegram واكتب /connect للحصول على رابط ربط آمن.';
    setPill('', 'بانتظار ربط Telegram');
  }

  /* ---------------- session ---------------- */

  function setPill(kind, label) {
    const pill = $('conn-pill');
    if (!pill) return;
    pill.className = 'live-pill' + (kind ? ' ' + kind : '');
    setText($('conn-pill-text'), label);
  }

  function renderSession(session) {
    state.session = session || null;
    const verified = Boolean(session && session.verified);
    const connected = Boolean(session && session.connected);
    const data = Boolean(session && session.market_data_available);

    if (verified && data) setPill('on', t('pill.connected'));
    else if (verified) setPill('warn', t('pill.partial'));
    else if (session) setPill('warn', t('pill.disconnected'));
    else setPill('', t('pill.disconnected'));

    const accountDot = $('s-account-dot');
    const sessionDot = $('s-session-dot');
    const bridgeDot = $('s-bridge-dot');
    const dataDot = $('s-data-dot');
    if (accountDot) accountDot.className = 'dot ' + (session && (session.account || session.login) ? 'ok' : 'bad');
    if (sessionDot) sessionDot.className = 'dot ' + (verified ? 'ok' : connected ? 'warn' : 'bad');
    if (bridgeDot) bridgeDot.className = 'dot ' + (session && session.bridge_configured ? 'ok' : 'bad');
    if (dataDot) dataDot.className = 'dot ' + (data ? 'ok' : 'bad');

    const login = session && (session.login || (session.account && session.account.login));
    setText($('s-account'), login ? String(login) : t('state.none'));

    let sessionLabel = t('state.disconnected');
    if (session) {
      const code = String(session.connection_state || '');
      if (code === 'expired' || session.session_expired) sessionLabel = t('state.expired');
      else if (verified) sessionLabel = t('state.connected');
      else if (connected) sessionLabel = t('state.unverified');
      else sessionLabel = t('state.disconnected');
    }
    setText($('s-session'), sessionLabel);
    setText($('s-bridge'), session && session.bridge_configured ? t('state.ready') : t('state.down'));
    setText($('s-data'), data ? t('state.available') : t('state.missing'));
    setText($('status-time'), clock());

    const detail = $('connect-detail');
    if (detail) {
      const msg = session && !verified ? (session.last_error || '') : '';
      detail.textContent = msg ? String(msg).slice(0, 240) : '';
      detail.classList.toggle('ok', !msg);
    }

    const source = $('data-source');
    if (source) {
      if (verified && login) setText(source, t('meta.sourceValue', { name: login }));
      else setText(source, t('meta.source'));
    }
    const dot = $('source-dot');
    if (dot) dot.className = 'dot ' + (verified ? 'ok' : '');

    document.body.classList.toggle('session-live', verified);
  }

  async function refreshSession() {
    try {
      const session = await api('/api/expertoption/session');
      renderSession(session);
      return session;
    } catch (err) {
      if (err.status === 409) {
        renderSession(null);
        return null;
      }
      if (err.status === 401) return null;
      setPill('', t('pill.offline'));
      return state.session;
    }
  }

  /* ExpertOption session is linked through the one-time secure Telegram page. */

  async function disconnect() {
    try {
      await api('/api/disconnect', { method: 'POST', body: {} });
      toast(t('toast.disconnected'));
    } catch (err) {
      toast(String(err.message), 'err');
    }
    await refreshSession();
    state.assets = [];
    renderAssets();
    await loadLogs();
  }

  /* ---------------- assets ---------------- */

  const CATEGORY_LABELS = {
    forex: 'cat.forex',
    otc: 'cat.otc',
    smarty: 'cat.smarty',
    indices: 'cat.indices',
    index: 'cat.indices',
    crypto: 'cat.crypto',
    stocks: 'cat.stocks',
    stock: 'cat.stocks',
    commodities: 'cat.commodities',
    commodity: 'cat.commodities',
  };

  function categoryLabel(cat) {
    const key = CATEGORY_LABELS[String(cat || '').toLowerCase()];
    return key ? t(key) : String(cat || t('cat.all'));
  }

  async function loadAssets() {
    const grid = $('asset-grid');
    try {
      const result = await api('/api/expertoption/assets');
      state.assets = Array.isArray(result.assets) ? result.assets : [];
      state.assetsError = state.assets.length ? null : (result.detail_ar || result.detail || t('assets.empty'));
      if (state.assets.length) toast(t('toast.loadingAssets', { n: state.assets.length }));
    } catch (err) {
      state.assets = [];
      state.assetsError = err.message;
      if (err.data && (err.data.detail_ar || err.data.detail)) state.assetsError = err.data.detail_ar || err.data.detail;
    }
    if (grid) grid.setAttribute('data-loading', '0');
    renderAssets();
    renderQuickAssets();
  }

  function visibleAssets() {
    const q = state.search.trim().toLowerCase();
    return state.assets.filter((a) => {
      if (state.category !== 'all') {
        const cat = String(a.category || '').toLowerCase();
        const match = cat === state.category
          || (state.category === 'indices' && cat === 'index')
          || (state.category === 'otc' && (a.otc || cat === 'otc'));
        if (!match) return false;
      }
      if (!q) return true;
      const hay = `${a.name || ''} ${a.symbol || ''} ${a.key || ''} ${a.id || ''} ${a.category || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderFilters() {
    const bar = $('asset-filters');
    if (!bar) return;
    const cats = ['all'];
    state.assets.forEach((a) => {
      const cat = String(a.category || '').toLowerCase();
      const norm = cat === 'index' ? 'indices' : cat;
      if (norm && !cats.includes(norm)) cats.push(norm);
    });
    bar.innerHTML = cats.map((cat) => {
      const label = cat === 'all' ? t('cat.all') : categoryLabel(cat);
      return `<button type="button" class="chip ${state.category === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(label)}</button>`;
    }).join('');
  }

  function renderAssets() {
    renderFilters();
    const grid = $('asset-grid');
    if (!grid) return;
    const list = visibleAssets();
    if (!state.assets.length) {
      grid.innerHTML = `<div class="empty-state">${escapeHtml(state.assetsError || t('assets.empty'))}</div>`;
      setText($('stat-assets'), '0');
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state">${escapeHtml(t('assets.noMatch'))}</div>`;
      setText($('stat-assets'), String(state.assets.length));
      return;
    }
    grid.innerHTML = list.map((a) => {
      const active = state.selected && String(state.selected.key) === String(a.key) ? ' active' : '';
      const badges = [
        `<span class="badge ${a.otc ? 'gold' : 'blue'}">${escapeHtml(categoryLabel(a.category))}</span>`,
        a.active === false ? `<span class="badge red">${escapeHtml(t('state.inactive'))}</span>` : '',
      ].join('');
      const payout = Number.isFinite(Number(a.payout)) && Number(a.payout) > 0
        ? `<span class="payout">${num(a.payout, 0)}%</span>`
        : `<span class="payout">#${escapeHtml(a.id)}</span>`;
      return `<button type="button" class="asset-card${active}" data-key="${escapeHtml(a.key)}" data-id="${escapeHtml(a.id)}">
        <div class="meta">${badges}</div>
        <div class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="foot">${payout}<span class="arrow">←</span></div>
      </button>`;
    }).join('');
    setText($('stat-assets'), String(state.assets.length));
  }

  function renderQuickAssets() {
    const wrap = $('quick-assets');
    if (!wrap) return;
    const picks = state.assets.slice(0, 6);
    if (!picks.length) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = picks.map((a) => `<button type="button" class="chip" data-key="${escapeHtml(a.key)}">${escapeHtml(a.name)}</button>`).join('');
  }

  function selectAsset(asset, options) {
    if (!asset) return;
    state.selected = asset;
    const supported = Array.isArray(asset.supported_expiries) ? asset.supported_expiries : [];
    if (supported.length && !supported.includes(state.expiry)) {
      state.expiry = supported[0];
    }
    renderAssets();
    renderExpiries();
    updateAnalysisHeader();
    if (!options || options.run !== false) runAnalysis();
  }

  function updateAnalysisHeader() {
    const sub = $('an-sub');
    if (!sub) return;
    if (!state.selected) {
      setText(sub, t('analysis.sub'));
      return;
    }
    const lastTf = state.last && state.last.asset && String(state.last.asset.key) === String(state.selected.key)
      ? state.last.timeframe
      : null;
    setText(sub, t('analysis.subValue', {
      asset: state.selected.name,
      expiry: expiryLabel(state.expiry),
      timeframe: lastTf || '—',
    }));
  }

  function expiryLabel(id) {
    const found = EXPIRIES.find((e) => e.id === id);
    if (!found) return id;
    return ar() ? found.ar : found.en;
  }

  function renderExpiries() {
    const row = $('expiry-row');
    if (!row) return;
    const supported = state.selected && Array.isArray(state.selected.supported_expiries)
      ? state.selected.supported_expiries
      : EXPIRIES.map((e) => e.id);
    row.innerHTML = EXPIRIES.filter((e) => supported.includes(e.id)).map((e) => {
      const active = e.id === state.expiry ? ' active' : '';
      return `<button type="button" class="expiry-btn${active}" data-expiry="${e.id}">${escapeHtml(ar() ? e.ar : e.en)}</button>`;
    }).join('');
  }

  function setBadge(kind, text) {
    const badge = $('an-badge');
    if (badge) badge.className = 'badge ' + kind;
    setText($('an-badge-text'), text);
  }

  /* ---------------- analysis ---------------- */

  function directionKey(direction) {
    if (direction === 'UP') return 'buy';
    if (direction === 'DOWN') return 'sell';
    return 'none';
  }

  function directionLabel(direction) {
    return t('signal.' + directionKey(direction));
  }

  function renderQuick(result) {
    const qv = $('quick-view');
    if (!qv) return;
    const dir = result.direction || 'NO TRADE';
    const signal = $('qv-signal');
    if (signal) {
      signal.className = 'signal-pill ' + directionKey(dir);
      setText(signal, directionLabel(dir));
    }
    const assetName = (result.asset && result.asset.name) || (state.selected && state.selected.name) || '—';
    setText($('qv-asset'), assetName);
    setText($('qv-meta'), `${expiryLabel(result.expiry || state.expiry)} · ${result.timeframe || '—'}`);
    setText($('qv-price'), result.price !== null && result.price !== undefined ? num(result.price) : '—');
    setText($('qv-price-note'), result.live_price ? `${ar() ? 'السعر الحي' : 'Live'} ${num(result.live_price)}` : '');
    setText($('qv-when'), ago(result.last_update || new Date().toISOString()));
    const reason = ar()
      ? (result.reason_ar || (result.reasons_ar && result.reasons_ar[0]) || '')
      : (result.reason_en || (result.reasons_en && result.reasons_en[0]) || '');
    setText($('qv-reason'), reason || t('quick.hint'));
  }

  function renderVerdict(result) {
    const dir = result.direction || 'NO TRADE';
    const signal = $('an-signal');
    if (signal) {
      signal.className = 'signal-pill ' + directionKey(dir);
      setText(signal, directionLabel(dir));
    }
    setText($('verdict-when'), result.last_update ? ago(result.last_update) : '—');

    const confidence = Number(result.confidence);
    const pct = Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence * 100))) : 0;
    const fill = $('an-strength');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'meter-fill ' + (dir === 'UP' ? 'green' : dir === 'DOWN' ? 'red' : '');
    }
    setText($('an-strength-label'), Number.isFinite(confidence) ? pct + '%' : '—');

    const reasons = ar() ? (result.reasons_ar || []) : (result.reasons_en || []);
    const list = reasons.length
      ? reasons
      : [ar() ? (result.reason_ar || '') : (result.reason_en || '')].filter(Boolean);
    const ul = $('an-reasons');
    if (ul) {
      ul.innerHTML = list.length
        ? list.slice(0, 8).map((r) => `<li>${escapeHtml(r)}</li>`).join('')
        : `<li>${escapeHtml(ar() ? 'لا توجد أسباب كافية لعرضها.' : 'No reasons available.')}</li>`;
    }
  }

  function renderIndicators(result) {
    const ind = result.indicators || {};
    const grid = $('ind-grid');
    if (!grid) return;
    const rows = [
      ['ind.rsi', ind.rsi !== null && ind.rsi !== undefined ? num(ind.rsi, 1) : '—'],
      ['ind.macd', ind.macd_hist !== null && ind.macd_hist !== undefined ? num(ind.macd_hist, 5) : '—'],
      ['ind.ema20', ind.ema20 !== null && ind.ema20 !== undefined ? num(ind.ema20) : '—'],
      ['ind.ema50', ind.ema50 !== null && ind.ema50 !== undefined ? num(ind.ema50) : '—'],
      ['ind.ema200', ind.ema200 !== null && ind.ema200 !== undefined ? num(ind.ema200) : '—'],
      ['ind.atr', ind.atr !== null && ind.atr !== undefined ? num(ind.atr, 5) : '—'],
      ['ind.adx', ind.adx !== null && ind.adx !== undefined ? num(ind.adx, 1) : '—'],
      ['ind.trend', trendLabel(result.trend)],
    ];
    grid.innerHTML = rows.map(([k, v]) => `<div class="ind"><small>${escapeHtml(t(k))}</small><b>${escapeHtml(v)}</b></div>`).join('');
    setText($('ind-price'), result.price !== null && result.price !== undefined ? num(result.price) : '—');
  }

  function trendLabel(trend) {
    if (!trend) return '—';
    const map = {
      bullish: ar() ? 'صاعد' : 'Bullish',
      bearish: ar() ? 'هابط' : 'Bearish',
      sideways: ar() ? 'عرضي' : 'Sideways',
      flat: ar() ? 'عرضي' : 'Flat',
    };
    return map[String(trend).toLowerCase()] || String(trend);
  }

  function renderLevels(result) {
    const sr = result.support_resistance;
    const ul = $('sr-list');
    if (!ul) return;
    if (!sr) {
      ul.innerHTML = `<li>${escapeHtml(t('levels.none'))}</li>`;
      return;
    }
    const rows = [
      [t('levels.resistance'), sr.resistance],
      [t('levels.support'), sr.support],
    ].filter((r) => r[1] !== null && r[1] !== undefined);
    ul.innerHTML = rows.map(([label, value]) => `<li><span>${escapeHtml(label)}</span><b>${escapeHtml(num(value))}</b></li>`).join('')
      || `<li>${escapeHtml(t('levels.none'))}</li>`;
  }

  function renderStructure(result) {
    const st = result.structure;
    const ul = $('structure-list');
    if (!ul) return;
    if (!st) {
      ul.innerHTML = `<li>${escapeHtml(t('structure.none'))}</li>`;
      return;
    }
    const yesNo = (v) => (v ? trendLabel(v) : '—');
    const rows = [
      [t('structure.bias'), trendLabel(st.bias)],
      [t('structure.bos'), yesNo(st.bos)],
      [t('structure.choch'), yesNo(st.choch)],
      [t('structure.fvg'), Array.isArray(st.fvg) && st.fvg.length ? String(st.fvg.length) : '—'],
      [t('structure.sweep'), st.liquidity_sweep ? (ar() ? 'نعم' : 'Yes') : (ar() ? 'لا' : 'No')],
    ];
    ul.innerHTML = rows.map(([label, value]) => `<li><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></li>`).join('');
  }

  async function runAnalysis() {
    if (!state.selected) {
      toast(t('analysis.needAsset'), 'err');
      return;
    }
    if (!state.session || !state.session.verified) {
      toast(t('analysis.needSession'), 'err');
      return;
    }
    if (state.busy) return;
    state.busy = true;
    setBadge('gold', t('analysis.running'));
    updateAnalysisHeader();
    const btn = $('analyze-btn');
    if (btn) btn.disabled = true;

    try {
      const result = await api('/api/expertoption/auto-analysis', {
        method: 'POST',
        body: {
          asset_id: state.selected.key,
          instrument_id: state.selected.id,
          expiry: state.expiry,
        },
      });
      state.last = result;
      state.stats.analyzed += 1;
      if (result.direction === 'UP') state.stats.buy += 1;
      else if (result.direction === 'DOWN') state.stats.sell += 1;
      else state.stats.none += 1;

      setBadge('green', t('analysis.done'));
      setText($('last-update'), t('meta.updatedValue', { time: clock(result.last_update) }));
      renderQuick(result);
      renderVerdict(result);
      renderIndicators(result);
      renderLevels(result);
      renderStructure(result);
      drawChart(result.chart && result.chart.candles);
      setText($('chart-meta'), `${result.timeframe || '—'} · ${(result.chart && result.chart.candles ? result.chart.candles.length : 0)} ${ar() ? 'شمعة' : 'candles'}`);
      renderStats();
    } catch (err) {
      setBadge('red', t('analysis.failed'));
      const detail = err.data || {};
      const message = detail.detail_ar || detail.reason_ar || err.message;
      toast(String(message || t('analysis.failed')).slice(0, 180), 'err');
      const signal = $('an-signal');
      if (signal) {
        signal.className = 'signal-pill none';
        setText(signal, t('signal.none'));
      }
      const ul = $('an-reasons');
      if (ul) ul.innerHTML = `<li>${escapeHtml(String(message || '').slice(0, 240))}</li>`;
      setText($('an-strength-label'), '—');
      const fill = $('an-strength');
      if (fill) fill.style.width = '0%';
      setText($('verdict-when'), clock());
    } finally {
      state.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  function renderStats() {
    setText($('stat-analyzed'), String(state.stats.analyzed));
    setText($('stat-buy'), String(state.stats.buy));
    setText($('stat-sell'), String(state.stats.sell));
    setText($('stat-none'), String(state.stats.none));
    setText($('stats-updated'), clock());
  }

  /* ---------------- chart ---------------- */

  function ema(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    values.forEach((v, i) => {
      if (i < period - 1) { out.push(null); return; }
      if (prev === null) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
        prev = sum / period;
      } else {
        prev = v * k + prev * (1 - k);
      }
      out.push(prev);
    });
    return out;
  }

  function drawChart(candles) {
    const canvas = $('price-chart');
    const empty = $('chart-empty');
    const list = Array.isArray(candles) ? candles : [];
    if (!canvas) return;
    if (empty) empty.classList.toggle('hidden', list.length > 0);
    if (!list.length) {
      const ctx0 = canvas.getContext('2d');
      if (ctx0) ctx0.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const wrap = $('chart-wrap');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = (wrap ? wrap.clientWidth : canvas.clientWidth) || 640;
    const height = Math.max(220, Math.round(width * 0.46));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padTop = 14;
    const padBottom = 16;
    const padX = 6;
    const plotW = width - padX * 2;
    const plotH = height - padTop - padBottom;

    const highs = list.map((c) => Number(c.h));
    const lows = list.map((c) => Number(c.l));
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const span = max - min || Math.max(1e-6, max * 0.001);
    const y = (v) => padTop + plotH - ((v - min) / span) * plotH;
    const step = plotW / list.length;
    const bw = Math.max(1.6, Math.min(9, step * 0.62));
    const x = (i) => padX + step * (i + 0.5);

    ctx.strokeStyle = 'rgba(120,122,160,0.13)';
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g += 1) {
      const gy = padTop + (plotH / 4) * g;
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(width - padX, gy);
      ctx.stroke();
    }

    list.forEach((c, i) => {
      const o = Number(c.o);
      const cl = Number(c.c);
      const up = cl >= o;
      ctx.strokeStyle = up ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.9)';
      ctx.fillStyle = up ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)';
      ctx.beginPath();
      ctx.moveTo(x(i), y(Number(c.h)));
      ctx.lineTo(x(i), y(Number(c.l)));
      ctx.stroke();
      const top = y(Math.max(o, cl));
      const bottom = y(Math.min(o, cl));
      ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1.4, bottom - top));
      ctx.strokeRect(x(i) - bw / 2, top, bw, Math.max(1.4, bottom - top));
    });

    const closes = list.map((c) => Number(c.c));
    [['ema20', '#f5b22e', 20], ['ema50', '#5b9cf6', 50]].forEach(([name, color, period]) => {
      const series = ema(closes, period);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      series.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      });
      ctx.stroke();
    });

    const sr = state.last && state.last.support_resistance;
    if (sr) {
      [['rgba(167,139,250,0.7)', sr.resistance], ['rgba(167,139,250,0.45)', sr.support]].forEach(([color, value]) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < min || n > max) return;
        ctx.strokeStyle = color;
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(padX, y(n));
        ctx.lineTo(width - padX, y(n));
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    ctx.fillStyle = 'rgba(236,236,246,0.92)';
    ctx.font = '600 11px "Cairo", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(num(max), padX + 3, padTop + 9);
    ctx.textAlign = 'right';
    ctx.fillText(num(min), width - padX - 3, height - padBottom - 2);
  }

  /* ---------------- logs ---------------- */

  const SECRET_PATTERN = /(token|password|secret|key|authorization)/i;

  async function loadLogs() {
    const wrap = $('log-list');
    if (!wrap) return;
    try {
      const result = await api('/api/logs?limit=30');
      const logs = Array.isArray(result.logs) ? result.logs : [];
      if (!logs.length) {
        wrap.innerHTML = `<p class="verdict-reason">${escapeHtml(t('logs.empty'))}</p>`;
        return;
      }
      wrap.innerHTML = logs.map((row) => {
        const level = String(row.level || 'info');
        const cls = level === 'error' ? ' error' : level === 'warn' ? ' warn' : '';
        let message = String(row.message || '');
        if (SECRET_PATTERN.test(message)) message = message.replace(/=\s*\S+/g, '= [redacted]');
        return `<div class="log-row${cls}">
          <span class="dot ${level === 'error' ? 'bad' : level === 'warn' ? 'warn' : 'ok'}"></span>
          <span class="msg">${escapeHtml(message)}</span>
          <span class="when">${escapeHtml(clock(row.created_at || row.ts))}</span>
        </div>`;
      }).join('');
    } catch (err) {
      wrap.innerHTML = `<p class="verdict-reason">${escapeHtml(String(err.message))}</p>`;
    }
  }

  /* ---------------- uptime ---------------- */

  let bootedAt = Date.now();
  function renderUptime() {
    const s = Math.round((Date.now() - bootedAt) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    setText($('stat-uptime'), h ? `${h}h ${m}m` : `${m}m`);
  }

  /* ---------------- wiring ---------------- */

  function selectByKey(key) {
    const asset = state.assets.find((a) => String(a.key) === String(key) || String(a.id) === String(key));
    if (asset) selectAsset(asset);
  }

  function bind() {
    const search = $('search-form');
    if (search) {
      search.addEventListener('submit', (e) => {
        e.preventDefault();
        state.search = $('asset-search').value || '';
        renderAssets();
        const first = visibleAssets()[0];
        if (first) {
          selectAsset(first);
          const target = $('analysis');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          toast(t('assets.noMatch'), 'err');
        }
      });
    }
    const searchInput = $('asset-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.search = searchInput.value || '';
        renderAssets();
      });
    }

    const grid = $('asset-grid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const card = e.target.closest('.asset-card');
        if (!card) return;
        selectByKey(card.dataset.key);
      });
    }
    const quick = $('quick-assets');
    if (quick) {
      quick.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip) selectByKey(chip.dataset.key);
      });
    }
    const filters = $('asset-filters');
    if (filters) {
      filters.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        state.category = chip.dataset.cat;
        renderAssets();
      });
    }
    const expiries = $('expiry-row');
    if (expiries) {
      expiries.addEventListener('click', (e) => {
        const btn = e.target.closest('.expiry-btn');
        if (!btn) return;
        state.expiry = btn.dataset.expiry;
        renderExpiries();
        updateAnalysisHeader();
        runAnalysis();
      });
    }

    const disconnectBtn = $('disconnect-btn');
    if (disconnectBtn) disconnectBtn.addEventListener('click', disconnect);
    const logsBtn = $('refresh-logs');
    if (logsBtn) logsBtn.addEventListener('click', loadLogs);

    const langToggle = $('lang-toggle');
    if (langToggle) {
      langToggle.addEventListener('click', () => I18N.setLang(ar() ? 'en' : 'ar'));
    }
    document.addEventListener('rozlf:lang', () => {
      renderSession(state.session);
      renderAssets();
      renderQuickAssets();
      renderExpiries();
      updateAnalysisHeader();
      renderStats();
      if (state.last) {
        renderQuick(state.last);
        renderVerdict(state.last);
        renderIndicators(state.last);
        renderLevels(state.last);
        renderStructure(state.last);
      }
      loadLogs();
    });


    window.addEventListener('resize', () => {
      if (state.last && state.last.chart && state.last.chart.candles) drawChart(state.last.chart.candles);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshSession();
    });
  }

  function reveal() {
    const items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    items.forEach((el) => io.observe(el));
  }

  let bootStarted = false;
  async function bootData() {
    if (bootStarted) return;
    bootStarted = true;
    await refreshSession();
    await loadAssets();
    await loadLogs();
    renderExpiries();
    renderStats();
    renderUptime();
    setInterval(refreshSession, 30000);
    setInterval(renderUptime, 1000);
  }

  function init() {
    bind();
    reveal();
    renderExpiries();
    renderAssets();
    renderStats();
    renderQuickAssets();
    setText($('stat-assets'), '—');
    refreshPublic();
  }

  async function refreshPublic() {
    try {
      const status = await fetch('/api/public/status', { credentials: 'same-origin' }).then((r) => r.json());
      if (!status.authenticated) {
        showTelegramGate(status);
        return;
      }
      const gate = $('telegram-gate');
      if (gate) gate.classList.add('hidden');
      const username = status.telegram_bot_username ? String(status.telegram_bot_username).replace(/^@/, '') : '';
      if (username) {
        const href = `https://t.me/${encodeURIComponent(username)}?start=connect`;
        const link = $('telegram-connect-link');
        if (link) link.href = href;
      }
      bootData();
    } catch (err) {
      showTelegramGate();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
