/**
 * earnings-snapshot.js — write the "mine it or buy it" numbers to a JSON file.
 *
 *   node scripts/earnings-snapshot.js [outfile]
 *
 * The app reads these numbers live from the chain (src/services/earnings.js).
 * The website cannot, so a scheduled GitHub Action runs this and publishes the
 * result; the page just fetches the file. Same code, same numbers.
 */
const fs = require("fs");
const path = require("path");
const earnings = require("../src/services/earnings");
const K = require("../src/knowledge");

const out = process.argv[2] || path.join(__dirname, "..", "data", "earnings.json");

(async () => {
  const seeds = K.get().seedNodes;
  let data = null, lastError = null;
  for (const seed of seeds) {
    try { data = await earnings.estimate(seed, { force: true }); break; }
    catch (e) { lastError = e; }
  }
  if (!data) throw lastError || new Error("no seed node answered");
  if (!data.configs.length) throw new Error("no configurations came back — refusing to publish an empty file");

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`${out}: ${data.configs.length} configurations, GNK $${data.price.usd}, epoch ${data.epoch.index}`);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
