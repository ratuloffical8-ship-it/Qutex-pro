import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

// ── Firebase Admin (Render ENV থেকে base64 JSON) ─────────────
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
)
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

// ── Config ─────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN
const ADMIN_ID       = process.env.ADMIN_TELEGRAM_ID
const WH_SECRET      = process.env.WEBHOOK_SECRET || 'masterai2024'
const BASE_URL       = process.env.RENDER_EXTERNAL_URL || `http://localhost:5000`

const app = express()
app.use(cors())
app.use(express.json())

// ── Telegram API helper ────────────────────────────────────────
const tg = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── Health check ───────────────────────────────────────────────
app.get('/', (req, res) => res.send('Master AI Backend Online ✅'))

// ── Frontend থেকে payment notification ────────────────────────
app.post('/api/notify-payment', async (req, res) => {
  try {
    const { userId, name, username, method, senderNumber, amount, txId, promoCode } = req.body

    if (!userId || !txId) return res.status(400).json({ ok: false, error: 'Missing fields' })

    const promoLine = promoCode
      ? `🎟️ প্রমো কোড: <code>${promoCode}</code>`
      : `🎟️ প্রমো কোড: <i>No promo code</i>`

    const msg =
      `💳 <b>নতুন পেমেন্ট রিকোয়েস্ট</b>\n\n` +
      `👤 নাম: <b>${name}</b>\n` +
      `🆔 TG ID: <code>${userId}</code>\n` +
      (username ? `📎 Username: @${username}\n` : ``) +
      `💰 পরিমাণ: <b>৳${amount}</b>\n` +
      `📱 মেথড: <b>${method}</b>\n` +
      `☎️ প্রেরক নম্বর: <code>${senderNumber || 'N/A'}</code>\n` +
      `🔑 TrxID: <code>${txId}</code>\n` +
      `${promoLine}`

    await tg('sendMessage', {
      chat_id: ADMIN_ID,
      text: msg,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ কনফার্ম',    callback_data: `confirm:${userId}:${txId}` },
            { text: '❌ রিজেক্ট',    callback_data: `reject:${userId}:${txId}` },
          ],
          [
            { text: '👥 Check Users', callback_data: 'check_users' },
          ],
        ],
      },
    })

    res.json({ ok: true })
  } catch (e) {
    console.error('notify-payment error:', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Telegram Webhook ───────────────────────────────────────────
app.post(`/webhook/${WH_SECRET}`, async (req, res) => {
  res.sendStatus(200) // Telegram-কে দ্রুত 200 দাও

  const update = req.body
  if (!update.callback_query) return

  const cb     = update.callback_query
  const data   = cb.data
  const chatId = cb.message.chat.id
  const msgId  = cb.message.message_id

  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, text })
  const editBtn = (label) => tg('editMessageReplyMarkup', {
    chat_id: chatId, message_id: msgId,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'done' }]] },
  })

  // ── CONFIRM ─────────────────────────────────────────────────
  if (data.startsWith('confirm:')) {
    const [, userId, txId] = data.split(':')
    try {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)

      await db.collection('users').doc(userId).set({
        status:    'approved',
        expiresAt,
        approvedAt: FieldValue.serverTimestamp(),
        lastTxId:  txId,
      }, { merge: true })

      await db.collection('payments').doc(txId).update({ status: 'approved' })

      await ack('✅ কনফার্ম সফল!')
      await editBtn('✅ কনফার্ম হয়েছে')

      // ইউজারকে জানাও
      await tg('sendMessage', {
        chat_id: userId,
        text: `✅ <b>পেমেন্ট কনফার্ম!</b>\n\nআপনার প্রিমিয়াম সাবস্ক্রিপশন সক্রিয় হয়েছে। 🎉\nমেয়াদ: ${expiresAt.toLocaleDateString('bn-BD')} পর্যন্ত`,
        parse_mode: 'HTML',
      }).catch(() => {})
    } catch (e) {
      await ack('❌ Error: ' + e.message)
    }

  // ── REJECT ──────────────────────────────────────────────────
  } else if (data.startsWith('reject:')) {
    const [, userId, txId] = data.split(':')
    try {
      await db.collection('payments').doc(txId).update({ status: 'rejected' })
      await db.collection('users').doc(userId).set({ status: 'rejected' }, { merge: true })

      await ack('❌ রিজেক্ট করা হয়েছে')
      await editBtn('❌ রিজেক্ট হয়েছে')

      await tg('sendMessage', {
        chat_id: userId,
        text: `❌ <b>পেমেন্ট রিজেক্ট</b>\n\nআপনার পেমেন্ট যাচাই হয়নি।\nসঠিক তথ্য দিয়ে আবার পেমেন্ট করুন।`,
        parse_mode: 'HTML',
      }).catch(() => {})
    } catch (e) {
      await ack('❌ Error')
    }

  // ── CHECK USERS ─────────────────────────────────────────────
  } else if (data === 'check_users') {
    try {
      const snap = await db.collection('users').where('status', '==', 'approved').get()

      if (snap.empty) {
        await ack('কোনো active user নেই')
        return
      }

      const users = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      await ack(`${users.length} জন active user`)

      const lines = users.map(u => {
        const exp = u.expiresAt?.toDate?.()?.toLocaleDateString('bn-BD') || 'N/A'
        return `👤 <b>${u.name || 'N/A'}</b> | <code>${u.id}</code> | ${exp}`
      }).join('\n')

      const keyboard = users.map(u => ([
        { text: `🔴 Disconnect: ${(u.name || u.id).slice(0, 20)}`, callback_data: `disconnect:${u.id}` },
        { text: `🟢 Connected`, callback_data: 'noop' },
      ]))

      await tg('sendMessage', {
        chat_id: chatId,
        text: `👥 <b>Active Premium Users (${users.length} জন)</b>\n\n${lines}`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      })
    } catch (e) {
      await ack('❌ Error: ' + e.message)
    }

  // ── DISCONNECT ──────────────────────────────────────────────
  } else if (data.startsWith('disconnect:')) {
    const [, userId] = data.split(':')
    try {
      await db.collection('users').doc(userId).update({
        status:    'disconnected',
        expiresAt: new Date(0),
      })

      await ack('🔴 Disconnect সফল!')

      await tg('sendMessage', {
        chat_id: userId,
        text: `⚠️ <b>প্রিমিয়াম মেয়াদ শেষ</b>\n\nআপনার প্রিমিয়াম অ্যাক্সেস বন্ধ করা হয়েছে — এখন থেকে ফ্রি টায়ারে ফিরিয়ে আনা হয়েছে।\nআবার পেমেন্ট করলে প্রিমিয়াম ফিরে পাবেন।`,
        parse_mode: 'HTML',
      }).catch(() => {})
    } catch (e) {
      await ack('❌ Error')
    }

  } else if (data === 'noop') {
    await ack('✅ এই ইউজার active আছে')

  } else if (data === 'done') {
    await ack('ok')
  }
})

// ── Start + register webhook ───────────────────────────────────
const PORT = process.env.PORT || 5000
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`)
  if (process.env.NODE_ENV === 'production' && BOT_TOKEN) {
    const result = await tg('setWebhook', { url: `${BASE_URL}/webhook/${WH_SECRET}` })
    console.log('Webhook:', result.description)
  }
})
