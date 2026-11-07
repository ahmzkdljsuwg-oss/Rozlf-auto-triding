# ROZLF — نشر Render والاختبار الحقيقي

هذا المستند يصف الخطوات الفعلية لتشغيل خدمتي ROZLF على Render ثم إجراء اختبار
الأصول والمدد على حساب ExpertOption Demo حقيقي. كل ما هنا مبني على الكود الحالي.

## 1. الخدمتان

`render.yaml` يعرّف خدمتين:

| الخدمة | النوع | المسار |
| --- | --- | --- |
| `rozlf-auto-trader` | Node web service | `server.js` (الخادم والواجهة والتحليل) |
| `rozlf-eo-bridge` | Docker | `eo_bridge/Dockerfile` → `/health` |
| `rozlf-db` | PostgreSQL (free) | مربوط بـ `DATABASE_URL` عبر `fromDatabase` |

### النشر عبر Blueprint
1. Render → **New → Blueprint** → اختر المستودع `ahmzkdljsuwg-oss/Rozlf-auto-triding` والفرع `main`.
2. Render يقرأ `render.yaml` وينشئ الخدمتين وقاعدة `rozlf-db` معاً.
3. املأ المتغيرات المعلّمة `sync: false` (تظهر لك في شاشة الإنشاء)، ثم Apply.
4. قاعدة PostgreSQL المجانية في Render لها حدّ عمري/مساحة؛ للاستمرار الطويل استخدم
   Neon أو Supabase Free وضع رابطها في `DATABASE_URL` بدل `fromDatabase`.
   بدون `DATABASE_URL` تبقى الجلسة في SQLite محلي وتضيع مع كل إعادة نشر.

الـ bridge يجب أن يكون في نفس منطقة Render القريبة من خوادم ExpertOption؛
الافتراضي `EO_BRIDGE_REGION=EUROPE` (`eo_bridge/manager.py:37`).

## 2. المتغيرات

### خدمة الـ backend (`rozlf-auto-trader`)
اضبطها من Dashboard → Environment:

```
APP_SECRET_KEY      = <قيمة عشوائية طويلة>     # مفتاح تشفير AES-GCM للتوكن (إلزامي)
APP_SECRET_KEY_PREVIOUS = <المفتاح القديم>      # عند تدوير المفتاح فقط، مفصول بفواصل
DASHBOARD_TOKEN     = <رمز دخول طويل>          # إلزامي: بدونه كل مسارات /api مغلقة
ALLOW_INSECURE_DASHBOARD = false               # للتطوير المحلي فقط
EXPERTOPTION_BRIDGE_URL  = https://<bridge-host>
EXPERTOPTION_BRIDGE_KEY  = <مفتاح سري طويل>
EXPERTOPTION_SESSION_TOKEN = <توكن جلسة ExpertOption>
EXPERTOPTION_RESTORE_SESSION = true            # يستعيد الجلسة من التخزين المشفر بعد الإقلاع
EXPERTOPTION_ALLOW_REAL_READ = true            # قراءة حساب حقيقي للتحليل فقط (لا تنفيذ)
DATABASE_URL        = <رابط PostgreSQL>        # مربوط تلقائياً بقاعدة rozlf-db في Blueprint
MISTRAL_API_KEY     = <مفتاح Mistral>
TELEGRAM_BOT_TOKEN  = <توكن البوت>
TELEGRAM_CHAT_ID    = <معرّف المحادثة>
REAL_TRADING_APPROVED = false
```

### خدمة الـ bridge (`rozlf-eo-bridge`)
```
EO_BRIDGE_API_KEY    = <نفس قيمة EXPERTOPTION_BRIDGE_KEY بالحرف>
EO_BRIDGE_DEMO_ONLY  = true
EO_BRIDGE_REGION     = EUROPE
EO_BRIDGE_LOG_LEVEL  = INFO
EO_BRIDGE_ALLOW_REAL_READ        = true        # قراءة بيانات الحساب الحقيقي مسموحة
EO_BRIDGE_QUOTE_MAX_AGE_SECONDS  = 20          # بعدها يُرفض السعر القديم (409 stale_data)
```

### تخزين الجلسة المشفّر (شرط الاستعادة التلقائية)
التوكن يُخزَّن مشفّراً بـ AES-256-GCM داخل جدول `accounts` في قاعدة البيانات، لذلك:
- **بدون `DATABASE_URL`** يستخدم الخادم ملف SQLite داخل الحاوية، وهذا الملف يضيع مع كل
  إعادة نشر أو إعادة تشغيل على Render، فلا تعمل الاستعادة التلقائية.
