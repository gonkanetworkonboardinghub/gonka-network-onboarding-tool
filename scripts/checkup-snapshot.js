/**
 * checkup-snapshot.js — every host's Checkup, worked out once for everyone.
 *
 *   node scripts/checkup-snapshot.js <store.json> <out.json>
 *
 * Gonka Host Monitor shows, on a node's page, what the host made over the
 * last 30 finished epochs, what it missed and to what, and what it can do
 * about it today. Working that out takes the chain's record of each of those
 * epochs (two questions an epoch) and every host's machine list, far more than
 * an app should ask a public node each time a page opens. So it is worked out
 * here, slowly, and the app reads the one file.
 *
 *   store.json   what the chain said about each finished epoch: every host's
 *                weight, its confirmation weight, and the chain's reason when
 *                it left a host out. A finished epoch never changes, so each
 *                is read once and kept here.
 *   out.json     the Checkup: the window looked at, the network's totals, and
 *                per host its figures and the moves found today. Figures and
 *                codes only; the screen writes the words (src/services/checkup.js
 *                has the arithmetic and says how a host is paid).
 *
 * Pay, requests and missed requests come from the epochs file the data job
 * already keeps (GNOT_EPOCHS_FILE, or the published one); each host's GPUs
 * and whether its reported hardware adds up, from the network file
 * (GNOT_NETWORK_FILE, or the published one). It only reads public data.
 *
 * WHAT IS MEASURED AND WHAT IS AN ESTIMATE. Made, lost, cut and fees are the
 * chain's records. A move's gain is an estimate: it trusts what a host reports
 * about its own hardware and assumes the other hosts stay as they are. A gain
 * is the host's share of the network with the extra work, minus its share now,
 * times the GNK minted per epoch. Moving GPUs to another model is given per
 * GPU and never as a total, because a model's rate falls as machines join it.
 */
const fs = require("fs");
const path = require("path");
const K = require("../src/knowledge");
const M = require("../src/services/monitor");
const C = require("../src/services/checkup");

const N = 30;                                  // finished epochs looked at
const KEEP = 90;                               // finished epochs kept in the store
const INF = "/chain-api/productscience/inference/inference";
const WORKING = /INFERENCE|POC|POW/i;
const [storePath, outPath] = process.argv.slice(2);
if (!outPath) { console.error("Usage: node scripts/checkup-snapshot.js <store.json> <out.json>"); process.exit(1); }

const { ask, unpackEpochs } = M._internal;
const soft = (p) => p.then((v) => v, () => null);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const short = (m) => String(m).split("/").pop();
/** The value most of a list has (the software version most of a host's machines run, the GPUs most of them have). */
const most = (a) => { const n = new Map(); for (const v of a) n.set(v, (n.get(v) || 0) + 1); return [...n.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]; };
/** Each model's rate in an epoch, from the chain's record of it (a machine counts what it proved times its model's rate). */
const ratesOf = (g) => {
  const r = {};
  for (const c of (g && g.epoch_group_data && g.epoch_group_data.confirmation_weight_scales) || []) {
    const x = c.effective_coefficient;
    if (c.model_id && x && x.value !== undefined) r[c.model_id] = Number(x.value) * Math.pow(10, Number(x.exponent) || 0);
  }
  return r;
};
/**
 * The ML node versions Gonka publishes (its public container registry, ghcr.io/gonka-ai/mlnode), and the one its own
 * setup files name today. A host reports its machines' version itself, and some report a build of their own that
 * nobody else can get: a version is only ever suggested when Gonka publishes it. null when it cannot be read.
 */
