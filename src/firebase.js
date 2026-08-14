import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCrDGsthtBUFhZ1-6PxnFXcpmb0w9IszFM",
  authDomain: "qutex-afb64.firebaseapp.com",
  projectId: "qutex-afb64",
  storageBucket: "qutex-afb64.firebasestorage.app",
  messagingSenderId: "833115908129",
  appId: "1:833115908129:web:6f9a8362cc853e97065b60"
};

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
