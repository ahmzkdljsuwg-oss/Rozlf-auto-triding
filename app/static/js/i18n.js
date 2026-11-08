(function () {
  const dict = {
    ar: {
      'pill.checking': 'جارٍ التحقق',
      'pill.connected': 'الجلسة متصلة',
      'pill.partial': 'قراءة جزئية',
      'pill.disconnected': 'غير متصل',
      'pill.offline': 'الخادم لا يستجيب',

      'hero.eyebrow': 'تحليل ذكي للأسواق',
      'hero.title': 'حلّل أي أصل',
      'hero.titleAccent': 'في ثوانٍ',
      'hero.sub': 'شموع حقيقية من جلسة حسابك في ExpertOption، مؤشرات فنية، هيكل سوق، وقراءة ذكية بالسعر الفعلي — دون أي تنفيذ صفقات.',
      'search.placeholder': 'ابحث عن أصل: Smarty، EUR/USD OTC…',
      'search.action': 'تحليل',

      'meta.source': 'المصدر: —',
      'meta.sourceValue': 'المصدر: جلسة حساب {name}',
      'meta.updated': 'آخر تحديث: —',
      'meta.updatedValue': 'آخر تحديث: {time}',
      'meta.readonly': 'قراءة وتحليل فقط',

      'connect.title': 'جلسة ExpertOption',
      'connect.sub': 'اربط جلستك مرة واحدة ليقرأ ROZLF شموع حسابك الحقيقية.',
      'connect.form': 'بيانات الجلسة',
      'connect.demoOnly': 'Demo فقط',
      'connect.login': 'بريد أو اسم الحساب',
      'connect.token': 'Session Token',
      'connect.tokenHint': 'أدخل قيمة token فقط أو ألصق سلسلة Cookies كاملة تحتوي token=؛ سيستخرج الخادم قيمة token وحدها ويحفظها مشفّرة. لا ترسلها لأحد.',
      'connect.submit': 'اختبار اتصال ExpertOption',
      'connect.disconnect': 'قطع الجلسة',
      'connect.helpSummary': 'من أين أحصل على Session Token؟',
      'connect.helpBody': 'سجّل الدخول إلى حسابك التجريبي في ExpertOption من متصفحك، ثم افتح أدوات المطوّر ← Application ← Local Storage، وانسخ قيمة مفتاح الجلسة (session / token). تُستخدم هذه القيمة للقراءة والتحليل فقط.',
      'connect.status': 'حالة الاتصال',
      'connect.account': 'الحساب',
      'connect.session': 'الجلسة',
      'connect.bridge': 'خدمة القراءة',
      'connect.data': 'بيانات السوق',
      'connect.mode': 'وضع التشغيل',
      'connect.modeValue': 'تحليل فقط — التنفيذ معطّل',

      'state.connected': 'متصل',
      'state.disconnected': 'غير متصل',
      'state.expired': 'منتهية',
      'state.unverified': 'غير مؤكدة',
      'state.unknown': 'غير معروفة',
      'state.active': 'نشطة',
      'state.inactive': 'غير نشطة',
      'state.ready': 'جاهزة',
      'state.down': 'متوقفة',
      'state.available': 'متوفرة',
      'state.missing': 'غير متوفرة',
      'state.none': '—',
      'state.analysisOnly': 'تحليل فقط',

      'quick.title': 'أحدث قراءة',
      'quick.empty': 'لم يتم تحليل أي أصل بعد',
      'quick.hint': 'اختر أصلاً من القائمة أو ابحث عنه للبدء.',
      'stats.title': 'لمحة سريعة',
      'stats.assets': 'أصول متاحة',
      'stats.analyzed': 'عمليات تحليل',
      'stats.buys': 'إشارات BUY',
      'stats.sells': 'إشارات SELL',
      'stats.none': 'بدون إشارة',
      'stats.uptime': 'مدة التشغيل',

      'assets.title': 'الأصول',
      'assets.sub': 'القائمة تُقرأ من أصول حسابك الفعلية — بدون رموز مُختلقة.',
      'assets.loading': 'جارٍ تحميل الأصول من جلسة الحساب…',
      'assets.empty': 'لا توجد أصول معروضة. اربط جلسة ExpertOption أولاً ثم أعد التحميل.',
      'assets.noMatch': 'لا يوجد أصل يطابق البحث.',
      'assets.count': '{n} أصل',

      'cat.all': 'الكل',
      'cat.forex': 'فوركس',
      'cat.otc': 'OTC',
      'cat.smarty': 'Smarty',
      'cat.indices': 'مؤشرات',
      'cat.crypto': 'كريبتو',
      'cat.stocks': 'أسهم',
      'cat.commodities': 'سلع',

      'analysis.title': 'التحليل الفني',
      'analysis.sub': 'اختر أصلاً ومدة ثم ابدأ التحليل.',
      'analysis.subValue': '{asset} · {expiry} · {timeframe}',
      'analysis.idle': 'بانتظار أصل',
      'analysis.running': 'جارٍ التحليل…',
      'analysis.done': 'تحليل مكتمل',
      'analysis.failed': 'تعذّر التحليل',
      'analysis.needSession': 'اربط جلسة ExpertOption أولاً.',
      'analysis.needAsset': 'اختر أصلاً أولاً.',

      'signal.buy': 'BUY',
      'signal.sell': 'SELL',
      'signal.none': 'NO TRADE',

      'chart.title': 'الشموع الحقيقية',
      'chart.empty': 'لا توجد شموع لعرضها بعد.',
      'chart.up': 'شموع صاعدة',
      'chart.down': 'شموع هابطة',
      'chart.sr': 'دعم/مقاومة',

      'verdict.title': 'القرار',
      'verdict.strength': 'قوة القراءة',
      'ind.title': 'المؤشرات',
      'ind.rsi': 'RSI',
      'ind.macd': 'MACD',
      'ind.ema20': 'EMA 20',
      'ind.ema50': 'EMA 50',
      'ind.ema200': 'EMA 200',
      'ind.atr': 'ATR',
      'ind.bb': 'Bollinger',
      'ind.adx': 'ADX',
      'ind.trend': 'الاتجاه',

      'levels.title': 'الدعم والمقاومة',
      'levels.support': 'دعم',
      'levels.resistance': 'مقاومة',
      'levels.none': 'لا توجد مستويات موثوقة في البيانات الحالية.',
      'structure.title': 'هيكل السوق',
      'structure.bias': 'الميل',
      'structure.bos': 'BOS',
      'structure.choch': 'CHoCH',
      'structure.fvg': 'FVG',
      'structure.sweep': 'Liquidity sweep',
      'structure.none': 'لا توجد إشارات هيكلية واضحة.',

      'logs.title': 'سجل العمليات',
      'logs.sub': 'أحدث الأحداث من الخادم — بدون أي أسرار.',
      'logs.refresh': 'تحديث',
      'logs.loading': 'جارٍ التحميل…',
      'logs.empty': 'لا توجد أحداث مسجّلة بعد.',

      'nav.home': 'الرئيسية',
      'nav.assets': 'الأصول',
      'nav.analysis': 'التحليل',
      'nav.logs': 'السجل',

      'access.title': 'ربط Telegram',
      'access.sub': 'اربط Telegram لفتح لوحة ROZLF.',
      'access.field': 'رمز الربط',
      'access.cancel': 'إلغاء',
      'access.save': 'حفظ',

      'footer.risk': 'ROZLF AUTO TRADER أداة تحليل ومعلومات فقط. لا ينفّذ صفقات ولا يدير أموالاً، ولا يضمن أي نتيجة. التداول ينطوي على مخاطر عالية، والقرار النهائي مسؤوليتك وحدك.',

      'toast.tokenRequired': 'أدخل Session Token صالحاً أولاً.',
      'toast.accessSaved': 'تم حفظ مفتاح الوصول.',
      'toast.accessMissing': 'أدخل مفتاح الوصول.',
      'toast.accessRequired': 'أدخل مفتاح حماية ROZLF من Render؛ هذا ليس Session Token.',
      'toast.accessWrong': 'مفتاح الوصول غير صحيح.',
      'toast.disconnected': 'تم قطع الجلسة على الخادم.',
      'toast.connected': 'تم التحقق من جلسة ExpertOption وقراءة الحساب.',
      'toast.tokenSavedUnverified': 'تم حفظ التوكن مشفّراً، لكن الجلسة لم تُتحقق بعد. راجع حالة الجسر ورسالة الخطأ.',
      'toast.offline': 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال.',
      'toast.loadingAssets': 'تم تحميل {n} أصلاً من حسابك.',
      'toast.noSignal': 'البيانات غير كافية — لا إشارة.',
      'toast.copied': 'تم النسخ.'
    },
    en: {
      'pill.checking': 'Checking',
      'pill.connected': 'Session live',
      'pill.partial': 'Partial read',
      'pill.disconnected': 'Disconnected',
      'pill.offline': 'Server unreachable',

      'hero.eyebrow': 'Smart market analysis',
      'hero.title': 'Analyze any asset',
      'hero.titleAccent': 'in seconds',
      'hero.sub': 'Real candles from your own ExpertOption session, technical indicators, market structure and a data-backed read at the live price — with no order execution.',
      'search.placeholder': 'Search an asset: Smarty, EUR/USD OTC…',
      'search.action': 'Analyze',

      'meta.source': 'Source: —',
      'meta.sourceValue': 'Source: {name} session',
      'meta.updated': 'Updated: —',
      'meta.updatedValue': 'Updated: {time}',
      'meta.readonly': 'Read & analysis only',

      'connect.title': 'ExpertOption session',
      'connect.sub': 'Connect once so ROZLF can read your real account candles.',
      'connect.form': 'Session details',
      'connect.demoOnly': 'Demo only',
      'connect.login': 'Email or account name',
      'connect.token': 'Session Token',
      'connect.tokenHint': 'Enter the token value, or paste a full cookie string containing token=. The server extracts only token and encrypts it. Never share it.',
      'connect.submit': 'Test ExpertOption connection',
      'connect.disconnect': 'Disconnect session',
      'connect.helpSummary': 'Where do I find the Session Token?',
      'connect.helpBody': 'Sign in to your ExpertOption demo account in your browser, open DevTools → Application → Local Storage and copy the session value. It is used for reading and analysis only.',
      'connect.status': 'Connection status',
      'connect.account': 'Account',
      'connect.session': 'Session',
      'connect.bridge': 'Read service',
      'connect.data': 'Market data',
      'connect.mode': 'Mode',
      'connect.modeValue': 'Analysis only — execution disabled',

      'state.connected': 'Connected',
      'state.disconnected': 'Disconnected',
      'state.expired': 'Expired',
      'state.unverified': 'Unverified',
      'state.unknown': 'Unknown',
      'state.active': 'Active',
      'state.inactive': 'Inactive',
      'state.ready': 'Ready',
      'state.down': 'Down',
      'state.available': 'Available',
      'state.missing': 'Unavailable',
      'state.none': '—',
      'state.analysisOnly': 'Analysis only',

      'quick.title': 'Latest read',
      'quick.empty': 'No asset analyzed yet',
      'quick.hint': 'Pick an asset from the list or search for one to begin.',
      'stats.title': 'At a glance',
      'stats.assets': 'Assets',
      'stats.analyzed': 'Analyses',
      'stats.buys': 'BUY signals',
      'stats.sells': 'SELL signals',
      'stats.none': 'No signal',
      'stats.uptime': 'Uptime',

      'assets.title': 'Assets',
      'assets.sub': 'Read from your own account list — no invented symbols.',
      'assets.loading': 'Loading assets from the account session…',
      'assets.empty': 'No assets to show. Connect your ExpertOption session first, then reload.',
      'assets.noMatch': 'No asset matches your search.',
      'assets.count': '{n} assets',

      'cat.all': 'All',
      'cat.forex': 'Forex',
      'cat.otc': 'OTC',
      'cat.smarty': 'Smarty',
      'cat.indices': 'Indices',
      'cat.crypto': 'Crypto',
      'cat.stocks': 'Stocks',
      'cat.commodities': 'Commodities',

      'analysis.title': 'Technical analysis',
      'analysis.sub': 'Pick an asset and an expiry, then run the analysis.',
      'analysis.subValue': '{asset} · {expiry} · {timeframe}',
      'analysis.idle': 'Waiting for asset',
      'analysis.running': 'Analyzing…',
      'analysis.done': 'Analysis complete',
      'analysis.failed': 'Analysis failed',
      'analysis.needSession': 'Connect your ExpertOption session first.',
      'analysis.needAsset': 'Select an asset first.',

      'signal.buy': 'BUY',
      'signal.sell': 'SELL',
      'signal.none': 'NO TRADE',

      'chart.title': 'Real candles',
      'chart.empty': 'No candles to draw yet.',
      'chart.up': 'Bullish',
      'chart.down': 'Bearish',
      'chart.sr': 'Support/Resistance',

      'verdict.title': 'Verdict',
      'verdict.strength': 'Read strength',
      'ind.title': 'Indicators',
      'ind.rsi': 'RSI',
      'ind.macd': 'MACD',
      'ind.ema20': 'EMA 20',
      'ind.ema50': 'EMA 50',
      'ind.ema200': 'EMA 200',
      'ind.atr': 'ATR',
      'ind.bb': 'Bollinger',
      'ind.adx': 'ADX',
      'ind.trend': 'Trend',

      'levels.title': 'Support & resistance',
      'levels.support': 'Support',
      'levels.resistance': 'Resistance',
      'levels.none': 'No reliable levels in the current data.',
      'structure.title': 'Market structure',
      'structure.bias': 'Bias',
      'structure.bos': 'BOS',
      'structure.choch': 'CHoCH',
      'structure.fvg': 'FVG',
      'structure.sweep': 'Liquidity sweep',
      'structure.none': 'No clear structural signal.',

      'logs.title': 'Activity log',
      'logs.sub': 'Latest server events — no secrets.',
      'logs.refresh': 'Refresh',
      'logs.loading': 'Loading…',
      'logs.empty': 'No events recorded yet.',

      'nav.home': 'Home',
      'nav.assets': 'Assets',
      'nav.analysis': 'Analysis',
      'nav.logs': 'Log',

      'access.title': 'Access key',
      'access.sub': 'Connect Telegram to open the ROZLF dashboard.',
      'access.field': 'Pairing code',
      'access.cancel': 'Cancel',
      'access.save': 'Save',

      'footer.risk': 'ROZLF AUTO TRADER is an analysis and information tool. It does not execute trades, does not manage funds and guarantees no result. Trading carries high risk and every decision is yours.',

      'toast.tokenRequired': 'Enter a valid Session Token first.',
      'toast.accessSaved': 'Access key saved.',
      'toast.accessMissing': 'Enter the access key.',
      'toast.accessRequired': 'Enter the ROZLF dashboard key from Render; this is not your ExpertOption Session Token.',
      'toast.accessWrong': 'That access key is not valid.',
      'toast.disconnected': 'Session cleared on the server.',
      'toast.connected': 'ExpertOption session verified and account data read.',
      'toast.tokenSavedUnverified': 'Token encrypted and saved, but the session is not verified yet. Check bridge status and the error message.',
      'toast.offline': 'Cannot reach the server. Check your connection.',
      'toast.loadingAssets': 'Loaded {n} assets from your account.',
      'toast.noSignal': 'Not enough data — no signal.',
      'toast.copied': 'Copied.'
    }
  };

  let lang = localStorage.getItem('rozlf_lang') === 'en' ? 'en' : 'ar';

  function t(key, vars) {
    const table = dict[lang] || dict.ar;
    let out = table[key];
    if (out === undefined) out = dict.ar[key];
    if (out === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        out = out.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return out;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const spec = el.dataset.i18nAttr || '';
      spec.split(';').forEach((pair) => {
        const parts = pair.split(':');
        const attr = (parts[0] || '').trim();
        const key = (parts[1] || '').trim();
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
    const toggle = document.getElementById('lang-toggle');
    if (toggle) toggle.textContent = lang === 'ar' ? 'EN' : 'ع';
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'ar';
    localStorage.setItem('rozlf_lang', lang);
    apply();
    document.dispatchEvent(new CustomEvent('rozlf:lang', { detail: { lang } }));
  }

  window.RozlfI18n = {
    t,
    setLang,
    apply,
    get lang() { return lang; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
