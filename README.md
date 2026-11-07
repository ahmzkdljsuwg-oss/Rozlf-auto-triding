# ROZLF AUTO TRADER

منصة تداول آلي مستقلة عن موقع ROZLF، مبنية بـ **FastAPI + SQLite + واجهة ويب** عربية/إنجليزية.
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
| صور الشارت ونتائج الصفقات | ✅ matplotlib |
| Gemini AI (اختياري) | ✅ عند وجود `GEMINI_API_KEY` |
| إشعارات Telegram (اختياري) | ✅ عند وجود token + chat id |
| MT5 حقيقي | ⚠️ يحتاج Windows + MT5 Terminal + `MT5_ENABLED=true` |
| ExpertOption تنفيذ | ❌ لا يوجد API عام مصرّح به — تحليل وتنبيهات فقط |

---

## 2. هيكل المشروع

```
app/
  main.py            # FastAPI app + static + security headers
  api.py             # كل مسارات /api المحمية
  config.py          # الإعدادات من متغيرات البيئة
  security.py        # تشفير كلمات المرور (Fernet) + قناع الحساب
  db.py              # SQLite: accounts, trades, logs, settings
  market_data.py     # Yahoo Finance + كاش + سبريد + pip
  indicators.py      # EMA/SMA/RSI/MACD/Bollinger/ATR/ADX
  smc.py             # BOS/CHoCH/FVG/OB/Liquidity sweep
  strategy.py        # تسجيل متعدد الفريمات → Signal
  risk.py            # حجم الصفقة + كل بوابات الحماية
  engine.py          # حلقة المراقبة، التنفيذ، الإغلاق، التنبيهات
  ai.py              # مراجعة Gemini
  charts.py          # صور الدخول والنتيجة
  telegram.py        # نصوص + صور Telegram
  brokers/
    base.py          # الواجهة المشتركة
    paper.py         # بروكر Demo بمحاكاة تنفيذ
    mt5.py           # جسر MT5 رسمي (Windows)
    expertoption.py  # تحليل فقط
  static/            # SPA: index.html, css, js (AR/EN, RTL, mobile)
tests/               # 25 اختباراً
```

---

## 3. التشغيل محلياً

