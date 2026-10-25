/**
 * monitor.js — what the network says about a node somebody already runs.
 *
 * Gonka Host Monitor/Vote is for a node that is already up, whoever set it up.
 * Everything here is read from the chain's public answers about an address: no
 * key, no password, no access to anybody's server. That is what lets a host
 * point the app at any node and trust it at once.
 *
 * Two halves, kept apart on purpose:
 *   - the reads (network(), host(), history()) fetch and tidy what the chain says;
 *   - summarise() turns those into the numbers the screen shows — pure, so
 *     scripts/check-monitor.js can test every figure without a network.
 *
 * Amounts stay in ngonka (1 GNK = 1,000,000,000) until the screen formats them.
 * A node's history comes from epochs.json, which the data job keeps
 * (scripts/epochs-snapshot.js): the chain no longer answers that cheaply.
 */
const fs = require("fs");
const path = require("path");
const K = require("../knowledge");

const INF = "/chain-api/productscience/inference";

// Answers normally come in well under a second: a node that does not answer at
// all should cost seconds, not half a minute.
async function getJson(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;                    // "nothing recorded" is an answer, not a failure
  if (res.status === 503 || res.status === 429) { const e = new Error("the node asked us to slow down"); e.slowDown = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}
/**
 * Ask Gonka's public nodes, at a pace they accept.
 *
 * Measured in October 2026: a node answers about twenty questions in a burst
 * from one address and then refuses (HTTP 503) until it has had a rest, while
 * one every 0.7 seconds goes on for ever. A screen that fired its fifty
 * questions together got refusals and took half a minute. So every question
 * waits for a turn: each node has an allowance that starts at ALLOWANCE and
 * refills at PER_SECOND, and a refusal is answered by waiting, not by asking
 * again at once.
 *
 * The nodes are not equal either: node2 answered most questions but failed
 * (HTTP 500) on every host's past results and on the reward estimate, node1
 * answered everything, node3 did not answer at all. So each question goes to
 * whichever node has the most allowance left among those not known to fail
 * that kind of question, which spreads a read over the nodes; a node that
 * fails a kind is left alone for that kind for a while, one that cannot be
 * reached is left alone altogether, and a merely slow one is joined by the
 * next after a moment.
 */
const ALLOWANCE = 15;
const PER_SECOND = 1.3;
const SLOW_MS = 2500;
const AVOID_KIND_MS = 10 * 60 * 1000;
const AVOID_NODE_MS = 3 * 60 * 1000;
const pace = {};                 // node -> { left, at }
const failed = {};               // "node|kind" or "node|*" -> until when to leave it alone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function allowance(node) {
  const p = pace[node] || (pace[node] = { left: ALLOWANCE, at: Date.now() });
  const now = Date.now();
  p.left = Math.min(ALLOWANCE, p.left + (now - p.at) / 1000 * PER_SECOND);
  p.at = now;
  return p;
}
async function turn(node) {
  for (;;) {
    const p = allowance(node);
    if (p.left >= 1) { p.left -= 1; return; }
    await sleep(Math.ceil((1 - p.left) / PER_SECOND * 1000));
  }
}
async function paced(node, path, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    await turn(node);
    try { return await getJson(node + path, timeoutMs); }
    catch (e) {
      if (!e.slowDown || attempt >= 2) throw e;
      allowance(node).left = 0;                          // told to slow down: start the allowance again
      await sleep(2000 * (attempt + 1));
    }
  }
}
function ask(seeds, path, timeoutMs) {
  const kind = path.replace(/^\/chain-api\/productscience\/inference\//, "").split("/").slice(0, 2).join("/").replace(/\?.*$/, "");
  const now = Date.now();
  const avoid = (n) => (failed[n + "|" + kind] || 0) > now || (failed[n + "|*"] || 0) > now;
  const fit = seeds.filter((n) => !avoid(n));
  // Most allowance first; the ones to avoid stay as a last resort.
  const order = [...fit.sort((a, b) => allowance(b).left - allowance(a).left), ...seeds.filter(avoid)];
  return new Promise((resolve, reject) => {
    let done = false, pending = 0, next = 0, last = null, timer = null, refusals = 0;
    const start = () => {
      if (done || next >= order.length) return;
      const node = order[next++];
      pending++;
      paced(node, path, timeoutMs).then((answer) => {
        pending--;
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(answer);
      }, (e) => {
        pending--; last = e;
        // An HTTP error is about this kind of question; anything else means the node cannot be reached.
        failed[node + "|" + (/^HTTP \d/.test(String(e.message)) ? kind : "*")] = Date.now() + (/^HTTP \d/.test(String(e.message)) ? AVOID_KIND_MS : AVOID_NODE_MS);
        if (done) return;
        // Two nodes refusing the same question is the answer: the question itself
        // is refused (since mid-October 2026 the nodes cap what one may cost).
        if (/^HTTP \d/.test(String(e.message)) && ++refusals >= 2) { done = true; clearTimeout(timer); reject(e); return; }
        if (next < order.length) { clearTimeout(timer); start(); }
        else if (pending === 0) { done = true; reject(last || new Error("no Gonka node answered")); }
      });
      if (next < order.length) timer = setTimeout(start, SLOW_MS);
    };
    if (!order.length) reject(new Error("no Gonka node to ask"));
    else start();
  });
}
/** A read that may fail without sinking everything else on the screen. */
const soft = (p) => p.then((v) => v, () => undefined);
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const coins = (list) => num(((list || []).find((c) => /ngonka/i.test(c.denom)) || {}).amount);

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

let blockPace = { sec: 0, at: 0 };
/** Where the network is in its epoch, and how fast blocks come. */
async function epochNow(seeds) {
  const k = K.get();
  const [j, tip] = await Promise.all([ask(seeds, k.api.latestEpoch), ask(seeds, "/chain-rpc/block")]);
  const height = num(tip.result.block.header.height);
  const tNow = Date.parse(tip.result.block.header.time);
  // How fast blocks come changes little: measured over 5,000 blocks, kept for half an hour.
  if (!blockPace.sec || Date.now() - blockPace.at > 30 * 60 * 1000) {
    const back = Math.max(1, height - 5000);
    const old = await ask(seeds, "/chain-rpc/block?height=" + back);
    blockPace = { sec: (tNow - Date.parse(old.result.block.header.time)) / 1000 / (height - back), at: Date.now() };
  }
  const secPerBlock = blockPace.sec;
  const st = j.epoch_stages || {};
  return {
    index: num(st.epoch_index || (j.latest_epoch || {}).index),
    phase: j.phase || "",
    confirmationPocActive: !!j.is_confirmation_poc_active,
    height, secPerBlock,
    pocStart: num(st.poc_start), nextPocStart: num(st.next_poc_start),
    epochBlocks: num((j.epoch_params || {}).epoch_length),
    // The block where hosts claim the previous epoch's reward, and the next one.
    claimMoney: num(st.claim_money), nextClaimMoney: num((j.next_epoch_stages || {}).claim_money)
  };
}

/** Everyone taking part in the current epoch, and anyone thrown out of it. */
async function members(seeds) {
  const k = K.get();
  const cur = await ask(seeds, k.api.epochParticipants, 40000);
  const ap = (cur && cur.active_participants) || cur || {};
  const epoch = num(ap.epoch_id || ap.epoch_group_id);
  const hosts = (ap.participants || []).map((p) => ({
    address: p.index,
    weight: num(p.weight),
    models: p.models || [],
    url: p.inference_url || "",
    nodes: (p.ml_nodes || []).flatMap((g) => (g.ml_nodes || [])).map((n) => ({ id: n.node_id, pocWeight: num(n.poc_weight) })),
    votingPower: (p.voting_powers || []).reduce((a, v) => a + num(v.voting_power), 0)
  }));
  const ex = await soft(ask(seeds, `${INF}/inference/excluded_participants/${epoch}`));
  const excluded = ((ex && ex.items) || []).map((x) => ({ address: x.address, reason: x.reason || "", height: num(x.exclusion_block_height) }));
  return { epoch, hosts, excluded };
}

/**
 * Every host's results for the recent epochs, as one file.
 *
 * The same GitHub job that publishes the website's numbers keeps it
 * (scripts/epochs-snapshot.js): it reads each epoch from the chain once, at a
 * pace the node accepts, so the app does not have to ask thirty questions to
 * draw one chart. Kept in memory for ten minutes. null when it cannot be had.
 */
let archive = { at: 0, byEpoch: null };
async function epochArchive() {
  const url = K.get().epochsUrl;
  if (!url) return null;
  if (archive.byEpoch && Date.now() - archive.at < 10 * 60 * 1000) return archive.byEpoch;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return archive.byEpoch;
    archive = { at: Date.now(), byEpoch: unpackEpochs(await res.json()) };
  } catch (_) { /* keep whatever was read before */ }
  return archive.byEpoch;
}
/** The file's compact rows back into the rows the screen works from. */
function unpackEpochs(file) {
  const hosts = (file && file.hosts) || [];
  const out = {};
  for (const e of (file && file.epochs) || []) {
    out[e.e] = (e.r || []).map((r) => ({
      address: hosts[r[0]], rewarded: num(r[1]), earned: num(r[2]), requests: num(r[3]), missed: num(r[4]),
      validated: num(r[5]), invalidated: num(r[6]), claimed: !!r[7], burned: 0
    })).filter((r) => r.address);
  }
  return out;
}

