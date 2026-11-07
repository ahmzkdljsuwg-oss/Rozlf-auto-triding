# ROZLF AUTO TRADER

منصة تداول آلي مستقلة عن موقع ROZLF، مبنية بـ **Node.js + Express + واجهة ويب عربية/إنجليزية**.
تعمل في وضع **Demo فقط** افتراضياً، وتحلّل السوق ببيانات حقيقية (Yahoo Finance)، وتنفّذ صفقات
تجريبية على محرك محاكاة داخلي، مع إشعارات Telegram ومراجعة اختيارية عبر Gemini.

> ⚠️ **إخلاء مسؤولية:** التداول ينطوي على مخاطر عالية. هذا المشروع لا يضمن أي أرباح.
> التداول الحقيقي معطّل حتى تفعّله صراحةً بعد إكمال الاختبارات. ExpertOption للتحليل والتنبيهات فقط.

---

## 1. ما الذي يعمل فعلاً

| المكوّن | الحالة |
| --- | --- |
| شاشة اختيار المنصة (ExpertOption / MT5) ثم Demo / Real | ✅ يعمل (Real مقفول) |
| تسجيل دخول Demo + اختبار اتصال بالسوق | ✅ يعمل |
| بيانات سوق حقيقية: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, NZDUSD, XAUUSD | ✅ Yahoo Finance |
| فريمات M5 / M15 / H1 / H4 / D1 | ✅ |
| مؤشرات RSI, MACD, EMA, Bollinger, ATR, ADX | ✅ |
| SMC: BOS, CHoCH, FVG, Order Blocks, Liquidity Sweeps | ✅ |
| إشارة BUY / SELL / NO TRADE + Entry / SL / TP + ثقة | ✅ |
| محرك تنفيذ Demo (Paper) بأسعار حقيقية وتسوية PnL | ✅ |
| منع التكرار، حدود يومية، سبريد، فقدان بيانات | ✅ |
| صور الشارت ونتائج الصفقات | ✅ `@napi-rs/canvas` |
| Gemini AI (اختياري) | ✅ عند وجود `GEMINI_API_KEY` |
| إشعارات Telegram (اختياري) | ✅ عند وجود token + chat id |
| MT5 حقيقي | ⚠️ يحتاج Windows + MT5 Terminal + جسر HTTP + `MT5_ENABLED=true` |
| ExpertOption تنفيذ | ❌ لا يوجد API عام مصرّح به — تحليل وتنبيهات فقط |

---

## 2. هيكل المشروع

```
server.js              # نقطة التشغيل (Express)
src/
  config.js            # الإعدادات من متغيرات البيئة
  security.js          # تشفير كلمات المرور (AES-256-GCM) + قناع الحساب
  db.js                # SQLite محلي أو PostgreSQL عبر DATABASE_URL
  market.js            # بيانات Yahoo Finance + السبريد
  indicators.js        # RSI/MACD/EMA/Bollinger/ATR/ADX
  smc.js               # BOS/CHoCH/FVG/Order Blocks/Liquidity Sweeps
  strategy.js          # بناء الإشارة والقرار
  risk.js              # حجم الصفقة والحدود اليومية
  engine.js            # حلقة المراقبة والتنفيذ والإغلاق
  app.js               # مسارات /api + الواجهة الثابتة
  ai.js                # Gemini (اختياري)
  telegram.js          # إشعارات وصور Telegram
  charts.js            # رسم الشارت PNG
  brokers/             # paper / mt5 bridge / expertoption (تحليل فقط)
tests/                 # اختبارات node --test
app/static/            # الواجهة العربية/الإنجليزية
app/                   # نسخة Python القديمة (مرجعية فقط، غير مستخدمة على Render)
data/                  # قاعدة البيانات والشارتات (غير مرفوعة إلى Git)
```

---

## 3. التشغيل محلياً

```bash
npm install
cp .env.example .env     # عدّل القيم حسب الحاجة
npm start                # http://localhost:8000
npm test                 # 12 اختباراً
```

المتطلبات: Node.js 20 أو أحدث.

---

## 4. متغيرات البيئة

| المتغير | الوصف |
| --- | --- |
| `PORT` | منفذ الخدمة (Render يمرّره تلقائياً) |
| `APP_SECRET_KEY` | مفتاح تشفير كلمات مرور الحسابات — استخدم قيمة عشوائية طويلة |
| `DASHBOARD_TOKEN` | رمز حماية لوحة التحكم (اختياري، يُطلب مرة واحدة في الواجهة) |
| `DATABASE_URL` | رابط PostgreSQL (اختياري). بدونه تُستخدم SQLite في `data/rozzlf.db` |
| `REAL_TRADING_APPROVED` | `false` افتراضياً. لا تغيّره إلا بموافقة صريحة |
| `MT5_ENABLED` | `true` فقط عند وجود جسر MT5 على Windows |
| `MT5_BRIDGE_URL` / `MT5_BRIDGE_TOKEN` | عنوان جسر MT5 ورمز الحماية |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | مراجعة Gemini الاختيارية |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | إشعارات Telegram |
| `SCAN_INTERVAL_SECONDS` | فاصل المسح (60 افتراضياً) |
| `DATABASE_PATH` | مسار SQLite بديل |

لا تُرفع ملفات `.env` أو المفاتيح إلى Git.

---

