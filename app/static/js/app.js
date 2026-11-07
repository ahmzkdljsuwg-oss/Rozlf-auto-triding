(function () {
  "use strict";

  const state = {
    platform: null,
    accountType: "demo",
    config: null,
    status: null,
    trades: [],
    scanner: null,
    scannerFilter: "all",
    poll: null,
    historyTick: 0,
    token: localStorage.getItem("rozzlf_dash_token") || "",
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function fmtMoney(v, cur = "USD") {
    const n = Number(v || 0);
    return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  function fmtPrice(v) {
    const n = Number(v || 0);
    if (!n) return "—";
    return n >= 1000 ? n.toFixed(2) : n.toFixed(5);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(window.I18N.lang === "ar" ? "ar" : "en-GB", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  let toastTimer = null;
  function toast(msg, type) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3800);
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers["Content-Type"] = "application/json";
    if (state.token) opts.headers["X-Dashboard-Token"] = state.token;
    const res = await fetch("/api" + path, opts);
    if (res.status === 401) {
      const entered = window.prompt("Dashboard access token");
      if (entered) {
        state.token = entered.trim();
        localStorage.setItem("rozzlf_dash_token", state.token);
        return api(path, options);
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
    return data;
  }

  /* ---------------- onboarding ---------------- */
  function showScreen(name) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    const el = $("#screen-" + name);
    if (el) el.classList.add("active");
    const idx = { platform: 1, account: 2, login: 3 }[name] || 1;
    $$(".step-dot").forEach((d, i) => d.classList.toggle("active", i < idx));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function selectPlatform(platform) {
    state.platform = platform;
    $("#selected-platform-label").textContent =
      platform === "mt5" ? "MetaTrader 5 · Demo" : "ExpertOption · Analysis";
    showScreen("account");
  }

  function goLogin() {
    $("#login-subtitle").textContent = t(
      state.platform === "mt5" ? "subtitle.mt5" : "subtitle.eo"
    );
    $("#platform-notice").textContent = t(
      state.platform === "mt5" ? "notice.mt5" : "notice.eo"
    );
    $("#server-field").classList.toggle("hidden", state.platform !== "mt5");
    $("#login-error").textContent = "";
    showScreen("login");
  }

  async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const login = form.login.value.trim();
    const password = form.password.value;
    const server = form.server ? form.server.value.trim() : "";
    if (!login || !password) {
      $("#login-error").textContent = t("login.needLogin");
      return;
    }
    const btn = $("#login-submit");
    btn.disabled = true;
    btn.textContent = t("login.working");
    $("#login-error").textContent = "";
    try {
      await api("/connect", {
        method: "POST",
        body: JSON.stringify({
          platform: state.platform,
          account_type: state.accountType,
          login, password, server,
        }),
      });
      form.reset();
      await enterDashboard();
      toast(t("login.ok"), "success");
    } catch (err) {
      $("#login-error").textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = t("login.submit");
    }
  }

  /* ---------------- dashboard ---------------- */
  async function enterDashboard() {
    $("#onboarding").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    await refreshStatus();
    await loadHistory();
    await loadStats();
    if (state.status && state.status.analysis_only) await loadScanner();
    if (state.poll) clearInterval(state.poll);
    state.poll = setInterval(tick, 5000);
  }

  async function tick() {
    if ($("#dashboard").classList.contains("hidden")) return;
    state.historyTick++;
    try {
      await refreshStatus();
      if (state.historyTick % 2 === 0) await loadHistory();
      if (state.historyTick % 6 === 0) await loadStats();
      if (state.historyTick % 3 === 0 && state.status && state.status.analysis_only) await loadScanner();
    } catch (err) {
      const pill = $("#conn-pill");
      pill.className = "status-pill bad";
      pill.innerHTML = "<i></i><span>" + t("status.disconnected") + "</span>";
    }
  }

  async function refreshStatus() {
    const s = await api("/status");
    state.status = s;
    renderStatus(s);
  }

  function renderStatus(s) {
    const pnlEl = $("#today-pnl");
    pnlEl.textContent = fmtMoney(s.today_pnl, s.currency);
    pnlEl.className = s.today_pnl > 0 ? "pos" : s.today_pnl < 0 ? "neg" : "";

    const accountLive = Boolean(s.account_synced && s.broker_connected);
    $("#balance-value").textContent = accountLive ? fmtMoney(s.balance, s.currency) : "—";
    $("#balance-cur").textContent = s.currency || "USD";
    $("#equity-value").textContent = accountLive ? fmtMoney(s.equity, s.currency) : "—";
    $("#free-margin").textContent = accountLive ? fmtMoney(s.margin_free, s.currency) : "—";
    $("#used-margin").textContent = accountLive ? fmtMoney(s.margin_used, s.currency) : "—";
    $("#margin-level").textContent = accountLive && s.margin_level !== null
      ? Number(s.margin_level).toFixed(1) + "%" : "—";
    $("#sync-state").textContent = accountLive
      ? (s.account_sync_at ? t("dash.syncedAt") + ": " + fmtTime(s.account_sync_at) : t("dash.neverSynced"))
      : (s.account_sync_error || t("dash.accountDisconnected"));
    $("#open-count").textContent = s.open_trades.length;
    $("#open-positions-count").textContent = s.open_trades.length;
    $("#daily-count").textContent = s.today_trades;

    const platformName = s.platform === "mt5" ? "MT5" : "ExpertOption";
    $("#mode-chip").textContent = s.account_type.toUpperCase() + " · " + platformName;
    $("#account-label").textContent = (s.account_login || "").replace(/.(?=.{3})/g, "•");
    $("#last-scan").textContent = s.last_scan_at
      ? t("status.lastScan") + ": " + fmtTime(s.last_scan_at)
      : t("status.never");

    const pill = $("#conn-pill");
    const ok = s.broker_connected && s.account_synced;
    if (s.analysis_only) {
      pill.className = "status-pill analysis";
      pill.innerHTML = "<i></i><span>" + t("status.analysis") + "</span>";
    } else {
      pill.className = "status-pill " + (ok ? "ok" : "bad");
      pill.innerHTML = "<i></i><span>" + (ok ? t("dash.marketOk") : t("status.disconnected")) + "</span>";
    }

    const dot = $("#live-dot");
    dot.className = "live-dot" + (s.emergency ? " emergency" : s.running ? " on" : "");
    const stateLabel = $("#bot-state-label");
    const sub = $("#engine-sub");
    if (s.emergency) {
      stateLabel.textContent = t("status.emergency");
      sub.textContent = t("status.scans") + " " + s.scan_count;
    } else if (s.running) {
      stateLabel.textContent = s.execution_mode === "analysis_only" ? t("status.analysis") : t("status.running");
      sub.textContent = (s.execution_mode === "simulated" ? t("status.simulated") : "MT5") +
        " · " + t("status.scans") + " " + s.scan_count;
    } else {
      stateLabel.textContent = t("dash.stopped");
      sub.textContent = s.execution_mode === "analysis_only" ? t("status.analysis") :
        s.execution_mode === "simulated" ? t("status.simulated") : "MT5";
    }

    const toggle = $("#toggle-bot");
    toggle.textContent = s.running ? t("dash.stop") : t("dash.start");
    toggle.disabled = s.emergency;
    $("#emergency-btn").disabled = s.emergency;

    const speed = s.speed || "medium";
    $$("[data-speed]").forEach((btn) => btn.classList.toggle("active", btn.dataset.speed === speed));
    const preset = s.speed_preset || {};
    $("#speed-note").textContent = t("speed." + speed) + " · " +
      t("speed.scanEvery") + " " + (preset.scan_interval_seconds || 30) + "s";

    $("#risk-percent").textContent = (s.risk.risk_percent || 0) + "%";
    $("#daily-limit").textContent = fmtMoney(s.daily_loss_limit, s.currency);
    $("#max-open").textContent = s.risk.max_open_trades || 3;

    $("#market-state").textContent = s.market_connected ? t("dash.marketOk") : t("dash.marketOff");
    $("#telegram-state").textContent = s.telegram_enabled ? t("dash.tgReady") : t("dash.tgOff");
    $("#ai-state").textContent = s.ai_enabled ? t("dash.aiReady") : t("dash.aiUnavailable");

    const platformLabel = s.platform === "mt5" ? "MT5" : s.platform === "expertoption" ? "ExpertOption" : "—";
    $("#platform-state").textContent = platformLabel + " · " + (s.account_type || "demo").toUpperCase();
    $("#bridge-state").textContent = s.execution_mode === "live_bridge" ? "متصل" : s.execution_mode === "simulated" ? "محاكاة" : "تحليل فقط";
    $("#sync-age").textContent = s.account_sync_at ? fmtTime(s.account_sync_at) : "—";
    $("#last-error").textContent = s.last_error || s.account_sync_error || "—";
    const modeText = s.analysis_only ? "تحليل فقط" : s.trading_mode === "demo" ? "Demo" : "Real";
    $("#stat-mode").textContent = modeText;

    renderOpportunities(s.opportunities || []);
    renderOpenTrades(s.open_trades || []);
    const scannerPanel = $("#scanner-panel");
    if (scannerPanel) scannerPanel.classList.toggle("hidden", !s.analysis_only);
    $("#scan-hint").textContent = s.scan_count ? t("status.scans") + " " + s.scan_count : t("dash.scanning");
  }

  async function loadStats() {
    try {
      const s = await api("/stats");
      $("#stat-total").textContent = s.total || 0;
      $("#stat-winrate").textContent = (s.win_rate || 0) + "%";
      $("#stat-pnl").textContent = fmtMoney(s.total_pnl, "USD");
      $("#stat-pnl").className = Number(s.total_pnl || 0) >= 0 ? "pos" : "neg";
      $("#stats-note").textContent = "مفتوحة: " + (s.open || 0) + " · اليوم: " + (s.today || 0);
    } catch (err) { /* silent during polling */ }
  }

  function renderOpportunities(list) {
    const box = $("#opportunities");
    if (!list.length) {
      box.innerHTML = '<div class="empty-state">' + t("dash.noOpp") + "</div>";
      return;
    }
    const ar = window.I18N.lang === "ar";
    box.innerHTML = list.slice(0, 6).map((o) => {
      const sideCls = o.side === "BUY" ? "BUY" : o.side === "SELL" ? "SELL" : "NO";
      const label = o.side === "NO TRADE" ? t("status.noTrade") : o.side;
      const reason = (ar ? o.reason_ar : o.reason) || "";
      return '<div class="opp-row">' +
        '<div class="opp-side ' + sideCls + '">' + esc(label) + "</div>" +
        '<div class="opp-main"><strong>' + esc(o.symbol) + " <em>" + esc(o.timeframe) + "</em></strong>" +
        "<small>" + esc(reason) + "</small></div>" +
        '<div class="conf-wrap"><div class="conf-bar"><i style="width:' +
        Math.round((o.confidence || 0) * 100) + '%"></i></div>' +
        '<span class="conf-num">' + Math.round((o.confidence || 0) * 100) + "%</span></div>" +
        "</div>";
    }).join("");
  }

  function categoryLabel(scanner, id) {
    const cat = (scanner.categories || []).find((c) => c.id === id);
    if (!cat) return id;
    return window.I18N.lang === "ar" ? cat.label_ar : cat.label_en;
  }

  function fmtScanPrice(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return "—";
    return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : n >= 10 ? n.toFixed(3) : n.toFixed(5);
  }

  async function loadScanner() {
    if (!state.status || !state.status.analysis_only) return;
    try {
      const scanner = await api("/scanner");
      state.scanner = scanner;
      renderScanner(scanner);
    } catch (err) { /* keep the last scanner snapshot */ }
  }

  function renderScanner(scanner) {
    const scan = scanner.scan || {};
    $("#scan-total").textContent = scan.total || 0;
    $("#scan-analyzed").textContent = scan.scanned || 0;
    $("#scan-qualified").textContent = scan.qualified || 0;
    $("#scan-buysell").textContent = (scan.buys || 0) + " / " + (scan.sells || 0);
    const stateEl = $("#scanner-state");
    stateEl.className = "scanner-state" + (scan.running ? " busy" : "");
    if (scan.running) {
      stateEl.textContent = t("scan.running") + " " + (scan.scanned || 0) + "/" + (scan.total || 0);
    } else if (!scan.finished_at) {
      stateEl.textContent = t("scan.notStarted");
    } else {
      stateEl.textContent = (scanner.auto ? t("scan.autoOn") : t("scan.autoOff")) +
        " · " + (scan.failed ? t("scan.status.unavailable") + ": " + scan.failed : t("scan.idle"));
    }
    $("#scanner-updated").textContent = scan.finished_at
      ? t("scan.lastUpdate") + ": " + fmtTime(scan.finished_at) : "—";
    $("#scanner-start").disabled = Boolean(scan.running);

    const tabs = $("#scanner-tabs");
    const active = state.scannerFilter || "all";
    tabs.innerHTML = (scanner.categories || []).map((cat) =>
      '<button type="button" class="scanner-tab' + (cat.id === active ? " active" : "") +
      '" data-scan-cat="' + esc(cat.id) + '" role="tab">' +
      esc(window.I18N.lang === "ar" ? cat.label_ar : cat.label_en) +
      "<small>" + (cat.count || 0) + "</small></button>"
    ).join("");

    const cat = (scanner.categories || []).find((c) => c.id === active);
    const note = $("#scanner-category-note");
    const unavailable = cat && cat.unavailable_reason;
    note.classList.toggle("hidden", !unavailable);
    note.textContent = unavailable ? t("scan.categoryUnavailable") : "";

    const list = (scanner.markets || []).filter((row) => active === "all" || row.category === active);
    const box = $("#scanner-list");
    if (!list.length) {
      box.innerHTML = '<div class="empty-state">' + (unavailable ? t("scan.categoryUnavailable") : t("scan.idle")) + "</div>";
      return;
    }
    const ar = window.I18N.lang === "ar";
    box.innerHTML = list.map((row) => {
      const side = row.signal === "BUY" ? "BUY" : row.signal === "SELL" ? "SELL" : "NO";
      const sideLabel = side === "NO" ? t("status.noTrade") : side;
      const statusKey = "scan.status." + (row.status || "pending");
      const trend = t("trend." + (row.trend || "unknown"));
      const change = row.change_percent === null || row.change_percent === undefined ? "" :
        " · " + (row.change_percent > 0 ? "+" : "") + row.change_percent + "%";
      const structure = row.structure || {};
      const reason = ar ? row.reason_ar : row.reason_en;
      const duration = row.duration_minutes
        ? '<span>' + t("scan.duration") + '<strong>' + row.duration_minutes + " " + t("scan.minutes") + "</strong></span>"
        : "";
      const detail = '<div class="scan-detail">' +
        '<p><strong>' + t("scan.reason") + ":</strong> " + esc(reason || t("scan.noData")) + "</p>" +
        '<div class="scan-kv">' +
        '<span>' + t("scan.trend") + '<strong>' + esc(trend) + "</strong></span>" +
        '<span>ADX<strong>' + (row.adx === null ? "—" : row.adx) + "</strong></span>" +
        '<span>RSI<strong>' + (row.rsi === null ? "—" : row.rsi) + "</strong></span>" +
        '<span>ATR<strong>' + (row.atr === null ? "—" : row.atr) + "</strong></span>" +
        '<span>' + t("scan.support") + '<strong>' + (row.support ? fmtScanPrice(row.support) : "—") + "</strong></span>" +
        '<span>' + t("scan.resistance") + '<strong>' + (row.resistance ? fmtScanPrice(row.resistance) : "—") + "</strong></span>" +
        '<span>' + t("scan.structure") + '<strong>' + esc(structure.bias || "neutral") +
          (structure.bos ? " · BOS" : "") + (structure.choch ? " · CHoCH" : "") + "</strong></span>" +
        duration + "</div>" +
        '<p style="color:var(--muted-2)">' + t("scan.chartNote") + "</p></div>";
      return '<details class="scanner-row">' +
        "<summary>" +
        '<div class="scanner-id"><strong>' + esc(row.symbol) + '</strong><small>' +
          esc(row.name) + " · " + esc(categoryLabel(scanner, row.category)) + "</small></div>" +
        '<div class="scanner-price"><strong>' + fmtScanPrice(row.price) + "</strong><small>" +
          esc(trend) + change + "</small></div>" +
        '<div class="scanner-badges"><span class="scan-side ' + side + '">' + esc(sideLabel) + "</span>" +
          '<div class="scan-strength"><i style="width:' + Math.max(2, Math.round(row.strength || 0)) + '%"></i></div>' +
          "<small>" + Math.round(row.strength || 0) + "% · " + esc(t(statusKey)) + "</small></div>" +
        "</summary>" + detail + "</details>";
    }).join("");
  }

  async function startScanning() {
    const btn = $("#scanner-start");
    btn.disabled = true;
    try {
      const scanner = await api("/scanner/scan", {
        method: "POST",
        body: JSON.stringify({ continuous: true, interval_seconds: 90 }),
      });
      state.scanner = scanner;
      renderScanner(scanner);
      toast(t("scan.autoOn"), "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function stopScanning() {
    try {
      const scanner = await api("/scanner/stop", { method: "POST" });
      state.scanner = scanner;
      renderScanner(scanner);
      toast(t("scan.autoOff"));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function scannerTrade() {
    try {
      await api("/scanner/trade", { method: "POST" });
    } catch (err) {
      toast(t("scan.execBlocked"), "error");
    }
  }

  function renderOpenTrades(list) {
    const box = $("#open-positions");
    $("#open-positions-count").textContent = list.length;
    if (!list.length) {
      box.innerHTML = '<div class="empty-state">' + t("dash.noOpen") + "</div>";
      return;
    }
    box.innerHTML = list.map((tr) => {
      const chart = tr.chart_path ? '<button class="text-btn" data-chart="' +
        esc(tr.chart_path.split(/[\\/]/).pop()) + '">' + t("trade.chart") + "</button>" : "";
      return '<div class="position-card">' +
        '<div class="position-top"><strong>' + esc(tr.symbol) + " · " + esc(tr.timeframe) + "</strong>" +
        '<span class="tag ' + esc(tr.side) + '">' + esc(tr.side) + "</span></div>" +
        '<div class="pos-grid">' +
        "<div><span>" + t("trade.entry") + "</span><strong>" + fmtPrice(tr.entry_price) + "</strong></div>" +
        "<div><span>" + t("trade.sl") + "</span><strong>" + fmtPrice(tr.stop_loss) + "</strong></div>" +
        "<div><span>" + t("trade.tp") + "</span><strong>" + fmtPrice(tr.take_profit) + "</strong></div>" +
        "<div><span>" + t("trade.lot") + "</span><strong>" + Number(tr.lot).toFixed(2) + "</strong></div>" +
        "<div><span>" + t("trade.open") + "</span><strong>" + fmtTime(tr.opened_at) + "</strong></div>" +
        "<div><span>R:R</span><strong>" + rr(tr) + "</strong></div>" +
        "<div><span>" + t("trade.current") + "</span><strong>" + (tr.current_price ? fmtPrice(tr.current_price) : "—") + "</strong></div>" +
        "<div><span>" + t("trade.floating") + "</span><strong class=\"" +
          (Number(tr.unrealized_pnl || 0) > 0 ? "pos" : Number(tr.unrealized_pnl || 0) < 0 ? "neg" : "") + "\">" +
          (tr.unrealized_pnl === null || tr.unrealized_pnl === undefined ? "—" : fmtMoney(tr.unrealized_pnl, state.status ? state.status.currency : "USD")) +
        "</strong></div>" +
        "</div>" + (chart ? '<div style="margin-top:8px">' + chart + "</div>" : "") +
        "</div>";
    }).join("");
  }

  function rr(tr) {
    const risk = Math.abs(tr.entry_price - tr.stop_loss);
    const reward = Math.abs(tr.take_profit - tr.entry_price);
    return risk ? (reward / risk).toFixed(1) : "—";
  }

  async function loadHistory() {
    try {
      const data = await api("/trades?limit=40");
      state.trades = data.trades || [];
      renderHistory(state.trades);
    } catch (err) { /* keep last render */ }
  }

  function renderHistory(list) {
    const box = $("#history");
    if (!list.length) {
      box.innerHTML = '<div class="empty-state">' + t("dash.noHistory") + "</div>";
      return;
    }
    box.innerHTML = list.slice(0, 25).map((tr) => {
      const closed = tr.status === "CLOSED";
      const pnl = Number(tr.pnl || 0);
      const resultTag = closed
        ? '<span class="tag ' + (tr.result === "WIN" ? "WIN" : "LOSS") + '">' + esc(tr.result || "") + "</span>"
        : '<span class="tag OPEN">' + t("trade.open") + "</span>";
      const chart = tr.chart_path ? '<button class="text-btn" data-chart="' +
        esc(tr.chart_path.split(/[\\/]/).pop()) + '">' + t("trade.chart") + "</button>" : "";
      return '<div class="history-row">' +
        '<div class="history-top"><strong>' + esc(tr.symbol) + " · " + esc(tr.side) +
        ' <span class="tag ' + esc(tr.side) + '">' + esc(tr.timeframe) + "</span></strong>" +
        resultTag + "</div>" +
        '<div class="price-line">' + t("trade.entry") + " " + fmtPrice(tr.entry_price) +
        " → " + (closed ? fmtPrice(tr.close_price) : "—") + " · " + fmtTime(tr.opened_at) + "</div>" +
        '<div class="hist-grid">' +
        "<div><span>" + t("trade.pnl") + '</span><strong class="' +
        (pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "") + '">' + fmtMoney(pnl) + "</strong></div>" +
        "<div><span>" + t("trade.lot") + "</span><strong>" + Number(tr.lot || 0).toFixed(2) + "</strong></div>" +
        "<div><span>" + t("trade.duration") + "</span><strong>" + duration(tr) + "</strong></div>" +
        "</div>" + (chart ? '<div style="margin-top:6px">' + chart + "</div>" : "") +
        "</div>";
    }).join("");
  }

  function duration(tr) {
    if (!tr.closed_at) return "—";
    const ms = new Date(tr.closed_at) - new Date(tr.opened_at);
    if (isNaN(ms) || ms < 0) return "—";
    const mins = Math.round(ms / 60000);
    return mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m";
  }

  async function openChart(name) {
    try {
      const opts = { headers: {} };
      if (state.token) opts.headers["X-Dashboard-Token"] = state.token;
      const res = await fetch("/api/charts/" + encodeURIComponent(name), opts);
      if (!res.ok) throw new Error("chart unavailable");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* ---------------- actions ---------------- */
  async function toggleBot() {
    const running = state.status && state.status.running;
    try {
      if (running) {
        await api("/bot/stop", { method: "POST" });
        toast(t("toast.stop"));
      } else {
        await api("/bot/start", { method: "POST" });
        toast(t("toast.start"), "success");
      }
      await refreshStatus();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function emergency() {
    if (state.status && state.status.emergency) return;
    if (!window.confirm(t("toast.emergencyConfirm"))) return;
    try {
      await api("/bot/emergency", { method: "POST" });
      toast(t("toast.emergency"), "success");
      await refreshStatus();
      await loadHistory();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function openRisk() {
    try {
      const r = await api("/risk");
      const form = $("#risk-form");
      Object.keys(r).forEach((k) => {
        if (form[k]) form[k].value = r[k];
      });
      $("#risk-modal").classList.remove("hidden");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function saveRisk(e) {
    e.preventDefault();
    const form = e.target;
    const body = {
      risk_percent: Number(form.risk_percent.value),
      daily_loss_limit_percent: Number(form.daily_loss_limit_percent.value),
      max_open_trades: Number(form.max_open_trades.value),
      max_daily_trades: Number(form.max_daily_trades.value),
      min_confidence: Number(form.min_confidence.value),
      max_spread_pips: Number(form.max_spread_pips.value),
    };
    try {
      await api("/risk", { method: "POST", body: JSON.stringify(body) });
      $("#risk-modal").classList.add("hidden");
      toast(t("risk.saved"), "success");
      await refreshStatus();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function openLogs() {
    try {
      const data = await api("/logs?limit=100");
      $("#log-list").innerHTML = (data.logs || []).map((l) =>
        '<div class="log-row"><span class="lvl ' + esc(l.level) + '">' + esc(l.level) + "</span>" +
        '<span class="msg">' + esc(l.message) + '</span><span class="ts">' + fmtTime(l.created_at) + "</span></div>"
      ).join("") || '<div class="empty-state">—</div>';
      $("#logs-modal").classList.remove("hidden");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function testTelegram() {
    try {
      await api("/telegram/test", { method: "POST" });
      toast(t("toast.tgOk"), "success");
    } catch (err) {
      toast(t("toast.tgFail") + ": " + err.message, "error");
    }
  }

  async function testMarket() {
    try {
      const data = await api("/market/test", { method: "POST" });
      toast(data.connected ? t("toast.marketOk") : t("toast.marketFail"), data.connected ? "success" : "error");
      await refreshStatus();
    } catch (err) {
      toast(t("toast.marketFail"), "error");
    }
  }

  async function changeSpeed(mode) {
    try {
      await api("/speed", { method: "POST", body: JSON.stringify({ speed: mode }) });
      await refreshStatus();
      toast(t("toast.speedChanged"), "success");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function syncAccount() {
    const btn = $("#sync-account");
    if (btn) btn.disabled = true;
    try {
      const s = await api("/account/sync", { method: "POST" });
      state.status = s;
      renderStatus(s);
      await loadHistory();
      toast(t("toast.synced"), "success");
    } catch (err) {
      toast(err.message, "error");
      await refreshStatus().catch(() => {});
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openSettings() {
    try {
      const s = await api("/settings");
      const form = $("#settings-form");
      ["mode", "timeframe", "risk_percent", "daily_loss_limit_percent", "max_open_trades",
        "max_daily_trades", "min_confidence", "max_spread_pips", "stop_loss_pips", "take_profit_pips"]
        .forEach((key) => { if (form[key] !== undefined && s[key] !== undefined) form[key].value = s[key]; });

      const tfSelect = $("#settings-timeframe");
      const timeframes = (state.config && state.config.timeframes) || ["M5", "M15", "H1", "H4", "D1"];
      tfSelect.innerHTML = timeframes.map((tf) =>
        '<option value="' + esc(tf) + '">' + esc(tf) + "</option>").join("");
      tfSelect.value = s.timeframe;

      const symbols = (state.config && state.config.symbols) || [];
      $("#settings-symbols").innerHTML = symbols.map((sym) =>
        '<label class="check-item"><input type="checkbox" name="symbol" value="' + esc(sym) + '"' +
        ((s.symbols || []).includes(sym) ? " checked" : "") + " /><span>" + esc(sym) + "</span></label>").join("");

      const labels = {
        bot_started: "بدء التحليل", opportunity: "فرصة جديدة", trade_open: "فتح صفقة",
        trade_close: "إغلاق صفقة", charts: "صور الشارت", daily_report: "التقرير اليومي",
      };
      $("#settings-notifications").innerHTML = Object.keys(labels).map((key) =>
        '<label class="check-item"><input type="checkbox" name="notify" value="' + esc(key) + '"' +
        ((s.notifications || {})[key] !== false ? " checked" : "") + " /><span>" + esc(labels[key]) + "</span></label>").join("");

      $("#settings-modal").classList.remove("hidden");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    const form = e.target;
    const notifications = {};
    $$('#settings-notifications input[name="notify"]').forEach((cb) => { notifications[cb.value] = cb.checked; });
    const body = {
      mode: form.mode.value,
      timeframe: form.timeframe.value,
      risk_percent: Number(form.risk_percent.value),
      daily_loss_limit_percent: Number(form.daily_loss_limit_percent.value),
      max_open_trades: Number(form.max_open_trades.value),
      max_daily_trades: Number(form.max_daily_trades.value),
      min_confidence: Number(form.min_confidence.value),
      max_spread_pips: Number(form.max_spread_pips.value),
      stop_loss_pips: Number(form.stop_loss_pips.value),
      take_profit_pips: Number(form.take_profit_pips.value),
      symbols: $$('#settings-symbols input[name="symbol"]:checked').map((cb) => cb.value),
      notifications,
    };
    if (!body.symbols.length) { toast("اختر زوجاً واحداً على الأقل", "error"); return; }
    try {
      await api("/settings", { method: "POST", body: JSON.stringify(body) });
      $("#settings-modal").classList.add("hidden");
      toast("تم الحفظ ومزامنة الإعدادات مع Telegram", "success");
      await refreshStatus();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function runAnalysis() {
    const btn = $("#run-analysis");
    btn.disabled = true;
    try {
      const result = await api("/analysis/run", { method: "POST" });
      toast("اكتمل التحليل — الفرص: " + result.opportunities.length, "success");
      await refreshStatus();
      await loadStats();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function openAnalysisChart() {
    try {
      const chart = await api("/analysis/chart");
      const name = String(chart.url || "").split("/").pop();
      await openChart(name);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function closeAllTrades() {
    if (!window.confirm("إغلاق كل الصفقات المفتوحة عبر الوسيط؟")) return;
    try {
      const result = await api("/trades/close-all", { method: "POST", body: JSON.stringify({ confirm: true }) });
      toast("أُغلقت " + result.closed + " صفقة، فشل " + result.failed, "success");
      await refreshStatus();
      await loadHistory();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function openErrorLog() {
    try {
      const data = await api("/logs?limit=100&level=warn");
      $("#log-list").innerHTML = (data.logs || []).map((l) =>
        '<div class="log-row"><span class="lvl ' + esc(l.level) + '">' + esc(l.level) + "</span>" +
        '<span class="msg">' + esc(l.message) + '</span><span class="ts">' + fmtTime(l.created_at) + "</span></div>"
      ).join("") || '<div class="empty-state">لا توجد أخطاء مسجلة.</div>';
      $("#logs-modal").classList.remove("hidden");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function logout() {
    if (!window.confirm("Disconnect account?")) return;
    try { await api("/disconnect", { method: "POST" }); } catch (err) { /* ignore */ }
    if (state.poll) clearInterval(state.poll);
    state.poll = null;
    $("#dashboard").classList.add("hidden");
    $("#onboarding").classList.remove("hidden");
    showScreen("platform");
    toast(t("toast.loggedOut"));
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    $$("[data-platform]").forEach((b) => b.addEventListener("click", () => selectPlatform(b.dataset.platform)));
    $$("[data-account-type]").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) { toast(t("account.realLocked"), "error"); return; }
      state.accountType = b.dataset.accountType;
      $$(".account-card").forEach((c) => c.classList.toggle("selected", c === b));
    }));
    $$("[data-back]").forEach((b) => b.addEventListener("click", () => showScreen(b.dataset.back)));
    $("#to-login").addEventListener("click", goLogin);
    $("#login-form").addEventListener("submit", handleLogin);
    $("#test-connection").addEventListener("click", testMarket);
    $("#login-form").querySelector(".reveal").addEventListener("click", (e) => {
      const input = e.target.closest(".password-wrap").querySelector("input");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      e.target.textContent = t(showing ? "login.show" : "login.hide");
    });
    $$("[data-speed]").forEach((btn) => btn.addEventListener("click", () => changeSpeed(btn.dataset.speed)));
    $("#toggle-bot").addEventListener("click", toggleBot);
    $("#emergency-btn").addEventListener("click", emergency);
    $("#open-risk").addEventListener("click", openRisk);
    $("#sync-account").addEventListener("click", syncAccount);
    $("#risk-form").addEventListener("submit", saveRisk);
    $("#open-logs").addEventListener("click", openLogs);
    $("#open-errors").addEventListener("click", openErrorLog);
    $("#open-settings").addEventListener("click", openSettings);
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#run-analysis").addEventListener("click", runAnalysis);
    $("#scanner-start").addEventListener("click", startScanning);
    $("#scanner-stop").addEventListener("click", stopScanning);
    $("#scanner-trade").addEventListener("click", scannerTrade);
    $("#scanner-tabs").addEventListener("click", (e) => {
      const tab = e.target.closest("[data-scan-cat]");
      if (!tab) return;
      state.scannerFilter = tab.dataset.scanCat;
      if (state.scanner) renderScanner(state.scanner);
    });
    $("#send-chart").addEventListener("click", openAnalysisChart);
    $("#close-all").addEventListener("click", closeAllTrades);
    $("#refresh-stats").addEventListener("click", loadStats);
    $("#refresh-history").addEventListener("click", loadHistory);
    $("#test-telegram").addEventListener("click", testTelegram);
    $("#test-market").addEventListener("click", testMarket);
    $("#logout-btn").addEventListener("click", logout);
    $("#lang-toggle").addEventListener("click", () => I18N.setLang(I18N.lang === "ar" ? "en" : "ar"));
    $("#dash-lang").addEventListener("click", () => I18N.setLang(I18N.lang === "ar" ? "en" : "ar"));
    $$(".close-modal").forEach((b) => b.addEventListener("click", () => {
      b.closest(".modal-backdrop").classList.add("hidden");
    }));
    $$(".modal-backdrop").forEach((m) => m.addEventListener("click", (e) => {
      if (e.target === m) m.classList.add("hidden");
    }));
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-chart]");
      if (btn) openChart(btn.dataset.chart);
    });
    document.addEventListener("langchange", () => {
      if (state.status) renderStatus(state.status);
      if (state.scanner) renderScanner(state.scanner);
      renderHistory(state.trades);
    });
  }

  async function boot() {
    I18N.init();
    bind();
    try {
      state.config = await api("/config");
      $("#disclaimer-text").textContent = state.config.disclaimer || "";
      if (!state.config.real_trading_approved) {
        const realBtn = $('[data-account-type="real"]');
        if (realBtn) realBtn.disabled = true;
      }
    } catch (err) {
      toast(err.message, "error");
    }
    try {
      const session = await api("/session");
      if (session.connected) await enterDashboard();
    } catch (err) { /* stay on onboarding */ }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
