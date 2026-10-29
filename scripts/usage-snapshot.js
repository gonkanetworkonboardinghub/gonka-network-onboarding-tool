/**
 * usage-snapshot.js — the network's total weight and its AI use, epoch by epoch.
 *
 *   node scripts/usage-snapshot.js <previous.json> <out.json>
 *
 * Two lines for the network page's charts, read from the chain and nothing else:
 *
 *   w     the epoch's total weight (epoch_group_data total_weight): what the
 *         network proved it can compute, and what rewards are split by. The
 *         chain keeps it for every epoch, so the whole history is read once.
 *   paid  what users paid for AI in the epoch, in ngonka. The network's AI
 *         runs through devshards, and when an epoch settles each host's
 *         devshard results for it carry its `cost`, which Gonka's own code
 *         works out as (input tokens + output tokens) × the per-token price
 *         (devshard/state/machine.go, tokenCost). Added up over the epoch's
 *         hosts; `hosts` says how many had devshard results. The chain keeps
 *         these results only until the next epoch ends (in October 2026 epoch
 *         439's were there during epoch 440, and 438's were gone), so each
 *         epoch is read while it is the last one, and the line starts at 439.
 *   p     the per-token price in ngonka while the epoch was on, [lowest,
 *         highest] over the models and the runs that saw it. The chain keeps
 *         only the current price, so every run reads it and keeps it with the
 *         epoch. Tokens = paid ÷ price, where the price stayed one number.
 *
 * The chain's own token counters (developer/stats_by_epochs_backwards and the
 * like) read zero since inference moved to devshards, so they are not used.
 */
const fs = require("fs");
const K = require("../src/knowledge");

const KEEP = 180;
const MAX_QUESTIONS = 260;       // about three and a half minutes at the pace below
const GAP_MS = 800;              // one question every 0.8 s: a pace the nodes accept for ever
const INF = "/chain-api/productscience/inference/inference";

const [prevPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node scripts/usage-snapshot.js <previous.json> <out.json>");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asked = 0;
const budgetLeft = () => MAX_QUESTIONS - asked;

/** One question, at the pace the node accepts. null = the chain has no such record. */
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    if (asked++) await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (body && body.code === 5) return null;               // "not found", said as an error
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body).slice(0, 160)}`);
    return body;
  }
}

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();

  // The first public node that says which epoch it is.
  let seed = null, current = 0;
  for (const s of k.seedNodes) {
    try {
      const latest = await getJson(s + k.api.latestEpoch);
      const index = Number(((latest || {}).epoch_stages || {}).epoch_index || ((latest || {}).latest_epoch || {}).index);
      if (index) { seed = s; current = index; break; }
    } catch (_) { /* try the next node */ }
  }
  if (!seed) throw new Error("no Gonka node said which epoch it is");

  const have = {};
  try {
    for (const e of JSON.parse(fs.readFileSync(prevPath, "utf8")).epochs || []) have[e.e] = e;
  } catch (_) { /* first run */ }
  const row = (e) => (have[e] = have[e] || { e });

  /** The epoch's total weight and its hosts, biggest first. */
  async function group(e) {
    const g = await getJson(`${seed}${INF}/epoch_group_data/${e}`);
    const d = g && g.epoch_group_data;
    if (!d) return null;
    const members = (d.validation_weights || []).slice().sort((a, b) => Number(b.weight) - Number(a.weight)).map((m) => m.member_address);
    return { w: Number(d.total_weight) || 0, members };
  }
  /** What users paid for AI in a settled epoch, host by host. null when it has no devshard results (yet, or any more). */
  async function paidIn(e, g) {
    // The biggest host first: no results there means none to read, for one question.
    const first = await getJson(`${seed}${INF}/devshard_host_epoch_stats/${e}/${g.members[0]}`);
    if (!(first && first.found)) return null;
    let paid = Number(first.stats.cost) || 0, hosts = 1;
    for (const a of g.members.slice(1)) {
      const j = await getJson(`${seed}${INF}/devshard_host_epoch_stats/${e}/${a}`);
      if (j && j.found && j.stats) { paid += Number(j.stats.cost) || 0; hosts++; }
    }
    return { paid, hosts };
  }

  // 1. The epoch that is on: its weight, and the per-token price now.
  try {
    const g = await group(current);
    if (g) row(current).w = g.w;
    const prices = await getJson(`${seed}${INF}/all_model_per_token_prices`);
    const list = ((prices && prices.model_prices) || []).map((m) => Number(m.price)).filter((x) => x > 0);
    if (list.length) {
      const now = row(current), lo = Math.min(...list), hi = Math.max(...list);
      now.p = now.p ? [Math.min(now.p[0], lo), Math.max(now.p[1], hi)] : [lo, hi];
    }
  } catch (err) { console.error(`epoch ${current}: ${err.message}`); }

  // 2. What users paid in the last epoch, and the one before if a run missed it while it could still be read.
  let readPaid = [];
  for (const e of [current - 1, current - 2]) {
    if (e < 1 || (e === current - 2 && have[e] && have[e].paid != null)) continue;
    try {
      const g = await group(e);
      if (!g || !g.members.length || g.members.length + 2 > budgetLeft()) continue;
      row(e).w = g.w;
      const r = await paidIn(e, g);
      if (r) { Object.assign(row(e), r); readPaid.push(e); }
    } catch (err) { console.error(`epoch ${e}: ${err.message}`); }
  }

  // 3. The weight of every epoch the file lacks, newest first: one question each.
  const first = Math.max(1, current - KEEP + 1);
  let weighed = 0;
  for (let e = current - 1; e >= first && budgetLeft() > 0; e--) {
    if (have[e] && have[e].w) continue;
    try { const g = await group(e); if (g && g.w) { row(e).w = g.w; weighed++; } }
    catch (err) { console.error(`epoch ${e}: ${err.message}`); }
  }

  const epochs = Object.values(have).filter((x) => x.e >= first && x.e <= current).sort((a, b) => a.e - b.e);
  if (!epochs.length) throw new Error("nothing could be read");
  const out = {
    asOf: new Date().toISOString(),
    epoch: current,
    method: "w: epoch_group_data total_weight. paid: the sum over the epoch's hosts of devshard_host_epoch_stats cost, in ngonka " +
      "((input + output tokens) x per-token price, devshard/state/machine.go), read while the chain still keeps it (until the next epoch ends). " +
      "p: all_model_per_token_prices while the epoch was on, [lowest, highest]; tokens = paid / price where the two are equal.",
    from: epochs[0].e, to: epochs[epochs.length - 1].e,
    epochs
  };
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  const last = have[current - 1] || {};
  const noWeight = epochs.filter((x) => x.e < current && !x.w).length;
  console.log(`usage ${out.from}-${out.to}: epoch ${current} weight ${(have[current] || {}).w || "?"}, price ${(have[current] || {}).p ? have[current].p.join("-") : "?"}; ` +
    `epoch ${current - 1} paid ${last.paid != null ? (last.paid / 1e9).toFixed(2) + " GNK by " + last.hosts + " hosts" : "not settled or not readable"}; ` +
    `paid read for ${readPaid.join(", ") || "none"}; ${weighed} weights filled in, ${noWeight} still missing (${asked} questions)`);
})().catch((e) => { console.error("usage-snapshot failed: " + e.message); process.exit(1); });
