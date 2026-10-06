// ══════════════════════════════════════════════════════════
//   MASTER AI — SIGNAL ENGINE (11 Indicators) — v2
//   Data Source: Twelve Data (REST API)
//
//   v2 ফিক্স:
//   • দুর্বল ভোট (weight-এর ৫০% এর কম) এখন কনফিডেন্সে গোনা হয় না
//   • Fractal / Pattern না থাকলে maxScore বাড়ে না (আগে strength ৫০-এর দিকে টানত)
//   • MACD এখন সঠিক EMA(9) সিগনাল লাইন ব্যবহার করে
//   • CALL/PUT-এর জন্য কমপক্ষে ৫টি শক্ত ভোট একমত হতে হবে
// ══════════════════════════════════════════════════════════

const mk = (pairs, cat) =>
  pairs.map(p => ({ name: p, td: p, tv: 'FX:' + p.replace('/', ''), cat }))

export const forexMarkets = [
  ...mk(['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD'], 'Major'),
  ...mk([
    'EUR/GBP', 'EUR/JPY', 'EUR/CHF', 'EUR/CAD', 'EUR/AUD', 'EUR/NZD',
    'GBP/JPY', 'GBP/CHF', 'GBP/CAD', 'GBP/AUD', 'GBP/NZD',
    'AUD/JPY', 'AUD/CHF', 'AUD/CAD', 'AUD/NZD',
    'NZD/JPY', 'NZD/CHF', 'NZD/CAD',
    'CAD/JPY', 'CAD/CHF', 'CHF/JPY',
  ], 'Cross'),
  ...mk([
    'USD/SGD', 'USD/HKD', 'USD/SEK', 'USD/NOK', 'USD/DKK', 'USD/MXN', 'USD/ZAR',
    'USD/TRY', 'USD/PLN', 'USD/HUF', 'USD/CZK', 'EUR/SEK', 'EUR/NOK', 'EUR/PLN',
    'EUR/TRY', 'GBP/SEK', 'GBP/NOK', 'SGD/JPY', 'USD/INR', 'USD/THB', 'USD/CNH',
  ], 'Exotic'),
]

// Ichimoku 52, MACD 35, EMA50 50 → 60 বাফার
export const MIN_CANDLES = 60

// কমপক্ষে কতটি শক্ত ভোট একমত হলে সিগনাল (১১টির মধ্যে)
const MIN_STRONG_AGREE = 5

// ══════════════════════════════════════════════════════════
//   CORE MATH HELPERS
// ══════════════════════════════════════════════════════════

const emaSeries = (arr, p) => {
  if (arr.length < p) return []
  const k = 2 / (p + 1)
  let val = arr.slice(0, p).reduce((a, b) => a + b, 0) / p
  const out = [val]
  for (let i = p; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k)
    out.push(val)
  }
  return out
}

const ema = (arr, p) => {
  const s = emaSeries(arr, p)
  return s.length ? s[s.length - 1] : null
}

const rsi = (arr, p = 14) => {
  if (arr.length < p + 1) return null
  const ch = arr.slice(-(p + 1)).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1)
  const ag = ch.filter(c => c > 0).reduce((a, b) => a + b, 0) / p
  const al = ch.filter(c => c < 0).reduce((a, b) => a - b, 0) / p
  if (al === 0) return 100
  return 100 - 100 / (1 + ag / al)
}

const bb = (arr, p = 20) => {
  if (arr.length < p) return null
  const sl = arr.slice(-p)
  const mid = sl.reduce((a, b) => a + b, 0) / p
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p)
  return { upper: mid + 2 * std, mid, lower: mid - 2 * std }
}

// সঠিক MACD: EMA12 − EMA26, সিগনাল = MACD লাইনের EMA9
const macdFull = (arr) => {
  if (arr.length < 35) return null
  const e12 = emaSeries(arr, 12) // index 0 ↔ arr[11]
  const e26 = emaSeries(arr, 26) // index 0 ↔ arr[25]
  const lineSeries = []
  for (let i = 25; i < arr.length; i++) lineSeries.push(e12[i - 11] - e26[i - 25])
  const sigSeries = emaSeries(lineSeries, 9)
  if (!sigSeries.length) return null
  const line = lineSeries[lineSeries.length - 1]
  const signal = sigSeries[sigSeries.length - 1]
  return { line, signal, hist: line - signal }
}

