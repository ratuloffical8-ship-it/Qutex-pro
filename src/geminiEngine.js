// ══════════════════════════════════════════════════════════
//   GEMINI GHOST-CANDLE PREDICTOR — 2 chained future candles
//   v2: অটো মডেল-ডিসকভারি + ফলব্যাক চেইন + রিট্রাই + বাংলা এরর ডায়াগনোসিস
//
//   কীভাবে কাজ করে:
//   1. Google-এর ListModels API থেকে এই মুহূর্তে কোন মডেল চালু আছে জানে (৩০ মিনিট ক্যাশ)
//   2. সবচেয়ে নতুন/ভালো Flash মডেল আগে, তারপর পুরনোগুলো — এভাবে চেইন বানায়
//   3. কোনো মডেল ব্যর্থ হলে পরেরটায় যায়; ব্যর্থ মডেলকে কিছুক্ষণ বিশ্রাম দেয়
//   4. সব ব্যর্থ হলে কারণ + সমাধান বাংলায় ফেরত দেয় (reason ফিল্ডে)
//   Candle 2-এর OPEN সবসময় Candle 1-এর CLOSE-এর সমান (কোডে জোর করে বসানো)
// ══════════════════════════════════════════════════════════

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ListModels কাজ না করলে এই তালিকা ব্যবহার হবে (ভালো → সাধারণ ক্রমে)
const PREFERRED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview', // Pro ধীর, তাই শেষ ভরসা
]

const MODEL_LIST_TTL = 30 * 60 * 1000 // ৩০ মিনিট
const COOLDOWN_TEMP = 60 * 1000 // 503/429 হলে ১ মিনিট বিশ্রাম
const COOLDOWN_GONE = 30 * 60 * 1000 // 404 (মডেল বন্ধ) হলে ৩০ মিনিট বিশ্রাম

let modelCache = { at: 0, list: null }
const cooldown = new Map() // model -> কখন পর্যন্ত স্কিপ করবো
let lastWorking = null
const reqSeq = new Map() // পেয়ার -> সর্বশেষ রিকোয়েস্ট নম্বর (পুরনো উত্তর চেনার জন্য)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────
// ১) মডেল তালিকা
// ─────────────────────────────────────────────
async function getModelChain(key) {
  const now = Date.now()
  if (!modelCache.list || now - modelCache.at > MODEL_LIST_TTL) {
    try {
      const res = await fetch(`${API_BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`)
      const data = await res.json()
      if (res.ok && Array.isArray(data.models)) {
        modelCache = {
          at: now,
          list: data.models
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, '')),
        }
      } else {
        modelCache = { at: now - MODEL_LIST_TTL + 60 * 1000, list: null } // ১ মিনিট পরে আবার চেষ্টা
      }
    } catch {
      modelCache = { at: now - MODEL_LIST_TTL + 60 * 1000, list: null }
    }
  }

  const available = modelCache.list
  if (!available) return PREFERRED_MODELS.slice()

  // স্থায়ী (stable) Flash মডেল: ভার্সন বড় → আগে; Lite → পরে
  const flash = available
    .map(name => {
      const m = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/)
      return m ? { name, ver: parseFloat(m[1]), lite: !!m[2] } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.ver - a.ver || Number(a.lite) - Number(b.lite))
    .map(x => x.name)

  // পছন্দের তালিকার যেগুলো চালু আছে কিন্তু উপরে ধরা পড়েনি (preview/pro)
  const extras = PREFERRED_MODELS.filter(n => available.includes(n) && !flash.includes(n))
  const chain = [...flash, ...extras]
  return chain.length ? chain : PREFERRED_MODELS.slice()
}

