// ============================================================================
// dashboard.js — كاشير (cashier)
// منطق لوحة صاحب المطعم: نظرة عامة، إدارة المنيو، تقارير الورديات، تدقيق بنكك
// يعتمد على الأدوات المشتركة في app.js
// ============================================================================

(function () {
    "use strict";

    let menuItemsCache = [];
    let editingMenuItemId = null;

    const el = {
        headerUsername: document.getElementById("header-username"),
        logoutBtn: document.getElementById("logout-btn"),
        dashTabs: document.getElementById("dash-tabs"),

        statTotalSales: document.getElementById("stat-total-sales"),
        statOrderCount: document.getElementById("stat-order-count"),
        statCash: document.getElementById("stat-cash"),
        statBankk: document.getElementById("stat-bankk"),
        overviewDateInput: document.getElementById("overview-date-input"),

        addMenuItemBtn: document.getElementById("add-menu-item-btn"),
        menuAdminList: document.getElementById("menu-admin-list"),

        menuItemSheetOverlay: document.getElementById("menu-item-sheet-overlay"),
        menuItemSheetTitle: document.getElementById("menu-item-sheet-title"),
        menuItemAlertBox: document.getElementById("menu-item-alert-box"),
        menuItemIdInput: document.getElementById("menu-item-id-input"),
        menuItemCategoryInput: document.getElementById("menu-item-category-input"),
        menuItemNameInput: document.getElementById("menu-item-name-input"),
        menuItemPriceInput: document.getElementById("menu-item-price-input"),
        categorySuggestions: document.getElementById("category-suggestions"),
        saveMenuItemBtn: document.getElementById("save-menu-item-btn"),
        closeMenuItemSheetBtn: document.getElementById("close-menu-item-sheet-btn"),

        shiftsList: document.getElementById("shifts-list"),
        bankkList: document.getElementById("bankk-list"),

        receiptPhotoSheetOverlay: document.getElementById("receipt-photo-sheet-overlay"),
        receiptPhotoImg: document.getElementById("receipt-photo-img"),
        closeReceiptPhotoBtn: document.getElementById("close-receipt-photo-btn"),

        confirmDialogOverlay: document.getElementById("confirm-dialog-overlay"),
        confirmDialogTitle: document.getElementById("confirm-dialog-title"),
        confirmDialogMessage: document.getElementById("confirm-dialog-message"),
        confirmDialogConfirmBtn: document.getElementById("confirm-dialog-confirm-btn"),
        confirmDialogCancelBtn: document.getElementById("confirm-dialog-cancel-btn"),
    };

    // ------------------------------------------------------------------
    // تهيئة
    // ------------------------------------------------------------------
    async function init() {
        const displayUsername = safeSessionGet("cashier_display_username");
        if (displayUsername) el.headerUsername.textContent = displayUsername;

        // تهيئة فلتر التاريخ على اليوم الحالي بتوقيت الجهاز (تقريب كافٍ للعرض)
        el.overviewDateInput.value = new Date().toISOString().slice(0, 10);

        bindEvents();
        await loadOverview();
    }

    function safeSessionGet(key) {
        try { return sessionStorage.getItem(key); } catch { return null; }
    }

    function openSheet(overlayEl) { overlayEl.classList.add("is-visible"); }
    function closeSheet(overlayEl) { overlayEl.classList.remove("is-visible"); }

    /**
     * نافذة تأكيد تفاعلية مصمَّمة بنفس هوية النظام (بدل confirm() الافتراضي
     * الرمادي في المتصفح). تُرجع Promise<boolean> — true عند التأكيد.
     * الاستخدام: const ok = await showConfirmDialog("حذف X نهائيًا؟");
     */
    function showConfirmDialog(message, title = "تأكيد الحذف") {
        el.confirmDialogTitle.textContent = title;
        el.confirmDialogMessage.textContent = message;
        openSheet(el.confirmDialogOverlay);

        return new Promise((resolve) => {
            function cleanup(result) {
                closeSheet(el.confirmDialogOverlay);
                el.confirmDialogConfirmBtn.removeEventListener("click", onConfirm);
                el.confirmDialogCancelBtn.removeEventListener("click", onCancel);
                resolve(result);
            }
            function onConfirm() { cleanup(true); }
            function onCancel() { cleanup(false); }

            el.confirmDialogConfirmBtn.addEventListener("click", onConfirm);
            el.confirmDialogCancelBtn.addEventListener("click", onCancel);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    // ------------------------------------------------------------------
    // التبويبات
    // ------------------------------------------------------------------
    function switchTab(tabName) {
        document.querySelectorAll(".dash-section").forEach((sec) => { sec.style.display = "none"; });
        document.getElementById(`tab-${tabName}`).style.display = "block";

        el.dashTabs.querySelectorAll(".category-chip").forEach((chip) => {
            chip.classList.toggle("is-active", chip.dataset.tab === tabName);
        });

        if (tabName === "overview") loadOverview();
        if (tabName === "menu") loadMenuAdmin();
        if (tabName === "shifts") loadShifts();
        if (tabName === "bankk") loadBankkAudit();
    }

    // ------------------------------------------------------------------
    // نظرة عامة (Dashboard Stats)
    // ------------------------------------------------------------------
    async function loadOverview() {
        const selectedDate = el.overviewDateInput.value; // YYYY-MM-DD
        const query = selectedDate ? `?date=${encodeURIComponent(selectedDate)}` : "";
        const result = await apiRequest(`/dashboard/today${query}`);

        if (result.status === 401) { window.location.href = "/"; return; }
        if (result.status === 403) { window.location.href = "/"; return; }
        if (!result.ok) return;

        const d = result.data;
        el.statTotalSales.textContent = formatSDG(d.total_sales);
        el.statOrderCount.textContent = d.order_count;
        el.statCash.textContent = formatSDG(d.total_cash);
        el.statBankk.textContent = formatSDG(d.total_bankk);
    }

    // ------------------------------------------------------------------
    // إدارة المنيو
    // ------------------------------------------------------------------
    async function loadMenuAdmin() {
        const result = await apiRequest("/menu");
        if (!result.ok) return;

        menuItemsCache = result.data.items || [];
        renderMenuAdminList();
        updateCategorySuggestions();
    }

    function updateCategorySuggestions() {
        const categories = [...new Set(menuItemsCache.map((i) => i.category))];
        el.categorySuggestions.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}">`).join("");
    }

    function renderMenuAdminList() {
        el.menuAdminList.innerHTML = "";

        if (menuItemsCache.length === 0) {
            el.menuAdminList.innerHTML = `<div class="empty-state">لا توجد أصناف بعد — أضف أول صنف</div>`;
            return;
        }

        // تجميع حسب التصنيف لعرض أوضح
        const byCategory = {};
        menuItemsCache.forEach((item) => {
            if (!byCategory[item.category]) byCategory[item.category] = [];
            byCategory[item.category].push(item);
        });

        Object.keys(byCategory).forEach((category) => {
            const heading = document.createElement("h3");
            heading.style.cssText = "font-size:14px; color:var(--color-text-muted); margin: var(--space-4) 0 var(--space-2);";
            heading.textContent = category;
            el.menuAdminList.appendChild(heading);

            byCategory[category].forEach((item) => {
                const row = document.createElement("div");
                row.className = "admin-row";
                row.innerHTML = `
                    <div class="admin-row__main">
                        <div class="admin-row__title">${escapeHtml(item.name)}</div>
                        <div class="admin-row__subtitle">
                            <span class="mono">${formatSDG(item.price)}</span>
                            <span class="pill ${item.is_available ? "pill--available" : "pill--unavailable"}" style="margin-right:6px;">
                                ${item.is_available ? "متوفر" : "نفد"}
                            </span>
                        </div>
                    </div>
                    <div class="admin-row__actions">
                        <button type="button" class="admin-row__icon-btn" data-action="edit" title="تعديل">✏️</button>
                        <button type="button" class="admin-row__icon-btn" data-action="toggle" title="تبديل التوفر">🔁</button>
                        <button type="button" class="admin-row__icon-btn" data-action="delete" title="حذف" style="color:var(--color-danger);">🗑️</button>
                    </div>
                `;

                row.querySelector('[data-action="edit"]').addEventListener("click", () => openMenuItemSheet(item));
                row.querySelector('[data-action="toggle"]').addEventListener("click", () => toggleMenuItem(item.id));
                row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteMenuItem(item.id, item.name));

                el.menuAdminList.appendChild(row);
            });
        });
    }

    function openMenuItemSheet(item) {
        hideAlert(el.menuItemAlertBox);
        editingMenuItemId = item ? item.id : null;

        el.menuItemSheetTitle.textContent = item ? "تعديل صنف" : "إضافة صنف";
        el.menuItemIdInput.value = item ? item.id : "";
        el.menuItemCategoryInput.value = item ? item.category : "";
        el.menuItemNameInput.value = item ? item.name : "";
        el.menuItemPriceInput.value = item ? item.price : "";

        openSheet(el.menuItemSheetOverlay);
    }

    async function saveMenuItem() {
        hideAlert(el.menuItemAlertBox);

        const category = el.menuItemCategoryInput.value.trim();
        const name = el.menuItemNameInput.value.trim();
        const price = parseInt(el.menuItemPriceInput.value, 10);

        if (!category || !name || isNaN(price) || price < 0) {
            showAlert(el.menuItemAlertBox, "املأ جميع الحقول بقيم صحيحة");
            return;
        }

        setButtonLoading(el.saveMenuItemBtn, true);

        let result;
        if (editingMenuItemId) {
            result = await apiRequest(`/menu/${editingMenuItemId}`, {
                method: "PUT",
                body: { category, name, price },
            });
        } else {
            result = await apiRequest("/menu", {
                method: "POST",
                body: { category, name, price },
            });
        }

        setButtonLoading(el.saveMenuItemBtn, false);

        if (!result.ok) {
            showAlert(el.menuItemAlertBox, (result.data && result.data.error) || "فشل الحفظ");
            return;
        }

        closeSheet(el.menuItemSheetOverlay);
        await loadMenuAdmin();
    }

    async function toggleMenuItem(itemId) {
        const result = await apiRequest(`/menu/${itemId}/toggle`, { method: "PATCH" });
        if (!result.ok) return;
        await loadMenuAdmin();
    }

    async function deleteMenuItem(itemId, itemName) {
        const confirmed = await showConfirmDialog(`سيُحذف "${itemName}" نهائيًا من المنيو ولن يمكن التراجع عن هذا الإجراء.`);
        if (!confirmed) return;

        const result = await apiRequest(`/menu/${itemId}`, { method: "DELETE" });
        if (!result.ok) return;
        await loadMenuAdmin();
    }

    // ------------------------------------------------------------------
    // تقارير الورديات
    // ------------------------------------------------------------------
    async function loadShifts() {
        const result = await apiRequest("/shifts?limit=100");
        if (!result.ok) return;

        const shifts = result.data.shifts || [];
        el.shiftsList.innerHTML = "";

        if (shifts.length === 0) {
            el.shiftsList.innerHTML = `<div class="empty-state">لا توجد ورديات مسجّلة بعد</div>`;
            return;
        }

        shifts.forEach((shift) => {
            const isOpen = shift.status === "OPEN";
            const diff = shift.difference;
            const diffClass = diff == null ? "" : diff < 0 ? "is-negative" : diff > 0 ? "is-positive" : "";

            const row = document.createElement("div");
            row.className = "admin-row";
            row.style.flexDirection = "column";
            row.style.alignItems = "stretch";
            row.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div class="admin-row__title">${escapeHtml(shift.cashier_username)}</div>
                    <span class="pill ${isOpen ? "pill--available" : "pill--unavailable"}">${isOpen ? "مفتوحة" : "مغلقة"}</span>
                </div>
                <div class="admin-row__subtitle">
                    فتح: ${formatKhartoumTime(shift.opened_at)}
                    ${shift.closed_at ? ` — إغلاق: ${formatKhartoumTime(shift.closed_at)}` : ""}
                </div>
                <div class="close-summary-row">
                    <span>الرصيد الافتتاحي</span>
                    <span class="close-summary-row__value">${formatSDG(shift.opening_balance)}</span>
                </div>
                ${!isOpen ? `
                <div class="close-summary-row">
                    <span>المتوقع نقدًا</span>
                    <span class="close-summary-row__value">${formatSDG(shift.expected_cash)}</span>
                </div>
                <div class="close-summary-row">
                    <span>الفعلي نقدًا</span>
                    <span class="close-summary-row__value">${formatSDG(shift.actual_cash)}</span>
                </div>
                <div class="close-summary-row close-summary-row--diff ${diffClass}">
                    <span>الفرق</span>
                    <span class="close-summary-row__value">${diff > 0 ? "+" : ""}${formatSDG(diff)}</span>
                </div>
                ` : ""}
                <div class="close-summary-row">
                    <span>إجمالي بنكك</span>
                    <span class="close-summary-row__value">${formatSDG(shift.total_bankk)}</span>
                </div>
            `;
            el.shiftsList.appendChild(row);
        });
    }

    // ------------------------------------------------------------------
    // تدقيق بنكك — مُجمَّعة حسب كل وردية على حدة
    // ------------------------------------------------------------------
    async function loadBankkAudit() {
        const result = await apiRequest("/orders?payment_method=BANKK&limit=200");
        if (!result.ok) return;

        const orders = result.data.orders || [];
        el.bankkList.innerHTML = "";

        if (orders.length === 0) {
            el.bankkList.innerHTML = `<div class="empty-state">لا توجد عمليات بنكك بعد</div>`;
            return;
        }

        // تجميع العمليات حسب shift_id — كل وردية تظهر كمجموعة منفصلة بعنوانها
        // الخاص. نستخدم Map بدل Object لأن مفاتيح الأرقام في Object تُرتَّب
        // تصاعديًا تلقائيًا في JavaScript (تتجاهل ترتيب الإدخال)، ما كان يُظهر
        // الورديات الأقدم أولًا رغم وصول البيانات مرتّبة من الأحدث للأقدم.
        const byShift = new Map();
        orders.forEach((order) => {
            const key = order.shift_id;
            if (!byShift.has(key)) byShift.set(key, []);
            byShift.get(key).push(order);
        });

        // ترتيب صريح إضافي حسب وقت فتح الوردية تنازليًا (الأحدث أولًا) —
        // ضمان مستقل عن ترتيب الطلبات نفسها.
        const shiftGroups = Array.from(byShift.values()).sort(
            (a, b) => new Date(b[0].shift_opened_at) - new Date(a[0].shift_opened_at)
        );

        shiftGroups.forEach((shiftOrders) => {
            const first = shiftOrders[0];
            const shiftTotal = shiftOrders.reduce((sum, o) => sum + o.total_amount, 0);
            const isOpen = first.shift_status === "OPEN";

            const header = document.createElement("div");
            header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin: var(--space-5) 0 var(--space-2);";
            header.innerHTML = `
                <div>
                    <div style="font-weight:700; font-size:14px;">
                        ${escapeHtml(first.cashier_username)}
                        <span class="pill ${isOpen ? "pill--available" : "pill--unavailable"}" style="margin-right:6px;">
                            ${isOpen ? "مفتوحة" : "مغلقة"}
                        </span>
                    </div>
                    <div style="font-size:12px; color:var(--color-text-muted); margin-top:2px;">
                        فتح: ${formatKhartoumTime(first.shift_opened_at)}
                        ${first.shift_closed_at ? ` — إغلاق: ${formatKhartoumTime(first.shift_closed_at)}` : ""}
                    </div>
                </div>
                <div class="mono" style="color:var(--color-bankk); font-weight:700;">${formatSDG(shiftTotal)}</div>
            `;
            el.bankkList.appendChild(header);

            shiftOrders.forEach((order) => {
                const row = document.createElement("div");
                row.className = "admin-row";
                row.innerHTML = `
                    <div class="admin-row__main">
                        <div class="admin-row__title">طلب #${escapeHtml(order.public_id)}</div>
                        <div class="admin-row__subtitle">
                            ${formatKhartoumTime(order.created_at)}
                            ${order.bankk_ref ? ` — رقم العملية: ${escapeHtml(order.bankk_ref)}` : ""}
                        </div>
                    </div>
                    <div class="admin-row__meta">${formatSDG(order.total_amount)}</div>
                    ${order.receipt_key ? `<button type="button" class="admin-row__icon-btn" data-key="${escapeHtml(order.receipt_key)}" title="عرض الصورة">🖼️</button>` : ""}
                `;

                const photoBtn = row.querySelector("[data-key]");
                if (photoBtn) {
                    photoBtn.addEventListener("click", () => showReceiptPhoto(order.receipt_key));
                }

                el.bankkList.appendChild(row);
            });
        });
    }

    function showReceiptPhoto(receiptKey) {
        // ملف محمي — يُطلب عبر الجلسة (Cookie) مباشرة، الرابط نفسه غير عام
        el.receiptPhotoImg.src = `/api/files/${encodeURIComponent(receiptKey)}`;
        openSheet(el.receiptPhotoSheetOverlay);
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
        el.dashTabs.querySelectorAll(".category-chip").forEach((chip) => {
            chip.addEventListener("click", () => switchTab(chip.dataset.tab));
        });

        el.overviewDateInput.addEventListener("change", loadOverview);

        el.logoutBtn.addEventListener("click", handleLogout);

        el.addMenuItemBtn.addEventListener("click", () => openMenuItemSheet(null));
        el.saveMenuItemBtn.addEventListener("click", saveMenuItem);
        el.closeMenuItemSheetBtn.addEventListener("click", () => closeSheet(el.menuItemSheetOverlay));

        el.closeReceiptPhotoBtn.addEventListener("click", () => closeSheet(el.receiptPhotoSheetOverlay));
    }

    document.addEventListener("DOMContentLoaded", init);
})();
