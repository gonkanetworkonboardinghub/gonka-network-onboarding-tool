/**
 * onboarded-snapshot.js — how many nodes and GPUs GNOT has brought into the
 * network, epoch by epoch, with the transactions as proof.
 *
 *   node scripts/onboarded-snapshot.js <previous.json> <earnings.json> <out.json>
 *
 * Every transaction GNOT signs carries the public note "Set up with GNOT vX"
 * (src/services/keys.js): the permission grant every setup sends, plus the
 * registration fallback and collateral deposits. This finds those
 * transactions on the chain, takes the participant who signed each one, and
 * checks every run which of them are in the current epoch, with how many GPUs
 * and what weight. Nothing is reported by the app itself; all of it is public
 * chain data that anyone can re-check from the transaction hashes.
 *
 * History lives in the file this writes, so each run only scans new blocks.
 * previous.json may be missing (first run); earnings.json is the file
 * scripts/earnings-snapshot.js wrote in the same run (epoch, GNK per weight).
 */
const fs = require("fs");
const path = require("path");
const K = require("../src/knowledge");
const wallet = require("../src/services/wallet");

const [prevPath, earningsPath, outPath] = process.argv.slice(2);
if (!earningsPath || !outPath) {
  console.error("Usage: node scripts/onboarded-snapshot.js <previous.json> <earnings.json> <out.json>");
  process.exit(1);
}

/** Public nodes that index transactions (searching needs it). node1 does today. */
const INDEXERS = ["http://node1.gonka.ai:8000", "http://node2.gonka.ai:8000", "http://node3.gonka.ai:8000"];
/** No tagged transaction can exist before the release that added the note. */
const START_HEIGHT = 6181000;
/** The transaction kinds GNOT signs. */
const ACTIONS = [
  "/cosmos.authz.v1beta1.MsgGrant",
  "/inference.inference.MsgSubmitNewParticipant",
  "/inference.collateral.MsgDepositCollateral"
];
const MARKER = /\bGNOT\b/;
const PAGE = 100;
const GPU_CLASSES = [[/B300/i, "B300"], [/B200/i, "B200"], [/H200/i, "H200"], [/H100/i, "H100"], [/A100/i, "A100"]];
const classOf = (type) => (GPU_CLASSES.find(([re]) => re.test(String(type))) || [, "other"])[1];

async function getJson(url, timeout = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(`${url} -> ${res.status}${body && body.message ? ": " + body.message : ""}`);
  return body;
}

/** The first node whose transaction search is switched on. */
async function findIndexer() {
  for (const base of INDEXERS) {
    try {
      await getJson(`${base}/chain-api/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`message.action='${ACTIONS[0]}'`)}&limit=1`);
      return base;
    } catch (_) { /* indexing off here; try the next */ }
  }
  throw new Error("no public node with transaction search answered");
}

/** Every tagged transaction of one kind in (from, to]. */
async function scan(base, action, from, to) {
  const found = [];
  const query = `message.action='${action}' AND tx.height>${from} AND tx.height<=${to}`;
  for (let page = 1; ; page++) {
    const j = await getJson(`${base}/chain-api/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query)}` +
      `&limit=${PAGE}&page=${page}&order_by=ORDER_BY_ASC`);
    const list = j.tx_responses || [];
    for (const t of list) {
      const memo = (t.tx && t.tx.body && t.tx.body.memo) || "";
      if (t.code !== 0 || !MARKER.test(memo)) continue;
      // The signer is the participant's own (cold) key for all three kinds.
      const pk = t.tx.auth_info.signer_infos[0].public_key.key;
      const address = wallet.addressOf(Buffer.from(pk, "base64"));
      found.push({ address, tx: t.txhash, height: Number(t.height), time: t.timestamp, memo, kind: action.split(".").pop() });
    }
    if (list.length < PAGE) break;
  }
  return found;
}

(async () => {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch (_) { /* first run */ }
  const earnings = JSON.parse(fs.readFileSync(earningsPath, "utf8"));

  const indexer = await findIndexer();
  const head = Number((await getJson(`${indexer}/chain-rpc/status`)).result.sync_info.latest_block_height);
  const from = Math.max(START_HEIGHT, Number(prev.scannedToHeight) || 0);

  // 1. New tagged transactions since the last run.
  const nodes = new Map((prev.nodes || []).map((n) => [n.address, n]));
  let newTx = 0;
  for (const action of ACTIONS) {
    for (const hit of await scan(indexer, action, from, head)) {
      newTx++;
      const known = nodes.get(hit.address);
      if (!known) {
        nodes.set(hit.address, { address: hit.address, since: hit, txCount: 1 });
      } else {
        known.txCount = (known.txCount || 1) + 1;
        if (hit.height < known.since.height) known.since = hit;
      }
    }
  }

  // 2. Where each of them stands in the current epoch (public chain state).
  const seed = K.get().seedNodes[0];
  const egd = (await getJson(`${seed}/chain-api/productscience/inference/inference/current_epoch_group_data`)).epoch_group_data;
  const weightOf = new Map((egd.validation_weights || []).map((m) => [m.member_address, Number(m.weight)]));
  const gnkPerWeight = Number(earnings.epoch && earnings.epoch.gnkPerWeight) || 0;
  const perDay = earnings.epoch && earnings.epoch.hours ? 24 / earnings.epoch.hours : 0;

  for (const n of nodes.values()) {
    const weight = weightOf.get(n.address) || 0;
    const gpus = {};
    try {
      const hw = (await getJson(`${seed}/chain-api/productscience/inference/inference/hardware_nodes/${n.address}`)).nodes.hardware_nodes || [];
      for (const node of hw) for (const h of node.hardware || []) {
        const cls = classOf(h.type);
        gpus[cls] = (gpus[cls] || 0) + (Number(h.count) || 0);
      }
    } catch (_) { /* not registered yet, or no hardware published */ }
    n.activeNow = weight > 0;
    n.weight = weight;
    n.gpus = Object.values(gpus).reduce((a, b) => a + b, 0);
    n.gpuTypes = gpus;
    n.gnkPerDay = weight * gnkPerWeight * perDay;
  }

  // 3. This epoch's line in the history. Weights are fixed for the whole epoch,
  //    so re-running within it just refreshes the same line.
  const epochIndex = Number(egd.epoch_index);
  const active = [...nodes.values()].filter((n) => n.activeNow);
  const line = {
    epoch: epochIndex,
    activeNodes: active.length,
    gpus: active.reduce((a, n) => a + n.gpus, 0),
    weight: active.reduce((a, n) => a + n.weight, 0),
    gnk: active.reduce((a, n) => a + n.weight * gnkPerWeight, 0)
  };
  const epochs = (prev.epochs || []).filter((e) => e.epoch !== epochIndex).concat([line]).sort((a, b) => a.epoch - b.epoch);

  const out = {
    asOf: new Date().toISOString(),
    marker: "Set up with GNOT",
    explorer: "https://gonka.gg/transactions/",
    scannedToHeight: head,
    currentEpoch: epochIndex,
    totals: {
      nodesEver: nodes.size,
      activeNow: active.length,
      gpusNow: line.gpus,
      gnkMinedAllEpochs: epochs.reduce((a, e) => a + e.gnk, 0)
    },
    nodes: [...nodes.values()].sort((a, b) => a.since.height - b.since.height),
    epochs
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`${outPath}: ${nodes.size} nodes ever, ${active.length} active in epoch ${epochIndex} with ${line.gpus} GPUs; ` +
    `${newTx} new tagged transactions in blocks ${from + 1}-${head} (searched on ${indexer})`);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