## 5. إدارة المخاطر المطبّقة

- حجم الصفقة محسوب من نسبة المخاطرة، ويُقرّب للأسفل بخطوات `0.01` حتى لا يتجاوز الميزانية.
- حد خسارة يومي كنسبة من الرصيد + حد أقصى للصفقات اليومية والمفتوحة.
- رفض الإشارة عند: انقطاع البيانات أو قدمها، السبريد العالي، ضعف الثقة، انخفاض R:R، تكرار الزوج.
- إيقاف تلقائي عند فقدان الاتصال، وإيقاف طارئ يدوي.
- لا تُفتح صفقة إلا بعد قبول الوسيط لها (`accepted`)، وتُسجَّل بعد القبول فقط.
- كل الإجراءات والأخطاء تُسجَّل في جدول `logs` وتظهر في الواجهة.

---

## 6. MT5

التنفيذ الحقيقي يحتاج:

1. Windows VPS أو جهاز Windows مع **MetaTrader 5** مثبّتاً ومسجّلاً الدخول.
2. جسر HTTP صغير يستخدم حزمة `MetaTrader5` الرسمية ويستقبل `POST /connect` و`/open` و`/close`.
3. `MT5_ENABLED=true` و`MT5_BRIDGE_URL` و`MT5_BRIDGE_TOKEN`.

بدون ذلك يعمل MT5 Demo في وضع `simulated` (Paper) على أسعار حقيقية. Render وحده لا يستطيع تشغيل
مكتبة MT5 لأنها تعتمد على Windows/الطرفية.

## 7. ExpertOption

لا يوجد API عام مصرّح به للتداول الآلي، ولذلك لا يتم تسجيل الدخول أو محاكاة النقرات.
نفس محرّك التحليل والتنبيهات يعمل للإشارات، بدون تنفيذ صفقات.

## 8. Telegram

عند فتح صفقة تُرسل صورة شارت مع الزوج والفريم والجانب والدخول/الوقف/الهدف والسبب والوقت.
عند الإغلاق تُرسل النتيجة WIN/LOSS والربح الفعلي وأسعار الدخول والخروج والمدة وصورة النتيجة.

## 9. Gemini

عند وجود `GEMINI_API_KEY` تُرسَل الإشارة المرشّحة للمراجعة. verdict = `REJECT` يمنع التنفيذ؛
`AGREE` / `CAUTION` تُسجَّل في السجل. غياب المفتاح لا يوقف البوت (تحليل قواعد فقط).

---

## 10. النشر على Render

إعدادات الخدمة (Node):

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check:** `/api/health`

`render.yaml` جاهز. للأسرار استخدم Environment Variables: `GEMINI_API_KEY`، `TELEGRAM_BOT_TOKEN`،
`TELEGRAM_CHAT_ID`، و`DATABASE_URL` إن أردت PostgreSQL.

**قيود تشغيلية:** خطة Render المجانية تنام بعد عدم النشاط ولا تضمن تشغيلاً متواصلاً 24/7،
والقرص المحلي مؤقت (تُفقد قاعدة SQLite والشارتات عند إعادة النشر). للاستمرارية استخدم
`DATABASE_URL` (PostgreSQL) وخطة مدفوعة أو Keep-alive خارجي حسب سياسة Render.

### عند ظهور `npm error enoent`

هذا يعني أن npm لم يجد `package.json` في مجلد البناء. تأكد في إعدادات خدمة Render من:

- **Root Directory:** فارغ (أو `.`) — وليس `app` أو أي مجلد فرعي.
- **Build Command:** `npm install`
- **Start Command:** `npm start`

المشروع موجود في جذر المستودع، و`app/package.json` مجرد توافق احتياطي لو بقي Root Directory
على `app`. بعد تعديل Root Directory احفظ الإعدادات ثم أعد النشر مع **Clear build cache**.


---

## 11. API مختصر

`GET /api/health` · `GET /api/config` · `POST /api/connect` · `POST /api/disconnect`
`GET /api/status` · `POST /api/bot/start|stop|emergency|reset-emergency`
`GET|POST /api/risk` · `POST /api/market/test` · `GET /api/trades` · `GET /api/logs`
`POST /api/telegram/test` · `GET /api/charts/:filename`

## 12. الأمان

- كلمات المرور مشفّرة AES-256-GCM ولا تُعاد للواجهة أو Telegram أو Gemini.
- ترويسات أمان (CSP, nosniff, no-referrer) وحماية اختيارية برمز لوحة التحكم.
- لا تُرفع أسرار إلى Git، ولا تُفعّل الصفقات الحقيقية تلقائياً.

---

## 13. English quick start

```bash
npm install
cp .env.example .env
npm start      # http://localhost:8000
npm test
```

Node.js 20+. Demo-only by default. Real execution requires `REAL_TRADING_APPROVED=true` and, for
MT5, a Windows host running the MetaTrader 5 terminal plus the HTTP bridge. ExpertOption has no
approved public trading API, so it is analysis and alerts only.

## 14. حدود معروفة

- لا يمكن اختبار الصفقات الحقيقية أو منصة MT5 هنا (تحتاج Windows + MT5).
- Telegram وGemini يحتاجان مفاتيح حقيقية للتحقق النهائي.
- في عطلة السوق تُرفض البيانات القديمة عمداً، فلا تُفتح صفقات.
