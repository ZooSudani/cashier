// ============================================================================
// service-worker.js — كاشير (cashier)
// تخزين مؤقت لأصول الواجهة الثابتة (Shell Caching) — يجعل فتح التطبيق فوريًا
// من زيارة ثانية، ويُبقي الشاشات الأساسية قابلة للفتح حتى مع اتصال ضعيف.
//
// ملاحظة مهمة عن حدود هذه المرحلة (7):
// هذا الملف يُخزّن الواجهة (HTML/CSS/JS) فقط — وليس بيانات API (المنيو،
// الطلبات، الورديات). تخزين الطلبات نفسها أثناء انقطاع الإنترنت الفعلي
// (Offline Orders Queue عبر IndexedDB) هو موضوع المرحلة 8 القادمة تحديدًا،
// ولم يُنفَّذ هنا بعد. حاليًا: بدون إنترنت، تُفتح الواجهة لكن API لا يستجيب.
// ============================================================================

const CACHE_VERSION = "cashier-v8";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;

// الأصول الأساسية التي تُخزَّن فور تثبيت الـ Service Worker.
// ملاحظة: "/" غير موجود عمدًا هنا — Cloudflare Pages يُعيد توجيهه داخليًا
// إلى index.html، وتخزين استجابة مُعاد توجيهها (redirected response) يمنع
// Safari تحديدًا من استخدامها لاحقًا لفتح صفحة (خطأ "has redirections").
// نُخزّن index.html صراحة فقط، ونتعامل مع طلبات "/" بشكل خاص في fetch أدناه.
const APP_SHELL_FILES = [
    "/index.html",
    "/cashier.html",
    "/dashboard.html",
    "/admin.html",
    "/styles.css",
    "/app.js",
    "/cashier.js",
    "/dashboard.js",
    "/admin.js",
    "/manifest.json",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
];

// ----------------------------------------------------------------------------
// التثبيت: تخزين أصول الواجهة مسبقًا
// ----------------------------------------------------------------------------
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(APP_SHELL_CACHE).then((cache) => {
            // إضافة فردية متسامحة — فشل ملف واحد لا يمنع تخزين البقية
            return Promise.all(
                APP_SHELL_FILES.map((url) =>
                    cache.add(url).catch((err) => {
                        console.warn("service-worker: فشل تخزين", url, err);
                    })
                )
            );
        })
    );
    self.skipWaiting(); // تفعيل النسخة الجديدة فورًا بدل انتظار إغلاق كل التبويبات
});

// ----------------------------------------------------------------------------
// التفعيل: حذف أي نسخ تخزين مؤقت قديمة من إصدارات سابقة
// ----------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key.startsWith("cashier-") && key !== APP_SHELL_CACHE)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim(); // السيطرة على الصفحات المفتوحة فورًا دون إعادة تحميل
});

// ----------------------------------------------------------------------------
// إعادة بناء الاستجابة من الصفر لإزالة أي "علامة إعادة توجيه" (redirected)
// قد تكون عالقة بها — ضروري تحديدًا لطلبات التصفّح (navigate) على Safari.
// ----------------------------------------------------------------------------
async function cloneWithoutRedirectFlag(response) {
    const body = await response.clone().blob();
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

// ----------------------------------------------------------------------------
// الجلب (Fetch): استراتيجيات مختلفة حسب نوع الطلب
// ----------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // تجاهل أي طلب لنطاق خارجي (مثل خطوط Google Fonts) — يُترك للمتصفح كالمعتاد
    if (url.origin !== self.location.origin) return;

    // API: دائمًا Network-First — البيانات (منيو، طلبات، ورديات) يجب أن تكون
    // حية دائمًا؛ لا معنى إطلاقًا لتخزينها مؤقتًا هنا.
    if (url.pathname.startsWith("/api/")) {
        event.respondWith(
            fetch(event.request).catch(() =>
                new Response(
                    JSON.stringify({ error: "لا يوجد اتصال بالإنترنت", code: "OFFLINE" }),
                    { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
                )
            )
        );
        return;
    }

    // طلبات التصفّح المباشر (فتح صفحة كاملة، مثل "/" أو "/cashier.html"):
    // نُحوّل "/" صراحة إلى "/index.html" في التخزين المؤقت، ونعيد بناء
    // الاستجابة دائمًا لإزالة أي علامة إعادة توجيه قبل إرجاعها.
    if (event.request.mode === "navigate") {
        const cacheKey = url.pathname === "/" ? "/index.html" : url.pathname;

        event.respondWith(
            fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.ok) {
                        const responseClone = networkResponse.clone();
                        caches.open(APP_SHELL_CACHE).then((cache) => cache.put(cacheKey, responseClone));
                    }
                    return networkResponse;
                })
                .catch(async () => {
                    const cached = await caches.match(cacheKey);
                    if (cached) return cloneWithoutRedirectFlag(cached);
                    return new Response("غير متصل بالإنترنت", { status: 503 });
                })
        );
        return;
    }

    // أصول الواجهة الثابتة (CSS/JS/الصور): Cache-First مع تحديث في الخلفية
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const networkFetch = fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.ok) {
                        const responseClone = networkResponse.clone();
                        caches.open(APP_SHELL_CACHE).then((cache) => cache.put(event.request, responseClone));
                    }
                    return networkResponse;
                })
                .catch(() => null);

            if (cachedResponse) return cloneWithoutRedirectFlag(cachedResponse);
            return networkFetch;
        })
    );
});
