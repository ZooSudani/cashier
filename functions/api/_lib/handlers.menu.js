// ============================================================================
// functions/api/_lib/handlers.menu.js
// معالجات: GET/POST /api/menu, PUT /api/menu/:id, PATCH /api/menu/:id/toggle
// ============================================================================

import { jsonResponse, errorResponse } from "./utils.js";
import { writeAuditLog } from "./auth.js";

// GET /api/menu — يعرض المنيو الكامل للمطعم الحالي (من السياق فقط)
export async function handleMenuList(request, env, ctx) {
    const { results } = await env.DB.prepare(
        `SELECT id, category, name, price, is_available, created_at
         FROM menu_items WHERE restaurant_id = ? ORDER BY category, name`
    ).bind(ctx.restaurantId).all();

    return jsonResponse({ items: results });
}

// POST /api/menu — إضافة صنف (RESTAURANT_ADMIN فقط)
export async function handleMenuCreate(request, env, ctx) {
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
export async function handleMenuUpdate(request, env, ctx, itemId) {
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
export async function handleMenuToggle(request, env, ctx, itemId) {
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
