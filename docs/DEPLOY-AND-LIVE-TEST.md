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
DASHBOARD_TOKEN     = <رمز دخول طويل>          # بدونه الـ API مفتوح للجميع
EXPERTOPTION_BRIDGE_URL  = https://<bridge-host>
EXPERTOPTION_BRIDGE_KEY  = <مفتاح سري طويل>
EXPERTOPTION_SESSION_TOKEN = <توكن جلسة ExpertOption>
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

- الجلسات في الذاكرة فقط: بعد نوم خدمة Render المجانية أو إعادة تشغيلها تُعاد
  الجلسة عند أول طلب، لكن الـ backend يحتاج إعادة إدخال التوكن من الواجهة لأن
  المحرّك لا يستعيده من قاعدة البيانات عند الإقلاع.
- خطة Render المجانية تُوقف الخدمة بعد فترة خمول، وقد تحتاج 30–60 ثانية للاستيقاظ.
- `EO_BRIDGE_DEMO_ONLY=true` يمنع أي طلب يُعلن أنه حساب حقيقي (403)، ولا علاقة له
  بتنفيذ الصفقات — لا يوجد تنفيذ صفقات في هذا التكامل مطلقًا.
- القراءة تعتمد على قائمة أصول الحساب نفسه؛ الأصول غير الموجودة في الحساب تُظهر
  NO TRADE برمز واضح، ولا تُستبدل ببيانات فوركس عادية.
