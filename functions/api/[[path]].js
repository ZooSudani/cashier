// ============================================================================
// functions/api/[[path]].js
// كاشير (cashier) — Multi-Tenant Restaurant POS SaaS
// Cloudflare Pages Functions — Router رئيسي واحد
// ============================================================================
// Bindings المتوقعة (env):
//   env.DB           -> Cloudflare D1
//   env.SETTINGS_KV   -> Cloudflare KV (موحّد: sessions / ratelimit / idempotency)
//   env.UPLOADS       -> Cloudflare R2 (صور إشعارات بنكك)
//
// المرحلة 2 تشمل:
//   Authentication, Sessions, Rate Limiting, Tenant Isolation,
//   Menu API, Shift API, Orders API, Upload API, R2 Protected Files, Dashboard API
// ============================================================================

// ----------------------------------------------------------------------------
// إعدادات عامة
// ----------------------------------------------------------------------------
const SESSION_TTL_SECONDS   = 60 * 60 * 12; // 12 ساعة
const SESSION_COOKIE_NAME   = "cashier_session";
const PBKDF2_ITERATIONS     = 210000;
const PBKDF2_HASH           = "SHA-256";
const PBKDF2_KEY_LENGTH     = 32; // بايت

const MAX_UPLOAD_BYTES      = 5 * 1024 * 1024; // 5MB
const ALLOWED_UPLOAD_TYPES  = ["image/jpeg", "image/png", "image/webp", "image/heic"];

// ----------------------------------------------------------------------------
// أدوات استجابة JSON موحّدة
// ----------------------------------------------------------------------------
function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...extraHeaders,
        },
    });
}

