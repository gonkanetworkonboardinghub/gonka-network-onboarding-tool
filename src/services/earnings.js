/**
 * earnings.js — what a given rig actually mines on Gonka right now.
 *
 * Everything here is measured, not modelled:
 *   - how much GNK the chain minted over the last full epoch (supply now vs
 *     supply one epoch ago), which is what gets shared out;
 *   - the weight each paid participant holds this epoch
 *     (current_epoch_group_data.validation_weights — these sum to total_weight,
 *     the number rewards are split by);
 *   - which GPUs are behind that weight, because every participant publishes
 *     its hardware (hardware_nodes) and each ml node's Proof of Compute weight.
 *
 * Divide those and you get GNK per GPU per day for each GPU class, observed
 * from nodes actually running — no benchmark, no promise. The configurations
 * come from the same place as the wizard's first step (the Gonka repo's
 * node-config files), so the table people see here is the table they can
 * actually deploy.
 *
 * Nothing here is a forecast: earnings fall when more weight joins, a fresh
 * node ramps up over its first epochs, and the GNK price moves. The UI says so.
 */
const netdata = require("./netdata");
const K = require("../knowledge");

const GPU_CLASSES = [
  [/B300/i, "B300"], [/B200/i, "B200"], [/H200/i, "H200"], [/H100/i, "H100"], [/A100/i, "A100"],
  // Hosts run these and are paid for them, but Gonka publishes no setup for
  // them, so they are listed with a † only. (\bH20\b leaves H200 alone.)
  [/\bH20\b/i, "H20"], [/RTX\s*5090/i, "RTX 5090"], [/RTX\s*4090/i, "RTX 4090"],
  [/RTX\s*PRO\s*6000/i, "RTX PRO 6000"], [/MI355X/i, "MI355X"], [/MI300X/i, "MI300X"]
];
/**
 * Servers are mostly rented whole, with 8 GPUs. Gonka's ML node starts as many
 * copies of a setup as the server has room for (mlnode runner.py: GPUs ÷ GPUs
 * per copy), so an 8-GPU server with a 4-GPU setup runs two and earns twice.
 */
const FULL_SERVER = 8;
/** Wrapped GNK on Ethereum — the only official one (gonka.ai/docs/FAQ). */
const WGNK = "0x972a7a92d92796a98801a8818bcf91f1648f2f68";
/** A class+model pair needs at least this many GPUs behind it to be quoted on its own. */
const MIN_SAMPLE_GPUS = 8;
/** A rig the network runs but no config covers needs at least this many GPUs behind it to be listed at all. */
const MIN_OBSERVED_GPUS = 4;
/** ...and at least this many hosts running it, since each host reports its own hardware. */
const MIN_OBSERVED_HOSTS = 2;
const CACHE_MS = 10 * 60 * 1000;

let cache = null;

const classOf = (type) => (GPU_CLASSES.find(([re]) => re.test(String(type))) || [, null])[1];

