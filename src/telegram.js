'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

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
  constructor(token = config.TELEGRAM_BOT_TOKEN, chatId = config.TELEGRAM_CHAT_ID) {
    this.token = token;
    this.chatId = chatId;
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async api(method, payload) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        return { ok: false, error: String(data.description || `HTTP ${response.status}`).slice(0, 180) };
      }
      return { ok: true, result: data.result };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 180) };
    }
  }

  async sendMessage(text) {
    const result = await this.api('sendMessage', {
      chat_id: this.chatId, text: String(text).slice(0, 4000),
      parse_mode: 'HTML', disable_web_page_preview: true,
    });
    return result;
  }

  async sendPhoto(filePath, caption) {
    if (!this.enabled) return { ok: false, error: 'Telegram is not configured' };
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Chart file not found' };
    const url = `https://api.telegram.org/bot${this.token}/sendPhoto`;
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
      return { ok: false, error: String(err.message).slice(0, 180) };
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

  async notifyError(message) {
    return this.sendMessage(`⚠️ <b>ROZLF AUTO TRADER</b>\n${escapeHtml(message).slice(0, 3500)}`);
  }
}

module.exports = { TelegramNotifier, humanDuration, escapeHtml };