async function publishedSoftware() {
  try {
    const tok = await (await fetch("https://ghcr.io/token?scope=repository:gonka-ai/mlnode:pull", { signal: AbortSignal.timeout(15000) })).json();
    const list = await (await fetch("https://ghcr.io/v2/gonka-ai/mlnode/tags/list?n=1000", { headers: { Authorization: "Bearer " + tok.token }, signal: AbortSignal.timeout(20000) })).json();
    const tags = new Set(list.tags || []);
    if (!tags.size) return null;
    let named = "";
    try {
      const yml = await (await fetch("https://raw.githubusercontent.com/gonka-ai/gonka/main/deploy/join/docker-compose.mlnode.yml", { signal: AbortSignal.timeout(15000) })).text();
      named = (/^\s*image:\s*\$\{MLNODE_IMAGE:-ghcr\.io\/gonka-ai\/mlnode:([^@}\s]+)/m.exec(yml) || /^\s*image:\s*ghcr\.io\/gonka-ai\/mlnode:([^@\s]+)/m.exec(yml) || [])[1] || "";
    } catch (_) { /* the list of versions still counts */ }
    return { tags, named };
  } catch (_) { return null; }
}
const readJson = async (file, url) => (file ? JSON.parse(fs.readFileSync(file, "utf8")) : (await fetch(url, { signal: AbortSignal.timeout(30000) })).json());

