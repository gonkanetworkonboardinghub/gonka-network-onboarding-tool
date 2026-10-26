/**
 * rentals-snapshot.js — write "what renting each setup costs now" to a JSON file.
 *
 *   node scripts/rentals-snapshot.js <earnings.json> [outfile]
 *
 * The app reads the providers' prices live (src/services/rentals.js). The
 * website cannot, so the scheduled data job runs this after the earnings step
 * and publishes the result as rentals.json. Same code, same numbers.
 */
const fs = require("fs");
const path = require("path");
const rentals = require("../src/services/rentals");

const src = process.argv[2];
const out = process.argv[3] || path.join(__dirname, "..", "data", "rentals.json");

(async () => {
  if (!src) throw new Error("usage: rentals-snapshot.js <earnings.json> [outfile]");
  const earnings = JSON.parse(fs.readFileSync(src, "utf8"));
  if (!(earnings.configs || []).length) throw new Error("the earnings file has no configurations");
  const data = await rentals.estimate(earnings, { force: true });
  if (data.providers.every((p) => p.error)) throw new Error("no provider answered: " + data.providers.map((p) => `${p.name}: ${p.error}`).join("; "));
  if (!data.rows.length) throw new Error("no rows came back — refusing to publish an empty file");
  // Which epoch's earnings the comparison used.
  data.earningsEpoch = earnings.epoch && earnings.epoch.index;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`${out}: ${data.rows.length} servers, ${data.rows.filter((r) => r.best).length} with a dedicated offer that has what a node needs`);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
