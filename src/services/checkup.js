/**
 * checkup.js — what a host made, what it missed and to what, and what it can
 * do about it, worked out from the network's own records.
 *
 * Arithmetic only: no network, no Electron. The data job
 * (scripts/checkup-snapshot.js) feeds it the chain's records and publishes the
 * result; Gonka Host Monitor shows it on a node's page.
 *
 * HOW A HOST IS PAID, as the records show it (tested on every host and epoch
 * of epochs 435–464 on 2026-11-23: the parts add up to the unpaid GNK exactly):
 *
 *   paid = minted × (confirmation weight ÷ all hosts' weight)
 *                 × (1 − fees for the models it does not run)   [+ fees it receives]
 *
 * The confirmation weight is the host's weight as the network measured it
 * again during the epoch. So what a host misses splits three ways and no more:
 *
 *   lost      a whole epoch paid nothing
 *   cut       its weight was confirmed lower than at the epoch's start
 *   fees      for the models it does not run (5% delegated, 10% refused,
 *             15% no choice, per model)
 *
 * THE TWO LINES THAT COST A WHOLE EPOCH, as the records show them:
 *   - weight confirmed at under about half (the chain's setting is 0.5; every
 *     failure in those 30 epochs was at 43% or lower, none at 46% or higher);
 *   - more than about 10% of requests missed (every loss had 10.5% or more; a
 *     few hosts with more were still paid, so it "can" pay nothing).
 */
const LINES = {
  confirmation: 0.5,        // under this, the epoch pays nothing
  missed: 0.10,             // over this, the epoch can pay nothing
  closeConfirmation: 0.7,   // paid, yet worth saying how close it came
  closeMissed: 0.07,
  liveCloseMissed: 0.05,    // while the epoch is running, say so earlier
  minRequests: 300          // a share of very few requests says little
};

/**
 * One host in one finished epoch.
 *   r: { e, minted, all, w, cw, paid, requests, missed, reason, claimed }
 * minted and paid in GNK; all, w, cw are weights; reason is the chain's own
 * word when it left the host out of the epoch. null when the row cannot be
 * judged yet (nothing paid, not claimed, and nothing explains it).
 */
function split(r) {
  const full = r.all > 0 ? (r.w / r.all) * r.minted : 0;
  const ratio = r.w > 0 ? r.cw / r.w : null;
  const total = (r.requests || 0) + (r.missed || 0);
  const missed = total > 0 ? r.missed / total : null;
  if (!(r.paid > 0)) {
    const cause = r.reason === "failed_confirmation_poc" ? "confirmation" : missed !== null && missed > LINES.missed ? "missed" : "other";
    if (cause === "other" && !r.reason && r.claimed === false) return null;   // its pay may simply not have landed yet
    return { e: r.e, full, paid: 0, lost: full, cut: 0, fees: 0, received: 0, ratio, missed, cause, reason: r.reason || "" };
  }
  const onConfirmed = r.all > 0 ? (r.cw / r.all) * r.minted : 0;
  const fees = onConfirmed - r.paid;            // negative: it was paid more than its confirmed weight, so it received fees
  return {
    e: r.e, full, paid: r.paid, lost: 0, cut: full - onConfirmed, fees: Math.max(0, fees), received: Math.max(0, -fees), ratio, missed, cause: null,
    close: (ratio !== null && ratio < LINES.closeConfirmation) || (missed !== null && missed > LINES.closeMissed)
  };
}

/**
 * A host's days added up. `days` are split() results; `window` is the list of
 * epochs looked at, newest first; `machineDay` is what today's machine fixes
 * would add per epoch (an estimate, used only for "had it been fixed earlier").
 */
