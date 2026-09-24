// ============================================================
// SHARED UTILITIES
// ============================================================

/**
 * Escape user-generated text before inserting into innerHTML.
 */
export function escapeHTML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Pick a random item from an array.
 */
export function randomItem(array) {
    if (!array || array.length === 0) {
        return "";
    }
    return array[Math.floor(Math.random() * array.length)];
}

/**
 * Fisher–Yates shuffle (returns a new array).
 */
export function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * Normalize text for comparison (trim + uppercase).
 */
export function normalizeText(value) {
    return String(value || "").trim().toUpperCase();
}

/**
 * FNV-1a hash → unsigned 32-bit integer.
 */
export function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
}

/**
 * Small helper — only logs when DEBUG is on.
 */
export function debug(...args) {
    if (window.APP_CONFIG?.DEBUG) {
        console.log("[BanWorld]", ...args);
    }
}