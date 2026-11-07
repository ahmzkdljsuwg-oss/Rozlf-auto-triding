'use strict';

const { getSpeedPreset } = require('./speed');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TelegramBotController {
  constructor({ notifier, engine }) {
    this.notifier = notifier;
    this.engine = engine;
    this.offset = 0;
    this.running = false;
    this._loopPromise = null;
    this._lastError = '';
  }

  get enabled() {
    return Boolean(this.notifier && this.notifier.enabled);
  }

  async start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this._loopPromise = this._loop();
  }

  async stop() {
    this.running = false;
    if (this.notifier) {
      try { await this.notifier.api('getUpdates', { offset: this.offset, timeout: 0 }, 5000); } catch { /* ignore */ }
    }
  }

  async _loop() {
    while (this.running) {
      let response;
      try {
        response = await this.notifier.api('getUpdates', {
          offset: this.offset,
          timeout: 20,
          allowed_updates: ['message', 'callback_query'],
        }, 30000);
      } catch (err) {
        response = { ok: false, error: err.message };
      }
      if (!this.running) break;
      if (!response.ok) {
        if (response.error !== this._lastError) {
          this._lastError = response.error;
          await this.engine.db.addLog('warn', 'telegram', `Telegram polling failed: ${response.error}`).catch(() => {});
        }
        await sleep(5000);
        continue;
      }
      this._lastError = '';
      const updates = Array.isArray(response.result) ? response.result : [];
      for (const update of updates) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        try { await this._handle(update); } catch (err) {
          await this.engine.db.addLog('warn', 'telegram', `Telegram update failed: ${err.message}`).catch(() => {});
        }
      }
      if (!updates.length) await sleep(300);
    }
  }

  _authorized(chatId) {
    return chatId !== undefined && String(chatId) === String(this.notifier.chatId);
  }

  async _handle(update) {
    if (update.callback_query) {
      const query = update.callback_query;
      const chatId = query.message && query.message.chat ? query.message.chat.id : null;
      if (!this._authorized(chatId)) {
        await this.notifier.api('answerCallbackQuery', {
          callback_query_id: query.id, text: 'غير مصرح', show_alert: true,
        });
        return;
      }
      const data = String(query.data || '');
      const match = /^speed:(slow|medium|fast)$/.exec(data);
      if (!match) {
        await this.notifier.api('answerCallbackQuery', {
          callback_query_id: query.id, text: 'خيار غير معروف', show_alert: false,
        });
        return;
      }
      const mode = match[1];
      await this.engine.setSpeed(mode, { source: 'telegram', notify: false });
      const preset = getSpeedPreset(mode);
      await this.notifier.api('answerCallbackQuery', {
        callback_query_id: query.id,
        text: `تم تفعيل الوضع ${preset.label_ar}`,
        show_alert: false,
      });
      if (query.message) {
        await this.notifier.api('editMessageText', {
          chat_id: chatId,
          message_id: query.message.message_id,
          text: `✅ <b>تم تغيير سرعة التداول</b>\nالوضع الحالي: ${preset.icon} <b>${preset.label_ar}</b>\nتم تحديث وضع التداول في الموقع أيضاً.`,
          parse_mode: 'HTML',
          reply_markup: this.notifier.speedKeyboard(),
        });
      }
      return;
    }

    const message = update.message;
    if (!message || !this._authorized(message.chat && message.chat.id)) return;
    const text = String(message.text || '').trim().toLowerCase();
    if (text === '/speed') {
      await this.notifier.sendSpeedMenu(this.engine.speed);
      return;
    }
    if (text === '/status') {
      const status = await this.engine.status();
      const labels = { slow: 'بطيء', medium: 'متوسط', fast: 'سريع' };
      await this.notifier.sendMessage([
        '📊 <b>ROZLF AUTO TRADER</b>',
        `الحساب: ${status.account_login || '—'} (${String(status.account_type || '').toUpperCase()})`,
        `الاتصال: ${status.account_status === 'connected' ? 'متصل' : 'غير متصل'}`,
        `البوت: ${status.running ? 'يعمل' : 'متوقف'}`,
        `سرعة التداول: ${labels[status.speed] || status.speed}`,
        `الرصيد: ${Number(status.balance || 0).toFixed(2)} ${status.currency || 'USD'}`,
        `صفقات مفتوحة: ${status.open_trades.length}`,
      ].join('\n'), this.notifier.speedKeyboard());
      return;
    }
    if (text === '/start' || text === '/help') {
      await this.notifier.sendMessage([
        '🤖 <b>ROZLF AUTO TRADER</b>',
        'الأوامر المتاحة:',
        '/speed — اختيار سرعة التداول',
        '/status — حالة الحساب والبوت',
        '',
        'التداول الحقيقي معطّل. لا تُنشأ صفقة على الموقع قبل تأكيد MT5 لها.',
      ].join('\n'), this.notifier.speedKeyboard());
    }
  }
}

module.exports = { TelegramBotController };
