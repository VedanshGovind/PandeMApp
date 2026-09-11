/* ============================================================
   PANDEM — report storage layer
   ------------------------------------------------------------
   One API, two backends:
     • "firestore"  → shared, everyone sees everyone's reports
     • "local"      → this browser only (used when Firestore is
                      unreachable or security rules block access)

   Usage:
     await Store.init()
     Store.onChange(cb)        // cb(reports, meta)
     await Store.addReport({...})
     await Store.removeReport(id)
   ============================================================ */

window.HealthMapStore = (function () {
  const LS_REPORTS = "healthmap.reports.v1";
  const LS_GUEST = "healthmap.guestId";

  const fb = window.HealthMapFirebase || {};
  const db = fb.db;

  const listeners = new Set();
  let mode = db ? "firestore" : "local";
  let cloudReports = [];
  let localReports = [];
  let lastError = null;
  let unsub = null;

  /* ---------- local helpers ---------- */
  function readLocal() {
    try {
      const raw = localStorage.getItem(LS_REPORTS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn("[PANDEM] Could not read local reports:", e);
      return [];
    }
  }

  function writeLocal() {
    try {
      localStorage.setItem(LS_REPORTS, JSON.stringify(localReports.slice(0, 500)));
    } catch (e) {
      console.warn("[PANDEM] Could not save locally:", e);
    }
  }

  function guestId() {
    let id = localStorage.getItem(LS_GUEST);
    if (!id) {
      id = "guest-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(LS_GUEST, id);
    }
    return id;
  }

  function toDate(v) {
    if (!v) return new Date();
    if (typeof v.toDate === "function") return v.toDate();
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function normalize(id, data) {
    const createdAt = toDate(data.createdAt);
    return {
      id,
      type: data.type,
      category: data.category,
      label: data.label || data.type,
      lat: Number(data.lat),
      lng: Number(data.lng),
      note: data.note || "",
      severity: Number(data.severity) || 1,
      userId: data.userId || "unknown",
      displayName: data.displayName || "Community member",
      createdAt
    };
  }

  /* ---------- emit ---------- */
  function merged() {
    if (mode === "firestore") {
      // Cloud list is authoritative, but keep any pending local reports visible.
      const cloudIds = new Set(cloudReports.map((r) => r.id));
      const pending = localReports.filter((r) => !cloudIds.has(r.id));
      return [...pending, ...cloudReports];
    }
    const localIds = new Set(localReports.map((r) => r.id));
    const staleCloud = cloudReports.filter((r) => !localIds.has(r.id) && !removedLocally(r.id));
    return [...localReports, ...staleCloud];
  }

  const localRemovals = new Set(JSON.parse(localStorage.getItem("healthmap.removed.v1") || "[]"));
  function removedLocally(id) {
    return localRemovals.has(id);
  }
  function markRemoved(id) {
    localRemovals.add(id);
    try {
      localStorage.setItem("healthmap.removed.v1", JSON.stringify([...localRemovals].slice(-300)));
    } catch (e) { /* ignore */ }
  }

  function emit() {
    const list = merged()
      .filter((r) => isFinite(r.lat) && isFinite(r.lng))
      .sort((a, b) => b.createdAt - a.createdAt);
    const meta = { mode, lastError, count: list.length };
    listeners.forEach((cb) => {
      try { cb(list, meta); } catch (e) { console.error(e); }
    });
    return list;
  }

  function sortByDate(arr) {
    return arr.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ---------- Firestore plumbing ---------- */
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  function degrade(err) {
    lastError = err;
    if (mode !== "local") {
      console.warn("[PANDEM] Falling back to local mode:", err && err.code, err && err.message);
      mode = "local";
      if (unsub) { try { unsub(); } catch (e) { /* ignore */ } unsub = null; }
    }
  }

  async function init() {
    localReports = readLocal().map((r) => ({ ...r, createdAt: toDate(r.createdAt) }));

    if (!db) {
      mode = "local";
      emit();
      return mode;
    }

    try {
      // Cheap probe: if this throws, Firestore is unreachable or rules deny reads.
      await withTimeout(db.collection("reports").limit(1).get(), 6000);
      mode = "firestore";

      unsub = db
        .collection("reports")
        .orderBy("createdAt", "desc")
        .limit(300)
        .onSnapshot(
          (qs) => {
            cloudReports = qs.docs.map((d) => normalize(d.id, d.data()));
            emit();
          },
          (err) => { degrade(err); emit(); }
        );
    } catch (err) {
      degrade(err);
    }

    emit();
    return mode;
  }

  /* ---------- public API ---------- */
  async function addReport(data) {
    const base = {
      type: data.type,
      category: data.category,
      label: data.label,
      lat: Number(data.lat),
      lng: Number(data.lng),
      note: (data.note || "").slice(0, 400),
      severity: Number(data.severity) || 1,
      userId: data.userId || guestId(),
      displayName: data.displayName || "Community member"
    };

    if (mode === "firestore") {
      try {
        const ref = await db.collection("reports").add({
          ...base,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        cloudReports = sortByDate([normalize(ref.id, { ...base, createdAt: new Date() }), ...cloudReports]);
        emit();
        return { ok: true, savedTo: "firestore", id: ref.id };
      } catch (err) {
        console.warn("[PANDEM] Cloud write failed:", err && err.code, err && err.message);
        lastError = err;
        degrade(err);
      }
    }

    const id = "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    localReports.unshift(normalize(id, { ...base, createdAt: new Date() }));
    writeLocal();
    emit();
    return { ok: true, savedTo: "local", id, error: lastError };
  }

  async function removeReport(id) {
    // Local copy (always removable)
    const before = localReports.length;
    localReports = localReports.filter((r) => r.id !== id);
    if (localReports.length !== before) writeLocal();

    if (String(id).startsWith("local-")) {
      emit();
      return { ok: true };
    }

    if (mode === "firestore") {
      try {
        await db.collection("reports").doc(id).delete();
        cloudReports = cloudReports.filter((r) => r.id !== id);
        emit();
        return { ok: true };
      } catch (err) {
        lastError = err;
        emit();
        return { ok: false, error: err };
      }
    }

    markRemoved(id);
    emit();
    return { ok: true };
  }

  function onChange(cb) {
    listeners.add(cb);
    cb(merged().filter((r) => isFinite(r.lat) && isFinite(r.lng)), { mode, lastError });
    return () => listeners.delete(cb);
  }

  function getMode() { return mode; }
  function getLastError() { return lastError; }

  return { init, addReport, removeReport, onChange, getMode, getLastError, guestId };
})();
