"use strict";
import { buildCatalog, LANG_NAMES, REPO_INFO } from "./catalog.mjs";
import * as gdrive from "./gdrive.js";

const STORE_KEY = "ptcg-collection-v1"; // owned = collected
const ORDERED_KEY = "ptcg-ordered-v1"; // ordered = bought, awaiting delivery
const QTY_KEY = "ptcg-qty-v1"; // { packId: count } — only stored when count >= 2
const SETTINGS_KEY = "ptcg-settings-v1";
const LASTBACKUP_KEY = "ptcg-last-backup";
const SNOOZE_KEY = "ptcg-backup-snooze";
const BACKUP_INTERVAL = 7 * 24 * 60 * 60 * 1000; // remind after ~7 days
const CATALOG_CACHE = "ptcg-catalog";
const LIVE_URL = "/live-catalog.json"; // synthetic key inside CATALOG_CACHE
const PRICES_URL = "prices.json";
const $ = (id) => document.getElementById(id);

let DATA = null;
let PRICES = { prices: {} };
let owned = new Set(loadJSON(STORE_KEY, []));
let ordered = new Set(loadJSON(ORDERED_KEY, []));
let quantities = normalizeQuantities(loadJSON(QTY_KEY, {}));
let settings = Object.assign(
  {
    multiLang: false,
    autoUpdate: true,
    showPromos: true,
    showPrices: true,
    backupReminders: true,
    gdriveClientId: "",
    gdriveConnected: false,
    gdriveEmail: "",
  },
  loadJSON(SETTINGS_KEY, {}),
);
const setByCode = new Map();

/* ---------------- persistence ---------------- */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveOwned() {
  localStorage.setItem(STORE_KEY, JSON.stringify([...owned]));
}
function saveOrdered() {
  localStorage.setItem(ORDERED_KEY, JSON.stringify([...ordered]));
}
function saveQuantities() {
  localStorage.setItem(QTY_KEY, JSON.stringify(quantities));
}
function saveCollection() {
  saveOwned();
  saveOrdered();
  saveQuantities();
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* ---------------- collection state ---------------- */
// Keep only integer counts >= 2 (a single copy is implicit, avoiding "1×" noise).
function normalizeQuantities(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [id, n] of Object.entries(raw)) {
      const v = Math.floor(Number(n));
      if (v >= 2) out[id] = v;
    }
  }
  return out;
}
// A pack is "owned" (collected), "ordered" (waiting to arrive), or "none".
function packState(id) {
  return owned.has(id) ? "owned" : ordered.has(id) ? "ordered" : "none";
}
function qtyOf(id) {
  return owned.has(id) ? quantities[id] || 1 : 0;
}
function setQty(id, n) {
  const v = Math.max(1, Math.floor(n));
  if (v >= 2 && owned.has(id)) quantities[id] = v;
  else delete quantities[id];
  saveQuantities();
}
// Tap cycles: none -> owned -> ordered -> none (a single tap still marks owned).
function cyclePack(id) {
  if (owned.has(id)) {
    owned.delete(id);
    delete quantities[id];
    ordered.add(id);
  } else if (ordered.has(id)) {
    ordered.delete(id);
  } else {
    owned.add(id);
    ordered.delete(id);
  }
  saveCollection();
  return packState(id);
}

/* ---------------- catalog indexing ---------------- */
function indexCatalog() {
  setByCode.clear();
  for (const s of DATA.sets) setByCode.set(s.code, s);
}
// Sets shown in list/aggregate views, honoring the "show promos" setting.
// (Direct set/pack views still work for promo sets via setByCode.)
function visibleSets() {
  return settings.showPromos ? DATA.sets : DATA.sets.filter((s) => !s.isPromo);
}
function langsPresent() {
  const seen = new Map();
  for (const s of visibleSets()) {
    if (!seen.has(s.lang)) seen.set(s.lang, { lang: s.lang, sets: [], packs: 0 });
    const e = seen.get(s.lang);
    e.sets.push(s);
    e.packs += s.packCount;
  }
  return [...seen.values()].sort(
    (a, b) =>
      (a.lang === "en" ? 0 : 1) - (b.lang === "en" ? 0 : 1) ||
      (LANG_NAMES[a.lang] || a.lang).localeCompare(LANG_NAMES[b.lang] || b.lang),
  );
}
function erasForLang(lang) {
  const map = new Map();
  for (const s of visibleSets()) {
    if (s.lang !== lang) continue;
    if (!map.has(s.eraId))
      map.set(s.eraId, { eraId: s.eraId, eraName: s.eraName, eraRank: s.eraRank, sets: [] });
    map.get(s.eraId).sets.push(s);
  }
  return [...map.values()].sort((a, b) => a.eraRank - b.eraRank);
}
function setsFor(lang, eraId) {
  return visibleSets().filter((s) => s.lang === lang && s.eraId === eraId);
}

