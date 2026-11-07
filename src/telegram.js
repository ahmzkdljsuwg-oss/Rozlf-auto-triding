'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function timedOutText(err) {
  const name = err && err.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'Telegram request timed out' : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function humanDuration(startIso, endIso = null) {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

class TelegramNotifier {
  constructor(
    token = config.TELEGRAM_BOT_TOKEN,
    chatId = config.TELEGRAM_CHAT_ID,
    apiBase = config.TELEGRAM_API_BASE,
  ) {
    this.token = token;
    this.chatId = chatId;
    this.apiBase = String(apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  get tokenConfigured() {
    return Boolean(this.token);
  }

  _url(method) {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  _netError(err) {
    const name = err && err.name;
    const message = timedOutText(err) || String((err && err.message) || err);
    return {
      ok: false,
      error: message,
      error_code: 0,
      network: true,
      timeout: name === 'TimeoutError' || name === 'AbortError',
    };
  }

  // Retries once on 429 (honouring retry_after) and reports 409/401 distinctly so
  // the polling loop can act on a webhook conflict or a revoked token.
  async api(method, payload, timeoutMs = 20000, attempt = 0) {
    if (!this.tokenConfigured) return { ok: false, error: 'Telegram bot token is not configured', error_code: 0 };
    try {
      const response = await fetch(this._url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const code = Number(data.error_code || response.status || 0);
        if (code === 429 && attempt < 1) {
          const waitMs = Math.min(5000, Math.max(500, Number(data.parameters && data.parameters.retry_after || 2) * 1000));
          await new Promise((r) => setTimeout(r, waitMs));
          return this.api(method, payload, timeoutMs, attempt + 1);
        }
        return {
          ok: false,
          error: String(data.description || `HTTP ${response.status}`).slice(0, 180),
          error_code: code,
          retry_after: data.parameters ? data.parameters.retry_after || null : null,
          webhook_conflict: code === 409,
          unauthorized: code === 401 || code === 404,
        };
      }
      return { ok: true, result: data.result };
    } catch (err) {
      return this._netError(err);
    }
  }

  async getMe() {
    const res = await this.api('getMe', {}, 15000);
    if (!res.ok) return res;
    return { ok: true, result: res.result, username: res.result && res.result.username };
  }

  async getWebhookInfo() {
    return this.api('getWebhookInfo', {}, 15000);
  }

  async deleteWebhook() {
    return this.api('deleteWebhook', { drop_pending_updates: false }, 15000);
  }

  async getChat() {
    if (!this.chatId) return { ok: false, error: 'TELEGRAM_CHAT_ID is not configured' };
    const res = await this.api('getChat', { chat_id: this.chatId }, 15000);
    if (!res.ok) return res;
    const chat = res.result || {};
    return { ok: true, result: chat, title: chat.title || chat.username || chat.first_name || '' };
  }

  async sendMessage(text, replyMarkup = null) {
    const payload = {
      chat_id: this.chatId, text: String(text).slice(0, 4000),
      parse_mode: 'HTML', disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    return this.api('sendMessage', payload);
  }

  speedKeyboard() {
    return {
      inline_keyboard: [[
        { text: '🐢 بطيء', callback_data: 'speed:slow' },
        { text: '⚖️ متوسط', callback_data: 'speed:medium' },
        { text: '⚡ سريع', callback_data: 'speed:fast' },
      ]],
    };
  }

  async sendSpeedMenu(current = 'medium') {
    const labels = { slow: '🐢 بطيء', medium: '⚖️ متوسط', fast: '⚡ سريع' };
    return this.sendMessage(
      `⚙️ <b>سرعة التداول</b>\nالوضع الحالي: <b>${labels[current] || current}</b>\nاختر الوضع المناسب:`,
      this.speedKeyboard(),
    );
  }

  mainKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '📊 ExpertOption — تحليل تلقائي', callback_data: 'menu:eo' }],
        [{ text: '▶️ التداول — MT5', callback_data: 'menu:trade' }],
        [{ text: '🔔 الإشعارات', callback_data: 'menu:notify' }, { text: '⚙️ الإعدادات', callback_data: 'menu:settings' }],
        [{ text: '📈 الحالة', callback_data: 'action:status' }],
      ],
    };
  }

  async notifyBotStarted({ accountType, login, server, speed, executionMode, connected, platform, tradingMode }) {
    const labels = { slow: '🐢 بطيء', medium: '⚖️ متوسط', fast: '⚡ سريع' };
    const platformLabel = platform === 'expertoption' ? 'ExpertOption' : 'MT5';
    const modeLabel = executionMode === 'analysis_only'
      ? 'تحليل وتنبيهات فقط — لا تنفيذ'
      : executionMode === 'simulated'
        ? 'تنفيذ محاكى (DEMO) — ليست صفقات MT5 حقيقية'
        : 'تنفيذ MT5 عبر الجسر';
    const text = [
      '🟢 <b>تم بدء التحليل بنجاح</b>',
      `• حالة الاتصال: ${connected ? 'متصل' : 'غير متصل'}`,
      `• الحساب: ${platformLabel} ${escapeHtml(accountType === 'demo' ? 'Demo' : accountType === 'real' ? 'Real' : 'Demo')} ${escapeHtml(login || '')}${server ? ` — ${escapeHtml(server)}` : ''}`,
      `• سرعة التداول: ${labels[speed] || escapeHtml(speed)}`,
      `• وضع التشغيل: ${escapeHtml(tradingMode || 'demo')}`,
      `• حالة السوق: ${connected ? 'جاري المراقبة' : 'بانتظار الاتصال'}`,
      `• ${modeLabel}`,
      '',
      'تحكم كامل من الأزرار أدناه.',
    ].join('\n');
    return this.sendMessage(text, this.mainKeyboard());
  }

  async notifySpeedChanged(speed) {
    const labels = { slow: '🐢 بطيء', medium: '⚖️ متوسط', fast: '⚡ سريع' };
    return this.sendMessage(
      `✅ <b>تم تغيير سرعة التداول</b>\nالوضع الحالي: <b>${labels[speed] || escapeHtml(speed)}</b>`,
      this.speedKeyboard(),
    );
  }

  async notifyOpportunity(signal, spreadPips) {
    return this.sendMessage([
      `👀 <b>فرصة مرشحة — ${escapeHtml(signal.symbol)} ${escapeHtml(signal.timeframe)}</b>`,
      `الاتجاه: <b>${escapeHtml(signal.side)}</b> | الثقة: ${Math.round(Number(signal.confidence || 0) * 100)}%`,
      `الدخول: <code>${escapeHtml(signal.entry)}</code> | SL: <code>${escapeHtml(signal.stop_loss)}</code> | TP: <code>${escapeHtml(signal.take_profit)}</code>`,
      `السبريد: ${Number(spreadPips || 0).toFixed(2)} نقطة`,
      `السبب: ${escapeHtml(signal.reason_ar || signal.reason_en || '')}`,
      'الحالة: قيد التحقق قبل التنفيذ',
    ].join('\n'));
  }

  async notifyExecutionFailure(signal, reason) {
    return this.sendMessage([
      `⛔ <b>فشل تنفيذ الصفقة — ${escapeHtml(signal.symbol)} ${escapeHtml(signal.side)}</b>`,
      `السبب: ${escapeHtml(reason)}`,
      'لم يتم تسجيل أي صفقة على الموقع لأن MT5 لم يؤكد التنفيذ.',
    ].join('\n'));
  }

  async sendPhoto(filePath, caption) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Chart file not found' };
    const url = this._url('sendPhoto');
    try {
      const buffer = await fs.promises.readFile(filePath);
      const form = new FormData();
      form.append('chat_id', String(this.chatId));
      form.append('caption', String(caption).slice(0, 1024));
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([buffer], { type: 'image/png' }), path.basename(filePath));
      const response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        return { ok: false, error: String(data.description || `HTTP ${response.status}`).slice(0, 180) };
      }
      return { ok: true };
    } catch (err) {
      return this._netError(err);
    }
  }

  async notifyOpen(trade, chartPath) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    const lines = [
      `<b>${escapeHtml(trade.symbol)} ${escapeHtml(trade.timeframe)} — ${escapeHtml(trade.side)}</b>`,
      `Platform: ${escapeHtml(trade.platform)} (${escapeHtml(trade.account_type || 'demo')})`,
      `Entry: <code>${escapeHtml(trade.entry_price)}</code>`,
      `Stop loss: <code>${escapeHtml(trade.stop_loss)}</code>`,
      `Take profit: <code>${escapeHtml(trade.take_profit)}</code>`,
      `Lot: ${escapeHtml(trade.lot)} | Risk: $${escapeHtml(trade.risk_amount)}`,
      `Confidence: ${Math.round(Number(trade.confidence || 0) * 100)}%`,
      `Reason: ${escapeHtml(trade.reason || '')}`,
      `Opened: ${escapeHtml(trade.opened_at)} UTC`,
      '#ROZLF #TradeOpen',
    ];
    return this.sendPhoto(chartPath, lines.join('\n'));
  }

  async notifyUpdate(trade, changes = {}) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    const lines = [
      `<b>ROZLF — position updated: ${escapeHtml(trade.symbol)} ${escapeHtml(trade.side)}</b>`,
      `Ticket: <code>${escapeHtml(trade.broker_order_id || '')}</code>`,
      `Entry: <code>${escapeHtml(trade.entry_price)}</code> | Current: <code>${escapeHtml(changes.current_price ?? trade.current_price ?? '')}</code>`,
      `Stop loss: <code>${escapeHtml(trade.stop_loss)}</code> → <code>${escapeHtml(changes.stop_loss ?? trade.stop_loss)}</code>`,
      `Take profit: <code>${escapeHtml(trade.take_profit)}</code> → <code>${escapeHtml(changes.take_profit ?? trade.take_profit)}</code>`,
      `Unrealized P/L: <b>${Number(changes.unrealized_pnl ?? trade.unrealized_pnl ?? 0).toFixed(2)}</b>`,
      'Source: MetaTrader 5 (synced)',
      '#ROZLF #TradeUpdate',
    ];
    return this.sendMessage(lines.join('\n'));
  }

  async notifyImported(trade, chartPath) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    const lines = [
      `<b>ROZLF — MT5 position detected: ${escapeHtml(trade.symbol)} ${escapeHtml(trade.side)}</b>`,
      `Ticket: <code>${escapeHtml(trade.broker_order_id || '')}</code> | Lot: ${escapeHtml(trade.lot)}`,
      `Entry: <code>${escapeHtml(trade.entry_price)}</code>`,
      `Stop loss: <code>${escapeHtml(trade.stop_loss)}</code> | Take profit: <code>${escapeHtml(trade.take_profit)}</code>`,
      'This position was opened outside the site and imported from MetaTrader 5.',
      '#ROZLF #MT5Sync',
    ];
    if (chartPath) return this.sendPhoto(chartPath, lines.join('\n'));
    return this.sendMessage(lines.join('\n'));
  }

  async notifyClose(trade, chartPath) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    const pnl = Number(trade.pnl || 0);
    const icon = trade.result === 'WIN' ? '✅' : '❌';
    const lines = [
      `${icon} <b>${escapeHtml(trade.result)} ${escapeHtml(trade.symbol)} ${escapeHtml(trade.timeframe)} ${escapeHtml(trade.side)}</b>`,
      `Net P/L: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>`,
      `Entry: <code>${escapeHtml(trade.entry_price)}</code> → Exit: <code>${escapeHtml(trade.close_price)}</code>`,
      `Stop loss: ${escapeHtml(trade.stop_loss)} | Take profit: ${escapeHtml(trade.take_profit)}`,
      `Lot: ${escapeHtml(trade.lot)}`,
      `Duration: ${escapeHtml(humanDuration(trade.opened_at, trade.closed_at))}`,
      `Closed: ${escapeHtml(trade.closed_at)} UTC`,
      '#ROZLF #TradeClosed',
    ];
    if (chartPath) return this.sendPhoto(chartPath, lines.join('\n'));
    return this.sendMessage(lines.join('\n'));
  }

  async notifyDailyReport(stats) {
    const pnl = Number(stats.today_pnl ?? stats.total_pnl ?? 0);
    const lines = [
      '📊 <b>تقرير الأداء اليومي — ROZLF</b>',
      `الرصيد: <b>${Number(stats.balance || 0).toFixed(2)} ${escapeHtml(stats.currency || 'USD')}</b>`,
      `صفقات اليوم: <b>${Number(stats.today || 0)}</b> | المفتوحة: ${Number(stats.open || 0)}`,
      `ربح/خسارة اليوم: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</b>`,
      `إجمالي الصفقات المغلقة: ${Number(stats.total || 0)}`,
      `نسبة النجاح: ${Number(stats.win_rate || 0)}% (${Number(stats.wins || 0)} ربح / ${Number(stats.losses || 0)} خسارة)`,
      `الوضع: ${escapeHtml(stats.mode || 'demo')} | السرعة: ${escapeHtml(stats.speed || 'medium')}`,
      '#ROZLF #DailyReport',
    ];
    return this.sendMessage(lines.join('\n'), this.mainKeyboard());
  }

  async sendExpertOptionAnalysis(result, { source = 'site' } = {}) {
    const labels = { UP: 'UP — صعود ⬆️', DOWN: 'DOWN — هبوط ⬇️', 'NO TRADE': 'NO TRADE — لا توجد فرصة واضحة ⏸️' };
    const asset = result.asset || {};
    const ind = result.indicators || {};
    const sr = result.support_resistance || {};
    const lines = [
      '🟦 <b>ROZLF AUTO TRADER — تحليل ExpertOption</b>',
      `<b>الأصل:</b> ${escapeHtml(asset.name || result.asset_id || '—')}${asset.otc ? ' (OTC)' : ''}`,
      `<b>المدة:</b> ${escapeHtml(result.expiry_label_ar || result.expiry || '—')}`,
      `<b>النتيجة:</b> ${labels[result.direction] || labels['NO TRADE']}`,
      `<b>السعر الحالي:</b> ${escapeHtml(result.price ?? '—')}`,
      `<b>آخر تحديث للبيانات:</b> ${escapeHtml(result.price_time || '—')}`,
      `<b>الاتجاه:</b> ${escapeHtml(result.trend || '—')}`,
      `<b>الثقة التقديرية:</b> ${Math.round(Number(result.confidence || 0) * 100)}%`,
      '',
      '<b>المؤشرات</b>',
      `RSI: ${escapeHtml(ind.rsi ?? '—')} | MACD: ${escapeHtml(ind.macd ?? '—')} (hist ${escapeHtml(ind.macd_hist ?? '—')})`,
      `EMA20/50/200: ${escapeHtml(ind.ema20 ?? '—')} / ${escapeHtml(ind.ema50 ?? '—')} / ${escapeHtml(ind.ema200 ?? '—')}`,
      `ADX: ${escapeHtml(ind.adx ?? '—')} | ATR: ${escapeHtml(ind.atr ?? '—')}`,
      `الدعم: ${escapeHtml(sr.support ?? '—')} | المقاومة: ${escapeHtml(sr.resistance ?? '—')}`,
    ];
    const reasons = Array.isArray(result.reasons_ar) ? result.reasons_ar.slice(0, 6) : [];
    if (reasons.length) {
      lines.push('', '<b>سبب القرار</b>', ...reasons.map((r) => `• ${escapeHtml(r)}`));
    }
    lines.push('', '⚠️ تحليل فقط — لا يتم تنفيذ أي صفقة. لا يوجد ضمان للربح.', `المصدر: ${source === 'telegram' ? 'Telegram' : 'الموقع'}`);
    const text = lines.join('\n');
    if (result.chart_path) {
      const caption = [
        '🟦 <b>ROZLF AUTO TRADER</b>',
        `${escapeHtml(asset.name || result.asset_id || '—')} · ${escapeHtml(result.timeframe || '')} · ${escapeHtml(result.expiry_label_ar || result.expiry || '')}`,
        `${labels[result.direction] || labels['NO TRADE']} · ${Math.round(Number(result.confidence || 0) * 100)}%`,
        `السعر: ${escapeHtml(result.live_price ?? result.price ?? '—')}`,
      ].join('\n');
      const photo = await this.sendPhoto(result.chart_path, caption);
      if (photo.ok) return this.sendMessage(text);
    }
    return this.sendMessage(text);
  }

  async sendExpertOptionNoTrade(result, { source = 'site' } = {}) {
    const reason = result.reason_ar || result.detail_ar || result.detail || 'لا توجد فرصة واضحة في هذه اللحظة.';
    return this.sendMessage([
      '🟦 <b>ROZLF AUTO TRADER — تحليل ExpertOption</b>',
      '<b>النتيجة:</b> NO TRADE — لا توجد فرصة واضحة ⏸️',
      `<b>السبب:</b> ${escapeHtml(reason)}`,
      '',
      '⚠️ تحليل فقط — لم يتم تنفيذ أي صفقة.',
      `المصدر: ${source === 'telegram' ? 'Telegram' : 'الموقع'}`,
    ].join('\n'));
  }

  async notifyError(message) {
    return this.sendMessage(`⚠️ <b>ROZLF AUTO TRADER</b>\n${escapeHtml(message).slice(0, 3500)}`);
  }
}

module.exports = { TelegramNotifier, humanDuration, escapeHtml };
