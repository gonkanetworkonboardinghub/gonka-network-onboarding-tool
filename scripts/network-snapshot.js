/**
 * network-snapshot.js — the network as a whole, for GNOT's network page.
 *
 *   node scripts/network-snapshot.js <out.json>
 *
 * Gonka Host Monitor/Vote shows everyone on the network: how many GPUs each
 * host runs and of what kind, and the network's totals — GPUs, GNK in
 * existence, the community pool. The GPUs are only told host by host (one
 * question each), and a public node refuses a caller who asks too much at once,
 * so this asks here, slowly, and publishes network.json on the data branch;
 * the app reads it in one download and adds the live figures itself.
 *
 * The same answers say which models each machine serves on which GPUs, and how
 * much memory each GPU has ("NVIDIA B300 SXM6 AC | 268GB"). Host Setup uses that
 * to show what a model really runs on, and what memory a chosen setup needs:
 *   models  { model: [{ gpus: [{ kind, count }], machines, hosts }] }, working
 *           machines only, most common setup first
 *   vram    { kind: GB per GPU }, as the machines report it
 */
const fs = require("fs");
const K = require("../src/knowledge");

const GAP_MS = 800;
const INF = "/chain-api/productscience/inference/inference";
const outPath = process.argv[2];
if (!outPath) { console.error("Usage: node scripts/network-snapshot.js <out.json>"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asked = 0;

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    if (asked++) await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (body && body.code === 5) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return body;
  }
}
const coins = (list) => Number(((list || []).find((c) => /ngonka/i.test(c.denom)) || {}).amount || 0);
const WORKING = /INFERENCE|POC|POW/i;

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();
  let seed = null, cur = null;
  for (const s of k.seedNodes) {
    try { cur = await getJson(s + k.api.epochParticipants); if (cur) { seed = s; break; } } catch (_) { /* next */ }
  }
  if (!seed) throw new Error("no Gonka node answered");
  const ap = cur.active_participants || cur;
  const epoch = Number(ap.epoch_id || ap.epoch_group_id);

  const hosts = {};
  const totals = { hosts: 0, gpus: 0, gpusWorking: 0, machines: 0, kinds: {} };
  const setups = {};     // model -> "8× NVIDIA H200" -> { gpus, machines, hosts }
  const sizes = {};      // kind -> { GB: GPUs reporting it }
  for (const p of ap.participants || []) {
    const r = await getJson(`${seed}${INF}/hardware_nodes/${p.index}`).catch(() => null);
    const nodes = (r && r.nodes && r.nodes.hardware_nodes) || [];
    const h = { gpus: 0, working: 0, machines: nodes.length, kinds: {} };
    for (const n of nodes) {
      const gpus = [];
      for (const g of n.hardware || []) {
        const [name, mem] = String(g.type || "").split("|");
        const kind = name.trim() || "unknown";
        const c = Number(g.count) || 0;
        h.gpus += c; h.kinds[kind] = (h.kinds[kind] || 0) + c;
        totals.kinds[kind] = (totals.kinds[kind] || 0) + c;
        if (WORKING.test(n.status || "")) h.working += c;
        const gb = parseInt(mem, 10);
        if (gb > 0 && c > 0) { sizes[kind] = sizes[kind] || {}; sizes[kind][gb] = (sizes[kind][gb] || 0) + c; }
        if (c > 0) gpus.push({ kind, count: c });
      }
      if (!WORKING.test(n.status || "") || !gpus.length) continue;
      const key = gpus.map((g) => `${g.count}× ${g.kind}`).join(" + ");
      for (const m of n.models || []) {
        const s = ((setups[m] = setups[m] || {})[key] = setups[m][key] || { gpus, machines: 0, hosts: new Set() });
        s.machines++; s.hosts.add(p.index);
      }
    }
    hosts[p.index] = h;
    totals.hosts++; totals.gpus += h.gpus; totals.gpusWorking += h.working; totals.machines += h.machines;
  }

  const supply = await getJson(`${seed}/chain-api/cosmos/bank/v1beta1/supply/by_denom?denom=ngonka`).catch(() => null);
  const pool = await getJson(`${seed}/chain-api/cosmos/distribution/v1beta1/community_pool`).catch(() => null);
  const out = {
    asOf: new Date().toISOString(),
    epoch,
    totals,
    hosts,
    supply: supply && supply.amount ? Number(supply.amount.amount) : null,
    communityPool: pool && pool.pool ? Math.floor(coins(pool.pool)) : null,
    models: Object.fromEntries(Object.entries(setups).map(([m, byKey]) => [m,
      Object.values(byKey).map((s) => ({ gpus: s.gpus, machines: s.machines, hosts: s.hosts.size }))
        .sort((a, b) => b.machines - a.machines)])),
    // The size most GPUs of a kind report (a few report a little less).
    vram: Object.fromEntries(Object.entries(sizes).map(([kind, by]) =>
      [kind, Number(Object.entries(by).sort((a, b) => b[1] - a[1])[0][0])]))
  };
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  console.log(`epoch ${epoch}: ${totals.hosts} hosts, ${totals.gpus} GPUs (${totals.gpusWorking} on working machines), ` +
    `supply ${out.supply ? Math.round(out.supply / 1e9).toLocaleString("en") : "?"} GNK, community pool ${out.communityPool ? Math.round(out.communityPool / 1e9).toLocaleString("en") : "?"} GNK, ${asked} questions`);
})().catch((e) => { console.error("network-snapshot failed: " + e.message); process.exit(1); });
