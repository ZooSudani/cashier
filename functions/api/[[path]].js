// ============================================================================
// functions/api/[[path]].js
// كاشير (cashier) — Multi-Tenant Restaurant POS SaaS
// Cloudflare Pages Functions — Router رئيسي واحد
// ============================================================================
// هذا الملف هو نقطة الدخول الوحيدة الفعلية (Route) لكل مسارات /api/*.
// كل منطق المعالجة الفعلي منقول إلى functions/api/_lib/*.js — مجلد اسمه
// يبدأ بشرطة سفلية (_) فلا يتحول تلقائيًا لمسار API في Cloudflare Pages،
// وهذا يجعل تقسيم الكود ممكنًا مع بقاء [[path]].js نقطة الدخول الوحيدة.
//
// Bindings المتوقعة (env):
//   env.DB           -> Cloudflare D1
//   env.SETTINGS_KV   -> Cloudflare KV (موحّد: sessions / ratelimit / idempotency)
//   env.UPLOADS       -> Cloudflare R2 (صور إشعارات بنكك)
//
// خريطة الملفات:
//   _lib/utils.js              أدوات عامة: JSON، تجزئة كلمات المرور، توكنات
//   _lib/auth.js                جلسات، Rate Limiting، Idempotency، Auth Context
//   _lib/handlers.auth.js       POST /api/auth/setup, login, logout
//   _lib/handlers.menu.js       GET/POST /api/menu, PUT/PATCH /api/menu/:id
//   _lib/handlers.shift.js      /api/shift/*, GET /api/shifts (تقرير)
//   _lib/handlers.orders.js     POST /api/orders, GET /api/orders, /:id/items
//   _lib/handlers.upload.js     POST /api/upload, GET /api/files/:key
//   _lib/handlers.dashboard.js  GET /api/dashboard/today
//   _lib/handlers.admin.js      كل /api/admin/* (Super Admin)
// ============================================================================

import { errorResponse } from "./_lib/utils.js";
import { getAuthContext, requireAuth, requireRole, requireRestaurantContext } from "./_lib/auth.js";

import { handleAuthSetup, handleAuthLogin, handleAuthLogout } from "./_lib/handlers.auth.js";
import { handleMenuList, handleMenuCreate, handleMenuUpdate, handleMenuToggle } from "./_lib/handlers.menu.js";
import { handleShiftCurrent, handleShiftOpen, handleShiftClose, handleShiftsList } from "./_lib/handlers.shift.js";
import { handleOrderCreate, handleOrdersList, handleOrderItemsList } from "./_lib/handlers.orders.js";
import { handleUpload, handleFileGet } from "./_lib/handlers.upload.js";
import { handleDashboardToday } from "./_lib/handlers.dashboard.js";
import {
    handleAdminOverview, handleAdminRestaurantsList, handleAdminRestaurantCreate,
    handleAdminRestaurantUpdate, handleAdminRestaurantToggle,
    handleAdminRestaurantUsersList, handleAdminRestaurantUserCreate, handleAdminUserToggle,
} from "./_lib/handlers.admin.js";

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
        // ملاحظة تشخيصية مؤقتة: نُظهر تفاصيل الخطأ الفعلية في الاستجابة نفسها
        // لتسهيل التشخيص من الهاتف بدون الحاجة لأدوات CLI أو سجلات خارجية.
        // يجب إزالة هذا التفصيل (debug) قبل الإطلاق النهائي للإنتاج.
        return new Response(JSON.stringify({
            error: "حدث خطأ في الخادم",
            code: "INTERNAL_ERROR",
            debug: { message: err && err.message, stack: err && err.stack },
        }), { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
}
