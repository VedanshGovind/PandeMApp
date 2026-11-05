// MapLibre v6 ships ESM only, with named exports (no default export).
import * as maplibregl from "https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.mjs";

/* ============================================================
   PandeMApp — dashboard logic
   • MapLibre GL map locked to India
   • Real community reports (Firestore, with local fallback)
   • Optional Google sign-in
   ============================================================ */
(function () {
  "use strict";

  const fb = window.HealthMapFirebase || {};
  const Store = window.HealthMapStore;
  const Images = window.HealthMapImages;
  /* Tile chain + disease lists live in store.js (window.HealthMapConfig) because
     both pages load it — one shared copy instead of an extra module each. */
  const { TILE_PROVIDERS, styleFor, TILE_STORE_KEY, errorStatus, isDecisive,
          ZOONOTIC_TYPES, ZOONOTIC_EXPOSURE } = window.HealthMapConfig;
  const auth = fb.auth;
  const db = fb.db;

  /* ---------------- report catalogue ----------------
     `category` is what the database stores and must stay "disease" or "risk" —
     the published rules reject anything else.
     `group` is what the UI sorts by: illness, risk, or animal-spread. */
  const ANIMAL_COLOR = "#F5A623";   // the whole animal group shares one colour

  const TYPES = {
    dengue:         { label: "Dengue",            icon: "🦠", category: "disease", group: "illness", color: "#E5484D", blurb: "Fever, rash, bone or joint pain" },
    malaria:        { label: "Malaria",           icon: "🌡️", category: "disease", group: "illness", color: "#8B5CF6", blurb: "Fever with chills and sweating" },
    chikungunya:    { label: "Chikungunya",       icon: "🦵", category: "disease", group: "illness", color: "#DB2777", blurb: "Fever with severe, lasting joint pain" },
    jp_enceph:     { label: "Japanese encephalitis", icon: "🧠", category: "disease", group: "illness", color: "#0891B2", blurb: "Fever, headache and confusion; caught from mosquitoes in rural areas" },
    zika:           { label: "Zika virus",        icon: "🦟", category: "disease", group: "illness", color: "#92400E", blurb: "Mild fever and rash; risky in pregnancy" },
    other_fever:    { label: "Other fever",       icon: "🤒", category: "disease", group: "illness", color: "#0EA5A0", blurb: "Fever that has not been diagnosed yet" },

    stagnant_water: { label: "Stagnant water",    icon: "💧", category: "risk", group: "risk", color: "#2E7CF6", blurb: "Puddles, waterlogging, tanks, coolers, tyres" },
    drainage:       { label: "Drainage & sewage", icon: "🚱", category: "risk", group: "risk", color: "#7C3AED", blurb: "Open drains, overflow, blocked gutters" },
    garbage:        { label: "Garbage & waste",   icon: "🗑️", category: "risk", group: "risk", color: "#65A30D", blurb: "Dumping, litter and unclean public areas" }
  };

  /* Animal-spread diseases. Names and descriptions come from the shared config in
     store.js; only the emoji and the colour live here. They share one colour so the
     map stays readable — the emoji on each pin tells them apart. */
  const ANIMAL_ICONS = {
    rabies: "🐕", nipah: "🦇", leptospirosis: "💧", anthrax: "🐄",
    brucellosis: "🐐", plague: "🐀", kyasanur: "🕷️", cchf: "🩸",
    avian_flu: "🐦", swine_flu: "🐖", scrub_typhus: "🌿", other_zoonotic: "❓"
  };
  Object.keys(ZOONOTIC_TYPES).forEach((k) => {
    TYPES[k] = Object.assign({}, ZOONOTIC_TYPES[k], {
      category: "disease", group: "animal", color: ANIMAL_COLOR, icon: ANIMAL_ICONS[k] || "🐾"
    });
  });

  /* The three groups the map, the filters and the legend all work in. */
  const GROUPS = {
    illness: { label: "Illness",       icon: "🩺", chip: "Illnesses" },
    risk:    { label: "Breeding risk", icon: "💧", chip: "Breeding & water" },
    animal:  { label: "From animals",  icon: "🐾", chip: "From animals" }
  };

  /* Reports saved with the previous, longer list are folded into the six above
     so old data still renders. Anything unrecognised falls back to "Other risk",
     which still shows on the map but isn't offered as a new option. */
  const FALLBACK_TYPE = {
    label: "Other risk", icon: "⚠️", category: "risk", group: "risk", color: "#4C6076",
    blurb: "Anything mosquitoes could breed in"
  };
  const LEGACY_TYPES = {
    other_illness: "other_fever",
    waterlogging: "stagnant_water",
    containers: "stagnant_water",
    sewage: "drainage",
    cleanliness: "garbage",
    mosquitoes: "other_risk",
    other_risk: "other_risk"
  };

  function typeInfo(key) { return TYPES[key] || FALLBACK_TYPE; }
  function normalizeType(key) { return TYPES[key] ? key : (LEGACY_TYPES[key] || "other_risk"); }
  function typeKeys(g) { return Object.keys(TYPES).filter((k) => TYPES[k].group === g); }
  function groupOf(k) { return (TYPES[k] && TYPES[k].group) || (typeInfo(k).group); }

  const SEVERITY = {
    disease: ["Suspected", "Doctor-confirmed", "Hospitalised"],
    risk:    ["Small spot", "Moderate", "Large area"]
  };

  const WATER_TYPES = ["stagnant_water", "drainage"];

  /* ---------------- app state ---------------- */
  let map = null;
  let pickerMap = null;
  let pickerMarker = null;
  let userLatLng = null;          // jittered display location
  let userMarker = null;
  let allReports = [];
  // "other_risk" is the bucket for legacy/unrecognised reports — it has no card
  // or chip of its own, but must stay visible so old data never disappears.
  let visibleTypes = new Set(Object.keys(TYPES).concat(["other_risk"]));
  let timeWindow = 10;            // days — default is the last 10 days; "custom" uses customFrom/customTo
  let customFrom = 0;             // ms timestamps for the custom date range (0 = open-ended)
  let customTo = 0;
  let radiusKm = 0;               // 0 = anywhere in India
  let radiusCentre = null;        // { lat, lng, label } — fixed when the radius is chosen
  let searchedCity = null;        // last city found by the city search
  let ringData = { type: "FeatureCollection", features: [] };   // radius outline, re-applied after a style swap
  let ringDirty = false;
  let currentUser = null;
  let markers = [];               // MapLibre markers currently on the map
  const markerIndex = new Map();  // id -> { layer, report }
  let selectedType = null;
  let selectedSeverity = 1;
  let pendingCoords = null;
  let pendingPhoto = null;        // data-URL of the photo chosen in the modal

  const $ = (id) => document.getElementById(id);

  /* ---------------- India-only map bounds (MapLibre: [west,south] → [east,north]) ---------------- */
  const INDIA_BOUNDS = [[67.8, 6.2], [97.6, 35.8]];
  const INDIA_CENTER = [78.9629, 20.5937];        // [lng, lat]
  const EMPTY_FC = { type: "FeatureCollection", features: [] };

  /* The tile chain itself lives in basemap.js — it is shared with the
     animal-spread disease form, so there is only one list to maintain. */

  /* Bump this whenever TILE_PROVIDERS changes. It is printed on load so you can
     tell, from the browser console alone, whether the browser is running the file
     you just uploaded or a stale cached copy. */
  const BUILD_ID = "2026-09-17.3";


  /* OpenFreeMap's and CARTO's vector styles carry no attribution of their own,
     which leaves OpenStreetMap's contributors uncredited — and ODbL requires
     credit. Rather than fight MapLibre's AttributionControl (it keeps a shared
     list, so swapping controls only appends), the map shows its own credit line,
     rewritten whenever the provider changes. Handy side effect: the corner of the
     map tells you who is actually serving it. */
  function setCredit(p) {
    const html = p.attribution || "";
    const main = $("mapCredit");
    if (main) main.innerHTML = html;
    const picker = $("pickerCredit");
    if (picker) picker.innerHTML = html;
  }

  /* Pick the starting provider: ?tiles= beats a remembered one. */
  function announceBuild() {
    const chain = TILE_PROVIDERS.map((p) => p.id).join(" → ");
    console.info("%c[PandeMApp] build " + BUILD_ID + "%c  basemap chain: " + chain,
      "font-weight:bold", "font-weight:normal");
    if (TILE_PROVIDERS.some((p) => p.id === "carto")) {
      console.warn("[PandeMApp] CARTO is only included when CARTO_KEY is set — if you see this with an empty key, you are running an old cached dashboard.js.");
    }
  }

  function initialProviderIndex() {
    const forced = new URLSearchParams(location.search).get("tiles");
    if (forced) {
      const i = TILE_PROVIDERS.findIndex((p) => p.id === forced);
      if (i >= 0) return i;
    }
    try {
      const saved = localStorage.getItem(TILE_STORE_KEY);
      if (!saved) return 0;
      const i = TILE_PROVIDERS.findIndex((p) => p.id === saved);
      if (i >= 0) return i;
      // remembered a provider that has since been removed (e.g. carto) — forget it
      localStorage.removeItem(TILE_STORE_KEY);
    } catch (e) { /* private mode */ }
    return 0;
  }

  /* ================= helpers ================= */
  function toast(msg, kind) {
    const host = $("toastHost");
    const t = document.createElement("div");
    t.className = "toast " + (kind || "info");
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 3400);
  }

  function timeAgo(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    const d = Math.floor(s / 86400);
    if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function fmtDistance(km) {
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km";
  }

  /* ================= report photos =================
     One photo per report, resized and re-encoded in the browser before it is
     stored. Two side effects worth knowing:
       • Re-drawing through a canvas strips EXIF, including GPS coordinates, so a
         photo of a breeding site doesn't publish where it was taken.
       • The result is a compact data URL that fits inside a Firestore document
         (1 MB limit), so no Storage bucket, rules change or billing is needed. */
  /* The compressor lives in store.js (window.HealthMapImages) because the
     animal-spread form uses the identical pipeline — a photo behaves the same
     whichever form it was attached from. */
  const compressImage = (file) => Images.compress(file);

  function photoUrl(v) {
    return (typeof v === "string" && v.length <= 400000 &&
            /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) ? v : "";
  }

  /* Google profile URLs carry a size suffix (=s96-c); ask for one that suits the
     element instead of whatever the provider picked. */

  function avatarSrc(url, size) {
    if (!url) return "";
    return url.replace(/=s\d+-c$/, "=s" + size + "-c");
  }

  function initialsOf(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "👤";
    return ((parts[0][0] || "") + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  /* Google serves profile photos from lh3.googleusercontent.com. When that
     request fails — a host content-security policy, a strict network, a photo
     the account no longer exposes — the <img> renders as an empty box and the
     profile picture quietly "disappears". So build the image in script, listen
     for the failure, and fall back to the person's initials: the button and the
     panel then always show something that is clearly theirs. */
  function initialsMark(user) {
    return user ? initialsOf(user.displayName || user.email) : "👤";
  }

  function setAvatar(user) {
    const btn = $("profileOpenBtn");
    const mark = initialsMark(user);

    const showBtnFallback = () => {
      btn.textContent = "";
      const s = document.createElement("span");
      s.className = "avatar-initials";
      s.textContent = mark;
      btn.appendChild(s);
    };

    btn.textContent = "";
    if (user && user.photoURL) {
      const url = avatarSrc(user.photoURL, 96);
      if (!url) { showBtnFallback(); }
      else {
        const img = document.createElement("img");
        img.className = "avatar-img";
        img.alt = "Your profile photo";
        img.referrerPolicy = "no-referrer";   // some photo hosts reject a referrer
        img.addEventListener("error", showBtnFallback);
        img.src = url;
        btn.appendChild(img);
      }
    } else if (user) {
      showBtnFallback();
    } else {
      btn.textContent = "👤";
    }

    const big = $("panelAvatar"), fallback = $("panelInitials");
    const showPanelFallback = () => {
      big.hidden = true;
      if (fallback) { fallback.hidden = false; fallback.textContent = mark; }
    };

    if (user && user.photoURL && avatarSrc(user.photoURL, 160)) {
      big.onerror = showPanelFallback;
      big.referrerPolicy = "no-referrer";
      big.hidden = false;
      if (fallback) fallback.hidden = true;
      big.src = avatarSrc(user.photoURL, 160);
    } else {
      big.onerror = null;
      big.removeAttribute("src");        // an empty src renders a broken-image icon
      big.hidden = true;
      if (fallback) { fallback.hidden = false; fallback.textContent = mark; }
    }
  }

  function photoHintFor(group) {
    if (group === "animal") return "A photo of the animal, the bite or wound, or a PDF of the doctor's note helps — hide faces, names and house numbers first. Images or PDFs up to about 500 KB.";
    return group === "illness"
      ? "A photo or PDF of the doctor's note or test report helps confirm it — hide names, IDs and other personal details first. Images or PDFs up to about 500 KB."
      : "A photo of the place — a drain, puddle, tank or dump site — helps others confirm it and act on it.";
  }

  /* ---- attachments: one image (compressed) or one small PDF per report ---- */
  const MAX_PDF_BYTES = 500 * 1024;   // keeps the Firestore document under its 1 MB limit

  const FILE_UI = {
    main:   { img: "photoPreviewImg",       box: "photoPreview",       rm: "photoRemoveBtn",       pick: "photoPickBtn",       input: "photoInput",       chip: "photoFileChip" },
    animal: { img: "animalPhotoPreviewImg", box: "animalPhotoPreview", rm: "animalPhotoRemoveBtn", pick: "animalPhotoPickBtn", input: "animalPhotoInput", chip: "animalFileChip" }
  };

  function isPdf(file) { return file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""); }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("Could not read that file."));
      fr.readAsDataURL(file);
    });
  }

  async function prepareFile(file) {
    if (/^image\//.test(file.type)) {
      return { kind: "image", dataUrl: await compressImage(file), name: file.name || "image" };
    }
    if (isPdf(file)) {
      if (file.size > MAX_PDF_BYTES) {
        throw new Error("That PDF is " + Math.round(file.size / 1024) + " KB — please keep PDFs under 500 KB, or attach an image of the key page.");
      }
      const raw = await readAsDataUrl(file);
      // some browsers label PDFs application/octet-stream — normalise so it can be validated later
      const dataUrl = String(raw).replace(/^data:[^;,]*;base64,/, "data:application/pdf;base64,");
      return { kind: "pdf", dataUrl: dataUrl, name: file.name || "document.pdf" };
    }
    throw new Error("Please choose an image or a PDF file.");
  }

  function fileKb(f) { return Math.round((f.dataUrl.length * 3) / 4 / 1024); }
  function imageOf(f) { return f && f.kind === "image" ? f.dataUrl : null; }
  function attachmentExtra(f) {
    return f && f.kind === "pdf"
      ? { attachment: f.dataUrl, attachmentName: f.name, attachmentType: "application/pdf" }
      : {};
  }

  function paintFile(ui, f) {
    const img = $(ui.img), box = $(ui.box), chip = $(ui.chip);
    if (f && f.kind === "image") {
      img.src = f.dataUrl;
      box.hidden = false;
      chip.hidden = true;
    } else if (f) {
      img.removeAttribute("src");
      box.hidden = true;
      chip.hidden = false;
      chip.innerHTML = "<span>📄</span><span>" + escapeHtml(f.name) + " <small>· PDF · " + fileKb(f) + " KB</small></span>";
    } else {
      img.removeAttribute("src");
      box.hidden = true;
      chip.hidden = true;
      chip.textContent = "";
      $(ui.input).value = "";
    }
    $(ui.rm).hidden = !f;
    $(ui.pick).textContent = f ? "📎 Replace file" : "📎 Add a file";
  }

  function setPendingPhoto(f) {
    pendingPhoto = f || null;
    paintFile(FILE_UI.main, pendingPhoto);
  }

  function attachmentUrl(r) {
    const v = r && r.attachment;
    return (typeof v === "string" && v.length <= 800000 &&
            /^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(v)) ? v : "";
  }

  function fileLinkHtml(r) {
    return attachmentUrl(r)
      ? '<a href="#" class="file-link" data-fileid="' + escapeHtml(r.id) + '">📄 ' + escapeHtml(r.attachmentName || "Attached PDF") + "</a>"
      : "";
  }

  /* A data: URL can't be opened as a top-level page in most browsers, so turn it into a Blob first. */
  function openAttachment(id) {
    const r = allReports.find((x) => x.id === id);
    const url = r && attachmentUrl(r);
    if (!url) return;
    try {
      const bin = atob(url.split(",")[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const w = window.open(blobUrl, "_blank", "noopener");
      if (!w) toast("Allow pop-ups to open the file.", "info");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      toast("Couldn't open that file.", "error");
    }
  }

  function openLightbox(reportId) {
    const r = allReports.find((x) => x.id === reportId);
    const src = r && photoUrl(r.photo);
    if (!src) return;
    $("lightboxImg").src = src;
    $("lightbox").hidden = false;
  }
  function closeLightbox() {
    $("lightbox").hidden = true;
    $("lightboxImg").removeAttribute("src");
  }

  /* Shift a point by up to `meters` so a report never lands on someone's doorstep. */
  function jitter(lat, lng, meters) {
    const dist = Math.sqrt(Math.random()) * meters;
    const angle = Math.random() * Math.PI * 2;
    const dLat = (dist * Math.cos(angle)) / 111320;
    const dLng = (dist * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
    return { lat: lat + dLat, lng: lng + dLng };
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function currentUserId() {
    return currentUser ? currentUser.uid : Store.guestId();
  }

  /* Deleting a cloud report requires a signed-in author — see firestore.rules.
     A guest can't prove ownership to the server, so their only working path is
     a report held locally. Never offer a button that is guaranteed to fail. */
  function canWithdraw(r) {
    if (r.userId !== currentUserId()) return false;
    if (Store.getMode() === "firestore" && !currentUser) return false;
    return true;
  }

  function withdrawControl(r, mine) {
    if (!mine) return "";
    return canWithdraw(r)
      ? '<button class="link-btn" data-del="' + r.id + '">Withdraw</button>'
      : '<span class="hint-noop" title="Sign in to manage your reports across devices">Sign in to withdraw</span>';
  }

  function pinElement(typeKey) {
    const t = typeInfo(typeKey);
    const el = document.createElement("div");
    el.className = "report-pin" + (t.group === "illness" ? " disease" : "");
    el.style.background = t.color;
    el.innerHTML = "<span>" + t.icon + "</span>";
    return el;
  }

  /* ================= map (MapLibre GL JS) ================= */
  let mapLoaded = false;
  let providerIndex = 0;
  let tileFailures = 0;
  let switching = false;
  let gaveUp = false;
  let paintChecks = 0;
  let paintStart = 0;
  let pendingSwitch = null;
  let tilesDeadline = null;
  let circleData = EMPTY_FC;      // illness halos, re-applied after a style swap
  let circleDirty = false;
  const providerLog = [];

  /* maxBounds only constrains the map CENTRE — at low zoom the viewport is wider
     than India, so neighbouring countries would still show. This returns the
     lowest zoom at which the viewport fits entirely inside India's box.
     MapLibre's world is tileSize(512) × 2^zoom pixels. */
  function indiaLockZoom(m) {
    const el = m.getContainer();
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return 4;
    const mercY = (lat) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
    const wFrac = (INDIA_BOUNDS[1][0] - INDIA_BOUNDS[0][0]) / 360;
    const hFrac = Math.abs(mercY(INDIA_BOUNDS[0][1]) - mercY(INDIA_BOUNDS[1][1]));
    for (let z = 2; z <= 14.001; z += 0.25) {
      const world = 512 * Math.pow(2, z);
      if (wFrac * world >= w && hFrac * world >= h) return z;
    }
    return 14;
  }

  function applyIndiaLock(m) {
    const z = indiaLockZoom(m);
    m.setMinZoom(z);
    if (m.getZoom() < z) m.setZoom(z);
    return z;
  }

  function initMap() {
    announceBuild();
    if (typeof maplibregl === "undefined") {
      $("mapLoading").innerHTML = "<p>MAP LIBRARY FAILED TO LOAD — CHECK YOUR CONNECTION</p>";
      return;
    }

    providerIndex = initialProviderIndex();

    map = new maplibregl.Map({
      container: "map",
      style: styleFor(TILE_PROVIDERS[providerIndex]),
      center: INDIA_CENTER,
      zoom: 4,
      minZoom: 3,
      maxZoom: 17,
      maxBounds: INDIA_BOUNDS,     // cannot pan outside India
      attributionControl: false,   // credit is our own element, see setCredit()
      dragRotate: false,
      pitchWithRotate: false
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    setCredit(TILE_PROVIDERS[providerIndex]);

    // "load" fires for the first style only, "idle" once the map has actually
    // drawn tiles — after a failover there is no second "load", so both paths
    // end in mapReady().
    /* "Ready" means tiles actually painted, not merely "the style parsed".
       An inline style fires load instantly even when every tile is refused —
       that's how a blocked host ends up looking like a blank white map.
       (MapLibre v6 has no dataType:"tile" event, so ask the map directly.) */
    map.on("load", armPaintCheck);

    map.on("styledata", ensureDiseaseLayers);   // setStyle drops our own layers

    map.on("error", (e) => {
      const err = e && e.error;
      const status = errorStatus(err);
      if (providerLog.length < 60) {
        providerLog.push({ provider: TILE_PROVIDERS[providerIndex].id, status: status === null ? "error" : status, msg: err && err.message });
      }
      // 403 / 429 = the host is refusing us; 0 = the request never completed
      // (DNS, CORS, offline). Any of those is decisive on its own.
      const decisive = isDecisive(status);
      if (decisive || !mapLoaded) tileFailures++;
      if (decisive || tileFailures >= 3) {
        // A refusal fired while we were mid-switch would otherwise be swallowed
        // by the cooldown and leave us parked on a dead host.
        if (switching) pendingSwitch = status === null ? "error" : status;
        else switchProvider(status === null ? "error" : status);
      }
    });

    armLoadTimeout();   // safety net: never sit on a blank map for ever

    map.on("moveend", renderStats);

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => applyIndiaLock(map), 250);
    });
  }

  /* Runs once the map can actually draw: "load" for the first style, "idle"
     after a failover. */
  /* Positive proof a tile really arrived: a 200 from this provider's own host.
     (transferSize/decodedBodySize are 0 cross-origin without Timing-Allow-Origin,
     but responseStatus is exposed — 200 when a tile loads, 0 when it's refused.) */
  function tilesArrived() {
    try {
      const host = TILE_PROVIDERS[providerIndex].host;
      return performance.getEntriesByType("resource").some(
        (e) => e.name.indexOf(host) >= 0 && e.responseStatus === 200
      );
    } catch (e) { return false; }
  }

  /* areTilesLoaded() on its own lies: when every request fails the queue is
     empty, so it reports "loaded". A host is only trustworthy when nothing is
     pending AND nothing was refused since we switched to it. */
  function mapLooksPainted() {
    if (!map || !map.getStyle()) return false;
    try { return map.areTilesLoaded() && tileFailures === 0; }
    catch (e) { return false; }
  }

  /* Failed tile requests switch providers instantly (see the error handler).
     This only catches the silent case: a style that loads but never paints.
     A host that is merely slow keeps getting chances; a refused one doesn't. */
  function armPaintCheck() {
    clearTimeout(tilesDeadline);
    paintChecks = 0;
    paintStart = Date.now();
    tilesDeadline = setTimeout(paintCheck, 300);
  }

  function paintCheck() {
    if (mapLoaded || !map) return;

    if (tilesArrived()) { mapReady(); return; }          // a tile genuinely loaded
    // Browsers that don't expose responseStatus fall back to the weaker signal,
    // but only after a short grace period so an empty request queue can't
    // masquerade as a painted map.
    if (Date.now() - paintStart > 4000 && mapLooksPainted()) { mapReady(); return; }
    if (tileFailures === 0 && paintChecks < 50) {        // slow network, not a refusal
      paintChecks++;
      tilesDeadline = setTimeout(paintCheck, 400);
      return;
    }
    switchProvider("no tiles painted");
  }

  function mapReady() {
    if (mapLoaded || !map) return;
    // Never call the map ready on an empty or refused style.
    const st = map.getStyle();
    if (!st || !st.sources || !Object.keys(st.sources).length) return;
    mapLoaded = true;
    ensureDiseaseLayers();
    applyIndiaLock(map);
    renderMarkers();
    $("mapLoading").classList.add("hide");
    console.info("[PandeMApp] basemap: " + TILE_PROVIDERS[providerIndex].label);
    try { localStorage.setItem(TILE_STORE_KEY, TILE_PROVIDERS[providerIndex].id); } catch (e) { /* private mode */ }
    if (providerIndex > 0) {
      const forced = new URLSearchParams(location.search).get("tiles");
      if (!forced) {
        toast("Default map tiles are blocked here — using " + TILE_PROVIDERS[providerIndex].label + " instead.", "info");
      }
    }
    locateUser();
  }

  /* Our halo source/layers live on top of the basemap style, so a setStyle
     (provider swap) wipes them. Re-add and re-feed them whenever that happens. */
  function ensureDiseaseLayers() {
    if (!map || !map.getStyle()) return;
    if (!map.getSource("disease-areas")) {
      map.addSource("disease-areas", { type: "geojson", data: circleData });
      map.addLayer({
        id: "disease-areas-fill", type: "fill", source: "disease-areas",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 }
      });
      map.addLayer({
        id: "disease-areas-line", type: "line", source: "disease-areas",
        paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.55 }
      });
      circleDirty = false;
    } else if (circleDirty) {
      map.getSource("disease-areas").setData(circleData);
      circleDirty = false;
    }

    // dashed outline for the radius filter
    if (!map.getSource("radius-ring")) {
      map.addSource("radius-ring", { type: "geojson", data: ringData });
      map.addLayer({
        id: "radius-ring-fill", type: "fill", source: "radius-ring",
        paint: { "fill-color": "#1565D8", "fill-opacity": 0.05 }
      });
      map.addLayer({
        id: "radius-ring-line", type: "line", source: "radius-ring",
        paint: { "line-color": "#1565D8", "line-width": 2, "line-dasharray": [2, 2] }
      });
      ringDirty = false;
    } else if (ringDirty) {
      map.getSource("radius-ring").setData(ringData);
      ringDirty = false;
    }
  }

  /* Move to the next tile host. Called on 403/429 tile responses, on any error
     before the first successful draw, and by the 20 s timeout. */
  let loadTimer = null;
  function armLoadTimeout() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => { if (!mapLoaded) switchProvider("timeout"); }, 20000);
  }

  function switchProvider(reason) {
    if (switching || !map) return;
    if (providerIndex >= TILE_PROVIDERS.length - 1) {
      if (gaveUp) return;
      gaveUp = true;
      const el = $("mapLoading");
      el.classList.remove("hide");
      el.innerHTML =
        '<div class="map-fallback">' +
        "<h3>Map tiles are blocked on this network</h3>" +
        "<p>Every map provider we tried was refused. Reporting still works — " +
        "open a report and pick your location on the picker map.</p>" +
        '<button class="btn ghost" id="retryTilesBtn">Try the map again</button>' +
        "</div>";
      const btn = $("retryTilesBtn");
      if (btn) btn.addEventListener("click", () => { gaveUp = false; providerIndex = 0; tileFailures = 0; map.setStyle(styleFor(TILE_PROVIDERS[0])); });
      return;
    }
    switching = true;
    tileFailures = 0;
    clearTimeout(tilesDeadline);
    const from = TILE_PROVIDERS[providerIndex];
    providerIndex++;
    const to = TILE_PROVIDERS[providerIndex];
    try { localStorage.removeItem(TILE_STORE_KEY); } catch (e) { /* private mode */ }
    console.warn("[PandeMApp] basemap " + from.id + " unusable (" + reason + ") → switching to " + to.id);
    try {
      map.setStyle(styleFor(to));
      if (pickerMap) pickerMap.setStyle(styleFor(to));
    } catch (err) {
      console.warn("[PandeMApp] setStyle failed:", err && err.message);
    }
    setCredit(to);
    setTimeout(() => {
      switching = false;
      if (pendingSwitch !== null) {
        const reason = pendingSwitch;
        pendingSwitch = null;
        switchProvider(reason);
      }
    }, 1500);
    armLoadTimeout();
  }

  function locateUser() {
    if (!navigator.geolocation) { $("geoBanner").classList.add("show"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const j = jitter(pos.coords.latitude, pos.coords.longitude, 150);
        userLatLng = { lat: j.lat, lng: j.lng };
        map.flyTo({ center: [j.lng, j.lat], zoom: 13 });
        if (userMarker) userMarker.remove();
        const pulse = document.createElement("div");
        pulse.className = "pulse-marker";
        pulse.innerHTML = '<div class="ring"></div><div class="dot"></div>';
        userMarker = new maplibregl.Marker({ element: pulse })
          .setLngLat([j.lng, j.lat])
          .setPopup(
            new maplibregl.Popup({ closeButton: false, offset: 12 }).setHTML(
              "<b>Your approximate location</b><br><span class='pop-meta'>Jittered by ~150 m for privacy.</span>"
            )
          )
          .addTo(map);
        if (radiusKm && $("radiusCenter").value === "me") applyRadius(true);
        renderStats();
      },
      () => { $("geoBanner").classList.add("show"); },
      { timeout: 8000, maximumAge: 60000 }
    );
  }

  /* ================= markers ================= */
  function withinTimeWindow(report) {
    const t = report.createdAt.getTime();
    if (timeWindow === "custom") {
      if (customFrom && t < customFrom) return false;
      if (customTo && t > customTo) return false;
      return true;
    }
    if (!timeWindow) return true;
    return Date.now() - t <= timeWindow * 86400000;
  }

  function withinRadius(report) {
    if (!radiusKm || !radiusCentre) return true;
    return haversine(radiusCentre.lat, radiusCentre.lng, report.lat, report.lng) <= radiusKm;
  }

  /* One test for every list the user sees: map pins, feed and counts. */
  function passesFilters(report) {
    return withinTimeWindow(report) && withinRadius(report);
  }

  function renderMarkers() {
    if (!map || !mapLoaded) return;   // re-runs from the map "load" handler
    markers.forEach((m) => m.remove());
    markers = [];
    markerIndex.clear();

    const features = [];
    allReports
      .filter((r) => visibleTypes.has(r.type) && passesFilters(r))
      .forEach((r) => {
        const t = typeInfo(r.type);
        // Illness and animal-disease reports get a blurred disc so the exact
        // spot stays private. Breeding risks are places, not people, so they
        // are pinned exactly.
        if (t.group === "illness" || t.group === "animal") features.push(circleFeature(r, 150, t.color));

        const popup = new maplibregl.Popup({ maxWidth: "260px", offset: 16 }).setHTML(popupHtml(r));
        const marker = new maplibregl.Marker({ element: pinElement(r.type), anchor: "bottom" })
          .setLngLat([r.lng, r.lat])
          .setPopup(popup)
          .addTo(map);
        markers.push(marker);
        markerIndex.set(r.id, { layer: marker, report: r });
      });

    circleData = { type: "FeatureCollection", features };
    circleDirty = true;
    ensureDiseaseLayers();
  }

  /* MapLibre has no metre-based circle layer, so build a 150 m polygon — the
     illness blur then stays accurate at every zoom level. */
  function circleFeature(r, radius, color) {
    const steps = 40;
    const coords = [];
    const dLat = radius / 111320;
    const dLng = radius / (111320 * Math.cos((r.lat * Math.PI) / 180));
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      coords.push([r.lng + Math.cos(a) * dLng, r.lat + Math.sin(a) * dLat]);
    }
    return {
      type: "Feature",
      properties: { color: color },
      geometry: { type: "Polygon", coordinates: [coords] }
    };
  }

  function popupHtml(r) {
    const t = typeInfo(r.type);
    const sev = (SEVERITY[t.category] || [])[Math.max(0, Math.min(2, r.severity - 1))] || "";
    const mine = r.userId === currentUserId();
    const ref = userLatLng || map.getCenter();
    const dist = fmtDistance(haversine(ref.lat, ref.lng, r.lat, r.lng));
    return (
      '<div class="pop-title">' + t.icon + " " + escapeHtml(t.label) + "</div>" +
      '<div class="pop-meta">' + (t.group === "illness" ? "Illness report" : t.group === "animal" ? "Animal-spread illness" : "Breeding risk") +
        (sev ? " · " + sev : "") + " · " + timeAgo(r.createdAt) + "</div>" +
      '<div class="pop-meta">📍 ~' + dist + " away</div>" +
      (r.note ? '<div class="pop-note">' + escapeHtml(r.note) + "</div>" : "") +
      (photoUrl(r.photo) ? '<img class="pop-photo" data-photoid="' + r.id + '" src="' + photoUrl(r.photo) + '" alt="Photo attached to this report" />' : "") +
      fileLinkHtml(r) +
      '<div class="pop-actions">' +
        (withdrawControl(r, mine).replace(/data-del=/, "data-withdraw=")) +
      "</div>"
    );
  }

  // Withdraw links live inside map popups, so delegate from the document.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-withdraw]");
    if (!el) return;
    e.preventDefault();
    withdrawReport(el.getAttribute("data-withdraw"));
  });

  async function withdrawReport(id) {
    if (!confirm("Withdraw this report? It will be removed from the map.")) return;
    const res = await Store.removeReport(id);
    if (res.ok) {
      toast("Report withdrawn.", "success");
      renderMarkers();
      renderFeed();
    } else {
      toast("Could not withdraw: " + ((res.error && res.error.code) || "permission denied"), "error");
    }
  }

  /* ================= stats ================= */
  /* Every report shown on the map, once the time filter is applied.

     This used to count only reports within 5 km of the map centre, so the bar
     read 0 while pins were plainly on the map. Counting the viewport instead
     doesn't work either: the India lock holds the map at a zoom where the frame
     cannot show the whole country, so panning north would drop Delhi from the
     count. The pins are drawn for every loaded report, so the bar counts the
     same set the pins do — they can never disagree again. */
  function countedReports() {
    return allReports.filter(passesFilters);
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  function renderStats() {
    if (!map) return;
    const nearby = countedReports();

    const illness = nearby.filter((r) => typeInfo(r.type).group === "illness").length;
    const animal = nearby.filter((r) => typeInfo(r.type).group === "animal").length;
    const risk = nearby.length - illness - animal;
    const water = nearby.filter((r) => WATER_TYPES.includes(r.type)).length;

    $("statIllness").textContent = illness;
    $("statRisk").textContent = risk;
    $("statWater").textContent = water;
    if ($("statAnimal")) $("statAnimal").textContent = animal;
    if ($("wordIllness")) $("wordIllness").textContent = plural(illness, "illness", "illnesses");
    if ($("wordRisk")) $("wordRisk").textContent = plural(risk, "breeding risk", "breeding risks");
    if ($("wordWater")) $("wordWater").textContent = plural(water, "water issue", "water issues");
    if ($("wordAnimal")) $("wordAnimal").textContent = plural(animal, "from animal", "from animals");

    const where = radiusKm && radiusCentre ? "Within " + radiusKm + " km of " + radiusCentre.label : "Across India";
    $("barMeta").textContent = where + " · " + timeRangeLabel() + " · " + nearby.length + " shown";
  }

  /* ================= feed ================= */
  function renderFeed() {
    const list = $("feedList");
    const ref = userLatLng || (map && map.getCenter());
    const items = allReports.filter((r) => visibleTypes.has(r.type) && passesFilters(r)).slice(0, 60);

    $("feedCount").textContent = allReports.length
      ? items.length + " of " + allReports.length + " reports"
      : "No reports yet";

    if (!items.length) {
      list.innerHTML =
        '<div class="empty-state"><span class="big">🗺️</span>' +
        (allReports.length
          ? "No reports match your filters. Try widening the date range or the radius."
          : "No reports in your area yet. Be the first to flag a breeding site.") +
        "</div>";
      return;
    }

    list.innerHTML = items
      .map((r) => {
        const t = typeInfo(r.type);
        const sev = (SEVERITY[t.category] || [])[Math.max(0, Math.min(2, r.severity - 1))] || "";
        const dist = ref ? fmtDistance(haversine(ref.lat, ref.lng, r.lat, r.lng)) : "—";
        const mine = r.userId === currentUserId();
        return (
          '<div class="feed-item" data-focus="' + r.id + '">' +
            '<div class="f-ic" style="background:' + t.color + '1A">' + t.icon + "</div>" +
            '<div class="f-main">' +
              '<div class="f-top">' +
                '<span class="f-type">' + escapeHtml(t.label) + "</span>" +
                '<span class="f-badge ' + t.group + '">' + (t.group === "illness" ? "illness" : t.group === "animal" ? "animal-spread" : "risk") + "</span>" +
              "</div>" +
              '<div class="f-meta">' + timeAgo(r.createdAt) + " · 📍 " + dist + " away" + (sev ? " · " + sev : "") + "</div>" +
              (r.note ? '<div class="f-note">' + escapeHtml(r.note) + "</div>" : "") +
              (photoUrl(r.photo) ? '<img class="f-photo" data-photoid="' + r.id + '" src="' + photoUrl(r.photo) + '" alt="Photo attached to this report" />' : "") +
              fileLinkHtml(r) +
            "</div>" +
            '<div class="f-actions">' +
              '<button class="link-btn" data-goto="' + r.id + '">Show on map</button>' +
              withdrawControl(r, mine) +
            "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  $("feedList").addEventListener("click", (e) => {
    const goto = e.target.closest("[data-goto]");
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      withdrawReport(del.getAttribute("data-del"));
      return;
    }
    if (goto) focusReport(goto.getAttribute("data-goto"));
  });

  function focusReport(id) {
    const entry = markerIndex.get(id);
    if (!entry) {
      toast("That report is hidden by your current filters.", "info");
      return;
    }
    map.flyTo({ center: entry.layer.getLngLat(), zoom: Math.max(map.getZoom(), 14), speed: 1.2 });
    // Don't wait for moveend: if the map is already there, no move happens and
    // the popup would never open.
    const popup = entry.layer.getPopup();
    setTimeout(() => { if (popup && !popup.isOpen()) entry.layer.togglePopup(); }, 400);
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ================= filters ================= */
  function buildFilterChips() {
    const host = $("typeChips");
    const group = (label, icon, keys) =>
      '<button class="chip on" data-group="' + keys.join(",") + '">' + icon + " " + label + "</button>";

    /* Three groups only. With twelve animal diseases on the map, a chip per type
       would mean twenty-one chips — the legend carries the per-type detail instead. */
    host.innerHTML = ["illness", "risk", "animal"]
      .map((g) => group(GROUPS[g].chip, GROUPS[g].icon, typeKeys(g)))
      .join("");

    host.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const keys = chip.dataset.type
        ? [chip.dataset.type]
        : chip.dataset.group.split(",");
      const allOn = keys.every((k) => visibleTypes.has(k));
      keys.forEach((k) => (allOn ? visibleTypes.delete(k) : visibleTypes.add(k)));
      document.querySelectorAll("#typeChips .chip").forEach((c) => {
        const ckeys = c.dataset.type ? [c.dataset.type] : c.dataset.group.split(",");
        c.classList.toggle("on", ckeys.some((k) => visibleTypes.has(k)));
      });
      renderMarkers();
      renderFeed();
    });
  }

  /* Three rows instead of eighteen entries. Each row shows the group's colours and
     a live count, and opens to list the individual types. */
  function buildLegend() {
    const host = $("legendItems");
    host.innerHTML = ["illness", "risk", "animal"]
      .map((g) => {
        const keys = typeKeys(g);
        const dots = keys
          .slice(0, 4)
          .map((k) => '<i class="lg-dot" style="background:' + TYPES[k].color + '"></i>')
          .join("");
        const items = keys
          .map((k) => {
            const t = TYPES[k];
            // a miniature of the actual pin: coloured marker with its emoji inside
            return (
              '<span class="lg-item"><span class="lg-pin" style="background:' + t.color + '">' +
                "<i>" + t.icon + "</i></span>" + t.label + "</span>"
            );
          })
          .join("");
        return (
          '<div class="lg-group">' +
            '<button class="lg-head" data-lg-toggle="' + g + '">' +
              '<span class="lg-caret">▸</span>' +
              GROUPS[g].icon + " " + GROUPS[g].label +
              '<span class="lg-dots">' + dots + "</span>" +
              '<b class="lg-count" data-count="' + g + '">0</b>' +
            "</button>" +
            '<div class="lg-types" data-lg-body="' + g + '" hidden>' + items + "</div>" +
          "</div>"
        );
      })
      .join("");

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-lg-toggle]");
      if (!btn) return;
      const body = host.querySelector('[data-lg-body="' + btn.dataset.lgToggle + '"]');
      if (!body) return;
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      btn.classList.toggle("open", willOpen);
    });
  }

  /* Live counts next to each legend group, so the legend doubles as a tally. */
  function updateLegendCounts() {
    ["illness", "risk", "animal"].forEach((g) => {
      const el = document.querySelector('[data-count="' + g + '"]');
      if (el) el.textContent = allReports.filter((r) => typeInfo(r.type).group === g).length;
    });
  }

  /* ================= report cards + modal ================= */
  /* Each group shows three cards, so the report section stays scannable. The
     third card is an "Other" door: it opens the same form the header button does,
     with every option in that group laid out to choose from. It preselects the
     group's catch-all ("Other fever" / "Something else"), which the grid then
     lets you change.

     Chikungunya, Japanese encephalitis and Zika are offered in the form even
     though they are not cards on the page. */
  const DASHBOARD_ILLNESS = typeKeys("illness");
  const DASHBOARD_ANIMAL  = typeKeys("animal");

  const OTHER_CARDS = {};   // the three tabs list every type, so there are no "Other" doors any more

  function buildReportCards() {
    const illnessGrid = $("illnessGrid");
    const riskGrid = $("riskGrid");
    const animalGrid = $("animalGrid");
    const card = (k) => {
      const t = TYPES[k];
      const isOther = !!OTHER_CARDS[k];
      return (
        '<button class="report-card" data-open="' + k + '">' +
          '<div class="ic" style="background:' + t.color + '18">' + (isOther ? "\u22ef" : t.icon) + "</div>" +
          "<h4>" + (isOther ? "Other" : t.label) + "</h4>" +
          "<p>" + (isOther ? OTHER_CARDS[k] : t.blurb) + "</p>" +
        "</button>"
      );
    };
    illnessGrid.innerHTML = DASHBOARD_ILLNESS.map(card).join("");
    riskGrid.innerHTML = typeKeys("risk").map(card).join("");
    // The third group opens the animal form, which asks one extra question.
    if (animalGrid) animalGrid.innerHTML = DASHBOARD_ANIMAL.map(card).join("");

    document.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.open;
        if (typeInfo(key).group === "animal") openAnimalModal(key);
        else openReportModal(key);
      });
    });
  }

  let modalGroup = "illness";

  function buildModalTypes() {
    /* The grid is filled by fillModalTypes() each time the form opens, so a disease
       report only offers diseases and a breeding-site report only offers sites.
       The twelve animal diseases have their own modal. */
    $("modalTypeGrid").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mtype]");
      if (!b) return;
      selectType(b.dataset.mtype);
    });
  }

  function fillModalTypes(group) {
    modalGroup = group === "risk" ? "risk" : "illness";
    $("modalTypeLabel").textContent = modalGroup === "risk" ? "What kind of breeding site?" : "Which disease?";
    $("modalTypeGrid").innerHTML = typeKeys(modalGroup)
      .map((k) => {
        const t = TYPES[k];
        return '<button class="type-opt" data-mtype="' + k + '"><span class="t-ic">' + t.icon + "</span>" + t.label + "</button>";
      })
      .join("");
  }

  function selectType(key) {
    selectedType = key;
    const t = typeInfo(key);
    document.querySelectorAll("#modalTypeGrid .type-opt").forEach((b) => {
      b.classList.toggle("on", b.dataset.mtype === key);
    });
    $("modalIcon").textContent = t.icon;
    $("modalIcon").style.background = t.color + "22";
    $("modalTitle").textContent = "Report: " + t.label;
    $("modalSub").textContent = t.blurb;
    $("photoHint").textContent = photoHintFor(t.group);
    $("symptomBox").hidden = t.group !== "illness";   // the checker is for diseases only
    buildSeverity(t.category);
  }

  function buildSeverity(category) {
    const opts = SEVERITY[category] || SEVERITY.risk;
    $("severityLabel").textContent = category === "disease" ? "How certain is it?" : "How big is the problem?";
    $("severitySeg").innerHTML = opts
      .map((o, i) => '<button data-sev="' + (i + 1) + '" class="' + (i === 0 ? "on" : "") + '">' + o + "</button>")
      .join("");
    selectedSeverity = 1;
    $("severitySeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sev]");
      if (!b) return;
      selectedSeverity = Number(b.dataset.sev);
      $("severitySeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
  }

  /* ---------- picker map inside the modal ---------- */
  function ensurePickerMap() {
    if (pickerMap || typeof maplibregl === "undefined") return;
    pickerMap = new maplibregl.Map({
      container: "pickerMap",
      style: styleFor(TILE_PROVIDERS[providerIndex]),
      center: INDIA_CENTER,
      zoom: 4,
      minZoom: 3,
      maxZoom: 18,
      maxBounds: INDIA_BOUNDS,
      attributionControl: false
    });
    if (!$("pickerCredit")) {
      const credit = document.createElement("div");
      credit.className = "map-credit small";
      credit.id = "pickerCredit";
      $("pickerMap").appendChild(credit);
    }
    setCredit(TILE_PROVIDERS[providerIndex]);
    pickerMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    pickerMap.on("click", (e) => setPickerPoint(e.lngLat.lat, e.lngLat.lng));
  }

  function setPickerPoint(lat, lng) {
    pendingCoords = { lat, lng };
    if (pickerMarker) pickerMarker.remove();
    pickerMarker = new maplibregl.Marker({ color: "#1565D8" }).setLngLat([lng, lat]).addTo(pickerMap);
    $("locReadout").textContent = lat.toFixed(4) + ", " + lng.toFixed(4) + " ✓ pin placed";
  }

  function openReportModal(typeKey) {
    ensurePickerMap();
    $("overlay").classList.add("show");
    $("reportModal").classList.add("show");
    $("noteInput").value = "";
    $("charCount").textContent = "0";
    setPendingPhoto(null);            // never carry a file into the next report
    fillModalTypes(typeInfo(typeKey || "stagnant_water").group);
    if (illnessChecker) illnessChecker.reset();
    selectType(typeKey || "stagnant_water");

    setTimeout(() => {
      pickerMap.resize();                 // the container was hidden while it mounted
      let center = INDIA_CENTER;          // [lng, lat]
      let zoom = 4;
      if (pendingCoords) { center = [pendingCoords.lng, pendingCoords.lat]; zoom = 16; }
      else if (userLatLng) { center = [userLatLng.lng, userLatLng.lat]; zoom = 16; }
      else if (map) { const c = map.getCenter(); center = [c.lng, c.lat]; zoom = Math.max(map.getZoom(), 13); }
      pickerMap.jumpTo({ center: center, zoom: zoom });
      applyIndiaLock(pickerMap);          // picker is India-locked too
      if (pendingCoords) setPickerPoint(pendingCoords.lat, pendingCoords.lng);
    }, 260);
  }

  function closeReportModal() {
    $("reportModal").classList.remove("show");
    if (!$("profilePanel").classList.contains("show")) $("overlay").classList.remove("show");
  }

  async function submitReport() {
    if (!selectedType) { toast("Choose what you're reporting.", "error"); return; }
    if (!pendingCoords) { toast("Tap the mini-map to place your pin.", "error"); return; }

    const t = typeInfo(selectedType);
    const j = jitter(pendingCoords.lat, pendingCoords.lng, 150);
    const btn = $("submitReportBtn");
    btn.disabled = true;
    btn.textContent = "Submitting…";

    const res = await Store.addReport({
      type: selectedType,
      category: t.category,
      label: t.label,
      lat: j.lat,
      lng: j.lng,
      note: $("noteInput").value.trim(),
      severity: selectedSeverity,
      photo: imageOf(pendingPhoto),
      extra: attachmentExtra(pendingPhoto),
      userId: currentUserId(),
      displayName: currentUser ? currentUser.displayName || "Signed-in user" : "Guest"
    });

    btn.disabled = false;
    btn.textContent = "Submit report";

    if (res.savedTo === "firestore") {
      toast(res.photoDropped
        ? "✅ Report added — the database rejected the file, so it saved without one."
        : "✅ Report added — it's live on the map.", "success");
    } else {
      toast("⚠️ Saved on this device (cloud write blocked). See README to enable Firestore.", "error");
    }

    closeReportModal();
    setTimeout(() => focusReport(res.id), 250);
  }

  /* ================= animal-spread report modal =================
     A second, purpose-built form on the same page — same map, same
     storage, but its own diseases, its own exposure question and its
     own safety notice. Nothing opens in a new tab any more. */
  let aSelectedType = "";
  let aSeverity = 1;
  let aPhoto = null;
  let aCoords = null;
  let aPickerMap = null;
  let aPickerMarker = null;
  let aSaving = false;

  function buildAnimalTypes() {
    const host = $("animalTypeGrid");
    host.innerHTML = typeKeys("animal")
      .map((k) => {
        const t = TYPES[k];
        return '<button class="type-opt" data-atype="' + k + '"><span class="t-ic">' + t.icon + "</span>" + t.label + "</button>";
      })
      .join("");
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-atype]");
      if (b) selectAnimalType(b.dataset.atype);
    });
  }

  function selectAnimalType(key) {
    aSelectedType = key;
    const t = TYPES[key];
    document.querySelectorAll("#animalTypeGrid .type-opt").forEach((b) => b.classList.toggle("on", b.dataset.atype === key));
    $("animalModalIcon").textContent = t.icon;
    $("animalModalTitle").textContent = "Report: " + t.label;
    $("animalModalSub").textContent = t.blurb;
    $("animalPhotoHint").textContent = photoHintFor("animal");
    refreshAnimalAlert();
  }

  function buildAnimalExposure() {
    $("animalExposure").innerHTML = '<option value="">Choose one…</option>' +
      Object.keys(ZOONOTIC_EXPOSURE)
        .map((k) => '<option value="' + k + '">' + ZOONOTIC_EXPOSURE[k] + "</option>")
        .join("");
  }

  function buildAnimalSeverity() {
    $("animalSeveritySeg").innerHTML = (SEVERITY.disease || [])
      .map((o, i) => '<button data-asev="' + (i + 1) + '" class="' + (i === 0 ? "on" : "") + '">' + o + "</button>")
      .join("");
    $("animalSeveritySeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-asev]");
      if (!b) return;
      aSeverity = Number(b.dataset.asev);
      $("animalSeveritySeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
  }

  /* Bites and scratches need the rabies advice even when rabies isn't the guess. */
  function refreshAnimalAlert() {
    $("animalRabiesAlert").hidden = !(aSelectedType === "rabies" || $("animalExposure").value === "bite");
  }

  function setAnimalPhoto(f) {
    aPhoto = f || null;
    paintFile(FILE_UI.animal, aPhoto);
  }

  function ensureAnimalPickerMap() {
    if (aPickerMap || typeof maplibregl === "undefined") return;
    aPickerMap = new maplibregl.Map({
      container: "animalPickerMap",
      style: styleFor(TILE_PROVIDERS[providerIndex]),
      center: INDIA_CENTER, zoom: 4, minZoom: 3, maxZoom: 18,
      maxBounds: INDIA_BOUNDS, attributionControl: false
    });
    aPickerMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    aPickerMap.on("click", (e) => setAnimalPoint(e.lngLat.lat, e.lngLat.lng));
  }

  function setAnimalPoint(lat, lng) {
    if (lat < INDIA_BOUNDS[0][1] || lat > INDIA_BOUNDS[1][1] ||
        lng < INDIA_BOUNDS[0][0] || lng > INDIA_BOUNDS[1][0]) {
      toast("That point is outside India.", "error");
      return;
    }
    aCoords = { lat, lng };
    if (aPickerMarker) aPickerMarker.remove();
    aPickerMarker = new maplibregl.Marker({ color: "#1565D8" }).setLngLat([lng, lat]).addTo(aPickerMap);
    $("animalLocReadout").textContent = lat.toFixed(4) + ", " + lng.toFixed(4) + " ✓ pin placed";
  }

  function openAnimalModal(typeKey) {
    ensureAnimalPickerMap();
    $("overlay").classList.add("show");
    $("animalModal").classList.add("show");
    $("animalNoteInput").value = "";
    $("animalCharCount").textContent = "0";
    setAnimalPhoto(null);
    aSeverity = 1;
    aCoords = null;
    if (aPickerMarker) { aPickerMarker.remove(); aPickerMarker = null; }
    $("animalLocReadout").textContent = "No pin dropped yet — tap the map above.";
    if (animalChecker) animalChecker.reset();
    selectAnimalType(typeInfo(typeKey).group === "animal" ? typeKey : "rabies");

    setTimeout(() => {
      if (!aPickerMap) return;
      aPickerMap.resize();
      let center = INDIA_CENTER, zoom = 4;
      if (userLatLng) { center = [userLatLng.lng, userLatLng.lat]; zoom = 16; }
      else if (map) { const c = map.getCenter(); center = [c.lng, c.lat]; zoom = Math.max(map.getZoom(), 13); }
      aPickerMap.jumpTo({ center: center, zoom: zoom });
      applyIndiaLock(aPickerMap);
    }, 260);
  }

  function closeAnimalModal() {
    $("animalModal").classList.remove("show");
    if (!$("profilePanel").classList.contains("show")) $("overlay").classList.remove("show");
  }

  async function submitAnimalReport() {
    if (!aSelectedType) { toast("Choose which disease you are reporting.", "error"); return; }
    if (!$("animalExposure").value) { toast("Choose how you think it spread to you.", "error"); return; }
    if (!aCoords) { toast("Tap the mini-map to place your pin.", "error"); return; }
    if (aSaving) return;

    const t = TYPES[aSelectedType];
    const j = jitter(aCoords.lat, aCoords.lng, 150);
    const btn = $("animalSubmitBtn");
    aSaving = true;
    btn.disabled = true;
    btn.textContent = "Submitting…";

    const res = await Store.addReport({
      type: aSelectedType,
      category: t.category,          // stays "disease" — the rules reject anything else
      label: t.label,
      lat: j.lat,
      lng: j.lng,
      note: $("animalNoteInput").value.trim(),
      severity: aSeverity,
      photo: imageOf(aPhoto),
      userId: currentUserId(),
      displayName: currentUser ? currentUser.displayName || "Signed-in user" : "Guest",
      extra: Object.assign({
        track: "zoonotic",
        exposure: $("animalExposure").value,
        exposureLabel: ZOONOTIC_EXPOSURE[$("animalExposure").value],
        onsetDate: ""
      }, attachmentExtra(aPhoto))
    });

    aSaving = false;
    btn.disabled = false;
    btn.textContent = "Submit report";

    if (res.savedTo === "firestore") {
      toast(res.photoDropped
        ? "✅ Report added — the database rejected the file, so it saved without one."
        : "✅ Report added — it's live on the map.", "success");
    } else {
      toast("⚠️ Saved on this device (cloud write blocked). See README to enable Firestore.", "error");
    }

    closeAnimalModal();
    setTimeout(() => focusReport(res.id), 250);
  }

  /* ================= file inputs (image or small PDF) ================= */
  function wireFileInput(ui, setter, getter) {
    $(ui.pick).addEventListener("click", () => $(ui.input).click());
    $(ui.rm).addEventListener("click", () => setter(null));
    $(ui.input).addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const btn = $(ui.pick);
      btn.disabled = true;
      btn.textContent = "⏳ Processing…";
      try {
        const f = await prepareFile(file);
        setter(f);
        toast("File ready — " + fileKb(f) + " KB.", "success");
      } catch (err) {
        toast(err && err.message ? err.message : "Could not read that file.", "error");
        paintFile(ui, getter());          // keep whatever was attached before
        $(ui.input).value = "";
      }
      btn.disabled = false;
    });
  }

  function wireFileInputs() {
    wireFileInput(FILE_UI.main, setPendingPhoto, () => pendingPhoto);
    wireFileInput(FILE_UI.animal, setAnimalPhoto, () => aPhoto);
  }

  /* ================= date filter ================= */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

  function timeRangeLabel() {
    if (timeWindow === "custom") {
      const f = $("dateFrom").value, t = $("dateTo").value;
      if (f && t) return f + " to " + t;
      if (f) return "from " + f;
      if (t) return "until " + t;
      return "all dates";
    }
    return timeWindow ? "last " + timeWindow + " days" : "all time";
  }

  function readCustomDates() {
    const f = $("dateFrom").value, t = $("dateTo").value;
    customFrom = f ? new Date(f + "T00:00:00").getTime() : 0;
    customTo = t ? new Date(t + "T23:59:59.999").getTime() : 0;
  }

  function refreshFiltered() {
    renderMarkers();
    renderFeed();
    renderStats();
  }

  function wireDateFilter() {
    const sel = $("timeSelect"), box = $("dateRange"), from = $("dateFrom"), to = $("dateTo");
    from.max = to.max = ymd(new Date());

    sel.addEventListener("change", () => {
      if (sel.value === "custom") {
        timeWindow = "custom";
        box.hidden = false;
        if (!from.value && !to.value) {
          const d = new Date();
          d.setDate(d.getDate() - 10);
          from.value = ymd(d);
          to.value = ymd(new Date());
        }
        readCustomDates();
      } else {
        timeWindow = Number(sel.value);
        box.hidden = true;
      }
      refreshFiltered();
    });

    function onDate() {
      if (from.value && to.value && from.value > to.value) {
        toast("The start date is after the end date.", "error");
        return;
      }
      readCustomDates();
      refreshFiltered();
    }
    from.addEventListener("change", onDate);
    to.addEventListener("change", onDate);
  }

  /* ================= radius filter =================
     The centre is fixed at the moment the radius is chosen, so panning the map
     afterwards doesn't silently change which reports count. */
  function radiusCentreFromUI() {
    const mode = $("radiusCenter").value;
    if (mode === "city" && searchedCity) return { lat: searchedCity.lat, lng: searchedCity.lng, label: searchedCity.name };
    if (mode === "me") {
      return userLatLng ? { lat: userLatLng.lat, lng: userLatLng.lng, label: "your location" } : null;
    }
    if (map) {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng, label: "the map centre" };
    }
    return null;
  }

  function fitRadius() {
    if (!map || !radiusCentre) return;
    const c = radiusCentre;
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.cos((c.lat * Math.PI) / 180));
    try {
      map.fitBounds([[c.lng - dLng, c.lat - dLat], [c.lng + dLng, c.lat + dLat]], { padding: 40, maxZoom: 15 });
    } catch (e) { /* map not ready */ }
  }

  function applyRadius(silent) {
    radiusKm = Number($("radiusSelect").value) || 0;
    radiusCentre = null;
    if (radiusKm) {
      radiusCentre = radiusCentreFromUI();
      if (!radiusCentre) {
        if (!silent) toast("Your location isn't available — measuring from the centre of the map instead.", "info");
        $("radiusCenter").value = "map";
        radiusCentre = radiusCentreFromUI();
      }
    }
    ringData = radiusCentre
      ? { type: "FeatureCollection", features: [circleFeature(radiusCentre, radiusKm * 1000, "#1565D8")] }
      : { type: "FeatureCollection", features: [] };
    ringDirty = true;
    ensureDiseaseLayers();
    $("radiusNote").textContent = radiusCentre
      ? "Showing reports within " + radiusKm + " km of " + radiusCentre.label + "."
      : "";
    if (radiusCentre && !silent) fitRadius();
    refreshFiltered();
  }

  function wireRadius() {
    $("radiusSelect").addEventListener("change", () => applyRadius());
    $("radiusCenter").addEventListener("change", () => applyRadius());
  }

  /* ================= reporting tabs ================= */
  function showReportTab(name, focus) {
    const tabs = Array.from(document.querySelectorAll("#reportTabs .tab"));
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  function wireReportTabs() {
    const bar = $("reportTabs");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const t = e.target.closest(".tab");
      if (t) showReportTab(t.dataset.tab);
    });
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const tabs = Array.from(bar.querySelectorAll(".tab"));
      const i = tabs.findIndex((t) => t.classList.contains("on"));
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      showReportTab(next.dataset.tab, true);
      e.preventDefault();
    });
    showReportTab("illness");
  }

  /* ================= symptom checker =================
     General information only. It scores the ticked symptoms against a short profile
     of each reportable disease and offers the closest ones as a starting point for
     the report. It never diagnoses, and the form says so. Warning signs always
     point the person to a doctor first. */
  const SYMPTOMS = {
    fever: "Fever", chills: "Chills / shivering", sweats: "Heavy sweating", headache: "Headache",
    eye_pain: "Pain behind the eyes", joint_pain: "Joint pain", muscle_pain: "Muscle / body ache",
    rash: "Skin rash", red_eyes: "Red eyes", nausea: "Nausea / vomiting", fatigue: "Extreme tiredness",
    cough: "Cough", sore_throat: "Sore throat / runny nose", breathless: "Difficulty breathing",
    confusion: "Confusion or drowsiness", seizures: "Seizures / fits", stiff_neck: "Stiff neck",
    bleeding: "Bleeding or bruising", abdo_pain: "Severe stomach pain", jaundice: "Yellow skin or eyes",
    swollen_nodes: "Swollen, tender lumps (glands)", black_sore: "Painless black sore or scab",
    bite: "Animal bite or scratch", tick_bite: "Tick or mite bite", swallowing: "Trouble swallowing / fear of water",
    tingling: "Tingling or pain at a bite wound", anxiety: "Agitation or anxiety"
  };

  /* Symptoms that should send someone to a doctor today. */
  const DANGER_SYMPTOMS = new Set(["breathless", "confusion", "seizures", "stiff_neck", "bleeding", "abdo_pain", "swallowing", "jaundice"]);

  const DISEASE_SYMPTOMS = {
    dengue:        ["fever", "headache", "eye_pain", "joint_pain", "muscle_pain", "rash", "nausea", "bleeding", "abdo_pain"],
    malaria:       ["fever", "chills", "sweats", "headache", "nausea", "muscle_pain", "fatigue"],
    chikungunya:   ["fever", "joint_pain", "rash", "headache", "muscle_pain", "fatigue"],
    jp_enceph:     ["fever", "headache", "nausea", "confusion", "seizures", "stiff_neck"],
    zika:          ["fever", "rash", "red_eyes", "joint_pain", "headache"],
    other_fever:   ["fever"],
    rabies:        ["bite", "tingling", "fever", "anxiety", "swallowing", "confusion", "headache"],
    nipah:         ["fever", "headache", "confusion", "cough", "breathless", "nausea", "seizures", "muscle_pain"],
    leptospirosis: ["fever", "muscle_pain", "red_eyes", "headache", "jaundice", "nausea", "chills"],
    anthrax:       ["black_sore", "fever", "cough", "breathless", "nausea"],
    brucellosis:   ["fever", "sweats", "joint_pain", "fatigue", "muscle_pain", "headache"],
    plague:        ["fever", "swollen_nodes", "chills", "fatigue", "cough"],
    kyasanur:      ["fever", "headache", "muscle_pain", "bleeding", "nausea", "tick_bite"],
    cchf:          ["fever", "bleeding", "headache", "muscle_pain", "nausea", "tick_bite", "abdo_pain"],
    avian_flu:     ["fever", "cough", "breathless", "sore_throat", "muscle_pain"],
    swine_flu:     ["fever", "cough", "sore_throat", "muscle_pain", "headache", "fatigue"],
    scrub_typhus:  ["fever", "black_sore", "headache", "rash", "muscle_pain", "tick_bite", "cough"]
  };

  const ILLNESS_SYMPTOM_LIST = ["fever", "chills", "sweats", "headache", "eye_pain", "joint_pain", "muscle_pain", "rash",
    "red_eyes", "nausea", "fatigue", "confusion", "seizures", "stiff_neck", "bleeding", "abdo_pain"];
  const ANIMAL_SYMPTOM_LIST = ["fever", "chills", "sweats", "headache", "muscle_pain", "joint_pain", "rash", "red_eyes",
    "nausea", "fatigue", "cough", "sore_throat", "breathless", "confusion", "seizures", "bleeding", "abdo_pain",
    "jaundice", "swollen_nodes", "black_sore", "bite", "tick_bite", "swallowing", "tingling", "anxiety"];

  let illnessChecker = null;
  let animalChecker = null;

  function makeSymptomChecker(cfg) {
    const selected = new Set();
    const grid = $(cfg.grid), danger = $(cfg.danger), result = $(cfg.result);

    function render() {
      grid.innerHTML = cfg.symptoms
        .map((k) =>
          '<button type="button" class="sym-chip' + (DANGER_SYMPTOMS.has(k) ? " warn" : "") +
          (selected.has(k) ? " on" : "") + '" data-sym="' + k + '" aria-pressed="' + selected.has(k) + '">' +
          SYMPTOMS[k] + "</button>")
        .join("");
    }

    function update() {
      const sel = Array.from(selected);

      const msgs = [];
      if (sel.some((k) => DANGER_SYMPTOMS.has(k))) {
        msgs.push("<strong>Some of these can be warning signs.</strong> Please see a doctor or go to a hospital today. Filing a report does not replace medical care.");
      }
      if (selected.has("bite")) {
        msgs.push("<strong>After an animal bite or scratch</strong>, wash the wound with soap and running water for 15 minutes and go to a hospital or clinic today to ask about rabies vaccination.");
      }
      danger.innerHTML = msgs.map((m) => "<div>" + m + "</div>").join("");
      danger.hidden = !msgs.length;

      if (!sel.length) {
        result.innerHTML = '<div class="sym-empty">Tick the symptoms the patient has to see which report type is the closest match.</div>';
        return;
      }

      const scored = cfg.candidates()
        .map((k) => {
          const profile = DISEASE_SYMPTOMS[k] || [];
          const matched = sel.filter((x) => profile.indexOf(x) >= 0).length;
          const precision = matched / sel.length;          // how much of what was ticked it explains
          const recall = profile.length ? matched / profile.length : 0;   // how much of its usual picture was ticked
          const score = matched ? (2 * precision * recall) / (precision + recall) : 0;
          return { k: k, matched: matched, score: score };
        })
        .filter((x) => x.matched > 0)
        .sort((a, b) => b.score - a.score || b.matched - a.matched)
        .slice(0, 3);

      if (!scored.length) {
        result.innerHTML = '<div class="sym-empty">None of the listed conditions is a close match. You can still pick one above, or choose the “other” option.</div>';
        return;
      }

      result.innerHTML =
        '<div class="sym-empty">Closest matches to report — not a diagnosis:</div>' +
        scored.map((x) => {
          const t = TYPES[x.k];
          return (
            '<div class="sym-hit"><span>' + t.icon + '</span>' +
            '<span class="s-name">' + escapeHtml(t.label) +
              "<small>Matches " + x.matched + " of your " + sel.length + " symptom" + (sel.length === 1 ? "" : "s") + "</small></span>" +
            '<button type="button" class="btn btn-ghost" data-sym-pick="' + x.k + '">Use this</button></div>'
          );
        }).join("");
    }

    grid.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sym]");
      if (!b) return;
      const k = b.dataset.sym;
      if (selected.has(k)) selected.delete(k); else selected.add(k);
      b.classList.toggle("on", selected.has(k));
      b.setAttribute("aria-pressed", selected.has(k) ? "true" : "false");
      update();
    });

    result.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sym-pick]");
      if (!b) return;
      cfg.onPick(b.dataset.symPick);
      toast("Selected " + TYPES[b.dataset.symPick].label + " — change it above if it isn't right.", "info");
    });

    return {
      reset: function () { selected.clear(); render(); update(); }
    };
  }

  function wireSymptomCheckers() {
    illnessChecker = makeSymptomChecker({
      grid: "symptomGrid", danger: "symptomDanger", result: "symptomResult",
      symptoms: ILLNESS_SYMPTOM_LIST,
      candidates: () => typeKeys("illness"),
      onPick: (k) => selectType(k)
    });
    animalChecker = makeSymptomChecker({
      grid: "animalSymptomGrid", danger: "animalSymptomDanger", result: "animalSymptomResult",
      symptoms: ANIMAL_SYMPTOM_LIST,
      candidates: () => typeKeys("animal").filter((k) => DISEASE_SYMPTOMS[k]),
      onPick: (k) => selectAnimalType(k)
    });
    illnessChecker.reset();
    animalChecker.reset();
  }

  /* ================= services: city outbreak check =================
     A built-in list of major Indian cities works instantly and offline. Anything
     else is looked up on OpenStreetMap's Nominatim, limited to India. */
  const CITIES = [
    ["Delhi", "Delhi", 28.61, 77.21], ["Mumbai", "Maharashtra", 19.08, 72.88], ["Kolkata", "West Bengal", 22.57, 88.36],
    ["Chennai", "Tamil Nadu", 13.08, 80.27], ["Bengaluru", "Karnataka", 12.97, 77.59], ["Hyderabad", "Telangana", 17.39, 78.49],
    ["Ahmedabad", "Gujarat", 23.02, 72.57], ["Pune", "Maharashtra", 18.52, 73.86], ["Jaipur", "Rajasthan", 26.91, 75.79],
    ["Lucknow", "Uttar Pradesh", 26.85, 80.95], ["Kanpur", "Uttar Pradesh", 26.45, 80.35], ["Nagpur", "Maharashtra", 21.15, 79.09],
    ["Indore", "Madhya Pradesh", 22.72, 75.86], ["Bhopal", "Madhya Pradesh", 23.26, 77.41], ["Patna", "Bihar", 25.59, 85.14],
    ["Surat", "Gujarat", 21.17, 72.83], ["Vadodara", "Gujarat", 22.31, 73.18], ["Rajkot", "Gujarat", 22.30, 70.80],
    ["Visakhapatnam", "Andhra Pradesh", 17.69, 83.22], ["Vijayawada", "Andhra Pradesh", 16.51, 80.65], ["Warangal", "Telangana", 17.97, 79.60],
    ["Coimbatore", "Tamil Nadu", 11.02, 76.96], ["Madurai", "Tamil Nadu", 9.92, 78.12], ["Tiruchirappalli", "Tamil Nadu", 10.79, 78.70],
    ["Puducherry", "Puducherry", 11.93, 79.83], ["Kochi", "Kerala", 9.93, 76.27], ["Thiruvananthapuram", "Kerala", 8.52, 76.94],
    ["Kozhikode", "Kerala", 11.26, 75.78], ["Thrissur", "Kerala", 10.53, 76.21], ["Mysuru", "Karnataka", 12.30, 76.64],
    ["Mangaluru", "Karnataka", 12.91, 74.86], ["Chandigarh", "Chandigarh", 30.73, 76.78], ["Amritsar", "Punjab", 31.63, 74.87],
    ["Ludhiana", "Punjab", 30.90, 75.86], ["Dehradun", "Uttarakhand", 30.32, 78.03], ["Shimla", "Himachal Pradesh", 31.10, 77.17],
    ["Srinagar", "Jammu & Kashmir", 34.08, 74.80], ["Jammu", "Jammu & Kashmir", 32.73, 74.86], ["Ghaziabad", "Uttar Pradesh", 28.67, 77.45],
    ["Noida", "Uttar Pradesh", 28.54, 77.39], ["Gurugram", "Haryana", 28.46, 77.03], ["Faridabad", "Haryana", 28.41, 77.31],
    ["Meerut", "Uttar Pradesh", 28.98, 77.71], ["Agra", "Uttar Pradesh", 27.18, 78.01], ["Varanasi", "Uttar Pradesh", 25.32, 82.97],
    ["Prayagraj", "Uttar Pradesh", 25.44, 81.85], ["Gorakhpur", "Uttar Pradesh", 26.76, 83.37], ["Jodhpur", "Rajasthan", 26.24, 73.02],
    ["Udaipur", "Rajasthan", 24.59, 73.71], ["Nashik", "Maharashtra", 19.99, 73.79], ["Aurangabad", "Maharashtra", 19.88, 75.34],
    ["Jabalpur", "Madhya Pradesh", 23.18, 79.95], ["Gwalior", "Madhya Pradesh", 26.22, 78.18], ["Raipur", "Chhattisgarh", 21.25, 81.63],
    ["Ranchi", "Jharkhand", 23.34, 85.31], ["Jamshedpur", "Jharkhand", 22.80, 86.20], ["Dhanbad", "Jharkhand", 23.80, 86.43],
    ["Bhubaneswar", "Odisha", 20.30, 85.82], ["Guwahati", "Assam", 26.14, 91.74], ["Siliguri", "West Bengal", 26.73, 88.40],
    ["Shillong", "Meghalaya", 25.58, 91.89], ["Imphal", "Manipur", 24.82, 93.94], ["Panaji", "Goa", 15.50, 73.83]
  ];

  const CITY_ALIASES = {
    "new delhi": "Delhi", "bangalore": "Bengaluru", "bombay": "Mumbai", "calcutta": "Kolkata", "madras": "Chennai",
    "trivandrum": "Thiruvananthapuram", "gurgaon": "Gurugram", "mysore": "Mysuru", "cochin": "Kochi",
    "allahabad": "Prayagraj", "vizag": "Visakhapatnam", "baroda": "Vadodara", "banaras": "Varanasi",
    "benares": "Varanasi", "pondicherry": "Puducherry", "calicut": "Kozhikode", "panjim": "Panaji",
    "trichy": "Tiruchirappalli", "mangalore": "Mangaluru"
  };

  const QUICK_CITIES = ["Delhi", "Mumbai", "Kolkata", "Chennai", "Bengaluru", "Hyderabad", "Pune", "Ahmedabad", "Kochi", "Lucknow", "Ghaziabad", "Guwahati"];

  let svcCity = null;
  let svcKm = 25;
  let svcDays = 30;

  function cityEntry(c) { return { name: c[0], sub: c[1], lat: c[2], lng: c[3] }; }

  function findCity(q) {
    const key = q.trim().toLowerCase().replace(/\s+/g, " ").replace(/,.*$/, "");
    const canon = (CITY_ALIASES[key] || key).toLowerCase();
    let hit = CITIES.find((c) => c[0].toLowerCase() === canon);
    if (!hit && canon.length >= 3) hit = CITIES.find((c) => c[0].toLowerCase().indexOf(canon) === 0);
    return hit ? cityEntry(hit) : null;
  }

  function insideIndia(lat, lng) {
    return lat >= INDIA_BOUNDS[0][1] && lat <= INDIA_BOUNDS[1][1] && lng >= INDIA_BOUNDS[0][0] && lng <= INDIA_BOUNDS[1][0];
  }

  async function geocodeCity(q) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=" + encodeURIComponent(q),
        { headers: { Accept: "application/json" }, signal: ctrl.signal }
      );
      if (!res.ok) throw new Error("lookup failed");
      const arr = await res.json();
      if (!arr || !arr.length) return null;
      const parts = String(arr[0].display_name || q).split(",").map((x) => x.trim());
      return { name: parts[0] || q, sub: parts.slice(1, 3).join(", "), lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchCity(raw) {
    const q = String(raw || "").trim();
    if (q.length < 2) { toast("Type at least two letters of a city name.", "error"); return; }

    let city = findCity(q);
    if (!city) {
      const btn = $("citySearchBtn");
      btn.disabled = true;
      btn.textContent = "Searching…";
      try {
        city = await geocodeCity(q);
        if (!city) toast("We couldn't find that place in India. Check the spelling or try a nearby larger city.", "error");
      } catch (err) {
        toast("City lookup is unavailable right now — try one of the suggested cities.", "error");
      }
      btn.disabled = false;
      btn.textContent = "🔍 Search";
      if (!city) return;
    }

    if (!isFinite(city.lat) || !isFinite(city.lng) || !insideIndia(city.lat, city.lng)) {
      toast("PandeMApp covers India only — that place is outside the map.", "error");
      return;
    }
    showCity(city);
  }

  function nearMe() {
    if (!navigator.geolocation) { toast("Location isn't available in this browser. Search for a city instead.", "error"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const j = jitter(pos.coords.latitude, pos.coords.longitude, 150);
        if (!insideIndia(j.lat, j.lng)) { toast("Your location is outside India — search for an Indian city instead.", "error"); return; }
        $("cityInput").value = "";
        showCity({ name: "Your area", sub: "Based on your approximate location", lat: j.lat, lng: j.lng });
      },
      () => toast("Couldn't get your location. Search for a city instead.", "error"),
      { timeout: 8000, maximumAge: 60000 }
    );
  }

  function showCity(city) {
    svcCity = city;
    searchedCity = city;
    const opt = $("radiusCenter").querySelector('option[value="city"]');
    if (opt) { opt.disabled = false; opt.textContent = "Searched city: " + city.name; }
    if (city.name !== "Your area") $("cityInput").value = city.name;
    $("cityEmpty").hidden = true;
    $("cityResult").hidden = false;
    renderCityResult();
  }

  function refreshCityResult() {
    if (svcCity && !$("cityResult").hidden) renderCityResult();
  }

  /* General precautions only — nothing here is medical advice, and the panel says so. */
  function safetyTips(g) {
    const groups = [{
      title: "Before you go out",
      items: [
        "Check your state health department or city municipal body for official advisories before you travel.",
        "Carry clean drinking water, wash hands often and eat freshly cooked food.",
        "If you get a fever, rash or severe pain after going out, see a doctor — don't wait or self-medicate."
      ]
    }];

    if (g.illness > 0 || g.risk > 0) {
      groups.push({
        title: "Mosquito bites",
        items: [
          "Wear light-coloured, full-sleeved shirts and long trousers. Some mosquitoes (such as those that spread dengue) bite in the daytime, others at dawn and dusk.",
          "Use a mosquito repellent as directed on its label, and sleep under a net or in a screened or air-conditioned room.",
          "Avoid places with standing water, blocked drains or heaps of garbage — mosquitoes breed there.",
          "If you are pregnant or have a long-term illness, ask your doctor before travelling to an area with mosquito-borne illness."
        ]
      });
    } else {
      groups.push({
        title: "Everyday protection",
        items: ["Even where nothing is reported, mosquitoes are common in India — cover arms and legs and use repellent at dawn and dusk."]
      });
    }

    if (g.risk > 0) {
      groups.push({
        title: "Water and drains",
        items: [
          "Avoid wading through floodwater or puddles, and wear closed footwear — floodwater can carry germs such as those that cause leptospirosis.",
          "Report standing water, blocked drains or uncollected garbage to your municipal helpline."
        ]
      });
    }

    if (g.animal > 0) {
      groups.push({
        title: "Animals, ticks and food",
        items: [
          "Keep away from stray or unfamiliar animals; don't feed or touch them.",
          "If an animal bites or scratches you, wash the wound with soap and running water for 15 minutes and go to a hospital or clinic the same day.",
          "Avoid raw date-palm sap and fruit that has fallen under trees or may have been bitten by bats.",
          "In grass or forest, wear long trousers tucked into socks to guard against ticks and mites.",
          "Eat well-cooked meat, poultry and eggs, and drink boiled or pasteurised milk."
        ]
      });
    }
    return groups;
  }

  function renderCityResult() {
    const city = svcCity;
    if (!city) return;

    const cutoff = Date.now() - svcDays * 86400000;
    const rows = allReports
      .filter((r) => r.createdAt.getTime() >= cutoff)
      .map((r) => ({ r: r, d: haversine(city.lat, city.lng, r.lat, r.lng) }))
      .filter((x) => x.d <= svcKm);

    const g = { illness: 0, risk: 0, animal: 0 };
    const byType = {};
    rows.forEach((x) => {
      g[typeInfo(x.r.type).group]++;
      byType[x.r.type] = (byType[x.r.type] || 0) + 1;
    });
    const total = rows.length;

    const level = total === 0 ? ["none", "No community reports"]
      : total < 5 ? ["few", "A few community reports"]
      : total < 15 ? ["several", "Several community reports"]
      : ["many", "Many community reports"];

    const typeChips = Object.keys(byType)
      .sort((a, b) => byType[b] - byType[a])
      .map((k) => {
        const t = typeInfo(k);
        return '<span class="svc-type"><i>' + t.icon + "</i>" + escapeHtml(t.label) + " <em>×" + byType[k] + "</em></span>";
      })
      .join("");

    const recent = rows.slice(0, 5)
      .map((x) => {
        const t = typeInfo(x.r.type);
        return (
          '<div class="r-row"><span>' + t.icon + '</span><span class="r-main">' + escapeHtml(t.label) + "</span>" +
          '<span class="r-meta">' + fmtDistance(x.d) + " away · " + timeAgo(x.r.createdAt) + "</span></div>"
        );
      })
      .join("");

    const sel = (name, values, current, unit) =>
      '<select class="time-select" data-svc-' + name + ' aria-label="' + name + '">' +
      values.map((v) => '<option value="' + v + '"' + (v === current ? " selected" : "") + ">" + v + " " + unit + "</option>").join("") +
      "</select>";

    const tips = safetyTips(g)
      .map((grp) =>
        '<div class="tip-group">' + escapeHtml(grp.title) + "</div><ul>" +
        grp.items.map((i) => "<li>" + escapeHtml(i) + "</li>").join("") + "</ul>")
      .join("");

    $("cityResult").innerHTML =
      '<div class="svc-head"><div><h3>' + escapeHtml(city.name) + "</h3>" +
        '<div class="bar-meta">' + escapeHtml(city.sub || "India") + "</div></div>" +
        '<span class="svc-level ' + level[0] + '">● ' + level[1] + "</span></div>" +

      '<div class="bar-row"><span class="bar-label">Within</span>' + sel("km", [10, 25, 50], svcKm, "km") +
        '<span class="bar-label">Last</span>' + sel("days", [7, 30, 90], svcDays, "days") + "</div>" +

      '<div class="svc-tiles">' +
        '<div class="svc-tile"><b>' + total + "</b><span>Total reports</span></div>" +
        '<div class="svc-tile"><b>' + g.illness + "</b><span>Diseases</span></div>" +
        '<div class="svc-tile"><b>' + g.risk + "</b><span>Breeding sites</span></div>" +
        '<div class="svc-tile"><b>' + g.animal + "</b><span>Animal-borne</span></div>" +
      "</div>" +

      (total
        ? '<div><div class="svc-sub">Reported in the last ' + svcDays + " days, within " + svcKm + ' km</div><div class="svc-types">' + typeChips + "</div></div>" +
          '<div><div class="svc-sub">Most recent</div><div class="svc-recent">' + recent + "</div></div>"
        : '<div class="svc-note" style="background:var(--bg);border-color:var(--line);color:var(--ink-soft)">No community reports found here in this period. That does <b>not</b> mean there are no cases — few people may be using the app in this area, and reports are unverified.</div>') +

      '<div class="svc-tips"><h4>🧭 Safety recommendations for going out</h4>' + tips + "</div>" +

      '<div class="svc-actions">' +
        '<button class="btn btn-primary" data-svc="map">🗺️ Show on the map</button>' +
        '<a class="btn btn-ghost" href="#report">📝 Report an issue</a>' +
      "</div>" +

      '<div class="svc-note"><b>Not a health advice website.</b> These counts come only from unverified community reports and are not an official outbreak status. The tips are general precautions, not medical advice. Check with your local health department and see a doctor if you feel unwell.</div>';
  }

  function showCityOnMap() {
    if (!svcCity) return;
    searchedCity = svcCity;
    $("radiusCenter").value = "city";
    $("radiusSelect").value = String(svcKm);
    if (svcDays === 7 || svcDays === 30 || svcDays === 90) {
      $("timeSelect").value = String(svcDays);
      $("dateRange").hidden = true;
      timeWindow = svcDays;
    }
    applyRadius();
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function wireServices() {
    $("cityList").innerHTML = CITIES.map((c) => '<option value="' + escapeHtml(c[0]) + '"></option>').join("");
    $("cityQuick").innerHTML = QUICK_CITIES
      .map((n) => '<button class="chip" type="button" data-city="' + n + '">' + n + "</button>")
      .join("");

    $("cityQuick").addEventListener("click", (e) => {
      const b = e.target.closest("[data-city]");
      if (b) searchCity(b.dataset.city);
    });
    $("citySearchBtn").addEventListener("click", () => searchCity($("cityInput").value));
    $("cityInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchCity($("cityInput").value); } });
    $("cityNearMeBtn").addEventListener("click", nearMe);

    $("cityResult").addEventListener("change", (e) => {
      const km = e.target.closest("[data-svc-km]");
      const days = e.target.closest("[data-svc-days]");
      if (km) svcKm = Number(km.value);
      if (days) svcDays = Number(days.value);
      if (km || days) renderCityResult();
    });
    $("cityResult").addEventListener("click", (e) => {
      if (e.target.closest('[data-svc="map"]')) showCityOnMap();
    });
  }

  /* ================= auth (optional) ================= */
  function updateAccountUI() {
    const signedIn = !!currentUser;
    $("signedInBlock").style.display = signedIn ? "block" : "none";
    $("guestBlock").style.display = signedIn ? "none" : "block";
    $("googleSignInBtn").style.display = signedIn ? "none" : "flex";
    $("signOutBtn").style.display = signedIn ? "flex" : "none";

    const myId = currentUserId();
    const mine = allReports.filter((r) => r.userId === myId).length;
    if (signedIn) {
      $("panelReports").textContent = mine;
    } else {
      $("guestReports").textContent = mine;
      $("guestStorage").textContent = Store.getMode() === "firestore" ? "Cloud database" : "This browser";
    }
    setAvatar(signedIn ? currentUser : null);
  }

  async function syncUserProfile(user) {
    if (!db) return;
    try {
      const ref = db.collection("users").doc(user.uid);
      const snap = await ref.get();
      const payload = {
        uid: user.uid,
        name: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        lastLogin: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (!snap.exists) {
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await ref.set(payload, { merge: true });
      } else {
        await ref.update({ lastLogin: payload.lastLogin });
      }
    } catch (err) {
      // Non-fatal: profile sync is a nice-to-have, reporting still works.
      console.warn("[PandeMApp] Profile sync failed:", err && err.code);
    }
  }

  function wireAuth() {
    if (!auth) { updateAccountUI(); return; }

    auth.onAuthStateChanged(async (user) => {
      currentUser = user || null;
      if (user) {
        setAvatar(user);
        $("panelName").textContent = user.displayName || "PandeMApp user";
        $("panelEmail").textContent = user.email || "";
        const created = user.metadata && user.metadata.creationTime
          ? new Date(user.metadata.creationTime)
          : null;
        const last = user.metadata && user.metadata.lastSignInTime
          ? new Date(user.metadata.lastSignInTime)
          : null;
        $("panelCreated").textContent = created ? created.toLocaleDateString("en-IN") : "—";
        $("panelLastLogin").textContent = last ? last.toLocaleString("en-IN") : "—";
        syncUserProfile(user);
      }
      updateAccountUI();
      renderFeed();
      renderMarkers();
    });

    $("googleSignInBtn").addEventListener("click", async () => {
      const btn = $("googleSignInBtn");
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = "Signing in…";
      try {
        await auth.signInWithPopup(fb.provider);
        toast("Signed in. Your reports are now linked to your account.", "success");
      } catch (err) {
        console.warn("[PandeMApp] Sign-in failed:", err && err.code, err && err.message);
        toast("Sign-in failed — you can keep using PandeMApp as a guest.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });

    $("signOutBtn").addEventListener("click", async () => {
      try {
        await auth.signOut();
        toast("Signed out. Reporting still works as a guest.", "success");
      } catch (err) {
        toast("Could not sign out.", "error");
      }
    });
  }

  /* ================= data ================= */
  function renderAll(reports, meta) {
    allReports = (reports || []).map((r) => ({ ...r, type: normalizeType(r.type) }));
    renderMarkers();
    renderFeed();
    renderStats();
    updateLegendCounts();
    refreshCityResult();
    updateAccountUI();
    if (meta) updateModeChip(meta);
  }

  function updateModeChip(meta) {
    const chip = $("modeChip");
    const live = meta.mode === "firestore";
    const offline = live && meta.offline;
    chip.classList.toggle("local", !live || offline);
    $("modeChipText").textContent = !live ? "This browser only" : (offline ? "Offline — will sync" : "Live database");
    $("sourceText").textContent = !live ? "this browser (local demo)" : (offline ? "queued, syncs when online" : "shared cloud database");
    chip.title = live
      ? "Reports are shared with everyone through Firestore."
      : "Firestore is unreachable or blocked by security rules — reports are stored locally. See firestore.rules in the README.";
  }

  /* ================= wiring ================= */
  function buildPage() {
    buildReportCards();
    buildModalTypes();
    buildFilterChips();
    buildLegend();
    initMap();

    // On phones the filters + legend panel starts closed behind a toggle;
    // on desktop it is always open (it lives under the map, not over it).
    if (window.innerWidth <= 768) $("barPanel").classList.add("collapsed");
    $("panelToggle").addEventListener("click", () => $("barPanel").classList.toggle("collapsed"));

    // map / card triggers
    // clicking the logo scrolls back to the top of the page
    const toTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
    $("brandHome").addEventListener("click", toTop);
    $("brandHome").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toTop(); }
    });
    $("headerCityBtn").addEventListener("click", () => {
      document.getElementById("services").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => $("cityInput").focus({ preventScroll: true }), 500);
    });
    $("headerReportBtn").addEventListener("click", () => {
      document.getElementById("report").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("modalCloseBtn").addEventListener("click", closeReportModal);
    $("cancelReportBtn").addEventListener("click", closeReportModal);

    /* animal-spread form — same page, its own UI */
    buildAnimalTypes();
    buildAnimalExposure();
    buildAnimalSeverity();
    $("animalModalCloseBtn").addEventListener("click", closeAnimalModal);
    $("animalCancelBtn").addEventListener("click", closeAnimalModal);
    $("animalExposure").addEventListener("change", refreshAnimalAlert);
    $("animalNoteInput").addEventListener("input", (e) => {
      $("animalCharCount").textContent = e.target.value.length;
    });
    wireFileInputs();
    $("animalLocateBtn").addEventListener("click", () => {
      if (!navigator.geolocation) { toast("Location isn't available in this browser.", "error"); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude, lng = pos.coords.longitude;
          ensureAnimalPickerMap();
          aPickerMap.flyTo({ center: [lng, lat], zoom: 16 });
          setAnimalPoint(lat, lng);
        },
        () => toast("Couldn't get your location. Tap the map instead.", "error"),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
    $("animalSubmitBtn").addEventListener("click", submitAnimalReport);
    $("submitReportBtn").addEventListener("click", submitReport);
    // Photos open in a lightbox; the id keeps data URLs out of the DOM attributes.
    document.addEventListener("click", (e) => {
      const thumb = e.target.closest("[data-photoid]");
      if (!thumb) return;
      e.stopPropagation();
      openLightbox(thumb.getAttribute("data-photoid"));
    });
    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-fileid]");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      openAttachment(a.getAttribute("data-fileid"));
    });
    $("lbCloseBtn").addEventListener("click", closeLightbox);
    $("lightbox").addEventListener("click", (e) => { if (e.target.id !== "lightboxImg") closeLightbox(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLightbox(); closePanels(); } });

    $("noteInput").addEventListener("input", (e) => {
      $("charCount").textContent = e.target.value.length;
    });

    $("useMyLocationBtn").addEventListener("click", () => {
      if (!navigator.geolocation) { toast("Location is not available in this browser.", "error"); return; }
      const btn = $("useMyLocationBtn");
      btn.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btn.innerHTML = "📍 Use my location";
          pickerMap.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16 });
          setPickerPoint(pos.coords.latitude, pos.coords.longitude);
          $("geoBanner").classList.remove("show");
        },
        () => {
          btn.innerHTML = "📍 Use my location";
          toast("Couldn't get your location — tap the map instead.", "error");
          $("geoBanner").classList.add("show");
        },
        { timeout: 8000 }
      );
    });


    wireDateFilter();
    wireRadius();
    wireReportTabs();
    wireSymptomCheckers();
    wireServices();

    $("locateBtn").addEventListener("click", () => {
      if (userLatLng) map.flyTo({ center: [userLatLng.lng, userLatLng.lat], zoom: 13 });
      else {
        locateUser();
        toast("Turn on location access, or use “Pick on map” in the report form.", "info");
      }
    });

    // profile panel
    $("profileOpenBtn").addEventListener("click", () => {
      $("overlay").classList.add("show");
      $("profilePanel").classList.add("show");
    });
    $("profileCloseBtn").addEventListener("click", closePanels);
    $("overlay").addEventListener("click", closePanels);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeReportModal(); closeAnimalModal(); closePanels(); }
    });


    wireAuth();
    Store.onChange(renderAll);
    Store.init().then((mode) => {
      if (mode !== "firestore") {
        toast("Running in local mode — reports stay in this browser until Firestore rules are published.", "info");
      }
    });
  }

  function closePanels() {
    $("animalModal").classList.remove("show");
    $("profilePanel").classList.remove("show");
    if (!$("reportModal").classList.contains("show")) $("overlay").classList.remove("show");
  }

  /* Small debug handle — handy in the browser console and for automated checks. */
  window.__healthmap = {
    getMap: () => map,
    isLoaded: () => mapLoaded,
    getProvider: () => TILE_PROVIDERS[providerIndex].id,
    setAvatar: (user) => setAvatar(user),   // lets the signed-in look be checked without a Google login
    getProviderState: () => ({ index: providerIndex, switching: switching, failures: tileFailures, gaveUp: gaveUp, mapLoaded: mapLoaded }),
    getProviderLog: () => providerLog.slice(),
    forceProvider: (id) => {
      const i = TILE_PROVIDERS.findIndex((p) => p.id === id);
      if (i >= 0 && map) { providerIndex = i; map.setStyle(styleFor(TILE_PROVIDERS[i])); setCredit(TILE_PROVIDERS[i]); }
    },
    getReports: () => allReports,
    getMode: () => Store.getMode(),
    showReportTab: (n) => showReportTab(n),
    INDIA_BOUNDS
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPage);
  } else {
    buildPage();
  }
})();