/* ---------------- progress helpers ---------------- */
function ownedInSet(s) {
  let n = 0;
  for (const p of s.packs) if (owned.has(p.id)) n++;
  return n;
}
function orderedInSet(s) {
  let n = 0;
  for (const p of s.packs) if (ordered.has(p.id)) n++;
  return n;
}
function agg(sets) {
  let done = 0, total = 0, setsDone = 0;
  for (const s of sets) {
    const o = ownedInSet(s);
    done += o;
    total += s.packCount;
    if (s.packCount > 0 && o === s.packCount) setsDone++;
  }
  return { done, total, setsDone, setCount: sets.length };
}
function setProgress(done, total) {
  $("progressFill").style.width = (total ? (done / total) * 100 : 0) + "%";
}

/* ---------------- pricing ---------------- */
// Market price (USD) of a single booster pack for a set, or null if unknown.
function packPrice(setCode) {
  const v = PRICES.prices && PRICES.prices[setCode];
  return typeof v === "number" ? v : null;
}
function money(n) {
  if (!isFinite(n)) return "$0";
  return n >= 1000
    ? "$" + Math.round(n).toLocaleString()
    : "$" + n.toFixed(2);
}
// Owned / ordered / missing value for one set (owned counts quantities).
function setValues(s) {
  const price = packPrice(s.code);
  const hasPrice = price != null;
  let ownedVal = 0, orderedVal = 0, missingVal = 0;
  if (hasPrice) {
    for (const p of s.packs) {
      const st = packState(p.id);
      if (st === "owned") ownedVal += price * (quantities[p.id] || 1);
      else if (st === "ordered") orderedVal += price;
      else missingVal += price;
    }
  }
  return { price, hasPrice, ownedVal, orderedVal, missingVal };
}
function aggValues(sets) {
  let owned = 0, ordered = 0, missing = 0, priced = 0;
  for (const s of sets) {
    const v = setValues(s);
    if (!v.hasPrice) continue;
    priced++;
    owned += v.ownedVal;
    ordered += v.orderedVal;
    missing += v.missingVal;
  }
  return { owned, ordered, missing, priced };
}
// Compact "$owned · $missing to go" line for a list of sets (or one set).
function valueRowHtml(sets) {
  if (!settings.showPrices) return "";
  const v = aggValues(sets);
  if (!v.priced || v.owned + v.missing + v.ordered === 0) return "";
  const parts = [`<span class="v-owned">${money(v.owned)}</span>`];
  if (v.ordered > 0) parts.push(`${money(v.ordered)} ordered`);
  if (v.missing > 0) parts.push(`${money(v.missing)} to go`);
  return `<div class="set-value">${parts.join(" · ")}</div>`;
}
// Short " · $owned owned · $missing to go" appended to a list header subtitle.
function valueSuffix(sets) {
  if (!settings.showPrices) return "";
  const v = aggValues(sets);
  if (!v.priced) return "";
  let s = ` · ${money(v.owned)} owned`;
  if (v.missing > 0) s += ` · ${money(v.missing)} to go`;
  return s;
}

