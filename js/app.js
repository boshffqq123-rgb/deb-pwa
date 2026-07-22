/* =========================================================================
   app.js — منطق واجهة التطبيق بالكامل
   ========================================================================= */

const state = {
  view: "dashboard",
  currentCustomerId: null,
  showArchived: false,
  customersCache: [],
  txnsCache: [],
};

/* --------------------------------- أدوات عامة ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, ms = 2600) {
  const box = document.createElement("div");
  box.className = "toast-msg";
  box.textContent = msg;
  $("#toast").appendChild(box);
  setTimeout(() => box.remove(), ms);
}
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------- نوافذ منبثقة ------------------------------ */

function openModal(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box">${innerHtml}</div>`;
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });
  $("#modalRoot").appendChild(overlay);
  return overlay;
}
function closeModal() { $("#modalRoot").innerHTML = ""; }

function confirmDialog(message, onYes) {
  const box = openModal(`
    <h3>تأكيد</h3>
    <p>${escapeHtml(message)}</p>
    <div class="btn-row" style="justify-content:flex-end;">
      <button class="secondary" id="cfNo">إلغاء</button>
      <button class="danger" id="cfYes">تأكيد</button>
    </div>
  `);
  $("#cfNo", box).onclick = closeModal;
  $("#cfYes", box).onclick = () => { closeModal(); onYes(); };
}

function customerModal(existing) {
  const box = openModal(`
    <h3>${existing ? "تعديل بيانات العميل" : "عميل جديد"}</h3>
    <label>الاسم *</label><input id="cmName" value="${escapeHtml(existing?.name || "")}">
    <label>الهاتف</label><input id="cmPhone" value="${escapeHtml(existing?.phone || "")}">
    <label>العنوان</label><input id="cmAddress" value="${escapeHtml(existing?.address || "")}">
    <label>ملاحظات</label><textarea id="cmNotes" rows="2">${escapeHtml(existing?.notes || "")}</textarea>
    <div class="btn-row" style="justify-content:flex-end;margin-top:8px;">
      <button class="secondary" id="cmCancel">إلغاء</button>
      <button id="cmSave">💾 حفظ</button>
    </div>
  `);
  $("#cmCancel", box).onclick = closeModal;
  $("#cmSave", box).onclick = async () => {
    const name = $("#cmName", box).value.trim();
    if (!name) { toast("الاسم مطلوب"); return; }
    const payload = {
      name,
      phone: $("#cmPhone", box).value.trim(),
      address: $("#cmAddress", box).value.trim(),
      notes: $("#cmNotes", box).value.trim(),
    };
    let newId;
    if (existing) await Customers.update(existing.id, payload);
    else newId = await Customers.add(payload);
    closeModal();
    toast("تم الحفظ بنجاح");
    await refreshCaches();
    if (state.view === "customers") renderCustomers();
    if (state.view === "statement") renderStatement(state.currentCustomerId);
    if (state.view === "dashboard") renderDashboard();
    if (!existing && typeof newId !== "undefined") return newId;
  };
}

function transactionModal({ customerId, type = "debt", existing = null }) {
  const box = openModal(`
    <h3>${existing ? "تعديل عملية" : (type === "debt" ? "تسجيل دين" : "تسجيل سداد")}</h3>
    <label>النوع</label>
    <select id="tmType">
      <option value="debt" ${((existing?.type || type) === "debt") ? "selected" : ""}>دين (على العميل)</option>
      <option value="payment" ${((existing?.type || type) === "payment") ? "selected" : ""}>سداد (من العميل)</option>
    </select>
    <label>المبلغ</label><input type="number" step="0.01" id="tmAmount" value="${existing?.amount ?? ""}">
    <label>التاريخ</label><input type="date" id="tmDate" value="${existing?.date || todayStr()}">
    <label>ملاحظة</label><textarea id="tmNote" rows="2">${escapeHtml(existing?.note || "")}</textarea>
    <div class="btn-row" style="justify-content:flex-end;margin-top:8px;">
      <button class="secondary" id="tmCancel">إلغاء</button>
      <button id="tmSave">💾 حفظ</button>
    </div>
  `);
  $("#tmCancel", box).onclick = closeModal;
  $("#tmSave", box).onclick = async () => {
    const amount = parseFloat($("#tmAmount", box).value);
    if (!amount || amount <= 0) { toast("أدخل مبلغًا صحيحًا"); return; }
    const payload = {
      customerId, type: $("#tmType", box).value,
      amount, date: $("#tmDate", box).value || todayStr(),
      note: $("#tmNote", box).value.trim(),
    };
    if (existing) await Transactions.update(existing.id, payload);
    else await Transactions.add(payload);
    closeModal();
    toast("تم حفظ العملية");
    await refreshCaches();
    if (state.view === "statement") renderStatement(state.currentCustomerId);
    if (state.view === "dashboard") renderDashboard();
  };
}

/* -------------------------------- تخزين مؤقت -------------------------------- */

