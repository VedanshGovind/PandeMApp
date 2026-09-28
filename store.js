/* ============================================================
   PandeMApp — report storage layer
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
  let cloudFromCache = false;
  let unsub = null;

  /* ---------- local helpers ---------- */
  function readLocal() {
    try {
      const raw = localStorage.getItem(LS_REPORTS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn("[PandeMApp] Could not read local reports:", e);
      return [];
    }
  }

  function writeLocal() {
    const save = (list) => localStorage.setItem(LS_REPORTS, JSON.stringify(list.slice(0, 500)));
    try {
      save(localReports);
    } catch (e) {
      /* Photos are the only thing big enough to hit the ~5 MB browser quota.
         Shed them from the oldest reports, then from all of them, rather than
         losing the reports themselves. */
      try {
        save(localReports.map((r, i) => (i < 5 ? r : Object.assign({}, r, { photo: "" }))));
        console.warn("[PandeMApp] Storage full — dropped photos from older local reports.");
      } catch (e2) {
        try {
          save(localReports.map((r) => Object.assign({}, r, { photo: "" })));
        } catch (e3) {
          console.warn("[PandeMApp] Could not save locally:", e3);
        }
      }
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
    /* Spread the incoming document first so fields this layer doesn't know about
       (the animal-spread track's `track`, `exposure`, `onsetDate`) survive the
       round trip — both from Firestore and from local storage. The known fields
       below then override the raw values with normalised ones. */
    return {
      ...data,
      id,
      type: data.type,
      category: data.category,
      label: data.label || data.type,
      lat: Number(data.lat),
      lng: Number(data.lng),
      note: data.note || "",
      severity: Number(data.severity) || 1,
      photo: typeof data.photo === "string" ? data.photo : "",
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
    const meta = { mode, lastError, count: list.length, offline: mode === "firestore" && cloudFromCache };
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
      console.warn("[PandeMApp] Falling back to local mode:", err && err.code, err && err.message);
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
          { includeMetadataChanges: true },   // lets us detect "served from cache"
          (qs) => {
            cloudFromCache = !!qs.metadata.fromCache;
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
      photo: typeof data.photo === "string" ? data.photo : "",
      userId: data.userId || guestId(),
      displayName: data.displayName || "Community member",
      // Optional passthrough for fields this layer doesn't know about (e.g. the
      // animal-spread track's `track`, `exposure` and `onsetDate`). The dashboard
      // never sends `extra`, so nothing changes for the main report flow.
      ...(data.extra || {})
    };

    if (mode === "firestore") {
      const push = async (payload) => {
        const ref = await db.collection("reports").add({
          ...payload,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        cloudReports = sortByDate([normalize(ref.id, { ...payload, createdAt: new Date() }), ...cloudReports]);
        emit();
        return ref.id;
      };

      try {
        return { ok: true, savedTo: "firestore", id: await push(base) };
      } catch (err) {
        /* The published rules may be an older revision that rejects the photo
           field (or caps it differently). Retry once without the photo so the
           report itself is never lost — a report without a picture is far more
           useful than no report at all. */
        if (base.photo) {
          try {
            console.warn("[PandeMApp] Cloud write rejected with a photo, retrying without it:", err && err.code);
            const id = await push(Object.assign({}, base, { photo: "" }));
            return { ok: true, savedTo: "firestore", id: id, photoDropped: true };
          } catch (err2) {
            err = err2;
          }
        }
        console.warn("[PandeMApp] Cloud write failed:", err && err.code, err && err.message);
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
    cb(merged().filter((r) => isFinite(r.lat) && isFinite(r.lng)), { mode, lastError, offline: mode === "firestore" && cloudFromCache });
    return () => listeners.delete(cb);
  }

  function getMode() { return mode; }
  function isOffline() { return mode === "firestore" && cloudFromCache; }
  function getLastError() { return lastError; }

  return { init, addReport, removeReport, onChange, getMode, getLastError, isOffline, guestId };
})();

/* ============================================================
   Shared app configuration
   ------------------------------------------------------------
   Both report forms live on the dashboard, and both load this file,
   so the tile chain and the animal-spread disease list live here
   rather than in extra modules: fewer files to upload, and still
   one place to change when a tile host starts blocking us.
   ============================================================ */
window.HealthMapConfig = (function () {

/* ============================================================
   PandeMApp — shared basemap configuration
   ------------------------------------------------------------
   One source of truth for the tile chain. Both the dashboard map
   and the animal-spread disease form read this, so a provider
   only ever has to be added or removed in one place.

   Tile hosts refuse traffic for all sorts of reasons — usage
   policy (OSM), a required API key (CARTO), an IP or region block,
   or plain rate limiting. When they do, they often don't return an
   error: they return HTTP 200 with the refusal drawn into the tile,
   so the map looks "loaded" while showing a notice. So the map walks
   this list and keeps the first host that genuinely paints.

   Deliberately absent:
     • tile.openstreetmap.org — its policy requires an identifiable
       User-Agent that a browser cannot send, so real users get
       blocked while server-side tests pass. This is the block we
       hit first.
     • CARTO — as of 2026 it serves an "API key required" tile unless
       you send a key. Enabled below only when CARTO_KEY is filled in.

   Force a provider with ?tiles=<id> (e.g. ?tiles=versatiles). The
   provider that works is remembered in localStorage, so the next
   visit starts there.
   ============================================================ */

const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const MAPTILER_KEY = "";   // optional: paste a MapTiler key to put it first
const CARTO_KEY = "";      // optional: CARTO now needs a key — paste one to use it

const TILE_PROVIDERS = [
  {
    id: "openfreemap", label: "OpenFreeMap", host: "tiles.openfreemap.org",
    style: "https://tiles.openfreemap.org/styles/liberty",
    attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; ' + OSM_LINK
  },
  {
    id: "versatiles", label: "VersaTiles", host: "tiles.versatiles.org",
    style: "https://tiles.versatiles.org/assets/styles/colorful/style.json",
    attribution: '&copy; <a href="https://versatiles.org">VersaTiles</a> &copy; ' + OSM_LINK
  },
  {
    // Plain raster on a different network entirely — no style JSON, no sprite,
    // no key. If this one fails too, the network is the problem, not the host.
    id: "esri", label: "Esri Streets", host: "server.arcgisonline.com",
    style: {
      version: 8,
      sources: {
        esri: {
          type: "raster", tileSize: 256,
          // note Esri's order is {z}/{y}/{x}
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"]
        }
      },
      layers: [{ id: "esri", type: "raster", source: "esri" }]
    },
    attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Source: Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; ' + OSM_LINK + ' contributors'
  }
];

if (CARTO_KEY) {
  const key = "?api_key=" + encodeURIComponent(CARTO_KEY);
  TILE_PROVIDERS.splice(1, 0, {
    id: "carto", label: "CARTO Voyager", host: "basemaps.cartocdn.com",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" + key,
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; ' + OSM_LINK
  });
}

if (MAPTILER_KEY) {
  TILE_PROVIDERS.unshift({
    id: "maptiler", label: "MapTiler", host: "api.maptiler.com",
    style: "https://api.maptiler.com/maps/streets/style.json?key=" + MAPTILER_KEY,
    attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; ' + OSM_LINK
  });
}

const TILE_STORE_KEY = "healthmap.basemap.v1";

/* MapLibre's AJAXError only sometimes carries `.status`; when it doesn't, the
   code is still in the message, e.g. "AJAXError: Forbidden (403): https://…".
   A refused or unreachable host is the signal we care about. */
function errorStatus(err) {
  if (!err) return null;
  if (typeof err.status === "number") return err.status;
  if (err.response && typeof err.response.status === "number") return err.response.status;
  const m = /\((\d{3})\)/.exec(err.message || "");
  if (m) return Number(m[1]);
  if (/failed to fetch|networkerror|load failed/i.test(err.message || "")) return 0;
  return null;
}

function isDecisive(status) {
  return status === 401 || status === 402 || status === 403 || status === 429 || status === 0;
}

function styleFor(p) { return p.style; }

/* ============================================================
   PandeMApp — animal-spread (zoonotic) disease track
   ------------------------------------------------------------
   Shared by the dashboard's two report forms: the animal-spread
   form builds its disease cards from this, and the map uses the
   list to place each disease in the "From animals" group.

   Stored in the same `reports` collection with category "disease"
   because the published Firestore rules only accept
   category in ['disease', 'risk']. A `track: "zoonotic"` field
   marks them; extra fields are permitted by the rules (they check
   hasAll for required fields, not hasOnly).
   ============================================================ */

const ZOONOTIC_TYPES = {
  rabies:        { label: "Rabies",                            blurb: "Fever, anxiety and difficulty swallowing, weeks to months after an animal bite" },
  nipah:         { label: "Nipah virus",                       blurb: "Fever, headache and drowsiness; spread by fruit bats or raw date palm sap" },
  leptospirosis: { label: "Leptospirosis",                     blurb: "Fever, severe muscle pain and red eyes after contact with water or soil contaminated by animal urine" },
  anthrax:       { label: "Anthrax",                           blurb: "Painless black skin sores, or severe breathing illness, from infected livestock" },
  brucellosis:   { label: "Brucellosis",                       blurb: "Long-lasting fever, joint pain and sweating; from raw milk or close livestock contact" },
  plague:        { label: "Plague",                            blurb: "Fever with swollen, very tender lymph nodes; spread by rodent fleas" },
  kyasanur:      { label: "Kyasanur Forest disease",           blurb: "Fever, headache and bleeding a few days after a tick bite in forest areas" },
  cchf:          { label: "Crimean-Congo haemorrhagic fever",  blurb: "Sudden fever with bruising and bleeding after a tick bite or contact with livestock blood" },
  avian_flu:     { label: "Avian influenza (bird flu)",        blurb: "Severe breathing illness after contact with infected birds or poultry" },
  swine_flu:     { label: "Swine influenza (H1N1)",            blurb: "Fever, cough and body ache; spreads between people as well as from pigs" },
  scrub_typhus:  { label: "Scrub typhus",                      blurb: "Fever with a dark scab (eschar) after a mite bite in grassy or bushy ground" },
  other_zoonotic:{ label: "Something else / not sure",         blurb: "Any illness you believe came from an animal, an insect, or their droppings" }
};

const ZOONOTIC_EXPOSURE = {
  bite:      "Dog, cat or monkey bite or scratch",
  bat:       "Bats, or raw date palm sap or fruit touched by bats",
  livestock: "Cattle, goats, sheep or pigs",
  rodent:    "Rodents, or fleas from rodents",
  tick:      "Tick or mite bite",
  water_soil:"Contaminated water, soil or floodwater",
  poultry:   "Birds or poultry",
  unsure:    "Not sure / something else"
};

/* Exposures where rabies post-exposure care is the urgent issue. */
function needsRabiesWarning(disease, exposure) {
  return disease === "rabies" || exposure === "bite";
}

function isZoonotic(type) {
  return Object.prototype.hasOwnProperty.call(ZOONOTIC_TYPES, type);
}

  return {
    OSM_LINK, TILE_PROVIDERS, TILE_STORE_KEY, errorStatus, isDecisive, styleFor,
    ZOONOTIC_TYPES, ZOONOTIC_EXPOSURE, needsRabiesWarning, isZoonotic
  };
})();

/* ============================================================
   Shared photo compression
   ------------------------------------------------------------
   Used by the dashboard report form and the animal-spread
   form, so a photo behaves identically wherever it is attached:
   resized, re-encoded, EXIF (including GPS) stripped by the
   canvas redraw, and shrunk until it fits the document budget.
   ============================================================ */
window.HealthMapImages = (function () {
  const MAX_EDGE = 1000;
  const QUALITY = 0.7;
  const MAX_CHARS = 260000;   // ≈190 KB of image inside the 1 MB Firestore doc limit

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" })   // rotates phone photos correctly
        .catch(() => createImageBitmap(file))
        .catch(() => fallbackBitmap(file));
    }
    return fallbackBitmap(file);
  }

  function fallbackBitmap(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read.")); };
      img.src = url;
    });
  }

  function compress(file) {
    return loadBitmap(file).then((bitmap) => {
      const w0 = bitmap.width || 1, h0 = bitmap.height || 1;
      const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      if (bitmap.close) bitmap.close();

      let q = QUALITY, out = canvas.toDataURL("image/jpeg", q);
      while (out.length > MAX_CHARS && q > 0.35) {   // shrink until it fits the budget
        q -= 0.1;
        out = canvas.toDataURL("image/jpeg", q);
      }
      if (out.length > MAX_CHARS) throw new Error("That image is too large even after compressing.");
      return out;
    });
  }

  return { compress, MAX_EDGE, QUALITY, MAX_CHARS };
})();