// ─────────────────────────────────────────────
// ২) এরর ব্যাখ্যা (বাংলা)
// ─────────────────────────────────────────────
function explainError(status, message = '') {
  const m = String(message).toLowerCase()

  if (status === 'NETWORK') return {
    fatal: false,
    cause: 'Gemini সার্ভারে পৌঁছানো যায়নি (ইন্টারনেট/নেটওয়ার্ক সমস্যা)',
    fix: 'ইন্টারনেট বা VPN চেক করুন, অ্যাড-ব্লকার বন্ধ করে আবার চেষ্টা করুন',
  }
  if (status === 400 && (m.includes('api key') || m.includes('api_key'))) return {
    fatal: true,
    cause: 'আপনার Gemini API Key ভুল বা মেয়াদ শেষ',
    fix: 'aistudio.google.com/apikey থেকে নতুন key নিয়ে অ্যাপে বসান',
  }
  if (status === 400 && m.includes('location')) return {
    fatal: true,
    cause: 'আপনার দেশ/অঞ্চল থেকে এই API ব্যবহার করা যাচ্ছে না',
    fix: 'সার্ভার এমন দেশে হোস্ট করুন যেখানে Gemini API সাপোর্টেড, অথবা সাপোর্টেড লোকেশনের সার্ভার থেকে কল করুন',
  }
  if (status === 400) return {
    fatal: false,
    cause: 'রিকোয়েস্টের ফরম্যাটে সমস্যা (400)',
    fix: 'কনসোলে এরর মেসেজ দেখুন: ' + message.slice(0, 80),
  }
  if (status === 401 || status === 403) return {
    fatal: true,
    cause: 'API Key-র অনুমতি নেই (401/403): key সীমাবদ্ধ, ভুল প্রজেক্টের, বা Generative Language API চালু নেই',
    fix: 'AI Studio-তে key-র restriction চেক করুন এবং Google Cloud-এ Generative Language API চালু করুন; দরকারে নতুন key বানান',
  }
  if (status === 404) return {
    fatal: false,
    cause: 'এই মডেলটি Google বন্ধ করে দিয়েছে বা নাম বদলেছে (404)',
    fix: 'কিছু করতে হবে না, কোড অটো পরের মডেলে গেছে; সব মডেলে এলে PREFERRED_MODELS তালিকা আপডেট করুন',
  }
  if (status === 429) return {
    fatal: false,
    cause: 'কোটা/রেট-লিমিট শেষ (429): প্রতি মিনিট বা প্রতিদিনের সীমা পার হয়েছে',
    fix: 'কল কমান (প্রতি ক্যান্ডেলে ১ বার), অথবা AI Studio-তে বিলিং চালু করে লিমিট বাড়ান',
  }
  if (status === 500 || status === 503 || status === 504) return {
    fatal: false,
    cause: 'Google-এর সার্ভারে এখন লোড বেশি (' + status + '), এটি আপনার কোডের ভুল নয়',
    fix: 'অপেক্ষা করুন, কোড অটো অন্য মডেলে চেষ্টা করছে; বারবার হলে বিলিং চালু (Paid tier) করলে এটা অনেক কমে',
  }
  if (status === 'BLOCKED') return {
    fatal: false,
    cause: 'Gemini নিরাপত্তা ফিল্টারে উত্তর আটকে দিয়েছে',
    fix: 'প্রম্পটে "trade/signal" জাতীয় শব্দ কমিয়ে নিরপেক্ষ ভাষা ব্যবহার করুন',
  }
  if (status === 'EMPTY' || status === 'BAD_FORMAT') return {
    fatal: false,
    cause: 'Gemini উত্তর দিয়েছে কিন্তু ফরম্যাট ভুল বা অসম্পূর্ণ',
    fix: 'সাধারণত অস্থায়ী; অটো অন্য মডেলে চেষ্টা হচ্ছে',
  }
  return {
    fatal: false,
    cause: 'অজানা এরর: ' + String(message).slice(0, 80),
    fix: 'ব্রাউজার কনসোলে বিস্তারিত দেখুন',
  }
}