/**
 * The last `count` finished epochs, oldest first: [{ epoch, rows }], with rows
 * null for an epoch the prepared file does not have yet.
 *
 * Only from the prepared file. The chain used to answer "every host's results
 * for this epoch" in one question; from about 13 October 2026 the public nodes
 * cap what a question may cost and refuse that one, and asking each host in
 * turn is thirty questions an epoch — fine for the data job, too many for a
 * screen. The job runs several times a day, so the newest epoch can be missing
 * for a few hours; it shows as "not collected yet".
 */
async function history(seeds, currentEpoch, count) {
  const kept = (await epochArchive()) || {};
  const out = [];
  for (let e = Math.max(1, currentEpoch - count); e <= currentEpoch - 1; e++) out.push({ epoch: e, rows: kept[e] || null });
  return out;
}

/** Everything the chain holds about one address. Each part may be missing. */
async function host(seeds, address) {
  const q = (p) => soft(ask(seeds, p));
  const [record, hardware, delegation, maintenance, credit, collateral, unbonding, balance, allowances, recipients, estimate] = await Promise.all([
    q(`${INF}/inference/participant/${address}`),
    q(`${INF}/inference/hardware_nodes/${address}`),
    q(`${INF}/inference/poc_delegation/${address}`),
    q(`${INF}/inference/maintenance_status/${address}`),
    q(`${INF}/inference/maintenance_credit/${address}`),
    q(`${INF}/collateral/collateral/${address}`),
    q(`${INF}/collateral/unbonding/${address}`),
    q(`/chain-api/cosmos/bank/v1beta1/balances/${address}`),
    q(`/chain-api/cosmos/feegrant/v1beta1/issued/${address}`),
    q(`${INF}/inference/list_claim_recipients/${address}`),
    q(`${INF}/inference/estimate_bitcoin_reward/${address}`)   // refused ("out of gas") since mid-October 2026; shown only if it answers
  ]);
  // Rewards can be paid to another address; that is where the vesting lives.
  const entries = ((recipients && recipients.entries) || []).slice().sort((a, b) => num(a.epoch) - num(b.epoch));
  const recipient = entries.length ? entries[entries.length - 1].recipient : address;
  const [schedule, recipientBalance] = await Promise.all([
    q(`${INF}/streamvesting/vesting_schedule/${recipient}`),
    recipient === address ? Promise.resolve(balance) : q(`/chain-api/cosmos/bank/v1beta1/balances/${recipient}`)
  ]);
  return { address, record, hardware, delegation, maintenance, credit, collateral, unbonding, balance, allowances, recipient, schedule, recipientBalance, estimate };
}

