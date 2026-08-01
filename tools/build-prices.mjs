// Build www/prices.json: the single-Booster-Pack TCGplayer market price for
// each catalog set, sourced from the free, key-less TCGCSV daily mirror
// (https://tcgcsv.com). Prices are per ONE loose booster pack, in USD.
//
// TCGCSV doesn't send CORS headers, so the browser can't fetch it directly;
// this runs at build time (Node) and is refreshed by a scheduled GitHub Action.
// Artwork variants of the same set share the same loose-pack price, so we key
// prices by set code and the app multiplies by how many packs you own.
//
//   node tools/build-prices.mjs
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CATEGORY = 3; // Pokemon on TCGplayer/TCGCSV
const BASE = `https://tcgcsv.com/tcgplayer/${CATEGORY}`;

async function getJSON(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ptcg-pack-tracker price builder (+https://github.com/chhcd/ptcg-pack-tracker)",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Normalize a set name for fuzzy matching between our catalog and TCGCSV.
function norm(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (Pokémon -> Pokemon)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bpokemon\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// TCGCSV group names are often prefixed with a set code, e.g.
// "SV08: Surging Sparks", "SM - Guardians Rising" or "SWSH12: Silver Tempest".
// Drop a short, space-free code prefix before the first ": " or " - ".
function groupDisplayName(name) {
  for (const sep of [": ", " - "]) {
    const i = name.indexOf(sep);
    if (i > 0) {
      const prefix = name.slice(0, i);
      if (!/\s/.test(prefix) && prefix.length <= 9) return name.slice(i + sep.length);
    }
  }
  return name;
}

// Pick single "Booster Pack" products, excluding sleeved packs, bundles,
// boxes, cases, blisters, code cards and other SKUs. Vintage packs carry
// suffixes like "[Unlimited]" / "[1st Edition]", so match on a substring and
// let the caller keep the cheapest (a single loose pack).
const EXCLUDE = /(sleeved|bundle|box|case|code card|blister|collection|tin|elite trainer|half|build|premium|deck|set of|display|wrapper|empty|lot|3 pack|single pack)/i;
function isPlainBoosterPack(name) {
  return /booster pack/i.test(name) && !EXCLUDE.test(name);
}

// Era prefixes stripped to form fuzzy aliases (e.g. TCGCSV "Scarlet & Violet
// 151" -> "151", "EX Emerald" -> "emerald").
const ERA_PREFIXES = [
  "scarlet and violet ", "sword and shield ", "sun and moon ",
  "xy ", "black and white ", "diamond and pearl ",
  "heartgold and soulsilver ", "hs ", "sm ", "ex ",
];
function stripEraPrefix(n) {
  for (const p of ERA_PREFIXES) if (n.startsWith(p)) return n.slice(p.length);
  return n;
}
function stripBaseSet(n) {
  return n.replace(/\bbase set\b/g, "").replace(/\s+/g, " ").trim();
}

async function main() {
  const data = JSON.parse(await readFile(join(ROOT, "www", "data.json"), "utf8"));
  const enSets = data.sets.filter((s) => s.lang === "en");

  console.log("Fetching TCGCSV groups…");
  const groups = (await getJSON(`${BASE}/groups`)).results;
  console.log(`  ${groups.length} groups`);

  // Build normalized-name -> booster-pack market price from TCGCSV.
  // priceByName holds exact display names; priceByAlias holds fuzzy fallbacks
  // (era-prefix / "base set" stripped) that only apply if no exact match wins.
  const priceByName = new Map();
  const priceByAlias = new Map();
  const addAlias = (key, price) => {
    if (key && key.length >= 2 && !priceByAlias.has(key)) priceByAlias.set(key, price);
  };
  for (const g of groups) {
    let products, prices;
    try {
      [products, prices] = await Promise.all([
        getJSON(`${BASE}/${g.groupId}/products`),
        getJSON(`${BASE}/${g.groupId}/prices`),
      ]);
    } catch {
      continue; // some groups have no product/price files
    }
    const priceById = new Map();
    for (const p of prices.results) {
      if (!priceById.has(p.productId) && p.marketPrice != null)
        priceById.set(p.productId, p.marketPrice);
    }
    let best = null;
    for (const prod of products.results) {
      if (!isPlainBoosterPack(prod.name)) continue;
      const mkt = priceById.get(prod.productId);
      if (mkt == null) continue;
      if (best == null || mkt < best) best = mkt; // cheapest = a single loose pack
    }
    if (best == null) continue;
    const display = norm(groupDisplayName(g.name));
    if (!priceByName.has(display)) priceByName.set(display, best);
    addAlias(stripEraPrefix(display), best);
    addAlias(stripBaseSet(display), best);
    addAlias(stripEraPrefix(stripBaseSet(display)), best);
  }
  console.log(`  ${priceByName.size} sets with a booster-pack price`);

  // Suffixes for sub-sets that don't sell their own pack; fall back to parent.
  const stripSub = (n) =>
    n
      .replace(/\btrainer gallery\b/g, "")
      .replace(/\bgalarian gallery\b/g, "")
      .replace(/\bshiny vault\b/g, "")
      .replace(/\bclassic collection\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const out = {};
  let matched = 0;
  const missing = [];
  for (const s of enSets) {
    const n = norm(s.name);
    const candidates = [
      n,
      n + " base set", // "Scarlet & Violet" -> group "Scarlet & Violet Base Set"
      stripSub(n), // Trainer Gallery / Shiny Vault etc. -> parent
    ];
    let price = null;
    for (const c of candidates) {
      if (priceByName.has(c)) { price = priceByName.get(c); break; }
    }
    if (price == null) {
      for (const c of [n, stripSub(n)]) {
        if (priceByAlias.has(c)) { price = priceByAlias.get(c); break; }
      }
    }
    if (price != null) {
      out[s.code] = Math.round(price * 100) / 100;
      matched++;
    } else if (!s.isPromo) {
      missing.push(`${s.code} :: ${s.name}`);
    }
  }

  console.log(`\nMatched ${matched}/${enSets.length} English sets.`);
  if (missing.length) {
    console.log(`Unpriced (non-promo) ${missing.length}:`);
    for (const m of missing) console.log("  " + m);
  }

  const payload = {
    source: "tcgcsv.com (TCGplayer mirror)",
    unit: "single booster pack",
    currency: "USD",
    generatedAt: new Date().toISOString(),
    setCount: Object.keys(out).length,
    prices: out,
  };
  await writeFile(join(ROOT, "www", "prices.json"), JSON.stringify(payload, null, 2) + "\n");
  console.log(`\nWrote www/prices.json (${payload.setCount} priced sets).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
