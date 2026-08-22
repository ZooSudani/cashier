// ============================================================================
// functions/api/_lib/handlers.orders.js
// معالجات: POST /api/orders، GET /api/orders (قائمة للتدقيق)، GET /api/orders/:id/items
// ============================================================================

import { jsonResponse, errorResponse } from "./utils.js";
import { checkIdempotency, storeIdempotencyResult, writeAuditLog } from "./auth.js";

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

// POST /api/orders — إنشاء طلب جديد (Atomic كاملًا + Idempotency)
export async function handleOrderCreate(request, env, ctx) {
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

    // إدخال الطلب وعناصره ضمن عملية ذرية واحدة فعليًا عبر env.DB.batch():
    // إما تنجح كلها معًا أو تفشل كلها معًا. public_id (فريد) يُستخدم كمرجع
    // آمن لربط عناصر الطلب بمعرّفه الحقيقي داخل نفس المعاملة.
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

        await env.DB.batch([insertOrderStmt, ...itemStatements]);

        const createdOrder = await env.DB.prepare(
            `SELECT id FROM orders WHERE public_id = ? AND restaurant_id = ?`
        ).bind(publicId, ctx.restaurantId).first();

        orderId = createdOrder.id;
    } catch (err) {
        console.error("order_create_failed", err);
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

// GET /api/orders?payment_method=BANKK&date=YYYY-MM-DD&limit=50 — لتدقيق بنكك (RESTAURANT_ADMIN)
export async function handleOrdersList(request, env, ctx) {
    const url = new URL(request.url);
    const paymentMethodFilter = url.searchParams.get("payment_method");
    const dateFilter = url.searchParams.get("date");
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

// GET /api/orders/:id/items — عناصر طلب محدد
export async function handleOrderItemsList(request, env, ctx, orderId) {
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
