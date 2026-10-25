/**
 * epochs-snapshot.js — every host's results for the recent epochs, as one file.
 *
 *   node scripts/epochs-snapshot.js <previous.json> <out.json>
 *
 * Gonka Host Monitor/Vote shows a node's rewards epoch by epoch, and how it
 * did next to the other hosts. The chain has all of that, but it does not
 * hand it over easily, and both ways it has refused were found the hard way:
 *
 *   - a public node answers about twenty quick questions from one address and
 *     then refuses (HTTP 503) until it has had a rest; one question every 0.7
 *     seconds goes on for ever;
 *   - from about 13 October 2026 the nodes cap what one question may cost
 *     ("Query gas limit exceeded: 10000000"), and the question that returned
 *     every host's results for an epoch in one go now always exceeds it.
 *
 * So this asks the cheap way, slowly, on GitHub's machine: an epoch's member
 * list (epoch_group_data), then each member's own result for that epoch. The
 * app then needs one small download, epochs.json on the data branch, instead
 * of hundreds of questions.
 *
 * It keeps the last KEEP epochs. Each run reads the epochs the previous file
 * lacks, newest first, up to MAX_QUESTIONS, and asks again about any result in
 * the newest two epochs not yet marked claimed, because that can still change.
 * Past epochs never change otherwise.
 *
 * Compact on purpose: addresses are listed once, and each row is
 *   [host, rewarded, earned, requests, missed, validated, invalidated, claimed]
 * with amounts in ngonka. Each epoch also carries `t`, when it began: the
 * time of its Proof of Compute's first block, in Unix seconds, so the charts
 * can say when an epoch was. Epochs read before `t` existed get it filled in
 * with whatever questions a run has left over.
 */
const fs = require("fs");
const K = require("../src/knowledge");

const KEEP = 180;
const MAX_QUESTIONS = 450;       // about six minutes at the pace below
const GAP_MS = 800;              // one question every 0.8 s: a pace the nodes accept for ever
const INF = "/chain-api/productscience/inference/inference";