/* ---------------- misc ---------------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------------- card builders ---------------- */
function progressRow(o, total) {
  const complete = total > 0 && o === total;
  return `<div class="set-count">
      <div class="mini-bar"><div style="width:${total ? (o / total) * 100 : 0}%"></div></div>
      <span>${complete ? '<span class="badge-done">✓ Complete</span>' : `${o}/${total}`}</span>
    </div>`;
}
function setCard(s) {
  const o = ownedInSet(s);
  const logo = s.logo
    ? `<img class="set-logo" loading="lazy" src="${s.logo}" alt="" onerror="this.style.visibility='hidden'">`
    : `<div class="set-logo placeholder">${s.code.toUpperCase()}</div>`;
  const card = document.createElement("div");
  card.className = "set-card";
  card.onclick = () => (location.hash = "#/s/" + encodeURIComponent(s.code));
  card.innerHTML = `${logo}
    <div class="set-info">
      <div class="set-name">${escapeHtml(s.name)}</div>
      <div class="set-code">${s.code}${s.lang !== "en" ? " · " + (LANG_NAMES[s.lang] || s.lang) : ""}</div>
      ${progressRow(o, s.packCount)}
      ${valueRowHtml([s])}
    </div>`;
  return card;
}
function groupCard({ title, subtitle, sets, onclick, badge, image }) {
  const a = agg(sets);
  const card = document.createElement("div");
  card.className = "set-card group-card";
  card.onclick = onclick;
  const thumb = image
    ? `<div class="group-img"><img loading="lazy" src="${image}" alt="" onerror="this.parentElement.innerHTML='${badge}';this.parentElement.className='group-badge'"></div>`
    : `<div class="group-badge">${badge}</div>`;
  card.innerHTML = `
    ${thumb}
    <div class="set-info">
      <div class="set-name">${escapeHtml(title)}</div>
      <div class="set-code">${subtitle}</div>
      ${progressRow(a.done, a.total)}
      ${valueRowHtml(sets)}
    </div>
    <div class="chev">›</div>`;
  return card;
}

