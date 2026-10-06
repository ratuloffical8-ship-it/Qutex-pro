// ══════════════════════════════════════════════════════════
//   GEMINI GHOST-CANDLE PREDICTOR — v3 (দ্রুত ও সময়-সীমাবদ্ধ)
//
//   v3 ফিক্স (১-২ মিনিট দেরির কারণ ঠিক করা হয়েছে):
//   1. মোট সময়সীমা (TOTAL_BUDGET_MS = ৭ সেকেন্ড): এর বেশি লাগলে সরাসরি বন্ধ
//   2. প্রতিটি রিকোয়েস্ট AbortController দিয়ে সত্যিকার অর্থে বাতিল হয়
//      (আগে App টাইমআউট দিলেও ব্যাকগ্রাউন্ডে চলতে থাকত ও কোটা খেত)
//   3. প্রতি মডেলে সর্বোচ্চ ৪.৫ সেকেন্ড; একই মডেলে আর রিট্রাই নয়
//   4. সর্বোচ্চ ৩টি মডেল চেষ্টা; ধীর/ব্যর্থ মডেল কিছুক্ষণ স্কিপ
//   5. maxOutputTokens ২০৪৮ (thinking টোকেনে উত্তর কেটে যেত)
//   6. Candle 2-এর OPEN সবসময় Candle 1-এর CLOSE (কোডে জোর করে)
// ══════════════════════════════════════════════════════════

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ListModels কাজ না করলে এই তালিকা (ভালো → সাধারণ)
const PREFERRED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
]

const TOTAL_BUDGET_MS = 7000   // পুরো প্রেডিকশনের সর্বোচ্চ সময়
const PER_MODEL_MS = 4500      // এক মডেলকে সর্বোচ্চ সময়
const LIST_TIMEOUT_MS = 2500   // মডেল তালিকা আনার সর্বোচ্চ সময়
const MIN_REMAINING_MS = 1500  // এর কম বাকি থাকলে নতুন মডেল ধরবো না
const MAX_MODELS_TRIED = 3

const MODEL_LIST_TTL = 30 * 60 * 1000
const COOLDOWN_TEMP = 60 * 1000        // 503/429/500
const COOLDOWN_SLOW = 2 * 60 * 1000    // টাইমআউট (ধীর মডেল)
const COOLDOWN_GONE = 30 * 60 * 1000   // 404

let modelCache = { at: 0, list: null }
const cooldown = new Map()
let lastWorking = null

// ─────────────────────────────────────────────
// সাহায্যকারী: টাইমআউটসহ fetch (সত্যিকারের বাতিল)
// ─────────────────────────────────────────────
async function timedFetchJson(url, options, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    const data = await res.json().catch(() => ({}))
    return { res, data }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────
// ১) মডেল তালিকা
// ─────────────────────────────────────────────
async function getModelChain(key) {
  const now = Date.now()
  if (!modelCache.list || now - modelCache.at > MODEL_LIST_TTL) {
    try {
      const { res, data } = await timedFetchJson(
        `${API_BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`,
        {},
        LIST_TIMEOUT_MS
      )
      if (res.ok && Array.isArray(data.models)) {
        modelCache = {
          at: now,
          list: data.models
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, '')),
        }
      } else {
        modelCache = { at: now - MODEL_LIST_TTL + 60 * 1000, list: null } // ১ মিনিট পরে আবার
      }
    } catch {
      modelCache = { at: now - MODEL_LIST_TTL + 60 * 1000, list: null }
    }
  }

  const available = modelCache.list
  if (!available) return PREFERRED_MODELS.slice()

  const flash = available
    .map(name => {
      const m = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/)
      return m ? { name, ver: parseFloat(m[1]), lite: !!m[2] } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.ver - a.ver || Number(a.lite) - Number(b.lite))
    .map(x => x.name)

  const extras = PREFERRED_MODELS.filter(n => available.includes(n) && !flash.includes(n))
  const chain = [...flash, ...extras]
  return chain.length ? chain : PREFERRED_MODELS.slice()
}