/* ------------------------------------------------------------------ */
/* The numbers the screen shows                                        */
/* ------------------------------------------------------------------ */

const median = (list) => {
  const a = list.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
/** 1 = best. Ties share the better place. null when the address is not in the list. */
function place(rows, key, address) {
  const mine = rows.find((r) => r.address === address);
  if (!mine) return null;
  return { rank: rows.filter((r) => r[key] > mine[key]).length + 1, of: rows.length };
}
const share = (part, whole) => (whole > 0 ? part / whole : 0);
/** Of the requests a host was given, the part it did not answer. */
const missedShare = (r) => share(r.missed, r.requests + r.missed);
/** Of its answers that were checked, the part judged wrong. */
const invalidShare = (r) => share(r.invalidated, r.validated + r.invalidated);

/** One epoch's results for one host, with where it stood among the others. */
function epochLine(epoch, rows, address) {
  if (!rows) return { epoch, took: false, unknown: true, hosts: 0 };
  const mine = rows.find((r) => r.address === address);
  if (!mine) return { epoch, took: false, hosts: rows.length };
  const total = rows.reduce((a, r) => a + r.rewarded, 0);
  return {
    epoch, took: true, hosts: rows.length,
    reward: mine.rewarded, work: mine.earned, claimed: mine.claimed,
    requests: mine.requests, missed: mine.missed, validated: mine.validated, invalidated: mine.invalidated,
    missedShare: missedShare(mine), invalidShare: invalidShare(mine),
    rewardShare: share(mine.rewarded, total),
    rewardPlace: place(rows, "rewarded", address),
    typicalMissedShare: median(rows.map(missedShare)),
    typicalInvalidShare: median(rows.filter((r) => r.validated + r.invalidated > 0).map(invalidShare)),
    typicalReward: median(rows.map((r) => r.rewarded))
  };
}

function summarise({ address, now, mem, hist, raw }) {
  const me = mem.hosts.find((h) => h.address === address) || null;
  const out = mem.excluded.find((x) => x.address === address) || null;
  const totalWeight = mem.hosts.reduce((a, h) => a + h.weight, 0);
  const rec = (raw.record && raw.record.participant) || null;
  const stats = (rec && rec.current_epoch_stats) || {};
  const dec = (d) => (d && d.value !== undefined ? num(d.value) * Math.pow(10, num(d.exponent)) : null);

  const lines = hist.map((h) => epochLine(h.epoch, h.rows, address));
  const took = lines.filter((l) => l.took);
  const last = took.length ? took[took.length - 1] : null;

  const nodes = (((raw.hardware || {}).nodes || {}).hardware_nodes || []).map((n) => ({
    id: n.local_id, status: n.status || "", models: n.models || [], version: n.version || "",
    gpus: (n.hardware || []).map((g) => ({ type: String(g.type || "").split("|")[0].trim(), memory: (String(g.type || "").split("|")[1] || "").trim(), count: num(g.count) })),
    pocWeight: me ? ((me.nodes.find((x) => x.id === n.local_id) || {}).pocWeight || 0) : 0
  }));
  const gpuCount = nodes.reduce((a, n) => a + n.gpus.reduce((b, g) => b + g.count, 0), 0);
  const gpuKinds = {};
  for (const n of nodes) for (const g of n.gpus) gpuKinds[g.type] = (gpuKinds[g.type] || 0) + g.count;

  // What is left of the allowance the node's own key may spend on fees.
  const allowance = ((raw.allowances && raw.allowances.allowances) || []).map((a) => ({
    grantee: a.grantee,
    left: coins((a.allowance || {}).spend_limit),
    limited: Array.isArray((a.allowance || {}).spend_limit) && (a.allowance || {}).spend_limit.length > 0,
    expires: (a.allowance || {}).expiration || null
  })).sort((a, b) => b.left - a.left)[0] || null;

  const stream = (((raw.schedule || {}).vesting_schedule || {}).epoch_amounts || []).map((e) => coins(e.coins));
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  return {
    address,
    epoch: {
      index: now.index, phase: now.phase, height: now.height,
      blocksToNextPoc: Math.max(0, now.nextPocStart - now.height),
      secondsToNextPoc: Math.max(0, (now.nextPocStart - now.height) * now.secPerBlock),
      progress: now.nextPocStart > now.pocStart ? Math.min(1, Math.max(0, (now.height - now.pocStart) / (now.nextPocStart - now.pocStart))) : 0,
      hours: now.epochBlocks * now.secPerBlock / 3600,
      hosts: mem.hosts.length
    },
    standing: {
      known: !!rec,
      inEpoch: !!me,
      excluded: out ? { reason: out.reason, height: out.height } : null,
      status: rec ? String(rec.status || "") : "",
      weight: me ? me.weight : 0,
      share: me ? share(me.weight, totalWeight) : 0,
      place: me ? place(mem.hosts, "weight", address) : null,
      models: me ? me.models : [],
      epochsCompleted: rec ? num(rec.epochs_completed) : 0,
      joined: rec && num(rec.join_time) ? new Date(num(rec.join_time)).toISOString() : null,
      url: rec ? rec.inference_url || "" : "",
      confirmationRatio: dec(stats.confirmationPoCRatio)
    },
    now: {                                           // this epoch so far, as the node's own record has it
      requests: num(stats.inference_count), missed: num(stats.missed_requests),
      validated: num(stats.validated_inferences), invalidated: num(stats.invalidated_inferences),
      estimate: num((((raw.estimate || {}).settle_amount) || {}).reward_coins)
    },
    last,
    history: lines,
    totals: { epochs: took.length, of: lines.length, unknown: lines.filter((l) => l.unknown).length, reward: sum(took.map((l) => l.reward)), requests: sum(took.map((l) => l.requests)) },
    attention: [],
    hardware: { nodes, gpuCount, gpuKinds, working: nodes.filter((n) => /INFERENCE|POC|POW/i.test(n.status)).length },
    poc: {
      delegations: ((raw.delegation || {}).delegations || []).map((d) => ({ model: d.model_id, to: d.delegate_to })),
      refusals: ((raw.delegation || {}).refusals || []).map((d) => ({ model: d.model_id })),
      intents: ((raw.delegation || {}).intents || []).map((d) => ({ model: d.model_id }))
    },
    maintenance: {
      credit: num((raw.credit || {}).credit_blocks),
      active: !!((raw.maintenance || {}).active_reservation),
      scheduled: (raw.maintenance || {}).scheduled_reservation || null
    },
    money: {
      balance: coins((raw.balance || {}).balances),
      collateral: num(((raw.collateral || {}).amount || {}).amount),
      unbonding: ((raw.unbonding || {}).unbondings || []).map((u) => ({ amount: num((u.amount || {}).amount), epoch: num(u.completion_epoch) })),
      allowance,
      recipient: raw.recipient,
      paidElsewhere: raw.recipient !== address,
      recipientBalance: coins((raw.recipientBalance || {}).balances),
      vesting: { total: sum(stream), epochs: stream.length, next: stream.slice(0, 60), next7: sum(stream.slice(0, 7)), next30: sum(stream.slice(0, 30)) }
    }
  };
}

/**
 * What deserves a look, worst first. Only things the network's own answers
 * show; each is a code and its figures, and the screen writes the sentence.
 * "Clearly more than typical" means over one and a half times the middle host
 * and more than one point above it, so ordinary noise never raises a flag.
 */
const clearlyMore = (mine, typical) => typical !== null && typical !== undefined && mine > typical * 1.5 && mine - typical > 0.01;
function attention(v) {
  const out = [];
  const add = (level, code, data = {}) => out.push({ level, code, ...data });
  const st = v.standing, l = v.last, m = v.money;
  if (!st.known) return out;
  if (st.excluded) add("bad", "excluded", { reason: st.excluded.reason });
  else if (!st.inEpoch) add("bad", "not-in-epoch");
  const down = v.hardware.nodes.filter((n) => !/INFERENCE|POC|POW/i.test(n.status));
  if (down.length) add(st.inEpoch ? "warn" : "bad", "machines-down", { machines: down.map((n) => ({ id: n.id, status: n.status })), of: v.hardware.nodes.length });
  if (!m.allowance) add("bad", "no-allowance");
  else if (m.allowance.limited && m.allowance.left < 1e9) add("warn", "allowance-low", { left: m.allowance.left });
  if (m.balance < 1e8) add("warn", "wallet-low", { balance: m.balance });
  if (st.inEpoch && st.confirmationRatio !== null && st.confirmationRatio < 1) add("warn", "confirmation", { ratio: st.confirmationRatio });
  if (l) {
    if (l.reward === 0) add("warn", "no-reward", { epoch: l.epoch });
    if (clearlyMore(l.missedShare, l.typicalMissedShare)) add("warn", "missed", { epoch: l.epoch, mine: l.missedShare, typical: l.typicalMissedShare });
    if (l.validated + l.invalidated > 0 && clearlyMore(l.invalidShare, l.typicalInvalidShare)) add("warn", "judged-wrong", { epoch: l.epoch, mine: l.invalidShare, typical: l.typicalInvalidShare });
  }
  const rank = { bad: 0, warn: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** The whole picture for one address. */
async function overview(seeds, address, { epochs = 30 } = {}) {
  const [now, mem, raw] = await Promise.all([epochNow(seeds), members(seeds), host(seeds, address)]);
  const hist = await history(seeds, mem.epoch || now.index, epochs);
  const view = summarise({ address, now, mem, hist, raw });
  view.attention = attention(view);
  return view;
}

/**
 * Each host's GPUs and the network's totals, as one file kept by the data job
 * (scripts/network-snapshot.js): the GPUs are only told host by host. Kept in
 * memory for ten minutes. null when it cannot be had.
 */
let netFile = { at: 0, data: null };
async function networkFile() {
  const url = K.get().networkUrl;
  if (!url) return null;
  if (netFile.data && Date.now() - netFile.at < 10 * 60 * 1000) return netFile.data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) netFile = { at: Date.now(), data: await res.json() };
  } catch (_) { /* keep whatever was read before */ }
  return netFile.data;
}

/**
 * What the network's working machines run each model on, and how much memory
 * each kind of GPU has, as network.json carries them (scripts/network-snapshot.js).
 * Host Setup's first step shows them. Null when the file has neither yet.
 */
async function hardwareSetups() {
  const f = await networkFile();
  if (!f || (!f.models && !f.vram)) return null;
  return { asOf: f.asOf || null, models: f.models || {}, vram: f.vram || {} };
}

/**
 * The network page: where the epoch is, who is in it, what they run, what was
 * paid out, what exists, and how all of it moved over the recent epochs.
 */
async function networkOverview(seeds, { epochs = 180 } = {}) {
  const [now, mem, file, kept] = await Promise.all([epochNow(seeds), members(seeds), networkFile(), epochArchive()]);
  const byEpoch = kept || {};
  const totalWeight = mem.hosts.reduce((a, h) => a + h.weight, 0);
  const finished = Object.keys(byEpoch).map(Number).filter((e) => e < mem.epoch).sort((a, b) => a - b);
  const lastEpoch = finished.length ? finished[finished.length - 1] : null;
  const lastRows = lastEpoch ? byEpoch[lastEpoch] : [];
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // The past, one entry an epoch: how many hosts took part and what was paid.
  const past = finished.slice(-epochs).map((e) => ({ epoch: e, hosts: byEpoch[e].length, rewards: sum(byEpoch[e].map((r) => r.rewarded)) }));

  // Everyone in the current epoch, with what they run and how they did last epoch.
  const files = (file && file.hosts) || {};
  const hosts = mem.hosts.map((h) => {
    const g = files[h.address] || null;
    const last = lastRows.find((r) => r.address === h.address) || null;
    return {
      address: h.address,
      weight: h.weight,
      share: share(h.weight, totalWeight),
      models: h.models,
      gpus: g ? g.gpus : null,
      gpusWorking: g ? g.working : null,
      kinds: g ? g.kinds : null,
      lastReward: last ? last.rewarded : null,
      missedShare: last ? missedShare(last) : null,
      invalidShare: last && last.validated + last.invalidated > 0 ? invalidShare(last) : null
    };
  }).sort((a, b) => b.weight - a.weight);
  const out = new Set(mem.excluded.map((x) => x.address));

  // Which models the hosts serve, by how many hosts.
  const models = {};
  for (const h of mem.hosts) for (const m of h.models) models[m] = (models[m] || 0) + 1;

  const totals = (file && file.totals) || null;
  const lastRewards = lastRows.length ? sum(lastRows.map((r) => r.rewarded)) : null;
  return {
    epoch: {
      index: now.index, phase: now.phase,
      secondsToNextPoc: Math.max(0, (now.nextPocStart - now.height) * now.secPerBlock),
      progress: now.nextPocStart > now.pocStart ? Math.min(1, Math.max(0, (now.height - now.pocStart) / (now.nextPocStart - now.pocStart))) : 0,
      hours: now.epochBlocks * now.secPerBlock / 3600
    },
    hosts: hosts.map((h) => ({ ...h, excluded: out.has(h.address) })),
    excluded: mem.excluded,
    totalWeight,
    gpus: totals ? { total: totals.gpus, working: totals.gpusWorking, machines: totals.machines, kinds: totals.kinds, countedAt: file.asOf, epoch: file.epoch } : null,
    models: Object.entries(models).map(([model, n]) => ({ model, hosts: n })).sort((a, b) => b.hosts - a.hosts),
    last: lastEpoch ? { epoch: lastEpoch, rewards: lastRewards, hosts: lastRows.length, perGpu: totals && totals.gpus ? lastRewards / totals.gpus : null } : null,
    supply: file ? file.supply : null,
    communityPool: file ? file.communityPool : null,
    past
  };
}

/** Who is on the network right now — to pick a node from, and to compare with. */
async function network(seeds) {
  const mem = await members(seeds);
  const total = mem.hosts.reduce((a, h) => a + h.weight, 0);
  return {
    epoch: mem.epoch,
    hosts: mem.hosts.map((h) => ({ address: h.address, weight: h.weight, share: share(h.weight, total), models: h.models, nodes: h.nodes.length }))
      .sort((a, b) => b.weight - a.weight),
    excluded: mem.excluded
  };
}

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

/** What a proposal would do, from the kinds of message it carries. */
const WHAT_IT_DOES = {
  MsgSoftwareUpgrade: "upgrade",
  MsgUpdateParams: "settings",
  MsgCommunityPoolSpend: "spend",
  MsgExecuteContract: "contract",
  MsgInstantiateContract2: "contract",
  MsgMigrateContract: "contract",
  MsgBatchTransferWithVesting: "payout",
  MsgTransferWithVesting: "payout",
  MsgRegisterModel: "model-add",
  MsgDeleteGovernanceModel: "model-remove"
};
/** Every ngonka amount anywhere inside a proposal's messages, added up. */
function askedIn(messages) {
  let total = 0;
  (function walk(o) {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (/ngonka/i.test(String(o.denom || "")) && o.amount) total += num(o.amount);
      Object.values(o).forEach(walk);
    }
  })(messages);
  return total;
}
/**
 * What a proposal pays, and from where, read from its messages the same way
 * scripts/governance-snapshot.js does: from the community pool, into the
 * community sale, from the governance account (in coins that unlock over
 * time), or in USDT from the community sale. `ctx` names the governance
 * account, the sale contracts and the USDT token (from governance.json).
 */
