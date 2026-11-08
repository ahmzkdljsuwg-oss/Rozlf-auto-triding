# نشر ROZLF والتحقق الفعلي

## بنية النشر الحالية

- خدمة Render واحدة لتشغيل `server.js`.
- عند ترك `EXPERTOPTION_BRIDGE_URL` فارغاً، يشغّل `src/local-bridge.js` الجسر الموجود في `eo_bridge/standalone.py` محلياً على `127.0.0.1:8011`.
- لا تنشئ خدمة Render ثانية باسم `rozlf-eo-bridge` لهذا الوضع.
- قاعدة PostgreSQL مطلوبة لحفظ الجلسة المشفّرة بشكل دائم؛ SQLite المحلية على استضافة مؤقتة قد تفقد بياناتها بعد إعادة التشغيل.

## متغيرات Render

اضبط القيم التالية في Environment:

```text
APP_SECRET_KEY=<قيمة عشوائية طويلة وثابتة>
DATABASE_URL=<رابط PostgreSQL>
EXPERTOPTION_RESTORE_SESSION=true
EXPERTOPTION_ALLOW_REAL_READ=true
REAL_TRADING_APPROVED=false
MT5_ENABLED=false
```

اختياري:

```text
MISTRAL_API_KEY=<مفتاح Mistral>
TELEGRAM_BOT_TOKEN=<توكن بوت Telegram>
TELEGRAM_CHAT_ID=<معرّف المحادثة>
```

**لا تغيّر `APP_SECRET_KEY` بعد حفظ الجلسة**؛ تغيير المفتاح يجعل فك تشفير الجلسة المخزنة مستحيلاً ما لم تستخدم تدوير المفاتيح.

## مفتاحان مختلفان

1. لا يوجد مفتاح لوحة؛ اكتب `/connect` في بوت Telegram ثم استخدم رابط الربط الآمن.
2. `ExpertOption Session Token`: يدخل لاحقاً داخل نموذج ExpertOption في الموقع، ويُخزن مشفراً على الخادم.

لا تضع أيّاً منهما في GitHub أو المحادثات. إذا سبق نشر Session Token، ألغِ الجلسة وأنشئ واحدة جديدة.

## خطوات التحقق

1. افتح `https://<service>.onrender.com/api/health`.
2. تحقق من `ok: true` ومن `expertoption_bridge.mode` و`ready: true`.
3. تذكّر أن صحة الجسر لا تعني أن حساب ExpertOption موصول.
4. افتح بوت Telegram واكتب `/connect` ثم افتح رابط الربط الآمن وأدخل Session Token داخل الصفحة فقط.
5. بعد فتح اللوحة، أدخل Session Token الجديد في قسم ExpertOption.
6. لا تعتبر الاتصال ناجحاً إلا إذا أظهرت حالة الجلسة `verified: true`.
7. لا تعتبر الشموع أو الإشارات حقيقية إلا بعد نجاح قراءة قائمة الأصول والشموع من جلسة الحساب. يجب أن تكون نتيجة التحليل `data_verified: true`.
8. إذا لم تتوفر شموع حديثة أو كان الأصل/الفريم غير مدعوم، يجب أن تكون النتيجة `NO TRADE`.

## حدود مهمة

- تكامل ExpertOption هنا قراءة وتحليل فقط؛ لا يوجد تنفيذ أوامر.
- لا يتم ضمان توفر Smarty أو OTC لكل حساب؛ القائمة الحية هي المرجع.
- أرقام الأصول القديمة ليست دليلاً كافياً وحدها على الهوية؛ يجب مطابقة الاسم أو الرمز مع قائمة الحساب.
- Render المجاني قد ينام ولا يضمن 24/7.