// ─────────────────────────────────────────────
// ২) এরর ব্যাখ্যা (বাংলা)
// ─────────────────────────────────────────────
function explainError(status, message = '') {
  const m = String(message).toLowerCase()

  if (status === 'TIMEOUT') return {
    fatal: false,
    cause: 'Gemini সময়মতো উত্তর দেয়নি (ধীর সার্ভার)',
    fix: 'কিছু করতে হবে না, ইঞ্জিনের সিগনালই ব্যবহার হচ্ছে; বারবার হলে বিলিং চালু (Paid tier) করুন',
  }
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
    fix: 'সাপোর্টেড লোকেশনের সার্ভার বা VPN ব্যবহার করুন',
  }
  if (status === 400) return {
    fatal: false,
    cause: 'রিকোয়েস্টের ফরম্যাটে সমস্যা (400)',
    fix: 'কনসোলে এরর মেসেজ দেখুন: ' + message.slice(0, 80),
  }
  if (status === 401 || status === 403) return {
    fatal: true,
    cause: 'API Key-র অনুমতি নেই (401/403): key সীমাবদ্ধ বা Generative Language API চালু নেই',
    fix: 'AI Studio-তে key-র restriction চেক করুন; দরকারে নতুন key বানান',
  }
  if (status === 404) return {
    fatal: false,
    cause: 'এই মডেলটি Google বন্ধ করেছে বা নাম বদলেছে (404)',
    fix: 'কোড অটো পরের মডেলে গেছে; সব মডেলে এলে PREFERRED_MODELS আপডেট করুন',
  }
  if (status === 429) return {
    fatal: false,
    cause: 'কোটা/রেট-লিমিট শেষ (429)',
    fix: 'কল কমান, অথবা AI Studio-তে বিলিং চালু করুন',
  }
  if (status === 500 || status === 503 || status === 504) return {
    fatal: false,
    cause: 'Google-এর সার্ভারে এখন লোড বেশি (' + status + '), আপনার কোডের ভুল নয়',
    fix: 'অপেক্ষা করুন; বারবার হলে Paid tier নিন',
  }
  if (status === 'BLOCKED') return {
    fatal: false,
    cause: 'Gemini নিরাপত্তা ফিল্টারে উত্তর আটকে দিয়েছে',
    fix: 'প্রম্পটে নিরপেক্ষ ভাষা ব্যবহার করুন',
  }
  if (status === 'EMPTY' || status === 'BAD_FORMAT') return {
    fatal: false,
    cause: 'Gemini উত্তর দিয়েছে কিন্তু ফরম্যাট ভুল বা অসম্পূর্ণ',
    fix: 'সাধারণত অস্থায়ী',
  }
  return {
    fatal: false,
    cause: 'অজানা এরর: ' + String(message).slice(0, 80),
    fix: 'ব্রাউজার কনসোলে বিস্তারিত দেখুন',
  }
}

// ─────────────────────────────────────────────
// ৩) একটি মডেলে কল (সময়সীমাসহ)
// ─────────────────────────────────────────────
async function callModel(model, key, baseBody, ms) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`
  const startedAt = Date.now()

  const attempt = async (withThinking) => {
    const remaining = ms - (Date.now() - startedAt)
    if (remaining < 500) return { ok: false, status: 'TIMEOUT', message: 'time budget exhausted' }

    const body = JSON.parse(JSON.stringify(baseBody))
    if (withThinking) {
      // thinking টোকেন আউটপুট ও সময় খায় — যতটা সম্ভব কমানো
      if (/^gemini-3/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' }
      else if (/^gemini-2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 }
    }

    try {
      const { res, data } = await timedFetchJson(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        remaining
      )
      if (res.ok && !data.error) return { ok: true, data }
      return { ok: false, status: res.status, message: data?.error?.message || `HTTP ${res.status}` }
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, status: 'TIMEOUT', message: 'aborted after ' + ms + 'ms' }
      return { ok: false, status: 'NETWORK', message: e?.message || 'network' }
    }
  }

  let r = await attempt(true)
  // মডেল thinkingConfig না বুঝলে ছাড়া আবার (বাকি সময়ের মধ্যে)
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
  const o2 = c1 // candle 2 ঠিক candle 1-এর close থেকে শুরু

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
// ৫) প্রম্পট
// ─────────────────────────────────────────────
const candleDump = (candles, last = 30) => {
  const slice = candles.length > last ? candles.slice(-last) : candles
  return slice
    .map(c => `${parseFloat(c.open).toFixed(5)},${parseFloat(c.high).toFixed(5)},${parseFloat(c.low).toFixed(5)},${parseFloat(c.close).toFixed(5)}`)
    .join(';')
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
Indicator votes marked "দুর্বল" are weak and should carry little weight; BULL/BEAR votes are strong.
REASON must be written in Bengali (বাংলা), up to about 20 words: if the indicators conflict or the setup looks risky/uncertain, explain in Bengali WHY it is risky or confusing; if the indicators agree well, explain in Bengali WHY you are confident. No punctuation beyond commas in REASON.
Never add greetings, disclaimers, markdown, or extra lines beyond the one required.
Never refuse to answer — always output definite predicted candles based on the data given.`