/* ---------------- rendering ---------------- */
function header(title, subtitle, showBack, showSearch) {
  $("title").textContent = title;
  $("subtitle").textContent = subtitle;
  $("backBtn").hidden = !showBack;
  $("searchWrap").style.display = showSearch ? "" : "none";
}
function currentQuery() {
  return $("search").value.trim().toLowerCase();
}
function renderList(nodes, emptyMsg) {
  const app = $("app");
  app.innerHTML = "";
  if (!nodes.length) {
    app.innerHTML = `<p class="empty">${emptyMsg}</p>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "set-list";
  for (const n of nodes) list.appendChild(n);
  app.appendChild(list);
  window.scrollTo(0, 0);
}
function renderSearch(scopeLang) {
  const q = currentQuery();
  const hideComplete = $("hideComplete").checked;
  const matches = visibleSets().filter((s) => {
    if (scopeLang && s.lang !== scopeLang) return false;
    if (hideComplete && s.packCount > 0 && ownedInSet(s) === s.packCount) return false;
    return s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
  });
  renderList(matches.map(setCard), `No sets match “${escapeHtml(q)}”.`);
}
function renderLanguages() {
  const overall = agg(visibleSets().filter((s) => s.lang === "en"));
  header("Pack Tracker", `${overall.done}/${overall.total} English packs` + valueSuffix(visibleSets().filter((s) => s.lang === "en")), false, true);
  setProgress(overall.done, overall.total);
  if (currentQuery()) return renderSearch(null);

  const hideComplete = $("hideComplete").checked;
  const cards = [];
  for (const L of langsPresent()) {
    const a = agg(L.sets);
    if (hideComplete && a.total > 0 && a.done === a.total) continue;
    cards.push(
      groupCard({
        title: LANG_NAMES[L.lang] || L.lang.toUpperCase(),
        subtitle: `${L.sets.length} sets · ${L.packs} packs`,
        sets: L.sets,
        badge: (L.lang || "en").toUpperCase(),
        onclick: () => (location.hash = "#/l/" + L.lang),
      }),
    );
  }
  renderList(cards, "No languages available.");
}
function renderEras(lang) {
  const langSets = visibleSets().filter((s) => s.lang === lang);
  const a = agg(langSets);
  const langName = LANG_NAMES[lang] || lang.toUpperCase();
  header(
    settings.multiLang ? langName : "Pack Tracker",
    `${a.done}/${a.total} packs · ${a.setsDone}/${a.setCount} sets complete` + valueSuffix(langSets),
    settings.multiLang,
    true,
  );
  setProgress(a.done, a.total);
  if (currentQuery()) return renderSearch(lang);

  const hideComplete = $("hideComplete").checked;
  const cards = [];
  for (const era of erasForLang(lang)) {
    const ea = agg(era.sets);
    if (hideComplete && ea.total > 0 && ea.done === ea.total) continue;
    // Use the era's namesake logo: the earliest known (in the repo README),
    // non-promo set that has one — e.g. sv1 "Scarlet & Violet". Prefer sets
    // with a known chronological order (order >= 0) so obscure/unlisted sets
    // don't hijack the era image.
    const oldestFirst = [...era.sets].reverse();
    const known = oldestFirst.filter((s) => s.order >= 0);
    const rep =
      known.find((s) => s.logo && !s.isPromo) ||
      known.find((s) => s.logo) ||
      oldestFirst.find((s) => s.logo && !s.isPromo) ||
      oldestFirst.find((s) => s.logo);
    cards.push(
      groupCard({
        title: era.eraName,
        subtitle: `${era.sets.length} sets · ${ea.total} packs`,
        sets: era.sets,
        badge: era.sets.length,
        image: rep ? rep.logo : null,
        onclick: () => (location.hash = `#/e/${lang}/${era.eraId}`),
      }),
    );
  }
  renderList(cards, "Nothing here yet.");
}
function renderSets(lang, eraId) {
  const sets = setsFor(lang, eraId);
  const eraName = sets[0] ? sets[0].eraName : eraId;
  const a = agg(sets);
  header(eraName, `${a.done}/${a.total} packs · ${a.setsDone}/${a.setCount} sets` + valueSuffix(sets), true, true);
  setProgress(a.done, a.total);
  if (currentQuery()) return renderSearch(lang);

  const hideComplete = $("hideComplete").checked;
  const cards = sets
    .filter((s) => !(hideComplete && s.packCount > 0 && ownedInSet(s) === s.packCount))
    .map(setCard);
  renderList(cards, "No sets in this era.");
}
function updatePackHeader(s) {
  const o = ownedInSet(s);
  const ord = orderedInSet(s);
  let sub = `${s.code.toUpperCase()} · ${o}/${s.packCount} packs`;
  if (ord) sub += ` · ${ord} ordered`;
  if (settings.showPrices) {
    const v = setValues(s);
    if (v.hasPrice) {
      sub += ` · ${money(v.ownedVal)} owned`;
      if (v.missingVal > 0) sub += ` · ${money(v.missingVal)} to go`;
    }
  }
  header(s.name, sub, true, false);
  setProgress(o, s.packCount);
}
function packTileHtml(p, priceStr) {
  const q = quantities[p.id] || 1;
  const many = q >= 2;
  return `<div class="pmark check">✓</div>
    <div class="pmark cart">🛒</div>
    <div class="qty-badge"${many ? "" : " hidden"}>×${q}</div>
    <img loading="lazy" src="${p.img}" alt="${escapeHtml(p.name)}" onerror="this.style.opacity=0.2">
    <div class="pname">${escapeHtml(p.name)}</div>
    ${priceStr ? `<div class="pprice">${priceStr}</div>` : ""}
    <div class="qty-ctrl"${owned.has(p.id) ? "" : " hidden"}>
      <button class="qbtn qminus"${many ? "" : " hidden"} aria-label="Remove one">−</button>
      <span class="qval"${many ? "" : " hidden"}>${q}</span>
      <button class="qbtn qplus" aria-label="Add one">+</button>
    </div>`;
}
function bindTile(el, s, p, priceStr) {
  const refresh = () => {
    el.className = "pack pack--" + packState(p.id);
    el.innerHTML = packTileHtml(p, priceStr);
    bindTile(el, s, p, priceStr);
    updatePackHeader(s);
    scheduleDriveSync();
  };
  el.onclick = (e) => {
    if (e.target.closest(".qty-ctrl")) return; // handled by the +/- buttons
    cyclePack(p.id);
    refresh();
  };
  el.querySelector(".qplus").onclick = (e) => {
    e.stopPropagation();
    if (!owned.has(p.id)) return;
    setQty(p.id, (quantities[p.id] || 1) + 1);
    refresh();
  };
  const minus = el.querySelector(".qminus");
  if (minus)
    minus.onclick = (e) => {
      e.stopPropagation();
      setQty(p.id, (quantities[p.id] || 1) - 1);
      refresh();
    };
}
function renderPacks(code) {
  const s = setByCode.get(code);
  if (!s) {
    location.hash = "";
    return;
  }
  updatePackHeader(s);
  const priceStr = settings.showPrices && packPrice(s.code) != null ? money(packPrice(s.code)) : null;
  const app = $("app");
  const grid = document.createElement("div");
  grid.className = "pack-grid";
  for (const p of s.packs) {
    const el = document.createElement("div");
    el.className = "pack pack--" + packState(p.id);
    el.innerHTML = packTileHtml(p, priceStr);
    bindTile(el, s, p, priceStr);
    grid.appendChild(el);
  }
  app.innerHTML = "";
  app.appendChild(grid);
  window.scrollTo(0, 0);
}

