import { useState } from 'react'
import { db } from './firebase'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'

// ── আপনার তথ্য ────────────────────────────────────────────────
const BKASH_NUMBER    = '01725218874'
const NAGAD_NUMBER    = '01725218874'
const CHANNEL_LINK    = 'https://t.me/ratulhossain4241'
const GROUP_LINK      = 'https://t.me/ratulhossain424'
const CHAT_LINK       = 'https://t.me/ratulhossain56'
const FULL_PRICE      = 1500
const PROMO_PRICE     = 1000
const PROMO_CODE      = 'RTX4241'
const BACKEND_URL     = 'https://qx-mashaallha.onrender.com'  // Deploy পরে এটি ঠিক থাকবে

// ── Colors ─────────────────────────────────────────────────────
const C = {
  bg: '#0b0e11', card: '#141820', panel: '#1a1f2e',
  border: '#2b3139', text: '#e0e0e0', muted: '#666',
  green: '#0ecb81', red: '#f6465d', gold: '#f3ba2f',
  blue: '#60a5fa', pink: '#e2136e', orange: '#f7941d',
}

export default function PaymentPage({ tgUser, status, onClose }) {
  const [method, setMethod]             = useState('')
  const [senderNumber, setSenderNumber] = useState('')
  const [txId, setTxId]                 = useState('')
  const [promoInput, setPromoInput]     = useState('')
  const [promoApplied, setPromoApplied] = useState(false)
  const [loading, setLoading]           = useState(false)
  const [done, setDone]                 = useState(false)
  const [error, setError]               = useState('')
  const [copied, setCopied]             = useState('')

  // Amount is NEVER user-editable — it's derived purely from promo state
  const amount = promoApplied ? PROMO_PRICE : FULL_PRICE

  const copyNum = (num, label) => {
    navigator.clipboard.writeText(num).catch(() => {})
    setCopied(label)
    setTimeout(() => setCopied(''), 2000)
  }

  const applyPromo = () => {
    if (!promoInput.trim()) return
    if (promoInput.trim().toUpperCase() === PROMO_CODE) {
      setPromoApplied(true)
      setError('')
    } else {
      setPromoApplied(false)
      setError('❌ ভুল প্রমো কোড')
    }
  }

  const removePromo = () => {
    setPromoApplied(false)
    setPromoInput('')
    setError('')
  }

  const handleSubmit = async () => {
    if (!method)               return setError('পেমেন্ট মেথড সিলেক্ট করুন')
    if (!senderNumber.trim())  return setError('যে নম্বর থেকে টাকা পাঠিয়েছেন সেটি লিখুন')
    if (!txId.trim())          return setError('ট্রানজেকশন আইডি লিখুন')

    setLoading(true)
    setError('')

    try {
      const name = tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : '')
      const data = {
        userId:        String(tgUser.id),
        name,
        username:      tgUser.username || '',
        method,
        senderNumber:  senderNumber.trim(),
        amount,
        txId:          txId.trim(),
        promoCode:     promoApplied ? PROMO_CODE : '',
        status:        'pending',
        createdAt:     serverTimestamp(),
      }

      // Firestore-এ save করো
      await setDoc(doc(db, 'payments', txId.trim()), data)

      // Backend-এ Telegram notification পাঠাও
      await fetch(`${BACKEND_URL}/api/notify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      setDone(true)
    } catch (e) {
      console.error(e)
      setError('সাবমিট হয়নি। ইন্টারনেট চেক করুন।')
    } finally {
      setLoading(false)
    }
  }

  const CloseBtn = onClose ? (
    <button onClick={onClose} style={{
      position: 'absolute', top: 12, right: 12, zIndex: 5,
      background: C.panel, border: `1px solid ${C.border}`, color: C.muted,
      borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
    }}>✕ বন্ধ</button>
  ) : null

  // ── Pending screen ────────────────────────────────────────────
  if (done || status === 'pending') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 998, overflowY: 'auto' }}>
        {CloseBtn}
        <div style={s.notifBar}>
          📢 প্রিমিয়াম আনলিমিটেড সিগনাল — মাত্র <strong>৳{FULL_PRICE}</strong>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ ...s.card, textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 50, marginBottom: 12 }}>⏳</div>
            <div style={{ color: C.gold, fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
              পেমেন্ট রিভিউতে আছে
            </div>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.7 }}>
              আপনার পেমেন্ট যাচাই হলে প্রিমিয়াম অ্যাক্টিভ হবে।{'\n'}
              সাধারণত ১–৩ ঘণ্টার মধ্যে কনফার্ম হয়। এই সময় আপনি ফ্রি টায়ারেই অ্যাপ ব্যবহার চালিয়ে যেতে পারবেন।
            </div>
            <SocialFooter />
          </div>
        </div>
      </div>
    )
  }

  // ── Rejected screen (shows the form again) ─────────────────────
  if (status === 'rejected') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 998, overflowY: 'auto' }}>
        {CloseBtn}
        <div style={s.notifBar}>
          📢 প্রিমিয়াম আনলিমিটেড সিগনাল — মাত্র <strong>৳{FULL_PRICE}</strong>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ ...s.card, textAlign: 'center', padding: '30px 16px', marginBottom: 12, border: `1px solid ${C.red}44` }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>❌</div>
            <div style={{ color: C.red, fontWeight: 800, fontSize: 16, marginBottom: 6 }}>পেমেন্ট রিজেক্ট হয়েছে</div>
            <div style={{ color: C.muted, fontSize: 12 }}>সঠিক তথ্য দিয়ে আবার পেমেন্ট করুন।</div>
          </div>

          <PromoBox promoInput={promoInput} setPromoInput={setPromoInput} promoApplied={promoApplied}
            applyPromo={applyPromo} removePromo={removePromo} amount={amount} />

          <PaymentNumbers copied={copied} copyNum={copyNum} amount={amount} promoApplied={promoApplied} />

          <PaymentForm
            method={method} setMethod={setMethod}
            senderNumber={senderNumber} setSenderNumber={setSenderNumber}
            txId={txId} setTxId={setTxId} amount={amount}
            loading={loading} error={error} handleSubmit={handleSubmit}
          />
          <SocialFooter />
        </div>
      </div>
    )
  }

  // ── Main upgrade / payment page ────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 998, overflowY: 'auto', paddingBottom: 30 }}>
      {CloseBtn}
      <div style={s.notifBar}>
        📢 প্রিমিয়াম আনলিমিটেড সিগনাল — মাত্র <strong>৳{FULL_PRICE}</strong>
      </div>
      <div style={{ padding: '12px 16px' }}>

        {/* Header card */}
        <div style={{ ...s.card, textAlign: 'center', padding: '20px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 40, marginBottom: 6 }}>💎</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.text, letterSpacing: '0.03em' }}>
            প্রিমিয়ামে আপগ্রেড করুন
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>আনলিমিটেড সিগনাল — ৩০ দিন</div>
          {tgUser?.id > 0 && (
            <div style={{ marginTop: 10, background: '#0d1117', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#9ba3af' }}>
              👤 {tgUser.first_name} {tgUser.last_name || ''}
              {tgUser.username && <span style={{ color: C.blue }}> @{tgUser.username}</span>}
            </div>
          )}
        </div>

        {/* Free vs Premium quick compare */}
        <div style={{ ...s.card, marginBottom: 12, display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 4 }}>🆓 ফ্রি</div>
            <div style={{ fontSize: 12, color: C.text }}>দৈনিক ৩টা সিগনাল</div>
          </div>
          <div style={{ width: 1, background: C.border }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: C.gold, marginBottom: 4 }}>💎 প্রিমিয়াম</div>
            <div style={{ fontSize: 12, color: C.text }}>আনলিমিটেড সিগনাল</div>
          </div>
        </div>

        <PromoBox promoInput={promoInput} setPromoInput={setPromoInput} promoApplied={promoApplied}
          applyPromo={applyPromo} removePromo={removePromo} amount={amount} />

        <PaymentNumbers copied={copied} copyNum={copyNum} amount={amount} promoApplied={promoApplied} />

        <PaymentForm
          method={method} setMethod={setMethod}
          senderNumber={senderNumber} setSenderNumber={setSenderNumber}
          txId={txId} setTxId={setTxId} amount={amount}
          loading={loading} error={error} handleSubmit={handleSubmit}
        />

        <SocialFooter />
      </div>
    </div>
  )
}

// ── Promo code box ────────────────────────────────────────────
function PromoBox({ promoInput, setPromoInput, promoApplied, applyPromo, removePromo, amount }) {
  return (
    <div style={{ ...s.card, marginBottom: 12 }}>
      <div style={s.sectionLabel}>প্রমো কোড আছে?</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input type="text" placeholder="প্রমো কোড লিখুন" value={promoInput}
          onChange={e => setPromoInput(e.target.value)}
          disabled={promoApplied}
          style={{ ...s.input, opacity: promoApplied ? 0.6 : 1 }} />
        {promoApplied ? (
          <button onClick={removePromo} style={{
            padding: '0 16px', borderRadius: 8, background: 'transparent',
            border: `1px solid ${C.red}`, color: C.red, fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>মুছুন</button>
        ) : (
          <button onClick={applyPromo} style={{
            padding: '0 16px', borderRadius: 8, background: C.gold,
            color: '#000', fontWeight: 800, fontSize: 12, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>প্রয়োগ করুন</button>
        )}
      </div>
      {promoApplied && (
        <div style={{ fontSize: 11, color: C.green }}>
          🎉 প্রমো কোড প্রয়োগ হয়েছে! এখন পে করতে হবে ৳{amount}
        </div>
      )}
    </div>
  )
}

// ── Small footer: Channel / Group / Chat (used everywhere) ─────
function SocialFooter() {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
      <button onClick={() => window.open(CHANNEL_LINK, '_blank')} style={s.socialBtn}>📢 চ্যানেল</button>
      <button onClick={() => window.open(GROUP_LINK, '_blank')} style={s.socialBtn}>👥 গ্রুপ</button>
      <button onClick={() => window.open(CHAT_LINK, '_blank')} style={s.socialBtn}>💬 চ্যাট</button>
    </div>
  )
}

// ── Payment numbers card ──────────────────────────────────────
function PaymentNumbers({ copied, copyNum, amount, promoApplied }) {
  return (
    <div style={{ ...s.card, marginBottom: 12 }}>
      <div style={s.sectionLabel}>পেমেন্ট নম্বর</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div style={{ ...s.numCard, borderColor: '#e2136e55' }} onClick={() => copyNum(BKASH_NUMBER, 'bkash')}>
          <div style={{ color: C.pink, fontWeight: 800, fontSize: 12, marginBottom: 4 }}>🩷 বিকাশ</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: '0.05em' }}>{BKASH_NUMBER}</div>
          <div style={{ fontSize: 10, color: copied === 'bkash' ? C.green : C.muted, marginTop: 4 }}>
            {copied === 'bkash' ? '✅ কপি হয়েছে!' : 'ট্যাপ করে কপি করুন'}
          </div>
        </div>
        <div style={{ ...s.numCard, borderColor: '#f7941d55' }} onClick={() => copyNum(NAGAD_NUMBER, 'nagad')}>
          <div style={{ color: C.orange, fontWeight: 800, fontSize: 12, marginBottom: 4 }}>🧡 নগদ</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: '0.05em' }}>{NAGAD_NUMBER}</div>
          <div style={{ fontSize: 10, color: copied === 'nagad' ? C.green : C.muted, marginTop: 4 }}>
            {copied === 'nagad' ? '✅ কপি হয়েছে!' : 'ট্যাপ করে কপি করুন'}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'center', fontSize: 13, color: '#9ba3af' }}>
        Send Money পাঠান: <strong style={{ color: C.gold }}>৳{amount}</strong>
        {promoApplied && <span style={{ color: C.muted, textDecoration: 'line-through', marginLeft: 6, fontSize: 11 }}>৳{FULL_PRICE}</span>}
      </div>
    </div>
  )
}

// ── Payment Form (method, sender number, txId, locked amount, submit) ─
function PaymentForm({ method, setMethod, senderNumber, setSenderNumber, txId, setTxId, amount, loading, error, handleSubmit }) {
  return (
    <div style={{ ...s.card, marginBottom: 12 }}>
      <div style={s.sectionLabel}>পেমেন্ট তথ্য দিন</div>

      <div style={{ marginBottom: 12 }}>
        <div style={s.fieldLabel}>মেথড সিলেক্ট করুন</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[{ key: 'বিকাশ', color: C.pink }, { key: 'নগদ', color: C.orange }].map(({ key, color }) => (
            <button key={key} onClick={() => setMethod(key)} style={{
              flex: 1, padding: '12px', borderRadius: 8, fontWeight: 700, fontSize: 13,
              cursor: 'pointer', transition: '0.2s',
              background: method === key ? color + '22' : C.panel,
              color:      method === key ? color : C.muted,
              border:     method === key ? `2px solid ${color}` : `2px solid ${C.border}`,
            }}>{key}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={s.fieldLabel}>যে নম্বর থেকে টাকা পাঠিয়েছেন</div>
        <input type="tel" placeholder="যেমন: 017XXXXXXXX" value={senderNumber}
          onChange={e => setSenderNumber(e.target.value)} style={s.input} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={s.fieldLabel}>পরিমাণ (টাকা)</div>
        <input type="text" value={`৳${amount}`} readOnly disabled
          style={{ ...s.input, opacity: 0.6, cursor: 'not-allowed', fontWeight: 800, color: C.gold }} />
        <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
          প্রমো কোড অনুযায়ী পরিমাণ স্বয়ংক্রিয়ভাবে ঠিক হয়ে গেছে — এডিট করা যাবে না।
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={s.fieldLabel}>ট্রানজেকশন আইডি / TrxID</div>
        <input type="text" placeholder="TrxID বা Ref নম্বর লিখুন" value={txId}
          onChange={e => setTxId(e.target.value)} style={s.input} />
      </div>

      {error && (
        <div style={{ background: '#f6465d11', border: '1px solid #f6465d44', borderRadius: 8, padding: '10px 12px', color: '#f6465d', fontSize: 12, marginBottom: 12 }}>
          ⚠️ {error}
        </div>
      )}

      <button onClick={handleSubmit} disabled={loading} style={{
        width: '100%', padding: '14px', borderRadius: 10,
        background: loading ? C.panel : C.gold, color: loading ? C.muted : '#000',
        fontWeight: 800, fontSize: 14, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
      }}>
        {loading ? '⏳ সাবমিট হচ্ছে...' : '✅ পেমেন্ট সাবমিট করুন'}
      </button>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────
const s = {
  notifBar: {
    background: 'linear-gradient(90deg, #1a1200, #251a00)',
    borderBottom: '1px solid #f3ba2f33',
    color: '#f3ba2f', fontSize: 12, padding: '10px 16px', textAlign: 'center',
  },
  card: {
    background: '#141820', borderRadius: 14, padding: '16px',
    border: '1px solid #2b3139',
  },
  numCard: {
    flex: 1, background: '#0d1117', borderRadius: 10, padding: '12px 10px',
    textAlign: 'center', cursor: 'pointer', border: '1px solid #2b3139',
  },
  sectionLabel: {
    fontSize: 10, color: '#555', fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 10, color: '#555', fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6,
  },
  input: {
    width: '100%', padding: '12px', borderRadius: 8,
    background: '#0d1117', color: '#e0e0e0',
    border: '1px solid #2b3139', fontSize: 13, outline: 'none',
  },
  supportBtnLarge: {
    width: '100%', padding: '14px', borderRadius: 10,
    background: '#1a2744', color: '#60a5fa',
    fontWeight: 700, fontSize: 13, border: '1px solid #60a5fa44',
    cursor: 'pointer', marginTop: 4,
  },
  socialBtn: {
    flex: 1, padding: '9px 4px', borderRadius: 8,
    background: '#1a2744', color: '#60a5fa',
    fontWeight: 700, fontSize: 10.5, border: '1px solid #60a5fa33',
    cursor: 'pointer',
  },
        }