const stoch = (candles, p = 14) => {
  if (candles.length < p) return null
  const sl = candles.slice(-p)
  const hh = Math.max(...sl.map(c => parseFloat(c.high)))
  const ll = Math.min(...sl.map(c => parseFloat(c.low)))
  const cl = parseFloat(candles[candles.length - 1].close)
  if (hh === ll) return 50
  return ((cl - ll) / (hh - ll)) * 100
}

const patternScore = (candles) => {
  if (candles.length < 3) return 0
  const last = candles.slice(-3).map(c => {
    const o = parseFloat(c.open), cl = parseFloat(c.close)
    const h = parseFloat(c.high), l = parseFloat(c.low)
    return { o, cl, h, l, body: Math.abs(cl - o), bull: cl > o }
  })
  const [c2, c1, c0] = last
  const lw = Math.min(c0.o, c0.cl) - c0.l
  const uw = c0.h - Math.max(c0.o, c0.cl)

  if (c0.bull && !c1.bull && c0.o <= c1.cl && c0.cl >= c1.o && c0.body > c1.body) return 2
  if (!c0.bull && c1.bull && c0.o >= c1.cl && c0.cl <= c1.o && c0.body > c1.body) return -2
  if (lw > c0.body * 2 && uw < c0.body * 0.3) return 1
  if (uw > c0.body * 2 && lw < c0.body * 0.3) return -1
  if (!c2.bull && c1.body < c2.body * 0.3 && c0.bull && c0.cl > (c2.o + c2.cl) / 2) return 2
  if (c2.bull && c1.body < c2.body * 0.3 && !c0.bull && c0.cl < (c2.o + c2.cl) / 2) return -2
  if (last.every(c => c.bull)) return 1
  if (last.every(c => !c.bull)) return -1
  return 0
}

// ══════════════════════════════════════════════════════════
//   TOP-TIER INDICATORS
// ══════════════════════════════════════════════════════════

const calcADX = (candles, p = 14) => {
  if (candles.length < p * 2 + 1) return null
  const highs = candles.map(c => parseFloat(c.high))
  const lows = candles.map(c => parseFloat(c.low))
  const closes = candles.map(c => parseFloat(c.close))

  const plusDM = [], minusDM = [], TRs = []
  for (let i = 1; i < candles.length; i++) {
    const upMove = highs[i] - highs[i - 1]
    const downMove = lows[i - 1] - lows[i]
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    TRs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ))
  }

  const wilderSmooth = (arr, period) => {
    const out = [arr.slice(0, period).reduce((a, b) => a + b, 0)]
    for (let i = period; i < arr.length; i++) {
      out.push(out[out.length - 1] - out[out.length - 1] / period + arr[i])
    }
    return out
  }

  const sTR = wilderSmooth(TRs, p)
  const sPlus = wilderSmooth(plusDM, p)
  const sMinus = wilderSmooth(minusDM, p)

  const plusDI = sPlus.map((v, i) => 100 * v / (sTR[i] || 1))
  const minusDI = sMinus.map((v, i) => 100 * v / (sTR[i] || 1))
  const dx = plusDI.map((v, i) => 100 * Math.abs(v - minusDI[i]) / ((v + minusDI[i]) || 1))

  if (dx.length < p) return null
  let adxVal = dx.slice(0, p).reduce((a, b) => a + b, 0) / p
  for (let i = p; i < dx.length; i++) adxVal = (adxVal * (p - 1) + dx[i]) / p

  return { adx: adxVal, plusDI: plusDI.at(-1), minusDI: minusDI.at(-1) }
}

const calcSupertrend = (candles, period = 10, mult = 3) => {
  if (candles.length < period + 2) return null
  const highs = candles.map(c => parseFloat(c.high))
  const lows = candles.map(c => parseFloat(c.low))
  const closes = candles.map(c => parseFloat(c.close))

  const trs = []
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ))
  }
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  const atrSeries = [atrVal]
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period
    atrSeries.push(atrVal)
  }

  let trend = 1, finalUpper = 0, finalLower = 0
  const offset = candles.length - atrSeries.length
  for (let i = 0; i < atrSeries.length; i++) {
    const idx = i + offset
    const hl2 = (highs[idx] + lows[idx]) / 2
    const bUpper = hl2 + mult * atrSeries[i]
    const bLower = hl2 - mult * atrSeries[i]
    if (i === 0) { finalUpper = bUpper; finalLower = bLower; continue }
    const prevClose = closes[idx - 1]
    finalUpper = (bUpper < finalUpper || prevClose > finalUpper) ? bUpper : finalUpper
    finalLower = (bLower > finalLower || prevClose < finalLower) ? bLower : finalLower
    if (trend === 1 && closes[idx] < finalLower) trend = -1
    else if (trend === -1 && closes[idx] > finalUpper) trend = 1
  }
  return { trend, value: trend === 1 ? finalLower : finalUpper }
}

