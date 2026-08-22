// ============================================================================
// functions/api/_lib/auth.js
// الجلسات، Rate Limiting، Idempotency، السياق الأمني (Auth Context)
// كل هذا يعتمد على env.SETTINGS_KV (namespace واحد موحّد، مفصول بالبادئات)
// ============================================================================

import { generateSecureToken } from "./utils.js";

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 ساعة
const SESSION_COOKIE_NAME = "cashier_session";

export { SESSION_COOKIE_NAME };

// ----------------------------------------------------------------------------
// إدارة الجلسات — مفتاح: sessions:<token>
// ----------------------------------------------------------------------------
export async function createSession(env, sessionData) {
    const token = generateSecureToken(32);
    await env.SETTINGS_KV.put(`sessions:${token}`, JSON.stringify(sessionData), {
        expirationTtl: SESSION_TTL_SECONDS,
    });
    return token;
}

export async function getSession(env, token) {
    if (!token) return null;
    const raw = await env.SETTINGS_KV.get(`sessions:${token}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export async function destroySession(env, token) {
    if (!token) return;
    await env.SETTINGS_KV.delete(`sessions:${token}`);
}

export function parseCookies(request) {
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = {};
    cookieHeader.split(";").forEach((pair) => {
        const idx = pair.indexOf("=");
        if (idx === -1) return;
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (name) cookies[name] = decodeURIComponent(value);
    });
    return cookies;
}

export function buildSessionCookieHeader(token, maxAgeSeconds) {
    return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function buildClearCookieHeader() {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export const SESSION_TTL = SESSION_TTL_SECONDS;

// ----------------------------------------------------------------------------
// Rate Limiting — مفتاح: ratelimit:<scope>:<identifier>
// ----------------------------------------------------------------------------
export async function checkRateLimit(env, scope, identifier, maxAttempts, windowSeconds) {
    const key = `ratelimit:${scope}:${identifier}`;
    const current = await env.SETTINGS_KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= maxAttempts) return { allowed: false, remaining: 0 };

    if (!current) {
        await env.SETTINGS_KV.put(key, "1", { expirationTtl: windowSeconds });
    } else {
        await env.SETTINGS_KV.put(key, String(count + 1), { expirationTtl: windowSeconds });
    }
    return { allowed: true, remaining: maxAttempts - count - 1 };
}

// ----------------------------------------------------------------------------
// Idempotency-Key — مفتاح: idempotency:<restaurant_id>:<key>
// يمنع تكرار تسجيل نفس الطلب بسبب ضغط الزر مرتين أو إعادة إرسال الشبكة.
// ----------------------------------------------------------------------------
export async function checkIdempotency(env, restaurantId, idempotencyKey) {
    if (!idempotencyKey) return null;
    const raw = await env.SETTINGS_KV.get(`idempotency:${restaurantId}:${idempotencyKey}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export async function storeIdempotencyResult(env, restaurantId, idempotencyKey, resultData) {
    if (!idempotencyKey) return;
    await env.SETTINGS_KV.put(
        `idempotency:${restaurantId}:${idempotencyKey}`,
        JSON.stringify(resultData),
        { expirationTtl: 60 * 60 * 24 } // 24 ساعة
    );
}

// ----------------------------------------------------------------------------
// السياق الأمني (Auth Context) — المصدر الوحيد الموثوق لـ restaurant_id/role
// لا يُقرأ restaurant_id أو role أبدًا من body الطلب أو query params في أي
// مكان آخر بالمشروع — فقط من هنا، القادم أصلًا من الجلسة المخزّنة في KV.
// ----------------------------------------------------------------------------
export async function getAuthContext(request, env) {
    const cookies = parseCookies(request);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return null;

    const session = await getSession(env, token);
    if (!session) return null;

    return {
        token,
        userId: session.userId,
        restaurantId: session.restaurantId, // null فقط لـ SUPER_ADMIN
        role: session.role,
        username: session.username,
    };
}

export function requireAuth(ctx) {
    return ctx !== null;
}

export function requireRole(ctx, allowedRoles) {
    return ctx !== null && allowedRoles.includes(ctx.role);
}

// يفرض وجود restaurant_id في السياق (أي دور عدا SUPER_ADMIN بدون مطعم محدد)
export function requireRestaurantContext(ctx) {
    return ctx !== null && ctx.restaurantId !== null && ctx.restaurantId !== undefined;
}

// ----------------------------------------------------------------------------
// سجل التدقيق (Audit Log)
// ----------------------------------------------------------------------------
export async function writeAuditLog(env, { restaurantId, userId, action, entityType, entityId, details }) {
    try {
        await env.DB.prepare(
            `INSERT INTO audit_logs (restaurant_id, user_id, action, entity_type, entity_id, details)
             VALUES (?, ?, ?, ?, ?, ?)`
        )
            .bind(
                restaurantId ?? null,
                userId ?? null,
                action,
                entityType ?? null,
                entityId ?? null,
                details ? JSON.stringify(details) : null
            )
            .run();
    } catch (err) {
        console.error("audit_log_write_failed", err);
    }
}
