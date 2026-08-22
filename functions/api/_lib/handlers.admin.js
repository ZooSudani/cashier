// ============================================================================
// functions/api/_lib/handlers.admin.js
// معالجات SUPER_ADMIN: إدارة المطاعم والاشتراكات والمستخدمين
// ============================================================================

import { jsonResponse, errorResponse, hashPassword } from "./utils.js";
import { writeAuditLog } from "./auth.js";

// GET /api/admin/overview — إحصائيات عامة عن المنصة
export async function handleAdminOverview(request, env, ctx) {
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
export async function handleAdminRestaurantsList(request, env, ctx) {
    const { results } = await env.DB.prepare(
        `SELECT id, name, slug, phone, subscription_plan, is_active, created_at
         FROM restaurants ORDER BY created_at DESC`
    ).all();

    return jsonResponse({ restaurants: results });
}

// POST /api/admin/restaurants — إنشاء مطعم جديد + أول حساب RESTAURANT_ADMIN له
export async function handleAdminRestaurantCreate(request, env, ctx) {
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
export async function handleAdminRestaurantUpdate(request, env, ctx, restaurantId) {
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
export async function handleAdminRestaurantToggle(request, env, ctx, restaurantId) {
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
export async function handleAdminRestaurantUsersList(request, env, ctx, restaurantId) {
    const restaurant = await env.DB.prepare(`SELECT id FROM restaurants WHERE id = ?`).bind(restaurantId).first();
    if (!restaurant) return errorResponse("المطعم غير موجود", 404);

    const { results } = await env.DB.prepare(
        `SELECT id, username, role, is_active, created_at
         FROM users WHERE restaurant_id = ? ORDER BY created_at DESC`
    ).bind(restaurantId).all();

    return jsonResponse({ users: results });
}

// POST /api/admin/restaurants/:id/users — إنشاء مستخدم جديد (كاشير أو أدمن مطعم)
export async function handleAdminRestaurantUserCreate(request, env, ctx, restaurantId) {
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
export async function handleAdminUserToggle(request, env, ctx, userId) {
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