const calcIchimoku = (candles) => {
  if (candles.length < 52) return null
  const highs = candles.map(c => parseFloat(c.high))
  const lows = candles.map(c => parseFloat(c.low))
  const close = parseFloat(candles.at(-1).close)
  const periodHL = (p) => (Math.max(...highs.slice(-p)) + Math.min(...lows.slice(-p))) / 2

  const tenkan = periodHL(9)
  const kijun = periodHL(26)
  const spanA = (tenkan + kijun) / 2
  const spanB = periodHL(52)

  return {
    tenkan, kijun, spanA, spanB,
    aboveCloud: close > Math.max(spanA, spanB),
    belowCloud: close < Math.min(spanA, spanB),
    tkCross: tenkan > kijun ? 1 : tenkan < kijun ? -1 : 0,
  }
}

// Williams Fractal (n=2). শুধু নিশ্চিত হওয়া পিভট, রিপেইন্ট করে না।
const calcFractal2 = (candles, n = 2) => {
  if (candles.length < n * 2 + 1) return null
  const highs = candles.map(c => parseFloat(c.high))
  const lows = candles.map(c => parseFloat(c.low))

  const idx = candles.length - 1 - n
  if (idx < n) return null

  let isHigh = true, isLow = true
  for (let i = 1; i <= n; i++) {
    if (!(highs[idx] > highs[idx - i] && highs[idx] > highs[idx + i])) isHigh = false
    if (!(lows[idx] < lows[idx - i] && lows[idx] < lows[idx + i])) isLow = false
  }

  if (isHigh) return { type: 'high' }
  if (isLow) return { type: 'low' }
  return null
}

