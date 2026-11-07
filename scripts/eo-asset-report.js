'use strict';

// Reads the connected ExpertOption account through the ROZLF backend and prints a
// per-asset / per-duration availability report. Read-only: no order is ever sent.
//
//   node scripts/eo-asset-report.js [http://127.0.0.1:3333]
//
// Requires the backend to have a verified ExpertOption session (login page or
// EXPERTOPTION_SESSION_TOKEN) and the bridge to be reachable.

const BASE = process.argv[2] || process.env.ROZLF_URL || 'http://127.0.0.1:3333';
const ASSETS = [
  ['smarty', 'Smarty', 240],
  ['cricket-index', 'Cricket Index', 276],
  ['football-index', 'Football Index', 278],
  ['ai-index', 'AI Index', 285],
  ['luxury-index', 'Luxury Index', 286],
  ['eurusd-otc', 'EUR/USD OTC', 179],
  ['gbpusd-otc', 'GBP/USD OTC', 180],
  ['usdjpy-otc', 'USD/JPY OTC', 181],
  ['usdchf-otc', 'USD/CHF OTC', 182],
];
const EXPIRIES = ['30s', '1m', '2m', '3m', '5m'];

async function call(path, init) {
  const res = await fetch(BASE + path, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  const health = await call('/api/health');
  console.log(`backend ${BASE} health=${health.status}`);

  const session = await call('/api/expertoption/session');
  const connected = Boolean(session.body?.connected || session.body?.expertoption?.connected);
  console.log(`session state=${session.body?.connection_state || session.body?.expertoption?.connection_state || 'unknown'} connected=${connected}`);
  if (!connected) {
    console.log('No verified ExpertOption session. Attach the account token first; no report can be produced from real data.');
    process.exit(2);
  }

  const assets = await call('/api/expertoption/assets');
  const rows = new Map((assets.body?.assets || []).map((a) => [a.key, a]));
  console.log('');

  let anyOk = false;
  for (const [key, label, hint] of ASSETS) {
    const row = rows.get(key);
    if (!row) {
      console.log(`${label.padEnd(16)} hint=${hint}  NOT IN CATALOG`);
      continue;
    }
    if (!row.available) {
      console.log(`${label.padEnd(16)} hint=${hint}  NOT IN ACCOUNT (id=${row.id || '-'} reason=${row.reason || 'absent'})`);
      continue;
    }
    console.log(`${label.padEnd(16)} id=${String(row.id).padEnd(4)} active=${row.active ? 'yes' : 'no '} payout=${row.payout ?? '-'}`);
    for (const expiry of EXPIRIES) {
      const res = await call('/api/expertoption/auto-analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset_id: key, expiry }),
      });
      const b = res.body || {};
      if (b.ok) anyOk = true;
      const verdict = b.ok
        ? `${b.direction} ${Math.round((b.confidence || 0) * 100)}% tf=${b.timeframe}`
        : `NO TRADE ${b.reason_code || res.status}`;
      console.log(`  ${expiry.padEnd(3)} ${verdict}`);
    }
    console.log('');
  }

  console.log(anyOk ? 'At least one asset produced a verified analysis from real candles.' : 'No asset produced a verified analysis. Reasons are printed above; nothing was invented.');
  process.exit(0);
})().catch((err) => {
  console.error('report failed:', err.message);
  process.exit(1);
});