async function refreshCaches() {
  state.customersCache = await Customers.all();
  state.txnsCache = await Transactions.all();
}
function txnsFor(customerId) {
  return state.txnsCache.filter((t) => t.customerId === customerId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}
function balanceOf(customerId) {
  return Transactions.balanceFor(txnsFor(customerId));
}

/* --------------------------------- التنقل ---------------------------------- */

const VIEW_META = {
  dashboard: ["لوحة التحكم", "نظرة عامة سريعة على حساباتك"],
  customers: ["العملاء", "إدارة العملاء وأرصدتهم"],
  statement: ["كشف الحساب", ""],
  newTransaction: ["عملية جديدة", "تسجيل دين أو سداد لعميل"],
  search: ["بحث", "ابحث في العملاء والعمليات"],
  reports: ["التقارير", "تقارير مفصّلة قابلة للتصدير"],
  alerts: ["التنبيهات", "متابعة المتأخرين وتجاوز السقف"],
  backup: ["النسخ الاحتياطي", "احفظ بياناتك أو استعِدها"],
  settings: ["الإعدادات", "المظهر والحماية"],
};

function navigate(view) {
  state.view = view;
  $all(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${view}`).classList.add("active");
  $all(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  const meta = VIEW_META[view] || ["", ""];
  $("#pageTitle").textContent = meta[0];
  $("#pageSub").textContent = meta[1];
  window.scrollTo({ top: 0 });

  if (view === "dashboard") renderDashboard();
  if (view === "customers") renderCustomers();
  if (view === "statement") renderStatement(state.currentCustomerId);
  if (view === "newTransaction") renderNewTransactionPage();
  if (view === "search") { $("#searchInput").value = ""; renderSearchResults(""); }
  if (view === "reports") renderReportsPage();
  if (view === "alerts") renderAlertsPage();
  if (view === "backup") renderBackupPage();
  if (view === "settings") renderSettingsPage();
}

function setupNav() {
  $all(".nav-item").forEach((item) => {
    item.onclick = () => navigate(item.dataset.view);
  });
  // شريط جوال يعكس نفس عناصر الشريط الجانبي (تم توسيعه ليشمل التنبيهات والنسخ والاعدادات)
  const mobileBar = $("#mobileTabbar");
  const items = ["dashboard","customers","newTransaction","search","reports","alerts","backup","settings"];
  const icons = {
    dashboard: "📊", customers: "👥", newTransaction: "➕",
    search: "🔍", reports: "📅", alerts: "🔔", backup: "💾", settings: "⚙️"
  };
  const labels = {
    dashboard: "الرئيسية", customers: "العملاء", newTransaction: "عملية",
    search: "بحث", reports: "تقارير", alerts: "التنبيهات", backup: "النسخ", settings: "الإعدادات"
  };
  mobileBar.innerHTML = items.map((v) => `<div class="nav-item" data-view="${v}"><span class="ic">${icons[v]}</span>${labels[v]}</div>`).join("");
  $all(".nav-item", mobileBar).forEach((item) => { item.onclick = () => navigate(item.dataset.view); });
}

/* ------------------------------- لوحة التحكم -------------------------------- */

async function renderDashboard() {
  await refreshCaches();
  const customers = state.customersCache.filter((c) => !c.archived);
  let totalDebt = 0, totalPaid = 0;
  const balances = customers.map((c) => {
    const b = balanceOf(c.id);
    totalDebt += b.debt; totalPaid += b.paid;
    return { customer: c, ...b };
  });
  const remaining = totalDebt - totalPaid;
  const maxLimit = await Settings.get("maxDebtLimit", 5000);
  const delayDays = await Settings.get("delayDays", 30);
  const today = new Date();
  let overdueCount = 0;
  balances.forEach((b) => {
    const txns = txnsFor(b.customer.id);
    const last = txns.length ? txns[txns.length - 1].date : null;
    if (last && b.remaining > 0) {
      const diff = Math.floor((today - new Date(last)) / 86400000);
      if (diff > delayDays) overdueCount++;
    }
  });

  $("#dashStats").innerHTML = `
    <div class="stat brand"><div class="label">عدد العملاء</div><div class="value">${customers.length}</div></div>
    <div class="stat debt"><div class="label">إجمالي الديون</div><div class="value">${fmtMoney(totalDebt)}</div></div>
    <div class="stat pay"><div class="label">إجمالي السداد</div><div class="value">${fmtMoney(totalPaid)}</div></div>
    <div class="stat ${remaining > 0 ? "debt" : "pay"}"><div class="label">الرصيد المتبقي</div><div class="value">${fmtMoney(remaining)}</div></div>
  `;

  const topDebtors = balances.filter((b) => b.remaining > 0).sort((a, b) => b.remaining - a.remaining).slice(0, 6);
  $("#topDebtors").innerHTML = topDebtors.length ? topDebtors.map((b) => `
    <div class="alert-row danger" style="justify-content:space-between;cursor:pointer;" data-goto="${b.customer.id}">
      <span>${escapeHtml(b.customer.name)}</span><b>${fmtMoney(b.remaining)}</b>
    </div>`).join("") : `<div class="empty-state"><div class="ic">✅</div>لا يوجد عملاء عليهم ديون حاليًا</div>`;
  $all("[data-goto]", $("#topDebtors")).forEach((el) => el.onclick = () => openStatement(Number(el.dataset.goto)));

  const recent = [...state.txnsCache].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 8);
  const nameMap = new Map(state.customersCache.map((c) => [c.id, c.name]));
  $("#recentTxns").innerHTML = recent.length ? recent.map((t) => `
    <div class="alert-row ${t.type === "debt" ? "danger" : "warn"}" style="justify-content:space-between;">
      <span>${escapeHtml(nameMap.get(t.customerId) || "—")} <span class="pill ${t.type}">${t.type === "debt" ? "دين" : "سداد"}</span></span>
      <span><b>${fmtMoney(t.amount)}</b> — ${t.date}</span>
    </div>`).join("") : `<div class="empty-state"><div class="ic">🗒️</div>لا توجد عمليات مسجلة بعد</div>`;

  if (overdueCount > 0) toast(`⚠️ لديك ${overdueCount} عميل متأخر عن السداد`);
}

/* ---------------------------------- العملاء --------------------------------- */

async function renderCustomers() {
  await refreshCaches();
  const filterText = ($("#customersFilterInput").value || "").trim().toLowerCase();
  const sortMode = $("#customersSort").value;
  let list = state.customersCache.filter((c) => !!c.archived === state.showArchived);
  if (filterText) {
    list = list.filter((c) => (c.name || "").toLowerCase().includes(filterText) || (c.phone || "").includes(filterText));
  }
  const withBalance = list.map((c) => ({ customer: c, ...balanceOf(c.id), lastDate: (txnsFor(c.id).slice(-1)[0]?.date || "") }));

  if (sortMode === "name") withBalance.sort((a, b) => a.customer.name.localeCompare(b.customer.name, "ar"));
  else if (sortMode === "balance_desc") withBalance.sort((a, b) => b.remaining - a.remaining);
  else if (sortMode === "recent") withBalance.sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  else withBalance.sort((a, b) => (b.customer.pinned ? 1 : 0) - (a.customer.pinned ? 1 : 0));

  $("#toggleArchivedBtn").textContent = state.showArchived ? "عرض النشطين" : "عرض المؤرشفين";

  $("#customersGrid").innerHTML = withBalance.length ? withBalance.map(({ customer, remaining }) => {
    const status = remaining > 0 ? "status-debt" : remaining < 0 ? "status-clear" : "status-zero";
    const label = remaining > 0 ? "عليه" : remaining < 0 ? "له رصيد" : "مسدد بالكامل";
    const pillClass = remaining > 0 ? "danger" : remaining < 0 ? "ok" : "warn";
    return `
    <div class="customer-card ${status}" data-id="${customer.id}">
      ${customer.pinned ? '<div class="pin-badge">📌</div>' : ""}
      <div class="name">${escapeHtml(customer.name)}</div>
      <div class="phone">📞 ${escapeHtml(customer.phone || "بدون رقم هاتف")}</div>
      <div class="balance">${fmtMoney(Math.abs(remaining))}</div>
      <div><span class="pill ${pillClass}">${label}</span></div>
    </div>`;
  }).join("") : `<div class="empty-state"><div class="ic">👤</div>لا يوجد عملاء ${state.showArchived ? "مؤرشفون" : ""} — أضف عميلًا جديدًا للبدء</div>`;

  $all(".customer-card", $("#customersGrid")).forEach((card) => {
    card.onclick = () => openStatement(Number(card.dataset.id));
  });

  $("#addCustomerBtn").onclick = () => customerModal(null);
  $("#customersFilterInput").oninput = renderCustomers;
  $("#customersSort").onchange = renderCustomers;
  $("#toggleArchivedBtn").onclick = () => { state.showArchived = !state.showArchived; renderCustomers(); };
}

/* ------------------------------- كشف الحساب --------------------------------- */

function openStatement(customerId) {
  state.currentCustomerId = customerId;
  navigate("statement");
}

async function renderStatement(customerId) {
  await refreshCaches();
  const customer = state.customersCache.find((c) => c.id === customerId);
  if (!customer) { navigate("customers"); return; }
  const txns = txnsFor(customerId);
  const { debt, paid, remaining } = Transactions.balanceFor(txns);
  $("#pageTitle").textContent = customer.name;
  $("#pageSub").textContent = customer.phone ? `📞 ${customer.phone}` : "كشف حساب العميل";

  const statusText = remaining > 0 ? "عليه دين" : remaining < 0 ? "له رصيد" : "مسدد بالكامل";
  $("#statementReceipt").innerHTML = `
    <div class="stamp">${customer.archived ? "مؤرشف" : statusText}</div>
    <div class="receipt-head">
      <div class="cname">${escapeHtml(customer.name)}</div>
      <div class="cmeta">${customer.phone ? "📞 " + escapeHtml(customer.phone) : "📞 بدون رقم هاتف"}${customer.address ? " — " + escapeHtml(customer.address) : ""}</div>
      ${customer.notes ? `<div class="cmeta">📝 ${escapeHtml(customer.notes)}</div>` : ""}
    </div>
    <div class="receipt-balance">
      <div class="field-hint" style="text-align:center;">الرصيد</div>
      <div class="amt" style="color:${remaining > 0 ? "var(--debt)" : remaining < 0 ? "var(--pay)" : "var(--ink)"}">${fmtMoney(Math.abs(remaining))}</div>
      <div class="cap"><span class="pill ${remaining > 0 ? "danger" : remaining < 0 ? "ok" : "warn"}">${statusText}</span></div>
    </div>
    <div class="grid cols-2" style="text-align:center;">
      <div><div class="field-hint">إجمالي الدين</div><b style="color:var(--debt)">${fmtMoney(debt)}</b></div>
      <div><div class="field-hint">إجمالي السداد</div><b style="color:var(--pay)">${fmtMoney(paid)}</b></div>
    </div>
  `;

  $("#statementTable tbody").innerHTML = txns.length ? txns.map((t) => `
    <tr>
      <td>${t.date}</td>
      <td><span class="pill ${t.type}">${t.type === "debt" ? "دين" : "سداد"}</span></td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${escapeHtml(t.note || "—")}</td>
      <td class="no-print">
        <button class="secondary sm" data-edit="${t.id}">✏️</button>
        <button class="danger sm" data-del="${t.id}">🗑️</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">لا توجد عمليات مسجلة لهذا العميل بعد</div></td></tr>`;

  $all("[data-edit]", $("#statementTable")).forEach((b) => b.onclick = () => {
    const t = txns.find((x) => x.id === Number(b.dataset.edit));
    transactionModal({ customerId, existing: t });
  });
  $all("[data-del]", $("#statementTable")).forEach((b) => b.onclick = () => {
    confirmDialog("هل تريد حذف هذه العملية نهائيًا؟", async () => {
      await Transactions.remove(Number(b.dataset.del));
      toast("تم حذف العملية");
      await refreshCaches(); renderStatement(customerId);
    });
  });

  $("#backToCustomersBtn").onclick = () => navigate("customers");
  $("#stAddDebtBtn").onclick = () => transactionModal({ customerId, type: "debt" });
  $("#stAddPaymentBtn").onclick = () => transactionModal({ customerId, type: "payment" });
  $("#stSettleBtn").onclick = () => {
    if (remaining === 0) { toast("الحساب مصفّى بالفعل — لا يوجد رصيد متبقٍ"); return; }
    const settleType = remaining > 0 ? "payment" : "debt";
    const settleLabel = remaining > 0 ? "تسجيل سداد كامل للمتبقي" : "تسجيل دين معادل للرصيد الزائد";
    confirmDialog(`سيتم ${settleLabel} بقيمة ${fmtMoney(Math.abs(remaining))} لتصفية الحساب إلى صفر. متابعة؟`, async () => {
      await Transactions.add({ customerId, type: settleType, amount: Math.abs(remaining), date: todayStr(), note: "تصفية حساب" });
      toast("تمت تصفية الحساب بنجاح");
      await refreshCaches(); renderStatement(customerId);
    });
  };
  $("#stEditCustomerBtn").onclick = () => customerModal(customer);
  $("#stPinBtn").onclick = async () => { await Customers.setPinned(customerId, !customer.pinned); toast(customer.pinned ? "أُلغي التثبيت" : "تم التثبيت"); await refreshCaches(); renderStatement(customerId); };
  $("#stArchiveBtn").onclick = async () => { await Customers.setArchived(customerId, !customer.archived); toast(customer.archived ? "تمت الاستعادة" : "تمت الأرشفة"); await refreshCaches(); renderStatement(customerId); };
  $("#stPrintBtn").onclick = () => window.print();
  $("#stExcelBtn").onclick = () => exportTxnsToExcel(txns, `كشف_حساب_${customer.name}`);
  $("#stDeleteBtn").onclick = () => confirmDialog(`سيتم حذف "${customer.name}" وكل عملياته نهائيًا. متابعة؟`, async () => {
    await Customers.remove(customerId);
    toast("تم حذف العميل");
    navigate("customers");
  });
}

/* ------------------------------- عملية جديدة --------------------------------- */

async function renderNewTransactionPage() {
  await refreshCaches();
  const active = state.customersCache.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  $("#ntCustomer").innerHTML = active.length
    ? active.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
    : `<option value="">لا يوجد عملاء — أضف عميلًا أولًا</option>`;
  $("#ntDate").value = todayStr();
  $("#ntAmount").value = "";
  $("#ntNote").value = "";
  $("#ntSaveBtn").onclick = async () => {
    const customerId = Number($("#ntCustomer").value);
    if (!customerId) { toast("أضف عميلًا أولًا من صفحة العملاء"); return; }
    const amount = parseFloat($("#ntAmount").value);
    if (!amount || amount <= 0) { toast("أدخل مبلغًا صحيحًا"); return; }
    await Transactions.add({
      customerId, type: $("#ntType").value, amount,
      date: $("#ntDate").value || todayStr(), note: $("#ntNote").value.trim(),
    });
    toast("تم حفظ العملية بنجاح");
    await refreshCaches();
    $("#ntAmount").value = ""; $("#ntNote").value = "";
  };
}

/* ----------------------------------- البحث ------------------------------------ */

function setupSearch() {
  $("#searchInput").oninput = (e) => renderSearchResults(e.target.value.trim().toLowerCase());
}
function renderSearchResults(q) {
  const nameMap = new Map(state.customersCache.map((c) => [c.id, c.name]));
  if (!q) { $("#searchCustomers").innerHTML = ""; $("#searchTxnsTable tbody").innerHTML = ""; return; }
  const matchedCustomers = state.customersCache.filter((c) =>
    (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q) || (c.notes || "").toLowerCase().includes(q));
  $("#searchCustomers").innerHTML = matchedCustomers.length ? matchedCustomers.map((c) => `
    <div class="alert-row warn" style="justify-content:space-between;cursor:pointer;" data-goto="${c.id}">
      <span>${escapeHtml(c.name)} — ${escapeHtml(c.phone || "")}</span>
      <b>${fmtMoney(Math.abs(balanceOf(c.id).remaining))}</b>
    </div>`).join("") : `<div class="empty-state">لا توجد نتائج عملاء</div>`;
  $all("[data-goto]", $("#searchCustomers")).forEach((el) => el.onclick = () => openStatement(Number(el.dataset.goto)));

  const matchedTxns = state.txnsCache.filter((t) =>
    (t.note || "").toLowerCase().includes(q) || String(t.amount).includes(q) || (t.date || "").includes(q) ||
    (t.type === "debt" && "دين".includes(q)) || (t.type === "payment" && "سداد".includes(q)) ||
    (nameMap.get(t.customerId) || "").toLowerCase().includes(q));
  $("#searchTxnsTable tbody").innerHTML = matchedTxns.length ? matchedTxns.map((t) => `
    <tr><td class="name-cell">${escapeHtml(nameMap.get(t.customerId) || "—")}</td><td>${t.date}</td>
    <td><span class="pill ${t.type}">${t.type === "debt" ? "دين" : "سداد"}</span></td>
    <td>${fmtMoney(t.amount)}</td><td>${escapeHtml(t.note || "—")}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty-state">لا توجد نتائج عمليات</div></td></tr>`;
}

/* ---------------------------------- التقارير ----------------------------------- */

async function renderReportsPage() {
  await refreshCaches();
  const sel = $("#repCustomer");
  sel.innerHTML = `<option value="">كل العملاء</option>` + state.customersCache
    .sort((a, b) => a.name.localeCompare(b.name, "ar"))
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  $("#repRunBtn").onclick = runReport;
  $("#repPrintBtn").onclick = () => window.print();
  $("#repExcelBtn").onclick = () => exportTxnsToExcel(getReportRows(), "تقرير");
  $("#repCsvBtn").onclick = () => exportReportCsv(getReportRows());
  runReport();
}
let _lastReportRows = [];
function getReportRows() { return _lastReportRows; }

function runReport() {
  const from = $("#repFrom").value, to = $("#repTo").value;
  const customerId = $("#repCustomer").value ? Number($("#repCustomer").value) : null;
  const type = $("#repType").value;
  let rows = [...state.txnsCache];
  if (from) rows = rows.filter((t) => t.date >= from);
  if (to) rows = rows.filter((t) => t.date <= to);
  if (customerId) rows = rows.filter((t) => t.customerId === customerId);
  if (type) rows = rows.filter((t) => t.type === type);
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  _lastReportRows = rows;

  const nameMap = new Map(state.customersCache.map((c) => [c.id, c.name]));
  const { debt, paid, remaining } = Transactions.balanceFor(rows);
  $("#repStats").innerHTML = `
    <div class="stat debt"><div class="label">إجمالي الديون في الفترة</div><div class="value">${fmtMoney(debt)}</div></div>
    <div class="stat pay"><div class="label">إجمالي السداد في الفترة</div><div class="value">${fmtMoney(paid)}</div></div>
    <div class="stat brand"><div class="label">صافي الحركة</div><div class="value">${fmtMoney(remaining)}</div></div>
  `;
  $("#repTable tbody").innerHTML = rows.length ? rows.map((t) => `
    <tr><td>${t.date}</td><td class="name-cell">${escapeHtml(nameMap.get(t.customerId) || "—")}</td>
    <td><span class="pill ${t.type}">${t.type === "debt" ? "دين" : "سداد"}</span></td>
    <td>${fmtMoney(t.amount)}</td><td>${escapeHtml(t.note || "—")}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty-state">لا توجد عمليات ضمن هذا الفلتر</div></td></tr>`;
}

function exportTxnsToExcel(rows, filenameBase) {
  if (typeof XLSX === "undefined") { toast("مكتبة تصدير Excel غير محمّلة"); return; }
  if (!rows || !rows.length) { toast("⚠️ لا توجد عمليات مسجلة لهذا العميل بعد — سجّل دينًا أو سدادًا أولًا"); return; }

  const custById = new Map(state.customersCache.map((c) => [c.id, c]));

  // ---- ورقة الملخص: إجمالي الدين/السداد/المتبقي والحالة لكل عميل ----
  const groups = new Map();
  rows.forEach((t) => {
    if (!groups.has(t.customerId)) groups.set(t.customerId, { debt: 0, paid: 0 });
    const g = groups.get(t.customerId);
    if (t.type === "debt") g.debt += Number(t.amount) || 0;
    else g.paid += Number(t.amount) || 0;
  });
  const summaryRows = [...groups.entries()].map(([cid, g]) => {
    const c = custById.get(cid);
    const remaining = g.debt - g.paid;
    return {
      "العميل": c ? c.name : "—",
      "الهاتف": c ? (c.phone || "") : "",
      "إجمالي الدين": Number(g.debt.toFixed(2)),
      "إجمالي السداد": Number(g.paid.toFixed(2)),
      "الرصيد المتبقي": Number(Math.abs(remaining).toFixed(2)),
      "الحالة": remaining > 0 ? "عليه" : remaining < 0 ? "له رصيد" : "مسدد بالكامل",
    };
  });
  // صف إجمالي عام في نهاية الملخص
  const grandDebt = summaryRows.reduce((s, r) => s + r["إجمالي الدين"], 0);
  const grandPaid = summaryRows.reduce((s, r) => s + r["إجمالي السداد"], 0);
  summaryRows.push({
    "العميل": "الإجمالي العام", "الهاتف": "",
    "إجمالي الدين": Number(grandDebt.toFixed(2)),
    "إجمالي السداد": Number(grandPaid.toFixed(2)),
    "الرصيد المتبقي": Number(Math.abs(grandDebt - grandPaid).toFixed(2)),
    "الحالة": grandDebt - grandPaid > 0 ? "عليهم" : grandDebt - grandPaid < 0 ? "لهم رصيد" : "مسدد بالكامل",
  });

  // ---- ورقة التفاصيل: كل عملية على حدة ----
  const detailRows = rows.map((t) => {
    const c = custById.get(t.customerId);
    return {
      "العميل": c ? c.name : "—",
      "التاريخ": t.date,
      "النوع": t.type === "debt" ? "دين" : "سداد",
      "المبلغ": Number((Number(t.amount) || 0).toFixed(2)),
      "ملاحظة": t.note || "",
    };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "الملخص");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), "تفاصيل العمليات");
  XLSX.writeFile(wb, `${filenameBase}_${Date.now()}.xlsx`);
}
function exportReportCsv(rows) {
  if (!rows || !rows.length) { toast("⚠️ لا توجد عمليات مسجلة لهذا العميل بعد — سجّل دينًا أو سدادًا أولًا"); return; }
  const custById = new Map(state.customersCache.map((c) => [c.id, c]));
  const groups = new Map();
  rows.forEach((t) => {
    if (!groups.has(t.customerId)) groups.set(t.customerId, { debt: 0, paid: 0 });
    const g = groups.get(t.customerId);
    if (t.type === "debt") g.debt += Number(t.amount) || 0; else g.paid += Number(t.amount) || 0;
  });

  const lines = ["ملخص الأرصدة", "العميل,الهاتف,إجمالي الدين,إجمالي السداد,الرصيد المتبقي,الحالة"];
  for (const [cid, g] of groups.entries()) {
    const c = custById.get(cid);
    const remaining = g.debt - g.paid;
    const status = remaining > 0 ? "عليه" : remaining < 0 ? "له رصيد" : "مسدد بالكامل";
    lines.push([c ? c.name : "—", c ? (c.phone || "") : "", g.debt.toFixed(2), g.paid.toFixed(2), Math.abs(remaining).toFixed(2), status].join(","));
  }
  lines.push("");
  lines.push("تفاصيل العمليات");
  lines.push("العميل,التاريخ,النوع,المبلغ,ملاحظة");
  rows.forEach((t) => {
    const c = custById.get(t.customerId);
    lines.push([c ? c.name : "—", t.date, t.type === "debt" ? "دين" : "سداد", t.amount, (t.note || "").replace(/,/g, " ")].join(","));
  });
  download(`تقرير_${Date.now()}.csv`, "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8;");
}

/* ---------------------------------- التنبيهات ----------------------------------- */

async function renderAlertsPage() {
  const maxLimit = await Settings.get("maxDebtLimit", 5000);
  const delayDays = await Settings.get("delayDays", 30);
  $("#maxDebtLimit").value = maxLimit;
  $("#delayDays").value = delayDays;
  $("#saveAlertsBtn").onclick = async () => {
    await Settings.set("maxDebtLimit", parseFloat($("#maxDebtLimit").value) || 0);
    await Settings.set("delayDays", parseInt($("#delayDays").value) || 0);
    toast("تم حفظ إعدادات التنبيهات");
    computeAndShowAlerts();
  };
  computeAndShowAlerts();
}

async function computeAndShowAlerts() {
  await refreshCaches();
  const maxLimit = await Settings.get("maxDebtLimit", 5000);
  const delayDays = await Settings.get("delayDays", 30);
  const today = new Date();
  const alerts = [];
  for (const c of state.customersCache.filter((c) => !c.archived)) {
    const txns = txnsFor(c.id);
    const { remaining } = Transactions.balanceFor(txns);
    if (remaining > maxLimit) alerts.push({ level: "danger", text: `⚠️ ${c.name}: تجاوز سقف الدين (المتبقي ${fmtMoney(remaining)} > ${fmtMoney(maxLimit)})` });
    const last = txns.length ? txns[txns.length - 1].date : null;
    if (last && remaining > 0) {
      const diff = Math.floor((today - new Date(last)) / 86400000);
      if (diff > delayDays) alerts.push({ level: "warn", text: `⏰ ${c.name}: تأخر عن السداد منذ ${diff} يومًا (آخر عملية ${last})` });
    }
  }
  const box = $("#alertsList");
  if (box) {
    box.innerHTML = alerts.length ? alerts.map((a) => `<div class="alert-row ${a.level}">${a.text}</div>`).join("") : `<div class="empty-state"><div class="ic">✅</div>لا توجد تنبيهات حاليًا</div>`;
  }
  if (alerts.length && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification("تنبيهات دفتر الحسابات", { body: `لديك ${alerts.length} تنبيه يحتاج مراجعة` }); } catch (e) { /* بعض البيئات تمنع الإشعارات */ }
  }
  return alerts;
}

/* -------------------------------- النسخ الاحتياطي -------------------------------- */

async function renderBackupPage() {
  const last = await Settings.get("lastBackupAt", null);
  $("#lastBackupInfo").textContent = last
    ? `آخر نسخة احتياطية: ${new Date(last).toLocaleString("ar-EG")}`
    : "لم يتم إنشاء أي نسخة احتياطية بعد — يُنصح بإنشاء نسخة الآن.";

  $("#exportJsonBtn").onclick = async () => {
    const data = await Backup.exportAll();
    download(`نسخة_احتياطية_${Date.now()}.json`, JSON.stringify(data, null, 2), "application/json");
    await Settings.set("lastBackupAt", new Date().toISOString());
    toast("تم تنزيل النسخة الاحتياطية بنجاح");
    renderBackupPage();
  };

  $("#importJsonBtn").onclick = () => $("#importJsonFile").click();
  $("#importJsonFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      openModal(`
        <h3>استيراد نسخة احتياطية</h3>
        <p class="field-hint">الملف يحتوي على ${data.customers?.length ?? 0} عميل و ${data.transactions?.length ?? 0} عملية.</p>
        <p>اختر طريقة الاستيراد:</p>
        <div class="btn-row" style="flex-direction:column;">
          <button id="impMerge">➕ دمج مع البيانات الحالية</button>
          <button id="impReplace" class="danger">♻️ استبدال كل البيانات الحالية</button>
          <button id="impCancel" class="secondary">إلغاء</button>
        </div>
      `);
      $("#impCancel").onclick = closeModal;
      $("#impMerge").onclick = async () => { await doImport(data, "merge"); };
      $("#impReplace").onclick = () => confirmDialog("سيتم حذف كل البيانات الحالية نهائيًا واستبدالها. متابعة؟", async () => { await doImport(data, "replace"); });
    } catch (err) {
      toast("تعذّرت قراءة الملف — تأكد أنه نسخة احتياطية صالحة");
    }
    e.target.value = "";
  };

  const audit = await Audit.recent(100);
  $("#auditTable tbody").innerHTML = audit.length ? audit.map((a) => `
    <tr><td>${new Date(a.date).toLocaleString("ar-EG")}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.details || "")}</td></tr>
  `).join("") : `<tr><td colspan="3"><div class="empty-state">لا يوجد نشاط مسجل بعد</div></td></tr>`;
}
async function doImport(data, mode) {
  try {
    await Backup.importAll(data, mode);
    closeModal();
    toast("تم استيراد النسخة الاحتياطية بنجاح");
    await refreshCaches();
    renderBackupPage();
  } catch (err) {
    toast("فشل الاستيراد: " + err.message);
  }
}

/* ---------------------------------- الإعدادات ------------------------------------ */

async function renderSettingsPage() {
  $("#setLightBtn").onclick = () => setTheme("light");
  $("#setDarkBtn").onclick = () => setTheme("dark");
  const pinHash = await Settings.get("pinHash", null);
  $("#pinStatus").textContent = pinHash ? "🔒 الحماية برمز PIN مُفعّلة." : "🔓 لا توجد حماية برمز PIN حاليًا.";
  $("#setPinBtn").onclick = () => pinSetupModal();
  $("#removePinBtn").onclick = () => confirmDialog("إزالة حماية PIN؟", async () => {
    await Settings.set("pinHash", null); toast("تمت إزالة الحماية"); renderSettingsPage();
  });

  $("#goBackupBeforeWipeBtn").onclick = () => navigate("backup");
  $("#wipeAllBtn").onclick = () => wipeAllDataModal();
}

function wipeAllDataModal() {
  const box = openModal(`
    <h3 style="color:var(--debt);">⚠️ مسح جميع البيانات نهائيًا</h3>
    <p>سيتم حذف كل العملاء وكل العمليات وسجل النشاط من هذا الجهاز بشكل نهائي ولا يمكن التراجع عنه إلا باستعادة نسخة احتياطية.</p>
    <p>للتأكيد، اكتب كلمة <b>مسح</b> في الحقل أدناه:</p>
    <input id="wipeConfirmText" placeholder="اكتب: مسح">
    <div class="btn-row" style="justify-content:flex-end;margin-top:8px;">
      <button class="secondary" id="wipeCancel">إلغاء</button>
      <button class="danger" id="wipeConfirmBtn">🗑️ مسح كل شيء نهائيًا</button>
    </div>
  `);
  $("#wipeCancel", box).onclick = closeModal;
  $("#wipeConfirmBtn", box).onclick = async () => {
    if ($("#wipeConfirmText", box).value.trim() !== "مسح") { toast("اكتب كلمة \"مسح\" بالضبط للتأكيد"); return; }
    await SystemOps.wipeAll();
    closeModal();
    toast("تم مسح جميع البيانات");
    await refreshCaches();
    navigate("dashboard");
  };
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pinSetupModal() {
  const box = openModal(`
    <h3>تعيين رمز PIN (٤ أرقام)</h3>
    <input type="password" inputmode="numeric" maxlength="4" id="pinNew" placeholder="أدخل رمزًا من 4 أرقام">
    <input type="password" inputmode="numeric" maxlength="4" id="pinConfirm" placeholder="تأكيد الرمز">
    <div class="btn-row" style="justify-content:flex-end;margin-top:8px;">
      <button class="secondary" id="pinCancel">إلغاء</button>
      <button id="pinSave">💾 حفظ</button>
    </div>
  `);
  $("#pinCancel", box).onclick = closeModal;
  $("#pinSave", box).onclick = async () => {
    const a = $("#pinNew", box).value, b = $("#pinConfirm", box).value;
    if (!/^\d{4}$/.test(a)) { toast("الرمز يجب أن يكون 4 أرقام"); return; }
    if (a !== b) { toast("الرمزان غير متطابقين"); return; }
    await Settings.set("pinHash", await sha256(a));
    closeModal(); toast("تم تفعيل الحماية"); renderSettingsPage();
  };
}

/* ---------------------------------- الثيم (فاتح/داكن) ----------------------------- */

function setTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  Settings.set("theme", mode);
  $("#themeToggleBtn").textContent = mode === "dark" ? "☀️" : "🌙";
}
async function initTheme() {
  const saved = await Settings.get("theme", "light");
  setTheme(saved);
  $("#themeToggleBtn").onclick = () => setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
}

/* --------------------------------- قفل PIN ---------------------------------------- */

let pinBuffer = "";
let pinTargetHash = null;
let inactivityTimer = null;

function buildPinPad() {
  const pad = $("#pinPad");
  const keys = ["1","2","3","4","5","6","7","8","9","⌫","0","✔"];
  pad.innerHTML = keys.map((k) => `<button data-k="${k}">${k}</button>`).join("");
  $all("[data-k]", pad).forEach((btn) => btn.onclick = () => onPinKey(btn.dataset.k));
  renderPinDots();
}
function renderPinDots() {
  $("#pinDots").innerHTML = [0, 1, 2, 3].map((i) => `<div class="pin-dot ${i < pinBuffer.length ? "filled" : ""}"></div>`).join("");
}
async function onPinKey(k) {
  if (k === "⌫") { pinBuffer = pinBuffer.slice(0, -1); renderPinDots(); return; }
  if (k === "✔") { await tryUnlock(); return; }
  if (pinBuffer.length < 4) pinBuffer += k;
  renderPinDots();
  if (pinBuffer.length === 4) await tryUnlock();
}
async function tryUnlock() {
  const hash = await sha256(pinBuffer);
  if (hash === pinTargetHash) {
    pinBuffer = "";
    $("#lockScreen").style.display = "none";
    $("#pinError").textContent = "";
    resetInactivityTimer();
  } else {
    $("#pinError").textContent = "رمز غير صحيح، حاول مجددًا";
    pinBuffer = "";
    renderPinDots();
  }
}
async function checkLockOnStart() {
  pinTargetHash = await Settings.get("pinHash", null);
  if (pinTargetHash) showLockScreen();
}
function showLockScreen() {
  pinBuffer = "";
  buildPinPad();
  $("#lockScreen").style.display = "flex";
}
function resetInactivityTimer() {
  if (!pinTargetHash) return;
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => { showLockScreen(); }, 5 * 60 * 1000); // 5 دقائق خمول
}
["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, resetInactivityTimer));

/* ------------------------------------ PWA ----------------------------------------- */

let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  $("#installPwaBtn").style.display = "inline-block";
});
function setupPwaInstall() {
  $("#installPwaBtn").onclick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      $("#installPwaBtn").style.display = "none";
      deferredPrompt = null;
    } else {
      toast("ثبّت التطبيق يدويًا من قائمة المتصفح (⋮) ← تثبيت التطبيق");
    }
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

window.addEventListener("error", (e) => {
  console.error("خطأ غير متوقع:", e.error || e.message);
  toast("⚠️ حدث خطأ غير متوقع: " + (e.error?.message || e.message || "راجع وحدة التحكم للتفاصيل"), 5000);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("خطأ غير متوقع (Promise):", e.reason);
  toast("⚠️ حدث خطأ غير متوقع: " + (e.reason?.message || e.reason || "راجع وحدة التحكم للتفاصيل"), 5000);
});

/* -------------------------------------- بدء التشغيل -------------------------------- */

(async () => {
  try {
    await openDB();
    await initTheme();
    setupNav();
    setupSearch();
    setupPwaInstall();
    await checkLockOnStart();
    resetInactivityTimer();

    const hasDefaults = await Settings.get("maxDebtLimit", null);
    if (hasDefaults === null) { await Settings.set("maxDebtLimit", 5000); await Settings.set("delayDays", 30); }

    const migration = await migrateFromLegacyIfNeeded();
    await refreshCaches();
    navigate("dashboard");

    if (migration.migrated) {
      toast(`✅ تم ترحيل ${migration.records} سجل قديم إلى ${migration.customers} عميل بنجاح`, 5000);
    }
    try {
      if (typeof Notification !== "undefined" && Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission();
      }
    } catch (e) { /* بعض بيئات المعاينة تمنع الإشعارات نهائيًا — نتجاهل بأمان */ }
    setInterval(computeAndShowAlerts, 5 * 60 * 1000);
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<div style="padding:40px;text-align:center;font-family:sans-serif;">
      <h2>حدث خطأ أثناء تشغيل التطبيق</h2><p>${escapeHtml(err.message || String(err))}</p>
      <p>إن كانت لديك نسخة احتياطية JSON محفوظة سابقًا يمكنك استعادتها بعد إصلاح المشكلة.</p></div>`;
  }
})();