// ─────────────────────────────────────────────
// ৩) একটি মডেলে কল
// ─────────────────────────────────────────────
async function callModel(model, key, baseBody) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`

  const attempt = async (withThinking) => {
    const body = JSON.parse(JSON.stringify(baseBody))
    // Gemini 3 মডেলে "thinking" টোকেন আউটপুট লিমিট খেয়ে ফেলে, তাই low রাখা হলো
    if (withThinking && /^gemini-3/.test(model)) {
      body.generationConfig.thinkingConfig = { thinkingLevel: 'low' }
    }
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      return { ok: false, status: 'NETWORK', message: e.message }
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok && !data.error) return { ok: true, data }
    return { ok: false, status: res.status, message: data?.error?.message || `HTTP ${res.status}` }
  }

  let r = await attempt(true)
  // মডেল thinkingConfig না বুঝলে ছাড়া আবার চেষ্টা
  if (!r.ok && r.status === 400 && /think/i.test(r.message)) r = await attempt(false)
  return r
}

// ─────────────────────────────────────────────
// ৪) উত্তর পার্স ও যাচাই
// ─────────────────────────────────────────────
function parsePrediction(data, decimals) {
  if (data?.promptFeedback?.blockReason) return { error: 'BLOCKED', message: data.promptFeedback.blockReason }

  const cand = data?.candidates?.[0]
  const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim()
  if (!text) return { error: 'EMPTY', message: cand?.finishReason || 'empty response' }

  const line = text.split('\n').find(l => l.includes('|')) || text
  const parts = line.replace(/```/g, '').trim().split('|')
  if (parts.length < 9) return { error: 'BAD_FORMAT', message: 'fields=' + parts.length }

  const [o1, h1, l1, c1, h2, l2, c2] = parts.slice(0, 7).map(s => parseFloat(s))
  const confidence = parseInt(parts[7].replace(/[^0-9]/g, ''), 10)
  const reason = parts.slice(8).join('|').trim()
  const o2 = c1 // জোর করে চেইন: candle 2 ঠিক যেখানে candle 1 শেষ, সেখান থেকে শুরু

  const ok1 = [o1, h1, l1, c1].every(Number.isFinite) && h1 >= Math.max(o1, c1) && l1 <= Math.min(o1, c1)
  const ok2 = [h2, l2, c2].every(Number.isFinite) && h2 >= Math.max(o2, c2) && l2 <= Math.min(o2, c2)
  if (!ok1 || !ok2) return { error: 'BAD_FORMAT', message: 'invalid OHLC' }

  const round = (n) => Number(n.toFixed(decimals))
  return {
    result: {
      candle1: { open: round(o1), high: round(h1), low: round(l1), close: round(c1) },
      candle2: { open: round(o2), high: round(h2), low: round(l2), close: round(c2) },
      confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 50,
      reason: reason || '',
      ok: true,
    },
  }
}

// ─────────────────────────────────────────────
// ৫) প্রম্পট (আগের মতোই)
// ─────────────────────────────────────────────
// ── ডেটা যাচাই: শুধু আসল, পরিষ্কার, একই পেয়ারের ডেটা যাবে ──
const countDecimals = (v) => (String(v).split('.')[1] || '').length

