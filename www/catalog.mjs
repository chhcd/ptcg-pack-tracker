// Shared, dependency-free catalog logic used by BOTH the Node build script
// (tools/build-data.mjs) and the browser app (www/app.js). Given a GitHub git
// tree, it produces the set/pack catalog with language, era and newest-first
// ordering metadata. Keep this file free of Node-only APIs.

const OWNER = "1niceroli";
const REPO = "ptcg-assets";

/* ---------------- language ---------------- */
export const LANG_NAMES = {
  en: "English",
  ja: "Japanese",
  de: "German",
  zh: "Chinese",
  ko: "Korean",
  fr: "French",
  it: "Italian",
  es: "Spanish",
  ru: "Russian",
};

function normalizeLang(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.startsWith("zh")) return "zh";
  const m = s.match(/^[a-z]{2}/);
  return m ? m[0] : "en";
}

function splitLang(code) {
  const m = code.match(/^([a-z]{2})_(.+)$/);
  if (m && LANG_NAMES[m[1]] && m[1] !== "en") return { lang: m[1], base: m[2] };
  return { lang: "en", base: code };
}

/* ---------------- eras (newest first) ---------------- */
// rank 0 = newest. Physical eras only — Pokémon TCG Pocket is intentionally
// excluded. `test` is a heuristic fallback for codes missing from the repo
// README table (which is the primary source of era via its "Series" column).
export const ERAS = [
  { id: "me", name: "Mega Evolution", test: (c) => /^me(\d|p)/.test(c) || c === "mep" || c === "mepfpcs1" },
  { id: "sv", name: "Scarlet & Violet", test: (c) => /^sv\d/.test(c) || /^(r|z)sv/.test(c) || ["sve", "svp", "sv3pt5"].includes(c) },
  { id: "swsh", name: "Sword & Shield", test: (c) => c.startsWith("swsh") || ["cel25", "cel25c", "pgo", "fut20"].includes(c) },
  { id: "sm", name: "Sun & Moon", test: (c) => /^sm/.test(c) || ["det1", "smp", "sma"].includes(c) },
  { id: "xy", name: "XY", test: (c) => /^xy/.test(c) || ["g1", "dc1"].includes(c) },
  { id: "bw", name: "Black & White", test: (c) => /^bw/.test(c) || c === "dv1" },
  { id: "hgss", name: "HeartGold & SoulSilver", test: (c) => c.startsWith("hgss") || ["col1", "hsp"].includes(c) },
  { id: "pl", name: "Platinum", test: (c) => /^pl\d/.test(c) },
  { id: "dp", name: "Diamond & Pearl", test: (c) => /^dp/.test(c) },
  { id: "ex", name: "EX Series", test: (c) => /^ex\d/.test(c) || /^pop\d/.test(c) || c === "np" },
  { id: "ecard", name: "e-Card Series", test: (c) => c.startsWith("ecard") },
  { id: "wotc", name: "Original Series", test: (c) => /^base/.test(c) || /^gym/.test(c) || /^neo/.test(c) || c === "si1" },
  { id: "other", name: "Other & Promos", test: () => true },
];
const ERA_RANK = new Map(ERAS.map((e, i) => [e.id, i]));

// Sets from these series are dropped entirely (not part of the physical game).
const DROP_SERIES = new Set(["Trading Card Game Pocket"]);

// Repo README "Series" column -> era id. Language-suffixed variants
// ("… JP" / "… CN") are stripped before lookup; localized names map directly.
const SERIES_TO_ERA = {
  "Mega Evolution": "me", "Mega Entwicklung": "me",
  "Scarlet & Violet": "sv", "Karmesin & Purpur": "sv",
  "Sword & Shield": "swsh", "Schwert & Schild": "swsh",
  "Sun & Moon": "sm",
  XY: "xy",
  "Black & White": "bw",
  "HeartGold & SoulSilver": "hgss",
  Platinum: "pl",
  "Diamond & Pearl": "dp",
  EX: "ex", NP: "ex", POP: "ex",
  "E-Card": "ecard",
  Base: "wotc", Gym: "wotc", Neo: "wotc", Grundset: "wotc",
  Other: "other", Special: "other",
};

function eraById(id) {
  const rank = ERA_RANK.get(id);
  return rank === undefined ? null : { eraId: id, eraName: ERAS[rank].name, eraRank: rank };
}

