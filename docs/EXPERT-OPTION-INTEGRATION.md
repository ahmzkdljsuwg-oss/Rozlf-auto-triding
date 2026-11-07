# تقرير تكامل ExpertOption مع ROZLF AUTO TRADER

تاريخ المراجعة: 2026-11-07

## الخلاصة

لا يوجد مسار تكامل مصرّح به يمكن تنفيذه الآن. لم نعثر على واجهة API عامة أو توثيق مطورين
أو برنامج شراكة تقنية للتداول الآلي على موقع ExpertOption. والأهم أن شروط الخدمة تمنع
البوتات صراحةً.

لذلك لا يمكن لـ ROZLF قراءة أسواق الحساب أو رصيده أو تنفيذ صفقات Demo على ExpertOption
بشكل مصرّح به. استخدام Session Token أو Cookies أو WebSocket داخلي لهذا الغرض سيكون
تجاوزاً لشروط المنصة، ولن يُضاف إلى الكود.

## الأدلة التي تمت مراجعتها

| المصدر | النتيجة |
| --- | --- |
| الموقع الرسمي `https://expertoption.com/` | لا يوجد رابط API أو Developer أو Documentation. |
| الشروط والأحكام `https://expertoption.com/company/policy/terms/` | البند 6.2 يمنع صراحةً `automated players (also known as 'bots')` وأي `implantations to the client—server relationship`. |
| الأسئلة الشائعة `https://expertoption.com/trade/faq/` | لا تذكر أي API للتداول أو قراءة بيانات الحساب. |
| الميزات `https://expertoption.com/trade/features/` | لا تذكر تكاملاً برمجياً أو وصولاً خارجياً. |
| برنامج الشركاء | برنامج تسويق/إحالات، وليس API تداول. |

نص البند 6.2 المنشور في صفحة الشروط (مقتبس):

> Any using an unfair advantage or influence (commonly known as cheating), including a
> decompilation, reverse engineering, any implantations to the client—server relationship,
> exploitation of bugs, loopholes or errors in software, any hack, database security
> violation, the use of automated players (also known as 'bots'); or the exploitation of an
> 'error' are strictly prohibited by the Company.

العقوبة المنصوص عليها: إغلاق الحساب دون إشعار، إلغاء المدفوعات، ومصادرة الأموال.

## هل يمكن طلب صلاحية API؟

نعم، يمكن إرسال طلب كتابي إلى دعم ExpertOption أو قسم الشراكات. لكن:

- لا توجد صفحة أو نموذج منشور لطلب API تداول.
- البند 6.2 يجعل الموافقة الكتابية شرطاً ضرورياً قبل أي أتمتة.
- لا يجوز افتراض أن الموافقة ستُمنح، ولا نشر كود تنفيذ قبل الحصول على توثيق رسمي.

## ما الذي يمكن تنفيذه فعلياً الآن

1. تحليل عام لأسواق مرجعية عامة، مع توضيح أن المصدر ليس بيانات حساب ExpertOption.
2. إشارات BUY / SELL / NO TRADE وتنبيهات Telegram، دون تنفيذ صفقات.
3. عرض حالة الاتصال منفصلة عن حالة مصدر البيانات، وعدم اعتبار التوكن اتصالاً ناجحاً.
4. استخدام MT5 Demo عبر جسر Windows رسمي إذا كان التنفيذ الآلي مطلوباً فعلاً.

## ما لا يمكن تنفيذه

- قراءة أصول الحساب أو OTC أو Smarty من جلسة ExpertOption.
- قراءة الرصيد أو Equity أو سجل الصفقات.
- قراءة شموع ExpertOption أو أسعارها الحقيقية.
- إرسال أوامر Demo أو فتح/إغلاق صفقات.
- استخدام توكن الجلسة أو أي واجهة داخلية غير موثقة.

## شرط فتح التنفيذ مستقبلاً

لا يُضاف أي كود تنفيذ إلا بعد توفير كل ما يلي من ExpertOption:

1. اتفاقية أو تفويض كتابي يسمح بالتداول الآلي.
2. توثيق API رسمي: نقاط النهاية، المصادقة، حدود المعدل، وبيئة اختبار.
3. تأكيد صريح بالسماح بأوامر Demo عبر الـ API.
4. آلية تحقق من الهوية لا تعتمد على توكن جلسة غير موثق.

عندها فقط يمكن تنفيذ `ExpertOptionSession` الحقيقي خلف نفس الواجهة، مع اختبار Demo فعلي،
ودون تغيير قواعد إدارة المخاطر أو إيقاف الصفقات عند فقدان الاتصال.