function sanitizeCandles(raw) {
  if (!Array.isArray(raw) || raw.length < 20) {
    return { ok: false, candles: [], problem: 'ক্যান্ডেল ডেটা নেই বা ২০টির কম', fix: 'TwelveData থেকে ডেটা ঠিকমতো এসেছে কিনা দেখুন, তারপর আবার সিগনাল জেনারেট করুন' }
  }
  const seen = new Map()
  const clean = []
  for (const c of raw) {
    const o = parseFloat(c.open), h = parseFloat(c.high), l = parseFloat(c.low), cl = parseFloat(c.close)
    if (![o, h, l, cl].every(Number.isFinite)) continue
    if (h < Math.max(o, cl) || l > Math.min(o, cl)) continue // ভাঙা OHLC বাদ
    const dt = c.datetime ? String(c.datetime) : ''
    if (dt) {
      if (seen.has(dt)) {
        // একই সময়ে ভিন্ন দাম = দুই আলাদা উৎসের ডেটা মিশেছে
        if (Math.abs(seen.get(dt) - cl) / seen.get(dt) > 0.03) {
          return { ok: false, candles: [], problem: 'একই সময়ের ক্যান্ডেলে সম্পূর্ণ ভিন্ন দাম পাওয়া গেছে, দুই পেয়ারের ডেটা মিশে গেছে', fix: 'পেয়ার বদলালে আগের ক্যান্ডেল স্টেট পরিষ্কার করে শুধু নতুন পেয়ারের ডেটা পাঠান' }
        }
        continue // সাধারণ ডুপ্লিকেট বাদ
      }
      seen.set(dt, cl)
    }
    const vol = parseFloat(c.volume)
    clean.push({ datetime: dt, open: o, high: h, low: l, close: cl, volume: Number.isFinite(vol) ? vol : 0, _raw: String(c.close) })
  }
  clean.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0)) // পুরনো → নতুন

  if (clean.length < 20) {
    return { ok: false, candles: clean, problem: 'যাচাইয়ের পর ব্যবহারযোগ্য ক্যান্ডেল ২০টির কম', fix: 'ডেটা সোর্স চেক করুন' }
  }
  // মিশ্রণ ধরার পরীক্ষা: ১ মিনিটে ৩% এর বেশি লাফ বাস্তবে হয় না; হলে অন্য পেয়ারের ডেটা মিশেছে
  for (let i = 1; i < clean.length; i++) {
    const jump = Math.abs(clean[i].close - clean[i - 1].close) / clean[i - 1].close
    if (jump > 0.03) {
      return {
        ok: false, candles: clean,
        problem: `ক্যান্ডেল ডেটায় অস্বাভাবিক লাফ (${(jump * 100).toFixed(1)}%), অন্য পেয়ারের ডেটা মিশে থাকতে পারে`,
        fix: 'পেয়ার বদলালে আগের চার্ট/ক্যান্ডেল স্টেট পরিষ্কার করে নতুন পেয়ারের ডেটা আনুন',
      }
    }
  }
  const decimals = Math.min(6, Math.max(...clean.slice(-20).map(c => countDecimals(c._raw)), 2))
  return { ok: true, candles: clean, decimals }
}

// ── ইন্ডিকেটরের আসল মান, নিজেদের ক্যান্ডেল থেকে হিসাব ──
const emaSeries = (vals, p) => {
  const k = 2 / (p + 1)
  const out = [vals[0]]
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k))
  return out
}
const rsiCalc = (closes, p = 14) => {
  if (closes.length < p + 1) return null
  let g = 0, l = 0
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d }
  g /= p; l /= p
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    g = (g * (p - 1) + Math.max(d, 0)) / p
    l = (l * (p - 1) + Math.max(-d, 0)) / p
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l)
}

