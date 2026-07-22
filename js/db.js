/* =========================================================================
   db.js — طبقة قاعدة البيانات (IndexedDB)
   البنية: Customers (عملاء) + Transactions (عمليات: دين/سداد) + Settings
   يحافظ على توافق تلقائي مع بيانات النظام القديم (متجر "debts" المسطّح)
   محدث: أضيفنا حقول monthlySalary و balance وتحديثات تلقائية للرصيد عند تسجيل/تعديل/حذف العمليات
   ========================================================================= */

const DB_NAME = "DebtSystemFinal"; // نفس اسم قاعدة النظام القديم عمدًا
const DB_VERSION = 2; // كانت 1 في النظام القديم (متجر debts فقط) — رفعها هنا يشغّل onupgradeneeded
// على بيانات المستخدم الحالية ويضيف المتاجر الجديدة دون فقدان متجر "debts" القديم،
// فيصبح بإمكاننا قراءته وترحيله لاحقًا من نفس القاعدة.
const OLD_STORE = "debts";
const S_CUSTOMERS = "customers";
const S_TRANSACTIONS = "transactions";
const S_SETTINGS = "settings";
const S_AUDIT = "audit";

let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("هذه البيئة لا تدعم تخزين البيانات محليًا (IndexedDB). جرّب فتح الملف مباشرة في متصفح كامل (كروم أو سفاري) بدل معاينة مصغّرة."));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new Error("تعذّر فتح قاعدة البيانات المحلية: " + e.message));
      return;
    }

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(S_CUSTOMERS)) {
        const s = db.createObjectStore(S_CUSTOMERS, { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("phone", "phone", { unique: false });
        s.createIndex("archived", "archived", { unique: false });
        s.createIndex("pinned", "pinned", { unique: false });
      }

      if (!db.objectStoreNames.contains(S_TRANSACTIONS)) {
        const t = db.createObjectStore(S_TRANSACTIONS, { keyPath: "id", autoIncrement: true });
        t.createIndex("customerId", "customerId", { unique: false });
        t.createIndex("date", "date", { unique: false });
        t.createIndex("type", "type", { unique: false });
        t.createIndex("customerId_date", ["customerId", "date"], { unique: false });
      }

      if (!db.objectStoreNames.contains(S_SETTINGS)) {
        db.createObjectStore(S_SETTINGS, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(S_AUDIT)) {
        const a = db.createObjectStore(S_AUDIT, { keyPath: "id", autoIncrement: true });
        a.createIndex("date", "date", { unique: false });
      }
      // ملاحظة: متجر "debts" القديم (إن وُجد من نسخة سابقة) يبقى كما هو هنا
      // وتتم قراءته/هجرته لاحقًا بعد فتح القاعدة عبر migrateFromLegacyIfNeeded().
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode = "readonly") {
  return _db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------- عملاء (Customers) --------------------------- */

const Customers = {
  async all() {
    const store = tx(S_CUSTOMERS).objectStore(S_CUSTOMERS);
    return reqToPromise(store.getAll());
  },
  async get(id) {
    const store = tx(S_CUSTOMERS).objectStore(S_CUSTOMERS);
    return reqToPromise(store.get(id));
  },
  async add(customer) {
    const store = tx(S_CUSTOMERS, "readwrite").objectStore(S_CUSTOMERS);
    const monthlySalary = Number(customer.monthlySalary) || 0;
    const payload = {
      name: customer.name || "",
      phone: customer.phone || "",
      address: customer.address || "",
      notes: customer.notes || "",
      archived: false,
      pinned: false,
      monthlySalary: monthlySalary, // راتب شهري (اختياري)
      // الرصيد الافتراضي: إن أعطينا monthlySalary نضعه، وإلا 0
      balance: Number(customer.balance ?? monthlySalary) || 0,
      createdAt: new Date().toISOString(),
    };
    const id = await reqToPromise(store.add(payload));
    await Audit.log("إضافة عميل", `تمت إضافة العميل: ${payload.name}`);
    return id;
  },
  async update(id, patch) {
    const store = tx(S_CUSTOMERS, "readwrite").objectStore(S_CUSTOMERS);
    const existing = await reqToPromise(store.get(id));
    if (!existing) return;
    // إذا غيّرنا monthlySalary ونريد الحفاظ على النمط: إذا كان الرصيد يساوي الراتب القديم
    // فنجعل الرصيد يتبع الراتب الجديد تلقائيًا، وإلا نترك الرصيد كما هو (المستخدم أدخله يدويًا سابقًا)
    const updated = { ...existing, ...patch };
    if (patch.hasOwnProperty("monthlySalary")) {
      const newSalary = Number(patch.monthlySalary) || 0;
      const oldSalary = Number(existing.monthlySalary) || 0;
      if (Number(existing.balance || 0) === oldSalary) {
        updated.balance = newSalary;
      }
      updated.monthlySalary = newSalary;
    }
    await reqToPromise(store.put(updated));
    await Audit.log("تعديل عميل", `تم تعديل بيانات: ${updated.name}`);
  },
  async remove(id) {
    const customer = await this.get(id);
    // حذف عمليات العميل أولًا (حذف كامل، وليس أرشفة)
    const txns = await Transactions.byCustomer(id);
    const store = tx([S_TRANSACTIONS], "readwrite").objectStore(S_TRANSACTIONS);
    for (const t of txns) await reqToPromise(store.delete(t.id));
    const cstore = tx(S_CUSTOMERS, "readwrite").objectStore(S_CUSTOMERS);
    await reqToPromise(cstore.delete(id));
    await Audit.log("حذف عميل", `تم حذف العميل وكل عملياته: ${customer ? customer.name : id}`);
  },
  async setArchived(id, archived) {
    await this.update(id, { archived: !!archived });
  },
  async setPinned(id, pinned) {
    await this.update(id, { pinned: !!pinned });
  },
};

/* -------------------------- عمليات (Transactions) ------------------------- */

const Transactions = {
  async all() {
    const store = tx(S_TRANSACTIONS).objectStore(S_TRANSACTIONS);
    return reqToPromise(store.getAll());
  },
  async byCustomer(customerId) {
    const store = tx(S_TRANSACTIONS).objectStore(S_TRANSACTIONS);
    const idx = store.index("customerId");
    const result = await reqToPromise(idx.getAll(IDBKeyRange.only(customerId)));
    return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  },

  /* دالة مساعدة داخلية: ضبط رصيد العميل داخل نفس المعاملة
     params: cstore (objectStore for customers), customerId, delta (number to add to balance)
  */
  async _applyBalanceChangeInTransaction(cstore, customerId, delta) {
    const cust = await reqToPromise(cstore.get(customerId));
    if (!cust) return;
    cust.balance = Number((Number(cust.balance || 0) + Number(delta || 0)).toFixed(2));
    await reqToPromise(cust ? cstore.put(cust) : Promise.resolve());
  },

  async add(t) {
    // نستخدم معاملة على المتجرين معًا لضمان تناسق أفضل
    const trx = tx([S_TRANSACTIONS, S_CUSTOMERS], "readwrite");
    const tstore = trx.objectStore(S_TRANSACTIONS);
    const cstore = trx.objectStore(S_CUSTOMERS);

    const payload = {
      customerId: t.customerId,
      type: t.type, // "debt" | "payment"
      amount: Number(t.amount) || 0,
      date: t.date || new Date().toISOString().slice(0, 10),
      note: t.note || "",
      createdAt: new Date().toISOString(),
    };
    const id = await reqToPromise(tstore.add(payload));

    // حدّث رصيد العميل: دين = نخصم الرصيد، سداد = نعيد الرصيد
    const customer = await reqToPromise(cstore.get(t.customerId));
    if (customer) {
      if (payload.type === "debt") {
        customer.balance = Number((Number(customer.balance || 0) - payload.amount).toFixed(2));
      } else {
        customer.balance = Number((Number(customer.balance || 0) + payload.amount).toFixed(2));
      }
      await reqToPromise(cstore.put(customer));
      await Audit.log(payload.type === "debt" ? "تسجيل دين" : "تسجيل سداد", `${customer.name} — ${payload.amount.toFixed(2)}`);
    } else {
      await Audit.log(payload.type === "debt" ? "تسجيل دين" : "تسجيل سداد", `عميل #${t.customerId} — ${payload.amount.toFixed(2)}`);
    }

    return id;
  },
  async update(id, patch) {
    // احصل على معاملتين داخل معاملة مشتركة لضمان الاتساق: عملية + عميل
    const trx = tx([S_TRANSACTIONS, S_CUSTOMERS], "readwrite");
    const tstore = trx.objectStore(S_TRANSACTIONS);
    const cstore = trx.objectStore(S_CUSTOMERS);

    const existing = await reqToPromise(tstore.get(id));
    if (!existing) return;
    const updated = { ...existing, ...patch };
    updated.amount = Number(patch.amount ?? existing.amount);

    // حساب التغيير في الرصيد (delta) الذي يجب تطبيقه على رصيد العميل
    const delta = (() => {
      // نرجع القيمة التي يجب إضافتها إلى رصيد العميل (موجبة أو سالبة)
      // حالة نفس النوع:
      //  - type === 'debt' => الرصيد انخفض سابقًا بمقدار existing.amount، والآن يجب أن ينخفض بمقدار updated.amount
      //    لذلك الفرق الذي يجب اضافته للرصد هو existing.amount - updated.amount
      //  - type === 'payment' => الرصيد زاد سابقًا بمقدار existing.amount، والآن يجب أن يزيد بمقدار updated.amount
      //    الفرق: updated.amount - existing.amount
      // حالة تغيّر النوع: نلغي أثر القديم ونطبّق أثر الجديد
      if (existing.type === updated.type) {
        if (updated.type === "debt") return Number(existing.amount) - Number(updated.amount);
        else return Number(updated.amount) - Number(existing.amount);
      } else {
        // نلغي أثر القديم ثم نطبّق الجديد
        const undoOld = existing.type === "debt" ? Number(existing.amount) : -Number(existing.amount);
        const applyNew = updated.type === "debt" ? -Number(updated.amount) : Number(updated.amount);
        return undoOld + applyNew;
      }
    })();

    // حفظ التغييرات في العملية
    await reqToPromise(tstore.put(updated));

    // تطبيق التغيير على رصيد العميل
    await this._applyBalanceChangeInTransaction(cstore, existing.customerId, delta);

    await Audit.log("تعديل عملية", `#${id}`);
  },
  async remove(id) {
    // نحتاج لإلغاء أثر العملية على رصيد العميل داخل معاملة
    const trx = tx([S_TRANSACTIONS, S_CUSTOMERS], "readwrite");
    const tstore = trx.objectStore(S_TRANSACTIONS);
    const cstore = trx.objectStore(S_CUSTOMERS);

    const existing = await reqToPromise(tstore.get(id));
    if (!existing) return;

    // عند الحذف: نُعيد التأثير المعاكس على رصيد العميل
    const reverse = existing.type === "debt" ? Number(existing.amount) : -Number(existing.amount);
    await reqToPromise(tstore.delete(id));
    await this._applyBalanceChangeInTransaction(cstore, existing.customerId, reverse);
    await Audit.log("حذف عملية", `#${id}`);
  },
  balanceFor(transactions) {
    let debt = 0, paid = 0;
    for (const t of transactions) {
      if (t.type === "debt") debt += Number(t.amount) || 0;
      else paid += Number(t.amount) || 0;
    }
    return { debt, paid, remaining: debt - paid };
  },
};

/* ------------------------------- إعدادات ---------------------------------- */

const Settings = {
  async get(key, fallback = null) {
    const store = tx(S_SETTINGS).objectStore(S_SETTINGS);
    const row = await reqToPromise(store.get(key));
    return row ? row.value : fallback;
  },
  async set(key, value) {
    const store = tx(S_SETTINGS, "readwrite").objectStore(S_SETTINGS);
    await reqToPromise(store.put({ key, value }));
  },
};

/* --------------------------------- سجل نشاط -------------------------------- */

const Audit = {
  async log(action, details) {
    try {
      const store = tx(S_AUDIT, "readwrite").objectStore(S_AUDIT);
      await reqToPromise(store.add({
        action, details,
        date: new Date().toISOString(),
      }));
    } catch (e) { /* لا نوقف التطبيق بسبب فشل تسجيل النشاط */ }
  },
  async recent(limit = 50) {
    const store = tx(S_AUDIT).objectStore(S_AUDIT);
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
  },
};

/* ------------------------------ نسخ احتياطي -------------------------------- */

function clearStore(name) {
  return reqToPromise(tx(name, "readwrite").objectStore(name).clear());
}

const Backup = {
  async exportAll() {
    const customers = await Customers.all();
    const transactions = await Transactions.all();
    const settingsStore = tx(S_SETTINGS).objectStore(S_SETTINGS);
    const settingsRows = await reqToPromise(settingsStore.getAll());
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
    return {
      appName: "DebtLedger",
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      customers, transactions, settings,
    };
  },

  // mode: "replace" يمسح كل البيانات الحالية ويستبدلها، "merge" يضيف فوق الموجود
  async importAll(data, mode) {
    if (!data || !Array.isArray(data.customers) || !Array.isArray(data.transactions)) {
      throw new Error("ملف النسخة الاحتياطية غير صالح");
    }

    if (mode === "replace") {
      await clearStore(S_CUSTOMERS);
      await clearStore(S_TRANSACTIONS);
      const repTx = tx([S_CUSTOMERS, S_TRANSACTIONS], "readwrite");
      const cstore = repTx.objectStore(S_CUSTOMERS);
      const tstore = repTx.objectStore(S_TRANSACTIONS);
      for (const c of data.customers) await reqToPromise(cstore.put(c));
      for (const t of data.transactions) await reqToPromise(tstore.put(t));
    } else {
      // merge: نعيد توليد المعرفات لتفادي أي تعارض مع البيانات الحالية
      const idMap = new Map();
      const mergeTx = tx([S_CUSTOMERS, S_TRANSACTIONS], "readwrite");
      const cstore = mergeTx.objectStore(S_CUSTOMERS);
      const tstore = mergeTx.objectStore(S_TRANSACTIONS);
      for (const c of data.customers) {
        const clone = { ...c };
        const oldId = clone.id;
        delete clone.id;
        const newId = await reqToPromise(cstore.add(clone));
        idMap.set(oldId, newId);
      }
      for (const t of data.transactions) {
        const clone = { ...t };
        delete clone.id;
        clone.customerId = idMap.get(t.customerId) ?? t.customerId;
        await reqToPromise(tstore.add(clone));
      }
    }

    if (data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        if (key === "migrated_from_legacy") continue;
        await Settings.set(key, value);
      }
    }

    await Audit.log("استيراد نسخة احتياطية", `الوضع: ${mode === "replace" ? "استبدال" : "دمج"} — ${data.customers.length} عميل`);
  },
};

const SystemOps = {
  async wipeAll() {
    await clearStore(S_CUSTOMERS);
    await clearStore(S_TRANSACTIONS);
    await clearStore(S_AUDIT);
    await Audit.log("مسح جميع البيانات", "تم مسح جميع العملاء والعمليات وسجل النشاط بالكامل");
  },
};

/* ----------------------- الهجرة من البنية القديمة -------------------------- */
/* النظام القديم: متجر "debts" بحقول {name, amount, paid, date, note}
   كل سجل قديم يحمل دينًا وسدادًا معًا لنفس "الاسم" النصي.
   نحوّله إلى: عميل واحد لكل اسم فريد + معاملتين (دين إن وجد، سداد إن وجد) لكل سجل. */

async function migrateFromLegacyIfNeeded() {
  const already = await Settings.get("migrated_from_legacy", false);
  if (already) return { migrated: false };

  if (!_db.objectStoreNames.contains(OLD_STORE)) {
    await Settings.set("migrated_from_legacy", true);
    return { migrated: false };
  }

  const oldStore = tx(OLD_STORE).objectStore(OLD_STORE);
  const oldRows = await reqToPromise(oldStore.getAll());

  if (!oldRows || oldRows.length === 0) {
    await Settings.set("migrated_from_legacy", true);
    return { migrated: false };
  }

  // نسخة احتياطية تلقائية من البيانات القديمة قبل أي تحويل
  await Settings.set("legacy_backup_" + Date.now(), oldRows);

  const nameToCustomerId = new Map();
  const migTx = tx([S_CUSTOMERS, S_TRANSACTIONS], "readwrite");
  const cstore = migTx.objectStore(S_CUSTOMERS);
  const tstore = migTx.objectStore(S_TRANSACTIONS);

  for (const row of oldRows) {
    const name = (row.name || "بدون اسم").trim();
    let customerId = nameToCustomerId.get(name);
    if (!customerId) {
      customerId = await reqToPromise(cstore.add({
        name, phone: "", address: "", notes: "",
        archived: false, pinned: false,
        // نضيف الحقول الجديدة بحدود افتراضية
        monthlySalary: 0,
        balance: 0,
        createdAt: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      }));
      nameToCustomerId.set(name, customerId);
    }
    const amount = Number(row.amount) || 0;
    const paid = Number(row.paid) || 0;
    const date = row.date || new Date().toISOString().slice(0, 10);

    if (amount > 0) {
      await reqToPromise(tstore.add({
        customerId, type: "debt", amount, date,
        note: row.note || "", createdAt: new Date().toISOString(),
      }));
    }
    if (paid > 0) {
      await reqToPromise(tstore.add({
        customerId, type: "payment", amount: paid, date,
        note: row.note ? "سداد مرتبط: " + row.note : "", createdAt: new Date().toISOString(),
      }));
    }
  }

  // ملاحظة: بعد إدخال العمليات القديمة قد نحتاج لتحديث أرصدة العملاء: سنترك ذلك للمستخدم أو يمكن تنفيذ حساب أولي لاحقًا

  await Settings.set("migrated_from_legacy", true);
  await Audit.log("ترحيل بيانات", `تم ترحيل ${oldRows.length} سجل قديم إلى ${nameToCustomerId.size} عميل`);
  return { migrated: true, customers: nameToCustomerId.size, records: oldRows.length };
}
