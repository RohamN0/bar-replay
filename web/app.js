"use strict";

/* ============================================================
   Bar Replay — crypto candlestick replay tool
   - Fetches OHLCV + indicators from /api/ohlcv (Python backend)
   - Indicator list is discovered from the backend's indicators/ directory
   - Falls back to JS-synthetic data + JS indicators offline
   - Renders its own candlestick chart (no external chart library)
   - Per-indicator parameters (TradingView-style gear settings dialog):
     server-side recompute with the Python backend, JS mirror offline
   ============================================================ */

// ---------- DOM refs ----------
function el(id){ return document.getElementById(id); }
const canvas = el("chart");
const ctx = canvas.getContext("2d");
const wrap = el("canvasWrap");
const emptyState = el("emptyState");
const crossTip = el("crossTip");
const chipsEl = el("indicatorChips");

const symbolInput = el("symbol");
const tfSelect = el("timeframe");
const limitInput = el("limit");
const fetchBtn = el("fetchBtn");
const sourceBadge = el("sourceBadge");

const playBtn = el("playBtn");
const startBtn = el("startBtn");
const endBtn = el("endBtn");
const stepBackBtn = el("stepBackBtn");
const stepFwdBtn = el("stepFwdBtn");
const speedSelect = el("speedSelect");
const progress = el("progress");
const counter = el("counter");
const barTime = el("barTime");

const ohlcReadout = el("ohlcReadout");
const indReadout = el("indReadout");

const errorBanner = el("errorBanner");
const errorText = el("errorText");
const errorClose = el("errorClose");

const settingsBackdrop = el("settingsBackdrop");
const settingsTitle = el("settingsTitle");
const paramGrid = el("paramGrid");
const settingsClose = el("settingsClose");
const settingsDefaults = el("settingsDefaults");
const settingsCancel = el("settingsCancel");
const settingsOk = el("settingsOk");

let loadSeq = 0; // guards against out-of-order fetch responses

function showError(msg){
  if (!msg){ hideError(); return; }
  errorText.textContent = msg;
  errorBanner.hidden = false;
}

function hideError(){
  errorBanner.hidden = true;
  errorText.textContent = "";
}

errorClose.addEventListener("click", hideError);

// ---------- palette ----------
const COLORS = {
  bg: "#0b0f14",
  grid: "rgba(255,255,255,0.06)",
  axis: "#8b98a9",
  up: "#26a69a",
  down: "#ef5350",
  cross: "rgba(255,255,255,0.28)",
  level: "rgba(255,255,255,0.35)",
  now: "rgba(255,197,66,0.6)",
  histUp: "rgba(38,166,154,0.8)",
  histDown: "rgba(239,83,80,0.8)",
};

// ---------- state ----------
const state = {
  bars: [],
  ind: {},             // seriesKey -> {group,label,color,kind,width,dash,pane,values[]}
  indicatorList: [],   // [{id,name,pane,params}]
  selected: new Set(), // selected indicator ids
  params: {},          // indicatorId -> {paramKey: number} (active values incl. defaults)
  count: 0,
  playing: false,
  speedMs: 400,
  timer: null,
  hover: -1,
  mouseY: null,
  source: "",
  live: false,         // true when the Python backend answered the last load
};

// ---------- small helpers ----------
const round8 = (v) => Math.round(v * 1e8) / 1e8;

function fmtTime(t){
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function fmtPrice(v){
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}
function fmtNum(v){
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
function fmtVol(v){
  if (v == null || !isFinite(v)) return "–";
  if (v >= 1e9) return (v/1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v/1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v/1e3).toFixed(1) + "k";
  return v.toFixed(1);
}
function fmtAxis(v){
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

// ---------- indicator math (JS mirrors of the Python indicators/) ----------
function emaArr(vals, len){
  const k = 2 / (len + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++){
    prev = (prev == null) ? vals[i] : vals[i]*k + prev*(1-k);
    out.push(prev);
  }
  return out;
}
function smaArr(vals, len){
  const out = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i++){
    sum += vals[i];
    if (i >= len) sum -= vals[i - len];
    out.push(i >= len - 1 ? sum/len : null);
  }
  return out;
}
function rmaArr(vals, len){
  const alpha = 1 / len;
  const out = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++){
    const v = vals[i];
    if (v == null || isNaN(v)){ out.push(prev); continue; }
    prev = (prev == null) ? v : v*alpha + prev*(1-alpha);
    out.push(prev);
  }
  return out;
}
function rsiArr(close, len = 14){
  const out = new Array(close.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < close.length; i++){
    const d = close[i] - close[i-1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= len){
      avgG += g; avgL += l;
      if (i === len){
        avgG /= len; avgL /= len;
        out[i] = avgL === 0 ? 100 : 100 - 100/(1 + avgG/avgL);
      }
    } else {
      avgG = (avgG*(len-1) + g) / len;
      avgL = (avgL*(len-1) + l) / len;
      out[i] = avgL === 0 ? 100 : 100 - 100/(1 + avgG/avgL);
    }
  }
  return out;
}
function macdArr(close, f = 12, s = 26, sig = 9){
  const ef = emaArr(close, f), es = emaArr(close, s);
  const line = ef.map((v, i) => v - es[i]);
  const signal = emaArr(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { macd: line, signal, hist };
}
function bollingerArr(close, len = 20, mult = 2){
  const mid = smaArr(close, len);
  const upper = [], lower = [];
  for (let i = 0; i < close.length; i++){
    if (i < len - 1){ upper.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - len + 1; j <= i; j++) sum += close[j];
    const mean = sum / len;
    let sq = 0;
    for (let j = i - len + 1; j <= i; j++) sq += (close[j] - mean) * (close[j] - mean);
    const sd = Math.sqrt(sq / len);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return { mid, upper, lower };
}
function dslLinesArr(src, length, mode){
  const sma = smaArr(src, length);
  const k = mode / length;
  const up = [], dn = [];
  let pu = 0, pd = 0;
  for (let i = 0; i < src.length; i++){
    const s = src[i], sm = sma[i];
    if (sm != null && !isNaN(sm)){
      if (s > sm) pu = pu + k * (s - pu);
      if (s < sm) pd = pd + k * (s - pd);
    }
    up.push(pu); dn.push(pd);
  }
  return { up, dn };
}
function zlemaArr(src, length){
  const lag = Math.floor((length - 1) / 2);
  const emaData = src.map((v, i) => 2 * v - (i - lag >= 0 ? src[i - lag] : v));
  return emaArr(emaData, length);
}
function atrArr(high, low, close, len = 14){
  const tr = [];
  for (let i = 0; i < close.length; i++){
    if (i === 0){ tr.push(high[i] - low[i]); continue; }
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i-1]), Math.abs(low[i] - close[i-1])));
  }
  return rmaArr(tr, len);
}
function supertrendArr(high, low, close, len = 10, mult = 3){
  const atr = atrArr(high, low, close, len);
  const upper = high.map((h, i) => (h + low[i]) / 2 + mult * atr[i]);
  const lower = high.map((h, i) => (h + low[i]) / 2 - mult * atr[i]);
  const n = close.length;
  const fU = new Array(n), fL = new Array(n);
  const trend = new Array(n).fill(0), dir = new Array(n).fill(0);
  // seed with the first band values (undefined seeds would propagate forever)
  fU[0] = upper[0];
  fL[0] = lower[0];
  for (let i = 1; i < n; i++){
    fU[i] = (upper[i] < fU[i-1] || close[i-1] > fU[i-1]) ? upper[i] : fU[i-1];
    fL[i] = (lower[i] > fL[i-1] || close[i-1] < fL[i-1]) ? lower[i] : fL[i-1];
    if (close[i] > fU[i-1]) trend[i] = 1;
    else if (close[i] < fL[i-1]) trend[i] = -1;
    else trend[i] = trend[i-1];
    if (trend[i] === 1 && trend[i-1] === -1) dir[i] = 1;
    else if (trend[i] === -1 && trend[i-1] === 1) dir[i] = -1;
    else dir[i] = dir[i-1];
  }
  const st = new Array(n);
  for (let i = 0; i < n; i++) st[i] = dir[i] === 1 ? fL[i] : fU[i];
  return st;
}
function wmaArr(vals, len){
  const out = [];
  const denom = len * (len + 1) / 2;
  for (let i = 0; i < vals.length; i++){
    if (i < len - 1){ out.push(null); continue; }
    let s = 0, ok = true;
    for (let j = 0; j < len; j++){
      const v = vals[i - len + 1 + j];
      if (v == null || !isFinite(v)){ ok = false; break; }
      s += v * (j + 1);
    }
    out.push(ok ? s / denom : null);
  }
  return out;
}
function medianArr(vals, len){
  const out = [];
  for (let i = 0; i < vals.length; i++){
    if (i < len - 1){ out.push(null); continue; }
    const win = [];
    let ok = true;
    for (let j = i - len + 1; j <= i; j++){
      const v = vals[j];
      if (v == null || !isFinite(v)){ ok = false; break; }
      win.push(v);
    }
    if (!ok){ out.push(null); continue; }
    win.sort((a, b) => a - b);
    const mid = len >> 1;
    out.push(len % 2 ? win[mid] : (win[mid - 1] + win[mid]) / 2);
  }
  return out;
}
function hmaArr(vals, len){
  const half = Math.max(1, Math.floor(len / 2));
  const sq = Math.max(1, Math.round(Math.sqrt(len)));
  const a = wmaArr(vals, half), b = wmaArr(vals, len);
  const diff = a.map((v, i) => (v == null || b[i] == null) ? null : 2 * v - b[i]);
  return wmaArr(diff, sq);
}
function zigzagNodes(bars, dev){
  // dev is a fraction (0.02 = 2%). Single pass, as-of the last bar of `bars`.
  const n = bars.length;
  const pivots = [];
  if (n === 0) return { pivots, pending: null };
  let dir = 0; // 0 undetermined, +1 up leg (tracking high), -1 down leg
  let hi = bars[0].high, hiI = 0, lo = bars[0].low, loI = 0;
  for (let i = 0; i < n; i++){
    const h = bars[i].high, l = bars[i].low;
    if (dir >= 0 && h >= hi){ hi = h; hiI = i; }
    if (dir <= 0 && l <= lo){ lo = l; loI = i; }
    if (dir >= 0 && l <= hi * (1 - dev)){
      pivots.push({ i: hiI, price: hi, kind: "H" });
      dir = -1; lo = l; loI = i;
    } else if (dir <= 0 && h >= lo * (1 + dev)){
      pivots.push({ i: loI, price: lo, kind: "L" });
      dir = 1; hi = h; hiI = i;
    }
  }
  let pending = null;
  if (pivots.length){
    const lastKind = pivots[pivots.length - 1].kind;
    if (dir >= 0 && lastKind === "L") pending = { i: hiI, price: hi, kind: "PH" };
    else if (dir <= 0 && lastKind === "H") pending = { i: loI, price: lo, kind: "PL" };
  }
  return { pivots, pending };
}
function buildZigzagSeries(bars, devPct){
  const n = bars.length;
  const dev = devPct / 100;
  const { pivots, pending } = zigzagNodes(bars, dev);
  const zz = new Array(n).fill(null);
  const zzUp = new Array(n).fill(null);
  const zzLo = new Array(n).fill(null);
  const zzPend = new Array(n).fill(null);
  for (const node of pivots){
    if (node.kind === "H") zzUp[node.i] = node.price;
    else zzLo[node.i] = node.price;
  }
  if (pending) zzPend[pending.i] = pending.price;
  const nodes = pivots.concat(pending ? [pending] : []);
  for (let k = 1; k < nodes.length; k++){
    const a = nodes[k - 1], b = nodes[k];
    for (let i = a.i; i <= b.i; i++){
      const t = (i - a.i) / (b.i - a.i);
      zz[i] = a.price + (b.price - a.price) * t;
    }
  }
  return {
    zz:      { label: "ZigZag " + devPct + "%", color: "#ff80ab", kind: "line", width: 2, pane: "overlay", primary: true, values: zz },
    zz_up:   { label: "Swing High", color: "#ef5350", kind: "marker", pane: "overlay", values: zzUp },
    zz_lo:   { label: "Swing Low",  color: "#26a69a", kind: "marker", pane: "overlay", values: zzLo },
    zz_pend: { label: "Developing", color: "rgba(230,237,243,0.65)", kind: "marker", pane: "overlay", values: zzPend },
  };
}

