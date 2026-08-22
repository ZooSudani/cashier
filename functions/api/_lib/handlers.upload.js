// ============================================================================
// functions/api/_lib/handlers.upload.js
// معالجات: POST /api/upload، GET /api/files/:key
// R2 خاص بالكامل — لا Public URL إطلاقًا
// ============================================================================

import { jsonResponse, errorResponse, generateSecureToken } from "./utils.js";
import { checkRateLimit } from "./auth.js";

const MAX_UPLOAD_BYTES     = 5 * 1024 * 1024; // 5MB
const ALLOWED_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

// POST /api/upload
export async function handleUpload(request, env, ctx) {
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
export async function handleFileGet(request, env, ctx, fileKey) {
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
