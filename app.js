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

// ============================================================================
// طابور الطلبات غير المتصلة (Offline Orders Queue) — IndexedDB
// ============================================================================
// المرحلة 8: عند انقطاع الإنترنت أثناء البيع، يُحفظ الطلب محليًا هنا بدل أن
// يفشل، ثم يُعاد إرساله تلقائيًا عند عودة الاتصال — مستفيدين من نفس
// Idempotency-Key المُستخدم في الوضع المتصل لمنع تكرار الطلب عند المزامنة.
//
// ⚠️ حد مهم يجب معرفته: الطلب غير المتصل يُنسب في قاعدة البيانات للوردية
// المفتوحة *وقت المزامنة الفعلية* (لأن الخادم يحدد الوردية من الجلسة تلقائيًا
// عند استلام الطلب)، وليس وقت البيع الفعلي أثناء الانقطاع. لذلك يجب أن تبقى
// الوردية مفتوحة حتى تكتمل المزامنة لضمان دقة حسابات الصندوق.
// ============================================================================

const OFFLINE_DB_NAME = "cashier_offline_db";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE_NAME = "pending_orders";

function openOfflineDB() {
    return new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
            reject(new Error("IndexedDB غير مدعوم في هذا المتصفح"));
            return;
        }
        const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
                db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "idempotencyKey" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** إضافة طلب لطابور الانتظار غير المتصل */
async function queueOfflineOrder(orderPayload, idempotencyKey) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readwrite");
        tx.objectStore(OFFLINE_STORE_NAME).put({
            idempotencyKey,
            payload: orderPayload,
            queuedAt: new Date().toISOString(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** جلب كل الطلبات المحفوظة بانتظار الإرسال */
async function getQueuedOrders() {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readonly");
        const request = tx.objectStore(OFFLINE_STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/** عدد الطلبات المنتظرة (لعرض شارة سريعة بدون تحميل كل البيانات) */
async function countQueuedOrders() {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readonly");
        const request = tx.objectStore(OFFLINE_STORE_NAME).count();
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => reject(request.error);
    });
}

/** حذف طلب من الطابور بعد نجاح إرساله للخادم */
async function removeQueuedOrder(idempotencyKey) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readwrite");
        tx.objectStore(OFFLINE_STORE_NAME).delete(idempotencyKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * محاولة مزامنة كل الطلبات المحفوظة محليًا مع الخادم — يُستدعى عند عودة
 * الاتصال (حدث "online")، وعند تحميل الصفحة، وعبر زر مزامنة يدوي.
 * يُرجع { synced: عدد الناجح, failed: عدد المتبقي, total }.
 */
async function syncQueuedOrders() {
    let queued;
    try {
        queued = await getQueuedOrders();
    } catch {
        return { synced: 0, failed: 0, total: 0 };
    }

    let synced = 0;
    for (const item of queued) {
        try {
            const result = await apiRequest("/orders", {
                method: "POST",
                body: item.payload,
                headers: { "Idempotency-Key": item.idempotencyKey },
            });
            // نجاح الإرسال، أو رفض واضح ونهائي من الخادم (مثل بيانات غير
            // صالحة) يعني "انتهى أمر هذا الطلب من منظور إعادة المحاولة"
            // ويجب إزالته من الطابور. لكن استمرار انقطاع الاتصال — سواء ظهر
            // كفشل fetch تام (status === 0) أو كاستجابة بديلة من الـ Service
            // Worker برمز "OFFLINE" (503) — يجب أن يُبقي الطلب في الطابور
            // لمحاولة لاحقة، وليس حذفه كأنه اكتمل.
            const stillOffline = !result.ok && (
                result.status === 0 ||
                (result.data && result.data.code === "OFFLINE")
            );

            if (result.ok || !stillOffline) {
                await removeQueuedOrder(item.idempotencyKey);
                synced++;
            } else {
                // لا يزال غير متصل — أوقف محاولة بقية الطابور في هذه الدورة
                // (لا فائدة من تجربة بقية الطلبات إن كان الاتصال منقطعًا أصلًا)
                break;
            }
        } catch {
            // تجاهل واستمر للطلب التالي — سيُعاد المحاولة لاحقًا
        }
    }

    const remaining = await countQueuedOrders().catch(() => 0);
    return { synced, failed: remaining, total: queued.length };
}

// ----------------------------------------------------------------------------
// تسجيل Service Worker (PWA) — يعمل على كل الصفحات التي تستدعي app.js
// فحص توفر الميزة أولًا (بعض المتصفحات القديمة لا تدعم Service Workers)،
// ولا يمنع أي خطأ هنا عمل باقي الصفحة إطلاقًا (best-effort تمامًا).
// ----------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/service-worker.js").catch((err) => {
            console.warn("تعذّر تسجيل service worker:", err);
        });
    });
}