/* ---------------- router ---------------- */
function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/s\/(.+)$/))) return renderPacks(decodeURIComponent(m[1]));
  if ((m = h.match(/^#\/e\/([a-z]{2})\/(.+)$/))) return renderSets(m[1], decodeURIComponent(m[2]));
  if ((m = h.match(/^#\/l\/([a-z]{2})$/))) return renderEras(m[1]);
  if (settings.multiLang) return renderLanguages();
  return renderEras("en");
}
function goBack() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/s\/(.+)$/))) {
    const s = setByCode.get(decodeURIComponent(m[1]));
    location.hash = s ? `#/e/${s.lang}/${s.eraId}` : "";
  } else if ((m = h.match(/^#\/e\/([a-z]{2})\/.+$/))) {
    location.hash = settings.multiLang ? `#/l/${m[1]}` : "";
  } else {
    location.hash = "";
  }
}

/* ---------------- backup / restore ---------------- */
function backupPayload() {
  return {
    app: "ptcg-pack-tracker",
    version: 2,
    exportedAt: new Date().toISOString(),
    catalogCommit: DATA.commit,
    owned: [...owned],
    ordered: [...ordered],
    quantities: { ...quantities },
  };
}
function backupFilename() {
  return `ptcg-collection-${new Date().toISOString().slice(0, 10)}.json`;
}
function markBackedUp() {
  localStorage.setItem(LASTBACKUP_KEY, String(Date.now()));
  localStorage.removeItem(SNOOZE_KEY);
  hideReminder();
  updateSyncStatus();
}
// Enforce invariants: a pack is never both owned and ordered; quantities only
// exist (>= 2) for owned packs.
function sanitizeCollection() {
  for (const id of [...ordered]) if (owned.has(id)) ordered.delete(id);
  for (const id of Object.keys(quantities))
    if (!owned.has(id) || quantities[id] < 2) delete quantities[id];
}
// Replace the whole collection from a backup/Drive payload (v1 array or
// v1/v2 object). Returns the number of owned packs restored.
function applyBackup(data) {
  const ownArr = Array.isArray(data) ? data : data && data.owned;
  if (!Array.isArray(ownArr)) throw new Error("bad file");
  owned = new Set(ownArr);
  ordered = new Set(Array.isArray(data && data.ordered) ? data.ordered : []);
  quantities = normalizeQuantities(data && data.quantities);
  sanitizeCollection();
  saveCollection();
  return ownArr.length;
}
function downloadJSON(json, filename) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function exportBackup() {
  downloadJSON(JSON.stringify(backupPayload(), null, 2), backupFilename());
  markBackedUp();
  toast("Backup saved");
}
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const n = applyBackup(data);
      markBackedUp();
      route();
      toast(`Restored ${n} packs`);
    } catch {
      toast("Restore failed: invalid file");
    }
  };
  reader.readAsText(file);
}

