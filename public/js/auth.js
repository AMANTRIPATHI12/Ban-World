// ============================================================
// FIREBASE AUTHENTICATION
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { FIREBASE_CONFIG } from "../firebase-config.js";

// ============================================================
// FIREBASE INIT
// ============================================================

const fbApp = initializeApp(FIREBASE_CONFIG);

export const auth = getAuth(fbApp);
export const fsDb = getFirestore(fbApp);

const googleProvider = new GoogleAuthProvider();

// ============================================================
// AUTH STATE (pub/sub)
// ============================================================

let currentUser = null;
let authResolved = false;
const authListeners = [];

/**
 * Subscribe to auth state changes.
 * If auth has already resolved, the callback fires immediately.
 */
export function onAuthChange(callback) {
    authListeners.push(callback);
    if (authResolved) {
        try {
            callback(currentUser);
        } catch (err) {
            console.error("[auth] listener error:", err);
        }
    }
}

/**
 * Synchronously get the current user (may be null on first load).
 */
export function getCurrentUser() {
    return currentUser;
}

function fireAuthChange(user) {
    currentUser = user;
    authResolved = true;
    authListeners.forEach((fn) => {
        try {
            fn(user);
        } catch (err) {
            console.error("[auth] listener error:", err);
        }
    });
}

// ============================================================
// USER PROFILE (Firestore)
// ============================================================

/**
 * Ensures a `users/{uid}` document exists.
 * Returns the profile data (or a freshly-created default).
 */
async function ensureUserProfile(user) {
    const ref = doc(fsDb, "users", user.uid);
    const snap = await getDoc(ref);

    if (snap.exists()) {
        return snap.data();
    }

    const profile = {
        displayName: user.displayName || "",
        email: user.email || "",
        photoURL: user.photoURL || "",
        totalScore: 0,
        bestStreak: 0,
        createdAt: serverTimestamp()
    };

    console.log("[auth] Creating user profile for", user.uid);
    await setDoc(ref, profile);

    // Return the freshly created profile (with placeholder createdAt for now)
    return profile;
}

/**
 * Fetch the current user's Firestore profile.
 * Returns `null` if not signed in or if the fetch fails.
 */
export async function fetchUserProfile() {
    if (!currentUser) return null;
    try {
        const ref = doc(fsDb, "users", currentUser.uid);
        const snap = await getDoc(ref);
        return snap.exists() ? snap.data() : null;
    } catch (err) {
        console.error("[auth] fetchUserProfile failed:", err);
        return null;
    }
}

// ============================================================
// SIGN IN / OUT
// ============================================================

export async function signInWithGoogle() {
    try {
        await signInWithPopup(auth, googleProvider);
    } catch (err) {
        console.error("Sign in failed:", err);
        alert("Sign in failed: " + err.message);
    }
}

export async function signOutUser() {
    try {
        await signOut(auth);
    } catch (err) {
        console.error("Sign out failed:", err);
    }
}

// ============================================================
// AUTH-AWARE FETCH
// ============================================================

/**
 * fetch() that automatically attaches the current user's ID token.
 * Falls back to a plain fetch if no user is signed in.
 */
export async function authFetch(url, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };

    if (currentUser) {
        const token = await currentUser.getIdToken();
        headers["Authorization"] = `Bearer ${token}`;
    }

    return fetch(url, { ...options, headers });
}

// ============================================================
// DOM: HEADER BUTTONS
// ============================================================

const headerEls = {
    authArea: document.getElementById("authArea"),
    signInBtn: document.getElementById("googleSignInBtn"),
    signOutBtn: document.getElementById("signOutBtn"),
    userInfo: document.getElementById("userInfo"),
    userPhoto: document.getElementById("userPhoto"),
    userName: document.getElementById("userName"),
    signInHint: document.getElementById("signInHint")
};

if (headerEls.signInBtn) {
    headerEls.signInBtn.addEventListener("click", signInWithGoogle);
}

if (headerEls.signOutBtn) {
    headerEls.signOutBtn.addEventListener("click", signOutUser);
}

// ============================================================
// REACT TO AUTH CHANGES
// ============================================================

onAuthStateChanged(auth, async (user) => {
    // ---- 1. Ensure profile exists in Firestore (only when signed in)
    if (user) {
        try {
            await ensureUserProfile(user);
        } catch (err) {
            console.error("[auth] Failed to ensure user profile:", err);
        }
    }

    // ---- 2. Toggle header UI
    if (user) {
        if (headerEls.signInBtn) headerEls.signInBtn.style.display = "none";
        if (headerEls.userInfo) headerEls.userInfo.classList.remove("hidden");
        if (headerEls.userPhoto) headerEls.userPhoto.src = user.photoURL || "";
        if (headerEls.userName) {
            headerEls.userName.textContent = user.displayName || user.email;
        }

        // Play page: hide the "sign in to save progress" hint
        if (headerEls.signInHint) headerEls.signInHint.classList.add("hidden");
    } else {
        if (headerEls.signInBtn) headerEls.signInBtn.style.display = "";
        if (headerEls.userInfo) headerEls.userInfo.classList.add("hidden");

        // Play page: show the hint again
        if (headerEls.signInHint) headerEls.signInHint.classList.remove("hidden");
    }

    // ---- 3. Reveal the auth area (was hidden to prevent "sign in" flash)
    if (headerEls.authArea) {
        headerEls.authArea.classList.remove("hidden");
    }

    // ---- 4. Broadcast to all subscribers
    fireAuthChange(user);
});