// ─────────────────────────────────────────────
// ৬) মূল ফাংশন
// ─────────────────────────────────────────────
export async function predictNextCandles(key, market, candles, engineResult, budgetMs = TOTAL_BUDGET_MS) {
  const deadline = Date.now() + budgetMs
  const lastClose = parseFloat(candles[candles.length - 1].close)
  const decimals = (candles[candles.length - 1].close.toString().split('.')[1] || '').length || 5

  // ব্যর্থ হলে ইন্ডিকেটর-ভিত্তিক অনুমান (ok:false — App এটা চার্টে দেখায় না)
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
    }
  }

  if (!key) {
    return fallback('⚠️ কারণ: Gemini API Key দেওয়া নেই। সমাধান: aistudio.google.com/apikey থেকে key নিয়ে বসান। এখন শুধু ইন্ডিকেটর দিয়ে অনুমান।')
  }

  const prompt = `Pair: ${market}
Recent 1m candles (oldest→newest, o,h,l,c per candle, ; separated):
${candleDump(candles)}

Last known close (this is O1, the open of candle 1): ${lastClose.toFixed(decimals)}
All 11 indicator votes: ${voteDump(engineResult?.breakdown || {})}
Technical engine reading: strength=${engineResult?.strength ?? 50}/100, agreement=${engineResult?.confidence ?? 0}%

Respond with exactly one line: O1|H1|L1|C1|H2|L2|C2|CONFIDENCE|REASON`

  const baseBody = {
    systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.15, maxOutputTokens: 2048, candidateCount: 1 },
  }

  let chain
  try {
    chain = await getModelChain(key)
  } catch {
    chain = PREFERRED_MODELS.slice()
  }

  // সবচেয়ে ভরসাযোগ্য (শেষবার কাজ করা) মডেল আগে
  if (lastWorking && chain.includes(lastWorking)) {
    chain = [lastWorking, ...chain.filter(m => m !== lastWorking)]
  }

  const now = Date.now()
  let ready = chain.filter(m => (cooldown.get(m) || 0) <= now)
  if (ready.length === 0) ready = chain.slice(0, 2) // সবাই বিশ্রামে → শুধু ২টি চেষ্টা
  ready = ready.slice(0, MAX_MODELS_TRIED)

  const errors = []
  let fatal = null

  for (const model of ready) {
    const remaining = deadline - Date.now()
    if (remaining < MIN_REMAINING_MS) {
      errors.push({ model, status: 'TIMEOUT', message: 'total budget exhausted' })
      break
    }

    const r = await callModel(model, key, baseBody, Math.min(remaining, PER_MODEL_MS))

    if (r.ok) {
      const p = parsePrediction(r.data, decimals)
      if (p.result) {
        lastWorking = model
        return { ...p.result, model, errors }
      }
      errors.push({ model, status: p.error, message: p.message })
      continue // ফরম্যাট ভুল → পরের মডেল
    }

    errors.push({ model, status: r.status, message: r.message })
    const info = explainError(r.status, r.message)

    if (info.fatal) { fatal = { model, ...r }; break } // key ভুল হলে কোনো মডেলেই হবে না

    if (r.status === 404) cooldown.set(model, Date.now() + COOLDOWN_GONE)
    else if (r.status === 'TIMEOUT') cooldown.set(model, Date.now() + COOLDOWN_SLOW)
    else if (r.status === 429 || r.status === 500 || r.status === 503 || r.status === 504) {
      cooldown.set(model, Date.now() + COOLDOWN_TEMP)
    }
    // কোনো একই-মডেল রিট্রাই নেই: সোজা পরের মডেলে
  }

  console.warn('[Gemini] সব মডেল ব্যর্থ বা সময় শেষ:', errors)

  const main =
    fatal ||
    errors.find(e => e.status !== 503 && e.status !== 'NETWORK' && e.status !== 'TIMEOUT') ||
    errors[errors.length - 1]
  const info = main ? explainError(main.status, main.message) : explainError('UNKNOWN', '')
  const tried = [...new Set(errors.map(e => e.model))].join(', ')
  return fallback(
    `⚠️ কারণ: ${info.cause}। সমাধান: ${info.fix}। (চেষ্টা করা মডেল: ${tried || 'কোনোটি নয়'}) এখন ইন্ডিকেটর দিয়ে অনুমান।`,
    errors
  )
        }
