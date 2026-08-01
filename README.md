# PTCG Pack Tracker

A very simple, installable **Pokémon TCG pack-artwork collection tracker**. Browse
sets **by era**, tap the booster pack designs to mark them **owned**, **ordered**
(bought, waiting to arrive) or not collected, track **how many copies** you own of
a design, and see your collection's **TCGplayer market value** (and what the packs
you're missing would cost). Newest sets appear first, English shows by default
(other languages are one toggle away), promo sets are optional, and the catalog
**auto-updates** when new sets are released. Works offline once installed and
stores your collection locally on-device, with one-tap **cloud backup**.

Artwork and set metadata come from the community asset repo
[1niceroli/ptcg-assets](https://github.com/1niceroli/ptcg-assets)
(physical sets only — **269 sets · 750 pack artworks**; the digital Pokémon TCG
Pocket line is intentionally excluded).

---

## Research

- The asset repo groups images per set code (`sv1`, `swsh12pt5`, `base1`, …).
  Each set has a `packshots/` folder containing one image per booster-pack design
  (e.g. `sv1/packshots/SV1_pack_Gyarados.webp`). Those packshots are exactly what
  this app tracks.
- Many sets ship **multiple pack artworks** (different Pokémon on the wrapper), so
  "collecting packs" means owning each distinct design — a niche nothing else
  tracks.
- Set folders also contain `logo.png`, used for nicer set headers.
- Built as a **PWA** (not native) so it can be built and verified without an
  Android SDK, installs to the Android home screen, and works offline. Project is
  structured (`www/` + `capacitor.config.json`) so it can later be wrapped into a
  real APK with [Capacitor](https://capacitorjs.com) with zero code changes.

## Navigation & features

The app is organized as a drill-down so a set is easy to find:

```
Era (Scarlet & Violet, Sword & Shield, …)  ← newest era first
  └─ Set (Prismatic Evolutions, Surging Sparks, …)  ← newest set first
       └─ Pack artworks  ← tap to mark owned
```

- **Three collection states.** Tapping a pack cycles **not collected → owned →
  ordered → not collected**. *Ordered* (amber 🛒 badge, half-lit art) means you've
  bought it and are waiting for it to arrive, so you won't buy it twice. Only
  *owned* packs count toward completion progress.
- **Multiple copies per design.** Own more than one of the same pack art? Use the
  small **＋ / −** stepper on an owned pack to set a count; a **×N** badge appears
  only when you have 2 or more (single copies stay clean — no "1×" clutter).
- **Prices & collection value.** Every set shows the **TCGplayer market price** of a
  single booster pack; the app totals what you **own** (× copies), what you've
  **ordered**, and what the packs you're **missing** would cost. Toggle *Show
  prices* off to hide it. See [Pricing](#pricing) below.
- **Newest first** everywhere — eras and sets are ordered most-recent → oldest,
  using the repo README's chronological table.
- **Era cards show artwork** — each era uses its namesake set's logo (e.g. the
  *Scarlet & Violet* era shows the `sv1` logo).
- **English by default.** Enable *Show other languages* in the menu to add a
  language chooser as the first level (English, Japanese, German, Chinese, Korean).
- **Promo sets optional** — toggle *Show promo sets* off to hide Black Star Promos
  and promo packs from lists and progress totals.
- **Search** any set by name/code from any list level (great for jumping straight
  to a set without drilling).
- **Hide complete** filter, per-era / per-set / overall progress bars.
- **Cloud backup**: one-tap backup to OneDrive / Google Drive / Dropbox (see below),
  plus save/restore a JSON file and reset.

## Backup & cloud sync

Your collection lives in on-device storage, so backups matter. Options in the menu:

- **☁︎ Back up to cloud** — uses the Web Share API to send the backup file straight
  into your OneDrive / Google Drive / Dropbox (or email) app via the OS share sheet.
  On desktop/unsupported browsers it falls back to a normal file download.
- **⬇︎ Save backup file** / **⬆︎ Restore from backup** — classic JSON export/import.
- **Backup reminders** (on by default) — if it's been a while (~7 days) since your
  last backup and you have packs marked, a banner nudges you with a one-tap
  *Back up* button so you don't forget. *Later* snoozes it for a day.

> **Why not fully-automatic background cloud sync for OneDrive/Dropbox?** A pure
> static PWA (no server) can't silently push to a cloud provider in the background
> without OAuth via a registered developer app + stored tokens. For **Google Drive**
> this app implements a proper client-side OAuth sync (below); OneDrive/Dropbox use
> the zero-setup Web Share path above.

### Automatic Google Drive sync (optional)

Connect once and your collection auto-syncs to **your own** Google Drive on every
change and on launch — no file juggling.

**User experience:** Settings → *Connect Google Drive* → Google's consent screen →
done. From then on it silently backs up (debounced) whenever you check/uncheck a
pack, and merges from Drive on launch (union — it never loses owned packs across
devices). *Restore from Drive* pulls the cloud copy; *Disconnect* revokes access.
Uses the narrow `drive.file` scope, so the app can only see the one backup file it
creates. Backup reminders are auto-suppressed while connected.

**Do end users each need a Client ID? No.** The app operator registers **one**
public OAuth Client ID; every user just taps *Connect*.

**One-time operator setup:**
1. In [Google Cloud Console](https://console.cloud.google.com/) create/select a
   project → **APIs & Services → Credentials**.
2. Configure the **OAuth consent screen** (External). For personal use keep it in
   *Testing* and add users' Google emails as **Test users** (up to 100). To open it
   to anyone, publish it (unverified shows a warning; verified needs Google review).
3. Create **OAuth client ID → Web application**. Add **Authorized JavaScript origin**
   `https://chhcd.github.io` (and `http://localhost:5173` for local dev).
4. Copy the Client ID (`…apps.googleusercontent.com`) and either paste it in the
   app's Settings → *One-time setup* field, or hard-code it as `DEFAULT_CLIENT_ID`
   in `www/gdrive.js`.
5. Enable the **Google Drive API** for the project.

> Sync uses union semantics (safe against data loss); un-checking a pack on one
> device won't remove it from another. Access tokens are held in memory only and
> refreshed silently — nothing sensitive is persisted.

## Auto-update — does it pull new sets automatically?

**Yes.** A bundled `data.json` loads instantly (and works offline). Then, when
online, the app fetches the asset repo's latest file tree from GitHub on launch,
rebuilds the catalog **in the browser** (shared logic in `www/catalog.mjs`), and if
the repo changed it swaps in the new catalog, caches it for offline use, and shows
a “Catalog updated · +N new packs” toast. So when `1niceroli/ptcg-assets` publishes
a new set, it appears in the app on the next launch — no rebuild or reinstall
needed. Toggle *Auto-update from GitHub* off in the menu to pin the bundled
catalog. (Uses the public GitHub API, ~60 requests/hour/IP; one request per launch.)

## Pricing

Each set's price is the **TCGplayer market price of a single loose booster pack**,
in USD. Artwork variants of the same set share the same loose-pack price, so prices
are keyed by set code and the app multiplies by how many packs you own (respecting
per-design counts). The menu's *Collection* section shows the totals: **Owned**,
**Ordered** and **Missing** value.

Prices come from the free, key-less **[TCGCSV](https://tcgcsv.com)** daily mirror of
TCGplayer. TCGCSV doesn't send CORS headers, so the browser can't fetch it directly;
instead `tools/build-prices.mjs` fetches it at build time into a bundled
`www/prices.json`, and a scheduled GitHub Action
(`.github/workflows/refresh-prices.yml`) regenerates it **daily** so the app stays
current while remaining fully offline-capable. Sets that don't have an active
single-pack market on TCGplayer (promos, brand-new sets, thinly-traded vintage)
simply show no price and are excluded from the totals; they fill in automatically
once TCGplayer lists a market price.

> Prices are market **estimates** for reference, not an appraisal. This is a
> personal, non-commercial fan tool.

## Plan

- [x] Index the asset repo into `www/data.json` (`tools/build-data.mjs`)
- [x] Shared catalog logic with set names, **era classification**, **newest-first
      ordering** and **language detection** (`www/catalog.mjs`)
- [x] Generate maskable Pokéball PWA icons (`tools/make-icons.mjs`)
- [x] Era → Set → Pack drill-down nav, tap-to-toggle owned, progress bars
- [x] Three pack states (not collected / owned / **ordered**) via tap-cycle
- [x] Per-design copy counts (×N badge, ＋/− stepper; hidden for single copies)
- [x] TCGplayer single-pack pricing: owned / ordered / missing collection value
- [x] Daily price refresh Action (`build-prices.mjs` → `www/prices.json`)
- [x] English-only default + language toggle / chooser
- [x] Search + "hide complete" filter
- [x] README-driven set names, era grouping & chronological order & language
- [x] Era cards show the namesake set's logo
- [x] Optional promo-set visibility toggle
- [x] Exclude the digital Pokémon TCG Pocket line
- [x] Runtime GitHub auto-update (rebuild in-browser, offline cache, fallback)
- [x] Cloud backup via Web Share + backup reminders; JSON save/restore + reset
- [x] Automatic Google Drive sync (client-side OAuth, `drive.file`, union merge)
- [x] Offline service worker (app shell + runtime image cache)
- [x] Installable manifest + persistent storage request
- [ ] (Optional) Capacitor wrap → APK / Play Store

## Usage

```powershell
# Serve locally (any modern browser)
npm start            # -> http://localhost:5173

# Refresh the catalog from the asset repo (optional; pin a commit for stability)
npm run build-data -- 89dca879388e39697a409c27e9c96c542576beda

# Refresh pack prices from TCGCSV (writes www/prices.json; runs daily via Actions)
npm run build-prices

# Regenerate icons
npm run make-icons
```

### Install on Android
1. Host the `www/` folder somewhere HTTPS (e.g. GitHub Pages, Netlify, Vercel).
2. Open the URL in Chrome on your phone → menu → **Add to Home screen**.
3. Launch it from the icon — fullscreen, offline-capable.

> Note: Service worker / install / offline features require **HTTPS** (or
> `localhost`). Opening `index.html` via `file://` won't register the SW.

## Wrapping into a real APK (later)

```powershell
npm install --save-dev @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync
npx cap open android   # build the APK in Android Studio
```

`capacitor.config.json` already points `webDir` at `www/`.

## Testing Plan

Verified in a headless browser (Playwright):
- Catalog loads: 287 sets / 779 packs (590 English); era home lists 14 eras
  newest-first (Mega Evolution → Other & Promos).
- Drilling Scarlet & Violet lists sets newest-first (Black Bolt, White Flare,
  Destined Rivals, …); opening a set shows the pack grid; tapping toggles owned.
- Back navigation walks Pack → Era → Home (→ Language when enabled).
- Language toggle adds a chooser (English, German, Japanese, Korean), English first.
- Search jumps to any set by name/code; "Hide complete" filters.
- Owned state persists across reloads; export/import/reset work.
- Pack states cycle not-collected → owned → ordered → not-collected; only owned
  counts toward progress; ordered + per-design counts persist across reloads and
  round-trip through backup/Drive sync (backward compatible with old owned-only
  backups).
- Pricing: `www/prices.json` loads; owned (× copies) / ordered / missing values
  total correctly in headers, cards and the menu summary; *Show prices* hides them.
- Auto-update: GitHub API reachable via CORS; in-browser `buildCatalog` rebuild of
  the live tree yields identical 287/779 and is cached for offline.
- Service worker registers; shell + images cached; zero console errors.

## Project layout

```
ptcg-pack-tracker/
├─ www/                      # web app (Capacitor webDir)
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js                 # ES module: nav, settings, auto-update, backups
│  ├─ catalog.mjs            # shared catalog logic (names, eras, order, lang)
│  ├─ gdrive.js              # Google Drive OAuth + sync (drive.file)
│  ├─ sw.js                  # offline service worker
│  ├─ manifest.webmanifest
│  ├─ data.json             # generated catalog (bundled fallback)
│  ├─ prices.json           # generated single-pack prices (TCGCSV/TCGplayer)
│  └─ icons/                # generated PNG icons
├─ tools/
│  ├─ build-data.mjs        # build data.json via www/catalog.mjs
│  ├─ build-prices.mjs      # build prices.json from TCGCSV
│  ├─ make-icons.mjs        # generate PWA icons
│  └─ serve.mjs             # tiny static dev server
├─ capacitor.config.json
└─ package.json
```

## Learnings

- Packshot filenames are inconsistent (resolution prefixes like `304px-`,
  lowercase `booster_raichu`, and raw hashes such as `81VK9bOyc+L.webp`), so set
  names rely on a curated map with a sanitised filename fallback; unnameable packs
  become `Design N`.
- PWAs are the fastest path to a working, installable Android experience with no
  Android SDK, and Capacitor keeps the door open to a store-ready APK later.

## Attribution

Pack artwork © The Pokémon Company / respective owners, mirrored by the
[ptcg-assets](https://github.com/1niceroli/ptcg-assets) project. This tracker is a
personal, non-commercial fan tool and ships no artwork itself — images load from
the asset repo at runtime.
