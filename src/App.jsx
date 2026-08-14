import { useState, useEffect, useRef, useCallback } from 'react'
import { db } from './firebase'
import { doc, onSnapshot } from 'firebase/firestore'
import PaymentPage from './PaymentPage'
import RulesPage from './RulesPage'
import { forexMarkets, runSignalEngine, MIN_CANDLES } from './signalEngine'

// ── Telegram WebApp ───────────────────────────────────────────
const tg = window.Telegram?.WebApp
if (tg) { tg.ready(); tg.expand() }

const getTgUser = () => {
  if (tg?.initDataUnsafe?.user) return tg.initDataUnsafe.user
  return { id: 12345, first_name: 'Test', last_name: '', username: 'testuser' }
}

// ── Colors ─────────────────────────────────────────────────────
const C = {
  bg: '#0b0e11', card: '#141820', panel: '#1a1f2e',
  border: '#2b3139', text: '#e0e0e0', muted: '#555',
  green: '#0ecb81', red: '#f6465d', gold: '#f3ba2f', blue: '#60a5fa',
}

const socialBtnStyle = {
  flex: 1, padding: '9px 4px', borderRadius: 8,
  background: '#1a2744', color: '#60a5fa',
  fontWeight: 700, fontSize: 10.5, border: '1px solid #60a5fa33',
  cursor: 'pointer',
}

// ── Twelve Data config ───────────────────────────────────────
const TD_BASE = 'https://api.twelvedata.com'
const CANDLE_COUNT = 150        // history pulled per signal (well under 5000-point cap)
const DAILY_LIMIT_FALLBACK = 800 // shown until api_usage confirms the real plan limit
const TRADE_SECONDS = 60         // 1-minute candle prediction

// ── Free tier config ──────────────────────────────────────────
const FREE_DAILY_SIGNAL_LIMIT = 3

// ── Social links (footer) ───────────────────────────────────────
const CHANNEL_LINK = 'https://t.me/ratulhossain4241'
const GROUP_LINK   = 'https://t.me/ratulhossain424'
const CHAT_LINK    = 'https://t.me/ratulhossain56'

// ── localStorage helpers (Twelve Data usage) ──────────────────
const localDateStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const getStoredUsage = () => {
  try {
    const raw = JSON.parse(localStorage.getItem('td_usage'))
    if (raw && raw.date === localDateStr()) return raw
  } catch (_) {}
  const fresh = { date: localDateStr(), count: 0 }
  localStorage.setItem('td_usage', JSON.stringify(fresh))
  return fresh
}

const bumpStoredUsage = () => {
  const u = getStoredUsage()
  u.count += 1
  localStorage.setItem('td_usage', JSON.stringify(u))
  return u.count
}

// ── localStorage helpers (Free-tier daily signal count) ────────
// Defensive: any malformed/unexpected shape in localStorage is treated
// as "no usage yet today" rather than accidentally blocking the user.
const getFreeUsage = () => {
  try {
    const raw = JSON.parse(localStorage.getItem('free_signal_usage'))
    const validShape = raw && raw.date === localDateStr() && Number.isFinite(raw.count) && raw.count >= 0
    if (validShape) return raw
  } catch (_) {}
  const fresh = { date: localDateStr(), count: 0 }
  localStorage.setItem('free_signal_usage', JSON.stringify(fresh))
  return fresh
}

const bumpFreeUsage = () => {
  const u = getFreeUsage()
  u.count += 1
  localStorage.setItem('free_signal_usage', JSON.stringify(u))
  return u
}

// Dev/testing helper — exposed on window so you can reset your own free
// quota from the browser console while testing: window.__resetFreeSignals()
if (typeof window !== 'undefined') {
  window.__resetFreeSignals = () => {
    localStorage.removeItem('free_signal_usage')
    console.log('✅ ফ্রি সিগনাল কোটা রিসেট হয়েছে — পেজ রিলোড করুন')
  }
}

