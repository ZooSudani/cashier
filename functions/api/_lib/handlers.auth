// ============================================================================
// functions/api/_lib/handlers.auth.js
// معالجات: POST /api/auth/setup, login, logout
// ============================================================================

import { jsonResponse, errorResponse, hashPassword, verifyPassword, getClientIdentifier } from "./utils.js";
import {
    checkRateLimit, createSession, getSession, destroySession, parseCookies,
    buildSessionCookieHeader, buildClearCookieHeader, writeAuditLog,
    SESSION_COOKIE_NAME, SESSION_TTL,
} from "./auth.js";

// POST /api/auth/setup — يعمل مرة واحدة فقط لإنشاء أول SUPER_ADMIN
export async function handleAuthSetup(request, env) {
    const rateLimit = await checkRateLimit(env, "setup", getClientIdentifier(request), 5, 3600);
    if (!rateLimit.allowed) return errorResponse("محاولات كثيرة جدًا، حاول لاحقًا", 429, "RATE_LIMITED");

    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { username, password } = body || {};
    if (!username || !password || typeof username !== "string" || typeof password !== "string") {
        return errorResponse("اسم المستخدم وكلمة المرور مطلوبان", 400);
    }
    if (password.length < 8) return errorResponse("كلمة المرور يجب ألا تقل عن 8 أحرف", 400);
    if (username.length < 3 || username.length > 64) return errorResponse("اسم المستخدم غير صالح", 400);

    const existing = await env.DB.prepare(
        `SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1`
    ).first();
    if (existing) return errorResponse("تم إعداد النظام مسبقًا", 403, "ALREADY_SETUP");

    const passwordHash = await hashPassword(password);
    const result = await env.DB.prepare(
        `INSERT INTO users (restaurant_id, username, password_hash, role, is_active)
         VALUES (NULL, ?, ?, 'SUPER_ADMIN', 1)`
    ).bind(username, passwordHash).run();

    const newUserId = result.meta.last_row_id;
    await writeAuditLog(env, {
        restaurantId: null, userId: newUserId, action: "USER_CREATED",
        entityType: "user", entityId: newUserId, details: { role: "SUPER_ADMIN", via: "setup" },
    });

    return jsonResponse({ success: true, message: "تم إنشاء حساب المدير الأعلى بنجاح" }, 201);
}

// POST /api/auth/login
export async function handleAuthLogin(request, env) {
    const clientId = getClientIdentifier(request);
    const rateLimit = await checkRateLimit(env, "login", clientId, 10, 900);
    if (!rateLimit.allowed) return errorResponse("محاولات دخول كثيرة جدًا، حاول بعد قليل", 429, "RATE_LIMITED");

    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { username, password, restaurantSlug } = body || {};
    if (!username || !password) return errorResponse("اسم المستخدم وكلمة المرور مطلوبان", 400);

    let user;
    if (restaurantSlug) {
        const restaurant = await env.DB.prepare(
            `SELECT id, is_active FROM restaurants WHERE slug = ?`
        ).bind(restaurantSlug).first();

        if (!restaurant) return errorResponse("بيانات الدخول غير صحيحة", 401, "INVALID_CREDENTIALS");
        if (!restaurant.is_active) return errorResponse("هذا المطعم معطّل حاليًا", 403, "RESTAURANT_DISABLED");

        user = await env.DB.prepare(
            `SELECT id, restaurant_id, username, password_hash, role, is_active
             FROM users WHERE restaurant_id = ? AND username = ?`
        ).bind(restaurant.id, username).first();
    } else {
        user = await env.DB.prepare(
            `SELECT id, restaurant_id, username, password_hash, role, is_active
             FROM users WHERE role = 'SUPER_ADMIN' AND username = ?`
        ).bind(username).first();
    }

    if (!user) {
        await hashPassword(password); // موازنة زمنية لمنع تسريب معلومة عبر التوقيت
        return errorResponse("بيانات الدخول غير صحيحة", 401, "INVALID_CREDENTIALS");
    }
    if (!user.is_active) return errorResponse("هذا الحساب معطّل", 403, "ACCOUNT_DISABLED");

    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) return errorResponse("بيانات الدخول غير صحيحة", 401, "INVALID_CREDENTIALS");

    const sessionToken = await createSession(env, {
        userId: user.id, restaurantId: user.restaurant_id, role: user.role, username: user.username,
    });

    await writeAuditLog(env, {
        restaurantId: user.restaurant_id, userId: user.id, action: "LOGIN",
        entityType: "user", entityId: user.id, details: null,
    });

    return jsonResponse(
        { success: true, user: { id: user.id, username: user.username, role: user.role, restaurantId: user.restaurant_id } },
        200,
        { "Set-Cookie": buildSessionCookieHeader(sessionToken, SESSION_TTL) }
    );
}

// POST /api/auth/logout
export async function handleAuthLogout(request, env) {
    const cookies = parseCookies(request);
    const token = cookies[SESSION_COOKIE_NAME];

    if (token) {
        const session = await getSession(env, token);
        if (session) {
            await writeAuditLog(env, {
                restaurantId: session.restaurantId, userId: session.userId, action: "LOGOUT",
                entityType: "user", entityId: session.userId, details: null,
            });
        }
        await destroySession(env, token);
    }

    return jsonResponse({ success: true }, 200, { "Set-Cookie": buildClearCookieHeader() });
}
