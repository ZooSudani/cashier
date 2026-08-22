// ============================================================================
// app.js — كاشير (cashier)
// أدوات مشتركة تُستخدم عبر كل صفحات المشروع (index / cashier / dashboard / admin)
// Vanilla JS — بدون أي إطار عمل
// ============================================================================

/**
 * غلاف موحّد لطلبات API — يرسل الجلسة تلقائيًا عبر Cookie (credentials: 'include')
 * ويُرجع دائمًا { ok, status, data } بدل رمي استثناءات متفرقة، لتسهيل التعامل
 * الموحّد مع الأخطاء في كل الصفحات.
 */
async function apiRequest(path, options = {}) {
    const { method = "GET", body, headers = {}, isFormData = false } = options;

    const fetchOptions = {
        method,
        credentials: "include", // إرسال Cookie الجلسة (httpOnly) تلقائيًا
        headers: { ...headers },
    };

    if (body !== undefined) {
        if (isFormData) {
            fetchOptions.body = body; // FormData يضبط Content-Type تلقائيًا مع boundary
        } else {
            fetchOptions.headers["Content-Type"] = "application/json";
            fetchOptions.body = JSON.stringify(body);
        }
    }

    let response;
    try {
        response = await fetch(`/api${path}`, fetchOptions);
    } catch (networkErr) {
        // فشل شبكة (انقطاع اتصال) — يُترك للصفحة المستدعية قرار التعامل معه
        // (مثلًا: تفعيل وضع Offline لاحقًا في المرحلة 8)
        return { ok: false, status: 0, data: { error: "تعذّر الاتصال بالخادم", code: "NETWORK_ERROR" } };
    }

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    return { ok: response.ok, status: response.status, data };
}

/** توجيه المستخدم إلى الصفحة المناسبة حسب دوره بعد تسجيل الدخول */
function redirectByRole(role) {
    if (role === "SUPER_ADMIN") {
        window.location.href = "/admin.html";
    } else if (role === "RESTAURANT_ADMIN") {
        window.location.href = "/dashboard.html";
    } else if (role === "CASHIER") {
        window.location.href = "/cashier.html";
    } else {
        window.location.href = "/";
    }
}

/**
 * حارس صفحة: يتحقق من الدور المطلوب لعرض الصفحة الحالية عبر استدعاء خفيف
 * لأحد الـ Endpoints المحمية. إن فشل التحقق (غير مسجّل دخول أو دور غير مطابق)
 * يعيد التوجيه لصفحة الدخول. يُستخدم في بداية سكربت كل صفحة محمية
 * (cashier.js / dashboard.js / admin.js).
 */
async function guardPage(allowedCheckPath) {
    const result = await apiRequest(allowedCheckPath);
    if (result.status === 401) {
        window.location.href = "/";
        return false;
    }
    if (result.status === 403) {
        // مسجّل دخول لكن بدور لا يملك صلاحية هذه الصفحة تحديدًا
        window.location.href = "/";
        return false;
    }
    return true;
}

/** تنسيق مبلغ بالجنيه السوداني بفواصل الآلاف */
function formatSDG(amount) {
    const value = Number(amount) || 0;
    return value.toLocaleString("ar-SD", { maximumFractionDigits: 0 }) + " جنيه";
}

/** تنسيق وقت/تاريخ بتوقيت Africa/Khartoum لعرض بشري */
function formatKhartoumTime(isoString) {
    if (!isoString) return "—";
    try {
        return new Date(isoString).toLocaleString("ar-SD", {
            timeZone: "Africa/Khartoum",
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "2-digit",
        });
    } catch {
        return isoString;
    }
}

/** إظهار رسالة تنبيه (خطأ/نجاح) داخل عنصر alert موجود في الصفحة */
function showAlert(alertEl, message, type = "danger") {
    if (!alertEl) return;
    alertEl.textContent = message;
    alertEl.classList.remove("alert--danger", "alert--success");
    alertEl.classList.add(type === "success" ? "alert--success" : "alert--danger", "is-visible");
}

function hideAlert(alertEl) {
    if (!alertEl) return;
    alertEl.classList.remove("is-visible");
}

/** تفعيل/تعطيل حالة التحميل على زر (يعرض Spinner ويمنع الضغط المزدوج) */
function setButtonLoading(buttonEl, isLoading) {
    if (!buttonEl) return;
    buttonEl.classList.toggle("is-loading", isLoading);
    buttonEl.disabled = isLoading;
}
