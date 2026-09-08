// ══════════════════════════════════════════════════════════
//   GEMINI GHOST-CANDLE PREDICTOR — 2 chained future candles
//   Asks Gemini to predict the NEXT TWO 1-minute candles' exact
//   O/H/L/C, using the full 11-indicator engine output as context.
//   Candle 2's OPEN is always forced to equal candle 1's CLOSE
//   in code (never taken from the model), so the two candles are
//   always perfectly chained with zero gap.
// ══════════════════════════════════════════════════════════

// gemini-2.0-flash-lite was shut down by Google on 2026-06-01.
// gemini-2.5-* is being shut down 2026-10-16. gemini-3.1-flash-lite is the
// current stable, cheapest-tier model with no shutdown date — the right
// pick for a live prediction loop that calls the API repeatedly.
const GEMINI_MODEL = 'gemini-3.1-flash-lite'
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

// Compact dump of the last N candles — keeps the prompt cheap.
const candleDump = (candles, last = 30) => {
  const slice = candles.length > last ? candles.slice(-last) : candles
  return slice
    .map(c => `${parseFloat(c.open).toFixed(5)},${parseFloat(c.high).toFixed(5)},${parseFloat(c.low).toFixed(5)},${parseFloat(c.close).toFixed(5)}`)
    .join(';')
}

// Every indicator's own BULL/BEAR/NEUTRAL vote — same breakdown the engine
// itself shows on the GRADE card, so Gemini sees exactly what the engine saw.
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
Never add greetings, disclaimers, markdown, or extra lines beyond the one required.
Never refuse to answer — always output definite predicted candles based on the data given.`

/**
 * Predicts the next TWO candles via Gemini, chained with zero gap.
 * @param {string} key - Gemini API key
 * @param {string} market - display name e.g. "GBP/USD"
 * @param {Array} candles - chronological OHLC candle history
 * @param {object} engineResult - the object returned by runSignalEngine
 * @returns {Promise<{candle1:object, candle2:object, confidence:number, reason:string, ok:boolean}>}
 */
export async function predictNextCandles(key, market, candles, engineResult) {
  const lastClose = parseFloat(candles[candles.length - 1].close)
  const decimals = (candles[candles.length - 1].close.toString().split('.')[1] || '').length || 5

  // Sane fallback if Gemini fails or there's no key: project two small moves
  // in the engine's own direction, sized off recent candle ranges — the
  // ghost candles are never left empty.
  const fallback = (reasonText) => {
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
    }
  }

  if (!key) return fallback('Gemini key নেই — শুধু ইন্ডিকেটর দিয়ে অনুমান')

  try {
    const prompt = `Pair: ${market}
Recent 1m candles (oldest→newest, o,h,l,c per candle, ; separated):
${candleDump(candles)}

Last known close (this is O1, the open of candle 1): ${lastClose.toFixed(decimals)}
All 11 indicator votes: ${voteDump(engineResult?.breakdown || {})}
Technical engine reading: strength=${engineResult?.strength ?? 50}/100, agreement=${engineResult?.confidence ?? 0}%

Respond with exactly one line: O1|H1|L1|C1|H2|L2|C2|CONFIDENCE|REASON`

    const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 140, candidateCount: 1 },
      }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error.message || 'Gemini API error')

    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
    const parts = text.split('|')
    if (parts.length >= 9) {
      const o1 = parseFloat(parts[0])
      const h1 = parseFloat(parts[1])
      const l1 = parseFloat(parts[2])
      const c1 = parseFloat(parts[3])
      const h2 = parseFloat(parts[4])
      const l2 = parseFloat(parts[5])
      const c2 = parseFloat(parts[6])
      const confidence = parseInt(parts[7].replace(/[^0-9]/g, ''), 10)
      const reason = parts.slice(8).join('|').trim()

      const o2 = c1 // forced chain — candle 2 always opens exactly where candle 1 closed

      const nums1Valid = [o1, h1, l1, c1].every(Number.isFinite)
      const nums2Valid = [h2, l2, c2].every(Number.isFinite)
      const range1Valid = nums1Valid && h1 >= Math.max(o1, c1) && l1 <= Math.min(o1, c1)
      const range2Valid = nums2Valid && h2 >= Math.max(o2, c2) && l2 <= Math.min(o2, c2)

      if (range1Valid && range2Valid) {
        const round = (n) => Number(n.toFixed(decimals))
        return {
          candle1: { open: round(o1), high: round(h1), low: round(l1), close: round(c1) },
          candle2: { open: round(o2), high: round(h2), low: round(l2), close: round(c2) },
          confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 50,
          reason: reason || '',
          ok: true,
        }
      }
    }
    return fallback('Gemini রেসপন্স বোঝা যায়নি, ইন্ডিকেটর দিয়ে অনুমান')
  } catch (e) {
    return fallback(`Gemini error: ${e.message}`)
  }
                            }
