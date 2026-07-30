// Offline support: precache the app shell + catalog, runtime-cache pack images.
const VERSION = "v10";
const SHELL_CACHE = `ptcg-shell-${VERSION}`;
const IMG_CACHE = "ptcg-images";
const CATALOG_CACHE = "ptcg-catalog";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./catalog.mjs",
  "./gdrive.js",
  "./data.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== IMG_CACHE && k !== CATALOG_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pack/logo artwork -> cache-first, keep offline copies of what you've viewed.
  if (url.hostname === "raw.githubusercontent.com") {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return hit || Response.error();
        }
      }),
    );
    return;
  }

  // Same-origin app shell -> cache-first with network fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }),
      ),
    );
  }
});
