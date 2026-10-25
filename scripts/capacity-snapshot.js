/**
 * capacity-snapshot.js — the GPUs on the network, epoch by epoch, and of what kind.
 *
 *   node scripts/capacity-snapshot.js <previous.json> <out.json>
 *
 * "GPUs that took part": every card the hosts report on the machines that had
 * poc_weight > 0 in the epoch. The hosts report their own hardware and the
 * chain does not check it, so the app labels it that way, as Gonka's note for
 * dashboards asks (gonka.ai/docs/dashboard-maintainer-memo-v0.2.16-h100).
 *
 * The chain keeps only each host's LATEST hardware report: once a host leaves
 * or renames a machine, what it ran is gone. So an epoch is measured here while
 * it is on (`g`), read again every run until it ends. Epochs before this job
 * measured them come from Gonkascan's record (`gs`, its active GPUs per epoch,
 * gonkascan.com/api/v1/metrics/hardware), which it has kept every epoch since
 * epoch 100; on epoch 436 its count and this job's agreed exactly.
 *
 * Each epoch also carries `k`, its GPUs by kind (B300, B200, H200, H100…),
 * because 2,000 H100s are not 2,000 B300s.
 *
 * Each run: one 5 MB list of every host's hardware and the current epoch's
 * records (about five questions), and Gonkascan's series (one download).
 */
const fs = require("fs");
const K = require("../src/knowledge");

const KEEP = 180;
const GAP_MS = 800;
const INF = "/chain-api/productscience/inference/inference";
const GONKASCAN = "https://gonkascan.com/api/v1/metrics/hardware";
// The kinds the app names; anything else is "Other". Order matters: first match wins.
const KINDS = [[/B300/i, "B300"], [/B200/i, "B200"], [/H200/i, "H200"], [/H100/i, "H100"], [/H20\b/i, "H20"], [/A100/i, "A100"],
  [/RTX|GeForce/i, "RTX"], [/AMD|Instinct|MI\d{3}/i, "AMD"], [/Tenstorrent|Wormhole/i, "Tenstorrent"]];
const kindOf = (type) => (KINDS.find(([re]) => re.test(String(type))) || [, "Other"])[1];

const [prevPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node scripts/capacity-snapshot.js <previous.json> <out.json>");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asked = 0;
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    if (asked++) await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (body && body.code === 5) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body).slice(0, 160)}`);
    return body;
  }
}
const add = (kinds, type, n) => { if (n > 0) { const k = kindOf(type); kinds[k] = (kinds[k] || 0) + n; } };

/** The GPUs on the machines that worked in the current epoch: { g, k }. */
function measureNow(groups, hardware) {
  const seen = new Set(), kinds = {};
  let gpus = 0;
  for (const g of groups) {
    for (const m of g.validation_weights || []) {
      const machines = hardware.get(m.member_address) || new Map();
      for (const n of m.ml_nodes || []) {
        const id = m.member_address + "/" + n.node_id;
        if (!(Number(n.poc_weight) > 0) || seen.has(id)) continue;
        seen.add(id);
        for (const x of machines.get(n.node_id) || []) { const c = Number(x.count) || 0; gpus += c; add(kinds, x.type, c); }
      }
    }
  }
  return { g: gpus, k: kinds };
}

/** Gonkascan's active GPUs per epoch: { epoch: { g, k } }, or null if it cannot be had. */
async function gonkascanGpus() {
  try {
    const res = await fetch(GONKASCAN, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "GNOT data job" } });
    if (!res.ok) return null;
    const active = ((await res.json()).series || {}).active_amount || {};
    const out = {};
    for (const [type, points] of Object.entries(active)) {
      for (const p of points || []) {
        const n = Number(p.value) || 0;
        const e = (out[p.epoch_id] = out[p.epoch_id] || { g: 0, k: {} });
        e.g += n;
        add(e.k, type, n);
      }
    }
    return Object.keys(out).length ? out : null;
  } catch (_) { return null; }
}

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();

  let seed = null, current = 0;
  for (const s of k.seedNodes) {
    try {
      const latest = await getJson(s + k.api.latestEpoch);
      current = Number(((latest || {}).epoch_stages || {}).epoch_index || ((latest || {}).latest_epoch || {}).index);
      if (current) { seed = s; break; }
    } catch (_) { /* the next node */ }
  }
  if (!seed) throw new Error("no Gonka node answered");

  const have = {};
  try { for (const x of JSON.parse(fs.readFileSync(prevPath, "utf8")).epochs || []) if (x && x.e) have[x.e] = x; } catch (_) { /* first run */ }
  const first = Math.max(1, current - KEEP + 1);
  const row = (e) => (have[e] = have[e] || { e });

  // 1. The current epoch, measured while it is on.
  let measured = null;
  try {
    const r = await getJson(`${seed}${INF}/epoch_group_data/${current}`);
    const root = r && r.epoch_group_data;
    if (root && (root.sub_group_models || []).length) {
      const all = await getJson(`${seed}${INF}/hardware_nodes_all`);
      const hardware = new Map();
      for (const p of (all && all.nodes) || []) hardware.set(p.participant, new Map((p.hardware_nodes || []).map((n) => [n.local_id, n.hardware || []])));
      const groups = [];
      for (const model of root.sub_group_models) {
        const g = await getJson(`${seed}${INF}/epoch_group_data/${current}?model_id=${encodeURIComponent(model)}`);
        if (g && g.epoch_group_data) groups.push(g.epoch_group_data);
      }
      if (hardware.size && groups.length) {
        measured = measureNow(groups, hardware);
        if (measured.g > 0) Object.assign(row(current), { g: measured.g, k: measured.k });
      }
    }
  } catch (err) { console.error(`current epoch ${current}: ${err.message}`); }

  // 2. Gonkascan's record, for the epochs this job did not measure itself.
  const gs = await gonkascanGpus();
  if (gs) for (let e = first; e <= current; e++) if (gs[e] && gs[e].g > 0) { const x = row(e); x.gs = gs[e].g; if (x.g == null) x.k = gs[e].k; }

  const epochs = [];
  for (let e = first; e <= current; e++) if (have[e] && (have[e].g != null || have[e].gs != null)) epochs.push(have[e]);
  if (!epochs.length) throw new Error("nothing could be read");
  fs.writeFileSync(outPath, JSON.stringify({
    asOf: new Date().toISOString(),
    method: "GPUs (self-reported) on machines with poc_weight > 0 in the epoch: g measured by this job while the epoch is on; gs from Gonkascan's record (gonkascan.com/api/v1/metrics/hardware); k by kind",
    // e epoch, g GPUs (this job), gs GPUs (Gonkascan), k GPUs by kind
    epochs
  }) + "\n");
  const last = epochs[epochs.length - 1];
  console.log(`capacity ${epochs[0].e}-${last.e}: ${epochs.length} epochs (${epochs.filter((x) => x.g != null).length} measured here, ` +
    `${epochs.filter((x) => x.gs != null).length} in Gonkascan's record${gs ? "" : " — Gonkascan did not answer this run"}; ${asked} questions); ` +
    `epoch ${last.e}: ${last.g != null ? `${last.g} GPUs measured here${last.gs != null ? ` (Gonkascan: ${last.gs})` : ""}` : `${last.gs} GPUs in Gonkascan's record`} — ` +
    Object.entries(last.k || {}).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", "));
})().catch((e) => { console.error("capacity-snapshot failed: " + e.message); process.exit(1); });
