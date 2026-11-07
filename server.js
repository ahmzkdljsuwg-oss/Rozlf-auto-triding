'use strict';

const config = require('./src/config');
const { Database } = require('./src/db');
const { TradingEngine } = require('./src/engine');
const { createApp } = require('./src/app');
const { TelegramBotController } = require('./src/telegram_bot');

async function main() {
  const db = await new Database().init();
  const engine = await new TradingEngine({ db }).init();
  const telegramBot = new TelegramBotController({ notifier: engine.telegram, engine });
  await telegramBot.start();
  await db.addLog('info', 'app', `ROZLF AUTO TRADER ${config.APP_VERSION} starting`);

  const app = createApp({ engine });
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`ROZLF AUTO TRADER listening on port ${config.PORT} (database: ${db.driver})`);
    console.log(`Demo execution mode; real trading approved: ${config.REAL_TRADING_APPROVED}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    server.close();
    try { await telegramBot.stop(); } catch { /* ignore */ }
    try { await engine.shutdown(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    db.addLog('error', 'process', `Unhandled rejection: ${err}`).catch(() => {});
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