function payoutsIn(messages, ctx = {}) {
  const coinsOf = (list) => (list || []).reduce((a, c) => (/^ngonka$/i.test(c.denom) ? a + num(c.amount) : a), 0);
  const sale = new Set(ctx.sale || []);
  const out = { pool: 0, toSale: 0, gov: 0, usdt: 0, recipients: 0 };
  const to = new Set();
  for (const m of messages || []) {
    const type = String(m["@type"] || "").split(".").pop();
    if (type === "MsgCommunityPoolSpend") {
      const a = coinsOf(m.amount);
      if (sale.has(m.recipient)) out.toSale += a; else { out.pool += a; to.add(m.recipient); }
    } else if (type === "MsgBatchTransferWithVesting" && (!ctx.gov || m.sender === ctx.gov)) {
      for (const o of m.outputs || []) { out.gov += coinsOf(o.amount); to.add(o.recipient); }
    } else if (type === "MsgTransferWithVesting" && (!ctx.gov || m.sender === ctx.gov || m.from_address === ctx.gov)) {
      out.gov += coinsOf(m.amount); to.add(m.recipient || m.to_address);
    } else if (type === "MsgMultiSend" && (!ctx.gov || (m.inputs || []).some((i) => i.address === ctx.gov))) {
      for (const o of m.outputs || []) { out.gov += coinsOf(o.coins); to.add(o.address); }
    } else if (type === "MsgExecuteContract" && m.msg && m.msg.withdraw_ibc && (!ctx.usdtDenom || m.msg.withdraw_ibc.denom === ctx.usdtDenom)) {
      out.usdt += num(m.msg.withdraw_ibc.amount); to.add(m.msg.withdraw_ibc.recipient);
    }
  }
  to.delete(undefined);
  out.recipients = to.size;
  return out;
}