- **مع `DATABASE_URL`** (PostgreSQL) يبقى التوكن المشفّر بعد أي إعادة تشغيل.
  حل مجاني مناسب: Neon أو Supabase (خطة Free). حدودها: مساحة صغيرة، وتوقف تلقائي
  عند الخمول فتزيد أول استجابة بعد الخمول، وقد تُحذف قاعدة الخطة المجانية عند عدم
  الاستخدام لفترة طويلة — لذلك خذ نسخة احتياطية قبل أي فترة توقف طويلة.
- `GET /api/config` يعيد `storage.driver` و`storage.durable` لتوضيح ذلك في الواجهة.
- اتصال PostgreSQL يتحقق من شهادة TLS افتراضياً. `PGSSL_INSECURE=true` مخصص فقط
  لمزوّد لا يستطيع Node التحقق من شهادته، ولا يُستخدم كحل عام.

### منع الأسعار القديمة
- الـ bridge يرفض سعراً أقدم من `EO_BRIDGE_QUOTE_MAX_AGE_SECONDS` (409 stale_data).
- الـ backend يرفض تحليلاً إذا كان آخر شمعة أقدم من
  `min(EXPERTOPTION_MAX_CANDLE_AGE_SECONDS، 5 × الفريم)` والحد الأدنى 60 ثانية.
- عند فقدان الاتصال يمسح الـ bridge كاش الأسعار ويعيد الاتصال؛ وإذا فشل الاتصال
  تُرفض الطلبات بـ 502 `connect_failed` ويظهر التحليل NO TRADE.

لا تُدخل أي سر في المستودع أو في المحادثة.

## 3. التحقق من النشر

```bash
curl -s https://<bridge-host>/health
# يجب أن يعيد ok=true و demo_only=true و v1.0.0

curl -s -H "X-Dashboard-Token: $DASHBOARD_TOKEN" \
  https://<backend-host>/api/health
```

ثم افتح الواجهة → اختر `ExpertOption` → `Demo` → أدخل ربط الحساب
(`login` = بريد حسابك، والتوكن في حقل التوكن) → «اختبار الاتصال وتسجيل الدخول».

## 4. الاختبار الحقيقي للأصول

بعد نجاح الاتصال:

```bash
ROZLF_URL=https://<backend-host> DASHBOARD_TOKEN=... \
  node scripts/eo-asset-report.js https://<backend-host>
```

يفحص لكل أصل من التسعة:

- هل موجود في قائمة الحساب الفعلية (`asset_not_found` إن لا)
- هل نشط (`asset_inactive`)
- الـ payout و id المطابق بالاسم
- كل مدة من `30s / 1m / 2m / 3m / 5m`: النتيجة أو رمز الرفض
  (`expiry_unsupported`، `insufficient_data`، `stale_data`، `weak_setup`)

## 5. حدود معروفة (يجب ذكرها في أي تقرير)

- الجلسات في ذاكرة الـ bridge: تُفقد عند إيقاف الحاوية، ويعيد الـ backend بناءها
  تلقائيًا عند أول طلب من التوكن المستعاد (لا يحتاج إعادة إدخال ما دام
  `APP_SECRET_KEY` ثابتًا و`EXPERTOPTION_RESTORE_SESSION=true`).
  لتدوير `APP_SECRET_KEY` بدون فقدان الجلسة: ضع المفتاح الجديد في `APP_SECRET_KEY`
  والقديم في `APP_SECRET_KEY_PREVIOUS`، ثم أعد التشغيل؛ يُستخدم القديم للفك فقط.
  إن حُذف القديم قبل أن يُعاد حفظ التوكن، يفشل فك التشفير ويُطلب التوكن مرة أخرى
  (السبب يظهر في السجل كـ `stored_token_unreadable`، دون طباعة أي سر).
- خطة Render المجانية تُوقف الخدمة بعد فترة خمول، وقد تحتاج 30–60 ثانية للاستيقاظ.
- `EO_BRIDGE_DEMO_ONLY=true` لا يمنع قراءة بيانات حساب حقيقي؛ فهو يصف سياسة
  التنفيذ فقط. التنفيذ غير موجود أصلًا: `buy/sell` ترمي `TradingDisabledError`،
  و`/health` يعيد `trading_enabled: false`. ولإيقاف قراءة الحساب الحقيقي كليًا
  اضبط `EO_BRIDGE_ALLOW_REAL_READ=false`.
- الأسعار القديمة لا تُستخدم: الـ bridge يرفض أي شمعة أحدث من `period*2 + 20s`
  بـ `409 stale_data`، والـ backend يحوّلها إلى NO TRADE برمز `stale_data`.
- القراءة تعتمد على قائمة أصول الحساب نفسه؛ الأصول غير الموجودة في الحساب تُظهر
  NO TRADE برمز واضح، ولا تُستبدل ببيانات فوركس عادية.