/* ---------------- backup reminder ---------------- */
function lastBackupAt() {
  return Number(localStorage.getItem(LASTBACKUP_KEY) || 0);
}
function hideReminder() {
  $("backupReminder").hidden = true;
}
function maybeShowBackupReminder() {
  if (!settings.backupReminders || owned.size === 0) return hideReminder();
  if (settings.gdriveConnected) return hideReminder(); // Drive auto-sync covers it
  const last = lastBackupAt();
  const snooze = Number(localStorage.getItem(SNOOZE_KEY) || 0);
  if (Date.now() - last < BACKUP_INTERVAL || Date.now() < snooze) return hideReminder();
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  $("reminderText").textContent = last
    ? `Last backup ${days} day${days === 1 ? "" : "s"} ago — keep it safe in the cloud.`
    : "Your collection isn't backed up yet — save it to the cloud.";
  $("backupReminder").hidden = false;
}

/* ---------------- Google Drive sync ---------------- */
let driveSyncTimer = null;

function relTime(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Live sync indicator on the main screen.
function updateSyncStatus(state) {
  const el = $("syncStatus");
  if (!el) return;
  if (state === "saving" && gdrive.isConnected()) {
    el.className = "sync-status syncing";
    el.textContent = "☁ Saving to Drive…";
    el.hidden = false;
    return;
  }
  const last = lastBackupAt();
  if (gdrive.isConnected()) {
    el.className = "sync-status synced";
    el.textContent = `☁ Synced to Drive · ${relTime(last)}`;
    el.hidden = false;
  } else if (owned.size === 0) {
    el.hidden = true;
  } else if (last) {
    el.className = "sync-status";
    el.textContent = `✓ Backed up · ${relTime(last)}`;
    el.hidden = false;
  } else {
    el.className = "sync-status warn";
    el.textContent = "⚠ Not backed up";
    el.hidden = false;
  }
}

function updateDriveStatus() {
  const el = $("driveStatus");
  if (!el) return;
  if (!gdrive.hasClientId()) el.textContent = "Not configured.";
  else if (gdrive.isConnected())
    el.textContent = settings.gdriveEmail
      ? `Connected as ${settings.gdriveEmail} — auto-syncing.`
      : "Connected — auto-syncing to your Drive.";
  else if (settings.gdriveConnected) el.textContent = "Configured — reconnecting…";
  else el.textContent = "Configured — tap Connect to sign in.";
  const connected = gdrive.isConnected();
  $("driveConnectBtn").hidden = connected;
  $("driveDisconnectBtn").hidden = !connected;
  $("driveRestoreBtn").hidden = !connected;
}

// Union-merge with the Drive copy (never loses owned packs), then push.
async function syncWithDrive(pull) {
  if (!gdrive.isConnected()) return;
  try {
    if (pull) {
      const remote = await gdrive.download();
      if (remote && Array.isArray(remote.owned)) {
        const before = owned.size + ordered.size + Object.keys(quantities).length;
        for (const id of remote.owned) owned.add(id);
        if (Array.isArray(remote.ordered))
          for (const id of remote.ordered) if (!owned.has(id)) ordered.add(id);
        if (remote.quantities && typeof remote.quantities === "object")
          for (const [id, q] of Object.entries(remote.quantities))
            if (owned.has(id)) quantities[id] = Math.max(quantities[id] || 1, Math.floor(Number(q)) || 1);
        sanitizeCollection();
        const after = owned.size + ordered.size + Object.keys(quantities).length;
        if (after !== before) {
          saveCollection();
          route();
        }
      }
    }
    await gdrive.upload(JSON.stringify(backupPayload()));
    markBackedUp();
  } catch {
    /* offline / token expired — will retry on next change or launch */
  }
  updateDriveStatus();
  updateSyncStatus();
}

// Debounced push after collection changes.
function scheduleDriveSync() {
  if (!gdrive.isConnected()) {
    updateSyncStatus();
    return;
  }
  updateSyncStatus("saving");
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => {
    gdrive
      .upload(JSON.stringify(backupPayload()))
      .then(() => markBackedUp())
      .catch(() => updateSyncStatus());
  }, 2500);
}