/** governance.json from the data branch: the shared money and every payout. */
let govFile = { at: 0, data: null };
async function governanceFile() {
  const url = K.get().governanceUrl;
  if (!url) return null;
  if (govFile.data && Date.now() - govFile.at < 10 * 60 * 1000) return govFile.data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) govFile = { at: Date.now(), data: await res.json() };
  } catch (_) { /* keep whatever was read before */ }
  return govFile.data;
}

function tidyProposal(p, { totalWeight, quorum, threshold, liveTally, ctx }) {
  const t = liveTally || p.final_tally_result || {};
  const yes = num(t.yes_count), no = num(t.no_count), veto = num(t.no_with_veto_count), abstain = num(t.abstain_count);
  const voted = yes + no + veto + abstain;
  const kinds = [...new Set((p.messages || []).map((m) => String(m["@type"] || "").split(".").pop()))];
  const upgrade = (p.messages || []).find((m) => /MsgSoftwareUpgrade$/.test(String(m["@type"])));
  return {
    id: num(p.id),
    title: p.title || "",
    summary: p.summary || "",
    status: String(p.status || "").replace("PROPOSAL_STATUS_", ""),      // VOTING_PERIOD, PASSED, REJECTED, FAILED, DEPOSIT_PERIOD
    submitted: p.submit_time || null, starts: p.voting_start_time || null, ends: p.voting_end_time || null,
    proposer: p.proposer || "",
    does: [...new Set(kinds.map((k) => WHAT_IT_DOES[k] || "other"))],
    kinds,
    asked: askedIn(p.messages),
    pays: payoutsIn(p.messages, ctx),
    upgradeTo: upgrade && upgrade.plan ? { name: upgrade.plan.name, height: num(upgrade.plan.height) } : null,
    tally: { yes, no, veto, abstain, voted },
    // Of those who voted yes or no; abstaining counts toward turnout only.
    yesShare: share(yes, yes + no + veto),
    turnout: totalWeight > 0 ? share(voted, totalWeight) : null,
    quorum, threshold
  };
}