function computeIndicators(c, decimals) {
  const closes = c.map(x => x.close)
  const n = closes.length
  const P = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(decimals))
  const N = (v, d = 1) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d))
  const emaLast = (p) => (n >= p ? emaSeries(closes, p)[n - 1] : null)

  // ATR14
  let atr = null
  if (n > 14) {
    const trs = []
    for (let i = n - 14; i < n; i++) {
      trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)))
    }
    atr = trs.reduce((a, b) => a + b, 0) / trs.length
  }
  // Bollinger 20
  let bb = null
  if (n >= 20) {
    const w = closes.slice(-20)
    const mid = w.reduce((a, b) => a + b, 0) / 20
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / 20)
    bb = { up: mid + 2 * sd, mid, low: mid - 2 * sd }
  }
  // MACD 12/26/9
  let macd = null
  if (n >= 35) {
    const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26)
    const line = e12.map((v, i) => v - e26[i])
    const sig = emaSeries(line, 9)
    macd = { line: line[n - 1], sig: sig[n - 1], hist: line[n - 1] - sig[n - 1] }
  }
  // Stochastic %K 14
  let stoch = null
  if (n >= 14) {
    const w = c.slice(-14)
    const hh = Math.max(...w.map(x => x.high)), ll = Math.min(...w.map(x => x.low))
    stoch = hh === ll ? 50 : ((closes[n - 1] - ll) / (hh - ll)) * 100
  }
  const w40 = c.slice(-40)
  const last = c[n - 1]
  const body = Math.abs(last.close - last.open)
  const upWick = last.high - Math.max(last.open, last.close)
  const loWick = Math.min(last.open, last.close) - last.low

  return [
    `EMA8=${P(emaLast(8))}, EMA21=${P(emaLast(21))}, EMA50=${P(emaLast(50))}`,
    `RSI14=${N(rsiCalc(closes, 14))}, Stoch%K14=${N(stoch)}, ATR14=${P(atr)}`,
    bb ? `Bollinger20 upper=${P(bb.up)}, mid=${P(bb.mid)}, lower=${P(bb.low)}` : 'Bollinger20=n/a',
    macd ? `MACD line=${macd.line.toFixed(decimals + 1)}, signal=${macd.sig.toFixed(decimals + 1)}, hist=${macd.hist.toFixed(decimals + 1)}` : 'MACD=n/a',
    `Last40 resistance(high)=${P(Math.max(...w40.map(x => x.high)))}, support(low)=${P(Math.min(...w40.map(x => x.low)))}`,
    `Last candle: ${last.close >= last.open ? 'bullish' : 'bearish'}, body=${P(body)}, upperWick=${P(upWick)}, lowerWick=${P(loWick)}`,
  ].join('\n')
}

// শেষ N ক্যান্ডেল: সময় + OHLC (+ ভলিউম, থাকলে)
const candleDump = (candles, decimals, last = 40) => {
  const slice = candles.length > last ? candles.slice(-last) : candles
  const hasVol = slice.some(c => c.volume > 0)
  return slice
    .map(c => {
      const t = c.datetime ? c.datetime.slice(11, 16) + ' ' : ''
      const v = hasVol ? `,${c.volume}` : ''
      return `${t}${c.open.toFixed(decimals)},${c.high.toFixed(decimals)},${c.low.toFixed(decimals)},${c.close.toFixed(decimals)}${v}`
    })
    .join(';')
}