const [prevPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node scripts/epochs-snapshot.js <previous.json> <out.json>");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asked = 0;

/** One question, at the pace the node accepts. null = the chain has no such record. */
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    if (asked++) await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (body && body.code === 5) return null;               // "not found", said as an error
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body).slice(0, 160)}`);
    return body;
  }
}
const toRow = (s) => [s.participant_id, Number(s.rewarded_coins) || 0, Number(s.earned_coins) || 0,
  Number(s.inference_count) || 0, Number(s.missed_requests) || 0,
  Number(s.validated_inferences) || 0, Number(s.invalidated_inferences) || 0, s.claimed ? 1 : 0];

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();

  // A node that answers the per-host question about a finished epoch.
  let seed = null, current = 0;
  for (const s of k.seedNodes) {
    try {
      const latest = await getJson(s + k.api.latestEpoch);
      const index = Number(((latest || {}).epoch_stages || {}).epoch_index || ((latest || {}).latest_epoch || {}).index);
      if (!index) continue;
      const group = await getJson(`${s}${INF}/epoch_group_data/${index - 1}`);
      const first = ((group && group.epoch_group_data && group.epoch_group_data.validation_weights) || [])[0];
      if (!first) continue;
      const probe = await getJson(`${s}${INF}/epoch_performance_summary/${index - 1}/${first.member_address}`);
      if (probe && probe.epochPerformanceSummary) { seed = s; current = index; break; }
    } catch (_) { /* try the next node */ }
  }
  if (!seed) throw new Error("no Gonka node gave past results");

  // What the previous file already holds, back in plain form.
  const have = {}, began = {};
  try {
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    for (const e of prev.epochs || []) {
      have[e.e] = e.r.map((r) => [prev.hosts[r[0]], ...r.slice(1)]);
      if (e.t) began[e.e] = e.t;
    }
  } catch (_) { /* first run */ }

  /** When an epoch began: the time of the block its Proof of Compute started at. */
  async function startOf(group) {
    const height = Number(((group || {}).epoch_group_data || {}).poc_start_block_height);
    if (!height || budgetLeft() < 1) return null;
    const b = await getJson(`${seed}/chain-rpc/block?height=${height}`);
    const header = b && b.result && b.result.block && b.result.block.header;
    const t = header ? Date.parse(header.time) : NaN;
    return isFinite(t) ? Math.round(t / 1000) : null;
  }

  const last = current - 1;                              // the newest finished epoch
  const first = Math.max(1, last - KEEP + 1);
  const budgetLeft = () => MAX_QUESTIONS - asked;
  let filled = 0, rechecked = 0, stopped = false;

  /** Every member's result for one epoch, or null if it could not all be read. */
  async function readEpoch(e) {
    const group = await getJson(`${seed}${INF}/epoch_group_data/${e}`);
    const members = ((group && group.epoch_group_data && group.epoch_group_data.validation_weights) || []).map((m) => m.member_address);
    if (!members.length || members.length + 2 > budgetLeft()) return null;
    const rows = [];
    for (const a of members) {
      const j = await getJson(`${seed}${INF}/epoch_performance_summary/${e}/${a}`);
      if (j && j.epochPerformanceSummary) rows.push(toRow(j.epochPerformanceSummary));
    }
    if (rows.length && !began[e]) { try { const t = await startOf(group); if (t) began[e] = t; } catch (_) { /* filled in later */ } }
    return rows.length ? rows : null;
  }

  // 1. The newest two: ask again only about results not yet marked claimed.
  for (const e of [last - 1, last]) {
    if (!have[e]) continue;
    for (const r of have[e]) {
      if (r[7] || budgetLeft() < 1) continue;
      try {
        const j = await getJson(`${seed}${INF}/epoch_performance_summary/${e}/${r[0]}`);
        if (j && j.epochPerformanceSummary) { r.splice(0, r.length, ...toRow(j.epochPerformanceSummary)); rechecked++; }
      } catch (err) { console.error(`epoch ${e}, ${r[0]}: ${err.message}`); }
    }
  }
  // 2. The epochs the file lacks, newest first.
  for (let e = last; e >= first; e--) {
    if (have[e]) continue;
    if (budgetLeft() < 10) { stopped = true; break; }
    try {
      const rows = await readEpoch(e);
      if (rows) { have[e] = rows; filled++; } else if (budgetLeft() < 40) { stopped = true; break; }
    } catch (err) {
      console.error(`epoch ${e}: ${err.message}`);
    }
  }

  // 3. When each held epoch began, for those read before that was kept: two
  //    questions each (its group record, then that block), newest first.
  let dated = 0;
  for (let e = last; e >= first; e--) {
    if (!have[e] || began[e]) continue;
    if (budgetLeft() < 2) break;
    try {
      const t = await startOf(await getJson(`${seed}${INF}/epoch_group_data/${e}`));
      if (t) { began[e] = t; dated++; }
    } catch (err) { console.error(`epoch ${e} start: ${err.message}`); }
  }

  // Back to the compact form: each address once.
  const hosts = [], at = new Map();
  const id = (address) => { if (!at.has(address)) { at.set(address, hosts.length); hosts.push(address); } return at.get(address); };
  const epochs = [];
  for (let e = first; e <= last; e++) if (have[e]) epochs.push({ e, ...(began[e] ? { t: began[e] } : {}), r: have[e].map((r) => [id(r[0]), ...r.slice(1)]) });
  if (!epochs.length) throw new Error("nothing could be read");

  const out = { asOf: new Date().toISOString(), from: epochs[0].e, to: epochs[epochs.length - 1].e, hosts, epochs };
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  const missing = last - first + 1 - epochs.length;
  console.log(`epochs ${out.from}-${out.to}: ${epochs.length} held (${epochs.filter((x) => x.t).length} dated, ${dated} this run), ${filled} filled in and ${rechecked} claims re-checked this run ` +
    `(${asked} questions), ${missing} still missing${stopped ? " — out of questions for this run, the next run goes on" : ""}; ${hosts.length} hosts, ${fs.statSync(outPath).size} bytes`);
})().catch((e) => { console.error("epochs-snapshot failed: " + e.message); process.exit(1); });