## بوابة البيانات المصرح بها (تحديث 2026-11-07)

بدلاً من محاكاة المنصة، صار كود الجلسة `src/expertoption-session.js` يعمل كـ **محوّل بوابة
مصرح بها**: يقرأ البيانات من خدمة يملك المشغّل حق استخدامها لحسابه، ولا يتصل بأي واجهة غير
موثقة ولا يعيد استخدام Cookies لتنفيذ أوامر.

المتغيرات المطلوبة (تُضبط كأسرار في Render، ولا تُحفظ في المستودع):

| المتغير | الوظيفة |
| --- | --- |
| `EXPERTOPTION_API_BASE_URL` | عنوان بوابة البيانات المصرح بها (HTTPS). |
| `EXPERTOPTION_API_KEY` | مفتاح البوابة، يُرسل كـ `Authorization: Bearer`. |
| `EXPERTOPTION_API_ACCOUNT` | معرّف الحساب داخل البوابة (اختياري). |
| `EXPERTOPTION_API_TIMEOUT_MS` | مهلة الطلب، الافتراضي 10000. |
| `EXPERTOPTION_API_MIN_INTERVAL_MS` | أقل تباعد بين الطلبات، الافتراضي 250. |
| `EXPERTOPTION_API_RETRIES` | عدد إعادات المحاولة عند فشل الشبكة، 0–5. |
| `EXPERTOPTION_MAX_CANDLE_AGE_SECONDS` | أقدم شمعة مقبولة قبل رفض التحليل، الافتراضي 180. |
| `EXPERTOPTION_MIN_CANDLES` | أقل عدد شموع مطلوب، الافتراضي 80. |

### عقد البوابة

كل الردود JSON وتُقرأ عبر HTTPS بمفتاح Bearer:

| المسار | الاستجابة |
| --- | --- |
| `GET /session` | `{ ok, account: { login, type, currency, balance, equity, free_margin, used_margin }, expires_at }` |
| `GET /account` | `{ account: { ... } }` لقراءة الرصيد المحدث |
| `GET /instruments` | `{ instruments: [ { id, symbol, name, category, otc, expiries } ] }` |
| `GET /candles?instrument_id=&timeframe=&limit=` | `{ candles: [ { time, open, high, low, close, volume } ] }` |

زمن الشمعة بالثواني أو بالميلي ثانية، ويُوحَّد داخلياً. أي شمعة ناقصة أو غير رقمية تُرفض
بدلاً من تقديرها.

### ما يفعله التطبيق فعلياً

1. تحقّق الجلسة: يقرأ `/session`، وإن فشل فلا يظهر الاتصال كمتصل أبداً.
2. قراءة الأصول: من `/instruments` فقط، ثم مطابقة الأصول المطلوبة (Smarty، Cricket Index،
   Football Index، AI Index، Luxury Index، EUR/USD OTC، GBP/USD OTC، USD/JPY OTC،
   USD/CHF OTC) بالاسم أو الرمز. المعرّفات القديمة (240/276/278/285/286/179/180/181/182)
   لا تُستخدم إلا بعد تطابقها مع القائمة الحقيقية.
3. قراءة الشموع وتصفيتها ومنع التكرار، ثم رفض التحليل إذا كانت الشمعة الأخيرة أقدم من الحد.
4. حساب RSI وMACD وEMA وBollinger وATR وADX، ثم BOS/CHoCH/FVG وOrder Blocks وسحب السيولة.
5. إسناد قاعدة النقاط، ثم مراجعة Mistral على لقطة بيانات حقيقية. أي تعارض أو ثقة أقل من 55%
   يعطي `NO TRADE` مع سبب واضح.
6. `execution_allowed` يبقى `false` دائماً: لا يوجد تنفيذ على ExpertOption.

### حدود يجب معرفتها

- بدون `EXPERTOPTION_API_BASE_URL` و`EXPERTOPTION_API_KEY` تظهر الحالة «غير متحققة» ولا
  يُعرض أي سعر أو إشارة. لا تُملأ الفراغات ببيانات بديلة.
- بوابة البيانات لا تعني صلاحية تنفيذ: التنفيذ يظل معطلاً لأن شروط المنصة تمنع البوتات.
- Render لا يضمن تشغيلاً متصلاً 24 ساعة على الخطة المجانية (توقف عند الخمول وإعادة نشر).