// ইঞ্জিনের নিজস্ব ইন্ডিকেটর মান থাকলে (engineResult.values / indicators) সেগুলোও পাঠানো হবে
const engineValuesDump = (engineResult) => {
  const ev = engineResult?.values || engineResult?.indicators || engineResult?.raw
  if (!ev || typeof ev !== 'object') return ''
  return Object.entries(ev)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(5)) : JSON.stringify(v)}`)
    .join(', ')
    .slice(0, 700)
}

const voteDump = (breakdown) => Object.entries(breakdown).map(([k, v]) => `${k}:${v}`).join(', ')

const SYSTEM_INSTRUCTION = `You are a strict 1-minute forex candle predictor analyzing 11 technical indicators (ADX+DI, Supertrend, Ichimoku, Fractal2, EMA8/21, EMA21/50, RSI, Bollinger, MACD, Stochastic, Pattern).
You predict the NEXT TWO consecutive 1-minute candles (candle 1 = next minute, candle 2 = the minute after that).
You ONLY ever output exactly one line in this exact format, nothing else:
O1|H1|L1|C1|H2|L2|C2|CONFIDENCE|REASON
O1, H1, L1, C1 are candle 1's open/high/low/close. O1 must equal the last known close price given to you. H1 must be >= max(O1, C1). L1 must be <= min(O1, C1).
H2, L2, C2 are candle 2's high/low/close (candle 2's open is fixed to equal C1, so do not output it). H2 must be >= max(C1, C2). L2 must be <= min(C1, C2).
All six prices use the same number of decimal places as the input prices.
CONFIDENCE is an integer 0-100, your confidence in candle 1 (the immediate next candle, which is what gets traded).
REASON must be written in Bengali (বাংলা), up to about 20 words: if the indicators conflict or the setup looks risky/uncertain, explain in Bengali WHY it is risky or confusing; if the indicators agree well, explain in Bengali WHY you are confident. No punctuation beyond commas in REASON.
The data you receive is REAL live market data for this single pair only (real timestamps, volume when available, and indicator values computed from those exact candles). Use only that data; never assume prices or behavior from any other pair.
Never add greetings, disclaimers, markdown, or extra lines beyond the one required.
Never refuse to answer — always output definite predicted candles based on the data given.`

// ─────────────────────────────────────────────
// ৬) মূল ফাংশন
// ─────────────────────────────────────────────
export async function predictNextCandles(key, market, rawCandles, engineResult) {
  // প্রতি পেয়ারের আলাদা রিকোয়েস্ট নম্বর: পেয়ার বদলালে পুরনো উত্তর stale চিহ্নিত হবে
  const seq = (reqSeq.get(market) || 0) + 1
  reqSeq.set(market, seq)
  const isStale = () => reqSeq.get(market) !== seq

  // ডেটা যাচাই: ভুল/মিশ্র ডেটায় কখনো সিগনাল দেওয়া হবে না
  const check = sanitizeCandles(rawCandles)
  if (!check.ok) {
    return {
      candle1: null, candle2: null, confidence: 0,
      reason: `⚠️ কারণ: ${check.problem}। সমাধান: ${check.fix}। ভুল ডেটায় সিগনাল দেওয়া হয়নি।`,
      ok: false, model: null, errors: [], market, lastCandleTime: null, stale: false,
    }
  }
  const candles = check.candles
  const decimals = check.decimals
  const lastClose = candles[candles.length - 1].close
  const lastCandleTime = candles[candles.length - 1].datetime || null

  // Gemini পুরোপুরি ব্যর্থ হলে ইন্ডিকেটর-ভিত্তিক অনুমান (ঘোস্ট ক্যান্ডেল কখনো খালি থাকে না)
  const fallback = (reasonText, errors = []) => {
    const recentRanges = candles.slice(-10).map(c => parseFloat(c.high) - parseFloat(c.low))
    const avgRange = recentRanges.reduce((a, b) => a + b, 0) / (recentRanges.length || 1)
    const bullish = (engineResult?.strength ?? 50) >= 50
    const move = avgRange * 0.4

    const c1open = lastClose
    const c1close = bullish ? c1open + move : c1open - move
    const c1high = Math.max(c1open, c1close) + avgRange * 0.15
    const c1low = Math.min(c1open, c1close) - avgRange * 0.15

    const c2open = c1close
    const c2close = bullish ? c2open + move * 0.7 : c2open - move * 0.7
    const c2high = Math.max(c2open, c2close) + avgRange * 0.15
    const c2low = Math.min(c2open, c2close) - avgRange * 0.15

    const round = (n) => Number(n.toFixed(decimals))
    return {
      candle1: { open: round(c1open), high: round(c1high), low: round(c1low), close: round(c1close) },
      candle2: { open: round(c2open), high: round(c2high), low: round(c2low), close: round(c2close) },
      confidence: 0,
      reason: reasonText,
      ok: false,
      model: null,
      errors,
      market,
      lastCandleTime,
      stale: isStale(),
    }
  }

  if (!key) {
    return fallback('⚠️ কারণ: Gemini API Key দেওয়া নেই। সমাধান: aistudio.google.com/apikey থেকে key নিয়ে বসান। এখন শুধু ইন্ডিকেটর দিয়ে অনুমান।')
  }

  const engineVals = engineValuesDump(engineResult)
  const prompt = `Pair: ${market} (timeframe 1m, real TwelveData candles, ${candles.length} candles available, last candle time: ${lastCandleTime || 'n/a'})
Recent 1m candles (oldest→newest) as "HH:mm o,h,l,c[,volume]" separated by ";":
${candleDump(candles, decimals)}

