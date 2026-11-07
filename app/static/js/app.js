(function () {
  "use strict";

  const state = {
    platform: null,
    accountType: "demo",
    config: null,
    status: null,
    trades: [],
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
    if (state.poll) clearInterval(state.poll);
    state.poll = setInterval(tick, 5000);
  }

  async function tick() {
    if ($("#dashboard").classList.contains("hidden")) return;
    state.historyTick++;
    try {
      await refreshStatus();
      if (state.historyTick % 2 === 0) await loadHistory();
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
    $("#daily-count").textContent = s.today_trades;

    const platformName = s.platform === "mt5" ? "MT5" : "ExpertOption";
    $("#mode-chip").textContent = s.account_type.toUpperCase() + " · " + platformName;
    $("#account-label").textContent = (s.account_login || "").replace(/.(?=.{3})/g, "•");
    $("#last-scan").textContent = s.last_scan_at
      ? t("status.lastScan") + ": " + fmtTime(s.last_scan_at)
      : t("status.never");

    const pill = $("#conn-pill");
    const ok = s.broker_connected && s.account_synced;
    pill.className = "status-pill " + (ok ? "ok" : "bad");
    pill.innerHTML = "<i></i><span>" + (ok ? t("dash.marketOk") : t("status.disconnected")) + "</span>";

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

    renderOpportunities(s.opportunities || []);
    renderOpenTrades(s.open_trades || []);
    $("#scan-hint").textContent = s.scan_count ? t("status.scans") + " " + s.scan_count : t("dash.scanning");
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

  function renderOpenTrades(list) {
    const box = $("#open-positions");
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
