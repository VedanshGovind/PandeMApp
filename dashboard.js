/* ============================================================
   PANDEM — dashboard logic
   • Leaflet map locked to India
   • Real community reports (Firestore, with local fallback)
   • Optional Google sign-in
   ============================================================ */
(function () {
  "use strict";

  const fb = window.HealthMapFirebase || {};
  const Store = window.HealthMapStore;
  const auth = fb.auth;
  const db = fb.db;

  /* ---------------- report catalogue: 3 illnesses + 3 risks ---------------- */
  const TYPES = {
    dengue:         { label: "Dengue",            icon: "🦠", category: "disease", color: "#E5484D", blurb: "Fever, rash, bone or joint pain" },
    malaria:        { label: "Malaria",           icon: "🌡️", category: "disease", color: "#8B5CF6", blurb: "Fever with chills and sweating" },
    other_fever:    { label: "Other fever",       icon: "🤒", category: "disease", color: "#0EA5A0", blurb: "Chikungunya, suspected or undiagnosed" },

    stagnant_water: { label: "Stagnant water",    icon: "💧", category: "risk", color: "#2E7CF6", blurb: "Puddles, waterlogging, tanks, coolers, tyres" },
    drainage:       { label: "Drainage & sewage", icon: "🚱", category: "risk", color: "#7C3AED", blurb: "Open drains, overflow, blocked gutters" },
    garbage:        { label: "Garbage & waste",   icon: "🗑️", category: "risk", color: "#65A30D", blurb: "Dumping, litter and unclean public areas" }
  };

  /* Reports saved with the previous, longer list are folded into the six above
     so old data still renders. Anything unrecognised falls back to "Other risk",
     which still shows on the map but isn't offered as a new option. */
  const FALLBACK_TYPE = {
    label: "Other risk", icon: "⚠️", category: "risk", color: "#4C6076",
    blurb: "Anything mosquitoes could breed in"
  };
  const LEGACY_TYPES = {
    chikungunya: "other_fever",
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
  function typeKeys(cat) { return Object.keys(TYPES).filter((k) => TYPES[k].category === cat); }

  const SEVERITY = {
    disease: ["Suspected", "Doctor-confirmed", "Hospitalised"],
    risk:    ["Small spot", "Moderate", "Large area"]
  };

  const WATER_TYPES = ["stagnant_water", "drainage"];

  /* ---------------- India-only map bounds ---------------- */
  const INDIA_BOUNDS = L.latLngBounds([6.2, 67.8], [35.8, 97.6]);
  const DEFAULT_CENTER = [20.5937, 78.9629];

  /* ---------------- app state ---------------- */
  let map = null;
  let pickerMap = null;
  let pickerMarker = null;
  let userLatLng = null;      // jittered display location
  let userMarker = null;
  let allReports = [];
  // "other_risk" is the bucket for legacy/unrecognised reports — it has no card
  // or chip of its own, but must stay visible so old data never disappears.
  let visibleTypes = new Set(Object.keys(TYPES).concat(["other_risk"]));
  let timeWindow = 30;        // days
  let currentUser = null;
  let layerGroups = {};
  const markerIndex = new Map(); // id -> { layer, report }
  let selectedType = null;
  let selectedSeverity = 1;
  let pendingCoords = null;

  const $ = (id) => document.getElementById(id);

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

  function pinIcon(typeKey) {
    const t = typeInfo(typeKey);
    return L.divIcon({
      className: "",
      html: '<div class="report-pin' + (t.category === "disease" ? " disease" : "") + '" style="background:' + t.color + '"><span>' + t.icon + "</span></div>",
      iconSize: [30, 30],
      iconAnchor: [15, 28],
      popupAnchor: [0, -26]
    });
  }

  /* ================= map ================= */
  /* Leaflet's maxBounds only constrains the map CENTRE — at low zoom the
     viewport is wider than India, so neighbouring countries still show.
     This finds the lowest zoom at which the viewport fits entirely inside
     India's box, i.e. "zoom out as far as you like, you still see India". */
  function indiaLockZoom(m) {
    const size = m.getSize();
    if (!size || !size.x || !size.y) return 4;
    const nw = INDIA_BOUNDS.getNorthWest();
    const se = INDIA_BOUNDS.getSouthEast();
    for (let z = 3; z <= 12.001; z += 0.25) {
      const a = m.project(nw, z);
      const b = m.project(se, z);
      if (Math.abs(b.x - a.x) >= size.x && Math.abs(b.y - a.y) >= size.y) return z;
    }
    return 12;
  }

  function applyIndiaLock(m) {
    const z = indiaLockZoom(m);
    m.setMinZoom(z);
    if (m.getZoom() < z) m.setZoom(z);
    return z;
  }

  function initMap() {
    if (typeof L === "undefined") {
      $("mapLoading").innerHTML = "<p>MAP LIBRARY FAILED TO LOAD — CHECK YOUR CONNECTION</p>";
      return;
    }

    map = L.map("map", {
      zoomControl: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 3,
      maxZoom: 18,
      maxBounds: INDIA_BOUNDS,
      maxBoundsViscosity: 1.0,
      worldCopyJump: false
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      minZoom: 3,
      maxZoom: 19,
      bounds: INDIA_BOUNDS,
      noWrap: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    // Start over India, then lock the zoom-out limit to the India-only level.
    map.setView(DEFAULT_CENTER, 5);
    applyIndiaLock(map);
    map.fitBounds(INDIA_BOUNDS);

    layerGroups.disease = L.layerGroup().addTo(map);
    layerGroups.risk = L.layerGroup().addTo(map);

    map.on("moveend", renderStats);

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => applyIndiaLock(map), 250);
    });

    locateUser();
    $("mapLoading").classList.add("hide");
  }

  function locateUser() {
    if (!navigator.geolocation) {
      $("geoBanner").classList.add("show");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const j = jitter(pos.coords.latitude, pos.coords.longitude, 150);
        userLatLng = { lat: j.lat, lng: j.lng };
        map.setView([j.lat, j.lng], 14);
        const pulse = L.divIcon({
          className: "",
          html: '<div class="pulse-marker"><div class="ring"></div><div class="dot"></div></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([j.lat, j.lng], { icon: pulse })
          .addTo(map)
          .bindPopup("<b>Your approximate location</b><br><span class='pop-meta'>Jittered by ~150 m for privacy.</span>");
        renderStats();
      },
      () => {
        $("geoBanner").classList.add("show");
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  }

  /* ================= markers ================= */
  function withinTimeWindow(report) {
    if (!timeWindow) return true;
    return Date.now() - report.createdAt.getTime() <= timeWindow * 86400000;
  }

  function renderMarkers() {
    if (!map) return;
    layerGroups.disease.clearLayers();
    layerGroups.risk.clearLayers();
    markerIndex.clear();

    allReports
      .filter((r) => visibleTypes.has(r.type) && withinTimeWindow(r))
      .forEach((r) => {
        const t = typeInfo(r.type);
        const group = layerGroups[t.category] || layerGroups.risk;

        // Illness reports get a blurred circle so the exact spot stays private.
        if (t.category === "disease") {
          L.circle([r.lat, r.lng], {
            radius: 150,
            color: t.color,
            weight: 1,
            fillColor: t.color,
            fillOpacity: 0.16
          }).addTo(group);
        }

        const marker = L.marker([r.lat, r.lng], { icon: pinIcon(r.type) }).addTo(group);
        marker.bindPopup(popupHtml(r), { maxWidth: 260 });
        markerIndex.set(r.id, { layer: marker, report: r });
      });
  }

  function popupHtml(r) {
    const t = typeInfo(r.type);
    const sev = (SEVERITY[t.category] || [])[Math.max(0, Math.min(2, r.severity - 1))] || "";
    const mine = r.userId === currentUserId();
    const ref = userLatLng || map.getCenter();
    const dist = fmtDistance(haversine(ref.lat, ref.lng, r.lat, r.lng));
    return (
      '<div class="pop-title">' + t.icon + " " + escapeHtml(t.label) + "</div>" +
      '<div class="pop-meta">' + (t.category === "disease" ? "Illness report" : "Breeding risk") +
        (sev ? " · " + sev : "") + " · " + timeAgo(r.createdAt) + "</div>" +
      '<div class="pop-meta">📍 ~' + dist + " away</div>" +
      (r.note ? '<div class="pop-note">' + escapeHtml(r.note) + "</div>" : "") +
      '<div class="pop-actions">' +
        (mine ? '<a href="#" class="link-btn" data-withdraw="' + r.id + '">Withdraw my report</a>' : "") +
      "</div>"
    );
  }

  // Withdraw links live inside Leaflet popups, so delegate from the map container.
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
  function renderStats() {
    if (!map) return;
    const ref = userLatLng || map.getCenter();
    const RADIUS_KM = 5;
    const nearby = allReports.filter(
      (r) => withinTimeWindow(r) && haversine(ref.lat, ref.lng, r.lat, r.lng) <= RADIUS_KM
    );
    const illness = nearby.filter((r) => typeInfo(r.type).category === "disease").length;
    const risk = nearby.length - illness;
    const water = nearby.filter((r) => WATER_TYPES.includes(r.type)).length;

    $("statIllness").textContent = illness;
    $("statRisk").textContent = risk;
    $("statWater").textContent = water;
    const range = timeWindow ? "last " + timeWindow + " days" : "all time";
    $("barMeta").textContent =
      (userLatLng ? "Around you" : "Selected area") + " · within " + RADIUS_KM + " km · " + range;

    const score = illness * 3 + risk;
    const chip = $("riskChip");
    let level = "low", text = "Low";
    if (score >= 18) { level = "high"; text = "High"; }
    else if (score >= 7) { level = "moderate"; text = "Moderate"; }
    chip.className = "risk-pill " + level;
    chip.textContent = (level === "high" ? "🔴 " : level === "moderate" ? "🟠 " : "🟢 ") + text;
  }

  /* ================= feed ================= */
  function renderFeed() {
    const list = $("feedList");
    const ref = userLatLng || (map && map.getCenter());
    const items = allReports.filter((r) => visibleTypes.has(r.type) && withinTimeWindow(r)).slice(0, 60);

    $("feedCount").textContent = allReports.length
      ? items.length + " of " + allReports.length + " reports"
      : "No reports yet";

    if (!items.length) {
      list.innerHTML =
        '<div class="empty-state"><span class="big">🗺️</span>' +
        (allReports.length
          ? "No reports match your filters. Try widening the time range."
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
                '<span class="f-badge ' + t.category + '">' + (t.category === "disease" ? "illness" : "risk") + "</span>" +
              "</div>" +
              '<div class="f-meta">' + timeAgo(r.createdAt) + " · 📍 " + dist + " away" + (sev ? " · " + sev : "") + "</div>" +
              (r.note ? '<div class="f-note">' + escapeHtml(r.note) + "</div>" : "") +
            "</div>" +
            '<div class="f-actions">' +
              '<button class="link-btn" data-goto="' + r.id + '">Show on map</button>' +
              (mine ? '<button class="link-btn" data-del="' + r.id + '">Withdraw</button>' : "") +
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
    map.setView(entry.layer.getLatLng(), Math.max(map.getZoom(), 15));
    entry.layer.openPopup();
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ================= filters ================= */
  function buildFilterChips() {
    const host = $("typeChips");
    const group = (label, icon, keys) =>
      '<button class="chip on" data-group="' + keys.join(",") + '">' + icon + " " + label + "</button>";

    let html = group("Illnesses", "🩺", typeKeys("disease"));
    html += group("Water &amp; breeding", "💧", typeKeys("risk"));
    Object.keys(TYPES).forEach((k) => {
      const t = TYPES[k];
      html +=
        '<button class="chip on" data-type="' + k + '"><i class="sw" style="background:' + t.color + '"></i>' + t.icon + " " + t.label + "</button>";
    });
    host.innerHTML = html;

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

  function buildLegend() {
    $("legendItems").innerHTML = Object.keys(TYPES)
      .map((k) => {
        const t = TYPES[k];
        // a miniature of the actual pin: coloured marker with its emoji inside
        return (
          '<span class="lg-item"><span class="lg-pin" style="background:' + t.color + '">' +
          "<i>" + t.icon + "</i></span>" + t.label + "</span>"
        );
      })
      .join("");
  }

  /* ================= report cards + modal ================= */
  function buildReportCards() {
    const illnessGrid = $("illnessGrid");
    const riskGrid = $("riskGrid");
    const card = (k) => {
      const t = TYPES[k];
      return (
        '<button class="report-card" data-open="' + k + '">' +
          '<div class="ic" style="background:' + t.color + '18">' + t.icon + "</div>" +
          "<h4>" + t.label + "</h4>" +
          "<p>" + t.blurb + "</p>" +
        "</button>"
      );
    };
    illnessGrid.innerHTML = typeKeys("disease").map(card).join("");
    riskGrid.innerHTML = typeKeys("risk").map(card).join("");

    document.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => openReportModal(btn.dataset.open));
    });
  }

  function buildModalTypes() {
    $("modalTypeGrid").innerHTML = Object.keys(TYPES)
      .map((k) => {
        const t = TYPES[k];
        return '<button class="type-opt" data-mtype="' + k + '"><span class="t-ic">' + t.icon + "</span>" + t.label + "</button>";
      })
      .join("");

    $("modalTypeGrid").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mtype]");
      if (!b) return;
      selectType(b.dataset.mtype);
    });
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
    if (pickerMap || typeof L === "undefined") return;
    pickerMap = L.map("pickerMap", {
      zoomControl: true,
      attributionControl: false,
      zoomSnap: 0.5,
      minZoom: 4,
      maxZoom: 18,
      maxBounds: INDIA_BOUNDS,
      maxBoundsViscosity: 1.0
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      minZoom: 3, maxZoom: 19, bounds: INDIA_BOUNDS, noWrap: true
    }).addTo(pickerMap);

    pickerMap.on("click", (e) => {
      setPickerPoint(e.latlng.lat, e.latlng.lng);
    });
  }

  function setPickerPoint(lat, lng) {
    pendingCoords = { lat, lng };
    if (pickerMarker) pickerMap.removeLayer(pickerMarker);
    pickerMarker = L.marker([lat, lng]).addTo(pickerMap);
    $("locReadout").textContent = lat.toFixed(4) + ", " + lng.toFixed(4) + " ✓ pin placed";
  }

  function openReportModal(typeKey) {
    ensurePickerMap();
    $("overlay").classList.add("show");
    $("reportModal").classList.add("show");
    $("noteInput").value = "";
    $("charCount").textContent = "0";
    selectType(typeKey || "stagnant_water");

    setTimeout(() => {
      pickerMap.invalidateSize();
      let center = DEFAULT_CENTER;
      let zoom = 5;
      if (pendingCoords) { center = [pendingCoords.lat, pendingCoords.lng]; zoom = 16; }
      else if (userLatLng) { center = [userLatLng.lat, userLatLng.lng]; zoom = 16; }
      else if (map) { center = map.getCenter(); zoom = Math.max(map.getZoom(), 13); }
      pickerMap.setView(center, zoom);
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
      userId: currentUserId(),
      displayName: currentUser ? currentUser.displayName || "Signed-in user" : "Guest"
    });

    btn.disabled = false;
    btn.textContent = "Submit report";

    if (res.savedTo === "firestore") {
      toast("✅ Report added — it's live on the map.", "success");
    } else {
      toast("⚠️ Saved on this device.", "error");
    }

    closeReportModal();
    setTimeout(() => focusReport(res.id), 250);
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
      $("profileOpenBtn").innerHTML = currentUser.photoURL
        ? '<img src="' + currentUser.photoURL + '" alt="">'
        : "👤";
    } else {
      $("guestReports").textContent = mine;
      $("guestStorage").textContent = Store.getMode() === "firestore" ? "Cloud database" : "This browser";
      $("profileOpenBtn").innerHTML = "👤";
    }
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
      console.warn("[PANDEM] Profile sync failed:", err && err.code);
    }
  }

  function wireAuth() {
    if (!auth) { updateAccountUI(); return; }

    auth.onAuthStateChanged(async (user) => {
      currentUser = user || null;
      if (user) {
        $("panelAvatar").src = user.photoURL || "";
        $("panelName").textContent = user.displayName || "PANDEM user";
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
        console.warn("[PANDEM] Sign-in failed:", err && err.code, err && err.message);
        toast("Sign-in failed — you can keep using PANDEM as a guest.", "error");
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
    updateAccountUI();
    if (meta) updateModeChip(meta);
  }

  function updateModeChip(meta) {
    const chip = $("modeChip");
    const live = meta.mode === "firestore";
    chip.classList.toggle("local", !live);
    $("modeChipText").textContent = live ? "Live database" : "Browser only";
    $("sourceText").textContent = live ? "shared cloud database" : "this browser (local demo)";
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
    $("headerReportBtn").addEventListener("click", () => openReportModal("stagnant_water"));
    $("modalCloseBtn").addEventListener("click", closeReportModal);
    $("cancelReportBtn").addEventListener("click", closeReportModal);
    $("submitReportBtn").addEventListener("click", submitReport);

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
          pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 17);
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


    $("timeSelect").addEventListener("change", (e) => {
      timeWindow = Number(e.target.value);
      renderMarkers();
      renderFeed();
      renderStats();
    });

    $("locateBtn").addEventListener("click", () => {
      if (userLatLng) map.setView([userLatLng.lat, userLatLng.lng], 14);
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
      if (e.key === "Escape") { closeReportModal(); closePanels(); }
    });

    $("runDiagBtn").addEventListener("click", runDiagnostics);

    wireAuth();
    Store.onChange(renderAll);
    Store.init().then((mode) => {
      if (mode !== "firestore") {
        toast("Running in local mode — reports stay in this browser until Firestore rules are published.", "info");
      }
    });
  }

  function closePanels() {
    $("profilePanel").classList.remove("show");
    if (!$("reportModal").classList.contains("show")) $("overlay").classList.remove("show");
  }

  async function runDiagnostics() {
    if (!db) {
      toast("Firebase SDK is not loaded — running in local mode.", "error");
      return;
    }
    try {
      await db.collection("diagnostics").doc("test-write").set({
        message: "hello from PANDEM",
        uid: currentUserId(),
        writtenAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      toast("✅ Firestore write succeeded.", "success");
    } catch (err) {
      console.warn("[PANDEM] Diagnostics write failed:", err);
      toast("❌ Firestore write failed: " + (err.code || err.message), "error");
    }
  }

  /* Small debug handle — handy in the browser console and for automated checks. */
  window.__healthmap = {
    getMap: () => map,
    getReports: () => allReports,
    getMode: () => Store.getMode(),
    INDIA_BOUNDS
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPage);
  } else {
    buildPage();
  }
})();