function summarize(days, window, machineDay = 0) {
  const sum = (list, k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const worth = sum(days, "full"), lost = sum(days, "lost");
  return {
    epochs: days.length,
    worth, made: sum(days, "paid"), lost,
    confirmCut: Math.max(0, sum(days, "cut")),
    feesPaid: sum(days, "fees"), feesReceived: sum(days, "received"),
    paidWorth: worth - lost,                                   // what its weight was worth in the epochs it was paid
    zero: days.filter((x) => x.cause).map((x) => ({ e: x.e, gnk: x.full, cause: x.cause, ratio: x.ratio, missed: x.missed })).sort((a, b) => b.e - a.e),
    close: days.filter((x) => x.close).map((x) => ({ e: x.e, ratio: x.ratio, missed: x.missed })).sort((a, b) => b.e - a.e),
    // Had it all been fixed 7, 14 or 30 epochs ago. Lost, cut and fees are from the records; machine fixes are
    // rough (today's gaps, as if they had been there in every epoch it took part in).
    windows: [7, 14, 30].map((k) => {
      const from = window[Math.min(k, window.length) - 1];
      const ds = days.filter((x) => x.e >= from);
      return { epochs: k, in: ds.length, made: sum(ds, "paid"), lost: sum(ds, "lost"), cut: Math.max(0, sum(ds, "cut")), fees: sum(ds, "fees"), rough: ds.length * machineDay };
    })
  };
}

/**
 * This epoch so far, from the chain's running record of the host.
 *   now: { requests, missed, confirmation, leftOut }  (confirmation null when
 *        unknown; leftOut is the chain's reason when it has already removed
 *        the host from this epoch)
 * level 3 = the epoch is already lost, 2 = over a line that costs the whole
 * epoch, 1 = close to one, 0 = clear.
 */
function live(now) {
  if (!now) return null;
  const total = (now.requests || 0) + (now.missed || 0);
  const missedShare = total > 0 ? now.missed / total : null;
  if (now.leftOut) return { total, missedShare, confirmation: now.confirmation === undefined ? null : now.confirmation, level: 3, flags: [{ code: "left-out", level: 3, reason: now.leftOut }] };
  const flags = [];
  if (missedShare !== null && total >= LINES.minRequests) {
    if (missedShare > LINES.missed) flags.push({ code: "missed", level: 2, share: missedShare, of: total });
    else if (missedShare > LINES.liveCloseMissed) flags.push({ code: "missed", level: 1, share: missedShare, of: total });
  }
  const c = now.confirmation;
  if (c !== null && c !== undefined) {
    if (c < LINES.confirmation) flags.push({ code: "confirmation", level: 2, ratio: c });
    else if (c < LINES.closeConfirmation) flags.push({ code: "confirmation", level: 1, ratio: c });
  }
  return { total, missedShare, confirmation: c === undefined ? null : c, level: flags.reduce((m, x) => Math.max(m, x.level), 0), flags };
}

/**
 * The to-do list of a host, biggest first. `host` is its record from the
 * snapshot (summary fields + moves found today); `now` is live() for it, or
 * null. Each item is a kind and its figures; the screen writes the words.
 *   size   what it is placed by: GNK per epoch
 *   key    stable across readings, so "marked as done" can be checked again
 */
function todo(host, now) {
  const list = [];
  const n = Math.max(1, host.epochs || 0);
  if (now && now.level > 0) for (const f of now.flags) list.push({ kind: "live-" + f.code, key: "live-" + f.code, size: Infinity, level: f.level, share: f.share, of: f.of, ratio: f.ratio, reason: f.reason, atStake: host.fullDay || 0 });
  if ((host.zero || []).length) {
    const by = {};
    for (const z of host.zero) by[z.cause] = (by[z.cause] || 0) + 1;
    list.push({ kind: "lost", key: "lost", size: host.lost / n, gnk: host.lost, times: host.zero.length, epochs: host.epochs, by });
  }
  if (host.paidWorth > 0 && host.confirmCut / host.paidWorth >= 0.01) {
    list.push({ kind: "confirm", key: "confirm", size: host.confirmCut / n, gnk: host.confirmCut, epochs: host.epochs, lower: host.confirmCut / host.paidWorth });
  }
  for (const m of host.moves || []) list.push({ ...m, key: m.key || m.kind });
  return list.sort((a, b) => (b.size || 0) - (a.size || 0));
}

/** What today's fixes would add per epoch: everything with a figure of its own (a model move is per GPU, so it is left out). */
const couldAdd = (host) => (host.moves || []).filter((m) => m.kind !== "model" && m.gnkDay != null).reduce((s, m) => s + m.gnkDay, 0);

/*
 * MEASURED AGAIN, machine by machine (read in Gonka's own code and on the live
 * chain, 2026-11-23: inference-chain/x/inference/module/confirmation_poc.go).
 *
 * About four times an epoch, at a block nobody knows ahead (the chain's
 * expected_confirmations_per_epoch = 4), the network makes the machines prove
 * their work again: two blocks' notice (inference_validation_cutoff), then 35
 * blocks of proving (poc_stage_duration). A sample of the machines is told to
 * keep serving inference instead, and those count in full. The host's
 * confirmed weight, which the whole epoch is paid on, is the LOWEST of those
 * readings (foldEventReadings: "min-take"). If a reading is under half of its
 * weight after the chain's tolerance, the host is left out of the epoch.
 *
 * The chain answers, per re-measurement, what every machine proved
 * (all_mlnode_weight_distributions/{trigger height}) and, for the newest one
 * only, which machines it kept serving (preserved_nodes_snapshot). It erases
 * the machine figures about an epoch later.
 *
 * A reading is not in the units of the weight at the epoch's start (the chain
 * scales each by how long the proving really ran, the same for every host), so
 * a machine is judged against the network's middle machine in the same
 * re-measurement: 1.00 = it did as the middle machine did. Under 0.909 it is
 * "low": that figure is the chain's own tolerance (pocDeviationCoeff).
 */
const TOLERANCE = 0.909;
const middleOf = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

/**
 * One host's machines in an epoch's re-measurements.
 *   all     [{ host, id, w, eff }]  every machine of the epoch on the whole network: the work it proved at the
 *           epoch's start, and eff = that work × its model's rate (its part of its host's weight)
 *   events  [{ n, height, at, raw: { "host|id": reading }, kept: ["host|id", …] | null }]   kept null = the chain no longer says
 * Each machine in each event is one of:
 *   held     it proved as the network's middle machine did (rel ≥ 0.909)
 *   low      it proved clearly less (rel is how much of the middle machine's result)
 *   kept     the network told it to keep serving inference: counted in full
 *   none     it gave no reading and was not kept serving: counted as nothing
 *   unknown  it gave no reading, and the chain no longer says whether it was kept serving
 * short = the part of the host's weight that came out low or missing in that event, as a share.
 */
function remeasured(host, all, events) {
  const mine = all.filter((x) => x.host === host && x.w > 0);
  const total = mine.reduce((s, x) => s + (x.eff || 0), 0);
  const rows = new Map(mine.map((x) => [x.id, { id: x.id, w: x.w, got: [] }]));
  const evs = [];
  for (const ev of events) {
    const ratios = [];
    for (const x of all) { const r = ev.raw[`${x.host}|${x.id}`]; if (x.w > 0 && r > 0) ratios.push(r / x.w); }
    const mid = ratios.length >= 10 ? middleOf(ratios) : null;       // too few machines measured to call a middle
    const kept = ev.kept ? new Set(ev.kept) : null;
    const e = { n: ev.n, height: ev.height, at: ev.at || null, judged: mid !== null, held: 0, low: 0, kept: 0, none: 0, unknown: 0, short: 0 };
    let short = 0;
    for (const x of mine) {
      const key = `${host}|${x.id}`, r = ev.raw[key];
      let cell;
      if (r > 0) {
        const rel = mid ? r / x.w / mid : null;
        cell = rel !== null && rel < TOLERANCE ? { state: "low", rel } : { state: "held", rel };
        if (cell.state === "low") short += (x.eff || 0) * (1 - rel);
      } else if (kept) {
        cell = { state: kept.has(key) ? "kept" : "none" };
        if (cell.state === "none") short += x.eff || 0;
      } else cell = { state: "unknown" };
      e[cell.state]++;
      rows.get(x.id).got.push(cell);
    }
    e.short = total > 0 ? short / total : 0;
    evs.push(e);
  }
  const bad = (c) => c.state === "low" || c.state === "none";
  const weight = (m) => m.got.reduce((s, c) => s + (c.state === "none" ? 1 : c.state === "low" ? 1 - c.rel : 0), 0) * m.w;
  return {
    events: evs, machines: mine.length,
    // the machines there is something to say about, the costliest first
    flagged: [...rows.values()].filter((m) => m.got.some(bad)).sort((a, b) => weight(b) - weight(a)),
    unknown: [...rows.values()].filter((m) => !m.got.some(bad) && m.got.some((c) => c.state === "unknown")).map((m) => m.id),
    worst: evs.reduce((m, e) => Math.max(m, e.short), 0)
  };
}

/*
 * BEFORE AND AFTER. The day somebody first marks a thing as done, the screen
 * keeps how the node stood (baseline): what it kept of what its weight was
 * worth over the epochs before (made ÷ worth: epochs lost, weight confirmed
 * lower and fees all show in that one figure), and the work its machines
 * proved that day, model by model. From then on every finished epoch is set
 * against the same epoch "without the changes" (since):
 *
 *   its weight without = the work its machines proved that day × this epoch's rate of each model
 *   worth without      = minted × weight without ÷ (all hosts' weight − its weight + its weight without)
 *   made without       = worth without × what it kept before
 *
 * "Made" is the chain's record. "Without the changes" is an estimate: it
 * assumes the machines would have gone on proving what they proved that day
 * and that the node would have kept what it kept before. What the changes
 * brought splits exactly in two: more weight, and keeping more of it.
 */

/** How a node stands today, to be kept when it starts changing things. `host` is its record in the Checkup's file. */
function baseline(host, window) {
  const paidWorth = host.paidWorth || 0;
  return {
    from: window.from, to: window.to, epochs: host.epochs || 0,
    keep: host.worth > 0 ? host.made / host.worth : null,
    lostTimes: (host.zero || []).length,
    cutShare: paidWorth > 0 ? host.confirmCut / paidWorth : 0,
    feeShare: paidWorth - host.confirmCut > 0 ? host.feesPaid / (paidWorth - host.confirmCut) : 0,
    work: host.work && Object.keys(host.work).length ? host.work : null
  };
}

/**
 * Every finished epoch since the start, against the same epoch without the changes.
 *   start   { epoch, base, rows? }   the epoch that was running when it started (still "before"), baseline() of that
 *           day, and the rows worked out on earlier visits: the file only holds the last 30 epochs, so the screen
 *           keeps each epoch once it has been compared and hands them back here
 *   host    its record in the file: days = [[epoch, paid, lost, cut, fees, its weight], …]
 *   epochs  { epoch: { minted, all, rates: { model: rate } } }
 * A row is [epoch, made, made without, worth, worth without, lost (0/1), cut, fees].
 * null when the start has nothing to compare with; epochs: 0 while no epoch has finished since.
 */
function since(start, host, epochs) {
  const b = start && start.base;
  if (!b || b.keep === null || b.keep === undefined) return null;
  const by = new Map();
  for (const r of (start.rows || [])) if (Array.isArray(r) && r.length >= 8 && r[0] > start.epoch) by.set(r[0], r);
  for (const x of ((host && host.days) || [])) {
    const [e, paid, lostGnk, cutGnk, feesGnk, w] = x;
    const ep = epochs && epochs[e];
    if (!(e > start.epoch) || !ep || x.length < 6) continue;
    const full = ep.all > 0 ? (w / ep.all) * ep.minted : 0;
    // the weight it would have had with the machines of the day it started
    const wWithout = b.work ? Object.entries(b.work).reduce((s, [model, raw]) => s + raw * ((ep.rates || {})[model] || 0), 0) : w;
    const all = ep.all - w + wWithout;
    const fullWithout = all > 0 ? (wWithout / all) * ep.minted : 0;
    by.set(e, [e, paid, fullWithout * b.keep, full, fullWithout, lostGnk > 0 ? 1 : 0, cutGnk, feesGnk]);   // a fresh reading replaces a kept one
  }
  const rows = [...by.values()].sort((x, y) => x[0] - y[0]);
  if (!rows.length) return { epochs: 0 };
  let made = 0, without = 0, worth = 0, worthWithout = 0, lost = 0, paidWorth = 0, cut = 0, fees = 0;
  for (const [, paid, w0, full, fullWithout, wasLost, cutGnk, feesGnk] of rows) {
    made += paid; without += w0; worth += full; worthWithout += fullWithout;
    if (wasLost) lost++; else { paidWorth += full; cut += cutGnk; fees += feesGnk; }
  }
  return {
    epochs: rows.length, from: rows[0][0], to: rows[rows.length - 1][0],
    made, without, brought: made - without,
    fromWeight: (worth - worthWithout) * b.keep,           // its machines prove more (or less) than on the day it started
    fromKeeping: made - worth * b.keep,                    // it keeps more (or less) of what its weight is worth
    weightKnown: !!b.work,
    keepBefore: b.keep, keepSince: worth > 0 ? made / worth : null,
    lostBefore: [b.lostTimes || 0, b.epochs || 0], lostSince: [lost, rows.length],
    cutBefore: b.cutShare || 0, cutSince: paidWorth > 0 ? cut / paidWorth : null,
    feeBefore: b.feeShare || 0, feeSince: paidWorth - cut > 0 ? fees / (paidWorth - cut) : null,
    rows
  };
}

module.exports = { LINES, TOLERANCE, split, summarize, live, todo, couldAdd, remeasured, baseline, since };