(async () => {
  await K.loadRemoteManifest();
  const k = K.get(), seeds = k.seedNodes;
  const [file, net] = await Promise.all([readJson(process.env.GNOT_EPOCHS_FILE, k.epochsUrl), readJson(process.env.GNOT_NETWORK_FILE, k.networkUrl)]);
  const byEpoch = unpackEpochs(file);
  const params = await ask(seeds, INF + "/params");
  const bp = params.params.bitcoin_reward_params;
  const decay = Number(bp.decay_rate.value) * Math.pow(10, Number(bp.decay_rate.exponent));
  const mintedAt = (e) => Number(bp.initial_epoch_reward) / 1e9 * Math.exp(decay * (e - Number(bp.genesis_epoch)));

  /* ---- the past: the last N finished epochs. The newest paid epoch is left out: its pay may still be landing. ---- */
  const window = Object.keys(byEpoch).map(Number).filter((e) => byEpoch[e].some((r) => r.rewarded > 0)).sort((a, b) => b - a).slice(1, N + 1);
  if (!window.length) throw new Error("the epochs file has no paid epochs");
  let store = { v: 1, epochs: {} };
  try { const s = JSON.parse(fs.readFileSync(storePath, "utf8")); if (s && s.v === 1 && s.epochs) store = s; } catch (_) { /* read afresh */ }
  let read = 0;
  for (const e of window) {
    if (store.epochs[e] && store.epochs[e].rates) continue;
    const g = await ask(seeds, `${INF}/epoch_group_data/${e}`);
    if (store.epochs[e]) { store.epochs[e].rates = ratesOf(g); read++; continue; }      // read before the rates were kept
    const vws = (g && g.epoch_group_data && g.epoch_group_data.validation_weights) || [];
    if (!vws.length) throw new Error(`the chain gave no hosts for epoch ${e}`);
    const ex = await soft(ask(seeds, `${INF}/excluded_participants/${e}`));
    const reason = new Map(((ex && ex.items) || []).map((x) => [x.address, x.reason || "excluded"]));
    const hosts = {};
    for (const v of vws) {
      const w = Math.max(0, Number(v.weight) || 0);
      if (w) hosts[v.member_address] = [w, Math.max(0, Number(v.confirmation_weight) || 0), reason.get(v.member_address) || ""];
    }
    store.epochs[e] = { all: Object.values(hosts).reduce((s, h) => s + h[0], 0), hosts, rates: ratesOf(g) };
    read++;
  }
  for (const e of Object.keys(store.epochs).map(Number).sort((a, b) => b - a).slice(KEEP)) delete store.epochs[e];
  fs.mkdirSync(path.dirname(path.resolve(storePath)), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store) + "\n");

  const days = new Map();                        // address -> split() results over the window
  const netSum = { minted: 0, paid: 0, lost: {}, confirmCut: 0, feesPaid: 0, feesReceived: 0,
    rule: { highestFailedRatio: 0, lowestPaidRatio: 1, lowestMissedLost: 1, highestMissedPaid: 0 } };
  const perEpoch = new Map();                    // the network's totals epoch by epoch, every host in them (also those gone since)
  for (const e of window) {
    const rec = store.epochs[e], minted = mintedAt(e);
    netSum.minted += minted;
    const pe = { minted, paid: 0, lost: 0, cut: 0, fees: 0, received: 0 };
    perEpoch.set(e, pe);
    for (const [address, [w, cw, reason]] of Object.entries(rec.hosts)) {
      const row = byEpoch[e].find((r) => r.address === address);
      const d = C.split({ e, minted, all: rec.all, w, cw, paid: row ? row.rewarded / 1e9 : 0, requests: row ? row.requests : 0, missed: row ? row.missed : 0, reason, claimed: row ? row.claimed : false });
      if (!d) continue;                          // not settled yet: neither made nor missed
      if (!days.has(address)) days.set(address, []);
      days.get(address).push(d);
      netSum.paid += d.paid;
      pe.paid += d.paid; pe.lost += d.lost; pe.cut += Math.max(0, d.cut); pe.fees += d.fees; pe.received += d.received;
      const r = netSum.rule;
      if (d.cause) {
        const c = (netSum.lost[d.cause] = netSum.lost[d.cause] || { n: 0, gnk: 0 });
        c.n++; c.gnk += d.full;
        if (d.cause === "confirmation" && d.ratio !== null) r.highestFailedRatio = Math.max(r.highestFailedRatio, d.ratio);
        if (d.cause === "missed") r.lowestMissedLost = Math.min(r.lowestMissedLost, d.missed);
      } else {
        netSum.confirmCut += d.cut; netSum.feesPaid += d.fees; netSum.feesReceived += d.received;
        if (d.ratio !== null) r.lowestPaidRatio = Math.min(r.lowestPaidRatio, d.ratio);
        if (d.missed !== null) r.highestMissedPaid = Math.max(r.highestMissedPaid, d.missed);
      }
    }
  }

  /* ---- now: this epoch's weights, rates, choices, machines ---- */
  const cur = await ask(seeds, k.api.epochParticipants, 40000);
  const ap = cur.active_participants || cur;
  const epoch = Number(ap.epoch_id || ap.epoch_group_id);
  const ps = ap.participants || [];
  const mem = await M.members(seeds);
  const rates = mem.rates || {};
  const leftOut = new Map((mem.excluded || []).map((x) => [x.address, x.reason || "excluded"]));   // removed from this epoch already
  const cd = await M.modelChoices(seeds);
  const counted = cd.counted.map((x) => x.id);
  const totalW = ps.reduce((a, p) => a + Number(p.weight || 0), 0);
  const mintedNow = mintedAt(epoch);

  // every machine: host, id, model, GPU kind and count, work the network measured, status, software version
  const machines = [], liveNow = new Map();
  for (const p of ps) {
    const hw = await soft(ask(seeds, `${INF}/hardware_nodes/${p.index}`));
    const nodes = (hw && hw.nodes && hw.nodes.hardware_nodes) || [];
    const work = new Map();
    (p.models || []).forEach((m, i) => { for (const n of (((p.ml_nodes || [])[i] || {}).ml_nodes || [])) work.set(n.node_id, { model: m, w: Number(n.poc_weight) || 0 }); });
    for (const n of nodes) {
      const top = (n.hardware || []).slice().sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))[0];
      const gpus = (n.hardware || []).reduce((a, x) => a + (Number(x.count) || 0), 0);
      const wk = work.get(n.local_id);
      // The GPU's family where GNOT knows it (an "H100 PCIe" and an "H100 80GB HBM3" are both H100), else its own name.
      const name = top ? String(top.type).split("|")[0].replace("NVIDIA", "").trim() : "";
      const cls = k.gpuClasses.find((c) => c.match.test(name));
      machines.push({ host: p.index, id: n.local_id, status: n.status || "", version: n.version || "", gpus,
        kind: cls ? cls.id : name.replace(/^GeForce /, ""), mixed: (n.hardware || []).length > 1,
        model: wk ? wk.model : ((n.models || [])[0] || ""), w: wk ? wk.w : 0, counted: !!wk });
    }
    // this epoch so far, as the chain's running record of the host has it
    const part = await soft(ask(seeds, `${INF}/participant/${p.index}`));
    const st = part && part.participant && part.participant.current_epoch_stats;
    const cr = st && st.confirmationPoCRatio;
    if (st) liveNow.set(p.index, { requests: Number(st.inference_count) || 0, missed: Number(st.missed_requests) || 0,
      confirmation: cr && cr.value != null ? Number((Number(cr.value) * Math.pow(10, Number(cr.exponent) || 0)).toFixed(4)) : null,
      ...(leftOut.has(p.index) ? { leftOut: leftOut.get(p.index) } : {}) });
  }
  const eff = (x) => x.w * (Number(rates[x.model]) || 0);       // what the work counts for after the model's rate
  const trusted = (a) => !(net.hosts[a] && net.hosts[a].underReported);
  const clean = (x) => x.counted && x.w > 0 && x.gpus > 0 && !x.mixed && x.kind;
  const hostGroup = new Map();                   // per host, per (GPU kind, model): its machines
  for (const x of machines) if (clean(x)) {
    const key = `${x.host}|${x.kind}|${x.model}`;
    if (!hostGroup.has(key)) hostGroup.set(key, []);
    hostGroup.get(key).push(x);
  }
  const peer = {};                               // per (GPU kind, model): each host's middle machine per GPU, hosts whose hardware adds up
  for (const [key, ms] of hostGroup) {
    const [host, kind, model] = key.split("|");
    if (!trusted(host)) continue;
    (peer[`${kind}|${model}`] = peer[`${kind}|${model}`] || []).push({ host, per: med(ms.map((x) => x.w / x.gpus)), n: ms.length,
      v: most(ms.map((x) => x.version).filter(Boolean)) || "", each: most(ms.map((x) => x.gpus)) });
  }

  // Software versions: what machines of one GPU kind on one model prove per GPU on each version, across hosts
  // whose hardware adds up. This is the evidence behind "try this software": how many machines, at how many hosts.
  const soft2 = await publishedSoftware();
  // true: Gonka publishes a version by exactly this name; "family": only longer names that start with it (3.0.14 → 3.0.14-post2);
  // false: nothing like it, so a build of the host's own; null: the list could not be read.
  const isPublished = (v) => (!soft2 ? null : soft2.tags.has(v) ? true : [...soft2.tags].some((x) => x.startsWith(v + "-")) ? "family" : false);
  // WHAT CAN BE TRUSTED HERE. The network checks the work a machine proves. How many GPUs the machine has, and of
  // what kind, is what its host reports, and a host can report it wrong: a machine with more GPUs than it reports
  // looks as if each GPU did wonders. Hosts whose figures are far off are left out (network-snapshot.js marks them),
  // but a smaller misreport passes that test. So nothing here rests on one host's word: a version's figure is what
  // at least two separate hosts both reach (the lower of their middle machines), and so is the figure a host's
  // machines are compared with.
  const byVersion = {};
  for (const x of machines) if (clean(x) && x.version && trusted(x.host)) {
    const g = `${x.kind}|${short(x.model)}`;
    byVersion[g] = byVersion[g] || {};
    const v = (byVersion[g][x.version] = byVersion[g][x.version] || { per: [], byHost: new Map() });
    v.per.push(x.w / x.gpus);
    if (!v.byHost.has(x.host)) v.byHost.set(x.host, []);
    v.byHost.get(x.host).push(x.w / x.gpus);
  }
  const versionRows = (g) => Object.entries(byVersion[g] || {}).map(([version, v]) => ({
    version, machines: v.per.length, hosts: v.byHost.size, perGpu: Math.round(med(v.per)),
    // what every host on this version reaches with its middle machine; null when only one host runs it
    low: v.byHost.size >= 2 ? Math.round(Math.min(...[...v.byHost.values()].map(med))) : null,
    published: isPublished(version)
  })).sort((x, y) => y.perGpu - x.perGpu);

  const hosts = {};
  for (const p of ps) {
    const a = p.index, W = Number(p.weight || 0), share = totalW ? W / totalW : 0, fullDay = share * mintedNow;
    const nh = net.hosts[a] || {};
    const mine = machines.filter((x) => x.host === a);
    const myEff = mine.reduce((s, x) => s + (x.counted ? eff(x) : 0), 0);
    // Extra work, as GNK a day: the host's weight grows and so does the network's, so its
    // share moves from W/T to (W+d)/(T+d). d is in the host's own weight units.
    const gnkOf = (effSlice) => { if (!(myEff > 0)) return 0; const d = effSlice / myEff * W; return ((W + d) / (totalW + d) - W / totalW) * mintedNow; };
    const moves = [];

    // fees for the models it does not run
    const ch = (cd.hosts.find((h) => h.address === a) || {}).choices || {};
    const notRun = counted.filter((m) => !(p.models || []).includes(m));
    const modes = notRun.map((m) => (ch[m] || {}).mode || "none");
    const fee = modes.reduce((s, mo) => s + (cd.rates[mo] ?? cd.rates.none), 0);
    if (fee > 0) {
      const byMode = {};
      for (const mo of modes) byMode[mo] = (byMode[mo] || 0) + 1;
      // the smaller step: delegating costs less than refusing or making no choice, one transaction a model
      const cheaper = fee - (cd.rates.delegate ?? 0.05) * notRun.length;
      moves.push({ kind: "fees", gnkDay: fee * fullDay, run: (p.models || []).length, of: counted.length, rate: fee, modes: byMode, rates: cd.rates, missing: notRun.map(short),
        cheaperDay: cheaper > 1e-9 ? cheaper * fullDay : 0 });
    }

    // Machines not working. Two kinds, and only one adds weight when it comes back:
    //   - it proved no work at this epoch's Proof of Compute: it is not in the host's weight, so bringing it back adds;
    //   - it proved work and stopped since: its work is already in the weight (nothing to add), and it counts
    //     against the host when the network measures again, which is how whole epochs are lost.
    const down = mine.filter((x) => !WORKING.test(x.status));
    if (down.length) {
      const idle = down.filter((x) => !(x.counted && x.w > 0)), proved = down.length - idle.length;
      const gp = down.reduce((s, x) => s + x.gpus, 0), gpIdle = idle.reduce((s, x) => s + x.gpus, 0);
      const ok = mine.filter((x) => x.counted && x.w > 0 && x.gpus > 0);
      const perGpuEff = ok.length ? med(ok.map((x) => eff(x) / x.gpus)) : 0;
      moves.push({ kind: "down", gnkDay: !idle.length ? 0 : trusted(a) ? gnkOf(perGpuEff * gpIdle) : null, n: down.length, of: mine.length, gpus: gp, proved,
        list: down.slice(0, 8).map((x) => ({ id: x.id, status: x.status })) });
    }

    // weak machines: each against this host's own machines with the same reported hardware on the same
    // model. It compares a host with itself, so it holds even where the reported hardware does not add up.
    const same = new Map();
    for (const x of mine) if (clean(x)) {
      const key = `${x.gpus}|${x.kind}|${x.model}`;
      if (!same.has(key)) same.set(key, []);
      same.get(key).push(x);
    }
    const unevenKeys = new Set();
    for (const [key, ms] of same) {
      const [n, kind, model] = key.split("|");
      if (ms.length < 4) continue;
      const ws = ms.map((x) => x.w).sort((x, y) => y - x);
      const best = med(ws.slice(0, Math.max(1, Math.round(ws.length / 4))));   // its best machines of that kind: the middle of the top quarter
      const behind = ms.filter((x) => x.w < 0.7 * best);
      if (!behind.length) continue;
      const lost = ms.reduce((s, x) => s + Math.max(0, best - x.w), 0) * (Number(rates[model]) || 0);
      unevenKeys.add(`${kind}|${model}`);
      moves.push({ kind: "uneven", key: `uneven|${n}|${kind}|${short(model)}`, gnkDay: gnkOf(lost), machines: ms.length, behind: behind.length, each: Number(n), gpu: kind, model: short(model),
        best: Math.round(best), lowest: Math.round(ws[ws.length - 1]),
        // which ones, and whether they run other software than its best ones do
        list: behind.slice().sort((x, y) => x.w - y.w).slice(0, 8).map((x) => ({ id: x.id, w: Math.round(x.w), v: x.version || "" })),
        vBest: most(ms.filter((x) => x.w >= 0.9 * best).map((x) => x.version).filter(Boolean)) || "",
        vSlow: [...new Set(behind.map((x) => x.version).filter(Boolean))] });
    }

    if (trusted(a)) {
      for (const [key, ms] of hostGroup) {
        const [host, kind, model] = key.split("|");
        if (host !== a) continue;
        const mid = med(ms.map((x) => x.w / x.gpus));
        // the same GPUs on the same model at other hosts (not said twice where its own machines of that kind are uneven)
        const others = (peer[`${kind}|${model}`] || []).filter((o) => o.host !== a && o.n >= 2).sort((x, y) => y.per - x.per);
        const ahead = others.filter((o) => o.per > mid * 1.1);
        if (ahead.length && !unevenKeys.has(`${kind}|${model}`)) {
          // With two or more hosts ahead, the figure is what at least two of them reach (the second best), and each of
          // its machines is brought up to that. With only one ahead there is no figure: one host's report cannot be
          // checked against another's.
          const single = ahead.length < 2, ref = single ? ahead[0] : ahead[1];
          const gap = single ? 0 : ms.reduce((s, x) => s + Math.max(0, ref.per * x.gpus - x.w), 0) * (Number(rates[model]) || 0);
          const rows = versionRows(`${kind}|${short(model)}`);
          moves.push({ kind: "peer", key: `peer|${kind}|${short(model)}`, gnkDay: single ? null : gnkOf(gap), single, ahead: ahead.length,
            gpu: kind, model: short(model), less: 1 - mid / ref.per, others: others.length,
            // what can be compared from outside: work per GPU, software version, GPUs in a machine
            per: Math.round(mid), bestPer: Math.round(ref.per), bestHost: ref.host,
            v: most(ms.map((x) => x.version).filter(Boolean)) || "", bestV: ref.v || "", each: most(ms.map((x) => x.gpus)), bestEach: ref.each,
            // The evidence, and the version worth a try: one Gonka publishes, that these machines do not run, on which
            // at least two separate hosts (3 machines or more between them) each prove 10% more or better.
            table: rows.slice(0, 6),
            tryV: rows.filter((r) => r.published === true && r.hosts >= 2 && r.machines >= 3 && !ms.some((x) => x.version === r.version) && r.low > mid * 1.1).sort((x, y) => y.low - x.low)[0] || null });
        }
        // the same GPUs on another model, at this epoch's rates: per GPU, only in machines big enough for it
        const mineEff = mid * (Number(rates[model]) || 0);
        let alt = null;
        for (const m2 of counted) {
          if (m2 === model) continue;
          const ref = (peer[`${kind}|${m2}`] || []).filter((o) => o.host !== a);
          if (!ref.length) continue;
          const e2 = med(ref.map((o) => o.per)) * (Number(rates[m2]) || 0);
          // the smallest machine of this kind that runs that model anywhere: what one copy of it takes
          const need = Math.min(...machines.filter((x) => x.kind === kind && x.model === m2 && clean(x)).map((x) => x.gpus));
          if (!alt || e2 > alt.e2) alt = { m2, e2, n: ref.length, need };
        }
        if (alt && alt.e2 > mineEff * 1.15) {
          const fits = ms.filter((x) => x.gpus >= alt.need).reduce((s, x) => s + x.gpus, 0);
          if (fits > 0) moves.push({ kind: "model", key: `model|${kind}|${short(model)}`, gnkDay: null, perGpuDay: gnkOf(alt.e2 - mineEff), fits, times: alt.e2 / mineEff,
            gpu: kind, from: short(model), to: short(alt.m2), hosts: alt.n, need: alt.need });
        }
      }
    }
    // The order of the list. A move with no figure (machines down at a host whose reported hardware does not add
    // up) is placed by the share of its machines that are down; that placing figure is never shown.
    for (const m of moves) m.size = m.kind === "down" ? Math.max(m.gnkDay || 0, (mine.length ? (m.gnkDay == null ? m.n : m.proved) / mine.length : 0) * fullDay)
      : m.gnkDay != null ? m.gnkDay : (m.perGpuDay || 0) * Math.min(m.fits || 0, 8);
    const machineDay = moves.filter((m) => ["down", "uneven", "peer"].includes(m.kind) && m.gnkDay != null).reduce((s, m) => s + m.gnkDay, 0);
    const sum = C.summarize(days.get(a) || [], window, machineDay);
    hosts[a] = {
      share, fullDay, weight: W,
      // its usual share of the network over those epochs (it can differ a lot from today's)
      avgShare: sum.epochs ? sum.worth / (sum.epochs * netSum.minted / window.length) : null,
      machines: mine.length, machinesDown: down.length, gpus: nh.gpus || 0, kinds: nh.kinds || {}, models: (p.models || []).map(short),
      underReported: !!nh.underReported, feeRate: fee, machineDay, live: liveNow.get(a) || null,
      // the work its machines proved this epoch, per model: what "before and after" starts from
      work: mine.reduce((o, x) => { if (x.counted && x.w > 0) o[x.model] = (o[x.model] || 0) + x.w; return o; }, {}),
      ...sum, moves,
      // epoch by epoch, oldest first, in whole GNK: [epoch, paid, lost, weight confirmed lower, fees, its weight in that epoch]
      days: (days.get(a) || []).slice().sort((x, y) => x.e - y.e).map((x) => [x.e, Math.round(x.paid), Math.round(x.lost), Math.round(Math.max(0, x.cut)), Math.round(x.fees), ((store.epochs[x.e] || {}).hosts || {})[a] ? store.epochs[x.e].hosts[a][0] : 0])
    };
  }
  // hosts that took part in the window but are not in this epoch: only what the records say they lost
  const gone = [...days.entries()].filter(([a]) => !hosts[a]).map(([a, ds]) => { const s = C.summarize(ds, window); return { address: a, epochs: s.epochs, made: s.made, lost: s.lost, times: s.zero.length }; });

  const versions = Object.keys(byVersion).map((g) => ({ gpu: g.split("|")[0], model: g.split("|")[1], rows: versionRows(g) })).filter((g) => g.rows.length > 1);

  const lostAll = Object.values(netSum.lost).reduce((s, v) => s + v.gnk, 0);
  const hit = new Set([...days.entries()].filter(([, ds]) => ds.some((x) => x.cause)).map(([a]) => a));
  const out = {
    v: 1, asOf: new Date().toISOString(), epoch, mintedNow,
    window: { from: window[window.length - 1], to: window[0], epochs: window.length },
    net: { ...netSum, lostAll,
      // epoch by epoch, oldest first, in whole GNK: [epoch, minted, paid, lost, weight confirmed lower, fees given up, fees received]
      perEpoch: [...perEpoch.entries()].sort((a, b) => a[0] - b[0]).map(([e, p]) => [e, Math.round(p.minted), Math.round(p.paid), Math.round(p.lost), Math.round(p.cut), Math.round(p.fees), Math.round(p.received)]), hostsHit: hit.size, hostsAll: days.size, hostsNow: ps.length,
      machines: machines.length, machinesDown: machines.filter((x) => !WORKING.test(x.status)).length,
      feesDay: Object.values(hosts).reduce((s, h) => s + ((h.moves.find((m) => m.kind === "fees") || {}).gnkDay || 0), 0) },
    hosts, gone, versions,
    // Gonka's own ML node software: the version its setup files name today, and whether its list of published versions was read
    software: { named: soft2 ? soft2.named : "", listed: !!soft2 },
    // each epoch of the window: GNK minted, all hosts' weight, each model's rate (for "before and after")
    epochs: Object.fromEntries(window.map((e) => [e, { minted: mintedAt(e), all: store.epochs[e].all, rates: store.epochs[e].rates || {} }]))
  };
  // The parts must add up to what was not paid, or something here is wrong.
  const gap = netSum.minted - netSum.paid - lostAll - netSum.confirmCut - netSum.feesPaid + netSum.feesReceived;
  const unsettled = [...Object.entries(store.epochs)].filter(([e]) => window.includes(Number(e))).reduce((s, [, r]) => s + Object.keys(r.hosts).length, 0) - [...days.values()].reduce((s, ds) => s + ds.length, 0);
  if (Math.abs(gap) > netSum.minted * 0.02 && !unsettled) throw new Error(`the parts do not add up: ${Math.round(gap)} GNK unexplained`);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  const f = (n) => Math.round(n).toLocaleString("en");
  console.log(`checkup: epochs ${out.window.from}–${out.window.to} (${read} read from the chain now), ${ps.length} hosts in epoch ${epoch}; ` +
    `minted ${f(netSum.minted)}, paid ${f(netSum.paid)}, lost ${f(lostAll)}, confirmed lower ${f(netSum.confirmCut)}, fees ${f(netSum.feesPaid)} given up / ${f(netSum.feesReceived)} received` +
    (unsettled ? `; ${unsettled} host-epochs not settled yet` : `; unexplained ${f(gap)}`));
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