// ---------- JS indicator registry (offline mirror of indicators/) ----------
// Each entry carries the same params spec as its Python twin, so the gear
// settings dialog works identically whether the backend is up or not.
const JS_INDICATORS = [
  { id: "ema", name: "EMA", pane: "overlay",
    params: [
      { key: "len1", label: "Fast length",   type: "int", default: 9,  min: 2, max: 1000 },
      { key: "len2", label: "Middle length", type: "int", default: 21, min: 2, max: 1000 },
      { key: "len3", label: "Slow length",   type: "int", default: 50, min: 2, max: 1000 },
    ],
    compute(bars, p){
      const c = bars.map(b => b.close);
      return {
        ema_fast: { label: "EMA " + p.len1, color: "#f5c542", kind: "line", width: 1.5, pane: "overlay", primary: true, values: emaArr(c, p.len1) },
        ema_mid:  { label: "EMA " + p.len2, color: "#4aa3ff", kind: "line", width: 1.5, pane: "overlay", values: emaArr(c, p.len2) },
        ema_slow: { label: "EMA " + p.len3, color: "#c084fc", kind: "line", width: 1.5, pane: "overlay", values: emaArr(c, p.len3) },
      };
    }},
  { id: "bollinger", name: "Bollinger Bands", pane: "overlay",
    params: [
      { key: "length", label: "Length",            type: "int",   default: 20, min: 2,   max: 1000, step: 1 },
      { key: "mult",   label: "StdDev multiplier", type: "float", default: 2.0, min: 0.1, max: 10,  step: 0.1 },
    ],
    compute(bars, p){
      const bb = bollingerArr(bars.map(b => b.close), p.length, p.mult);
      return {
        bb_mid:   { label: "BB " + p.length + ", " + p.mult, color: "rgba(180,160,255,0.50)", kind: "line", width: 1, dash: true, pane: "overlay", primary: true, values: bb.mid },
        bb_upper: { label: "BB Upper", color: "rgba(180,160,255,0.75)", kind: "line", width: 1, dash: true, pane: "overlay", values: bb.upper },
        bb_lower: { label: "BB Lower", color: "rgba(180,160,255,0.75)", kind: "line", width: 1, dash: true, pane: "overlay", values: bb.lower },
      };
    }},
  { id: "rsi", name: "RSI", pane: "rsi",
    params: [
      { key: "length", label: "RSI length", type: "int",   default: 14, min: 2, max: 1000 },
      { key: "ob",     label: "Overbought", type: "float", default: 70, min: 50, max: 100, step: 1 },
      { key: "os",     label: "Oversold",   type: "float", default: 30, min: 0,  max: 50,  step: 1 },
    ],
    compute(bars, p){
      const n = bars.length;
      const ob = new Array(n).fill(p.ob), os = new Array(n).fill(p.os);
      return {
        rsi:    { label: "RSI " + p.length,    color: "#ffb74d",                kind: "line", width: 1.5, pane: "rsi", primary: true, values: rsiArr(bars.map(b => b.close), p.length) },
        rsi_ob: { label: "Overbought " + p.ob, color: "rgba(139,152,169,0.55)", kind: "line", width: 1,   dash: true, pane: "rsi", values: ob },
        rsi_os: { label: "Oversold " + p.os,   color: "rgba(139,152,169,0.55)", kind: "line", width: 1,   dash: true, pane: "rsi", values: os },
      };
    }},
  { id: "macd", name: "MACD", pane: "macd",
    params: [
      { key: "fast",   label: "Fast length",   type: "int", default: 12, min: 1, max: 1000 },
      { key: "slow",   label: "Slow length",   type: "int", default: 26, min: 1, max: 1000 },
      { key: "signal", label: "Signal length", type: "int", default: 9,  min: 1, max: 1000 },
    ],
    compute(bars, p){
      const m = macdArr(bars.map(b => b.close), p.fast, p.slow, p.signal);
      return {
        macd:        { label: "MACD " + p.fast + " " + p.slow + " " + p.signal, color: "#4aa3ff", kind: "line", width: 1.5, pane: "macd", primary: true, values: m.macd },
        macd_signal: { label: "Signal",   color: "#ff7043", kind: "line", width: 1.5, pane: "macd", values: m.signal },
        macd_hist:   { label: "Histogram", color: "#26a69a", kind: "hist", pane: "macd", values: m.hist },
      };
    }},
  { id: "dsl_oscillator", name: "DSL Oscillator", pane: "dsl",
    params: [
      { key: "len_dsl", label: "DSL length", type: "int",   default: 10, min: 2,   max: 1000, step: 1 },
      { key: "rsi_len", label: "RSI length", type: "int",   default: 14, min: 2,   max: 1000, step: 1 },
      { key: "mode",    label: "DSL mode",   type: "float", default: 2,  min: 0.1, max: 20,  step: 0.1 },
    ],
    compute(bars, p){
      const r = rsiArr(bars.map(b => b.close), p.rsi_len);
      const d1 = dslLinesArr(r, p.len_dsl, p.mode);
      const osc = zlemaArr(d1.up.map((v, i) => (v + d1.dn[i]) / 2), 10).map(v => v + 75);
      const d2 = dslLinesArr(osc, 10, p.mode);
      const upSig = [], dnSig = [];
      for (let i = 0; i < osc.length; i++){
        const u = i > 0 && osc[i] > d2.dn[i] && osc[i-1] <= d2.dn[i-1] && osc[i] < 130;
        const dn = i > 0 && osc[i] < d2.up[i] && osc[i-1] >= d2.up[i-1] && osc[i] > 125;
        upSig.push(u ? osc[i] : null);
        dnSig.push(dn ? osc[i] : null);
      }
      return {
        dsl_osc:      { label: "DSL Osc",  color: "#26c6da",                kind: "line",   width: 2,   pane: "dsl", primary: true, values: osc },
        dsl_level_up: { label: "Level Up", color: "rgba(120,140,255,0.85)", kind: "line",   width: 1, dash: true, pane: "dsl", values: d2.up },
        dsl_level_dn: { label: "Level Dn", color: "rgba(255,150,60,0.85)",  kind: "line",   width: 1, dash: true, pane: "dsl", values: d2.dn },
        dsl_up:       { label: "Buy",      color: "#26a69a",                kind: "marker",             pane: "dsl", values: upSig },
        dsl_dn:       { label: "Sell",     color: "#ef5350",                kind: "marker",             pane: "dsl", values: dnSig },
      };
    }},
  { id: "supertrend", name: "SuperTrend", pane: "overlay",
    params: [
      { key: "length", label: "ATR length", type: "int",   default: 10, min: 1,   max: 1000, step: 1 },
      { key: "mult",   label: "Multiplier", type: "float", default: 3.0, min: 0.1, max: 20,  step: 0.1 },
    ],
    compute(bars, p){
      const st = supertrendArr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), p.length, p.mult);
      return { supertrend: { label: "SuperTrend " + p.length + "," + p.mult, color: "#ff9800", kind: "line", width: 1.5, pane: "overlay", primary: true, values: st } };
    }},
  { id: "dynamic_deviation_levels", name: "Dynamic Deviation Levels", pane: "overlay",
    params: [
      { key: "len",      label: "Length",                      type: "int",   default: 50,  min: 2,   max: 500 },
      { key: "mult",     label: "Multiplier",                  type: "float", default: 3.0, min: 0.1, max: 20, step: 0.1 },
      { key: "show_dev", label: "Show deviation levels (0/1)", type: "int",   default: 0,   min: 0,   max: 1,  step: 1 },
    ],
    compute(bars, p){
      const hl2 = bars.map(b => (b.high + b.low) / 2);
      const mid = hmaArr(medianArr(hl2, p.len * 2), 10);
      const out = {
        ddl_mid: { label: "DDL mid (" + p.len + ", " + p.mult + ")", color: "#02ffff", kind: "line", width: 2, pane: "overlay", primary: true, values: mid },
      };
      if (p.show_dev >= 1){
        const atr = atrArr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 200);
        for (const k of [1, 2, 3]){
          out["ddl_up" + k] = { label: "Level +" + k, color: "rgba(230,237,243,0.30)", kind: "line", width: 1, dash: true, pane: "overlay",
            values: mid.map((v, i) => (v == null || atr[i] == null) ? null : v + atr[i] * p.mult * k) };
          out["ddl_dn" + k] = { label: "Level -" + k, color: "rgba(230,237,243,0.30)", kind: "line", width: 1, dash: true, pane: "overlay",
            values: mid.map((v, i) => (v == null || atr[i] == null) ? null : v - atr[i] * p.mult * k) };
        }
      }
      return out;
    }},
  { id: "zigzag", name: "ZigZag (repaints)", pane: "overlay", dynamic: true,
    params: [
      { key: "dev", label: "Reversal %", type: "float", default: 2.0, min: 0.1, max: 50, step: 0.1 },
    ],
    compute(bars, p){
      return buildZigzagSeries(bars, p.dev);
    }},
  { id: "supertrend_oscillator", name: "SuperTrend Oscillator", pane: "stosc", dynamic: true,
    params: [
      { key: "length",   label: "ST Length",                  type: "int",   default: 10, min: 1, max: 1000 },
      { key: "mult",     label: "ST Multiplier",              type: "float", default: 2.0, min: 1, max: 20,  step: 0.1 },
      { key: "smooth",   label: "Histogram Smoothing",        type: "int",   default: 72, min: 1, max: 1000 },
      { key: "fixed",    label: "Fixed Transparency (0/1)",   type: "int",   default: 0,  min: 0, max: 1,   step: 1 },
      { key: "show_ln",  label: "Show Lines (0/1)",           type: "int",   default: 1,  min: 0, max: 1,   step: 1 },
      { key: "show_lb",  label: "Show Labels (0/1)",          type: "int",   default: 1,  min: 0, max: 1,   step: 1 },
      { key: "show_per", label: "Show % False Signals (0/1)", type: "int",   default: 0,  min: 0, max: 1,   step: 1 },
    ],
    compute(bars, p){
      const n = bars.length;
      const length = p.length, mult = p.mult, smooth = p.smooth;
      const src = bars.map(b => b.close);
      const atrM = atrArr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), length).map(v => v == null ? null : v * mult);
      const up = bars.map((b, i) => (b.high + b.low) / 2 + atrM[i]);
      const dn = bars.map((b, i) => (b.high + b.low) / 2 - atrM[i]);
      const upper = new Array(n).fill(null), lower = new Array(n).fill(null), trend = new Array(n).fill(null);
      for (let i = 0; i < n; i++){
        if (i === 0){ upper[0] = up[0]; lower[0] = dn[0]; continue; }
        const pu = upper[i-1], pl = lower[i-1], ps = src[i-1];
        upper[i] = (ps < pu) ? Math.min(up[i], pu) : up[i];
        lower[i] = (ps > pl) ? Math.max(dn[i], pl) : dn[i];
        if (src[i] > pu) trend[i] = 1;
        else if (src[i] < pl) trend[i] = 0;
        else trend[i] = trend[i-1];
      }
      const spt = trend.map((t, i) => t == null ? null : (t === 1 ? lower[i] : upper[i]));
      const osc = new Array(n).fill(null);
      for (let i = 0; i < n; i++){
        if (spt[i] == null || upper[i] == null || lower[i] == null) continue;
        const r = upper[i] - lower[i];
        if (!r) continue;
        osc[i] = Math.max(Math.min((src[i] - spt[i]) / r, 1), -1);
      }
      const ama = new Array(n).fill(null);
      let prevAma = null;
      for (let i = 0; i < n; i++){
        const o = osc[i];
        if (o == null || !isFinite(o)) continue;
        const alpha = (o * o) / length;
        prevAma = (prevAma == null) ? o : prevAma + alpha * (o - prevAma);
        ama[i] = prevAma;
      }
      const hist = new Array(n).fill(null);
      let prevH = null;
      const k = 2 / (smooth + 1);
      for (let i = 0; i < n; i++){
        const v = (osc[i] == null || ama[i] == null) ? null : osc[i] - ama[i];
        if (v == null) continue;
        prevH = (prevH == null) ? v : v * k + prevH * (1 - k);
        hist[i] = prevH;
      }
      const labBullOk = new Array(n).fill(null), labBullX = new Array(n).fill(null);
      const labBearOk = new Array(n).fill(null), labBearX = new Array(n).fill(null);
      const per = new Array(n).fill(null);
      let lastCo = null, lastCu = null, num = 0, den = 0, x2 = null;
      for (let i = 1; i < n; i++){
        if (spt[i] != null && spt[i-1] != null){
          const co = src[i-1] <= spt[i-1] && src[i] > spt[i];
          const cu = src[i-1] >= spt[i-1] && src[i] < spt[i];
          if (co) lastCo = src[i];
          if (cu) lastCu = src[i];
          if (co || cu){
            const both = lastCo != null && lastCu != null;
            const falseBuy = both && lastCu < lastCo;
            const falseSell = both && lastCo > lastCu;
            den++;
            if (falseBuy || falseSell) num++;
            x2 = i;
            if (p.show_lb >= 1){
              if (co){ if (falseSell) labBullX[i] = -80; else labBullOk[i] = -80; }
              if (cu){ if (falseBuy) labBearX[i] = 80; else labBearOk[i] = 80; }
            }
          }
        }
        per[i] = den > 0 ? num / den * 100 : null;
      }
      const sigUp = new Array(n).fill(null), sigDn = new Array(n).fill(null);
      if (p.show_ln >= 1){
        for (let i = 1; i < n; i++){
          if (osc[i] == null || osc[i-1] == null) continue;
          const s0 = Math.sign(osc[i-1]), s1 = Math.sign(osc[i]);
          if (s1 !== s0){
            if (osc[i] > 0) sigDn[i] = osc[i] * -100;
            else if (osc[i] < 0) sigUp[i] = osc[i] * -100;
          }
        }
      }
      const conn = new Array(n).fill(null);
      let connColor = "#0cb51a";
      if (p.show_ln >= 1 && x2 != null && x2 < n - 1 && osc[n-1] != null){
        const y1 = -Math.sign(osc[n-1]) * 100, y2 = osc[n-1] * 100;
        for (let i = x2; i < n; i++){
          const t = (i - x2) / (n - 1 - x2);
          conn[i] = y1 + (y2 - y1) * t;
        }
        connColor = osc[n-1] < 0 ? "#ff1100" : "#0cb51a";
      }
      const colors = new Array(n).fill(null);
      for (let i = 0; i < n; i++){
        const o = osc[i];
        if (o == null) continue;
        if (p.fixed >= 1){ colors[i] = o > 0 ? "#0cb51a" : "#ff1100"; continue; }
        const q = Math.min(99, Math.max(0, Math.round(Math.abs(o) * 99)));
        const a = q / 100;
        colors[i] = o > 0 ? `rgba(12,181,26,${a})` : `rgba(255,17,0,${a})`;
      }
      const amaPos = new Array(n).fill(null), amaNeg = new Array(n).fill(null);
      for (let i = 0; i < n; i++){
        const a = ama[i];
        if (a == null) continue;
        if (a > 0) amaPos[i] = a * 100; else amaNeg[i] = a * 100;
      }
      for (let i = 1; i < n; i++){
        const a = ama[i], pr = ama[i-1];
        if (a == null || pr == null) continue;
        if (a > 0 && pr <= 0) amaPos[i-1] = pr * 100;
        else if (a <= 0 && pr > 0) amaNeg[i-1] = pr * 100;
      }
      const lv80 = new Array(n).fill(80), lvM80 = new Array(n).fill(-80);
      const out = {
        sto:        { label: "SuperOsc",   color: "#0cb51a", kind: "hist", colw: 1.0, pane: "stosc", primary: true, values: osc.map(o => o == null ? null : o * 100), colors },
        sto_hist:   { label: "Histogram",  color: "#808080", kind: "hist", colw: 1.0, pane: "stosc", values: hist.map(v => v == null ? null : v * 100), colors: hist.map(v => v == null ? null : "rgba(128,128,128,0.60)") },
        sto_ama_up: { label: "Signal",     color: "#2157f3", kind: "line", width: 1.5, pane: "stosc", values: amaPos },
        sto_ama_dn: { label: "Signal",     color: "#673ab7", kind: "line", width: 1.5, pane: "stosc", values: amaNeg },
        sto_fill:   { label: "80 Fill",    color: "rgba(33,87,243,0.10)", kind: "hfill", y1: 80, y2: -80, pane: "stosc", values: new Array(n).fill(null) },
        sto_lv80:   { label: "+80",        color: "rgba(33,87,243,0.45)", kind: "line", width: 1, dash: true, pane: "stosc", values: lv80 },
        sto_lvm80:  { label: "-80",        color: "rgba(33,87,243,0.45)", kind: "line", width: 1, dash: true, pane: "stosc", values: lvM80 },
        sto_sig_up: { label: "Zero Cross", color: "#0cb51a", kind: "marker", pane: "stosc", values: sigUp },
        sto_sig_dn: { label: "Zero Cross", color: "#ff1100", kind: "marker", pane: "stosc", values: sigDn },
        sto_conn:   { label: "Trend Line", color: connColor, kind: "line", width: 1, pane: "stosc", values: conn },
        sto_lab_bull_ok: { label: "Cross \u2713",         color: "#808080", kind: "marker", pane: "stosc", values: labBullOk },
        sto_lab_bull_x:  { label: "Cross \u2717 (false)", color: "#808080", kind: "marker", pane: "stosc", values: labBullX },
        sto_lab_bear_ok: { label: "Cross \u2713",         color: "#808080", kind: "marker", pane: "stosc", values: labBearOk },
        sto_lab_bear_x:  { label: "Cross \u2717 (false)", color: "#808080", kind: "marker", pane: "stosc", values: labBearX },
      };
      if (p.show_per >= 1) out.sto_per = { label: "False Signals %", color: "#808080", kind: "line", width: 1, dash: true, pane: "stosc", values: per };
      return out;
    }},
];

