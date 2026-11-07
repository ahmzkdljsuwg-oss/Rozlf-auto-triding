'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { ema } = require('./indicators');

const WIDTH = 1100;
const HEIGHT = 620;
const BG = '#0b1220';
const PANEL = '#0f172a';
const GRID = '#1e293b';
const TEXT = '#cbd5e1';
const MUTED = '#64748b';
const UP = '#22c55e';
const DOWN = '#ef4444';
const BLUE = '#38bdf8';
const PURPLE = '#a78bfa';
const YELLOW = '#facc15';

function money(value) {
  return Number(value).toFixed(value >= 100 ? 2 : 5);
}

function drawChart(options) {
  const {
    symbol, timeframe, side, candles, entry, stopLoss, takeProfit,
    exitPrice = null, pnl = null, result = null, footer = '',
  } = options;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const margin = { left: 24, right: 104, top: 76, bottom: 46 };
  const plotW = WIDTH - margin.left - margin.right;
  const plotH = HEIGHT - margin.top - margin.bottom;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = PANEL;
  ctx.fillRect(margin.left, margin.top, plotW, plotH);

  const view = candles.slice(-90);
  if (!view.length) return canvas;

  let low = Math.min(...view.map((c) => c.low));
  let high = Math.max(...view.map((c) => c.high));
  const marks = [entry, stopLoss, takeProfit, exitPrice].filter((v) => Number.isFinite(v) && v > 0);
  for (const v of marks) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  const pad = (high - low) * 0.08 || high * 0.001 || 1;
  low -= pad;
  high += pad;
  const y = (price) => margin.top + plotH - ((price - low) / (high - low)) * plotH;
  const step = plotW / view.length;
  const width = Math.max(2, Math.min(10, step * 0.62));

  // grid + price labels
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i += 1) {
    const py = margin.top + (plotH / 5) * i;
    const price = high - ((high - low) / 5) * i;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, py);
    ctx.lineTo(margin.left + plotW, py);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(money(price), margin.left + plotW + 10, py);
  }

  // candles
  view.forEach((candle, index) => {
    const cx = margin.left + step * (index + 0.5);
    const color = candle.close >= candle.open ? UP : DOWN;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, y(candle.high));
    ctx.lineTo(cx, y(candle.low));
    ctx.stroke();
    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));
    ctx.fillRect(cx - width / 2, top, width, Math.max(1, bottom - top));
  });

  // EMA overlays
  const closes = view.map((c) => c.close);
  const plotLine = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    values.forEach((v, index) => {
      if (!Number.isFinite(v)) return;
      const px = margin.left + step * (index + 0.5);
      const py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    });
    ctx.stroke();
  };
  plotLine(ema(closes, 20), BLUE);
  plotLine(ema(closes, 50), PURPLE);

  // levels
  const level = (price, color, label) => {
    if (!Number.isFinite(price) || price <= 0) return;
    const py = y(price);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(margin.left, py);
    ctx.lineTo(margin.left + plotW, py);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(label, margin.left + 8, py - 10);
  };
  level(entry, YELLOW, `ENTRY ${money(entry)}`);
  level(stopLoss, DOWN, `SL ${money(stopLoss)}`);
  level(takeProfit, UP, `TP ${money(takeProfit)}`);
  level(exitPrice, BLUE, `EXIT ${money(exitPrice)}`);

  // header
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(`${symbol} ${timeframe} | ${side}`, margin.left, 42);

  ctx.font = '13px sans-serif';
  ctx.fillStyle = MUTED;
  ctx.fillText('ROZLF AUTO TRADER', WIDTH - margin.right - 168, 32);

  if (result) {
    ctx.textAlign = 'right';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = result === 'WIN' ? UP : DOWN;
    const pnlText = Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${Number(pnl).toFixed(2)} USD` : '';
    ctx.fillText(`${result} ${pnlText}`, WIDTH - margin.right, 32);
  }

  // footer + timestamp labels
  ctx.textAlign = 'left';
  ctx.font = '12px sans-serif';
  ctx.fillStyle = MUTED;
  if (footer) ctx.fillText(footer, margin.left, HEIGHT - 16);

  const first = view[0].time * 1000;
  const last = view[view.length - 1].time * 1000;
  ctx.textAlign = 'right';
  ctx.fillText(new Date(first).toISOString().slice(5, 16).replace('T', ' '), margin.left + plotW, HEIGHT - 16);
  ctx.textAlign = 'left';
  ctx.fillText(new Date(last).toISOString().slice(5, 16).replace('T', ' '), margin.left + 350, HEIGHT - 16);

  return canvas;
}

async function renderTradeChart({
  symbol, timeframe, side, candles, entry, stopLoss, takeProfit, outputDir,
}) {
  const canvas = drawChart({
    symbol, timeframe, side, candles, entry, stopLoss, takeProfit,
    footer: `Opened ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC | EMA20/50`,
  });
  const filename = `trade_${symbol}_${timeframe}_${Date.now()}.png`;
  const outputPath = path.join(outputDir, filename);
  await fs.promises.writeFile(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}

async function renderResultChart({
  symbol, timeframe, side, candles, entry, stopLoss, takeProfit,
  exitPrice, pnl, result, outputDir,
}) {
  const canvas = drawChart({
    symbol, timeframe, side, candles, entry, stopLoss, takeProfit,
    exitPrice, pnl, result,
    footer: `Closed ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  });
  const filename = `result_${symbol}_${timeframe}_${Date.now()}.png`;
  const outputPath = path.join(outputDir, filename);
  await fs.promises.writeFile(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}

async function renderAnalysisChart({
  symbol, timeframe, direction, candles, price, outputDir, expiryLabel = '', confidence = null,
}) {
  const side = direction === 'UP' ? 'BUY' : (direction === 'DOWN' ? 'SELL' : 'NO TRADE');
  const confidenceText = Number.isFinite(Number(confidence)) ? ` | ${Math.round(Number(confidence) * 100)}%` : '';
  const canvas = drawChart({
    symbol,
    timeframe,
    side,
    candles,
    entry: price,
    footer: `${direction} ${expiryLabel}${confidenceText} | ROZLF analysis${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  });
  const filename = `analysis_${String(symbol || 'asset').replace(/[^\w.-]/g, '_')}_${timeframe}_${Date.now()}.png`;
  const outputPath = path.join(outputDir, filename);
  await fs.promises.writeFile(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}

module.exports = { renderTradeChart, renderResultChart, renderAnalysisChart };
