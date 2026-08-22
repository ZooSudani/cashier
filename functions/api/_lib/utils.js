// ============================================================================
// functions/api/_lib/utils.js
// أدوات مشتركة: استجابات JSON، تجزئة كلمات المرور (PBKDF2)، معرّفات آمنة
// ملاحظة: أي مجلد اسمه يبدأ بـ "_" لا يتحول لمسار API في Cloudflare Pages —
// لذلك هذا الملف وبقية ملفات _lib آمنة للاستيراد فقط، ولا تُطلب مباشرة أبدًا.
// ============================================================================

const PBKDF2_ITERATIONS = 210000;
const PBKDF2_HASH       = "SHA-256";
const PBKDF2_KEY_LENGTH = 32; // بايت

// ----------------------------------------------------------------------------
// أدوات استجابة JSON موحّدة
// ----------------------------------------------------------------------------
export function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...extraHeaders,
        },
    });
}

export function errorResponse(message, status = 400, code = null) {
    return jsonResponse({ error: message, code: code || undefined }, status);
}

// ----------------------------------------------------------------------------
// تجزئة كلمات المرور — PBKDF2-SHA256 عبر Web Crypto API
// التنسيق المخزّن: pbkdf2$<iterations>$<salt_base64>$<hash_base64>
// ----------------------------------------------------------------------------
function bufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

export async function hashPassword(plainPassword) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", encoder.encode(plainPassword), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        keyMaterial,
        PBKDF2_KEY_LENGTH * 8
    );
    return `pbkdf2$${PBKDF2_ITERATIONS}$${bufferToBase64(salt.buffer)}$${bufferToBase64(derivedBits)}`;
}

export async function verifyPassword(plainPassword, storedHash) {
    try {
        const parts = storedHash.split("$");
        if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
        const iterations = parseInt(parts[1], 10);
        const salt = new Uint8Array(base64ToBuffer(parts[2]));
        const expectedHashB64 = parts[3];

        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw", encoder.encode(plainPassword), { name: "PBKDF2" }, false, ["deriveBits"]
        );
        const derivedBits = await crypto.subtle.deriveBits(
            { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
            keyMaterial,
            PBKDF2_KEY_LENGTH * 8
        );
        return timingSafeEqual(bufferToBase64(derivedBits), expectedHashB64);
    } catch {
        return false;
    }
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return result === 0;
}

// ----------------------------------------------------------------------------
// توليد معرّفات عشوائية آمنة (Session Tokens / أسماء ملفات R2)
// ----------------------------------------------------------------------------
export function generateSecureToken(byteLength = 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function getClientIdentifier(request) {
    return request.headers.get("CF-Connecting-IP") || "unknown";
}