// Returns era info, null to DROP the set, or undefined if series is unknown
// (caller falls back to the heuristic).
function eraFromSeries(series) {
  if (!series) return undefined;
  const s = series.replace(/\s+(JP|CN|EN|DE|KR|FR|IT|ES)$/i, "").trim();
  if (DROP_SERIES.has(s) || DROP_SERIES.has(series)) return null;
  const id = SERIES_TO_ERA[s];
  return id ? eraById(id) : undefined;
}

function classifyEra(base) {
  if (base.startsWith("tcgp")) return null; // TCG Pocket -> drop
  for (let i = 0; i < ERAS.length; i++) {
    if (ERAS[i].test(base)) return { eraId: ERAS[i].id, eraName: ERAS[i].name, eraRank: i };
  }
  const last = ERAS.length - 1;
  return { eraId: ERAS[last].id, eraName: ERAS[last].name, eraRank: last };
}

/* ---------------- repo README table ---------------- */
// Parses the "| ID | Language | Name | Series |" markdown table into
// code -> { name, series }.
export function parseReadme(text) {
  const meta = new Map();
  if (!text) return meta;
  let idx = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue; // ['', id, lang, name, series, '']
    const id = cells[1];
    const name = cells[3];
    const series = cells[4];
    if (!id || id.toLowerCase() === "id" || /^-+$/.test(id)) continue;
    // Row index is chronological within each series block; used for ordering.
    // Keep the first row for a duplicated id (sub-variant rows share a code).
    if (!meta.has(id)) meta.set(id, { name, lang: cells[2], series, idx: idx });
    idx++;
  }
  return meta;
}

// Higher = newer, used to sort sets within an era.
function computeOrder(base) {
  const m = base.match(/(\d+)(?:pt(\d+))?/);
  let n = m ? parseInt(m[1], 10) : 0;
  if (m && m[2]) n += parseInt(m[2], 10) / 10;
  // Sub-sets release with/after their base number.
  if (/tg$/.test(base)) n += 0.05;
  if (/gg$/.test(base)) n += 0.06;
  if (/sv$/.test(base)) n += 0.04;
  // Original-series sub-lines are chronological: base < gym < neo.
  if (/^gym/.test(base)) n += 10;
  else if (/^neo/.test(base)) n += 20;
  else if (base === "si1") n += 30;
  return n;
}

