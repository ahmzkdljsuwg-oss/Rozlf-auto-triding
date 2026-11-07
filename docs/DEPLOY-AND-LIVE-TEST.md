# ROZLF — نشر Render والاختبار الحقيقي

هذا المستند يصف الخطوات الفعلية لتشغيل خدمتي ROZLF على Render ثم إجراء اختبار
الأصول والمدد على حساب ExpertOption Demo حقيقي. كل ما هنا مبني على الكود الحالي.

## 1. الخدمتان

`render.yaml` يعرّف خدمتين:

| الخدمة | النوع | المسار |
| --- | --- | --- |
| `rozlf-auto-trader` | Node web service | `server.js` (الخادم والواجهة والتحليل) |
| `rozlf-eo-bridge` | Docker | `eo_bridge/Dockerfile` → `/health` |

الـ bridge يجب أن يكون في نفس منطقة Render القريبة من خوادم ExpertOption؛
الافتراضي `EO_BRIDGE_REGION=EUROPE` (`eo_bridge/manager.py:37`).

## 2. المتغيرات

### خدمة الـ backend (`rozlf-auto-trader`)
اضبطها من Dashboard → Environment:

```
APP_SECRET_KEY      = <قيمة عشوائية طويلة>     # مفتاح تشفير AES-GCM للتوكن
DASHBOARD_TOKEN     = <رمز دخول طويل>          # إلزامي: بدونه كل مسارات /api مغلقة
ALLOW_INSECURE_DASHBOARD = false               # للتطوير المحلي فقط
EXPERTOPTION_BRIDGE_URL  = https://<bridge-host>
EXPERTOPTION_BRIDGE_KEY  = <مفتاح سري طويل>
EXPERTOPTION_SESSION_TOKEN = <توكن جلسة ExpertOption>
EXPERTOPTION_RESTORE_SESSION = true            # يستعيد الجلسة من التخزين المشفر بعد الإقلاع
EXPERTOPTION_ALLOW_REAL_READ = false           # قراءة حساب حقيقي للتحليل فقط
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
  إن تغيّر `APP_SECRET_KEY` يفشل فك التشفير ويُطلب التوكن مرة أخرى من الواجهة
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
