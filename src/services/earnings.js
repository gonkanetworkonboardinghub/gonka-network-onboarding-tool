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
  [/B300/i, "B300"], [/B200/i, "B200"], [/H200/i, "H200"], [/H100/i, "H100"], [/A100/i, "A100"]
];
/** Wrapped GNK on Ethereum — the only official one (gonka.ai/docs/FAQ). */
const WGNK = "0x972a7a92d92796a98801a8818bcf91f1648f2f68";
/** A class+model pair needs at least this many GPUs behind it to be quoted on its own. */
const MIN_SAMPLE_GPUS = 8;
/** A rig the network runs but no config covers needs at least this many GPUs behind it to be listed at all. */
const MIN_OBSERVED_GPUS = 4;
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
  const bump = (map, key, gpus, weight, nodeGpus) => {
    const cur = map.get(key) || { gpus: 0, perGpu: [], nodeGpus: [] };
    cur.gpus += gpus;
    if (gpus > 0) { cur.perGpu.push(weight / gpus); cur.nodeGpus.push(nodeGpus || gpus); }
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
        bump(byClass, cls, count, part, gpus);
        for (const model of models) {
          if (!model) continue;
          bump(byClassModel, cls + "|" + model, count / models.length, part / models.length, gpus);
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
    byClass, byClassModel
  };
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
  for (const row of rows) {
    if (!row.gpuClass || !row.model || !row.gpuCount) continue;
    if (running.size && !running.has(row.model)) { skipped.add(row.model); continue; }
    const key = `${row.model}|${row.gpuClass}|${row.gpuCount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const per = weightPerGpu(row.gpuClass, row.model);
    if (!per) continue;
    const gnkPerDay = per.w * row.gpuCount * facts.gnkPerWeight * perDay;
    configs.push({
      model: row.model,
      gpuClass: row.gpuClass,
      gpuCount: row.gpuCount,
      weight: Math.round(per.w * row.gpuCount),
      gnkPerDay,
      usdPerDay: price.usd ? gnkPerDay * price.usd : null,
      // What the whole rig may cost per hour before it stops paying for itself.
      breakEvenPerHour: price.usd ? (gnkPerDay * price.usd) / 24 : null,
      basis: per.basis,          // "model" = GPUs of this class running this model; "class" = all of this class
      sampleGpus: Math.round(per.gpus),
      deployable: true
    });
  }

  // Models the network pays for that no published configuration covers — GLM
  // is one today. People do run them, with a node-config they wrote themselves,
  // so leaving them out of the table looks like the app is hiding something.
  // They are listed exactly as the network shows them, marked not deployable.
  for (const [key, v] of facts.byClassModel) {
    const [gpuClass, model] = key.split("|");
    if (!running.has(model) || v.gpus < MIN_OBSERVED_GPUS) continue;
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

  const classes = [...facts.byClass.entries()].map(([id, v]) => ({
    id, gpus: v.gpus, nodes: v.perGpu.length,
    gnkPerGpuPerDay: median(v.perGpu) * facts.gnkPerWeight * perDay
  })).sort((a, b) => b.gnkPerGpuPerDay - a.gnkPerGpuPerDay);

  const data = {
    asOf: new Date().toISOString(),
    epoch: {
      index: facts.epochIndex,
      hours: facts.epochHours,
      mintedGnk: facts.mintedGnk,
      totalWeight: facts.totalWeight,
      participants: facts.participants,
      gnkPerWeight: facts.gnkPerWeight,
      networkGnkPerDay: facts.mintedGnk * perDay
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
    withoutData: [...skipped].sort()
  };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { estimate, gnkPrice, WGNK };