// ══════════════════════════════════════════════════════════
//   MASTER SIGNAL ENGINE
// ══════════════════════════════════════════════════════════
export const runSignalEngine = (candles) => {
  const EMPTY = { direction: null, strength: 50, breakdown: {}, confidence: 0, bulls: 0, bears: 0 }
  if (!candles || candles.length < MIN_CANDLES) return EMPTY

  const closes = candles.map(c => parseFloat(c.close))
  const last = closes[closes.length - 1]
  let score = 0, maxScore = 0
  let strongBulls = 0, strongBears = 0
  const bd = {}

  // একটি ইন্ডিকেটরের ভোট নথিভুক্ত করে।
  // শক্ত ভোট = weight-এর কমপক্ষে ৫০%। দুর্বল ভোট স্কোরে যায় (ছোট ওজনে)
  // কিন্তু কনফিডেন্সে গোনা হয় না, আর স্ক্রিনে "দুর্বল" দেখায়।
  const vote = (label, v, weight) => {
    score += v
    maxScore += weight
    const strong = Math.abs(v) >= weight * 0.5
    if (strong) {
      if (v > 0) strongBulls++
      else strongBears++
      bd[label] = v > 0 ? '↑ BULL' : '↓ BEAR'
    } else {
      bd[label] = v > 0 ? '↑ দুর্বল' : '↓ দুর্বল'
    }
  }
  const neutral = (label) => { bd[label] = '→ NEUTRAL' }

  // 1. ADX + DI — weight 16
  const ax = calcADX(candles, 14)
  if (ax) {
    let v
    if (ax.adx > 25) v = ax.plusDI > ax.minusDI ? 16 : -16
    else if (ax.adx > 20) v = ax.plusDI > ax.minusDI ? 8 : -8
    else v = ax.plusDI > ax.minusDI ? 4 : -4
    vote(`ADX ${ax.adx.toFixed(0)}`, v, 16)
  } else neutral('ADX')

  // 2. Supertrend — weight 16
  const st2 = calcSupertrend(candles, 10, 3)
  if (st2) vote('Supertrend', st2.trend === 1 ? 16 : -16, 16)
  else neutral('Supertrend')

  // 3. Ichimoku — weight 16
  const ich = calcIchimoku(candles)
  if (ich) {
    let v
    if (ich.aboveCloud) v = 16
    else if (ich.belowCloud) v = -16
    else if (ich.tkCross !== 0) v = ich.tkCross * 4
    else v = last >= ich.kijun ? 4 : -4
    vote('Ichimoku', v, 16)
  } else neutral('Ichimoku')

  // 4. Fractal 2 — ইভেন্ট-ভিত্তিক। পিভট না থাকলে NEUTRAL এবং
  //    maxScore বাড়ে না (আগে fallback momentum দিয়ে নকল ভোট হতো)
  const fr = calcFractal2(candles, 2)
  if (fr) vote('Fractal 2', fr.type === 'low' ? 16 : -16, 16)
  else neutral('Fractal 2')

  // 5. EMA 8/21 — weight 14
  const e8 = ema(closes, 8), e21 = ema(closes, 21)
  if (e8 && e21) {
    const gap = Math.abs((e8 - e21) / e21) * 100
    const w = Math.min(14, gap * 250)
    vote('EMA 8/21', e8 > e21 ? w : -w, 14)
  } else neutral('EMA 8/21')

  // 6. EMA 21/50 — weight 12
  const e50 = ema(closes, 50)
  if (e21 && e50) vote('EMA 21/50', e21 > e50 ? 12 : -12, 12)
  else neutral('EMA 21/50')

  // 7. RSI — weight 14
  const r = rsi(closes, 14)
  if (r !== null) {
    let v
    if (r < 25) v = 14
    else if (r < 35) v = 9
    else if (r < 45) v = 3
    else if (r > 75) v = -14
    else if (r > 65) v = -9
    else if (r > 55) v = -3
    else v = r >= 50 ? 1 : -1
    vote(`RSI ${r.toFixed(0)}`, v, 14)
  } else neutral('RSI')

  // 8. Bollinger — weight 12
  const b = bb(closes, 20)
  if (b && b.upper !== b.lower) {
    const pct = (last - b.lower) / (b.upper - b.lower)
    let v
    if (pct < 0.05) v = 12
    else if (pct < 0.2) v = 7
    else if (pct < 0.4) v = 3
    else if (pct > 0.95) v = -12
    else if (pct > 0.8) v = -7
    else if (pct > 0.6) v = -3
    else v = pct >= 0.5 ? 1 : -1
    vote('Bollinger', v, 12)
  } else neutral('Bollinger')

  // 9. MACD — weight 12
  const m = macdFull(closes)
  if (m) {
    const cv = m.line > m.signal ? 7 : -7
    const hv = m.hist > 0 ? 5 : -5
    vote('MACD', cv + hv, 12)
  } else neutral('MACD')

  // 10. Stochastic — weight 10
  const st = stoch(candles, 14)
  if (st !== null) {
    let v
    if (st < 20) v = 10
    else if (st < 35) v = 5
    else if (st > 80) v = -10
    else if (st > 65) v = -5
    else v = st >= 50 ? 1 : -1
    vote(`Stoch ${st.toFixed(0)}`, v, 10)
  } else neutral('Stoch')

  // 11. Candle Pattern — weight 10. প্যাটার্ন না থাকলে NEUTRAL, maxScore বাড়ে না
  const pat = patternScore(candles)
  if (pat !== 0) vote('Pattern', pat * 5, 10)
  else neutral('Pattern')

  // ── Final scoring ────────────────────────────────────────────
  if (maxScore === 0) return EMPTY
  const strength = Math.round(((score / maxScore) + 1) / 2 * 100)

  // কনফিডেন্স = শুধু শক্ত ভোটের মধ্যে কত % একমত
  const strongTotal = strongBulls + strongBears
  const confidence = strongTotal > 0
    ? Math.round((Math.max(strongBulls, strongBears) / strongTotal) * 100)
    : 0

  let direction = null
  if (strength >= 65 && confidence >= 70 && strongBulls >= MIN_STRONG_AGREE) direction = 'CALL'
  else if (strength <= 35 && confidence >= 70 && strongBears >= MIN_STRONG_AGREE) direction = 'PUT'

  return { direction, strength, breakdown: bd, confidence, bulls: strongBulls, bears: strongBears }
  }
