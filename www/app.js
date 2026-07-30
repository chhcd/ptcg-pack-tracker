"use strict";
import { buildCatalog, LANG_NAMES, REPO_INFO } from "./catalog.mjs";
import * as gdrive from "./gdrive.js";

const STORE_KEY = "ptcg-collection-v1";
const SETTINGS_KEY = "ptcg-settings-v1";
const LASTBACKUP_KEY = "ptcg-last-backup";
const SNOOZE_KEY = "ptcg-backup-snooze";
const BACKUP_INTERVAL = 7 * 24 * 60 * 60 * 1000; // remind after ~7 days
const CATALOG_CACHE = "ptcg-catalog";
const LIVE_URL = "/live-catalog.json"; // synthetic key inside CATALOG_CACHE
const $ = (id) => document.getElementById(id);

let DATA = null;
let owned = new Set(loadJSON(STORE_KEY, []));
let settings = Object.assign(
  {
    multiLang: false,
    autoUpdate: true,
    showPromos: true,
    backupReminders: true,
    gdriveClientId: "",
    gdriveConnected: false,
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
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  header("Pack Tracker", `${overall.done}/${overall.total} English packs`, false, true);
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
    `${a.done}/${a.total} packs · ${a.setsDone}/${a.setCount} sets complete`,
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
  header(eraName, `${a.done}/${a.total} packs · ${a.setsDone}/${a.setCount} sets`, true, true);
  setProgress(a.done, a.total);
  if (currentQuery()) return renderSearch(lang);

  const hideComplete = $("hideComplete").checked;
  const cards = sets
    .filter((s) => !(hideComplete && s.packCount > 0 && ownedInSet(s) === s.packCount))
    .map(setCard);
  renderList(cards, "No sets in this era.");
}
function renderPacks(code) {
  const s = setByCode.get(code);
  if (!s) {
    location.hash = "";
    return;
  }
  const o = ownedInSet(s);
  header(s.name, `${s.code.toUpperCase()} · ${o}/${s.packCount} packs`, true, false);
  setProgress(o, s.packCount);

  const app = $("app");
  const grid = document.createElement("div");
  grid.className = "pack-grid";
  for (const p of s.packs) {
    const el = document.createElement("div");
    el.className = "pack" + (owned.has(p.id) ? " owned" : "");
    el.innerHTML = `<div class="check">✓</div>
      <img loading="lazy" src="${p.img}" alt="${escapeHtml(p.name)}" onerror="this.style.opacity=0.2">
      <div class="pname">${escapeHtml(p.name)}</div>`;
    el.onclick = () => {
      if (owned.has(p.id)) owned.delete(p.id);
      else owned.add(p.id);
      saveOwned();
      el.classList.toggle("owned");
      const oo = ownedInSet(s);
      $("subtitle").textContent = `${s.code.toUpperCase()} · ${oo}/${s.packCount} packs`;
      setProgress(oo, s.packCount);
      scheduleDriveSync();
    };
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
    version: 1,
    exportedAt: new Date().toISOString(),
    catalogCommit: DATA.commit,
    owned: [...owned],
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
      const arr = Array.isArray(data) ? data : data.owned;
      if (!Array.isArray(arr)) throw new Error("bad file");
      owned = new Set(arr);
      saveOwned();
      markBackedUp();
      route();
      toast(`Restored ${arr.length} packs`);
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
  else if (gdrive.isConnected()) el.textContent = "Connected — auto-syncing to your Drive.";
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
        const before = owned.size;
        for (const id of remote.owned) owned.add(id);
        if (owned.size !== before) {
          saveOwned();
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
  const id = settings.gdriveClientId || gdrive.DEFAULT_CLIENT_ID;
  if (!id) {
    toast("No Google Client ID configured");
    return;
  }
  gdrive.setClientId(id);
  toast("Opening Google sign-in…");
  try {
    if (await gdrive.connect()) {
      settings.gdriveConnected = true;
      saveSettings();
      await syncWithDrive(true);
      toast("Google Drive connected");
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
  settings.gdriveConnected = false;
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
      owned = new Set(remote.owned);
      saveOwned();
      markBackedUp();
      route();
      toast(`Restored ${remote.owned.length} packs from Drive`);
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
  $("optBackupReminders").checked = settings.backupReminders;
  updateDriveStatus();
  const updated = DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleDateString() : "?";
  $("metaInfo").textContent =
    `Catalog: ${DATA.setCount} sets · ${DATA.packCount} packs · commit ${String(DATA.commit).slice(0, 7)} · updated ${updated}`;
  $("sheet").hidden = false;
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
      saveOwned();
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
  gdrive.setClientId(settings.gdriveClientId || gdrive.DEFAULT_CLIENT_ID);
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