/* ---------------- set names ---------------- */
export const SET_NAMES = {
  base1: "Base Set", base2: "Jungle", base3: "Fossil", base4: "Base Set 2",
  base5: "Team Rocket", base6: "Legendary Collection",
  gym1: "Gym Heroes", gym2: "Gym Challenge",
  neo1: "Neo Genesis", neo2: "Neo Discovery", neo3: "Neo Revelation", neo4: "Neo Destiny",
  si1: "Southern Islands",
  ecard1: "Expedition Base Set", ecard2: "Aquapolis", ecard3: "Skyridge",
  ex1: "EX Ruby & Sapphire", ex2: "EX Sandstorm", ex3: "EX Dragon",
  ex4: "EX Team Magma vs Team Aqua", ex5: "EX Hidden Legends",
  ex6: "EX FireRed & LeafGreen", ex7: "EX Team Rocket Returns", ex8: "EX Deoxys",
  ex9: "EX Emerald", ex10: "EX Unseen Forces", ex11: "EX Delta Species",
  ex12: "EX Legend Maker", ex13: "EX Holon Phantoms", ex14: "EX Crystal Guardians",
  ex15: "EX Dragon Frontiers", ex16: "EX Power Keepers",
  np: "Nintendo Black Star Promos",
  pop1: "POP Series 1", pop2: "POP Series 2", pop3: "POP Series 3",
  pop4: "POP Series 4", pop5: "POP Series 5", pop6: "POP Series 6",
  pop7: "POP Series 7", pop8: "POP Series 8", pop9: "POP Series 9",
  dp1: "Diamond & Pearl", dp2: "Mysterious Treasures", dp3: "Secret Wonders",
  dp4: "Great Encounters", dp5: "Majestic Dawn", dp6: "Legends Awakened",
  dp7: "Stormfront", dpp: "DP Black Star Promos",
  pl1: "Platinum", pl2: "Rising Rivals", pl3: "Supreme Victors", pl4: "Arceus",
  hgss1: "HeartGold & SoulSilver", hgss2: "HS—Unleashed", hgss3: "HS—Undaunted",
  hgss4: "HS—Triumphant", hsp: "HGSS Black Star Promos", col1: "Call of Legends",
  bw1: "Black & White", bw2: "Emerging Powers", bw3: "Noble Victories",
  bw4: "Next Destinies", bw5: "Dark Explorers", bw6: "Dragons Exalted",
  bw7: "Boundaries Crossed", bw8: "Plasma Storm", bw9: "Plasma Freeze",
  bw10: "Plasma Blast", bw11: "Legendary Treasures", bwp: "BW Black Star Promos",
  dv1: "Dragon Vault",
  xy0: "Kalos Starter Set", xy1: "XY", xy2: "Flashfire", xy3: "Furious Fists",
  xy4: "Phantom Forces", xy5: "Primal Clash", xy6: "Roaring Skies",
  xy7: "Ancient Origins", xy8: "BREAKthrough", xy9: "BREAKpoint",
  xy10: "Fates Collide", xy11: "Steam Siege", xy12: "Evolutions",
  g1: "Generations", dc1: "Double Crisis", xyp: "XY Black Star Promos",
  sm1: "Sun & Moon", sm2: "Guardians Rising", sm3: "Burning Shadows",
  sm35: "Shining Legends", sm4: "Crimson Invasion", sm5: "Ultra Prism",
  sm6: "Forbidden Light", sm7: "Celestial Storm", sm75: "Dragon Majesty",
  sm8: "Lost Thunder", sm9: "Team Up", sm10: "Unbroken Bonds",
  sm11: "Unified Minds", sm115: "Hidden Fates", sm12: "Cosmic Eclipse",
  smp: "SM Black Star Promos", det1: "Detective Pikachu",
  swsh1: "Sword & Shield", swsh2: "Rebel Clash", swsh3: "Darkness Ablaze",
  swsh35: "Champion's Path", swsh4: "Vivid Voltage", swsh45: "Shining Fates",
  swsh45sv: "Shining Fates: Shiny Vault", swsh5: "Battle Styles",
  swsh6: "Chilling Reign", swsh7: "Evolving Skies", swsh8: "Fusion Strike",
  swsh9: "Brilliant Stars", swsh9tg: "Brilliant Stars: Trainer Gallery",
  swsh10: "Astral Radiance", swsh10tg: "Astral Radiance: Trainer Gallery",
  swsh11: "Lost Origin", swsh11tg: "Lost Origin: Trainer Gallery",
  swsh12: "Silver Tempest", swsh12tg: "Silver Tempest: Trainer Gallery",
  swsh12pt5: "Crown Zenith", swsh12pt5gg: "Crown Zenith: Galarian Gallery",
  swshp: "SWSH Black Star Promos", cel25: "Celebrations",
  cel25c: "Celebrations: Classic Collection", pgo: "Pokémon GO",
  sv1: "Scarlet & Violet", sv2: "Paldea Evolved", sv3: "Obsidian Flames",
  sv3pt5: "151", sv4: "Paradox Rift", sv4pt5: "Paldean Fates",
  sv5: "Temporal Forces", sv6: "Twilight Masquerade", sv6pt5: "Shrouded Fable",
  sv7: "Stellar Crown", sv8: "Surging Sparks", sv8pt5: "Prismatic Evolutions",
  sv9: "Journey Together", sv10: "Destined Rivals", svp: "SV Black Star Promos",
  sve: "SV Energies", rsv10pt5: "White Flare", zsv10pt5: "Black Bolt",
  fut20: "Pokémon Futsal 2020", mcd19: "McDonald's Collection 2019",
  mcd21: "McDonald's Collection 2021", mcd22: "McDonald's Collection 2022",
  tot22: "Trick or Trade 2022", tot23: "Trick or Trade 2023",
  tot24: "Trick or Trade 2024", topps1: "Topps TV Animation Edition",
  tcgp1: "Genetic Apex", tcgp1a: "Mythical Island",
  tcgpa2: "Space-Time Smackdown", tcgpa2a: "Triumphant Light",
  tcgpa2b: "Shining Revelry", tcgpa3: "Celestial Guardians",
  tcgpa3a: "Extradimensional Crisis", tcgpa3b: "Eevee Grove",
  tcgppa: "TCG Pocket Promos-A",
};