function computeJSIndicators(bars, paramsById){
  const out = {};
  for (const ind of JS_INDICATORS){
    const p = cleanJSParams(ind, paramsById && paramsById[ind.id]);
    const res = ind.compute(bars, p);
    for (const key in res){ res[key].group = ind.id; out[key] = res[key]; }
  }
  return out;
}

// Merge user params onto the defaults for a JS indicator spec (mirror of the
// server-side clean_params in indicators/__init__.py).
function cleanJSParams(ind, raw){
  const out = {};
  for (const p of (ind.params || [])){
    let v = p.default;
    if (raw && Object.prototype.hasOwnProperty.call(raw, p.key)){
      const x = Number(raw[p.key]);
      if (isFinite(x)){
        v = x;
        if (p.min != null) v = Math.max(p.min, v);
        if (p.max != null) v = Math.min(p.max, v);
        if (p.type === "int") v = Math.round(v);
      }
    }
    out[p.key] = v;
  }
  return out;
}

// ---------- synthetic data (offline fallback) ----------
function syntheticBars(limit = 500, startPrice = 60000){
  const bars = [];
  const now = Math.floor(Date.now()/1000/3600) * 3600;
  const step = 3600;
  let s = 7;
  const rnd = () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const norm = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let price = startPrice, vs = 1;
  for (let i = 0; i < limit; i++){
    vs = 0.95*vs + 0.05*(0.4 + 2.0*rnd());
    const drift = Math.sin(i/37) * 0.0012;
    const ret = norm()*0.008*vs + drift;
    const o = price;
    const c = Math.max(0.01, price*(1 + ret));
    const hi = Math.max(o,c)*(1 + Math.abs(norm()*0.004*vs));
    const lo = Math.min(o,c)*(1 - Math.abs(norm()*0.004*vs));
    const vol = Math.abs(norm()*0.35*vs + 1)*1000;
    const t = now - (limit - i)*step;
    bars.push({ time: t, open: round8(o), high: round8(hi), low: round8(lo), close: round8(c), volume: round8(vol) });
    price = c;
  }
  return bars;
}

