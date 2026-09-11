/* ============================================================
   PANDEM — Firebase bootstrap (OPTIONAL sign-in)
   ------------------------------------------------------------
   Firebase is initialised if the SDK loaded successfully.
   If it did not (blocked script, offline, bad config), the app
   keeps working in "local mode" using the browser's storage.
   ============================================================ */

(function () {
"use strict";

const firebaseConfig = {
  apiKey: "AIzaSyCNCo83ZgyQ5JEbYDiN7w-Vs2IPAYci69s",
  authDomain: "healthapp-c22c5.firebaseapp.com",
  projectId: "healthapp-c22c5",
  storageBucket: "healthapp-c22c5.firebasestorage.app",
  messagingSenderId: "399695097115",
  appId: "1:399695097115:web:ebd244f60ef203e4bdb7be"
};

let auth = null;
let db = null;
let provider = null;
let firebaseReady = false;

try {
  if (typeof firebase !== "undefined" && firebase.initializeApp) {
    if (!firebase.apps || firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
    }
    auth = firebase.auth ? firebase.auth() : null;
    db = firebase.firestore ? firebase.firestore() : null;
    provider = firebase.auth && firebase.auth.GoogleAuthProvider
      ? new firebase.auth.GoogleAuthProvider()
      : null;
    firebaseReady = !!(auth && db);
  } else {
    console.warn("[PANDEM] Firebase SDK not loaded — running in local mode.");
  }
} catch (err) {
  console.warn("[PANDEM] Firebase init failed — running in local mode.", err);
}

window.HealthMapFirebase = { firebaseReady, auth, db, provider, firebaseConfig };

})();
