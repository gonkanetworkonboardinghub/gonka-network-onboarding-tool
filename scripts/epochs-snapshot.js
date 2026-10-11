/**
 * epochs-snapshot.js — every host's results for the recent epochs, as one file.
 *
 *   node scripts/epochs-snapshot.js <previous.json> <out.json>
 *
 * Gonka Host Monitor/Vote shows a node's rewards epoch by epoch, and how it
 * did next to the other hosts. The chain has all of that, one epoch per
 * question — but a public node refuses a caller after about twenty quick
 * questions, so an app that asked for thirty epochs at once got refused. This
 * asks once, slowly, on GitHub's machine, and publishes the answers as
 * epochs.json on the data branch; the app then needs one small download.
 *
 * It keeps the last KEEP epochs. Each run reads only what the previous file
 * lacks (at most PER_RUN, so a first run fills in over a few runs instead of
 * hammering the node) plus the newest two again, because whether a reward has
 * been claimed can still change for a while. Past epochs never change.
 *
 * Compact on purpose: addresses are listed once, and each row is
 *   [host, rewarded, earned, requests, missed, validated, invalidated, claimed]
 * with amounts in ngonka.
 */
const fs = require("fs");
const K = require("../src/knowledge");

const KEEP = 180;
const PER_RUN = 150;
const GAP_MS = 800;              // one question every 0.8 s: a pace the node accepts for ever
const INF = "/chain-api/productscience/inference/inference";

const [prevPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node scripts/epochs-snapshot.js <previous.json> <out.json>");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }
}

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();

  // Past results are only on some of Gonka's nodes: find one that has them.
  let seed = null, current = 0;
  for (const s of k.seedNodes) {
    try {
      const latest = await getJson(s + k.api.latestEpoch);
      const index = Number(((latest || {}).epoch_stages || {}).epoch_index || ((latest || {}).latest_epoch || {}).index);
      if (!index) continue;
      const probe = await getJson(`${s}${INF}/epoch_performance_summary/${index - 2}`);
      if (probe && Array.isArray(probe.epochPerformanceSummary) && probe.epochPerformanceSummary.length) { seed = s; current = index; break; }
    } catch (_) { /* try the next node */ }
    await sleep(GAP_MS);
  }
  if (!seed) throw new Error("no Gonka node gave past results");

  // What the previous file already holds, back in plain form.
  const have = {};
  try {
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    for (const e of prev.epochs || []) have[e.e] = e.r.map((r) => [prev.hosts[r[0]], ...r.slice(1)]);
  } catch (_) { /* first run */ }

  const last = current - 1;                              // the newest finished epoch
  const first = Math.max(1, last - KEEP + 1);
  const wanted = [];
  for (let e = last; e >= first; e--) if (!have[e] || e > last - 2) wanted.push(e);
  const todo = wanted.slice(0, PER_RUN);

  let read = 0;
  for (const e of todo) {
    try {
      const j = await getJson(`${seed}${INF}/epoch_performance_summary/${e}`);
      const rows = (j && j.epochPerformanceSummary) || [];
      if (rows.length) {
        have[e] = rows.map((r) => [r.participant_id, Number(r.rewarded_coins) || 0, Number(r.earned_coins) || 0,
          Number(r.inference_count) || 0, Number(r.missed_requests) || 0,
          Number(r.validated_inferences) || 0, Number(r.invalidated_inferences) || 0, r.claimed ? 1 : 0]);
        read++;
      }
    } catch (err) {
      console.error(`epoch ${e}: ${err.message}`);        // keep what we had for it, if anything
    }
    await sleep(GAP_MS);
  }

  // Back to the compact form: each address once.
  const hosts = [], at = new Map();
  const id = (address) => { if (!at.has(address)) { at.set(address, hosts.length); hosts.push(address); } return at.get(address); };
  const epochs = [];
  for (let e = first; e <= last; e++) {
    if (!have[e]) continue;
    epochs.push({ e, r: have[e].map((r) => [id(r[0]), ...r.slice(1)]) });
  }
  if (!epochs.length) throw new Error("nothing could be read");

  const out = { asOf: new Date().toISOString(), from: epochs[0].e, to: epochs[epochs.length - 1].e, hosts, epochs };
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  const missing = last - first + 1 - epochs.length;
  console.log(`epochs ${out.from}-${out.to}: ${epochs.length} held (${read} read this run, ${missing} still to fill in), ${hosts.length} hosts, ${fs.statSync(outPath).size} bytes`);
})().catch((e) => { console.error("epochs-snapshot failed: " + e.message); process.exit(1); });