/** The newest proposals, live ones first, with how the vote stands. */
async function proposals(seeds, { limit = 25 } = {}) {
  const [list, params, mem, money] = await Promise.all([
    ask(seeds, `/chain-api/cosmos/gov/v1/proposals?pagination.reverse=true&pagination.limit=${limit}`, 40000),
    soft(ask(seeds, "/chain-api/cosmos/gov/v1/params/tallying")),
    soft(members(seeds)),
    governanceFile()
  ]);
  const ctx = money ? { gov: money.govAccount && money.govAccount.address, sale: (money.sale || []).map((s) => s.address), usdtDenom: money.usdt && money.usdt.denom } : {};
  const totalWeight = mem ? mem.hosts.reduce((a, h) => a + h.weight, 0) : 0;
  const tp = (params && params.params) || {};
  const rules = { quorum: num(tp.quorum), threshold: num(tp.threshold), veto: num(tp.veto_threshold) };
  const raw = (list && list.proposals) || [];
  const out = [];
  for (const p of raw) {
    const live = /VOTING_PERIOD/.test(String(p.status));
    const tally = live ? await soft(ask(seeds, `/chain-api/cosmos/gov/v1/proposals/${p.id}/tally`)) : null;
    out.push(tidyProposal(p, { totalWeight, quorum: rules.quorum, threshold: rules.threshold, liveTally: tally && tally.tally, ctx }));
  }
  out.sort((a, b) => (Number(b.status === "VOTING_PERIOD") - Number(a.status === "VOTING_PERIOD")) || (b.id - a.id));
  return { rules, totalWeight, hosts: mem ? mem.hosts.length : 0, proposals: out, money: money || null };
}

