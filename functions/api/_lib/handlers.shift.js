// ============================================================================
// functions/api/_lib/handlers.shift.js
// معالجات: GET /api/shift/current, POST /api/shift/open, POST /api/shift/close
// ============================================================================

import { jsonResponse, errorResponse } from "./utils.js";
import { writeAuditLog } from "./auth.js";

// GET /api/shift/current — الوردية المفتوحة الحالية للكاشير الحالي
export async function handleShiftCurrent(request, env, ctx) {
    const shift = await env.DB.prepare(
        `SELECT id, opened_at, opening_balance, expected_cash, actual_cash, total_bankk, status
         FROM shifts WHERE restaurant_id = ? AND cashier_id = ? AND status = 'OPEN'
         ORDER BY opened_at DESC LIMIT 1`
    ).bind(ctx.restaurantId, ctx.userId).first();

    if (!shift) return jsonResponse({ shift: null });

    // حسابات حية لمبيعات الوردية حتى هذه اللحظة (بدون انتظار الإغلاق) —
    // تتيح للكاشير رؤية "المتوقع بالصندوق" في أي وقت، لا فقط عند الإغلاق.
    const liveSums = await env.DB.prepare(
        `SELECT
            COUNT(*) as order_count,
            COALESCE(SUM(cash_amount), 0)  as cash_so_far,
            COALESCE(SUM(bankk_amount), 0) as bankk_so_far
         FROM orders
         WHERE restaurant_id = ? AND shift_id = ? AND status = 'COMPLETED'`
    ).bind(ctx.restaurantId, shift.id).first();

    const orderCount = liveSums?.order_count ?? 0;
    const cashSoFar = liveSums?.cash_so_far ?? 0;
    const bankkSoFar = liveSums?.bankk_so_far ?? 0;

    return jsonResponse({
        shift: {
            ...shift,
            order_count: orderCount,
            cash_so_far: cashSoFar,
            bankk_so_far: bankkSoFar,
            expected_cash_now: shift.opening_balance + cashSoFar, // المتوقع بالصندوق الآن لو أُغلقت الوردية هذه اللحظة
        },
    });
}

// POST /api/shift/open
export async function handleShiftOpen(request, env, ctx) {
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
export async function handleShiftClose(request, env, ctx) {
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

// GET /api/shifts?status=OPEN|CLOSED&limit=50 — تقرير الورديات (RESTAURANT_ADMIN)
export async function handleShiftsList(request, env, ctx) {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status");
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
