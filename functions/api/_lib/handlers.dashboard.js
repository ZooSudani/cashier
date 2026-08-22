// ============================================================================
// functions/api/_lib/handlers.dashboard.js
// معالجات: GET /api/dashboard/today (RESTAURANT_ADMIN)
// ============================================================================

import { jsonResponse } from "./utils.js";

// GET /api/dashboard/today
export async function handleDashboardToday(request, env, ctx) {
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