/** How one address voted on a proposal that is still open (the chain forgets votes afterwards). */
async function voteOf(seeds, id, address) {
  const j = await soft(ask(seeds, `/chain-api/cosmos/gov/v1/proposals/${id}/votes/${address}`));
  const opt = j && j.vote && ((j.vote.options || [])[0] || {}).option;
  return opt ? String(opt).replace("VOTE_OPTION_", "") : null;        // YES, NO, ABSTAIN, NO_WITH_VETO
}

const looksLikeAddress = (s) => /^gonka1[02-9ac-hj-np-z]{38}$/.test(String(s || "").trim());

/* The nodes a person has chosen to watch: an address and the name they gave
   it, kept in a small file on this computer and nowhere else. A node of
   their own also keeps the name of its wallet in this computer's keyring and
   how to reach its server. Never a password or a passphrase: those are asked
   for each time. */
const MAX_NODES = 50;
const tidyText = (s, max) => String(s || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
function tidyServer(s) {
  if (!s || typeof s !== "object") return null;
  if (s.mode === "local") return { mode: "local" };
  const host = tidyText(s.host, 253);
  const username = tidyText(s.username, 64);
  if (!host || !username || /\s/.test(host)) return null;
  const port = Math.round(Number(s.port) || 22);
  const auth = s.auth === "password" ? "password" : "key";
  const out = { mode: "ssh", host, port: port >= 1 && port <= 65535 ? port : 22, username, auth };
  if (auth === "key" && s.privateKeyPath) out.privateKeyPath = tidyText(s.privateKeyPath, 1024);
  return out;
}
function tidyNode(n) {
  const out = { address: String(n.address).trim(), name: tidyText(n.name, 40) };
  const wallet = tidyText(n.wallet, 64);
  if (wallet) out.wallet = wallet;
  const server = tidyServer(n.server);
  if (server) out.server = server;
  return out;
}
function loadNodes(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, "nodes.json"), "utf8"));
    return Array.isArray(list) ? list.filter((n) => n && looksLikeAddress(n.address)).slice(0, MAX_NODES).map(tidyNode) : [];
  } catch (_) { return []; }
}
function saveNodes(dir, nodes) {
  const seen = new Set();
  const clean = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const address = String((n && n.address) || "").trim();
    if (!looksLikeAddress(address) || seen.has(address)) continue;
    seen.add(address);
    clean.push(tidyNode({ ...n, address }));
    if (clean.length >= MAX_NODES) break;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "nodes.json"), JSON.stringify(clean, null, 1));
  return clean;
}

module.exports = {
  epochNow, members, history, host, overview, network, networkOverview, hardwareSetups, summarise,
  proposals, voteOf,
  looksLikeAddress, loadNodes, saveNodes,
  attention,
  _internal: { median, place, epochLine, missedShare, invalidShare, tidyProposal, askedIn, payoutsIn, ask, clearlyMore, unpackEpochs }
};
