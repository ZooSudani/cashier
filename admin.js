// ============================================================================
// admin.js — كاشير (cashier)
// منطق لوحة Super Admin: إنشاء المطاعم، إدارتها، إدارة مستخدميها
// يعتمد على الأدوات المشتركة في app.js
// ============================================================================

(function () {
    "use strict";

    let restaurantsCache = [];
    let currentDetailRestaurantId = null;

    const el = {
        headerUsername: document.getElementById("header-username"),
        logoutBtn: document.getElementById("logout-btn"),

        statTotal: document.getElementById("stat-total"),
        statActive: document.getElementById("stat-active"),
        statDisabled: document.getElementById("stat-disabled"),

        restaurantsList: document.getElementById("restaurants-list"),
        addRestaurantBtn: document.getElementById("add-restaurant-btn"),

        createSheetOverlay: document.getElementById("create-restaurant-sheet-overlay"),
        createAlertBox: document.getElementById("create-restaurant-alert-box"),
        newName: document.getElementById("new-restaurant-name"),
        newSlug: document.getElementById("new-restaurant-slug"),
        newPhone: document.getElementById("new-restaurant-phone"),
        newPlan: document.getElementById("new-restaurant-plan"),
        newAdminUsername: document.getElementById("new-admin-username"),
        newAdminPassword: document.getElementById("new-admin-password"),
        saveRestaurantBtn: document.getElementById("save-restaurant-btn"),
        closeCreateRestaurantBtn: document.getElementById("close-create-restaurant-btn"),

        detailSheetOverlay: document.getElementById("restaurant-detail-sheet-overlay"),
        detailTitle: document.getElementById("restaurant-detail-title"),
        detailAlertBox: document.getElementById("restaurant-detail-alert-box"),
        detailRestaurantId: document.getElementById("detail-restaurant-id"),
        detailName: document.getElementById("detail-restaurant-name"),
        detailPhone: document.getElementById("detail-restaurant-phone"),
        detailPlan: document.getElementById("detail-restaurant-plan"),
        saveRestaurantDetailBtn: document.getElementById("save-restaurant-detail-btn"),
        toggleRestaurantBtn: document.getElementById("toggle-restaurant-btn"),
        restaurantUsersList: document.getElementById("restaurant-users-list"),
        addUserBtn: document.getElementById("add-user-btn"),
        closeRestaurantDetailBtn: document.getElementById("close-restaurant-detail-btn"),

        addUserSheetOverlay: document.getElementById("add-user-sheet-overlay"),
        addUserAlertBox: document.getElementById("add-user-alert-box"),
        addUserUsername: document.getElementById("add-user-username"),
        addUserPassword: document.getElementById("add-user-password"),
        addUserRole: document.getElementById("add-user-role"),
        saveNewUserBtn: document.getElementById("save-new-user-btn"),
        closeAddUserBtn: document.getElementById("close-add-user-btn"),

        resetPasswordSheetOverlay: document.getElementById("reset-password-sheet-overlay"),
        resetPasswordTitle: document.getElementById("reset-password-title"),
        resetPasswordAlertBox: document.getElementById("reset-password-alert-box"),
        resetPasswordInput: document.getElementById("reset-password-input"),
        saveResetPasswordBtn: document.getElementById("save-reset-password-btn"),
        closeResetPasswordBtn: document.getElementById("close-reset-password-btn"),
    };

    // ------------------------------------------------------------------
    // تهيئة
    // ------------------------------------------------------------------
    async function init() {
        const displayUsername = safeSessionGet("cashier_display_username");
        if (displayUsername) el.headerUsername.textContent = displayUsername;

        bindEvents();
        await loadOverview();
        await loadRestaurants();
    }

    function safeSessionGet(key) {
        try { return sessionStorage.getItem(key); } catch { return null; }
    }

    function openSheet(overlayEl) { overlayEl.classList.add("is-visible"); }
    function closeSheet(overlayEl) { overlayEl.classList.remove("is-visible"); }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    // ------------------------------------------------------------------
    // إحصائيات عامة
    // ------------------------------------------------------------------
    async function loadOverview() {
        const result = await apiRequest("/admin/overview");

        if (result.status === 401 || result.status === 403) {
            window.location.href = "/";
            return;
        }
        if (!result.ok) return;

        el.statTotal.textContent = result.data.total_restaurants;
        el.statActive.textContent = result.data.active_restaurants;
        el.statDisabled.textContent = result.data.disabled_restaurants;
    }

    // ------------------------------------------------------------------
    // قائمة المطاعم
    // ------------------------------------------------------------------
    async function loadRestaurants() {
        const result = await apiRequest("/admin/restaurants");
        if (!result.ok) return;

        restaurantsCache = result.data.restaurants || [];
        renderRestaurantsList();
    }

    function renderRestaurantsList() {
        el.restaurantsList.innerHTML = "";

        if (restaurantsCache.length === 0) {
            el.restaurantsList.innerHTML = `<div class="empty-state">لا توجد مطاعم بعد — أضف أول مطعم</div>`;
            return;
        }

        restaurantsCache.forEach((r) => {
            const row = document.createElement("div");
            row.className = "admin-row";
            row.style.cursor = "pointer";
            row.innerHTML = `
                <div class="admin-row__main">
                    <div class="admin-row__title">${escapeHtml(r.name)}</div>
                    <div class="admin-row__subtitle">
                        <span class="plan-badge">${escapeHtml(r.subscription_plan)}</span>
                        <span class="pill ${r.is_active ? "pill--available" : "pill--unavailable"}" style="margin-right:6px;">
                            ${r.is_active ? "نشط" : "معطّل"}
                        </span>
                        <span style="margin-right:6px;">${escapeHtml(r.slug)}</span>
                    </div>
                </div>
            `;
            row.addEventListener("click", () => openRestaurantDetail(r));
            el.restaurantsList.appendChild(row);
        });
    }

    // ------------------------------------------------------------------
    // إنشاء مطعم جديد
    // ------------------------------------------------------------------
    function openCreateRestaurantSheet() {
        hideAlert(el.createAlertBox);
        el.newName.value = "";
        el.newSlug.value = "";
        el.newPhone.value = "";
        el.newPlan.value = "FREE";
        el.newAdminUsername.value = "";
        el.newAdminPassword.value = "";
        openSheet(el.createSheetOverlay);
    }

    async function saveNewRestaurant() {
        hideAlert(el.createAlertBox);

        const name = el.newName.value.trim();
        const slug = el.newSlug.value.trim();
        const phone = el.newPhone.value.trim();
        const plan = el.newPlan.value;
        const adminUsername = el.newAdminUsername.value.trim();
        const adminPassword = el.newAdminPassword.value;

        if (!name || !slug) {
            showAlert(el.createAlertBox, "اسم المطعم والمعرّف مطلوبان");
            return;
        }
        if (!adminUsername || !adminPassword) {
            showAlert(el.createAlertBox, "بيانات مدير المطعم مطلوبة");
            return;
        }
        if (adminPassword.length < 8) {
            showAlert(el.createAlertBox, "كلمة مرور المدير يجب ألا تقل عن 8 أحرف");
            return;
        }

        setButtonLoading(el.saveRestaurantBtn, true);

        const result = await apiRequest("/admin/restaurants", {
            method: "POST",
            body: {
                name, slug, phone: phone || null, subscription_plan: plan,
                admin_username: adminUsername, admin_password: adminPassword,
            },
        });

        setButtonLoading(el.saveRestaurantBtn, false);

        if (!result.ok) {
            showAlert(el.createAlertBox, (result.data && result.data.error) || "فشل إنشاء المطعم");
            return;
        }

        closeSheet(el.createSheetOverlay);
        await loadOverview();
        await loadRestaurants();
    }

    // ------------------------------------------------------------------
    // تفاصيل/تعديل مطعم
    // ------------------------------------------------------------------
    async function openRestaurantDetail(restaurant) {
        hideAlert(el.detailAlertBox);
        currentDetailRestaurantId = restaurant.id;

        el.detailTitle.textContent = restaurant.name;
        el.detailRestaurantId.value = restaurant.id;
        el.detailName.value = restaurant.name;
        el.detailPhone.value = restaurant.phone || "";
        el.detailPlan.value = restaurant.subscription_plan;

        el.toggleRestaurantBtn.textContent = restaurant.is_active ? "تعطيل المطعم" : "تفعيل المطعم";

        openSheet(el.detailSheetOverlay);
        await loadRestaurantUsers(restaurant.id);
    }

    async function saveRestaurantDetail() {
        hideAlert(el.detailAlertBox);

        const name = el.detailName.value.trim();
        const phone = el.detailPhone.value.trim();
        const plan = el.detailPlan.value;

        if (!name) {
            showAlert(el.detailAlertBox, "اسم المطعم مطلوب");
            return;
        }

        setButtonLoading(el.saveRestaurantDetailBtn, true);

        const result = await apiRequest(`/admin/restaurants/${currentDetailRestaurantId}`, {
            method: "PUT",
            body: { name, phone: phone || null, subscription_plan: plan },
        });

        setButtonLoading(el.saveRestaurantDetailBtn, false);

        if (!result.ok) {
            showAlert(el.detailAlertBox, (result.data && result.data.error) || "فشل حفظ التعديلات");
            return;
        }

        showAlert(el.detailAlertBox, "تم الحفظ بنجاح", "success");
        await loadRestaurants();
    }

    async function toggleRestaurant() {
        const result = await apiRequest(`/admin/restaurants/${currentDetailRestaurantId}/toggle`, { method: "PATCH" });
        if (!result.ok) return;

        el.toggleRestaurantBtn.textContent = result.data.is_active ? "تعطيل المطعم" : "تفعيل المطعم";
        await loadOverview();
        await loadRestaurants();
    }

    // ------------------------------------------------------------------
    // مستخدمو المطعم
    // ------------------------------------------------------------------
    async function loadRestaurantUsers(restaurantId) {
        const result = await apiRequest(`/admin/restaurants/${restaurantId}/users`);
        if (!result.ok) return;

        const users = result.data.users || [];
        el.restaurantUsersList.innerHTML = "";

        if (users.length === 0) {
            el.restaurantUsersList.innerHTML = `<div class="empty-state">لا يوجد مستخدمون بعد</div>`;
            return;
        }

        const roleLabels = { RESTAURANT_ADMIN: "مدير مطعم", CASHIER: "كاشير" };

        users.forEach((u) => {
            const row = document.createElement("div");
            row.className = "admin-row";
            row.innerHTML = `
                <div class="admin-row__main">
                    <div class="admin-row__title">${escapeHtml(u.username)}</div>
                    <div class="admin-row__subtitle">
                        <span class="role-badge">${roleLabels[u.role] || u.role}</span>
                        <span class="pill ${u.is_active ? "pill--available" : "pill--unavailable"}" style="margin-right:6px;">
                            ${u.is_active ? "نشط" : "معطّل"}
                        </span>
                    </div>
                </div>
                <div class="admin-row__actions">
                    <button type="button" class="admin-row__icon-btn" data-action="reset-pw" title="إعادة تعيين كلمة المرور">🔑</button>
                    <button type="button" class="admin-row__icon-btn" data-action="toggle" title="تفعيل/تعطيل">🔁</button>
                </div>
            `;
            row.querySelector('[data-action="toggle"]').addEventListener("click", () => toggleUser(u.id, restaurantId));
            row.querySelector('[data-action="reset-pw"]').addEventListener("click", () => openResetPasswordSheet(u.id, u.username));
            el.restaurantUsersList.appendChild(row);
        });
    }

    async function toggleUser(userId, restaurantId) {
        const result = await apiRequest(`/admin/users/${userId}/toggle`, { method: "PATCH" });
        if (!result.ok) return;
        await loadRestaurantUsers(restaurantId);
    }

    // ------------------------------------------------------------------
    // إعادة تعيين كلمة مرور مستخدم (مدير مطعم أو كاشير) — Super Admin فقط
    // ------------------------------------------------------------------
    let resetPasswordTargetUserId = null;

    function openResetPasswordSheet(userId, username) {
        resetPasswordTargetUserId = userId;
        hideAlert(el.resetPasswordAlertBox);
        el.resetPasswordTitle.textContent = `كلمة مرور جديدة لـ ${username}`;
        el.resetPasswordInput.value = "";
        openSheet(el.resetPasswordSheetOverlay);
    }

    async function saveResetPassword() {
        hideAlert(el.resetPasswordAlertBox);
        const newPassword = el.resetPasswordInput.value;

        if (!newPassword || newPassword.length < 8) {
            showAlert(el.resetPasswordAlertBox, "كلمة المرور يجب ألا تقل عن 8 أحرف");
            return;
        }

        setButtonLoading(el.saveResetPasswordBtn, true);
        const result = await apiRequest(`/admin/users/${resetPasswordTargetUserId}/reset-password`, {
            method: "POST",
            body: { new_password: newPassword },
        });
        setButtonLoading(el.saveResetPasswordBtn, false);

        if (!result.ok) {
            showAlert(el.resetPasswordAlertBox, (result.data && result.data.error) || "فشل تغيير كلمة المرور");
            return;
        }

        closeSheet(el.resetPasswordSheetOverlay);
    }

    function openAddUserSheet() {
        hideAlert(el.addUserAlertBox);
        el.addUserUsername.value = "";
        el.addUserPassword.value = "";
        el.addUserRole.value = "CASHIER";
        openSheet(el.addUserSheetOverlay);
    }

    async function saveNewUser() {
        hideAlert(el.addUserAlertBox);

        const username = el.addUserUsername.value.trim();
        const password = el.addUserPassword.value;
        const role = el.addUserRole.value;

        if (!username || !password) {
            showAlert(el.addUserAlertBox, "جميع الحقول مطلوبة");
            return;
        }
        if (password.length < 8) {
            showAlert(el.addUserAlertBox, "كلمة المرور يجب ألا تقل عن 8 أحرف");
            return;
        }

        setButtonLoading(el.saveNewUserBtn, true);

        const result = await apiRequest(`/admin/restaurants/${currentDetailRestaurantId}/users`, {
            method: "POST",
            body: { username, password, role },
        });

        setButtonLoading(el.saveNewUserBtn, false);

        if (!result.ok) {
            showAlert(el.addUserAlertBox, (result.data && result.data.error) || "فشل إضافة المستخدم");
            return;
        }

        closeSheet(el.addUserSheetOverlay);
        await loadRestaurantUsers(currentDetailRestaurantId);
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
        el.logoutBtn.addEventListener("click", handleLogout);

        el.addRestaurantBtn.addEventListener("click", openCreateRestaurantSheet);
        el.saveRestaurantBtn.addEventListener("click", saveNewRestaurant);
        el.closeCreateRestaurantBtn.addEventListener("click", () => closeSheet(el.createSheetOverlay));

        el.saveRestaurantDetailBtn.addEventListener("click", saveRestaurantDetail);
        el.toggleRestaurantBtn.addEventListener("click", toggleRestaurant);
        el.closeRestaurantDetailBtn.addEventListener("click", () => closeSheet(el.detailSheetOverlay));

        el.addUserBtn.addEventListener("click", openAddUserSheet);
        el.saveNewUserBtn.addEventListener("click", saveNewUser);
        el.closeAddUserBtn.addEventListener("click", () => closeSheet(el.addUserSheetOverlay));

        el.saveResetPasswordBtn.addEventListener("click", saveResetPassword);
        el.closeResetPasswordBtn.addEventListener("click", () => closeSheet(el.resetPasswordSheetOverlay));
    }

    document.addEventListener("DOMContentLoaded", init);
})();