async function connectDrive() {
  const id = gdrive.DEFAULT_CLIENT_ID || settings.gdriveClientId;
  if (!id) {
    toast("No Google Client ID configured");
    return;
  }
  gdrive.setClientId(id);
  toast("Opening Google sign-in…");
  try {
    if (await gdrive.connect()) {
      settings.gdriveConnected = true;
      const email = await gdrive.fetchEmail();
      if (email) {
        settings.gdriveEmail = email;
        gdrive.setHint(email);
      }
      saveSettings();
      await syncWithDrive(true);
      toast(email ? `Connected as ${email}` : "Google Drive connected");
    } else {
      toast("Connection cancelled");
    }
  } catch {
    toast("Drive connect failed — check the Client ID & origin");
  }
  updateDriveStatus();
  updateSyncStatus();
}

function disconnectDrive() {
  gdrive.disconnect();
  gdrive.setHint("");
  settings.gdriveConnected = false;
  settings.gdriveEmail = "";
  saveSettings();
  toast("Google Drive disconnected");
  updateDriveStatus();
  updateSyncStatus();
}

async function restoreFromDrive() {
  if (!gdrive.isConnected()) {
    toast("Connect Drive first");
    return;
  }
  try {
    const remote = await gdrive.download();
    if (remote && Array.isArray(remote.owned)) {
      const n = applyBackup(remote);
      markBackedUp();
      route();
      toast(`Restored ${n} packs from Drive`);
    } else {
      toast("No Drive backup found yet");
    }
  } catch {
    toast("Restore failed");
  }
  updateDriveStatus();
}

/* ---------------- settings sheet ---------------- */
function openSheet() {
  $("optMultiLang").checked = settings.multiLang;
  $("optAutoUpdate").checked = settings.autoUpdate;
  $("optShowPromos").checked = settings.showPromos;
  $("optShowPrices").checked = settings.showPrices;
  $("optBackupReminders").checked = settings.backupReminders;
  updateDriveStatus();
  updateValueSummary();
  const updated = DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleDateString() : "?";
  $("metaInfo").textContent =
    `Catalog: ${DATA.setCount} sets · ${DATA.packCount} packs · commit ${String(DATA.commit).slice(0, 7)} · updated ${updated}`;
  $("sheet").hidden = false;
}
// Overall collection value (English sets, honoring the promo toggle).
function updateValueSummary() {
  const el = $("valueSummary");
  if (!el) return;
  if (!settings.showPrices) {
    el.hidden = true;
    return;
  }
  const v = aggValues(visibleSets().filter((s) => s.lang === "en"));
  const priced = PRICES.generatedAt
    ? new Date(PRICES.generatedAt).toLocaleDateString()
    : "";
  el.innerHTML =
    `<div class="val-line"><span>Owned</span><b class="v-owned">${money(v.owned)}</b></div>` +
    `<div class="val-line"><span>Ordered</span><b>${money(v.ordered)}</b></div>` +
    `<div class="val-line"><span>Missing</span><b>${money(v.missing)}</b></div>` +
    `<div class="val-src">TCGplayer single-pack market${priced ? " · updated " + priced : ""}</div>`;
  el.hidden = false;
}
function closeSheet() {
  $("sheet").hidden = true;
}

