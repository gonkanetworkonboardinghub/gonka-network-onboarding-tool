/**
 * machines-snapshot.js — every machine on the network, epoch by epoch, kept.
 *
 *   node scripts/machines-snapshot.js <folder>
 *
 * The chain tells what each machine is doing NOW: its status, the work it
 * proved at this epoch's Proof of Compute, its GPUs, its software version. It
 * does not keep that. Its record of a past epoch has every host's weight but no
 * machines (checked 2026-11-23: `ml_nodes` is empty there, and hardware_nodes
 * only ever shows the present). So "this machine has been down for six epochs"
 * can only be said by whoever wrote it down at the time. This writes it down.
 *
 * It also keeps each host's running record inside the epoch: requests answered
 * and missed, and how its weight is being confirmed. Those two decide whether a
 * host is paid for the epoch at all, and the chain resets them when it ends.
 *
 * One file per epoch, <folder>/<epoch>.json, so a run rewrites only the epoch
 * that is on (a past epoch's file never changes again), and <folder>/index.json
 * listing the epochs kept. Each run is one "reading" added to the epoch's file:
 *
 *   epoch, readings, times[]                 when each reading was taken (UTC)
 *   hosts[address]
 *     w                                      its weight this epoch
 *     live[]  [reading, requests, missed, confirmation]   one row per reading
 *     m[machine id]
 *       model, hw ("8× NVIDIA H100 80GB HBM3 | 80GB"), gpus, v (software)
 *       w                                    the work it proved this epoch
 *       seen                                 readings it was listed in
 *       st { status: readings }              e.g. { INFERENCE: 5, FAILED: 1 }
 *       last                                 its status at the newest reading
 *
 * It only reads public network data. Nothing here is about any person.
 */
const fs = require("fs");
const path = require("path");

const GAP_MS = 800;              // one question every 0.8 s: a pace the nodes accept for ever
const INF = "/chain-api/productscience/inference/inference";

/**
 * One reading folded into an epoch's file. `prev` is that epoch's file as it
 * stands (or null), `reading` is { epoch, at, hosts: { address: { w, live, machines: [...] } } }.
 * A reading of another epoch is never mixed in: it starts that epoch's file.
 */
function merge(prev, reading) {
  const file = prev && Number(prev.epoch) === Number(reading.epoch) ? prev : { epoch: Number(reading.epoch), readings: 0, times: [], hosts: {} };
  const n = file.readings;                       // this reading's number, from 0
  file.readings = n + 1;
  file.times.push(reading.at);
  for (const [address, h] of Object.entries(reading.hosts || {})) {
    const host = (file.hosts[address] = file.hosts[address] || { w: 0, live: [], m: {} });
    host.w = h.w;
    if (h.live) host.live.push([n, h.live.requests, h.live.missed, h.live.confirmation]);
    for (const x of h.machines || []) {
      const m = (host.m[x.id] = host.m[x.id] || { model: "", hw: "", gpus: 0, v: "", w: 0, seen: 0, st: {}, last: "" });
      // what a machine is can change inside an epoch (a new version, another model): the newest reading stands
      m.model = x.model || m.model; m.hw = x.hw || m.hw; m.gpus = x.gpus || m.gpus; m.v = x.v || m.v;
      m.w = Math.max(m.w, x.w || 0);             // proved once, at the epoch's Proof of Compute
      m.seen++;
      const s = x.status || "none";
      m.st[s] = (m.st[s] || 0) + 1;
      m.last = s;
    }
  }
  return file;
}

/** The index: which epochs are kept, and when the newest reading was taken. */
function indexOf(folder, epoch, at) {
  const epochs = fs.readdirSync(folder).map((f) => (/^(\d+)\.json$/.exec(f) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  return {
    asOf: at, current: epoch, epochs,
    about: "Every machine on the Gonka network, epoch by epoch: status, work proved, GPUs, software version, and each host's requests and confirmation inside the epoch. One file per epoch, <epoch>.json. Read from the public network; see scripts/machines-snapshot.js."
  };
}

async function main(folder) {
  const K = require("../src/knowledge");
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
  await K.loadRemoteManifest();
  const k = K.get();
  let seed = null, cur = null;
  for (const s of k.seedNodes) {
    try { cur = await getJson(s + k.api.epochParticipants); if (cur) { seed = s; break; } } catch (_) { /* next */ }
  }
  if (!seed) throw new Error("no Gonka node answered");
  const ap = cur.active_participants || cur;
  const epoch = Number(ap.epoch_id || ap.epoch_group_id);
  if (!(epoch > 0)) throw new Error("the node did not say which epoch is on");

  const reading = { epoch, at: new Date().toISOString(), hosts: {} };
  let machines = 0, noHardware = 0;
  for (const p of ap.participants || []) {
    // the work each machine proved, and the model it proved it on
    const proved = new Map();
    (p.models || []).forEach((model, i) => {
      for (const n of (((p.ml_nodes || [])[i] || {}).ml_nodes || [])) proved.set(n.node_id, { model, w: Number(n.poc_weight) || 0 });
    });
    const hw = await getJson(`${seed}${INF}/hardware_nodes/${p.index}`).catch(() => null);
    const nodes = (hw && hw.nodes && hw.nodes.hardware_nodes) || [];
    if (!hw) noHardware++;
    const list = nodes.map((n) => {
      const pr = proved.get(n.local_id);
      return {
        id: n.local_id, status: n.status || "", v: n.version || "",
        model: pr ? pr.model : ((n.models || [])[0] || ""), w: pr ? pr.w : 0,
        gpus: (n.hardware || []).reduce((a, g) => a + (Number(g.count) || 0), 0),
        hw: (n.hardware || []).map((g) => `${Number(g.count) || 0}× ${String(g.type || "").trim()}`).join(" + ")
      };
    });
    // a machine that proved work but is not in the host's hardware list is still a machine
    for (const [id, pr] of proved) if (!list.some((x) => x.id === id)) list.push({ id, status: "", v: "", model: pr.model, w: pr.w, gpus: 0, hw: "" });
    const part = await getJson(`${seed}${INF}/participant/${p.index}`).catch(() => null);
    const st = part && part.participant && part.participant.current_epoch_stats;
    const cr = st && st.confirmationPoCRatio;
    reading.hosts[p.index] = {
      w: Number(p.weight) || 0,
      live: st ? {
        requests: Number(st.inference_count) || 0, missed: Number(st.missed_requests) || 0,
        confirmation: cr && cr.value != null ? Number((Number(cr.value) * Math.pow(10, Number(cr.exponent) || 0)).toFixed(4)) : null
      } : null,
      machines: list
    };
    machines += list.length;
  }
  const hostCount = Object.keys(reading.hosts).length;
  if (!hostCount) throw new Error("no hosts in the epoch?");
  // One host's list failing to answer is a gap in one reading; all of them failing is a broken reading: keep the old file.
  if (noHardware === hostCount) throw new Error("no host's machine list could be read");

  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${epoch}.json`);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { /* the epoch's first reading */ }
  const next = merge(prev, reading);
  fs.writeFileSync(file, JSON.stringify(next) + "\n");
  fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify(indexOf(folder, epoch, reading.at), null, 1) + "\n");
  console.log(`machines: epoch ${epoch}, reading ${next.readings}: ${hostCount} hosts, ${machines} machines` +
    (noHardware ? ` (${noHardware} hosts' machine lists did not answer)` : "") + `; ${asked} questions`);
}

module.exports = { merge, indexOf };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) { console.error("Usage: node scripts/machines-snapshot.js <folder>"); process.exit(1); }
  main(folder).catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
}
