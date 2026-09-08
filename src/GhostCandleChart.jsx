import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, ColorType } from 'lightweight-charts'

// NOTE: this targets lightweight-charts v5's unified addSeries(SeriesType, options)
// API. If `npm ls lightweight-charts` shows a v4.x install, the old
// chart.addCandlestickSeries(options) call is needed instead — check
// node_modules/lightweight-charts/package.json if this throws at runtime.

const C = {
  bg: 'transparent',
  text: '#888',
  grid: '#1a1f2e',
  green: '#0ecb81',
  red: '#f6465d',
  ghostUp: 'rgba(243, 186, 47, 0.35)',   // translucent gold — visually distinct from real candles
  ghostDown: 'rgba(243, 186, 47, 0.35)',
  ghostBorder: '#f3ba2f',
}

// TwelveData "YYYY-MM-DD HH:mm:ss" -> unix seconds. Relative spacing between
// candles is correct regardless of which timezone TwelveData used, since
// every candle (and the +60s ghost candle) is parsed the same way.
const toUnixSeconds = (datetime) => {
  const iso = datetime.replace(' ', 'T') + 'Z'
  return Math.floor(new Date(iso).getTime() / 1000)
}

/**
 * @param {Array} candles - chronological real candles: [{open,high,low,close,datetime}, ...]
 * @param {{open:number,high:number,low:number,close:number}|null} predicted - the Gemini ghost candle
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
        background: { type: ColorType.Solid, color: C.bg },
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

    const realSeries = chart.addSeries(CandlestickSeries, {
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

    // Ghost (predicted) candle — separate series, same price scale, styled
    // translucent gold so it reads as "prediction" rather than real data.
    if (predicted && realData.length > 0) {
      const ghostSeries = chart.addSeries(CandlestickSeries, {
        upColor: C.ghostUp,
        downColor: C.ghostDown,
        borderUpColor: C.ghostBorder,
        borderDownColor: C.ghostBorder,
        wickUpColor: C.ghostBorder,
        wickDownColor: C.ghostBorder,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      const ghostTime = realData[realData.length - 1].time + 60 // next 1-minute candle
      ghostSeries.setData([{
        time: ghostTime,
        open: predicted.open,
        high: predicted.high,
        low: predicted.low,
        close: predicted.close,
      }])
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
      {predicted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 9.5, color: '#666' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: C.ghostUp, border: `1px solid ${C.ghostBorder}` }} />
          <span>স্বচ্ছ সোনালী = AI প্রেডিক্টেড পরবর্তী ক্যান্ডেল (আসল না)</span>
        </div>
      )}
    </div>
  )
    }