Indicator values computed from the real candles above:
${computeIndicators(candles, decimals)}
${engineVals ? `Engine indicator values: ${engineVals}\n` : ''}
Last known close (this is O1, the open of candle 1): ${lastClose.toFixed(decimals)}
All 11 indicator votes: ${voteDump(engineResult?.breakdown || {})}
Technical engine reading: strength=${engineResult?.strength ?? 50}/100, agreement=${engineResult?.confidence ?? 0}%

Respond with exactly one line: O1|H1|L1|C1|H2|L2|C2|CONFIDENCE|REASON`

  const baseBody = {
    systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // 1024: বাংলা টেক্সট + মডেলের ভেতরের চিন্তায় টোকেন বেশি লাগে, ১৪০ এ উত্তর কেটে যেত
    generationConfig: { temperature: 0.15, maxOutputTokens: 1024, candidateCount: 1 },
  }

  let chain
  try {
    chain = await getModelChain(key)
  } catch {
    chain = PREFERRED_MODELS.slice()
  }

  // শেষবার যে মডেল কাজ করেছিল সেটা আগে (যদি এখনো চেইনে থাকে)
  if (lastWorking && chain.includes(lastWorking) && chain[0] !== lastWorking) {
    const best = chain[0]
    // সেরা মডেল বিশ্রামে না থাকলে সেরাটাই আগে; নইলে lastWorking
    if ((cooldown.get(best) || 0) > Date.now()) chain = [lastWorking, ...chain.filter(m => m !== lastWorking)]
  }

  const now = Date.now()
  let ready = chain.filter(m => (cooldown.get(m) || 0) <= now)
  if (ready.length === 0) ready = chain // সবাই বিশ্রামে থাকলে সবাইকে আবার চেষ্টা

  const errors = []
  let fatal = null

  outer: for (const model of ready) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callModel(model, key, baseBody)

      if (r.ok) {
        const p = parsePrediction(r.data, decimals)
        if (p.result) {
          lastWorking = model
          return { ...p.result, model, errors, market, lastCandleTime, stale: isStale() }
        }
        errors.push({ model, status: p.error, message: p.message })
        break // ফরম্যাট ভুল: এই মডেলে আবার নয়, পরেরটায়
      }

      errors.push({ model, status: r.status, message: r.message })
      const info = explainError(r.status, r.message)

      if (info.fatal) { fatal = { model, ...r }; break outer } // key ভুল হলে কোনো মডেলেই কাজ হবে না

      if (r.status === 404) { cooldown.set(model, Date.now() + COOLDOWN_GONE); break }
      if (r.status === 429) { cooldown.set(model, Date.now() + COOLDOWN_TEMP); break } // কোটা মডেল-ভিত্তিক, পরেরটায় যাই

      if (attempt === 0 && (r.status === 503 || r.status === 500 || r.status === 504 || r.status === 'NETWORK')) {
        await sleep(800) // একবার ছোট বিরতি দিয়ে একই মডেলে আবার
        continue
      }
      if (r.status === 503 || r.status === 500 || r.status === 504) cooldown.set(model, Date.now() + COOLDOWN_TEMP)
      break
    }
  }

  console.warn('[Gemini] সব মডেল ব্যর্থ:', errors)

  // সবচেয়ে গুরুত্বপূর্ণ এররটি বেছে ব্যাখ্যা দিই
  const main = fatal || errors.find(e => e.status !== 503 && e.status !== 'NETWORK') || errors[errors.length - 1]
  const info = main ? explainError(main.status, main.message) : explainError('UNKNOWN', '')
  const tried = [...new Set(errors.map(e => e.model))].join(', ')
  return fallback(
    `⚠️ কারণ: ${info.cause}। সমাধান: ${info.fix}। (চেষ্টা করা মডেল: ${tried || 'কোনোটি নয়'}) এখন ইন্ডিকেটর দিয়ে অনুমান।`,
    errors
  )
            }