function errorResponse(message, status = 400, code = null) {
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

async function hashPassword(plainPassword) {
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

async function verifyPassword(plainPassword, storedHash) {
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
// توليد معرّفات عشوائية آمنة
// ----------------------------------------------------------------------------
function generateSecureToken(byteLength = 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ----------------------------------------------------------------------------
// إدارة الجلسات عبر SETTINGS_KV — مفتاح: sessions:<token>
// ----------------------------------------------------------------------------
async function createSession(env, sessionData) {
    const token = generateSecureToken(32);
    await env.SETTINGS_KV.put(`sessions:${token}`, JSON.stringify(sessionData), {
        expirationTtl: SESSION_TTL_SECONDS,
    });
    return token;
}

async function getSession(env, token) {
    if (!token) return null;
    const raw = await env.SETTINGS_KV.get(`sessions:${token}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function destroySession(env, token) {
    if (!token) return;
    await env.SETTINGS_KV.delete(`sessions:${token}`);
}

function parseCookies(request) {
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

function buildSessionCookieHeader(token, maxAgeSeconds) {
    return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function buildClearCookieHeader() {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ----------------------------------------------------------------------------
// Rate Limiting عبر SETTINGS_KV — مفتاح: ratelimit:<scope>:<identifier>
// ----------------------------------------------------------------------------
async function checkRateLimit(env, scope, identifier, maxAttempts, windowSeconds) {
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

function getClientIdentifier(request) {
    return request.headers.get("CF-Connecting-IP") || "unknown";
}

// ----------------------------------------------------------------------------
// Idempotency-Key عبر SETTINGS_KV — مفتاح: idempotency:<restaurant_id>:<key>
// يمنع تكرار تسجيل نفس الطلب بسبب ضغط الزر مرتين أو إعادة إرسال الشبكة.
// نخزّن استجابة أول تنفيذ ناجح لمدة 24 ساعة، ونعيدها كما هي لأي طلب مكرر
// بنفس المفتاح خلال هذه المدة.
// ----------------------------------------------------------------------------
async function checkIdempotency(env, restaurantId, idempotencyKey) {
    if (!idempotencyKey) return null;
    const raw = await env.SETTINGS_KV.get(`idempotency:${restaurantId}:${idempotencyKey}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function storeIdempotencyResult(env, restaurantId, idempotencyKey, resultData) {
    if (!idempotencyKey) return;
    await env.SETTINGS_KV.put(
        `idempotency:${restaurantId}:${idempotencyKey}`,
        JSON.stringify(resultData),
        { expirationTtl: 60 * 60 * 24 } // 24 ساعة
    );
}

// ----------------------------------------------------------------------------
// السياق الأمني (Auth Context) — المصدر الوحيد الموثوق لـ restaurant_id/role
// ----------------------------------------------------------------------------
async function getAuthContext(request, env) {
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

function requireAuth(ctx) {
    return ctx !== null;
}

function requireRole(ctx, allowedRoles) {
    return ctx !== null && allowedRoles.includes(ctx.role);
}

// يفرض وجود restaurant_id في السياق (أي دور عدا SUPER_ADMIN بدون مطعم محدد)
function requireRestaurantContext(ctx) {
    return ctx !== null && ctx.restaurantId !== null && ctx.restaurantId !== undefined;
}

// ----------------------------------------------------------------------------
// سجل التدقيق (Audit Log)
// ----------------------------------------------------------------------------
async function writeAuditLog(env, { restaurantId, userId, action, entityType, entityId, details }) {
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

// ----------------------------------------------------------------------------
// توليد public_id للطلب: YYYYMMDD-XXXX (تسلسلي يومي لكل مطعم)
// ----------------------------------------------------------------------------
async function generateOrderPublicId(env, restaurantId) {
    // تاريخ اليوم بتوقيت Africa/Khartoum (UTC+2، بدون توقيت صيفي)
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");

    const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM orders
         WHERE restaurant_id = ? AND public_id LIKE ?`
    )
        .bind(restaurantId, `${datePart}-%`)
        .first();

    const nextSeq = (countRow?.cnt ?? 0) + 1;
    const seqPadded = String(nextSeq).padStart(4, "0");
    return `${datePart}-${seqPadded}`;
}

// ============================================================================
// معالجات المصادقة (Auth Handlers)
// ============================================================================

async function handleAuthSetup(request, env) {
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

async function handleAuthLogin(request, env) {
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
        { "Set-Cookie": buildSessionCookieHeader(sessionToken, SESSION_TTL_SECONDS) }
    );
}

async function handleAuthLogout(request, env) {
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

// ============================================================================
// Menu API
// ============================================================================

// GET /api/menu — يعرض المنيو الكامل للمطعم الحالي (من السياق فقط)
async function handleMenuList(request, env, ctx) {
    const { results } = await env.DB.prepare(
        `SELECT id, category, name, price, is_available, created_at
         FROM menu_items WHERE restaurant_id = ? ORDER BY category, name`
    ).bind(ctx.restaurantId).all();

    return jsonResponse({ items: results });
}

// POST /api/menu — إضافة صنف (RESTAURANT_ADMIN فقط)
async function handleMenuCreate(request, env, ctx) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { category, name, price } = body || {};
    if (!category || !name || typeof price !== "number" || price < 0) {
        return errorResponse("الحقول (category, name, price) مطلوبة وصحيحة", 400);
    }

    const result = await env.DB.prepare(
        `INSERT INTO menu_items (restaurant_id, category, name, price, is_available)
         VALUES (?, ?, ?, ?, 1)`
    ).bind(ctx.restaurantId, category, name, price).run();

    const newId = result.meta.last_row_id;
    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "MENU_CREATED",
        entityType: "menu_item", entityId: newId, details: { category, name, price },
    });

    return jsonResponse({ success: true, id: newId }, 201);
}

// PUT /api/menu/:id — تعديل صنف (RESTAURANT_ADMIN فقط)
async function handleMenuUpdate(request, env, ctx, itemId) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    // نتحقق أولًا أن الصنف يخص نفس مطعم المستخدم — منع IDOR
    const existing = await env.DB.prepare(
        `SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ?`
    ).bind(itemId, ctx.restaurantId).first();

    if (!existing) return errorResponse("الصنف غير موجود", 404);

    const fields = [];
    const values = [];

    if (typeof body.category === "string") { fields.push("category = ?"); values.push(body.category); }
    if (typeof body.name === "string") { fields.push("name = ?"); values.push(body.name); }
    if (typeof body.price === "number" && body.price >= 0) { fields.push("price = ?"); values.push(body.price); }
    if (typeof body.is_available === "boolean") { fields.push("is_available = ?"); values.push(body.is_available ? 1 : 0); }

    if (fields.length === 0) return errorResponse("لا توجد حقول للتحديث", 400);

    values.push(itemId, ctx.restaurantId);
    await env.DB.prepare(
        `UPDATE menu_items SET ${fields.join(", ")} WHERE id = ? AND restaurant_id = ?`
    ).bind(...values).run();

    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "MENU_UPDATED",
        entityType: "menu_item", entityId: itemId, details: body,
    });

    return jsonResponse({ success: true });
}

// PATCH /api/menu/:id/toggle — إيقاف/تفعيل صنف
async function handleMenuToggle(request, env, ctx, itemId) {
    const existing = await env.DB.prepare(
        `SELECT id, is_available FROM menu_items WHERE id = ? AND restaurant_id = ?`
    ).bind(itemId, ctx.restaurantId).first();

    if (!existing) return errorResponse("الصنف غير موجود", 404);

    const newAvailability = existing.is_available ? 0 : 1;
    await env.DB.prepare(
        `UPDATE menu_items SET is_available = ? WHERE id = ? AND restaurant_id = ?`
    ).bind(newAvailability, itemId, ctx.restaurantId).run();

    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId,
        action: newAvailability ? "MENU_UPDATED" : "MENU_DISABLED",
        entityType: "menu_item", entityId: itemId, details: { is_available: !!newAvailability },
    });

    return jsonResponse({ success: true, is_available: !!newAvailability });
}

// ============================================================================
// Shift API
// ============================================================================

// GET /api/shift/current — الوردية المفتوحة الحالية للكاشير الحالي
async function handleShiftCurrent(request, env, ctx) {
    const shift = await env.DB.prepare(
        `SELECT id, opened_at, opening_balance, expected_cash, actual_cash, total_bankk, status
         FROM shifts WHERE restaurant_id = ? AND cashier_id = ? AND status = 'OPEN'
         ORDER BY opened_at DESC LIMIT 1`
    ).bind(ctx.restaurantId, ctx.userId).first();

    return jsonResponse({ shift: shift || null });
}

// POST /api/shift/open
async function handleShiftOpen(request, env, ctx) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const openingBalance = typeof body.opening_balance === "number" ? body.opening_balance : 0;
    if (openingBalance < 0) return errorResponse("الرصيد الافتتاحي غير صالح", 400);

    // منع فتح أكثر من وردية واحدة مفتوحة لنفس الكاشير في نفس المطعم
    const alreadyOpen = await env.DB.prepare(
        `SELECT id FROM shifts WHERE restaurant_id = ? AND cashier_id = ? AND status = 'OPEN' LIMIT 1`
    ).bind(ctx.restaurantId, ctx.userId).first();

    if (alreadyOpen) return errorResponse("لديك وردية مفتوحة بالفعل", 409, "SHIFT_ALREADY_OPEN");

    const result = await env.DB.prepare(
        `INSERT INTO shifts (restaurant_id, cashier_id, opening_balance, status)
         VALUES (?, ?, ?, 'OPEN')`
    ).bind(ctx.restaurantId, ctx.userId, openingBalance).run();

    const shiftId = result.meta.last_row_id;
    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "SHIFT_OPEN",
        entityType: "shift", entityId: shiftId, details: { opening_balance: openingBalance },
    });

    return jsonResponse({ success: true, shiftId }, 201);
}

// POST /api/shift/close
async function handleShiftClose(request, env, ctx) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const actualCash = typeof body.actual_cash === "number" ? body.actual_cash : null;
    if (actualCash === null || actualCash < 0) return errorResponse("المبلغ الفعلي مطلوب", 400);

    const shift = await env.DB.prepare(
        `SELECT id, opening_balance FROM shifts
         WHERE restaurant_id = ? AND cashier_id = ? AND status = 'OPEN' LIMIT 1`
    ).bind(ctx.restaurantId, ctx.userId).first();

    if (!shift) return errorResponse("لا توجد وردية مفتوحة", 404, "NO_OPEN_SHIFT");

    // حساب المبيعات الفعلية من الطلبات المكتملة ضمن هذه الوردية
    const sums = await env.DB.prepare(
        `SELECT
            COALESCE(SUM(cash_amount), 0)  as total_cash,
            COALESCE(SUM(bankk_amount), 0) as total_bankk
         FROM orders
         WHERE restaurant_id = ? AND shift_id = ? AND status = 'COMPLETED'`
    ).bind(ctx.restaurantId, shift.id).first();

    const expectedCash = shift.opening_balance + (sums?.total_cash ?? 0);
    const totalBankk = sums?.total_bankk ?? 0;

    await env.DB.prepare(
        `UPDATE shifts
         SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             expected_cash = ?, actual_cash = ?, total_bankk = ?, status = 'CLOSED'
         WHERE id = ? AND restaurant_id = ?`
    ).bind(expectedCash, actualCash, totalBankk, shift.id, ctx.restaurantId).run();

    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "SHIFT_CLOSE",
        entityType: "shift", entityId: shift.id,
        details: { expected_cash: expectedCash, actual_cash: actualCash, difference: actualCash - expectedCash },
    });

    return jsonResponse({
        success: true,
        summary: {
            expected_cash: expectedCash,
            actual_cash: actualCash,
            difference: actualCash - expectedCash,
            total_bankk: totalBankk,
        },
    });
}

// ============================================================================
// Orders API
// ============================================================================

// POST /api/orders — إنشاء طلب جديد (Atomic قدر الإمكان + Idempotency)
async function handleOrderCreate(request, env, ctx) {
    const idempotencyKey = request.headers.get("Idempotency-Key");

    // 1) تحقق من التكرار أولًا
    if (idempotencyKey) {
        const cached = await checkIdempotency(env, ctx.restaurantId, idempotencyKey);
        if (cached) return jsonResponse(cached, 200);
    }

    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { order_type, table_number, payment_method, items, bankk_ref, receipt_key } = body || {};

    if (!["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(order_type)) {
        return errorResponse("نوع الطلب غير صالح", 400);
    }
    if (!["CASH", "BANKK"].includes(payment_method)) {
        return errorResponse("طريقة الدفع غير صالحة", 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
        return errorResponse("يجب أن يحتوي الطلب على صنف واحد على الأقل", 400);
    }
    if (payment_method === "BANKK" && !bankk_ref && !receipt_key) {
        return errorResponse("رقم العملية أو صورة الإشعار مطلوبة للدفع ببنكك", 400);
    }

    // الوردية المفتوحة الحالية إلزامية لإنشاء أي طلب
    const shift = await env.DB.prepare(
        `SELECT id FROM shifts WHERE restaurant_id = ? AND cashier_id = ? AND status = 'OPEN' LIMIT 1`
    ).bind(ctx.restaurantId, ctx.userId).first();

    if (!shift) return errorResponse("يجب فتح وردية أولًا", 409, "NO_OPEN_SHIFT");

    // إعادة حساب السعر والإجمالي من جانب الخادم فقط — لا نثق بأي سعر قادم
    // من Frontend، بل نجلب السعر الحالي من menu_items في نفس المطعم.
    const lineItems = [];
    let totalAmount = 0;

    for (const rawItem of items) {
        const { item_id, quantity, notes } = rawItem || {};
        const qty = parseInt(quantity, 10);
        if (!item_id || !Number.isInteger(qty) || qty <= 0) {
            return errorResponse("بيانات صنف غير صالحة في الطلب", 400);
        }

        const menuItem = await env.DB.prepare(
            `SELECT id, name, price, is_available FROM menu_items
             WHERE id = ? AND restaurant_id = ?`
        ).bind(item_id, ctx.restaurantId).first();

        if (!menuItem) return errorResponse(`الصنف رقم ${item_id} غير موجود`, 400);
        if (!menuItem.is_available) return errorResponse(`الصنف "${menuItem.name}" غير متوفر حاليًا`, 400);

        const subtotal = menuItem.price * qty;
        totalAmount += subtotal;

        lineItems.push({
            item_id: menuItem.id,
            item_name: menuItem.name,
            unit_price: menuItem.price,
            quantity: qty,
            subtotal,
            notes: notes || null,
        });
    }

    const cashAmount = payment_method === "CASH" ? totalAmount : 0;
    const bankkAmount = payment_method === "BANKK" ? totalAmount : 0;
    const publicId = await generateOrderPublicId(env, ctx.restaurantId);

    // إدخال الطلب وعناصره ضمن عملية ذرية واحدة فعليًا.
    // env.DB.batch() في D1 ينفّذ كل الاستعلامات ضمن معاملة (Transaction) واحدة:
    // إما تنجح كلها معًا أو تفشل كلها معًا. لذلك ندمج INSERT الطلب مع كل
    // INSERT لعناصره في نفس الاستدعاء بدل تنفيذهما على مرحلتين منفصلتين.
    // بما أن public_id فريد (UNIQUE)، تُستخدم كمرجع آمن لربط عناصر الطلب
    // بمعرّفه الحقيقي (id) داخل نفس المعاملة عبر subquery، بدل الاعتماد على
    // last_row_id من استدعاء run() منفصل قد لا يكتمل معه إدخال العناصر.
    let orderId;
    try {
        const insertOrderStmt = env.DB.prepare(
            `INSERT INTO orders
                (restaurant_id, shift_id, public_id, order_type, table_number,
                 payment_method, total_amount, cash_amount, bankk_amount,
                 receipt_key, bankk_ref, status, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`
        ).bind(
            ctx.restaurantId, shift.id, publicId, order_type, table_number || null,
            payment_method, totalAmount, cashAmount, bankkAmount,
            receipt_key || null, bankk_ref || null, idempotencyKey || null
        );

        const itemStatements = lineItems.map((li) =>
            env.DB.prepare(
                `INSERT INTO order_items (order_id, item_id, item_name, unit_price, quantity, subtotal, notes)
                 VALUES (
                    (SELECT id FROM orders WHERE public_id = ? AND restaurant_id = ?),
                    ?, ?, ?, ?, ?, ?
                 )`
            ).bind(publicId, ctx.restaurantId, li.item_id, li.item_name, li.unit_price, li.quantity, li.subtotal, li.notes)
        );

        // استدعاء batch واحد فقط: الطلب أولًا ثم كل عناصره — كوحدة ذرية كاملة
        await env.DB.batch([insertOrderStmt, ...itemStatements]);

        const createdOrder = await env.DB.prepare(
            `SELECT id FROM orders WHERE public_id = ? AND restaurant_id = ?`
        ).bind(publicId, ctx.restaurantId).first();

        orderId = createdOrder.id;
    } catch (err) {
        console.error("order_create_failed", err);
        // إذا كان الخطأ بسبب تكرار idempotency_key (سباق بين طلبين متزامنين
        // بنفس المفتاح)، نُرجع النتيجة المخزّنة إن وُجدت بدل رمي خطأ عام.
        if (idempotencyKey) {
            const cached = await checkIdempotency(env, ctx.restaurantId, idempotencyKey);
            if (cached) return jsonResponse(cached, 200);
        }
        return errorResponse("فشل إنشاء الطلب، حاول مرة أخرى", 500);
    }

    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "ORDER_CREATED",
        entityType: "order", entityId: orderId,
        details: { public_id: publicId, total_amount: totalAmount, payment_method },
    });

    const responsePayload = {
        success: true,
        order: {
            id: orderId,
            public_id: publicId,
            order_type,
            table_number: table_number || null,
            payment_method,
            total_amount: totalAmount,
            items: lineItems,
            created_at: new Date().toISOString(),
        },
    };

    if (idempotencyKey) {
        await storeIdempotencyResult(env, ctx.restaurantId, idempotencyKey, responsePayload);
    }

    return jsonResponse(responsePayload, 201);
}

// ============================================================================
// Upload API — رفع صور إشعارات بنكك إلى R2 (خاص/غير عام)
// ============================================================================

// POST /api/upload
async function handleUpload(request, env, ctx) {
    const rateLimit = await checkRateLimit(env, "upload", `${ctx.restaurantId}:${ctx.userId}`, 30, 3600);
    if (!rateLimit.allowed) return errorResponse("محاولات رفع كثيرة جدًا", 429, "RATE_LIMITED");

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
        return errorResponse("يجب إرسال الملف بصيغة multipart/form-data", 400);
    }

    let formData;
    try { formData = await request.formData(); } catch { return errorResponse("بيانات رفع غير صالحة", 400); }

    const file = formData.get("file");
    if (!file || typeof file === "string") return errorResponse("الملف مطلوب", 400);

    if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
        return errorResponse("نوع الملف غير مسموح — الأنواع المسموحة: صور فقط", 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return errorResponse("حجم الملف يتجاوز الحد المسموح (5 ميجابايت)", 400);
    }

    // اسم آمن وعشوائي — لا نستخدم اسم الملف الأصلي إطلاقًا
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const randomName = generateSecureToken(24);
    const objectKey = `receipts/${ctx.restaurantId}/${randomName}.${extension}`;

    const fileBuffer = await file.arrayBuffer();
    await env.UPLOADS.put(objectKey, fileBuffer, {
        httpMetadata: { contentType: file.type },
        customMetadata: { restaurantId: String(ctx.restaurantId), uploadedBy: String(ctx.userId) },
    });

    // لا نُنشئ Public URL إطلاقًا — نُعيد فقط المفتاح الداخلي (receipt_key)
    return jsonResponse({ success: true, receipt_key: objectKey }, 201);
}

// GET /api/files/:key — إرجاع صورة إشعار بنكك لمستخدم مصرّح له فقط
async function handleFileGet(request, env, ctx, fileKey) {
    // decode لأن المفتاح يحتوي على / وقد يصل مُرمّزًا في الـ URL
    const decodedKey = decodeURIComponent(fileKey);

    // التحقق الصارم: يجب أن يبدأ المفتاح بمسار مطعم المستخدم الحالي بالضبط
    const expectedPrefix = `receipts/${ctx.restaurantId}/`;
    if (!decodedKey.startsWith(expectedPrefix)) {
        // منع IDOR: أي محاولة الوصول لملف مطعم آخر تُرفض بدون كشف أي تفاصيل
        return errorResponse("الملف غير موجود", 404);
    }

    const object = await env.UPLOADS.get(decodedKey);
    if (!object) return errorResponse("الملف غير موجود", 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, max-age=3600");
    // لا Content-Disposition مفتوح للعامة — الوصول محصور بالجلسة فقط عبر هذا الـ Endpoint

    return new Response(object.body, { headers });
}

// ============================================================================
// Shifts Report API (RESTAURANT_ADMIN)
// ============================================================================

// GET /api/shifts?status=OPEN|CLOSED&limit=50
async function handleShiftsList(request, env, ctx) {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status"); // اختياري: OPEN أو CLOSED
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 50, 200);

    let query = `
        SELECT
            s.id, s.opened_at, s.closed_at, s.opening_balance,
            s.expected_cash, s.actual_cash, s.total_bankk, s.status,
            u.username as cashier_username
        FROM shifts s
        JOIN users u ON u.id = s.cashier_id
        WHERE s.restaurant_id = ?
    `;
    const bindings = [ctx.restaurantId];

    if (statusFilter === "OPEN" || statusFilter === "CLOSED") {
        query += ` AND s.status = ?`;
        bindings.push(statusFilter);
    }

    query += ` ORDER BY s.opened_at DESC LIMIT ?`;
    bindings.push(limit);

    const { results } = await env.DB.prepare(query).bind(...bindings).all();

    const shifts = results.map((s) => ({
        id: s.id,
        cashier_username: s.cashier_username,
        opened_at: s.opened_at,
        closed_at: s.closed_at,
        opening_balance: s.opening_balance,
        expected_cash: s.expected_cash,
        actual_cash: s.actual_cash,
        difference: s.status === "CLOSED" ? (s.actual_cash - s.expected_cash) : null,
        total_bankk: s.total_bankk,
        status: s.status,
    }));

    return jsonResponse({ shifts });
}

// ============================================================================
// Orders List API (RESTAURANT_ADMIN) — لتدقيق بنكك ومراجعة الطلبات
// ============================================================================

// GET /api/orders?payment_method=BANKK&date=YYYY-MM-DD&limit=50
async function handleOrdersList(request, env, ctx) {
    const url = new URL(request.url);
    const paymentMethodFilter = url.searchParams.get("payment_method"); // CASH | BANKK
    const dateFilter = url.searchParams.get("date"); // YYYY-MM-DD
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 50, 200);

    let query = `
        SELECT
            o.id, o.public_id, o.order_type, o.table_number, o.payment_method,
            o.total_amount, o.cash_amount, o.bankk_amount, o.receipt_key,
            o.bankk_ref, o.status, o.created_at,
            u.username as cashier_username
        FROM orders o
        JOIN shifts s ON s.id = o.shift_id
        JOIN users u ON u.id = s.cashier_id
        WHERE o.restaurant_id = ?
    `;
    const bindings = [ctx.restaurantId];

    if (paymentMethodFilter === "CASH" || paymentMethodFilter === "BANKK") {
        query += ` AND o.payment_method = ?`;
        bindings.push(paymentMethodFilter);
    }
    if (dateFilter && /^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
        query += ` AND substr(o.created_at, 1, 10) = ?`;
        bindings.push(dateFilter);
    }

    query += ` ORDER BY o.created_at DESC LIMIT ?`;
    bindings.push(limit);

    const { results } = await env.DB.prepare(query).bind(...bindings).all();

    return jsonResponse({ orders: results });
}

// GET /api/orders/:id/items — عناصر طلب محدد (لعرض التفاصيل عند الحاجة)
async function handleOrderItemsList(request, env, ctx, orderId) {
    // تحقق أولًا أن الطلب يخص نفس مطعم المستخدم — منع IDOR
    const order = await env.DB.prepare(
        `SELECT id FROM orders WHERE id = ? AND restaurant_id = ?`
    ).bind(orderId, ctx.restaurantId).first();

    if (!order) return errorResponse("الطلب غير موجود", 404);

    const { results } = await env.DB.prepare(
        `SELECT item_name, unit_price, quantity, subtotal, notes
         FROM order_items WHERE order_id = ?`
    ).bind(orderId).all();

    return jsonResponse({ items: results });
}

// ============================================================================
// Super Admin API — إدارة المطاعم والاشتراكات (SUPER_ADMIN فقط)
// ============================================================================

// GET /api/admin/overview — إحصائيات عامة عن المنصة
async function handleAdminOverview(request, env, ctx) {
    const counts = await env.DB.prepare(
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_count,
            SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as disabled_count
         FROM restaurants`
    ).first();

    return jsonResponse({
        total_restaurants: counts?.total ?? 0,
        active_restaurants: counts?.active_count ?? 0,
        disabled_restaurants: counts?.disabled_count ?? 0,
    });
}

// GET /api/admin/restaurants — قائمة كل المطاعم
async function handleAdminRestaurantsList(request, env, ctx) {
    const { results } = await env.DB.prepare(
        `SELECT id, name, slug, phone, subscription_plan, is_active, created_at
         FROM restaurants ORDER BY created_at DESC`
    ).all();

    return jsonResponse({ restaurants: results });
}

// POST /api/admin/restaurants — إنشاء مطعم جديد + أول حساب RESTAURANT_ADMIN له
async function handleAdminRestaurantCreate(request, env, ctx) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { name, slug, phone, subscription_plan, admin_username, admin_password } = body || {};

    if (!name || !slug) return errorResponse("اسم المطعم والمعرّف (slug) مطلوبان", 400);
    if (!/^[a-z0-9\u0600-\u06FF-]+$/i.test(slug)) {
        return errorResponse("المعرّف (slug) يجب أن يحتوي أحرفًا وأرقامًا وشرطات فقط", 400);
    }
    const plan = ["FREE", "BASIC", "PRO", "ENTERPRISE"].includes(subscription_plan) ? subscription_plan : "FREE";

    if (!admin_username || !admin_password) {
        return errorResponse("بيانات مدير المطعم الأول (اسم المستخدم وكلمة المرور) مطلوبة", 400);
    }
    if (admin_password.length < 8) return errorResponse("كلمة مرور مدير المطعم يجب ألا تقل عن 8 أحرف", 400);

    const existingSlug = await env.DB.prepare(`SELECT id FROM restaurants WHERE slug = ?`).bind(slug).first();
    if (existingSlug) return errorResponse("هذا المعرّف (slug) مستخدم بالفعل", 409, "SLUG_TAKEN");

    let restaurantId;
    try {
        const restaurantResult = await env.DB.prepare(
            `INSERT INTO restaurants (name, slug, phone, subscription_plan, is_active)
             VALUES (?, ?, ?, ?, 1)`
        ).bind(name, slug, phone || null, plan).run();

        restaurantId = restaurantResult.meta.last_row_id;

        const passwordHash = await hashPassword(admin_password);
        await env.DB.prepare(
            `INSERT INTO users (restaurant_id, username, password_hash, role, is_active)
             VALUES (?, ?, ?, 'RESTAURANT_ADMIN', 1)`
        ).bind(restaurantId, admin_username, passwordHash).run();
    } catch (err) {
        console.error("admin_restaurant_create_failed", err);
        return errorResponse("فشل إنشاء المطعم، تحقق من البيانات وحاول مجددًا", 500);
    }

    await writeAuditLog(env, {
        restaurantId: null, userId: ctx.userId, action: "RESTAURANT_CREATED",
        entityType: "restaurant", entityId: restaurantId, details: { name, slug, plan },
    });

    return jsonResponse({ success: true, restaurantId }, 201);
}

// PUT /api/admin/restaurants/:id — تعديل بيانات مطعم (اسم/هاتف/خطة)
async function handleAdminRestaurantUpdate(request, env, ctx, restaurantId) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const existing = await env.DB.prepare(`SELECT id FROM restaurants WHERE id = ?`).bind(restaurantId).first();
    if (!existing) return errorResponse("المطعم غير موجود", 404);

    const fields = [];
    const values = [];

    if (typeof body.name === "string" && body.name.trim()) { fields.push("name = ?"); values.push(body.name.trim()); }
    if (typeof body.phone === "string") { fields.push("phone = ?"); values.push(body.phone || null); }
    if (typeof body.bank_account_info === "string") { fields.push("bank_account_info = ?"); values.push(body.bank_account_info || null); }
    if (["FREE", "BASIC", "PRO", "ENTERPRISE"].includes(body.subscription_plan)) {
        fields.push("subscription_plan = ?"); values.push(body.subscription_plan);
    }

    if (fields.length === 0) return errorResponse("لا توجد حقول للتحديث", 400);

    values.push(restaurantId);
    await env.DB.prepare(`UPDATE restaurants SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();

    await writeAuditLog(env, {
        restaurantId: null, userId: ctx.userId, action: "RESTAURANT_UPDATED",
        entityType: "restaurant", entityId: restaurantId, details: body,
    });

    return jsonResponse({ success: true });
}

// PATCH /api/admin/restaurants/:id/toggle — تفعيل/تعطيل مطعم
async function handleAdminRestaurantToggle(request, env, ctx, restaurantId) {
    const existing = await env.DB.prepare(
        `SELECT id, is_active FROM restaurants WHERE id = ?`
    ).bind(restaurantId).first();

    if (!existing) return errorResponse("المطعم غير موجود", 404);

    const newActive = existing.is_active ? 0 : 1;
    await env.DB.prepare(`UPDATE restaurants SET is_active = ? WHERE id = ?`).bind(newActive, restaurantId).run();

    await writeAuditLog(env, {
        restaurantId: null, userId: ctx.userId,
        action: newActive ? "RESTAURANT_ENABLED" : "RESTAURANT_DISABLED",
        entityType: "restaurant", entityId: restaurantId, details: null,
    });

    return jsonResponse({ success: true, is_active: !!newActive });
}

// GET /api/admin/restaurants/:id/users — قائمة مستخدمي مطعم محدد
async function handleAdminRestaurantUsersList(request, env, ctx, restaurantId) {
    const restaurant = await env.DB.prepare(`SELECT id FROM restaurants WHERE id = ?`).bind(restaurantId).first();
    if (!restaurant) return errorResponse("المطعم غير موجود", 404);

    const { results } = await env.DB.prepare(
        `SELECT id, username, role, is_active, created_at
         FROM users WHERE restaurant_id = ? ORDER BY created_at DESC`
    ).bind(restaurantId).all();

    return jsonResponse({ users: results });
}

// POST /api/admin/restaurants/:id/users — إنشاء مستخدم جديد (كاشير أو أدمن مطعم)
async function handleAdminRestaurantUserCreate(request, env, ctx, restaurantId) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { username, password, role } = body || {};

    const restaurant = await env.DB.prepare(`SELECT id FROM restaurants WHERE id = ?`).bind(restaurantId).first();
    if (!restaurant) return errorResponse("المطعم غير موجود", 404);

    if (!username || !password) return errorResponse("اسم المستخدم وكلمة المرور مطلوبان", 400);
    if (password.length < 8) return errorResponse("كلمة المرور يجب ألا تقل عن 8 أحرف", 400);
    if (!["RESTAURANT_ADMIN", "CASHIER"].includes(role)) return errorResponse("الدور غير صالح", 400);

    const existingUsername = await env.DB.prepare(
        `SELECT id FROM users WHERE restaurant_id = ? AND username = ?`
    ).bind(restaurantId, username).first();
    if (existingUsername) return errorResponse("اسم المستخدم مستخدم بالفعل في هذا المطعم", 409, "USERNAME_TAKEN");

    const passwordHash = await hashPassword(password);
    const result = await env.DB.prepare(
        `INSERT INTO users (restaurant_id, username, password_hash, role, is_active)
         VALUES (?, ?, ?, ?, 1)`
    ).bind(restaurantId, username, passwordHash, role).run();

    const newUserId = result.meta.last_row_id;
    await writeAuditLog(env, {
        restaurantId, userId: ctx.userId, action: "USER_CREATED",
        entityType: "user", entityId: newUserId, details: { username, role },
    });

    return jsonResponse({ success: true, userId: newUserId }, 201);
}

// PATCH /api/admin/users/:id/toggle — تفعيل/تعطيل مستخدم
async function handleAdminUserToggle(request, env, ctx, userId) {
    const existing = await env.DB.prepare(
        `SELECT id, restaurant_id, is_active, role FROM users WHERE id = ?`
    ).bind(userId).first();

    if (!existing) return errorResponse("المستخدم غير موجود", 404);
    if (existing.role === "SUPER_ADMIN") return errorResponse("لا يمكن تعطيل حساب مدير المنصة", 403);

    const newActive = existing.is_active ? 0 : 1;
    await env.DB.prepare(`UPDATE users SET is_active = ? WHERE id = ?`).bind(newActive, userId).run();

    await writeAuditLog(env, {
        restaurantId: existing.restaurant_id, userId: ctx.userId,
        action: newActive ? "USER_UPDATED" : "USER_DISABLED",
        entityType: "user", entityId: userId, details: { is_active: !!newActive },
    });

    return jsonResponse({ success: true, is_active: !!newActive });
}

// ============================================================================
// Dashboard API
// ============================================================================

// GET /api/dashboard/today
async function handleDashboardToday(request, env, ctx) {
    // نطاق اليوم بتوقيت Africa/Khartoum (UTC+2)
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    const stats = await env.DB.prepare(
        `SELECT
            COUNT(*) as order_count,
            COALESCE(SUM(total_amount), 0) as total_sales,
            COALESCE(SUM(cash_amount), 0)  as total_cash,
            COALESCE(SUM(bankk_amount), 0) as total_bankk
         FROM orders
         WHERE restaurant_id = ?
           AND status = 'COMPLETED'
           AND substr(created_at, 1, 10) = ?`
    ).bind(ctx.restaurantId, todayStr).first();

    return jsonResponse({
        date: todayStr,
        order_count: stats?.order_count ?? 0,
        total_sales: stats?.total_sales ?? 0,
        total_cash: stats?.total_cash ?? 0,
        total_bankk: stats?.total_bankk ?? 0,
    });
}

// ============================================================================
// Router رئيسي
// ============================================================================
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
        // ---------------- Auth (بدون تسجيل دخول) ----------------
        if (path === "/api/auth/setup" && method === "POST") return await handleAuthSetup(request, env);
        if (path === "/api/auth/login" && method === "POST") return await handleAuthLogin(request, env);
        if (path === "/api/auth/logout" && method === "POST") return await handleAuthLogout(request, env);

        // ---------------- من هنا فصاعدًا: تسجيل الدخول إلزامي ----------------
        const ctx = await getAuthContext(request, env);
        if (!requireAuth(ctx)) {
            return errorResponse("يجب تسجيل الدخول", 401, "UNAUTHENTICATED");
        }

        // ---------------- Menu ----------------
        if (path === "/api/menu" && method === "GET") {
            if (!requireRestaurantContext(ctx)) return errorResponse("غير مصرح", 403);
            return await handleMenuList(request, env, ctx);
        }
        if (path === "/api/menu" && method === "POST") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleMenuCreate(request, env, ctx);
        }
        const menuUpdateMatch = path.match(/^\/api\/menu\/(\d+)$/);
        if (menuUpdateMatch && method === "PUT") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleMenuUpdate(request, env, ctx, parseInt(menuUpdateMatch[1], 10));
        }
        const menuToggleMatch = path.match(/^\/api\/menu\/(\d+)\/toggle$/);
        if (menuToggleMatch && method === "PATCH") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleMenuToggle(request, env, ctx, parseInt(menuToggleMatch[1], 10));
        }

        // ---------------- Shift ----------------
        if (path === "/api/shift/current" && method === "GET") {
            if (!requireRole(ctx, ["CASHIER"])) return errorResponse("غير مصرح", 403);
            return await handleShiftCurrent(request, env, ctx);
        }
        if (path === "/api/shift/open" && method === "POST") {
            if (!requireRole(ctx, ["CASHIER"])) return errorResponse("غير مصرح", 403);
            return await handleShiftOpen(request, env, ctx);
        }
        if (path === "/api/shift/close" && method === "POST") {
            if (!requireRole(ctx, ["CASHIER"])) return errorResponse("غير مصرح", 403);
            return await handleShiftClose(request, env, ctx);
        }

        // ---------------- Orders ----------------
        if (path === "/api/orders" && method === "POST") {
            if (!requireRole(ctx, ["CASHIER"])) return errorResponse("غير مصرح", 403);
            return await handleOrderCreate(request, env, ctx);
        }

        // ---------------- Upload / Files ----------------
        if (path === "/api/upload" && method === "POST") {
            if (!requireRestaurantContext(ctx)) return errorResponse("غير مصرح", 403);
            return await handleUpload(request, env, ctx);
        }
        const fileMatch = path.match(/^\/api\/files\/(.+)$/);
        if (fileMatch && method === "GET") {
            if (!requireRestaurantContext(ctx)) return errorResponse("غير مصرح", 403);
            return await handleFileGet(request, env, ctx, fileMatch[1]);
        }

        // ---------------- Super Admin ----------------
        if (path === "/api/admin/overview" && method === "GET") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminOverview(request, env, ctx);
        }
        if (path === "/api/admin/restaurants" && method === "GET") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantsList(request, env, ctx);
        }
        if (path === "/api/admin/restaurants" && method === "POST") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantCreate(request, env, ctx);
        }
        const adminRestaurantUpdateMatch = path.match(/^\/api\/admin\/restaurants\/(\d+)$/);
        if (adminRestaurantUpdateMatch && method === "PUT") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantUpdate(request, env, ctx, parseInt(adminRestaurantUpdateMatch[1], 10));
        }
        const adminRestaurantToggleMatch = path.match(/^\/api\/admin\/restaurants\/(\d+)\/toggle$/);
        if (adminRestaurantToggleMatch && method === "PATCH") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantToggle(request, env, ctx, parseInt(adminRestaurantToggleMatch[1], 10));
        }
        const adminRestaurantUsersMatch = path.match(/^\/api\/admin\/restaurants\/(\d+)\/users$/);
        if (adminRestaurantUsersMatch && method === "GET") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantUsersList(request, env, ctx, parseInt(adminRestaurantUsersMatch[1], 10));
        }
        if (adminRestaurantUsersMatch && method === "POST") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminRestaurantUserCreate(request, env, ctx, parseInt(adminRestaurantUsersMatch[1], 10));
        }
        const adminUserToggleMatch = path.match(/^\/api\/admin\/users\/(\d+)\/toggle$/);
        if (adminUserToggleMatch && method === "PATCH") {
            if (!requireRole(ctx, ["SUPER_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleAdminUserToggle(request, env, ctx, parseInt(adminUserToggleMatch[1], 10));
        }

        // ---------------- Dashboard ----------------
        if (path === "/api/dashboard/today" && method === "GET") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleDashboardToday(request, env, ctx);
        }

        // ---------------- Shifts Report ----------------
        if (path === "/api/shifts" && method === "GET") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleShiftsList(request, env, ctx);
        }

        // ---------------- Orders List / Items (تدقيق بنكك) ----------------
        if (path === "/api/orders" && method === "GET") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleOrdersList(request, env, ctx);
        }
        const orderItemsMatch = path.match(/^\/api\/orders\/(\d+)\/items$/);
        if (orderItemsMatch && method === "GET") {
            if (!requireRole(ctx, ["RESTAURANT_ADMIN"])) return errorResponse("غير مصرح", 403);
            return await handleOrderItemsList(request, env, ctx, parseInt(orderItemsMatch[1], 10));
        }

        return errorResponse("المسار غير موجود", 404, "NOT_FOUND");
    } catch (err) {
        console.error("unhandled_api_error", err);
        return errorResponse("حدث خطأ في الخادم", 500, "INTERNAL_ERROR");
    }
}
