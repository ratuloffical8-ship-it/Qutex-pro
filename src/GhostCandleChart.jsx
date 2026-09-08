import { useEffect, useRef } from 'react'
import { createChart } from 'lightweight-charts'

// NOTE: uses chart.addCandlestickSeries(options) — the API present in the
// lightweight-charts version this project actually resolved to. (v5's
// addSeries(CandlestickSeries, options) needs a named "CandlestickSeries"
// export that this installed version doesn't provide.)

const C = {
  bg: 'transparent',
  text: '#888',
  grid: '#1a1f2e',
  green: '#0ecb81',
  red: '#f6465d',
  // Ghost candle colors are now direction-based, not a flat gold:
  // UP/bullish prediction -> white, DOWN/bearish prediction -> gold.
  ghostUpFill: 'rgba(255, 255, 255, 0.45)',
  ghostUpBorder: '#ffffff',
  ghostDownFill: 'rgba(243, 186, 47, 0.45)',
  ghostDownBorder: '#f3ba2f',
}

// TwelveData "YYYY-MM-DD HH:mm:ss" -> unix seconds. Relative spacing between
// candles is correct regardless of which timezone TwelveData used, since
// every candle (and the ghost candles after it) is parsed the same way.
const toUnixSeconds = (datetime) => {
  const iso = datetime.replace(' ', 'T') + 'Z'
  return Math.floor(new Date(iso).getTime() / 1000)
}

/**
 * @param {Array} candles - chronological real candles: [{open,high,low,close,datetime}, ...]
 * @param {Array<{open:number,high:number,low:number,close:number}>|null} predicted
 *        - one or two Gemini ghost candles, chained in order (predicted[0] = next minute, predicted[1] = minute after)
 * @param {number} height - chart height in px
 */
export default function GhostCandleChart({ candles, predicted, height = 220 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    if (!candles || candles.length === 0) return

    const container = containerRef.current
    const chart = createChart(container, {
      height,
      layout: {
        background: { type: 'solid', color: C.bg },
        textColor: C.text,
        fontSize: 10,
      },
      grid: {
        vertLines: { color: C.grid },
        horzLines: { color: C.grid },
      },
      rightPriceScale: { borderColor: C.grid },
      timeScale: { borderColor: C.grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const realSeries = chart.addCandlestickSeries({
      upColor: C.green,
      downColor: C.red,
      borderUpColor: C.green,
      borderDownColor: C.red,
      wickUpColor: C.green,
      wickDownColor: C.red,
    })

    const realData = candles
      .map(c => ({
        time: toUnixSeconds(c.datetime),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }))
      // lightweight-charts requires strictly ascending, de-duplicated time values
      .filter((c, i, arr) => i === 0 || c.time > arr[i - 1].time)

    realSeries.setData(realData)

    // Ghost (predicted) candles — each gets its OWN series so each can be
    // colored independently by its own direction (white=UP, gold=DOWN),
    // rather than sharing one flat color regardless of direction.
    if (predicted && predicted.length > 0 && realData.length > 0) {
      const lastRealTime = realData[realData.length - 1].time
      predicted.forEach((p, i) => {
        if (!p) return
        const isUp = p.close >= p.open
        const ghostSeries = chart.addCandlestickSeries({
          upColor: C.ghostUpFill,
          downColor: C.ghostDownFill,
          borderUpColor: C.ghostUpBorder,
          borderDownColor: C.ghostDownBorder,
          wickUpColor: C.ghostUpBorder,
          wickDownColor: C.ghostDownBorder,
          priceLineVisible: i === predicted.length - 1, // only the last ghost candle shows the price line
          lastValueVisible: i === predicted.length - 1,
        })
        const ghostTime = lastRealTime + 60 * (i + 1) // +1 min, +2 min, ...
        ghostSeries.setData([{ time: ghostTime, open: p.open, high: p.high, low: p.low, close: p.close }])
        void isUp // color already encodes direction via up/down series options
      })
    }

    chart.timeScale().fitContent()

    const handleResize = () => {
      if (container) chart.applyOptions({ width: container.clientWidth })
    }
    window.addEventListener('resize', handleResize)
    handleResize()

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
    }
  }, [candles, predicted, height])

  if (!candles || candles.length === 0) {
    return (
      <div style={{
        height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#555', fontSize: 11, background: '#0d1117', borderRadius: 10,
      }}>
        চার্ট ডেটা নেই — সিগনাল জেনারেট করুন
      </div>
    )
  }

  return (
    <div>
      <div ref={containerRef} style={{ width: '100%', borderRadius: 10, overflow: 'hidden' }} />
      {predicted && predicted.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, fontSize: 9.5, color: '#666', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: C.ghostUpFill, border: `1px solid ${C.ghostUpBorder}` }} />
            সাদা = AI প্রেডিক্টেড UP ক্যান্ডেল
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: C.ghostDownFill, border: `1px solid ${C.ghostDownBorder}` }} />
            গোল্ডেন = AI প্রেডিক্টেড DOWN ক্যান্ডেল
          </span>
        </div>
      )}
    </div>
  )
      }
