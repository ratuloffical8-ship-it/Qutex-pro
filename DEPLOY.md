Skip to content
Qx-Mashaallha-
Repository navigation
Code
Issues
Pull requests
Actions
Qx-Mashaallha-
/DEPLOY.md
ratuloffical837-beep
ratuloffical837-beep
2 months ago
150 lines (110 loc) · 4.72 KB

Preview

Code

Blame
🚀 Master AI Signal — Deploy গাইড
ফাইল তালিকা (মোট ১১টি)
project/
├── src/
│   ├── main.jsx          ← React entry
│   ├── App.jsx           ← Trading UI
│   ├── PaymentPage.jsx   ← পেমেন্ট পেজ
│   ├── signalEngine.js   ← সিগনাল ইঞ্জিন
│   └── firebase.js       ← Firebase config
├── server.js             ← Backend + Bot
├── index.html
├── vite.config.js
├── package.json
├── render.yaml
├── firestore.rules
└── .gitignore
ধাপ ১ — Firebase Firestore Rules সেট করুন
https://console.firebase.google.com → আপনার project
Firestore Database → Rules ট্যাব
firestore.rules ফাইলের সব কোড paste করুন → Publish
ধাপ ২ — Firebase Service Account JSON নিন
Firebase Console → Project Settings (⚙️)
Service Accounts ট্যাব
Generate new private key → JSON ডাউনলোড হবে
JSON কে base64 করুন:
Windows (PowerShell):

[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\serviceAccount.json")) | clip
(Clipboard-এ কপি হয়ে যাবে)

Linux/Mac:

cat serviceAccount.json | base64 | tr -d '\n'
এই output-টি save করুন — Render-এ লাগবে।

ধাপ ৩ — Telegram Bot তৈরি করুন
Telegram-এ @BotFather খুলুন
/newbot → নাম দিন → Token পাবেন (save করুন)
@userinfobot খুলুন → /start → আপনার ID পাবেন
ধাপ ৪ — GitHub-এ Upload করুন
https://github.com → New repository → master-ai-signal
সব ১১টি ফাইল upload করুন (ফোল্ডার সহ)
ধাপ ৫ — Render.com Deploy
৫.১ — Backend (Web Service)
https://render.com → New → Web Service
GitHub repo connect করুন
নাম: master-ai-backend
Build Command: npm install
Start Command: node server.js
Environment Variables যোগ করুন:
Key	Value
NODE_ENV	production
BOT_TOKEN	BotFather থেকে পাওয়া token
ADMIN_TELEGRAM_ID	আপনার Telegram ID
FIREBASE_SERVICE_ACCOUNT_B64	base64 করা JSON
WEBHOOK_SECRET	যেকোনো random word (যেমন: abc123xyz)
RENDER_EXTERNAL_URL	Deploy হলে এই URL পাবেন (নিচে দেখুন)
Deploy করুন → URL পাবেন (যেমন: https://master-ai-backend.onrender.com)
এই URL টি RENDER_EXTERNAL_URL-এ সেট করুন (আবার Save)
৫.২ — BACKEND URL ফাইলে বসান
src/PaymentPage.jsx ফাইলে এই লাইন:

const BACKEND_URL = 'https://master-ai-backend.onrender.com'
এখানে আপনার actual backend URL বসান।

একই URL src/App.jsx-এর উপরে:

const BACKEND_URL = 'https://master-ai-backend.onrender.com'
GitHub-এ এই পরিবর্তন push করুন।

৫.৩ — Frontend (Static Site)
Render → New → Static Site
একই GitHub repo connect করুন
Build Command: npm install && npm run build
Publish Directory: dist
Deploy করুন → Frontend URL পাবেন
ধাপ ৬ — Telegram Mini App সেট করুন
BotFather-এ:

/setmenubutton
→ আপনার bot সিলেক্ট করুন
→ URL: https://your-frontend.onrender.com
→ Button text: Open Master AI
সব হয়ে গেলে টেস্ট করুন
Telegram-এ আপনার bot খুলুন
Menu button চাপুন → Mini App খুলবে
পেমেন্ট পেজ দেখাবে
পেমেন্ট সাবমিট করুন → আপনার Telegram-এ নোটিফিকেশন আসবে
✅ কনফার্ম চাপুন → ইউজার ভেতরে ঢুকতে পারবে
Admin Commands (Bot-এ)
Action	কীভাবে
পেমেন্ট কনফার্ম	Notification-এ ✅ বাটন
পেমেন্ট রিজেক্ট	Notification-এ ❌ বাটন
সব user দেখুন	যেকোনো notification-এ 👥 Check Users
User disconnect	Check Users → 🔴 Disconnect