function titleCase(s) {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanLabel(label) {
  if (!label) return null;
  const s = label.replace(/^\d+\s*px\b[\s_-]*/i, "").trim();
  if (!/[a-z]/i.test(s)) return null;
  if (s.length < 3) return null;
  if (/^[a-z0-9]{8,}$/i.test(s) && !/\s/.test(s)) return null;
  return s;
}

function resolveSetName(base, filenameLabel) {
  return SET_NAMES[base] || cleanLabel(filenameLabel) || base.toUpperCase();
}

/* ---------------- filename parsing ---------------- */
function parseName(fileBase) {
  const base = fileBase.replace(/^\d+\s*px\b[\s_-]*/i, "");
  for (const sep of ["_pack_", "_Pack_", "_booster_", "_Booster_"]) {
    const i = base.indexOf(sep);
    if (i !== -1) {
      return { setLabel: titleCase(base.slice(0, i)), pack: cleanPack(base.slice(i + sep.length)) };
    }
  }
  const lead = base.match(/^booster[\s_-]+(.+)$/i);
  if (lead) return { setLabel: null, pack: cleanPack(lead[1]) };
  return { setLabel: null, pack: cleanPack(base) };
}

function cleanPack(frag) {
  const s = titleCase(frag);
  if (!/[a-z]/i.test(s)) return null;
  if (/^[a-z0-9]{9,}$/i.test(frag) && !/[\s_-]/.test(frag)) return null;
  return s;
}

function mostCommon(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestN = -1;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

/* ---------------- catalog build ---------------- */
// tree: array of { path, type } from the GitHub git-trees API.
// readmeText: optional repo README markdown, used for authoritative set names
// and era grouping (via its "Series" column).
export function buildCatalog(tree, commit, readmeText) {
  const meta = parseReadme(readmeText);
  const raw = (p) =>
    `https://raw.githubusercontent.com/${OWNER}/${REPO}/${commit}/${encodeURI(p)}`;
  const isImg = (p) => /\.(webp|png|jpg|jpeg)$/i.test(p);
  const blobs = tree.filter((n) => n.type === "blob");

  const bySet = new Map();
  for (const n of blobs) {
    if (!/\/packshots\//.test(n.path) || !isImg(n.path)) continue;
    const parts = n.path.split("/");
    const code = parts[0];
    const fileBase = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    const { setLabel, pack } = parseName(fileBase);
    if (!bySet.has(code)) bySet.set(code, { labels: [], packs: [] });
    const e = bySet.get(code);
    if (setLabel) e.labels.push(setLabel);
    e.packs.push({ id: n.path, name: pack, img: raw(n.path) });
  }

  const logos = new Map();
  for (const n of blobs) {
    const m = n.path.match(/^([^/]+)\/logo\.(png|webp|jpg|jpeg)$/i);
    if (m) logos.set(m[1], raw(n.path));
  }

  const sets = [];
  for (const [code, { labels, packs }] of bySet) {
    const { lang: codeLang, base } = splitLang(code);
    const m = meta.get(code);
    const lang = (m && normalizeLang(m.lang)) || codeLang;

    // Era: prefer the README "Series" column, fall back to the heuristic.
    // A null result means the set is dropped (e.g. TCG Pocket).
    let era = m ? eraFromSeries(m.series) : undefined;
    if (era === undefined) era = classifyEra(base);
    if (!era) continue; // dropped series / TCG Pocket

    const name = (m && m.name) || resolveSetName(base, mostCommon(labels));
    const isPromo = /promo/i.test(name);
    let designN = 0;
    for (const p of packs) if (!p.name) p.name = `Design ${++designN}`;
    packs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    sets.push({
      code, name, lang, isPromo,
      eraId: era.eraId, eraName: era.eraName, eraRank: era.eraRank,
      // README row index is chronological (higher = newer). Fall back to the
      // filename/code heuristic only for sets missing from the table.
      order: m && m.idx != null ? m.idx : computeOrder(base) - 1000,
      logo: logos.get(code) || null,
      packCount: packs.length,
      packs,
    });
  }

  // Global sort: English first, newest era first, newest set first.
  sets.sort(
    (a, b) =>
      (a.lang === "en" ? 0 : 1) - (b.lang === "en" ? 0 : 1) ||
      a.eraRank - b.eraRank ||
      b.order - a.order ||
      a.name.localeCompare(b.name),
  );

  return {
    source: `github.com/${OWNER}/${REPO}`,
    commit,
    generatedAt: new Date().toISOString(),
    setCount: sets.length,
    packCount: sets.reduce((s, x) => s + x.packCount, 0),
    sets,
  };
}

export const REPO_INFO = { OWNER, REPO };