export default function App() {
  const tgUser = getTgUser()

  // ── Auth / Subscription ────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState('loading') // loading|new|pending|approved|rejected|expired
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [freeUsage, setFreeUsage] = useState(getFreeUsage())

  // ── Twelve Data API key state ───────────────────────────────
  const [apiKey, setApiKey] = useState(localStorage.getItem('td_api_key') || '')
  const [keyInput, setKeyInput] = useState('')
  const [keyValid, setKeyValid] = useState(null)      // null=unchecked, true/false
  const [keyChecking, setKeyChecking] = useState(false)
  const [keySavedDate, setKeySavedDate] = useState(localStorage.getItem('td_key_saved_date') || null)
  const [usage, setUsage] = useState(getStoredUsage())
  const [planLimit, setPlanLimit] = useState(DAILY_LIMIT_FALLBACK)

  // ── Trading ───────────────────────────────────────────────────
  const [selected, setSelected] = useState(forexMarkets[0])
  const [liveTime, setLiveTime] = useState('--:--:--')
  const [connStatus, setConnStatus] = useState(apiKey ? 'READY' : 'API KEY লাগবে')
  const [sigData, setSigData] = useState({ direction: null, strength: 50, breakdown: {}, confidence: 0 })
  const [lastPred, setLastPred] = useState(null)
  const [mLevel, setMLevel] = useState(1)
  const [scanning, setScanning] = useState(false)
  const [score, setScore] = useState(JSON.parse(localStorage.getItem('trade_score')) || { win: 0, loss: 0, profit: 0 })
  const [unlockTime, setUnlockTime] = useState(localStorage.getItem('unlock_time') || null)
  const [isLocked, setIsLocked] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const resultTimerRef = useRef(null)

  const dailyTarget = (() => {
    if (!localStorage.getItem('start_date')) localStorage.setItem('start_date', new Date().toISOString())
    const days = Math.floor((Date.now() - new Date(localStorage.getItem('start_date'))) / 86400000)
    return days < 3 ? 6 : days < 6 ? 12 : 20
  })()

  // ── Is this user premium right now? ─────────────────────────
  const isPremium = authStatus === 'approved'

  // ── Firestore auth listener ───────────────────────────────────
  useEffect(() => {
    const uid = String(tgUser.id)
    if (!uid || uid === '0') { setAuthStatus('new'); return }

    const unsub = onSnapshot(doc(db, 'users', uid), (snap) => {
      if (!snap.exists()) { setAuthStatus('new'); return }
      const d = snap.data()
      if (d.status === 'approved') {
        const exp = d.expiresAt?.toDate?.()
        if (exp && exp < new Date()) setAuthStatus('expired')
        else setAuthStatus('approved')
      } else if (d.status === 'rejected') {
        setAuthStatus('rejected')
      } else if (d.status === 'disconnected') {
        setAuthStatus('expired')
      } else if (d.status === 'pending') {
        setAuthStatus('pending')
      } else {
        setAuthStatus('new')
      }
    }, (err) => {
      console.error('Firestore error:', err)
      setAuthStatus('new')
    })
    return () => unsub()
  }, [tgUser.id])

  // ── Clock + lock timer ──────────────────────────────────────
  useEffect(() => {
    const tick = setInterval(() => {
      const now = new Date()
      setLiveTime(now.toLocaleTimeString('en-GB'))
      if (unlockTime) {
        if (now < new Date(unlockTime)) setIsLocked(true)
        else { setIsLocked(false); setUnlockTime(null); localStorage.removeItem('unlock_time') }
      }
      // keep free-usage display in sync across local-midnight rollover
      setFreeUsage(getFreeUsage())
    }, 1000)
    return () => clearInterval(tick)
  }, [unlockTime])

  // ── Cleanup pending result-check timer on unmount ───────────
  useEffect(() => () => { if (resultTimerRef.current) clearTimeout(resultTimerRef.current) }, [])

  // ── Twelve Data: fetch usage + validate key ─────────────────
  const checkKeyStatus = useCallback(async (key) => {
    if (!key) { setKeyValid(null); return }
    setKeyChecking(true)
    try {
      const res = await fetch(`${TD_BASE}/api_usage?apikey=${encodeURIComponent(key)}`)
      const data = await res.json()
      if (data.code && data.code >= 400) {
        setKeyValid(false)
      } else {
        setKeyValid(true)
        if (typeof data.current_usage === 'number') {
          setUsage(prev => ({ ...prev, count: data.current_usage }))
        }
        setPlanLimit(800);
      }
    } catch (_) {
      setKeyValid(false)
    } finally {
      setKeyChecking(false)
    }
  }, [])

  useEffect(() => {
    if (apiKey) checkKeyStatus(apiKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveKey = () => {
    const trimmed = keyInput.trim()
    if (!trimmed) return
    localStorage.setItem('td_api_key', trimmed)
    const savedAt = new Date().toISOString()
    localStorage.setItem('td_key_saved_date', savedAt)
    setApiKey(trimmed)
    setKeySavedDate(savedAt)
    setKeyInput('')
    setConnStatus('READY')
    checkKeyStatus(trimmed)
  }

  const handleDeleteKey = () => {
    if (!window.confirm('API key মুছে ফেলবেন?')) return
    localStorage.removeItem('td_api_key')
    localStorage.removeItem('td_key_saved_date')
    setApiKey('')
    setKeySavedDate(null)
    setKeyValid(null)
    setConnStatus('API KEY লাগবে')
  }

  const daysUsingKey = keySavedDate
    ? Math.max(0, Math.floor((Date.now() - new Date(keySavedDate)) / 86400000))
    : null

  // ── Twelve Data: fetch candles ──────────────────────────────
  const fetchCandles = useCallback(async (symbol) => {
    const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=${CANDLE_COUNT}&apikey=${apiKey}`
    const res = await fetch(url)
    const data = await res.json()

    if (data.status === 'error' || (data.code && data.code >= 400)) {
      throw new Error(data.message || 'Twelve Data API error')
    }
    if (!data.values || !Array.isArray(data.values)) {
      throw new Error('কোনো ডেটা পাওয়া যায়নি')
    }

    bumpStoredUsage()
    setUsage(getStoredUsage())

    // Twelve Data returns newest-first by default → reverse to chronological
    const chronological = data.values.slice().reverse().map(v => ({
      open: v.open, high: v.high, low: v.low, close: v.close, datetime: v.datetime,
    }))
    // Drop the last bar — on the free plan it may still be forming / delayed,
    // so we only trust fully-closed candles for signal math.
    return chronological.slice(0, -1)
  }, [apiKey])

  // ── Manual signal generation ────────────────────────────────
  const generateSignal = useCallback(async () => {
    if (!apiKey) { setConnStatus('API KEY লাগবে'); setShowSettings(true); return }
    if (isLocked) return
    if (usage.count >= planLimit) { setConnStatus('DAILY LIMIT শেষ ❌'); return }

    // ── Free-tier daily signal limit gate ─────────────────────
    if (!isPremium) {
      const fu = getFreeUsage()
      if (fu.count >= FREE_DAILY_SIGNAL_LIMIT) {
        console.log(`ফ্রি লিমিট গেট: আজকের (${fu.date}) ব্যবহৃত সিগনাল ${fu.count}/${FREE_DAILY_SIGNAL_LIMIT} — টেস্টের সময় রিসেট করতে window.__resetFreeSignals() রান করুন।`)
        setConnStatus('ফ্রি লিমিট শেষ ❌')
        setShowPaymentModal(true)
        return
      }
    }

    setScanning(true)
    setConnStatus('ডেটা আনা হচ্ছে...')

    try {
      const candles = await fetchCandles(selected.td)
      if (candles.length < MIN_CANDLES) {
        setConnStatus('পর্যাপ্ত ডেটা নেই ❌')
        setScanning(false)
        return
      }

      const result = runSignalEngine(candles)
      setSigData(result)
      setConnStatus('CONNECTED ✅')

      // Count this generation against the free daily quota (premium = unlimited)
      if (!isPremium) setFreeUsage(bumpFreeUsage())

      if (result.direction) {
        setLastPred(result.direction)
        try { new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg').play() } catch (_) {}

        // Schedule exactly ONE follow-up check after the trade duration —
        // this costs 1 extra API call, not a repeating poll.
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
        resultTimerRef.current = setTimeout(() => { checkResult(result.direction) }, (TRADE_SECONDS + 5) * 1000)
      }
    } catch (e) {
      console.error(e)
      setConnStatus(/invalid api key/i.test(e.message) ? 'API KEY ভুল ❌' : 'ERROR ❌')
    } finally {
      setScanning(false)
    }
  }, [apiKey, selected, isLocked, usage, planLimit, fetchCandles, isPremium]) // eslint-disable-line

  // ── Result check (single follow-up call, not polling) ──────
  const checkResult = useCallback(async (predDirection) => {
    if (!apiKey) return
    try {
      const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(selected.td)}&interval=1min&outputsize=3&apikey=${apiKey}`
      const res = await fetch(url)
      const data = await res.json()
      bumpStoredUsage()
      setUsage(getStoredUsage())

      if (data.status === 'error' || !data.values) return
      const chronological = data.values.slice().reverse()
      const closed = chronological[chronological.length - 2] // last fully-closed bar
      if (!closed) return

      const actual = parseFloat(closed.close) > parseFloat(closed.open) ? 'CALL' : 'PUT'
      const isWin = predDirection === actual

      setScore(prev => {
        const change = isWin ? parseFloat((mLevel * 0.85).toFixed(2)) : -mLevel
        const updated = {
          win: isWin ? prev.win + 1 : prev.win,
          loss: isWin ? prev.loss : prev.loss + 1,
          profit: parseFloat((prev.profit + change).toFixed(2)),
        }
        localStorage.setItem('trade_score', JSON.stringify(updated))
        if (updated.profit >= dailyTarget) {
          const lock = new Date(Date.now() + 12 * 3600 * 1000).toISOString()
          setUnlockTime(lock); localStorage.setItem('unlock_time', lock)
        }
        return updated
      })

      setMLevel(prev => isWin ? 1 : prev === 1 ? 2.5 : prev === 2.5 ? 5.5 : 1)
      setLastPred(null)
      // Keep breakdown visible — only clear direction/confidence, not the indicator readout
      setSigData(prev => ({ direction: null, strength: prev.strength, breakdown: prev.breakdown, confidence: prev.confidence }))
    } catch (e) {
      console.error('checkResult error:', e)
    }
  }, [apiKey, selected, mLevel, dailyTarget])

  // ── Loading screen ────────────────────────────────────────────
  if (authStatus === 'loading') {
    return (
      <div style={{ background: C.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 32 }}>💹</div>
        <div style={{ color: C.muted, fontSize: 13 }}>লোড হচ্ছে...</div>
      </div>
    )
  }

  // ── Trading UI (always shown once loaded — free users included) ─
  const dir = sigData.direction
  const str = sigData.strength
  const conf = sigData.confidence
  const isCall = dir === 'CALL'
  const isPut = dir === 'PUT'
  const sigColor = isCall ? C.green : isPut ? C.red : C.muted
  const sigLabel =
    scanning ? '⟳  স্ক্যান হচ্ছে...' :
    isCall ? '▲  CALL  (UP)' :
    isPut ? '▼  PUT  (DOWN)' :
    lastPred ? '⏳  রেজাল্ট আসছে...' :
    '—  সিগনাল জেনারেট করুন'

  const handleReset = () => {
    if (!window.confirm('স্কোর রিসেট করবেন?')) return
    const e = { win: 0, loss: 0, profit: 0 }
    setScore(e)
    localStorage.removeItem('trade_score')
    localStorage.removeItem('start_date')
  }

  const usagePct = Math.min(100, Math.round((usage.count / planLimit) * 100))
  const freeRemaining = Math.max(0, FREE_DAILY_SIGNAL_LIMIT - freeUsage.count)

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif", minHeight: '100vh', overflowX: 'hidden' }}>

      {/* ── HEADER — connStatus | badge/upgrade | 📜 Rules | time ──
          Rules icon lives HERE (not inside the isLocked block below) so
          it is always reachable — locked, free, premium, doesn't matter. */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 14px', background: C.card, borderBottom: `1px solid ${C.border}`,
        fontSize: 11, fontWeight: 700, gap: 6,
      }}>
        <span style={{ color: connStatus.includes('✅') || connStatus === 'READY' ? C.green : connStatus.includes('❌') ? C.red : C.gold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {connStatus}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {isPremium ? (
            <span style={{ color: C.gold, fontWeight: 900, fontSize: 13, letterSpacing: '0.02em' }}>
              💎★★★★★
            </span>
          ) : (
            <button onClick={() => setShowPaymentModal(true)} style={{
              background: `linear-gradient(90deg, ${C.gold}, #ffd76a)`, color: '#000',
              border: 'none', borderRadius: 6, padding: '4px 10px', fontWeight: 800, fontSize: 11, cursor: 'pointer',
            }}>⬆️ Upgrade</button>
          )}

          {/* Rules — always visible to every user, every state */}
          <button onClick={() => setShowRules(true)} aria-label="Rules" style={{
            background: C.panel, border: `1px solid ${C.border}`, color: C.gold,
            borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer', lineHeight: 1,
          }}>📜</button>
        </div>

        <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{liveTime}</span>
      </header>

      {/* ── SUB-HEADER: target + free/premium status ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 14px', background: '#0d1117', borderBottom: `1px solid ${C.border}`,
        fontSize: 10.5,
      }}>
        <span style={{ color: C.gold, fontWeight: 700 }}>🎯 লক্ষ্য: ৳{dailyTarget}</span>
        {isPremium ? (
          <span style={{ color: C.green, fontWeight: 700 }}>✅ প্রিমিয়াম সক্রিয় — আনলিমিটেড সিগনাল</span>
        ) : (
          <span style={{ color: freeRemaining === 0 ? C.red : C.muted, fontWeight: 700 }}>
            🆓 ফ্রি সিগনাল বাকি: {freeRemaining}/{FREE_DAILY_SIGNAL_LIMIT}
          </span>
        )}
      </div>

      {/* ── pending / rejected / expired notice banners (non-blocking) ── */}
      {authStatus === 'pending' && (
        <div style={{ background: '#1a1200', borderBottom: `1px solid ${C.gold}33`, color: C.gold, fontSize: 11, padding: '8px 14px', textAlign: 'center' }}>
          ⏳ আপনার পেমেন্ট রিভিউতে আছে — কনফার্ম হলে প্রিমিয়াম অ্যাক্টিভ হবে
        </div>
      )}
      {authStatus === 'rejected' && (
        <div style={{ background: '#2a0000', borderBottom: `1px solid ${C.red}33`, color: C.red, fontSize: 11, padding: '8px 14px', textAlign: 'center' }}>
          ❌ আপনার আগের পেমেন্ট রিজেক্ট হয়েছে — আবার চেষ্টা করতে Upgrade বাটনে চাপুন
        </div>
      )}
      {authStatus === 'expired' && (
        <div style={{ background: '#1a1200', borderBottom: `1px solid ${C.gold}33`, color: C.gold, fontSize: 11, padding: '8px 14px', textAlign: 'center' }}>
          ⚠️ আপনার প্রিমিয়াম মেয়াদ শেষ হয়েছে — ফ্রি টায়ারে ফিরিয়ে আনা হয়েছে
        </div>
      )}

      {/* ── CHART ── */}
      <div style={{ height: '34vh', background: '#0d1117' }}>
        <iframe
          key={selected.td}
          src={`https://s.tradingview.com/widgetembed/?symbol=${selected.tv}&theme=dark&hide_top_toolbar=1&save_image=0`}
          width="100%" height="100%" style={{ border: 'none', display: 'block' }}
          title="chart"
        />
      </div>

      {/* ── SCORE ROW ── */}
      <div style={{ display: 'flex', gap: 6, padding: '10px 12px 0' }}>
        {[
          { l: 'WIN', v: score.win, c: C.green },
          { l: 'LOSS', v: score.loss, c: C.red },
          { l: 'PROFIT', v: `$${score.profit}`, c: C.gold },
        ].map(x => (
          <div key={x.l} style={{
            flex: 1, padding: '9px 4px', borderRadius: 8, textAlign: 'center',
            background: C.panel, border: `1px solid ${x.c}22`,
            color: x.c, fontSize: 11, fontWeight: 800,
          }}>
            <div style={{ color: '#444', fontSize: 9, marginBottom: 3 }}>{x.l}</div>
            {x.v}
          </div>
        ))}
        <button onClick={handleReset} style={{
          padding: '0 10px', borderRadius: 8, background: C.panel,
          border: `1px solid ${C.border}`, color: C.muted, fontSize: 11, cursor: 'pointer',
        }}>↺</button>
      </div>

      {/* ── MAIN ── */}
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {isLocked ? (
          <div style={{
            background: 'rgba(243,186,47,0.08)', border: `2px solid ${C.gold}`,
            borderRadius: 14, padding: '28px 20px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
            <div style={{ color: C.gold, fontWeight: 800, fontSize: 18 }}>লক্ষ্য অর্জিত!</div>
            <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              আনলক: {new Date(unlockTime).toLocaleTimeString()}
            </div>
          </div>
        ) : (
          <>
            {/* ── SIGNAL CARD ── */}
            <div style={{
              borderRadius: 14, padding: '16px', background: C.card,
              border: `2px solid ${isCall ? C.green : isPut ? C.red : C.border}`,
              boxShadow: isCall ? `0 0 24px ${C.green}33` : isPut ? `0 0 24px ${C.red}33` : 'none',
              transition: 'all 0.4s',
            }}>
              <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 900, color: sigColor, marginBottom: 10, letterSpacing: '0.04em' }}>
                {sigLabel}
              </div>

              {dir && (
                <div style={{ textAlign: 'center', marginBottom: 10 }}>
                  <span style={{
                    background: conf >= 80 ? `${C.green}22` : `${C.gold}22`,
                    color: conf >= 80 ? C.green : C.gold,
                    border: `1px solid ${conf >= 80 ? C.green : C.gold}55`,
                    borderRadius: 20, padding: '3px 14px', fontSize: 11, fontWeight: 700,
                  }}>{conf}% কনফিডেন্স</span>
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.muted, marginBottom: 3 }}>
                  <span>PUT ↓</span>
                  <span style={{ color: C.gold, fontWeight: 700 }}>শক্তি {str}%</span>
                  <span>↑ CALL</span>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: '#0d1117', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(0, 50 - str)}%`, background: str <= 35 ? C.red : `${C.red}44`, borderRadius: '4px 0 0 4px', transition: 'width 0.5s' }} />
                  <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${Math.max(0, str - 50)}%`, background: str >= 65 ? C.green : `${C.green}44`, borderRadius: '0 4px 4px 0', transition: 'width 0.5s' }} />
                  <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: C.border, transform: 'translateX(-50%)' }} />
                </div>
              </div>

              {/* Breakdown — always visible once first signal is generated, top 4 first */}
              {Object.keys(sigData.breakdown).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 6px', marginBottom: 8 }}>
                  {Object.entries(sigData.breakdown).map(([k, v]) => (
                    <div key={k} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 9.5, padding: '5px 7px', borderRadius: 5, background: '#0d1117',
                      overflow: 'hidden', gap: 4,
                    }}>
                      <span style={{ color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</span>
                      <span style={{
                        color: v.includes('BULL') ? C.green : v.includes('BEAR') ? C.red : C.muted,
                        fontWeight: 700, whiteSpace: 'nowrap', fontSize: 9,
                      }}>{v}</span>
                    </div>
                  ))}
                </div>
              )}

              {mLevel > 1 && (
                <div style={{ textAlign: 'center', fontSize: 11, color: C.gold, fontWeight: 700 }}>
                  💰 মার্টিঙ্গেল: {mLevel}x
                </div>
              )}
            </div>

            {/* ── MARKET SELECT ── */}
            <select value={selected.td} onChange={e => setSelected(forexMarkets.find(m => m.td === e.target.value))}
              style={{ padding: '11px 12px', borderRadius: 8, background: C.panel, color: C.text, border: `1px solid ${C.border}`, fontSize: 12 }}>
              {['Major', 'Cross', 'Exotic'].map(cat => (
                <optgroup key={cat} label={cat}>
                  {forexMarkets.filter(m => m.cat === cat).map(m => (
                    <option key={m.td} value={m.td}>{m.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* ── ACTION BUTTONS ── */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={generateSignal}
                disabled={scanning || !apiKey}
                style={{
                  flex: 2, padding: '14px', borderRadius: 8, fontWeight: 800, fontSize: 13,
                  border: 'none', cursor: scanning || !apiKey ? 'not-allowed' : 'pointer',
                  background: scanning ? C.panel : C.green,
                  color: scanning ? C.muted : '#000',
                  opacity: !apiKey ? 0.5 : 1,
                  transition: '0.2s',
                }}>
                {scanning ? '⟳ স্ক্যান হচ্ছে...' : '🔍 সিগনাল জেনারেট'}
              </button>
              <button onClick={() => setShowSettings(s => !s)} style={{
                flex: 1, padding: '14px', borderRadius: 8, background: C.panel,
                color: C.blue, fontWeight: 700, fontSize: 12,
                border: `1px solid ${C.border}`, cursor: 'pointer',
              }}>⚙️</button>
            </div>

            {/* ── SETTINGS PANEL ── */}
            {showSettings && (
              <div style={{ background: C.card, borderRadius: 12, padding: 14, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                  🔑 Twelve Data API Key
                </div>

                {apiKey ? (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ color: C.green, fontSize: 12, fontWeight: 700 }}>
                        ✅ Key saved (...{apiKey.slice(-6)})
                      </span>
                      <button onClick={handleDeleteKey} style={{
                        padding: '4px 10px', borderRadius: 6, background: 'transparent',
                        border: `1px solid ${C.red}`, color: C.red, fontSize: 10, cursor: 'pointer',
                      }}>🗑️ Delete</button>
                    </div>

                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
                      স্ট্যাটাস: {keyChecking ? '⏳ চেক হচ্ছে...' : keyValid === true ? '🟢 Valid' : keyValid === false ? '🔴 Invalid / Expired' : '⚪ যাচাই করা হয়নি'}
                    </div>
                    {daysUsingKey !== null && (
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                        📅 এই key দিয়ে ব্যবহার করছেন: <b style={{ color: C.text }}>{daysUsingKey} দিন</b>
                      </div>
                    )}
                    <button onClick={() => checkKeyStatus(apiKey)} style={{
                      padding: '6px 12px', borderRadius: 6, background: C.panel,
                      border: `1px solid ${C.border}`, color: C.blue, fontSize: 10, cursor: 'pointer',
                    }}>🔄 আবার যাচাই করুন</button>
                  </div>
                ) : (
                  <div style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>কোনো key সেভ করা নেই</div>
                )}

                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <input type="text" placeholder="Enter Twelve Data API key..." value={keyInput}
                    onChange={e => setKeyInput(e.target.value)}
                    style={{ flex: 1, padding: '10px 12px', borderRadius: 8, background: '#0d1117', color: C.text, border: `1px solid ${C.border}`, fontSize: 12, outline: 'none' }} />
                  <button onClick={handleSaveKey} style={{
                    padding: '0 16px', borderRadius: 8, background: C.gold,
                    color: '#000', fontWeight: 800, fontSize: 12, border: 'none', cursor: 'pointer',
                  }}>💾 Save</button>
                </div>

                <div style={{ fontSize: 10, color: '#555', lineHeight: 1.6, marginBottom: 12 }}>
                  ফ্রি key পাবেন <a href="https://twelvedata.com" target="_blank" rel="noreferrer" style={{ color: C.blue }}>twelvedata.com</a>-এ।
                  ফ্রি প্ল্যান: দৈনিক ৮০০ কল, মিনিটে ৮টা। আপনার key শুধু এই ডিভাইসে সেভ থাকে — আমাদের সার্ভারে পাঠানো হয় না।
                </div>

                <div style={{ background: '#0d1117', borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>📊 Daily API Usage</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: usagePct >= 90 ? C.red : C.green, marginBottom: 6 }}>
                    {usage.count} / {planLimit}
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: C.panel, overflow: 'hidden' }}>
                    <div style={{ width: `${usagePct}%`, height: '100%', background: usagePct >= 90 ? C.red : C.gold, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>Resets at local midnight</div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── SOCIAL FOOTER — small, bottom of app ── */}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={() => window.open(CHANNEL_LINK, '_blank')} style={socialBtnStyle}>📢 চ্যানেল</button>
          <button onClick={() => window.open(GROUP_LINK, '_blank')} style={socialBtnStyle}>👥 গ্রুপ</button>
          <button onClick={() => window.open(CHAT_LINK, '_blank')} style={socialBtnStyle}>💬 চ্যাট</button>
        </div>
      </div>

      {/* ── UPGRADE / PAYMENT MODAL ── */}
      {showPaymentModal && (
        <PaymentPage
          tgUser={tgUser}
          status={authStatus}
          onClose={() => setShowPaymentModal(false)}
        />
      )}

      {/* ── RULES MODAL — reachable by every user, every state (locked included) ── */}
      {showRules && <RulesPage onClose={() => setShowRules(false)} />}

    </div>
  )
    }