async function getJson(url, timeout = 15000, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/**
 * The GNK price, from as many independent places as answer in time; the median
 * is used, so one stale or odd source cannot swing it. Native GNK is not on a
 * central exchange: the traded asset is WGNK on Ethereum, which is what the
 * DEX sources below read.
 */
async function gnkPrice() {
  const tryOne = async (name, fn) => {
    try {
      const usd = await fn();
      return usd > 0 && isFinite(usd) ? { name, usd } : null;
    } catch (_) { return null; }
  };
  const sources = (await Promise.all([
    tryOne("Uniswap (GeckoTerminal)", async () =>
      Number((await getJson(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${WGNK}`)).data.attributes.price_usd)),
    tryOne("DEX Screener", async () => {
      const pairs = (await getJson(`https://api.dexscreener.com/latest/dex/tokens/${WGNK}`)).pairs || [];
      const best = pairs.filter((p) => p.baseToken && p.baseToken.symbol === "WGNK")
        .sort((a, b) => Number(b.liquidity && b.liquidity.usd || 0) - Number(a.liquidity && a.liquidity.usd || 0))[0];
      return Number(best && best.priceUsd);
    }),
    tryOne("CoinGecko", async () =>
      Number((await getJson("https://api.coingecko.com/api/v3/simple/price?ids=gonka&vs_currencies=usd")).gonka.usd)),
    tryOne("CoinPaprika", async () =>
      Number((await getJson("https://api.coinpaprika.com/v1/tickers/gnk-gonka")).quotes.USD.price))
    // Not here on purpose: crypto.com and Bitget publish a GNK price page but
    // have no GNK market to quote, and SafeTrade — the one order book that does
    // list it — answers 403 to anything that is not a browser. Its price reaches
    // us through CoinGecko, which tracks that listing.
  ])).filter(Boolean);

  if (!sources.length) return { usd: null, sources: [] };
  const sorted = sources.map((s) => s.usd).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const usd = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { usd, sources };
}

/** Minting, weight and the GPUs behind it, for the epoch that just paid out. */
async function chainFacts(seed) {
  const base = String(seed).replace(/\/+$/, "");
  const api = (p, height) => getJson(base + p, 20000, height ? { "x-cosmos-block-height": String(height) } : {});

  const head = Number((await api("/chain-rpc/status")).result.sync_info.latest_block_height);
  const params = (await api("/chain-api/productscience/inference/inference/params")).params;
  const epochLen = Number(params.epoch_params.epoch_length);

  // Real elapsed time, not the nominal block count: epochs drift.
  const tNow = new Date((await api("/chain-rpc/block")).result.block.header.time).getTime();
  const tPrev = new Date((await api("/chain-rpc/block?height=" + (head - epochLen))).result.block.header.time).getTime();
  const epochHours = (tNow - tPrev) / 3.6e6;

  const supplyNow = BigInt((await api("/chain-api/cosmos/bank/v1beta1/supply/by_denom?denom=ngonka")).amount.amount);
  const supplyPrev = BigInt((await api("/chain-api/cosmos/bank/v1beta1/supply/by_denom?denom=ngonka", head - epochLen)).amount.amount);
  const mintedGnk = Number(supplyNow - supplyPrev) / 1e9;

  // Rewards do not land in one piece: each epoch's award is cut into slices
  // released one per epoch, so what you mine today arrives over months.
  let vestingEpochs = Number(params.tokenomics_params && params.tokenomics_params.reward_vesting_period) || 0;
  try {
    const sv = await api("/chain-api/productscience/inference/streamvesting/params");
    vestingEpochs = Number(sv.params.reward_vesting_period) || vestingEpochs;
  } catch (_) { /* the tokenomics param above is the same number */ }

  const egd = (await api("/chain-api/productscience/inference/inference/current_epoch_group_data")).epoch_group_data;
  const totalWeight = Number(egd.total_weight);
  const memberWeight = new Map((egd.validation_weights || []).map((m) => [m.member_address, Number(m.weight)]));
  const active = (await api("/v1/epochs/current/participants")).active_participants;

  // Per node, not pooled: a few stragglers (a node that joined mid-epoch, or
  // spent part of it failing validation) drag a pooled average well below what
  // a healthy node of the same kind earns, so the median is the honest answer
  // to "what would mine get".
  const byClass = new Map();        // "H100"        -> { gpus, perGpu: [] }
  const byClassModel = new Map();   // "H100|model"  -> { gpus, perGpu: [] }
  const bump = (map, key, gpus, weight, nodeGpus, host) => {
    const cur = map.get(key) || { gpus: 0, perGpu: [], nodeGpus: [], hosts: new Set() };
    cur.gpus += gpus;
    if (gpus > 0) { cur.perGpu.push(weight / gpus); cur.nodeGpus.push(nodeGpus || gpus); cur.hosts.add(host); }
    map.set(key, cur);
  };

  for (const p of active.participants || []) {
    const paid = memberWeight.get(p.index);
    if (!paid) continue;                       // not in the paid set this epoch
    // A node can appear under several models; its PoC weight is the same node.
    const poc = new Map();
    for (const group of p.ml_nodes || []) for (const n of group.ml_nodes || []) {
      const w = Number(n.poc_weight || 0);
      if (w > 0) poc.set(n.node_id, Math.max(w, poc.get(n.node_id) || 0));
    }
    const pocTotal = [...poc.values()].reduce((a, b) => a + b, 0);
    if (!pocTotal) continue;

    let hardware = [];
    try {
      hardware = (await api("/chain-api/productscience/inference/inference/hardware_nodes/" + p.index)).nodes.hardware_nodes || [];
    } catch (_) { continue; }                  // no published hardware: it just isn't counted
    const byId = new Map(hardware.map((n) => [n.local_id, n]));

    for (const [nodeId, w] of poc) {
      const node = byId.get(nodeId);
      if (!node || !(node.hardware || []).length) continue;
      const share = (w / pocTotal) * paid;     // this node's slice of what the member is paid for
      const gpus = node.hardware.reduce((a, h) => a + Number(h.count || 0), 0) || 1;
      const models = (node.models || []).length ? node.models : [null];
      for (const h of node.hardware) {
        const cls = classOf(h.type);
        if (!cls) continue;
        const count = Number(h.count) || 0;
        const part = share * (count / gpus);
        bump(byClass, cls, count, part, gpus, p.index);
        for (const model of models) {
          if (!model) continue;
          bump(byClassModel, cls + "|" + model, count / models.length, part / models.length, gpus, p.index);
        }
      }
    }
  }

  return {
    epochIndex: Number(egd.epoch_index),
    epochHours,
    mintedGnk,
    totalWeight,
    // What the network is actually serving this epoch. A model nobody runs has
    // no observed weight, so quoting earnings for it would be a guess.
    runningModels: egd.sub_group_models || [],
    vestingEpochs,
    participants: (egd.validation_weights || []).length,
    gnkPerWeight: totalWeight ? mintedGnk / totalWeight : 0,
    rewardParams: params.bitcoin_reward_params || null,
    api,
    byClass, byClassModel
  };
}

/**
 * What a working host is paid, against its full share of an epoch's reward
 * (what was minted × its weight ÷ all the weight). A host that missed too much
 * work, or was left out, is paid nothing, and its share goes to the governance
 * account rather than to the others — so it says nothing about what a working
 * rig earns, yet it had been pulling every figure down by 10–40%, depending on
 * how many others failed that epoch. The hosts that were paid got about 90% of
 * their full share in every epoch measured (Oct 2026). The median over the hosts
 * paid in the last three finished epochs, from epochs.json and each epoch's
 * weights. Null when it cannot be read or does not add up.
 */
async function typicalShare(facts) {
  const url = K.get().epochsUrl, bp = facts.rewardParams;
  if (!url || !bp || !bp.use_bitcoin_rewards) return null;
  try {
    const file = await getJson(url, 20000);
    const hosts = file.hosts || [];
    const done = (file.epochs || [])
      .filter((e) => e.e < facts.epochIndex && (e.r || []).some((r) => Number(r[1]) > 0))
      .sort((a, b) => b.e - a.e).slice(0, 3);
    const decay = Number(bp.decay_rate && bp.decay_rate.value) * Math.pow(10, Number(bp.decay_rate && bp.decay_rate.exponent));
    const ratios = [], epochs = [];
    for (const ep of done) {
      const g = await facts.api(`/chain-api/productscience/inference/inference/epoch_group_data/${ep.e}`);
      const vws = (g && g.epoch_group_data && g.epoch_group_data.validation_weights) || [];
      const all = vws.reduce((a, v) => a + Math.max(0, Number(v.weight) || 0), 0);
      const minted = Number(bp.initial_epoch_reward) / 1e9 * Math.exp(decay * (ep.e - Number(bp.genesis_epoch)));
      if (!(all > 0) || !(minted > 0)) continue;
      const got = new Map(ep.r.map((r) => [hosts[r[0]], Number(r[1] || 0) / 1e9]));
      for (const v of vws) {
        const full = Math.max(0, Number(v.weight) || 0) / all * minted, paid = got.get(v.member_address) || 0;
        if (full > 0 && paid > 0) ratios.push(paid / full);
      }
      epochs.push(ep.e);
    }
    if (ratios.length < 5) return null;
    ratios.sort((a, b) => a - b);
    const share = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
    // Outside this range means a misread file or a rule the code here does not know.
    if (!(share > 0.3 && share < 1.05)) return null;
    return { share, epochs, hosts: ratios.length };
  } catch (_) { return null; }
}

/**
 * What the hosts were actually paid in the last finished epoch, from the
 * record of every host's rewarded coins that the data job publishes
 * (epochs.json): between 59% and 89% of what was minted in October 2026. Shown
 * as it is, and used for the figures only when typicalShare() cannot be read —
 * most of the gap is hosts paid nothing, which a working rig is not. Null when
 * the record cannot be read or does not add up.
 */
async function lastPaid(currentEpoch, mintedGnk) {
  const url = K.get().epochsUrl;
  if (!url) return null;
  try {
    const file = await getJson(url, 20000);
    const done = (file.epochs || [])
      .filter((e) => e.e < currentEpoch && (e.r || []).some((r) => Number(r[1]) > 0))
      .sort((a, b) => b.e - a.e)[0];
    if (!done) return null;
    const gnk = done.r.reduce((a, r) => a + Number(r[1] || 0), 0) / 1e9;
    const share = mintedGnk ? gnk / mintedGnk : 0;
    // A share outside this range means a half-collected epoch or a misread file.
    if (!(share > 0.2 && share < 1.05)) return null;
    return { epoch: done.e, gnk, share, hosts: done.r.filter((r) => Number(r[1]) > 0).length };
  } catch (_) { return null; }
}

/**
 * Per deployable configuration: the models and GPU counts the wizard's first
 * step offers, priced with what that class of GPU is earning today.
 */
async function estimate(seed, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const [facts, price, repoRows] = await Promise.all([
    chainFacts(seed),
    gnkPrice(),
    netdata.repoGpuConfigs().catch(() => [])
  ]);
  const repoKeys = new Set(repoRows.map((r) => r.model + "|" + r.gpuClass));
  const rows = repoRows.concat(
    (K.get().curatedConfigs || []).filter((c) => !repoKeys.has(c.model + "|" + c.gpuClass)));
  const perDay = facts.epochHours ? 24 / facts.epochHours : 0;
  // A rig's share of the network's weight now, times what is minted, times the
  // part of its full share a working host is actually paid. Without that part,
  // what all hosts were paid last epoch; without either, what was minted.
  const paid = await lastPaid(facts.epochIndex, facts.mintedGnk);
  const typical = await typicalShare(facts);
  if (typical && facts.totalWeight) facts.gnkPerWeight = facts.mintedGnk / facts.totalWeight * typical.share;
  else if (paid && facts.totalWeight) facts.gnkPerWeight = paid.gnk / facts.totalWeight;

  const median = (a) => {
    const v = [...a].sort((x, y) => x - y);
    if (!v.length) return 0;
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  };
  const weightPerGpu = (gpuClass, model) => {
    const pair = facts.byClassModel.get(gpuClass + "|" + model);
    if (pair && pair.gpus >= MIN_SAMPLE_GPUS) return { w: median(pair.perGpu), gpus: pair.gpus, basis: "model" };
    const cls = facts.byClass.get(gpuClass);
    if (cls && cls.gpus > 0) return { w: median(cls.perGpu), gpus: cls.gpus, basis: "class" };
    return null;
  };

  const running = new Set(facts.runningModels);
  const skipped = new Set();
  const seen = new Set();
  const configs = [];
  // Setups Gonka publishes for a kind of GPU no host runs now: nothing to
  // measure, so they are named rather than priced.
  const noHosts = [];
  const rig = (row, per, gpuCount, copies) => {
    const gnkPerDay = per.w * gpuCount * facts.gnkPerWeight * perDay;
    return {
      model: row.model,
      gpuClass: row.gpuClass,
      gpuCount,
      // How many copies of the setup the ML node runs on this many GPUs.
      copies,
      weight: Math.round(per.w * gpuCount),
      gnkPerDay,
      usdPerDay: price.usd ? gnkPerDay * price.usd : null,
      // What the whole rig may cost per hour before it stops paying for itself.
      breakEvenPerHour: price.usd ? (gnkPerDay * price.usd) / 24 : null,
      basis: per.basis,          // "model" = GPUs of this class running this model; "class" = all of this class
      sampleGpus: Math.round(per.gpus),
      deployable: true
    };
  };
  for (const row of rows) {
    if (!row.gpuClass || !row.model || !row.gpuCount) continue;
    if (running.size && !running.has(row.model)) { skipped.add(row.model); continue; }
    const key = `${row.model}|${row.gpuClass}|${row.gpuCount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const per = weightPerGpu(row.gpuClass, row.model);
    if (!per) { noHosts.push({ model: row.model, gpuClass: row.gpuClass, gpuCount: row.gpuCount }); continue; }
    configs.push(rig(row, per, row.gpuCount, 1));
    // The same setup on a whole server, when it divides evenly.
    if (row.gpuCount < FULL_SERVER && FULL_SERVER % row.gpuCount === 0 && !seen.has(`${row.model}|${row.gpuClass}|${FULL_SERVER}`)) {
      seen.add(`${row.model}|${row.gpuClass}|${FULL_SERVER}`);
      configs.push(rig(row, per, FULL_SERVER, FULL_SERVER / row.gpuCount));
    }
  }

  // Models the network pays for that no published configuration covers — GLM
  // is one today. People do run them, with a node-config they wrote themselves,
  // so leaving them out of the table looks like the app is hiding something.
  // They are listed exactly as the network shows them, marked not deployable.
  // Hosts declare their own hardware, so a kind only one host reports is left
  // out: one host's say-so put an RTX 4090 above an H100 (Oct 2026).
  for (const [key, v] of facts.byClassModel) {
    const [gpuClass, model] = key.split("|");
    if (!running.has(model) || v.gpus < MIN_OBSERVED_GPUS || v.hosts.size < MIN_OBSERVED_HOSTS) continue;
    if (configs.some((c) => c.model === model && c.gpuClass === gpuClass)) continue;
    const gpuCount = Math.round(median(v.nodeGpus)) || 1;
    const w = median(v.perGpu);
    const gnkPerDay = w * gpuCount * facts.gnkPerWeight * perDay;
    configs.push({
      model, gpuClass, gpuCount,
      weight: Math.round(w * gpuCount),
      gnkPerDay,
      usdPerDay: price.usd ? gnkPerDay * price.usd : null,
      breakEvenPerHour: price.usd ? (gnkPerDay * price.usd) / 24 : null,
      basis: "model",
      sampleGpus: Math.round(v.gpus),
      deployable: false
    });
  }
  configs.sort((a, b) => b.gnkPerDay - a.gnkPerDay);

  const classes = [...facts.byClass.entries()].filter(([, v]) => v.hosts.size >= MIN_OBSERVED_HOSTS).map(([id, v]) => ({
    id, gpus: v.gpus, nodes: v.perGpu.length,
    gnkPerGpuPerDay: median(v.perGpu) * facts.gnkPerWeight * perDay
  })).sort((a, b) => b.gnkPerGpuPerDay - a.gnkPerGpuPerDay);

  const data = {
    asOf: new Date().toISOString(),
    epoch: {
      index: facts.epochIndex,
      hours: facts.epochHours,
      mintedGnk: facts.mintedGnk,
      // What the hosts were paid, and in which epoch: the amount shared out.
      // "minted" when the payout record could not be read (then the figures
      // run high, by as much as the part that does not reach the hosts).
      basis: typical ? "typical" : paid ? "paid" : "minted",
      // The part of its full share a working host was paid, and from which epochs.
      typicalShare: typical ? typical.share : null,
      typicalEpochs: typical ? typical.epochs : null,
      paidGnk: paid ? paid.gnk : null,
      paidEpoch: paid ? paid.epoch : null,
      paidHosts: paid ? paid.hosts : null,
      paidShare: paid ? paid.share : null,
      totalWeight: facts.totalWeight,
      participants: facts.participants,
      gnkPerWeight: facts.gnkPerWeight,
      networkGnkPerDay: (paid ? paid.gnk : facts.mintedGnk) * perDay
    },
    price,
    contract: WGNK,
    vesting: {
      epochs: facts.vestingEpochs,
      days: facts.vestingEpochs * facts.epochHours / 24
    },
    classes,
    configs,
    // Configurations the repo offers for models the network is not serving this
    // epoch: no observed weight, so they are left out rather than guessed at.
    withoutData: [...skipped].sort(),
    // Setups Gonka publishes that no host runs now, so nothing can be measured.
    noHosts
  };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { estimate, gnkPrice, WGNK };
