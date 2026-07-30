// Google Drive backup sync for the Pack Tracker (client-side, no backend).
//
// Uses Google Identity Services (GIS) for OAuth with the narrow `drive.file`
// scope, so the app can only touch the single backup file it creates. One
// public OAuth Client ID (owned by the app operator) serves all users — end
// users just click "Connect" and consent; they never register anything.
//
// The Client ID is provided at runtime (Settings field or a hard-coded default
// below). Everything degrades gracefully when it is absent.

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const FILE_NAME = "ptcg-pack-tracker-backup.json";

// Optionally hard-code your Client ID here instead of using the Settings field.
export const DEFAULT_CLIENT_ID =
  "652207901743-ihc96b9bh4pg4kl0lmc36779trf6mcu3.apps.googleusercontent.com";

let clientId = "";
let hint = "";
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let gisLoaded = null;
let fileId = null;

function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

export function setClientId(id) {
  const next = (id || "").trim();
  if (next !== clientId) {
    clientId = next;
    tokenClient = null;
    accessToken = null;
    tokenExpiry = 0;
  }
}
export function setHint(email) {
  hint = email || "";
}
export function hasClientId() {
  return !!clientId;
}
export function isConnected() {
  return !!accessToken && Date.now() < tokenExpiry - 60000;
}

async function ensureTokenClient() {
  if (!clientId) throw new Error("No Google Client ID configured");
  await loadGis();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {}, // set per-request below
    });
  }
  return tokenClient;
}

// Request an access token.
//   mode "silent"      -> prompt:'none' (NO UI at all; errors if it can't,
//                         so launches never show an unexpected popup)
//   mode "interactive" -> normal flow (account chooser / consent as needed)
// A saved account `hint` lets the silent flow pick the right account without UI.
function requestToken(mode) {
  return new Promise(async (resolve, reject) => {
    try {
      const tc = await ensureTokenClient();
      tc.callback = (resp) => {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          resolve(accessToken);
        } else {
          reject(new Error(resp && resp.error ? resp.error : "no_token"));
        }
      };
      tc.error_callback = (err) => reject(new Error(err && err.type ? err.type : "oauth_error"));
      const cfg = mode === "silent" ? { prompt: "none" } : { prompt: "" };
      if (hint) cfg.hint = hint;
      tc.requestAccessToken(cfg);
    } catch (e) {
      reject(e);
    }
  });
}

/** Interactive connect (shows Google account chooser/consent). */
export async function connect() {
  if (isConnected()) return true;
  await requestToken("interactive");
  return isConnected();
}

/** Silent reconnect for a returning user — never shows UI. */
export async function reconnect() {
  if (isConnected()) return true;
  try {
    await requestToken("silent");
    return isConnected();
  } catch {
    return false;
  }
}

/** Fetch the signed-in user's email (works with the drive.file scope). */
export async function fetchEmail() {
  try {
    const res = await api("https://www.googleapis.com/drive/v3/about?fields=user");
    const data = await res.json();
    return (data.user && data.user.emailAddress) || "";
  } catch {
    return "";
  }
}

export function disconnect() {
  const t = accessToken;
  accessToken = null;
  tokenExpiry = 0;
  fileId = null;
  if (t && window.google && google.accounts && google.accounts.oauth2) {
    try {
      google.accounts.oauth2.revoke(t, () => {});
    } catch {}
  }
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  return res;
}

async function findFileId() {
  if (fileId) return fileId;
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = await api(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&pageSize=1`,
  );
  const data = await res.json();
  fileId = data.files && data.files[0] ? data.files[0].id : null;
  return fileId;
}

async function ensureToken() {
  if (isConnected()) return accessToken;
  return requestToken("silent");
}

/** Upload the given JSON string as the backup file (creates or updates). */
export async function upload(jsonString) {
  await ensureToken();
  const id = await findFileId();
  if (id) {
    await api(
      `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: jsonString },
    );
    return id;
  }
  const boundary = "ptcgboundary" + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: FILE_NAME }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    jsonString +
    `\r\n--${boundary}--`;
  const res = await api(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
  );
  const data = await res.json();
  fileId = data.id;
  return fileId;
}

/** Download the backup file's parsed contents, or null if none exists. */
export async function download() {
  await ensureToken();
  const id = await findFileId();
  if (!id) return null;
  const res = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return res.json();
}
