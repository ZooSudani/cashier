// ============================================================================
// cashier.js — كاشير (cashier)
// منطق شاشة الكاشير: فتح/إغلاق الوردية، المنيو، السلة، الدفع، الطباعة
// يعتمد على الأدوات المشتركة في app.js (apiRequest, formatSDG, showAlert...)
// ============================================================================

(function () {
    "use strict";

    // ------------------------------------------------------------------
    // الحالة (State)
    // ------------------------------------------------------------------
    let currentShift = null;      // { id, opening_balance, ... } أو null إن لم تكن هناك وردية مفتوحة
    let menuItems = [];           // كل أصناف المنيو كما وردت من الخادم
    let activeCategory = "الكل";
    let cart = [];                // [{ item_id, name, price, quantity, notes }]
    let selectedPaymentMethod = null; // "CASH" | "BANKK"
    let selectedOrderType = "DINE_IN";
    let bankkReceiptKey = null;   // يُملأ بعد نجاح رفع صورة الإشعار
    let lastOrderIdempotencyKey = null;
    let lastCompletedOrder = null;

    // ------------------------------------------------------------------
    // عناصر DOM
    // ------------------------------------------------------------------
    const el = {
        restaurantName: document.getElementById("restaurant-name"),
        shiftBadge: document.getElementById("shift-status-badge"),
        shiftStatusText: document.getElementById("shift-status-text"),
        shiftToggleBtn: document.getElementById("shift-toggle-btn"),
        logoutBtn: document.getElementById("logout-btn"),
        shiftLiveSummary: document.getElementById("shift-live-summary"),
        shiftLiveOrders: document.getElementById("shift-live-orders"),
        shiftLiveCash: document.getElementById("shift-live-cash"),
        previewOrderCount: document.getElementById("preview-order-count"),
        previewBankk: document.getElementById("preview-bankk"),
        previewExpectedCash: document.getElementById("preview-expected-cash"),

        categoryScroll: document.getElementById("category-scroll"),
        menuGrid: document.getElementById("menu-grid"),
        menuEmptyState: document.getElementById("menu-empty-state"),

        cartBar: document.getElementById("cart-bar"),
        cartCount: document.getElementById("cart-count"),
        cartTotal: document.getElementById("cart-total"),
        openCartBtn: document.getElementById("open-cart-btn"),

        cartSheetOverlay: document.getElementById("cart-sheet-overlay"),
        cartRowsContainer: document.getElementById("cart-rows-container"),
        cartSheetTotal: document.getElementById("cart-sheet-total"),
        proceedToPaymentBtn: document.getElementById("proceed-to-payment-btn"),
        closeCartSheetBtn: document.getElementById("close-cart-sheet-btn"),

        paymentSheetOverlay: document.getElementById("payment-sheet-overlay"),
        paymentTotal: document.getElementById("payment-total"),
        paymentAlertBox: document.getElementById("payment-alert-box"),
        methodCashBtn: document.getElementById("method-cash-btn"),
        methodBankkBtn: document.getElementById("method-bankk-btn"),
        bankkDetails: document.getElementById("bankk-details"),
        bankkRefInput: document.getElementById("bankk-ref-input"),
        bankkPhotoInput: document.getElementById("bankk-photo-input"),
        bankkPhotoBtn: document.getElementById("bankk-photo-btn"),
        bankkPhotoPreview: document.getElementById("bankk-photo-preview"),
        orderTypeTabs: document.getElementById("order-type-tabs"),
        tableNumberInput: document.getElementById("table-number-input"),
        confirmOrderBtn: document.getElementById("confirm-order-btn"),
        closePaymentSheetBtn: document.getElementById("close-payment-sheet-btn"),

        shiftSheetOverlay: document.getElementById("shift-sheet-overlay"),
        shiftSheetTitle: document.getElementById("shift-sheet-title"),
        shiftAlertBox: document.getElementById("shift-alert-box"),
        shiftOpenContent: document.getElementById("shift-open-content"),
        shiftCloseContent: document.getElementById("shift-close-content"),
        openingBalanceInput: document.getElementById("opening-balance-input"),
        confirmOpenShiftBtn: document.getElementById("confirm-open-shift-btn"),
        actualCashInput: document.getElementById("actual-cash-input"),
        confirmCloseShiftBtn: document.getElementById("confirm-close-shift-btn"),
        closeShiftSheetBtn: document.getElementById("close-shift-sheet-btn"),

        successSheetOverlay: document.getElementById("success-sheet-overlay"),
        successOrderId: document.getElementById("success-order-id"),
        printReceiptBtn: document.getElementById("print-receipt-btn"),
        newOrderBtn: document.getElementById("new-order-btn"),
    };

    // ------------------------------------------------------------------
    // تهيئة الصفحة
    // ------------------------------------------------------------------
    async function init() {
        // عرض اسم الكاشير المخزّن من صفحة الدخول (عرض فقط، ليس مصدر الصلاحية)
        const displayUsername = safeSessionGet("cashier_display_username");
        if (displayUsername) {
            el.restaurantName.textContent = displayUsername;
        }

        await refreshShiftStatus();
        await loadMenu();

        bindEvents();
    }

    function safeSessionGet(key) {
        try { return sessionStorage.getItem(key); } catch { return null; }
    }

    // ------------------------------------------------------------------
    // حالة الوردية
    // ------------------------------------------------------------------
    async function refreshShiftStatus() {
        const result = await apiRequest("/shift/current");

        if (result.status === 401) {
            window.location.href = "/";
            return;
        }
        if (result.status === 403) {
            // مسجّل دخول لكن ليس بدور CASHIER — لا يملك صلاحية هذه الشاشة
            window.location.href = "/";
            return;
        }

        currentShift = (result.ok && result.data) ? result.data.shift : null;
        renderShiftStatus();
    }

    function renderShiftStatus() {
        const isOpen = !!currentShift;

        el.shiftBadge.classList.toggle("shift-status--open", isOpen);
        el.shiftBadge.classList.toggle("shift-status--closed", !isOpen);
        el.shiftStatusText.textContent = isOpen ? "مفتوحة" : "مغلقة";

        el.shiftToggleBtn.textContent = isOpen ? "إغلاق الوردية" : "فتح الوردية";
        el.shiftToggleBtn.classList.toggle("shift-bar__action--open", !isOpen);
        el.shiftToggleBtn.classList.toggle("shift-bar__action--close", isOpen);

        // زر الخروج مخفي أثناء وجود وردية مفتوحة — يمنع خروج الكاشير سهوًا
        // بدون إغلاق الوردية أولًا، ما قد يُربك حسابات الصندوق لاحقًا.
        el.logoutBtn.style.display = isOpen ? "none" : "inline-flex";

        // ملخص حي: عدد الطلبات والمتوقع بالصندوق حتى الآن — يبقى ظاهرًا طوال
        // الوردية حتى لا يفاجأ الكاشير بالأرقام فقط عند لحظة الإغلاق.
        if (isOpen) {
            el.shiftLiveSummary.style.display = "flex";
            el.shiftLiveOrders.textContent = `${currentShift.order_count ?? 0} طلب`;
            el.shiftLiveCash.textContent = `نقدًا: ${formatSDG(currentShift.expected_cash_now ?? currentShift.opening_balance)}`;
        } else {
            el.shiftLiveSummary.style.display = "none";
        }

        // لا يمكن البيع بدون وردية مفتوحة
        el.menuEmptyState.style.display = isOpen ? "none" : "block";
        el.menuGrid.style.display = isOpen ? "grid" : "none";
        el.categoryScroll.style.display = isOpen ? "flex" : "none";

        if (!isOpen) {
            clearCart();
        }
    }

    // ------------------------------------------------------------------
    // المنيو
    // ------------------------------------------------------------------
    async function loadMenu() {
        const result = await apiRequest("/menu");
        if (!result.ok) return;

        menuItems = result.data.items || [];
        renderCategories();
        renderMenuGrid();
    }

    function renderCategories() {
        const categories = ["الكل", ...new Set(menuItems.map((i) => i.category))];
        el.categoryScroll.innerHTML = "";

        categories.forEach((cat) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "category-chip" + (cat === activeCategory ? " is-active" : "");
            chip.textContent = cat;
            chip.addEventListener("click", () => {
                activeCategory = cat;
                renderCategories();
                renderMenuGrid();
            });
            el.categoryScroll.appendChild(chip);
        });
    }

    function renderMenuGrid() {
        el.menuGrid.innerHTML = "";

        const filtered = activeCategory === "الكل"
            ? menuItems
            : menuItems.filter((i) => i.category === activeCategory);

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "لا توجد أصناف في هذا التصنيف";
            el.menuGrid.appendChild(empty);
            return;
        }

        filtered.forEach((item) => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "menu-item" + (item.is_available ? "" : " menu-item--unavailable");
            card.disabled = !item.is_available;

            const cartQty = getCartQuantity(item.id);
            if (cartQty > 0) card.classList.add("has-qty");

            card.innerHTML = `
                <span class="menu-item__qty-badge">${cartQty}</span>
                <span class="menu-item__name">${escapeHtml(item.name)}</span>
                <span class="menu-item__price mono">${formatSDG(item.price)}</span>
            `;

            card.addEventListener("click", () => addToCart(item));
            el.menuGrid.appendChild(card);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ------------------------------------------------------------------
    // السلة
    // ------------------------------------------------------------------
    function getCartQuantity(itemId) {
        const line = cart.find((c) => c.item_id === itemId);
        return line ? line.quantity : 0;
    }

    function addToCart(menuItem) {
        const existing = cart.find((c) => c.item_id === menuItem.id);
        if (existing) {
            existing.quantity += 1;
        } else {
            cart.push({
                item_id: menuItem.id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: 1,
                notes: "",
            });
        }
        renderMenuGrid();
        renderCartBar();
    }

    function updateCartQuantity(itemId, delta) {
        const line = cart.find((c) => c.item_id === itemId);
        if (!line) return;
        line.quantity += delta;
        if (line.quantity <= 0) {
            cart = cart.filter((c) => c.item_id !== itemId);
        }
        renderMenuGrid();
        renderCartBar();
        renderCartSheet();
    }

    function clearCart() {
        cart = [];
        renderCartBar();
    }

    function getCartTotal() {
        return cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
    }

    function getCartCount() {
        return cart.reduce((sum, c) => sum + c.quantity, 0);
    }

    function renderCartBar() {
        const count = getCartCount();
        el.cartBar.classList.toggle("is-visible", count > 0);
        el.cartCount.textContent = `${count} صنف`;
        el.cartTotal.textContent = formatSDG(getCartTotal());
    }

    function renderCartSheet() {
        el.cartRowsContainer.innerHTML = "";

        if (cart.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "السلة فارغة";
            el.cartRowsContainer.appendChild(empty);
        }

        cart.forEach((line) => {
            const row = document.createElement("div");
            row.className = "cart-row";
            row.innerHTML = `
                <div class="cart-row__info">
                    <div class="cart-row__name">${escapeHtml(line.name)}</div>
                    <div class="cart-row__unit-price mono">${formatSDG(line.price)} × ${line.quantity}</div>
                </div>
                <div class="qty-stepper">
                    <button type="button" class="qty-stepper__btn" data-action="dec">−</button>
                    <span class="qty-stepper__value mono">${line.quantity}</span>
                    <button type="button" class="qty-stepper__btn" data-action="inc">+</button>
                </div>
                <div class="cart-row__subtotal mono">${formatSDG(line.price * line.quantity)}</div>
            `;

            row.querySelector('[data-action="inc"]').addEventListener("click", () => updateCartQuantity(line.item_id, 1));
            row.querySelector('[data-action="dec"]').addEventListener("click", () => updateCartQuantity(line.item_id, -1));

            el.cartRowsContainer.appendChild(row);
        });

        el.cartSheetTotal.textContent = formatSDG(getCartTotal());
    }

    // ------------------------------------------------------------------
    // أوراق الواجهة (فتح/إغلاق)
    // ------------------------------------------------------------------
    function openSheet(overlayEl) { overlayEl.classList.add("is-visible"); }
    function closeSheet(overlayEl) { overlayEl.classList.remove("is-visible"); }

    // ------------------------------------------------------------------
    // الدفع
    // ------------------------------------------------------------------
    function openPaymentSheet() {
        selectedPaymentMethod = null;
        bankkReceiptKey = null;
        el.bankkRefInput.value = "";
        el.bankkPhotoPreview.classList.remove("is-visible");
        el.bankkPhotoBtn.classList.remove("has-photo");
        el.bankkPhotoBtn.textContent = "📷 التقاط صورة إشعار بنكك";
        el.bankkDetails.classList.remove("is-visible");
        el.methodCashBtn.classList.remove("is-selected");
        el.methodBankkBtn.classList.remove("is-selected");
        hideAlert(el.paymentAlertBox);

        el.paymentTotal.textContent = getCartTotal().toLocaleString("ar-SD");

        closeSheet(el.cartSheetOverlay);
        openSheet(el.paymentSheetOverlay);
    }

    function selectPaymentMethod(method) {
        selectedPaymentMethod = method;
        el.methodCashBtn.classList.toggle("is-selected", method === "CASH");
        el.methodBankkBtn.classList.toggle("is-selected", method === "BANKK");
        el.bankkDetails.classList.toggle("is-visible", method === "BANKK");
    }

    async function handlePhotoCapture(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        // معاينة فورية للمستخدم
        const previewUrl = URL.createObjectURL(file);
        el.bankkPhotoPreview.src = previewUrl;
        el.bankkPhotoPreview.classList.add("is-visible");

        el.bankkPhotoBtn.textContent = "⏳ جاري الرفع...";

        const formData = new FormData();
        formData.append("file", file);

        const result = await apiRequest("/upload", { method: "POST", body: formData, isFormData: true });

        if (!result.ok) {
            el.bankkPhotoBtn.textContent = "❌ فشل الرفع — أعد المحاولة";
            bankkReceiptKey = null;
            return;
        }

        bankkReceiptKey = result.data.receipt_key;
        el.bankkPhotoBtn.textContent = "✅ تم رفع الصورة";
        el.bankkPhotoBtn.classList.add("has-photo");
    }

    async function confirmOrder() {
        hideAlert(el.paymentAlertBox);

        if (!selectedPaymentMethod) {
            showAlert(el.paymentAlertBox, "اختر طريقة الدفع");
            return;
        }
        if (selectedPaymentMethod === "BANKK" && !el.bankkRefInput.value.trim() && !bankkReceiptKey) {
            showAlert(el.paymentAlertBox, "أدخل رقم العملية أو أرفق صورة الإشعار");
            return;
        }
        if (cart.length === 0) {
            showAlert(el.paymentAlertBox, "السلة فارغة");
            return;
        }

        setButtonLoading(el.confirmOrderBtn, true);

        // Idempotency-Key فريد لكل محاولة إرسال جديدة — يمنع تكرار الطلب لو
        // ضغط الكاشير الزر مرتين أو انقطعت الشبكة أثناء الإرسال.
        if (!lastOrderIdempotencyKey) {
            lastOrderIdempotencyKey = generateClientToken();
        }

        const payload = {
            order_type: selectedOrderType,
            table_number: el.tableNumberInput.value.trim() || null,
            payment_method: selectedPaymentMethod,
            items: cart.map((c) => ({ item_id: c.item_id, quantity: c.quantity, notes: c.notes || null })),
            bankk_ref: selectedPaymentMethod === "BANKK" ? (el.bankkRefInput.value.trim() || null) : null,
            receipt_key: selectedPaymentMethod === "BANKK" ? bankkReceiptKey : null,
        };

        const result = await apiRequest("/orders", {
            method: "POST",
            body: payload,
            headers: { "Idempotency-Key": lastOrderIdempotencyKey },
        });

        setButtonLoading(el.confirmOrderBtn, false);

        if (!result.ok) {
            const message = (result.data && result.data.error) || "فشل إنشاء الطلب";
            showAlert(el.paymentAlertBox, message);
            return;
        }

        lastCompletedOrder = result.data.order;
        lastOrderIdempotencyKey = null; // جاهز لطلب جديد مستقل بعد النجاح

        clearCart();
        closeSheet(el.paymentSheetOverlay);
        showOrderSuccess(lastCompletedOrder);
        refreshShiftStatus(); // تحديث عدد الطلبات والمتوقع بالصندوق في الشريط فورًا
    }

    function generateClientToken() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function showOrderSuccess(order) {
        el.successOrderId.textContent = `رقم الطلب: ${order.public_id}`;
        openSheet(el.successSheetOverlay);
    }

    // ------------------------------------------------------------------
    // الطباعة
    // ------------------------------------------------------------------
    function printReceipt() {
        if (!lastCompletedOrder) return;
        const order = lastCompletedOrder;

        document.getElementById("print-restaurant-name").textContent = el.restaurantName.textContent || "كاشير";
        document.getElementById("print-order-id").textContent = `طلب #${order.public_id}`;
        document.getElementById("print-datetime").textContent = formatKhartoumTime(order.created_at);

        const itemsTable = document.getElementById("print-items-table");
        itemsTable.innerHTML = order.items.map((li) => `
            <tr>
                <td>${escapeHtml(li.item_name)} × ${li.quantity}</td>
                <td style="text-align:left;">${li.subtotal.toLocaleString("ar-SD")}</td>
            </tr>
            ${li.notes ? `<tr><td colspan="2" style="color:#555; font-size:10px;">${escapeHtml(li.notes)}</td></tr>` : ""}
        `).join("");

        document.getElementById("print-total").textContent = formatSDG(order.total_amount);
        document.getElementById("print-payment-method").textContent = order.payment_method === "CASH" ? "كاش" : "بنكك";

        window.print();
    }

    // ------------------------------------------------------------------
    // الوردية: فتح/إغلاق
    // ------------------------------------------------------------------
    function openShiftSheet() {
        hideAlert(el.shiftAlertBox);
        const isOpen = !!currentShift;

        el.shiftSheetTitle.textContent = isOpen ? "إغلاق الوردية" : "فتح وردية جديدة";
        el.shiftOpenContent.style.display = isOpen ? "none" : "block";
        el.shiftCloseContent.style.display = isOpen ? "block" : "none";

        el.openingBalanceInput.value = "";
        el.actualCashInput.value = "";

        // تعبئة صندوق المعاينة بأرقام حية قبل أن يُدخل الكاشير المبلغ الفعلي —
        // حتى لا يُغلق الوردية "بشكل أعمى" بدون معرفة المتوقع مسبقًا.
        if (isOpen && currentShift) {
            el.previewOrderCount.textContent = currentShift.order_count ?? 0;
            el.previewBankk.textContent = formatSDG(currentShift.bankk_so_far ?? 0);
            el.previewExpectedCash.textContent = formatSDG(currentShift.expected_cash_now ?? currentShift.opening_balance);
        }

        openSheet(el.shiftSheetOverlay);
    }

    async function handleOpenShift() {
        hideAlert(el.shiftAlertBox);
        const openingBalance = parseInt(el.openingBalanceInput.value, 10) || 0;

        if (openingBalance < 0) {
            showAlert(el.shiftAlertBox, "الرصيد الافتتاحي غير صالح");
            return;
        }

        setButtonLoading(el.confirmOpenShiftBtn, true);
        const result = await apiRequest("/shift/open", { method: "POST", body: { opening_balance: openingBalance } });
        setButtonLoading(el.confirmOpenShiftBtn, false);

        if (!result.ok) {
            showAlert(el.shiftAlertBox, (result.data && result.data.error) || "فشل فتح الوردية");
            return;
        }

        closeSheet(el.shiftSheetOverlay);
        await refreshShiftStatus();
        await loadMenu();
    }

    async function handleCloseShift() {
        hideAlert(el.shiftAlertBox);
        const actualCash = el.actualCashInput.value === "" ? null : parseInt(el.actualCashInput.value, 10);

        if (actualCash === null || actualCash < 0) {
            showAlert(el.shiftAlertBox, "أدخل المبلغ الفعلي بالصندوق");
            return;
        }

        setButtonLoading(el.confirmCloseShiftBtn, true);
        const result = await apiRequest("/shift/close", { method: "POST", body: { actual_cash: actualCash } });
        setButtonLoading(el.confirmCloseShiftBtn, false);

        if (!result.ok) {
            showAlert(el.shiftAlertBox, (result.data && result.data.error) || "فشل إغلاق الوردية");
            return;
        }

        closeSheet(el.shiftSheetOverlay);
        await refreshShiftStatus();
    }

    // ------------------------------------------------------------------
    // تسجيل الخروج
    // ------------------------------------------------------------------
    async function handleLogout() {
        await apiRequest("/auth/logout", { method: "POST" });
        try {
            sessionStorage.removeItem("cashier_display_username");
            sessionStorage.removeItem("cashier_display_role");
        } catch (e) { /* تجاهل */ }
        window.location.href = "/";
    }

    // ------------------------------------------------------------------
    // ربط الأحداث
    // ------------------------------------------------------------------
    function bindEvents() {
        el.shiftToggleBtn.addEventListener("click", openShiftSheet);
        el.logoutBtn.addEventListener("click", handleLogout);
        el.closeShiftSheetBtn.addEventListener("click", () => closeSheet(el.shiftSheetOverlay));
        el.confirmOpenShiftBtn.addEventListener("click", handleOpenShift);
        el.confirmCloseShiftBtn.addEventListener("click", handleCloseShift);

        el.openCartBtn.addEventListener("click", () => {
            renderCartSheet();
            openSheet(el.cartSheetOverlay);
        });
        el.closeCartSheetBtn.addEventListener("click", () => closeSheet(el.cartSheetOverlay));
        el.proceedToPaymentBtn.addEventListener("click", () => {
            if (cart.length === 0) return;
            openPaymentSheet();
        });

        el.methodCashBtn.addEventListener("click", () => selectPaymentMethod("CASH"));
        el.methodBankkBtn.addEventListener("click", () => selectPaymentMethod("BANKK"));
        el.bankkPhotoBtn.addEventListener("click", () => el.bankkPhotoInput.click());
        el.bankkPhotoInput.addEventListener("change", handlePhotoCapture);

        el.orderTypeTabs.querySelectorAll(".tabs__btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                selectedOrderType = btn.dataset.type;
                el.orderTypeTabs.querySelectorAll(".tabs__btn").forEach((b) => b.classList.remove("is-active"));
                btn.classList.add("is-active");
            });
        });

        el.confirmOrderBtn.addEventListener("click", confirmOrder);
        el.closePaymentSheetBtn.addEventListener("click", () => {
            closeSheet(el.paymentSheetOverlay);
            openSheet(el.cartSheetOverlay);
        });

        el.printReceiptBtn.addEventListener("click", printReceipt);
        el.newOrderBtn.addEventListener("click", () => {
            closeSheet(el.successSheetOverlay);
            lastCompletedOrder = null;
        });
    }

    // ------------------------------------------------------------------
    document.addEventListener("DOMContentLoaded", init);
})();
