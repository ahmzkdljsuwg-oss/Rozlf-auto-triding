'use strict';

function findSwings(candles, lookback = 3) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const maxHigh = Math.max(...window.map((c) => c.high));
    const minLow = Math.min(...window.map((c) => c.low));
    if (candles[i].high >= maxHigh) {
      swings.push({ index: i, price: candles[i].high, type: 'high', time: candles[i].time });
    }
    if (candles[i].low <= minLow) {
      swings.push({ index: i, price: candles[i].low, type: 'low', time: candles[i].time });
    }
  }
  return swings;
}

function detectBosChoch(candles, swings) {
  if (candles.length < 10 || !swings.length) {
    return { bos: null, choch: null, bias: 'neutral', break_level: null, notes: [] };
  }
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  const lastClose = candles[candles.length - 1].close;
  const notes = [];
  let bos = null;
  let choch = null;
  let breakLevel = null;

  if (highs.length && lastClose > highs[highs.length - 1].price) {
    bos = 'bullish';
    breakLevel = highs[highs.length - 1].price;
    notes.push(`Bullish BOS above ${breakLevel.toFixed(5)}`);
  } else if (lows.length && lastClose < lows[lows.length - 1].price) {
    bos = 'bearish';
    breakLevel = lows[lows.length - 1].price;
    notes.push(`Bearish BOS below ${breakLevel.toFixed(5)}`);
  }

  if (highs.length >= 2 && lows.length >= 2) {
    const recentHighs = highs.slice(-2);
    const recentLows = lows.slice(-2);
    const risingHighs = recentHighs[1].price > recentHighs[0].price;
    const risingLows = recentLows[1].price > recentLows[0].price;
    const fallingHighs = recentHighs[1].price < recentHighs[0].price;
    const fallingLows = recentLows[1].price < recentLows[0].price;
    if (fallingHighs && fallingLows && bos === 'bullish') {
      choch = 'bullish';
      notes.push('Bullish CHoCH: bearish structure broken');
    } else if (risingHighs && risingLows && bos === 'bearish') {
      choch = 'bearish';
      notes.push('Bearish CHoCH: bullish structure broken');
    }
  }

  const bias = bos === 'bullish' || choch === 'bullish'
    ? 'bullish'
    : bos === 'bearish' || choch === 'bearish' ? 'bearish' : 'neutral';

  return {
    bos,
    choch,
    bias,
    break_level: breakLevel,
    last_swing_high: highs.length ? highs[highs.length - 1].price : null,
    last_swing_low: lows.length ? lows[lows.length - 1].price : null,
    notes,
  };
}

function detectFvg(candles, maxAge = 40) {
  const gaps = [];
  const start = Math.max(2, candles.length - maxAge);
  for (let i = start; i < candles.length; i += 1) {
    const prev2 = candles[i - 2];
    const cur = candles[i];
    let gap = null;
    if (cur.low > prev2.high) {
      gap = {
        type: 'bullish', top: cur.low, bottom: prev2.high,
        index: i, time: cur.time, filled: false,
      };
    } else if (cur.high < prev2.low) {
      gap = {
        type: 'bearish', top: prev2.low, bottom: cur.high,
        index: i, time: cur.time, filled: false,
      };
    }
    if (!gap) continue;
    for (let j = i + 1; j < candles.length; j += 1) {
      const later = candles[j];
      if (gap.type === 'bullish' && later.low <= gap.bottom) { gap.filled = true; break; }
      if (gap.type === 'bearish' && later.high >= gap.top) { gap.filled = true; break; }
    }
    gaps.push(gap);
  }
  return gaps;
}

function detectOrderBlocks(candles, maxAge = 60) {
  const blocks = [];
  const start = Math.max(1, candles.length - maxAge);
  for (let i = start; i < candles.length; i += 1) {
    const cur = candles[i];
    const body = Math.abs(cur.close - cur.open);
    const recent = candles.slice(Math.max(0, i - 10), i);
    if (!recent.length) continue;
    const avgBody = recent.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / recent.length || 1e-9;
    if (cur.close > cur.open && body > avgBody * 1.8) {
      for (let j = i - 1; j > Math.max(-1, i - 8); j -= 1) {
        if (candles[j].close < candles[j].open) {
          blocks.push({
            type: 'bullish',
            top: Math.max(candles[j].open, candles[j].close),
            bottom: candles[j].low,
            index: j,
            time: candles[j].time,
          });
          break;
        }
      }
    } else if (cur.close < cur.open && body > avgBody * 1.8) {
      for (let j = i - 1; j > Math.max(-1, i - 8); j -= 1) {
        if (candles[j].close > candles[j].open) {
          blocks.push({
            type: 'bearish',
            top: candles[j].high,
            bottom: Math.min(candles[j].open, candles[j].close),
            index: j,
            time: candles[j].time,
          });
          break;
        }
      }
    }
  }
  return blocks.slice(-6);
}

function detectLiquiditySweep(candles, swings, lookback = 20) {
  if (candles.length < lookback) return { sweep: null, level: null, note: '' };
  const highs = swings.filter((s) => s.type === 'high' && s.index < candles.length - 2);
  const lows = swings.filter((s) => s.type === 'low' && s.index < candles.length - 2);
  const last = candles[candles.length - 1];
  if (highs.length) {
    const priorHigh = highs[highs.length - 1].price;
    if (last.high > priorHigh && last.close < priorHigh) {
      return { sweep: 'bearish', level: priorHigh, note: 'Liquidity swept above prior high then rejected' };
    }
  }
  if (lows.length) {
    const priorLow = lows[lows.length - 1].price;
    if (last.low < priorLow && last.close > priorLow) {
      return { sweep: 'bullish', level: priorLow, note: 'Liquidity swept below prior low then reclaimed' };
    }
  }
  return { sweep: null, level: null, note: '' };
}

function analyzeStructure(candles) {
  const swings = findSwings(candles);
  const structure = detectBosChoch(candles, swings);
  const gaps = detectFvg(candles);
  const blocks = detectOrderBlocks(candles);
  const sweep = detectLiquiditySweep(candles, swings);
  const activeGaps = gaps.filter((g) => !g.filled);
  return {
    swings: swings.slice(-8),
    structure,
    fvg: activeGaps.slice(-3),
    order_blocks: blocks,
    liquidity_sweep: sweep,
    notes: structure.notes.concat(sweep.note ? [sweep.note] : []),
  };
}

module.exports = {
  findSwings, detectBosChoch, detectFvg, detectOrderBlocks,
  detectLiquiditySweep, analyzeStructure,
};
