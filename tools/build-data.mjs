// Builds www/data.json from the 1niceroli/ptcg-assets repo using the shared
// catalog logic in www/catalog.mjs. Re-run any time to refresh the bundled
// catalog (the app also refreshes itself at runtime).
//
//   node tools/build-data.mjs [ref]
//
// `ref` defaults to the repo default branch (main); pin a commit SHA for a
// reproducible catalog.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCatalog, REPO_INFO } from "../www/catalog.mjs";

const { OWNER, REPO } = REPO_INFO;
const ref = process.argv[2] || "main";
const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = join(__dirname, "..", "www", "data.json");

async function api(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "ptcg-pack-tracker",
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  console.log(`Resolving ${OWNER}/${REPO}@${ref} ...`);
  const info = await api(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${ref}`);
  const commit = info.sha;
  console.log(`Commit: ${commit}`);

  const tree = await api(
    `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${commit}?recursive=1`,
  );
  if (tree.truncated) console.warn("WARNING: git tree truncated; catalog may be incomplete.");

  // README table gives authoritative set names + era grouping.
  let readmeText = "";
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${commit}/README.md`,
    );
    if (r.ok) readmeText = await r.text();
  } catch {
    console.warn("WARNING: could not fetch README; using name/era fallbacks.");
  }

  const data = buildCatalog(tree.tree, commit, readmeText);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data));
  console.log(`Wrote ${outFile}: ${data.setCount} sets, ${data.packCount} packs.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