يتطلب **Python 3.11+** (تم الاختبار على 3.13).

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env             # عدّل القيم
uvicorn app.main:app --reload --port 8000
```

افتح: **http://localhost:8000**

المسار: اختر **MT5** → **Demo** → أدخل أي Login/Password → **تسجيل الدخول**.
في وضع Demo لا تُرسل بياناتك لأي وسيط؛ كلمة المرور تُشفّر وتُستخدم فقط لفتح جلسة المحاكاة.

### الاختبارات

```bash
pip install -r requirements-dev.txt
python -m pytest -q
# 25 passed
```

تم تنفيذها فعلاً على هذا المستودع: مؤشرات، استراتيجية، إدارة مخاطر، بروكر Demo،
وكل مسارات API (بما فيها قفل Real ومنع `path traversal` للشارتات).
كما نُفّذ سيناريو تكامل كامل: فتح صفقة → منع تكرارها → إغلاقها على الهدف → ربح → إيقاف طارئ.

---

## 4. متغيرات البيئة

| المتغير | الوصف |
| --- | --- |
| `APP_SECRET_KEY` | مفتاح تشفير كلمات المرور المخزّنة. إلزامي في الإنتاج. |
| `DASHBOARD_TOKEN` | إن وُضع، كل `/api` تحتاج ترويسة `X-Dashboard-Token`. |
| `REAL_TRADING_APPROVED` | `false` افتراضياً. `true` فقط بعد موافقتك الصريحة. |
| `MT5_ENABLED` / `MT5_TERMINAL_PATH` | تفعيل جسر MT5 على Windows. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | مراجعة AI اختيارية. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | إشعارات Telegram اختيارية. |
| `SCAN_INTERVAL_SECONDS` | دورية المسح (افتراضي 60). |
| `SYMBOLS` / `TIMEFRAMES` | قوائم مفصولة بفواصل. |
| `DEMO_START_BALANCE` | رصيد حساب Demo الافتراضي (10000). |

لا يوجد أي مفتاح مكتوب داخل الكود. `.env` مستثنى من Git.

---

## 5. إدارة المخاطر المطبّقة

قبل أي صفقة يجب أن تتحقق **كل** الشروط:

- حد خسارة يومي (نسبة من الرصيد) — افتراضي 3%.
- مخاطرة لكل صفقة — افتراضياً 0.5% (حجم اللوت يُقرّب للأسفل حتى لا يتجاوزها).
- حد أقصى للصفقات المفتوحة وللصفقات اليومية.
- منع صفقة ثانية على نفس الزوج.
- فحص السبريد مقابل الحد الأقصى.
- فحص الانزلاق السعري في البروكر.
- رفض البيانات القديمة/المنقطعة (السوق مغلق = لا صفقات).
- إيقاف فوري عند الضغط على **إيقاف طارئ**.
- R:R أدنى 1.4، وحد أدنى للثقة.
- لا تُفتح صفقة إلا بعد قبول البروكر لها (`accepted == true`).

---

## 6. MT5 — التشغيل الحقيقي

مكتبة `MetaTrader5` الرسمية تعمل على **Windows فقط** مع تثبيت منصة MT5.
لذلك لا يمكن لـ Render (Linux) تنفيذ صفقات MT5.

السيناريو المدعوم:

1. Windows VPS / جهاز Windows مع MT5 مسجّل دخول لحساب Demo.
2. `pip install MetaTrader5` داخل نفس البيئة.
3. `MT5_ENABLED=true`, `MT5_TERMINAL_PATH=...`.
4. تشغيل خادم ROZLF على نفس الجهاز (أو ربطه بشكل آمن بالخادم).
5. التأكد أن الحساب Demo في MT5 يطابق رقم الحساب المُدخل.

بدون ذلك يبقى التنفيذ على محرك المحاكاة (Paper) بأسعار حقيقية.

---

## 7. ExpertOption

لا يوجد API عام موثّق يسمح بالتداول الآلي. المشروع **لا** يستخدم تسجيل دخول آلياً غير مصرّح به،
ولا محاكاة نقرات، ولا endpoints غير موثقة. عند اختيار ExpertOption:

- يتم فتح جلسة "تحليل فقط" (analysis_only).
- تُنشر الفرص والتحليل والشارتات والتنبيهات.
- **لا يُدّعى** تنفيذ أي صفقة.

---

## 8. Telegram

1. أنشئ بوتاً عبر `@BotFather` وخُذ التوكن.
2. أضف البوت للقناة/المحادثة واحصل على `chat_id`.
3. ضع القيمتين في البيئة.
4. من لوحة التحكم: **اختبار Telegram**.

عند الفتح: صورة شارت + الزوج/الفريم/الاتجاه + Entry/SL/TP + السبب + الوقت.
عند الإغلاق: WIN/LOSS + PnL الفعلي من الحساب + سعر الدخول والخروج + المدة + صورة النتيجة.
إذا لم تُضبط القيم تبقى الإشعارات معطّلة ويظهر ذلك في اللوحة (لا فشل صامت).

---

## 9. Gemini

اختياري تماماً. عند وجود المفتاح تُرسل آخر تحليل مُجمّع (بدون كلمات مرور) ويُطلب JSON
بحقول `verdict`, `confidence`, `rationale`. يمكن لـ Gemini الاعتراض على صفقة،
لكنه لا يستطيع تجاوز بوابات إدارة المخاطر. عند غياب المفتاح أو فشل الاتصال يظهر
`UNAVAILABLE` ولا تُختلق نتائج.

---

## 10. النشر على Render

المستودع يحتوي `render.yaml` جاهزاً:

- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Health: `/api/health`

أضف القيم السرية من لوحة Render (`sync: false`) ثم Deploy.

### قيود Render المجانية (مهمة)

- الخدمة **تنام** بعد فترة خمول وتستيقظ عند أول طلب (بطء أول استجابة).
- نظام الملفات **مؤقت**: قاعدة SQLite والشارتات قد تُفقد عند إعادة النشر أو إعادة التشغيل.
  للإنتاج استخدم Persistent Disk أو PostgreSQL.
- لا يمكن تشغيل MT5 الحقيقي على Render (يحتاج Windows).
- الخطة المجانية لا تضمن تشغيلاً متواصلاً 24/7.

---

## 11. API مختصر

| Method | Path | الوظيفة |
| --- | --- | --- |
| GET | `/api/health` | فحص الصحة |
| GET | `/api/config` | المنصات والأوضاع المتاحة |
| GET | `/api/session` | هل توجد جلسة |
| POST | `/api/connect` | ربط حساب Demo (Real مرفوض 403) |
| POST | `/api/disconnect` | فصل الحساب |
| GET/POST | `/api/risk` | قراءة/تحديث إعدادات المخاطر |
| GET | `/api/status` | حالة المحرك والرصيد والفرص |
| POST | `/api/bot/start` \| `/stop` \| `/emergency` | التحكم |
| GET | `/api/trades` | السجل |
| GET | `/api/logs` | السجلات |
| POST | `/api/telegram/test` | اختبار Telegram |
| POST | `/api/market/test` | اختبار بيانات السوق |
| GET | `/api/charts/{file}` | صور الشارت (محمية) |

جميع المسارات تقبل `X-Dashboard-Token` عند ضبطه.

---

## 12. الأمان

- كلمات المرور مشفّرة بـ Fernet (مفتاح مشتق من `APP_SECRET_KEY`) ولا تُعاد للواجهة أبداً.
- لا تُرسل كلمات المرور إلى Gemini أو Telegram.
- واجهات API محمية بـ token اختياري، مع منع `path traversal` في ملفات الشارت.
- ترويسات أمان: `nosniff`, `DENY`, `no-referrer`, `no-store` لواجهات API.
- سجل كامل للعمليات والأخطاء في قاعدة البيانات.
- Real mode يحتاج موافقة صريحة + بروكر مسموح.

---

## 13. English quick start

```bash
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 → pick **MT5** → **Demo** → sign in.
Demo uses live Yahoo prices with simulated fills. Real-money execution is locked
(`REAL_TRADING_APPROVED=false`). ExpertOption is analysis-only by design.
MT5 live orders require Windows + MetaTrader 5. Tests: `python -m pytest -q`.

---

## 14. حدود معروفة

- البيانات من Yahoo Finance قد تتأخر أو تنقطع؛ عندها يتوقف التداول بدل التخمين.
- لا يوجد ضمان لربح، ولا تُستخدم مخاطرة غير محدودة.
- ExpertOption بلا تنفيذ.
- إشعارات Telegram تحتاج اعتمادك للتوكن.
- MT5 غير مختبَر تنفيذياً هنا لعدم توفر Windows في بيئة البناء.

هذا المشروع أداة تحليل وتنفيذ تجريبي، وليس نصيحة استثمارية.
