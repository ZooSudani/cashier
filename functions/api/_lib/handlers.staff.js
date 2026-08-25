// ============================================================================
// functions/api/_lib/handlers.staff.js
// معالجات RESTAURANT_ADMIN لإدارة كاشيرية مطعمه فقط (وليس مديرين آخرين):
// GET /api/staff، POST /api/staff/:id/reset-password
// ============================================================================

import { jsonResponse, errorResponse, hashPassword } from "./utils.js";
import { writeAuditLog } from "./auth.js";

// GET /api/staff — قائمة الكاشيرية في مطعم المستخدم الحالي فقط
export async function handleStaffList(request, env, ctx) {
    const { results } = await env.DB.prepare(
        `SELECT id, username, is_active, created_at
         FROM users WHERE restaurant_id = ? AND role = 'CASHIER'
         ORDER BY created_at DESC`
    ).bind(ctx.restaurantId).all();

    return jsonResponse({ staff: results });
}

// POST /api/staff/:id/reset-password — إعادة تعيين كلمة مرور كاشير
// يتحقق أن المستخدم المستهدف كاشير فعلًا وينتمي لنفس مطعم المدير — لا يمكن
// لمدير مطعم تغيير كلمة مرور مدير آخر أو كاشير في مطعم آخر (منع IDOR).
export async function handleStaffResetPassword(request, env, ctx, userId) {
    let body;
    try { body = await request.json(); } catch { return errorResponse("بيانات غير صالحة", 400); }

    const { new_password } = body || {};
    if (!new_password || new_password.length < 8) {
        return errorResponse("كلمة المرور يجب ألا تقل عن 8 أحرف", 400);
    }

    const target = await env.DB.prepare(
        `SELECT id, role FROM users WHERE id = ? AND restaurant_id = ?`
    ).bind(userId, ctx.restaurantId).first();

    if (!target || target.role !== "CASHIER") {
        return errorResponse("الكاشير غير موجود", 404);
    }

    const passwordHash = await hashPassword(new_password);
    await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, userId).run();

    await writeAuditLog(env, {
        restaurantId: ctx.restaurantId, userId: ctx.userId, action: "USER_UPDATED",
        entityType: "user", entityId: userId, details: { password_reset: true },
    });

    return jsonResponse({ success: true });
}