/* ---------------- catalog loading + auto-update ---------------- */
async function readLiveCache() {
  try {
    const cache = await caches.open(CATALOG_CACHE);
    const res = await cache.match(LIVE_URL);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}
async function writeLiveCache(data) {
  try {
    const cache = await caches.open(CATALOG_CACHE);
    await cache.put(
      LIVE_URL,
      new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
    );
  } catch {}
}
async function loadCatalog() {
  const live = await readLiveCache();
  if (live && live.sets) {
    DATA = live;
  } else {
    const res = await fetch("data.json", { cache: "no-cache" });
    DATA = await res.json();
  }
  indexCatalog();
}
async function loadPrices() {
  try {
    const res = await fetch(PRICES_URL, { cache: "no-cache" });
    if (res.ok) {
      const p = await res.json();
      if (p && p.prices) PRICES = p;
    }
  } catch {
    /* prices are optional — the app works without them */
  }
}
async function ghJSON(path) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_INFO.OWNER}/${REPO_INFO.REPO}/${path}`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(res.status);
  return res.json();
}
async function checkForUpdate() {
  if (!settings.autoUpdate || !navigator.onLine) return;
  try {
    const head = await ghJSON("commits/main");
    const latest = head.sha;
    if (!latest || latest === DATA.commit) return;
    const tree = await ghJSON(`git/trees/${latest}?recursive=1`);
    if (!tree.tree) return;
    let readmeText = "";
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${REPO_INFO.OWNER}/${REPO_INFO.REPO}/${latest}/README.md`,
      );
      if (r.ok) readmeText = await r.text();
    } catch {}
    const prevPacks = DATA.packCount;
    const rebuilt = buildCatalog(tree.tree, latest, readmeText);
    DATA = rebuilt;
    indexCatalog();
    await writeLiveCache(rebuilt);
    route();
    const diff = rebuilt.packCount - prevPacks;
    toast(diff > 0 ? `Catalog updated · +${diff} new packs` : "Catalog updated");
  } catch {
    /* offline, rate-limited, or API error -> keep current catalog */
  }
}

/* ---------------- init ---------------- */
async function init() {
  $("backBtn").onclick = goBack;
  $("menuBtn").onclick = openSheet;
  $("closeSheet").onclick = closeSheet;
  $("sheet").onclick = (e) => {
    if (e.target === $("sheet")) closeSheet();
  };
  $("search").oninput = route;
  $("hideComplete").onchange = route;
  $("optMultiLang").onchange = (e) => {
    settings.multiLang = e.target.checked;
    saveSettings();
    location.hash = "";
    route();
  };
  $("optAutoUpdate").onchange = (e) => {
    settings.autoUpdate = e.target.checked;
    saveSettings();
    if (settings.autoUpdate) checkForUpdate();
  };
  $("optShowPromos").onchange = (e) => {
    settings.showPromos = e.target.checked;
    saveSettings();
    route();
  };
  $("optShowPrices").onchange = (e) => {
    settings.showPrices = e.target.checked;
    saveSettings();
    updateValueSummary();
    route();
  };
  $("optBackupReminders").onchange = (e) => {
    settings.backupReminders = e.target.checked;
    saveSettings();
    maybeShowBackupReminder();
  };
  $("driveConnectBtn").onclick = connectDrive;
  $("driveDisconnectBtn").onclick = disconnectDrive;
  $("driveRestoreBtn").onclick = restoreFromDrive;
  $("exportBtn").onclick = () => { exportBackup(); closeSheet(); };
  $("importBtn").onclick = () => $("importFile").click();
  $("reminderBackup").onclick = () => { exportBackup(); };
  $("reminderLater").onclick = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
    hideReminder();
  };
  $("importFile").onchange = (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = "";
    closeSheet();
  };
  $("clearBtn").onclick = () => {
    if (confirm("Reset ALL collection progress? This cannot be undone.")) {
      owned = new Set();
      ordered = new Set();
      quantities = {};
      saveCollection();
      route();
      toast("Progress reset");
    }
    closeSheet();
  };
  window.addEventListener("hashchange", route);

  try {
    await loadCatalog();
  } catch {
    $("app").innerHTML = `<p class="empty">Failed to load catalog. Check your connection and reopen.</p>`;
    return;
  }
  await loadPrices();

  route();
  requestPersistence();
  registerSW();
  checkForUpdate();
  maybeShowBackupReminder();
  updateSyncStatus();
  initDrive();
}

// Configure Drive from saved settings and silently reconnect if the user
// previously connected (no popup for an already-consented session).
async function initDrive() {
  gdrive.setClientId(gdrive.DEFAULT_CLIENT_ID || settings.gdriveClientId);
  gdrive.setHint(settings.gdriveEmail || "");
  if (settings.gdriveConnected && gdrive.hasClientId() && navigator.onLine) {
    if (await gdrive.reconnect()) {
      await syncWithDrive(true);
    }
    updateDriveStatus();
    updateSyncStatus();
  }
}
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {}
}
function registerSW() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