// ---------- params persistence ----------
const PARAMS_STORE_KEY = "bar-replay:params:v1";

function loadSavedParams(){
  try {
    const raw = localStorage.getItem(PARAMS_STORE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return (data && typeof data === "object") ? data : {};
  } catch (e){ return {}; }
}

function saveParams(){
  try { localStorage.setItem(PARAMS_STORE_KEY, JSON.stringify(state.params)); } catch (e){}
}

// Active params for an indicator: saved overrides merged onto defaults.
function activeParamsFor(ind){
  if (!ind.params || !ind.params.length) return null;
  return cleanJSParams({ params: ind.params }, state.params[ind.id]);
}

// True when the user changed anything away from the defaults.
function paramsChanged(ind){
  const saved = state.params[ind.id];
  if (!saved) return false;
  for (const p of ind.params){
    if (Object.prototype.hasOwnProperty.call(saved, p.key) && Number(saved[p.key]) !== p.default) return true;
  }
  return false;
}

function paramSummary(ind){
  const p = activeParamsFor(ind);
  if (!p) return "";
  return ind.params.map(spec => spec.key + " " + p[spec.key]).join(" · ");
}

// ---------- layout & scales ----------
function visibleSeries(){
  const out = [];
  for (const key in state.ind){
    if (state.selected.has(state.ind[key].group)) out.push({ key, meta: state.ind[key] });
  }
  return out;
}
function paneOrder(){
  const keys = [];
  for (const ind of state.indicatorList){
    if (!state.selected.has(ind.id)) continue;
    if (ind.pane === "overlay") continue;
    if (!keys.includes(ind.pane)) keys.push(ind.pane);
  }
  return keys;
}
function layout(W, H, subKeys){
  const left = 62, right = 12, top = 12, bottom = 26;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 8;
  const n = subKeys.length;
  const priceFrac = n > 0 ? 0.44 : 0.80;
  const priceH = innerH * priceFrac;
  const subH = n > 0 ? (innerH - priceH - gap * n) / n : 0;
  const priceRect = { x: left, y: top, w: innerW, h: priceH };
  const subRects = {};
  let y = top + priceH + gap;
  for (const k of subKeys){
    subRects[k] = { x: left, y, w: innerW, h: subH };
    y += subH + gap;
  }
  return { left, right, top, bottom, innerW, innerH, priceRect, subRects, timeY: H - 15 };
}
function yFromValue(v, min, max, rect){ return rect.y + (max - v)/(max - min) * rect.h; }
function valueFromY(y, min, max, rect){ return max - (y - rect.y)/rect.h * (max - min); }
function niceStep(range, targetTicks){
  if (range <= 0) return 1;
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / pow;
  let s;
  if (n < 1.5) s = 1; else if (n < 3) s = 2; else if (n < 7) s = 5; else s = 10;
  return s * pow;
}
function niceTicks(min, max, count = 5){
  if (!isFinite(min) || !isFinite(max)) return [0];
  if (min === max){ min -= 1; max += 1; }
  const step = niceStep(max - min, count);
  const start = Math.ceil(min/step) * step;
  const ticks = [];
  for (let v = start; v <= max + step*0.0001; v += step) ticks.push(v);
  return ticks;
}

// ---------- drawing primitives ----------
function drawGrid(rect, min, max, ticks, fmt){
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of ticks){
    if (v < min || v > max) continue;
    const y = yFromValue(v, min, max, rect);
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y); ctx.stroke();
    ctx.fillStyle = COLORS.axis;
    ctx.fillText(fmt(v), rect.x - 7, y);
  }
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath(); ctx.moveTo(rect.x, rect.y); ctx.lineTo(rect.x + rect.w, rect.y); ctx.stroke();
}
function drawLine(arr, color, n, rect, min, max, width, dash){
  if (!arr) return;
  ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
  ctx.beginPath();
  let started = false;
  const barW = rect.w / n;
  for (let i = 0; i < n; i++){
    const v = arr[i];
    if (v == null || !isFinite(v)){ started = false; continue; }
    const x = rect.x + (i + 0.5) * barW;
    const y = yFromValue(v, min, max, rect);
    if (!started){ ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawDashedLevel(rect, value, min, max){
  const y = yFromValue(value, min, max, rect);
  ctx.strokeStyle = COLORS.level; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y); ctx.stroke();
  ctx.setLineDash([]);
}
function drawSeries(meta, n, rect, min, max, barW){
  const vals = meta.values;
  const kind = meta.kind;
  if (kind === "hfill"){
    // horizontal fill between two constant levels (e.g. the ±80 zone)
    const y1 = yFromValue(meta.y1, min, max, rect);
    const y2 = yFromValue(meta.y2, min, max, rect);
    ctx.fillStyle = meta.color;
    ctx.fillRect(rect.x, Math.min(y1, y2), rect.w, Math.abs(y2 - y1));
    return;
  }
  if (kind === "hist"){
    const y0 = yFromValue(0, min, max, rect);
    const cw = Math.max(1, barW * (meta.colw || 0.7));
    for (let i = 0; i < n; i++){
      const v = vals[i];
      if (v == null || !isFinite(v)) continue;
      const x = rect.x + (i + 0.5) * barW;
      const y1 = yFromValue(v, min, max, rect);
      ctx.fillStyle = (meta.colors && meta.colors[i]) ? meta.colors[i] : (v >= 0 ? COLORS.histUp : COLORS.histDown);
      ctx.fillRect(x - cw/2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y0 - y1)));
    }
  } else if (kind === "marker"){
    for (let i = 0; i < n; i++){
      const v = vals[i];
      if (v == null || !isFinite(v)) continue;
      const x = rect.x + (i + 0.5) * barW;
      const y = yFromValue(v, min, max, rect);
      ctx.fillStyle = meta.color;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
  } else { // line / area
    drawLine(vals, meta.color, n, rect, min, max, meta.width || 1.5, meta.dash ? [4, 4] : []);
  }
}
function paneRange(seriesList, n, paneKey){
  let mn = Infinity, mx = -Infinity;
  for (const s of seriesList){
    for (let i = 0; i < n; i++){
      const v = s.meta.values[i];
      if (v == null || !isFinite(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
  }
  if (paneKey === "rsi"){ return { min: 0, max: 100 }; }
  if (paneKey === "stosc"){ return { min: -105, max: 105 }; }  // SuperTrend Oscillator: fixed ±100 scale
  if (!isFinite(mn)){ return { min: 0, max: 1 }; }
  const pad = (mx - mn) * 0.1 || 1;
  return { min: mn - pad, max: mx + pad };
}

// ---------- main render ----------
function render(){
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W <= 0 || H <= 0) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  const n = state.count;
  if (n === 0){ emptyState.style.display = "flex"; return; }
  emptyState.style.display = "none";

  const vs = visibleSeries();
  const subKeys = paneOrder();
  const L = layout(W, H, subKeys);
  const bars = state.bars;
  const barW = L.innerW / n;
  const cw = Math.max(1, barW * 0.7);

  const pricePlot = { x: L.priceRect.x, y: L.priceRect.y, w: L.priceRect.w, h: L.priceRect.h * 0.76 };
  const volRect   = { x: L.priceRect.x, y: L.priceRect.y + L.priceRect.h * 0.78, w: L.priceRect.w, h: L.priceRect.h * 0.22 };

  const overlay = vs.filter(s => s.meta.pane === "overlay");

  // price range (candles + overlay series)
  let pmin = Infinity, pmax = -Infinity;
  for (let i = 0; i < n; i++){
    if (bars[i].low < pmin) pmin = bars[i].low;
    if (bars[i].high > pmax) pmax = bars[i].high;
  }
  for (const s of overlay){
    for (let i = 0; i < n; i++){ const v = s.meta.values[i]; if (v != null && isFinite(v)){ if (v < pmin) pmin = v; if (v > pmax) pmax = v; } }
  }
  if (!isFinite(pmin)){ pmin = 0; pmax = 1; }
  const ppad = (pmax - pmin) * 0.06 || pmin * 0.01 || 1;
  pmin -= ppad; pmax += ppad;

  drawGrid(L.priceRect, pmin, pmax, niceTicks(pmin, pmax, 5), fmtAxis);

  // volume
  let vmax = 0;
  for (let i = 0; i < n; i++){ if (bars[i].volume > vmax) vmax = bars[i].volume; }
  vmax = vmax || 1;
  for (let i = 0; i < n; i++){
    const b = bars[i];
    const x = L.priceRect.x + (i + 0.5) * barW;
    const vh = (b.volume / vmax) * volRect.h;
    const y = volRect.y + volRect.h - vh;
    ctx.fillStyle = b.close >= b.open ? COLORS.histUp : COLORS.histDown;
    ctx.fillRect(x - cw/2, y, cw, Math.max(vh, 0.5));
  }

  // candlesticks
  const py = (v) => yFromValue(v, pmin, pmax, pricePlot);
  for (let i = 0; i < n; i++){
    const b = bars[i];
    const x = L.priceRect.x + (i + 0.5) * barW;
    const up = b.close >= b.open;
    ctx.strokeStyle = up ? COLORS.up : COLORS.down;
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, py(b.high)); ctx.lineTo(x, py(b.low)); ctx.stroke();
    const y1 = py(b.open), y2 = py(b.close);
    ctx.fillRect(x - cw/2, Math.min(y1, y2), cw, Math.max(1, Math.abs(y1 - y2)));
  }

  // overlay indicators
  for (const s of overlay) drawSeries(s.meta, n, L.priceRect, pmin, pmax, barW);

  // sub-panes
  for (const paneKey of subKeys){
    const rect = L.subRects[paneKey];
    const seriesList = vs.filter(s => s.meta.pane === paneKey);
    const range = paneRange(seriesList, n, paneKey);
    drawGrid(rect, range.min, range.max, niceTicks(range.min, range.max, 5), (v) => (paneKey === "rsi" ? v.toFixed(0) : fmtAxis(v)));
    // fills render under everything else, like Pine's fill()
    for (const s of seriesList){ if (s.meta.kind === "hfill") drawSeries(s.meta, n, rect, range.min, range.max, barW); }
    if (paneKey === "rsi"){
      drawDashedLevel(rect, 30, range.min, range.max);
      drawDashedLevel(rect, 70, range.min, range.max);
    } else {
      drawDashedLevel(rect, 0, range.min, range.max);
    }
    for (const s of seriesList){ if (s.meta.kind !== "hfill") drawSeries(s.meta, n, rect, range.min, range.max, barW); }
  }

  // time axis
  const target = Math.max(1, Math.min(6, Math.floor(n / (L.innerW / 90))));
  const tstep = Math.max(1, Math.ceil(n / target));
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.axis;
  for (let i = 0; i < n; i += tstep){
    const x = L.left + (i + 0.5) * barW;
    ctx.fillText(fmtTime(bars[i].time), x, L.timeY);
  }

  drawNowMarker(L, n);
  drawCrosshair(L, n, pmin, pmax);
}

function bottomY(L){
  let y = L.priceRect.y + L.priceRect.h;
  for (const k in L.subRects){ y = Math.max(y, L.subRects[k].y + L.subRects[k].h); }
  return y;
}
function drawNowMarker(L, n){
  if (n === 0) return;
  const barW = L.innerW / n;
  const x = L.left + (n - 0.5) * barW;
  const endY = bottomY(L);
  ctx.strokeStyle = COLORS.now; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, L.priceRect.y); ctx.lineTo(x, endY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,197,66,0.95)";
  ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillText("◄ replay here", x + 5, L.priceRect.y + L.priceRect.h - 4);
}
function drawCrosshair(L, n, pmin, pmax){
  if (state.hover < 0 || state.hover >= n){ crossTip.style.display = "none"; return; }
  const i = state.hover;
  const barW = L.innerW / n;
  const x = L.left + (i + 0.5) * barW;
  const endY = bottomY(L);
  ctx.strokeStyle = COLORS.cross; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(x, L.priceRect.y); ctx.lineTo(x, endY); ctx.stroke();
  ctx.setLineDash([]);
  if (state.mouseY != null && state.mouseY >= L.priceRect.y && state.mouseY <= L.priceRect.y + L.priceRect.h){
    ctx.beginPath(); ctx.moveTo(L.priceRect.x, state.mouseY); ctx.lineTo(L.priceRect.x + L.priceRect.w, state.mouseY); ctx.stroke();
    const price = valueFromY(state.mouseY, pmin, pmax, L.priceRect);
    ctx.fillStyle = COLORS.axis;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(fmtAxis(price), L.priceRect.x - 7, state.mouseY);
  }
  const b = state.bars[i];
  crossTip.style.display = "block";
  crossTip.innerHTML = tooltipHTML(b, i);
  const tw = crossTip.offsetWidth, th = crossTip.offsetHeight;
  let tx = x + 12;
  if (tx + tw > L.left + L.innerW) tx = x - tw - 12;
  const ty = L.priceRect.y + 8;
  crossTip.style.left = tx + "px";
  crossTip.style.top = ty + "px";
}
function tooltipHTML(b, i){
  const cls = b.close >= b.open ? "up" : "down";
  let html = `<div class="tt-time">${fmtTime(b.time)}</div>` +
    `<div class="tt-row ${cls}">O ${fmtPrice(b.open)} &nbsp; H ${fmtPrice(b.high)} &nbsp; L ${fmtPrice(b.low)} &nbsp; C ${fmtPrice(b.close)}</div>` +
    `<div class="tt-row">Vol ${fmtVol(b.volume)}</div>`;
  const vs = visibleSeries();
  if (vs.length){
    const parts = vs.map(s => {
      const v = s.meta.values[i];
      return `<span style="color:${s.meta.color}">${s.meta.label}</span> ${fmtNum(v)}`;
    });
    html += `<div class="tt-row">${parts.join(" · ")}</div>`;
  }
  return html;
}

// ---------- indicator chips (picker) ----------
function buildChips(){
  chipsEl.innerHTML = "";
  for (const ind of state.indicatorList){
    const on = state.selected.has(ind.id);
    const chip = document.createElement("button");
    chip.className = "chip" + (on ? " on" : "");
    chip.type = "button";
    chip.title = ind.pane === "overlay" ? `${ind.name} (on price)` : `${ind.name} (${ind.pane} pane)`;
    const summary = paramSummary(ind);
    if (summary) chip.title += `\n${summary}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = chipColor(ind.id);
    chip.appendChild(dot);
    const nameSpan = document.createElement("span");
    nameSpan.className = "chip-name";
    nameSpan.textContent = ind.name;
    chip.appendChild(nameSpan);
    if (ind.params && ind.params.length){
      const gear = document.createElement("span");
      gear.className = "gear" + (paramsChanged(ind) ? " modified" : "");
      gear.title = "Settings";
      gear.textContent = "⚙";
      gear.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openSettings(ind);
      });
      chip.appendChild(gear);
    }
    chip.addEventListener("click", () => {
      if (state.selected.has(ind.id)) state.selected.delete(ind.id);
      else state.selected.add(ind.id);
      buildChips();
      updateReadouts();
      render();
    });
    chipsEl.appendChild(chip);
  }
}
function chipColor(id){
  const map = {
    ema: "#f5c542", bollinger: "#b4a0ff", rsi: "#ffb74d",
    macd: "#4aa3ff", dsl_oscillator: "#26c6da", supertrend: "#ff9800",
    dynamic_deviation_levels: "#02ffff", zigzag: "#ff80ab", supertrend_oscillator: "#673ab7",
  };
  return map[id] || "#8b98a9";
}

// ---------- settings dialog (TradingView-style) ----------
const settings = {
  ind: null,        // indicator list entry being edited
  inputs: {},       // key -> current input element value (raw string)
};

function openSettings(ind){
  settings.ind = ind;
  settings.inputs = {};
  settingsTitle.textContent = ind.name + " — settings";
  paramGrid.innerHTML = "";
  const current = activeParamsFor(ind) || {};
  for (const p of (ind.params || [])){
    settings.inputs[p.key] = String(current[p.key] != null ? current[p.key] : p.default);
    const row = document.createElement("label");
    row.className = "param-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "param-name";
    nameSpan.textContent = p.label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = p.step != null ? p.step : (p.type === "int" ? 1 : 0.1);
    if (p.min != null) input.min = p.min;
    if (p.max != null) input.max = p.max;
    input.value = settings.inputs[p.key];
    input.dataset.key = p.key;
    input.addEventListener("input", () => { settings.inputs[p.key] = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter"){ e.preventDefault(); applySettings(); }
      else if (e.key === "Escape"){ e.preventDefault(); closeSettings(); }
      e.stopPropagation();
    });
    row.appendChild(nameSpan);
    row.appendChild(input);
    paramGrid.appendChild(row);
    if (paramGrid.lastElementChild) {
      const first = paramGrid.querySelector("input");
      if (first && paramGrid.children.length === 1) setTimeout(() => first.focus(), 50);
    }
  }
  settingsBackdrop.hidden = false;
}

function closeSettings(){
  settingsBackdrop.hidden = true;
  settings.ind = null;
}

function collectSettings(){
  const ind = settings.ind;
  if (!ind) return null;
  const out = {};
  let touched = false;
  for (const p of ind.params){
    let v = p.default;
    const raw = settings.inputs[p.key];
    if (raw != null && String(raw).trim() !== ""){
      const x = Number(raw);
      if (isFinite(x)){
        v = x;
        if (p.min != null) v = Math.max(p.min, v);
        if (p.max != null) v = Math.min(p.max, v);
        if (p.type === "int") v = Math.round(v);
        touched = true;
      }
    }
    out[p.key] = v;
  }
  return { values: out, touched };
}

function applySettings(){
  const ind = settings.ind;
  const collected = collectSettings();
  if (!ind || !collected) return;
  const prev = state.params[ind.id];
  const next = {};
  let anyChanged = false;
  for (const p of ind.params){
    const v = collected.values[p.key];
    if (v !== p.default) next[p.key] = v;   // store only non-default values
    if (prev == null || prev[p.key] !== v){
      if (!(prev == null && v === p.default)) anyChanged = true;
    }
  }
  state.params[ind.id] = next;
  saveParams();
  closeSettings();
  if (anyChanged) applyParams(ind);
  else { buildChips(); }
}

function settingsToDefaults(){
  const ind = settings.ind;
  if (!ind) return;
  for (const p of ind.params){
    settings.inputs[p.key] = String(p.default);
  }
  const inputs = paramGrid.querySelectorAll("input");
  for (const input of inputs){
    const p = ind.params.find(sp => sp.key === input.dataset.key);
    if (p) input.value = String(p.default);
  }
}

settingsClose.addEventListener("click", closeSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsDefaults.addEventListener("click", settingsToDefaults);
settingsOk.addEventListener("click", applySettings);
settingsBackdrop.addEventListener("mousedown", (e) => { if (e.target === settingsBackdrop) closeSettings(); });

window.addEventListener("keydown", (e) => {
  if (settingsBackdrop.hidden) return;
  if (e.key === "Escape"){ e.preventDefault(); closeSettings(); }
});

// Recompute one indicator after a params change, keeping the replay position.
function applyParams(ind){
  if (state.live){
    refreshFromServer();       // server recomputes everything with ?params=
  } else {
    const jsInd = JS_INDICATORS.find(j => j.id === ind.id);
    if (!jsInd) return;
    if (ind.dynamic){
      recomputeDynamic();   // as-of replay position, not full history
    } else {
      const res = jsInd.compute(state.bars, cleanJSParams(jsInd, state.params[ind.id]));
      for (const key in state.ind){
        if (state.ind[key].group === ind.id) delete state.ind[key];
      }
      for (const key in res){
        res[key].group = ind.id;
        state.ind[key] = res[key];
      }
    }
    buildChips();
    updateReadouts();
    render();
  }
}

// Re-fetch from the backend with the current params, preserving replay state.
async function refreshFromServer(){
  const seq = ++loadSeq;
  const symbol = symbolInput.value.trim() || "BTC/USDT";
  const timeframe = tfSelect.value;
  const limit = Math.max(20, Math.min(3000, parseInt(limitInput.value, 10) || 500));
  const keepCount = state.count;
  const wasPlaying = state.playing;
  pause();

  let payload = null;
  try {
    const q = new URLSearchParams({
      symbol, timeframe, limit: String(limit),
      params: JSON.stringify(state.params),
    });
    const res = await fetch("/api/ohlcv?" + q.toString());
    if (res.ok){
      const j = await res.json();
      if (seq !== loadSeq) return;
      if (j && j.bars && j.bars.length) payload = j;
    }
  } catch (e){ /* fall through to offline */ }

  if (!payload){
    // Backend disappeared mid-session: fall back to the JS mirror so the
    // param change still applies, then surface why the badge changed.
    const bars = state.bars.length ? state.bars : syntheticBars(limit);
    payload = {
      bars,
      indicators: computeJSIndicators(bars, state.params),
      indicator_list: JS_INDICATORS.map(i => ({ id: i.id, name: i.name, pane: i.pane, params: i.params, dynamic: !!i.dynamic })),
      source: "synthetic-fallback",
      error: "Backend not reachable — showing offline demo data.",
    };
  }
  if (seq !== loadSeq) return;

  const prevSelected = new Set(state.selected);
  state.bars = payload.bars;
  state.ind = payload.indicators || {};
  state.indicatorList = payload.indicator_list || [];
  state.selected = new Set(state.indicatorList.filter(i => prevSelected.has(i.id)).map(i => i.id));
  if (state.selected.size === 0 && prevSelected.size === 0){
    state.selected = new Set(state.indicatorList.map(i => i.id));
  }
  state.source = payload.source || "unknown";
  state.live = String(state.source).startsWith("ccxt");
  state.count = Math.min(Math.max(1, keepCount), state.bars.length);
  setBadge(state.source);
  if (payload.error) showError(payload.error); else hideError();
  recomputeDynamic();
  buildChips();
  updateReadouts();
  render();
  if (wasPlaying) play();
}

// ---------- dynamic (repainting) indicators ----------
// DYNAMIC indicators (ZigZag) are recomputed from bars[0..count] on every
// replay step, so the revealed values match what a real-time chart would
// have shown at that bar — pivots appear late and the developing leg moves.
function recomputeDynamic(){
  for (const ind of state.indicatorList){
    if (!ind.dynamic) continue;
    const jsInd = JS_INDICATORS.find(j => j.id === ind.id);
    if (!jsInd) continue;
    const p = cleanJSParams(jsInd, state.params[ind.id]);
    const res = jsInd.compute(state.bars.slice(0, state.count), p);
    for (const key in state.ind){
      if (state.ind[key].group === ind.id) delete state.ind[key];
    }
    for (const key in res){
      res[key].group = ind.id;
      state.ind[key] = res[key];
    }
  }
}

// ---------- readouts ----------
function updateReadouts(){
  const n = state.count;
  const b = n > 0 ? state.bars[n - 1] : null;
  if (b){
    const cls = b.close >= b.open ? "up" : "down";
    ohlcReadout.innerHTML =
      `<span class="k o">O <b>${fmtPrice(b.open)}</b></span>` +
      `<span class="k h">H <b>${fmtPrice(b.high)}</b></span>` +
      `<span class="k l">L <b>${fmtPrice(b.low)}</b></span>` +
      `<span class="k c ${cls}">C <b>${fmtPrice(b.close)}</b></span>`;
  } else {
    ohlcReadout.innerHTML = `<span class="k o">O <b>–</b></span><span class="k h">H <b>–</b></span><span class="k l">L <b>–</b></span><span class="k c">C <b>–</b></span>`;
  }

  const parts = [];
  for (const ind of state.indicatorList){
    if (!state.selected.has(ind.id)) continue;
    const first = firstSeriesOf(ind.id);
    let val = "–";
    if (first && n > 0){
      const v = first.meta.values[n - 1];
      val = fmtNum(v);
    }
    parts.push(`<span><span class="rd-dot" style="background:${chipColor(ind.id)}"></span>${ind.name} <b>${val}</b></span>`);
  }
  indReadout.innerHTML = parts.join("");

  counter.textContent = `${n} / ${state.bars.length}`;
  progress.max = Math.max(0, state.bars.length - 1);
  progress.value = Math.max(0, n - 1);
  barTime.textContent = b ? fmtTime(b.time) : "–";
}
function firstSeriesOf(indId){
  // Prefer the indicator's primary series for the legend readout…
  for (const key in state.ind){
    if (state.ind[key].group === indId && state.ind[key].primary) return { key, meta: state.ind[key] };
  }
  // …falling back to its first series (pre-param behaviour).
  for (const key in state.ind){
    if (state.ind[key].group === indId) return { key, meta: state.ind[key] };
  }
  return null;
}

// ---------- replay controls ----------
function setCount(n){
  state.count = Math.max(0, Math.min(state.bars.length, Math.round(n)));
  recomputeDynamic();
  updateReadouts();
  render();
}
function tick(){
  if (state.count >= state.bars.length){ pause(); return; }
  setCount(state.count + 1);
}
function play(){
  if (state.bars.length === 0) return;
  if (state.count >= state.bars.length) setCount(1);
  state.playing = true;
  clearInterval(state.timer);
  state.timer = setInterval(tick, state.speedMs);
  playBtn.textContent = "⏸ Pause";
  playBtn.classList.add("paused");
}
function pause(){
  state.playing = false;
  clearInterval(state.timer);
  playBtn.textContent = "▶ Play";
  playBtn.classList.remove("paused");
}

playBtn.addEventListener("click", () => state.playing ? pause() : play());
startBtn.addEventListener("click", () => { pause(); setCount(1); });
endBtn.addEventListener("click", () => { pause(); setCount(state.bars.length); });
stepBackBtn.addEventListener("click", () => { pause(); setCount(state.count - 1); });
stepFwdBtn.addEventListener("click", () => { pause(); setCount(state.count + 1); });
progress.addEventListener("input", () => { pause(); setCount(parseInt(progress.value, 10) + 1); });
speedSelect.addEventListener("change", () => {
  state.speedMs = parseInt(speedSelect.value, 10);
  if (state.playing){ clearInterval(state.timer); state.timer = setInterval(tick, state.speedMs); }
});

window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) return;
  if (e.code === "Space"){ e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.code === "ArrowRight"){ pause(); setCount(state.count + 1); }
  else if (e.code === "ArrowLeft"){ pause(); setCount(state.count - 1); }
});

// ---------- mouse ----------
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  state.mouseY = my;
  const n = state.count;
  if (n === 0){ state.hover = -1; return; }
  const subKeys = paneOrder();
  const L = layout(canvas.clientWidth, canvas.clientHeight, subKeys);
  const barW = L.innerW / n;
  const idx = Math.floor((mx - L.left) / barW);
  state.hover = (mx < L.left || mx > L.left + L.innerW) ? -1 : Math.max(0, Math.min(n - 1, idx));
  render();
});
canvas.addEventListener("mouseleave", () => {
  state.hover = -1; state.mouseY = null; crossTip.style.display = "none"; render();
});

// ---------- data loading ----------
function setBadge(text){
  if (text === "loading…"){ sourceBadge.textContent = "loading…"; sourceBadge.className = "source-badge"; return; }
  if (text && text.startsWith("ccxt")){ sourceBadge.textContent = "live · " + text; sourceBadge.className = "source-badge live"; }
  else if (text === "synthetic-fallback"){ sourceBadge.textContent = "offline demo data"; sourceBadge.className = "source-badge offline"; }
  else { sourceBadge.textContent = text; sourceBadge.className = "source-badge"; }
}

async function loadData(){
  const seq = ++loadSeq;
  const symbol = symbolInput.value.trim() || "BTC/USDT";
  const timeframe = tfSelect.value;
  const limit = Math.max(20, Math.min(3000, parseInt(limitInput.value, 10) || 500));
  setBadge("loading…");
  hideError();
  emptyState.textContent = "Loading…";
  emptyState.style.display = "flex";

  let payload = null;
  try {
    const q = new URLSearchParams({
      symbol, timeframe, limit: String(limit),
      params: JSON.stringify(state.params),
    });
    const res = await fetch("/api/ohlcv?" + q.toString());
    if (res.ok){
      const j = await res.json();
      if (seq !== loadSeq) return; // a newer request already started
      if (j && j.bars && j.bars.length) payload = j;
    }
  } catch (e){ /* backend not reachable — fall through */ }

  if (!payload){
    const bars = syntheticBars(limit);
    payload = {
      bars,
      indicators: computeJSIndicators(bars, state.params),
      indicator_list: JS_INDICATORS.map(i => ({ id: i.id, name: i.name, pane: i.pane, params: i.params, dynamic: !!i.dynamic })),
      source: "synthetic-fallback",
      error: "Backend not reachable — showing offline demo data.",
    };
  }
  if (seq !== loadSeq) return;
  applyPayload(payload);
}

function applyPayload(p){
  const prevSelected = new Set(state.selected);
  const prevCount = state.count;
  const hadData = state.bars.length > 0;
  state.bars = p.bars;
  state.ind = p.indicators || {};
  state.indicatorList = p.indicator_list || [];
  // Keep the user's toggles across refetches; select all on the first load.
  state.selected = new Set(state.indicatorList.filter(i => prevSelected.has(i.id)).map(i => i.id));
  if (state.selected.size === 0 && prevSelected.size === 0){
    state.selected = new Set(state.indicatorList.map(i => i.id));
  }
  state.source = p.source || "unknown";
  state.live = String(state.source).startsWith("ccxt");
  state.count = hadData ? Math.min(Math.max(1, prevCount), state.bars.length) : state.bars.length;
  state.hover = -1;
  state.mouseY = null;
  pause();
  setBadge(state.source);
  if (p.error) showError(p.error); else hideError();
  recomputeDynamic();
  buildChips();
  updateReadouts();
  render();
}

// ---------- sizing & boot ----------
function resize(){
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

window.addEventListener("resize", resize);
fetchBtn.addEventListener("click", loadData);

// Auto-refetch whenever symbol / timeframe / bar-count change.
symbolInput.addEventListener("change", loadData);
symbolInput.addEventListener("keydown", e => { if (e.key === "Enter") loadData(); });
tfSelect.addEventListener("change", loadData);
limitInput.addEventListener("change", loadData);

window.addEventListener("load", () => {
  state.params = loadSavedParams();
  resize();
  loadData();
});
