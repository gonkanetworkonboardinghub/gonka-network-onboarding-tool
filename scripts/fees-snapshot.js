/*
 * What hosts really paid in network fees over about the last epoch, for Host
 * Setup's fee card: "while your node works out its own estimate, here is what
 * hosts like it have been paying".
 *
 * Since Gonka v0.2.16 a node pays a fee for each Proof of Compute and hardware
 * report, through the fee allowance its wallet granted the node's own key, so
 * the allowance shrinks by exactly what was spent. This reads every current
 * host's allowance now and the same allowance BLOCKS_BACK blocks ago (the chain
 * keeps about one epoch of past state) and keeps the difference. A host whose
 * allowance has no spend limit, or that was granted one in between, cannot be
 * measured and is kept with fees: null.
 *
 *   node scripts/fees-snapshot.js <out.json>
 *
 * Out: { asOf, height, then, hours, hosts: [{ weight, share, fees }] } with fees
 * in ngonka, hosts from the smallest to the biggest. No addresses: the card
 * only needs sizes and amounts.
 */
const fs = require("fs");
const K = require("../src/knowledge");

const BLOCKS_BACK = 15000;       // about 22 hours at ~5.3 s a block: close to one epoch
const GAP_MS = 800;              // one question every 0.8 s, a pace the nodes accept
const [outPath] = process.argv.slice(2);
if (!outPath) { console.error("usage: node scripts/fees-snapshot.js <out.json>"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// node1 answers questions about past blocks; the others are tried after it.
const seeds = [...new Set(["http://node1.gonka.ai:8000", ...K.get().seedNodes])];

async function getJson(path, height) {
  let last;
  for (const s of seeds) {
    try {
      await sleep(GAP_MS);
      const res = await fetch(s + path, { headers: height ? { "x-cosmos-block-height": String(height) } : {}, signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => null);
      if (res.ok && body) return body;
      last = new Error(`${s}${path}: ${res.status}`);
    } catch (e) { last = e; }
  }
  throw last || new Error("no seed answered");
}

/** The ngonka spend limits of a wallet's fee allowances, by the key they were granted to. */
function limits(j) {
  const out = {};
  for (const a of (j && j.allowances) || []) {
    const al = a.allowance && (a.allowance.spend_limit ? a.allowance : a.allowance.allowance) || {};
    const s = (al.spend_limit || []).find((c) => c.denom === "ngonka");
    if (s) out[a.grantee] = Number(s.amount);
  }
  return out;
}

(async () => {
  const latest = await getJson("/chain-api/cosmos/base/tendermint/v1beta1/blocks/latest");
  const height = Number(latest.block.header.height);
  const then = height - BLOCKS_BACK;
  const old = await getJson(`/chain-api/cosmos/base/tendermint/v1beta1/blocks/${then}`);
  const hours = (Date.parse(latest.block.header.time) - Date.parse(old.block.header.time)) / 3600e3;

  const ep = await getJson(K.get().api.epochParticipants);
  const list = ((ep.active_participants || ep).participants || []).map((p) => ({ address: p.index, weight: Number(p.weight) || 0 }));
  const total = list.reduce((a, p) => a + p.weight, 0);
  if (!list.length || !total) throw new Error("no hosts in the current epoch");

  const hosts = [];
  for (const p of list) {
    let fees = null;
    try {
      const [now, before] = [await getJson(`/chain-api/cosmos/feegrant/v1beta1/issued/${p.address}`), await getJson(`/chain-api/cosmos/feegrant/v1beta1/issued/${p.address}`, then)];
      const ln = limits(now), lb = limits(before);
      for (const g of Object.keys(ln)) if (lb[g] != null && lb[g] >= ln[g]) fees = (fees || 0) + (lb[g] - ln[g]);
    } catch (_) { /* unmeasured */ }
    hosts.push({ weight: p.weight, share: p.weight / total, fees });
  }
  hosts.sort((a, b) => a.weight - b.weight);
  const measured = hosts.filter((h) => h.fees != null).length;
  if (measured < 5) throw new Error(`only ${measured} hosts could be measured`);
  fs.writeFileSync(outPath, JSON.stringify({ asOf: new Date().toISOString(), height, then, hours: Math.round(hours * 10) / 10, hosts }));
  console.log(`fees.json: ${measured} of ${hosts.length} hosts measured over ${hours.toFixed(1)} hours`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
