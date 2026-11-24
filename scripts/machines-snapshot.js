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
 * And it keeps the epoch's RE-MEASUREMENTS (added 2026-11-23). About four times
 * an epoch, at a block nobody knows ahead, the network makes the machines prove
 * their work again (the chain calls each a confirmation Proof of Compute event)
 * and pays the whole epoch on the lowest result. The chain tells what every
 * machine proved in each one, but erases it about an epoch later; and it only
 * ever tells which machines it kept serving inference (they count in full) for
 * the newest one. Both are written down here as they are seen, so "this machine
 * gave no reading in 5 of the last 40 re-measurements" can be said later.
 *
 * One file per epoch, <folder>/<epoch>.json, so a run rewrites only the epoch
 * that is on, and <folder>/index.json listing the epochs kept. A past epoch's
 * file changes once more at most: the first run of the next epoch adds the
 * re-measurements that happened after its last reading. Each run is one
 * "reading" added to the epoch's file:
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
 *   again[trigger height]                    one re-measurement
 *     n                                      which one of the epoch (0, 1, 2…)
 *     at                                     when its proving started (the block's own time, UTC)
 *     raw { address: { machine id: reading } }   what each machine proved in it
 *     kept { address: [machine ids] } | null     the machines the network kept serving; null = not caught
 *   againDone                                true once the epoch is over and nothing more can be added
 *
 * A reading is not in the units of "w": the chain scales each by how long the
 * proving really ran. See remeasured() in src/services/checkup.js for how a
 * machine is judged from these figures.
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
  foldAgain(file, reading.again);
  return file;
}

/**
 * Re-measurements folded into an epoch's file: [{ h, n, at, raw, kept }].
 * What machines proved in a finished one never changes, so it is written once;
 * the machines kept serving are added when they were not caught the first time.
 * Returns how many were new.
 */
function foldAgain(file, again) {
  let added = 0;
  for (const ev of again || []) {
    file.again = file.again || {};
    const key = String(ev.h);
    if (!file.again[key]) { file.again[key] = { n: ev.n, at: ev.at || null, raw: ev.raw || {}, kept: ev.kept || null }; added++; }
    else {
      if (!file.again[key].kept && ev.kept) file.again[key].kept = ev.kept;
      if (!file.again[key].at && ev.at) file.again[key].at = ev.at;
    }
  }
  return added;
}

/** The index: which epochs are kept, and when the newest reading was taken. */
function indexOf(folder, epoch, at) {
  const epochs = fs.readdirSync(folder).map((f) => (/^(\d+)\.json$/.exec(f) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  return {
    asOf: at, current: epoch, epochs,
    about: "Every machine on the Gonka network, epoch by epoch: status, work proved, GPUs, software version, each host's requests and confirmation inside the epoch, and what every machine proved each time the network measured again. One file per epoch, <epoch>.json. Read from the public network; see scripts/machines-snapshot.js."
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
  // The epoch's re-measurements so far: only the ones not written down yet are asked for.
  fs.mkdirSync(folder, { recursive: true });
  const fileOf = (e) => path.join(folder, `${e}.json`);
  const stored = (e) => { try { return JSON.parse(fs.readFileSync(fileOf(e), "utf8")); } catch (_) { return null; } };
  // which machines the network kept serving in the newest re-measurement (it tells no older one)
  let keptNow = null;
  try {
    const snap = await getJson(`${seed}${INF}/preserved_nodes_snapshot`);
    const sn = snap && snap.snapshot;
    if (sn && sn.episode_anchor_height) {
      const by = {};
      for (const m of sn.model_preserved_nodes || []) for (const p of m.participants || []) (by[p.participant_id] = by[p.participant_id] || []).push(...(p.node_ids || []));
      keptNow = { h: String(sn.episode_anchor_height), by };
    }
  } catch (_) { /* not caught this time */ }
  async function againOf(e, have) {
    const got = await getJson(`${seed}${INF}/confirmation_poc_events/${e}`).catch(() => null);
    const out = [];
    for (const ev of (got && got.events) || []) {
      if (ev.phase !== "CONFIRMATION_POC_COMPLETED") continue;          // still running: its figures are not final
      const h = String(ev.trigger_height), old = have && have.again && have.again[h];
      const kept = keptNow && keptNow.h === h ? keptNow.by : null;
      if (old) { if (!old.kept && kept) out.push({ h, n: Number(ev.event_sequence) || 0, kept }); continue; }
      const d = await getJson(`${seed}${INF}/all_mlnode_weight_distributions/${h}`).catch(() => null);
      if (!d || !(d.distributions || []).length) continue;               // erased already, or not answering: nothing to write
      const raw = {};
      for (const x of d.distributions) for (const w of x.weights || []) (raw[x.participant_address] = raw[x.participant_address] || {})[w.node_id] = Number(w.weight) || 0;
      const b = await getJson(`${seed}/chain-api/cosmos/base/tendermint/v1beta1/blocks/${ev.generation_start_height || h}`).catch(() => null);
      const at = b && b.block && b.block.header && b.block.header.time ? new Date(b.block.header.time).toISOString() : null;
      out.push({ h, n: Number(ev.event_sequence) || 0, at, raw, kept });
    }
    return out;
  }
  let againNew = 0, againBefore = 0;
  try {
    const have = stored(epoch);
    reading.again = await againOf(epoch, have);
    againNew = reading.again.filter((x) => x.raw).length;
  } catch (_) { /* the machines' reading still counts */ }
  // The epoch before: whatever happened after its last reading, added once.
  try {
    const before = stored(epoch - 1);
    if (before && !before.againDone) {
      againBefore = foldAgain(before, await againOf(epoch - 1, before));
      before.againDone = true;
      fs.writeFileSync(fileOf(epoch - 1), JSON.stringify(before) + "\n");
    }
  } catch (_) { /* tried again next run */ }

  const hostCount = Object.keys(reading.hosts).length;
  if (!hostCount) throw new Error("no hosts in the epoch?");
  // One host's list failing to answer is a gap in one reading; all of them failing is a broken reading: keep the old file.
  if (noHardware === hostCount) throw new Error("no host's machine list could be read");

  const file = fileOf(epoch);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { /* the epoch's first reading */ }
  const next = merge(prev, reading);
  fs.writeFileSync(file, JSON.stringify(next) + "\n");
  fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify(indexOf(folder, epoch, reading.at), null, 1) + "\n");
  console.log(`machines: epoch ${epoch}, reading ${next.readings}: ${hostCount} hosts, ${machines} machines` +
    (noHardware ? ` (${noHardware} hosts' machine lists did not answer)` : "") +
    `; re-measurements kept ${Object.keys(next.again || {}).length}` + (againNew ? ` (${againNew} new)` : "") + (againBefore ? `, ${againBefore} added to epoch ${epoch - 1}` : "") + `; ${asked} questions`);
}

module.exports = { merge, foldAgain, indexOf };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) { console.error("Usage: node scripts/machines-snapshot.js <folder>"); process.exit(1); }
  main(folder).catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
}
