'use strict';

const config = require('./config');
const { getSpeedPreset } = require('./speed');
const settingsUtil = require('./settings');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPEED_LABELS = { slow: '🐢 بطيء', medium: '⚖️ متوسط', fast: '⚡ سريع' };
const SETTING_LABELS = {
  risk_percent: 'نسبة المخاطرة لكل صفقة (%)',
  daily_loss_limit_percent: 'حد الخسارة اليومي (%)',
  max_open_trades: 'أقصى عدد صفقات مفتوحة',
  max_daily_trades: 'أقصى عدد صفقات يومياً',
  min_confidence: 'أدنى قوة إشارة (0.5 - 0.95)',
  max_spread_pips: 'أقصى سبريد مسموح (نقطة)',
  stop_loss_pips: 'وقف الخسارة (نقطة، 0 = تلقائي)',
  take_profit_pips: 'الهدف (نقطة، 0 = تلقائي)',
};

class TelegramBotController {
  constructor({ notifier, engine }) {
    this.notifier = notifier;
    this.engine = engine;
    this.offset = 0;
    this.running = false;
    this._loopPromise = null;
    this._lastError = '';
    this._pending = new Map();
    this.eoSelection = new Map();
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
          offset: this.offset, timeout: 20, allowed_updates: ['message', 'callback_query'],
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

  async _answer(query, text, alert = false) {
    await this.notifier.api('answerCallbackQuery', {
      callback_query_id: query.id, text, show_alert: alert,
    });
  }

  async _edit(query, text, keyboard) {
    if (!query.message) return;
    await this.notifier.api('editMessageText', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }


  expertOptionAssetsKeyboard() {
    const assets = [
      ['ai-index','🤖 AI Index'], ['cricket-index','🏏 Cricket Index'], ['stock','📈 سهم'],
      ['eurusd-otc','🇪🇺 EUR / USD (OTC)'], ['usdjpy-otc','🇯🇵 USD / JPY (OTC)'],
      ['gbpusd-otc','🇬🇧 GBP / USD (OTC)'], ['football-index','⚽ Football Index'],
      ['luxury-index','💎 Luxury Index'], ['smarty','🧠 Smarty'], ['usdchf-otc','🇨🇭 USD / CHF (OTC)'],
      ['silver-otc','🥈 Silver (OTC)'], ['nzdusd-otc','🇳🇿 NZD / USD (OTC)'],
    ];
    return { inline_keyboard: assets.map(([id,label]) => [{ text: label, callback_data: `eoasset:${id}` }]).concat([[{ text: '🕘 آخر التوصيات', callback_data: 'action:eo_latest' }, { text: '⚙️ إعدادات التحليل', callback_data: 'menu:eo_settings' }],[{ text: '🔔 الإشعارات', callback_data: 'menu:notify' }],[{ text: '↩️ القائمة', callback_data: 'menu:main' }]]) };
  }

  expertOptionExpiryKeyboard() {
    return { inline_keyboard: [[
      { text: '30 ثانية', callback_data: 'eoexpiry:30s' },
      { text: '1 دقيقة', callback_data: 'eoexpiry:1m' },
    ], [
      { text: 'دقيقتان', callback_data: 'eoexpiry:2m' },
      { text: '3 دقائق', callback_data: 'eoexpiry:3m' },
      { text: '5 دقائق', callback_data: 'eoexpiry:5m' },
    ], [{ text: '↩️ الأصول', callback_data: 'menu:eo' }]] };
  }

  tradeKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '▶️ تشغيل البوت', callback_data: 'action:start' }, { text: '⏹ إيقاف', callback_data: 'action:stop' }],
        [{ text: '🛑 إيقاف طارئ', callback_data: 'confirm:emergency' }],
        [{ text: '🔒 إغلاق كل الصفقات', callback_data: 'confirm:closeall' }],
        [{ text: '🔍 تحليل فقط', callback_data: 'mode:analysis' }, { text: '🧪 تداول Demo', callback_data: 'mode:demo' }],
        [{ text: '🧭 الوضع الحالي', callback_data: 'action:status' }, { text: '↩️ القائمة', callback_data: 'menu:main' }],
      ],
    };
  }

  settingsKeyboard() {
    const rows = Object.keys(SETTING_LABELS).map((key) => ([
      { text: SETTING_LABELS[key], callback_data: `set:${key}` },
    ]));
    rows.push([
      { text: '💱 الأزواج', callback_data: 'menu:symbols' },
      { text: '⏱ الفريم', callback_data: 'menu:timeframes' },
    ]);
    rows.push([{ text: '↩️ القائمة', callback_data: 'menu:main' }]);
    return { inline_keyboard: rows };
  }

  analysisKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '🔎 تحليل الآن', callback_data: 'action:analyze' }, { text: '🏆 أفضل الفرص', callback_data: 'action:opportunities' }],
        [{ text: '🖼 شارت التحليل', callback_data: 'action:chart' }, { text: '📌 سبب الإشارة', callback_data: 'action:reason' }],
        [{ text: '📂 الصفقات المفتوحة', callback_data: 'action:open' }, { text: '🧾 سجل الصفقات', callback_data: 'action:history' }],
        [{ text: '💰 الأرباح والخسائر', callback_data: 'action:pnl' }, { text: '🏦 الرصيد والهامش', callback_data: 'action:account' }],
        [{ text: '↩️ القائمة', callback_data: 'menu:main' }],
      ],
    };
  }

  notifyKeyboard() {
    const labels = {
      bot_started: 'بدء التحليل', opportunity: 'فرصة جديدة', trade_open: 'فتح صفقة',
      trade_close: 'إغلاق صفقة', charts: 'صور الشارت', daily_report: 'التقرير اليومي',
    };
    const rows = settingsUtil.NOTIFICATION_KEYS.map((key) => {
      const on = this.engine.notifications[key] !== false;
      return [{ text: `${on ? '✅' : '⬜'} ${labels[key]}`, callback_data: `toggle:${key}` }];
    });
    rows.push([{ text: '↩️ القائمة', callback_data: 'menu:main' }]);
    return { inline_keyboard: rows };
  }

  symbolsKeyboard() {
    const rows = config.SYMBOLS.map((symbol) => {
      const on = this.engine.symbols.includes(symbol);
      return [{ text: `${on ? '✅' : '⬜'} ${symbol}`, callback_data: `symbol:${symbol}` }];
    });
    rows.push([{ text: '↩️ رجوع', callback_data: 'menu:settings' }]);
    return { inline_keyboard: rows };
  }

  timeframeKeyboard() {
    const rows = config.TIMEFRAMES.map((tf) => ([{
      text: `${this.engine.timeframe === tf ? '✅' : '⬜'} ${tf}`, callback_data: `tf:${tf}`,
    }]));
    rows.push([{ text: '↩️ رجوع', callback_data: 'menu:settings' }]);
    return { inline_keyboard: rows };
  }

  async _handleCallback(query) {
    const chatId = query.message && query.message.chat ? query.message.chat.id : null;
    if (!this._authorized(chatId)) return this._answer(query, 'غير مصرح', true);
    const data = String(query.data || '');
    const engine = this.engine;

    if (data === 'menu:main') {
      await this._answer(query, 'القائمة الرئيسية');
      return this._edit(query, '🤖 <b>ROZLF AUTO TRADER — لوحة التحكم</b>\nاختر قسمًا:', this.notifier.mainKeyboard());
    }
    if (data === 'menu:eo') {
      await this._answer(query, 'اختر أصل ExpertOption');
      return this._edit(query, '📊 <b>ExpertOption — التحليل فقط</b>\nاختر الأصل ثم مدة التحليل. لا يتم تنفيذ صفقات.', this.expertOptionAssetsKeyboard());
    }
    if (data === 'menu:eo_settings') {
      const enabled = await engine.db.getSetting('telegram.expertoption_notifications', true);
      const keyboard = { inline_keyboard: [[{ text: `${enabled ? '✅' : '⬜'} إشعارات توصيات ExpertOption`, callback_data: 'eo:toggle_notifications' }],[{ text: '↩️ رجوع', callback_data: 'menu:eo' }]] };
      await this._answer(query, 'إعدادات التحليل');
      return this._edit(query, '⚙️ <b>إعدادات ExpertOption</b>\nتحكم في وصول التوصيات إلى Telegram.', keyboard);
    }
    if (data === 'action:eo_latest') {
      await this._answer(query, 'آخر التوصيات');
      return this._edit(query, '🕘 <b>آخر توصيات ExpertOption</b>\nلا توجد توصيات موثقة محفوظة حتى الآن. لن نعرض إشارة من دون بيانات سوق حقيقية.', this.expertOptionAssetsKeyboard());
    }
    if (data === 'eo:toggle_notifications') {
      const current = await engine.db.getSetting('telegram.expertoption_notifications', true);
      const enabled = !current;
      await engine.db.setSetting('telegram.expertoption_notifications', enabled);
      const keyboard = { inline_keyboard: [[{ text: `${enabled ? '✅' : '⬜'} إشعارات توصيات ExpertOption`, callback_data: 'eo:toggle_notifications' }],[{ text: '↩️ رجوع', callback_data: 'menu:eo' }]] };
      await this._answer(query, enabled ? 'تم تفعيل إشعارات التوصيات' : 'تم إيقاف إشعارات التوصيات');
      return this._edit(query, '⚙️ <b>إعدادات ExpertOption</b>', keyboard);
    }
    if (data === 'menu:trade') {
      await this._answer(query, 'التداول');
      return this._edit(query, '▶️ <b>التحكم في التداول</b>\nكل الأوامر تُنفَّذ فعلياً وتُحفظ.', this.tradeKeyboard());
    }
    if (data === 'menu:settings') {
      await this._answer(query, 'الإعدادات');
      return this._edit(query, '⚙️ <b>إعدادات الصفقات والمخاطر</b>\nاضغط إعداداً لتغيير قيمته.', this.settingsKeyboard());
    }
    if (data === 'menu:analysis') {
      await this._answer(query, 'التحليل');
      return this._edit(query, '📊 <b>التحليل والمراقبة</b>', this.analysisKeyboard());
    }
    if (data === 'menu:notify') {
      await this._answer(query, 'الإشعارات');
      return this._edit(query, '🔔 <b>إدارة الإشعارات</b>', this.notifyKeyboard());
    }
    if (data === 'menu:speed') {
      await this._answer(query, 'السرعة');
      return this._edit(query, '⚡ <b>سرعة التداول</b>', this.notifier.speedKeyboard());
    }
    if (data === 'menu:symbols') {
      await this._answer(query, 'الأزواج');
      return this._edit(query, '💱 <b>اختيار الأزواج</b>', this.symbolsKeyboard());
    }
    if (data === 'menu:timeframes') {
      await this._answer(query, 'الفريم');
      return this._edit(query, '⏱ <b>اختيار الفريم</b>', this.timeframeKeyboard());
    }

    const eoAsset = /^eoasset:([a-z0-9-]+)$/.exec(data);
    if (eoAsset) {
      const allowed = new Set(['ai-index','cricket-index','stock','eurusd-otc','usdjpy-otc','gbpusd-otc','football-index','luxury-index','smarty','usdchf-otc','silver-otc','nzdusd-otc']);
      if (!allowed.has(eoAsset[1])) return this._answer(query, 'أصل غير معروف', true);
      this.eoSelection.set(String(chatId), { asset: eoAsset[1] });
      await this._answer(query, 'تم اختيار الأصل');
      return this._edit(query, '⏱ <b>اختر مدة التحليل</b>', this.expertOptionExpiryKeyboard());
    }
    const eoExpiry = /^eoexpiry:(30s|1m|2m|3m|5m)$/.exec(data);
    if (eoExpiry) {
      const selection = this.eoSelection.get(String(chatId));
      if (!selection) return this._answer(query, 'اختر الأصل أولاً', true);
      selection.expiry = eoExpiry[1];
      const labels = { '30s':'30 ثانية','1m':'دقيقة','2m':'دقيقتان','3m':'3 دقائق','5m':'5 دقائق' };
      const assetLabels = { 'ai-index':'AI Index','cricket-index':'Cricket Index','stock':'سهم','eurusd-otc':'EUR / USD (OTC)','usdjpy-otc':'USD / JPY (OTC)','gbpusd-otc':'GBP / USD (OTC)','football-index':'Football Index','luxury-index':'Luxury Index','smarty':'Smarty','usdchf-otc':'USD / CHF (OTC)','silver-otc':'Silver (OTC)','nzdusd-otc':'NZD / USD (OTC)' };
      await this._answer(query, 'تم اختيار المدة');
      return this._edit(query, `🔎 <b>طلب التحليل</b>\nالأصل: ${assetLabels[selection.asset]}\nالمدة: ${labels[selection.expiry]}\n\nلا توجد حالياً واجهة بيانات سوق موثقة ومصرح بها من ExpertOption لقراءة هذا الأصل. لم أصدر شراء أو بيع حتى لا أخمّن السعر.`, this.expertOptionAssetsKeyboard());
    }

    const speed = /^speed:(slow|medium|fast)$/.exec(data);
    if (speed) {
      await engine.setSpeed(speed[1], { source: 'telegram', notify: false });
      const preset = getSpeedPreset(speed[1]);
      await this._answer(query, `تم تفعيل الوضع ${preset.label_ar}`);
      return this._edit(query,
        `✅ <b>تم تغيير سرعة التداول</b>\nالوضع الحالي: ${preset.icon} <b>${preset.label_ar}</b>\nتم تحديث وضع التداول في الموقع أيضاً.`,
        this.notifier.speedKeyboard());
    }

    const toggle = /^toggle:(bot_started|opportunity|trade_open|trade_close|charts|daily_report)$/.exec(data);
    if (toggle) {
      const notifications = { ...engine.notifications, [toggle[1]]: !engine.notifications[toggle[1]] };
      await engine.updateSettings({ notifications }, { source: 'telegram' });
      await this._answer(query, 'تم التحديث');
      return this._edit(query, '🔔 <b>إدارة الإشعارات</b>', this.notifyKeyboard());
    }

    const symbol = /^symbol:([A-Z0-9]+)$/.exec(data);
    if (symbol) {
      if (!config.SYMBOLS.includes(symbol[1])) return this._answer(query, 'زوج غير مدعوم', true);
      const next = engine.symbols.includes(symbol[1])
        ? engine.symbols.filter((s) => s !== symbol[1])
        : [...engine.symbols, symbol[1]];
      if (!next.length) return this._answer(query, 'يجب اختيار زوج واحد على الأقل', true);
      try {
        await engine.updateSettings({ symbols: config.SYMBOLS.filter((s) => next.includes(s)) }, { source: 'telegram' });
        await this._answer(query, 'تم التحديث');
        return this._edit(query, '💱 <b>اختيار الأزواج</b>', this.symbolsKeyboard());
      } catch (err) {
        return this._answer(query, err.message, true);
      }
    }

    const timeframe = /^tf:([A-Z0-9]+)$/.exec(data);
    if (timeframe) {
      try {
        await engine.updateSettings({ timeframe: timeframe[1] }, { source: 'telegram' });
        await this._answer(query, 'تم تحديث الفريم');
        return this._edit(query, '⏱ <b>اختيار الفريم</b>', this.timeframeKeyboard());
      } catch (err) {
        return this._answer(query, err.message, true);
      }
    }

    const setting = /^set:(risk_percent|daily_loss_limit_percent|max_open_trades|max_daily_trades|min_confidence|max_spread_pips|stop_loss_pips|take_profit_pips)$/.exec(data);
    if (setting) {
      this._pending.set(String(chatId), setting[1]);
      const current = await engine.getSettings();
      await this._answer(query, 'أرسل القيمة الآن');
      return this._edit(query,
        `✏️ <b>${SETTING_LABELS[setting[1]]}</b>\nأرسل القيمة الجديدة كرقم فقط.\nالقيمة الحالية: <code>${current[setting[1]]}</code>`,
        { inline_keyboard: [[{ text: 'إلغاء', callback_data: 'menu:settings' }]] });
    }

    const mode = /^mode:(analysis|demo|live)$/.exec(data);
    if (mode) {
      try {
        await engine.setTradingMode(mode[1], { source: 'telegram' });
        await this._answer(query, `الوضع: ${mode[1]}`);
        return this._edit(query, `✅ تم تحويل وضع التشغيل إلى <b>${mode[1]}</b>`, this.tradeKeyboard());
      } catch (err) {
        return this._answer(query, err.message, true);
      }
    }

    if (data === 'confirm:closeall') {
      await this._answer(query, 'يجب التأكيد');
      return this._edit(query,
        '⚠️ <b>تأكيد إغلاق كل الصفقات المفتوحة</b>\nسيتم إغلاق الصفقات عبر الوسيط وتسجيل النتائج الفعلية.',
        { inline_keyboard: [
          [{ text: '✅ تأكيد الإغلاق', callback_data: 'action:closeall' }],
          [{ text: '❌ إلغاء', callback_data: 'menu:trade' }],
        ] });
    }
    if (data === 'confirm:emergency') {
      await this._answer(query, 'يجب التأكيد');
      return this._edit(query, '🛑 <b>تأكيد الإيقاف الطارئ</b>\nسيتوقف فتح أي صفقة جديدة فوراً.',
        { inline_keyboard: [
          [{ text: '✅ تأكيد الإيقاف', callback_data: 'action:emergency' }],
          [{ text: '❌ إلغاء', callback_data: 'menu:trade' }],
        ] });
    }

    try {
      switch (data) {
        case 'action:start':
          await engine.start();
          await this._answer(query, 'تم التشغيل');
          return this._edit(query, '🟢 <b>البوت يعمل الآن</b> — جاري المراقبة والتحليل.', this.tradeKeyboard());
        case 'action:stop':
          await engine.stop('telegram');
          await this._answer(query, 'تم الإيقاف');
          return this._edit(query, '⏹ <b>تم إيقاف البوت</b> — لا تُفتح صفقات جديدة.', this.tradeKeyboard());
        case 'action:emergency':
          await engine.emergencyStop();
          await this._answer(query, 'إيقاف طارئ مفعّل', true);
          return this._edit(query, '🛑 <b>تم تفعيل الإيقاف الطارئ</b>', this.tradeKeyboard());
        case 'action:closeall': {
          const result = await engine.closeAllTrades({ confirm: true });
          await this._answer(query, `أُغلقت ${result.closed} صفقة`);
          return this._edit(query,
            `🔒 <b>إغلاق الصفقات</b>\nتم الإغلاق: ${result.closed}\nفشل: ${result.failed}`,
            this.tradeKeyboard());
        }
        case 'action:status': {
          const text = await this.statusText();
          await this._answer(query, 'الحالة');
          return this._edit(query, text, this.notifier.mainKeyboard());
        }
        case 'action:analyze': {
          await this._answer(query, 'جاري التحليل...');
          const result = await engine.analyzeNow();
          return this._edit(query,
            `🔎 <b>اكتمل التحليل</b>\nالفرص المتاحة: ${result.opportunities.length}\nآخر فحص: ${result.last_scan_at || '—'}`,
            this.analysisKeyboard());
        }
        case 'action:opportunities': {
          const text = this.opportunitiesText();
          await this._answer(query, 'أفضل الفرص');
          return this._edit(query, text, this.analysisKeyboard());
        }
        case 'action:reason': {
          const best = engine.opportunities.find((o) => o.side === 'BUY' || o.side === 'SELL');
          await this._answer(query, best ? 'سبب الإشارة' : 'لا توجد إشارة');
          return this._edit(query, best
            ? `📌 <b>${best.symbol} ${best.timeframe} — ${best.side}</b>\n${best.reason_ar || best.reason || ''}`
            : '📌 لا توجد إشارة BUY/SELL حالياً (NO TRADE).', this.analysisKeyboard());
        }
        case 'action:chart': {
          const chart = await engine.latestOpportunityChart();
          await this._answer(query, 'جاري إرسال الشارت...');
          await this.notifier.sendPhoto(chart.path, chart.caption);
          return;
        }
        case 'action:open': {
          const open = await engine.db.openTrades(engine.account ? engine.account.id : 0);
          await this._answer(query, 'الصفقات المفتوحة');
          return this._edit(query, open.length
            ? open.map((t) => `• ${t.symbol} ${t.side} | ${t.entry_price} → ${t.current_price || '—'} | P/L ${Number(t.unrealized_pnl || 0).toFixed(2)}`).join('\n')
            : 'لا توجد صفقات مفتوحة.', this.analysisKeyboard());
        }
        case 'action:history': {
          const trades = await engine.db.recentTrades(10);
          await this._answer(query, 'السجل');
          return this._edit(query, trades.length
            ? trades.map((t) => `• ${t.symbol} ${t.side} ${t.status} ${t.result || ''} ${t.pnl == null ? '' : Number(t.pnl).toFixed(2)}`).join('\n')
            : 'السجل فارغ.', this.analysisKeyboard());
        }
        case 'action:pnl': {
          const stats = await engine.stats();
          await this._answer(query, 'الأداء');
          return this._edit(query,
            `💰 <b>الأداء</b>\nإجمالي P/L: <b>${Number(stats.total_pnl || 0).toFixed(2)}</b>\nاليوم: ${Number(stats.today_pnl || 0).toFixed(2)}\nنسبة النجاح: ${stats.win_rate}%`,
            this.analysisKeyboard());
        }
        case 'action:account': {
          const status = await engine.status();
          await this._answer(query, 'الحساب');
          return this._edit(query, [
            '🏦 <b>بيانات الحساب</b>',
            `الرصيد: <b>${Number(status.balance || 0).toFixed(2)} ${status.currency || 'USD'}</b>`,
            `Equity: ${Number(status.equity || 0).toFixed(2)}`,
            `Free margin: ${Number(status.margin_free || 0).toFixed(2)}`,
            `Used margin: ${Number(status.margin_used || 0).toFixed(2)}`,
            `الحالة: ${status.account_status}`,
          ].join('\n'), this.analysisKeyboard());
        }
        default:
          return this._answer(query, 'خيار غير معروف');
      }
    } catch (err) {
      await this._answer(query, String(err.message).slice(0, 180), true);
    }
  }

  async _handleMessage(message) {
    const text = String(message.text || '').trim();
    const lower = text.toLowerCase();
    const chatId = message.chat && message.chat.id;

    const pending = this._pending.get(String(chatId));
    if (pending && !text.startsWith('/')) {
      this._pending.delete(String(chatId));
      const value = Number(text.replace(',', '.'));
      try {
        await this.engine.updateSettings({ [pending]: value }, { source: 'telegram' });
        await this.notifier.sendMessage(
          `✅ تم تحديث <b>${SETTING_LABELS[pending]}</b> إلى <code>${value}</code>`, this.settingsKeyboard());
      } catch (err) {
        await this.notifier.sendMessage(`⛔ ${err.message}`, this.settingsKeyboard());
      }
      return;
    }

    if (lower === '/speed') return this.notifier.sendSpeedMenu(this.engine.speed);
    if (lower === '/menu') return this.notifier.sendMessage('🤖 <b>لوحة التحكم</b>', this.notifier.mainKeyboard());
    if (lower === '/status') return this.notifier.sendMessage(await this.statusText(), this.notifier.mainKeyboard());
    if (lower === '/stop') {
      await this.engine.stop('telegram');
      return this.notifier.sendMessage('⏹ تم إيقاف البوت.', this.notifier.mainKeyboard());
    }
    if (lower === '/start' || lower === '/help') {
      return this.notifier.sendMessage([
        '🤖 <b>ROZLF AUTO TRADER</b>',
        'ExpertOption للتحليل والإشعارات، وقسم التداول مخصص لـ MT5. اختر القسم من الأزرار أدناه.',
        'التداول الحقيقي معطّل. لا تُنشأ صفقة قبل تأكيد الوسيط لها.',
      ].join('\n'), this.notifier.mainKeyboard());
    }
  }

  async _handle(update) {
    if (update.callback_query) return this._handleCallback(update.callback_query);
    const message = update.message;
    if (!message || !this._authorized(message.chat && message.chat.id)) return;
    return this._handleMessage(message);
  }

  async statusText() {
    const status = await this.engine.status();
    const modeLabel = status.analysis_only ? 'تحليل فقط' : status.trading_mode;
    return [
      '📊 <b>ROZLF AUTO TRADER</b>',
      `الحساب: ${status.account_login || '—'} (${String(status.account_type || '').toUpperCase()})`,
      `الاتصال: ${status.account_status === 'connected' ? 'متصل' : status.account_status === 'analysis' ? 'تحليل فقط' : 'غير متصل'}`,
      `البوت: ${status.running ? 'يعمل' : 'متوقف'} | الوضع: ${modeLabel}`,
      `السرعة: ${SPEED_LABELS[status.speed] || status.speed}`,
      `الرصيد: ${Number(status.balance || 0).toFixed(2)} ${status.currency || 'USD'}`,
      `صفقات مفتوحة: ${status.open_trades.length} | اليوم: ${status.today_trades}`,
    ].join('\n');
  }

  opportunitiesText() {
    const items = this.engine.opportunities.filter((o) => o.side === 'BUY' || o.side === 'SELL');
    if (!items.length) return '🏆 لا توجد فرص واضحة حالياً — القرار: <b>NO TRADE</b>.';
    return ['🏆 <b>أفضل الفرص</b>'].concat(items.slice(0, 8).map((o) =>
      `• ${o.symbol} ${o.timeframe} <b>${o.side}</b> — ${Math.round(Number(o.confidence || 0) * 100)}% | ${o.entry}`,
    )).join('\n');
  }
}

module.exports = { TelegramBotController };
