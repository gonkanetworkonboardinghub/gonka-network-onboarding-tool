/**
 * governance-snapshot.js — where the network's shared money is, and where the
 * proposals sent it, for Gonka Host Monitor/Vote's Votes page.
 *
 *   node scripts/governance-snapshot.js <out.json>
 *
 * Three places hold money that only a passed proposal can move:
 *   - the community pool (the distribution module);
 *   - the governance account itself, which pays compensation and restitution
 *     in coins that unlock over time (MsgBatchTransferWithVesting and co.);
 *   - the community sale contract: proposal #14 moved 20M GNK from the pool
 *     into it, it sells them for USDT, and grants and bounties are paid in
 *     that USDT (withdraw_ibc).
 * Reading every proposal is three large questions and the app would ask them
 * on every visit, so this asks here and publishes governance.json on the data
 * branch:
 *   pool, govAccount, sale       what each holds now (ngonka; USDT in its smallest unit)
 *   paid                         totals over every passed proposal
 *   payouts                      one row per passed proposal that paid anything,
 *                                newest first: { id, title, ended, fromPool,
 *                                toSale, fromGov, usdt, recipients }
 */
const fs = require("fs");
const K = require("../src/knowledge");

const GAP_MS = 800;
const outPath = process.argv[2];
if (!outPath) { console.error("Usage: node scripts/governance-snapshot.js <out.json>"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asked = 0;
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    if (asked++) await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (res.status === 404) return null;
    if ((res.status === 503 || res.status === 429) && attempt < 4) { await sleep(5000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return body;
  }
}
const ngonka = (list) => (list || []).reduce((a, c) => (/^ngonka$/i.test(c.denom) ? a + Math.floor(Number(c.amount)) : a), 0);

(async () => {
  await K.loadRemoteManifest();
  const k = K.get();
  let seed = null;
  for (const s of k.seedNodes) {
    try { if (await getJson(s + "/chain-api/cosmos/gov/v1/params/tallying")) { seed = s; break; } } catch (_) { /* next */ }
  }
  if (!seed) throw new Error("no Gonka node answered");
  const api = (p) => getJson(seed + "/chain-api" + p);

  // Every proposal, a page at a time.
  let all = [], key = "";
  for (let i = 0; i < 20; i++) {
    const r = await api("/cosmos/gov/v1/proposals?pagination.limit=50" + (key ? "&pagination.key=" + encodeURIComponent(key) : ""));
    all = all.concat((r && r.proposals) || []);
    key = r && r.pagination && r.pagination.next_key;
    if (!key) break;
  }
  if (!all.length) throw new Error("no proposals came back");

  const gov = await api("/cosmos/auth/v1beta1/module_accounts/gov");
  const govAddress = gov && gov.account && ((gov.account.base_account || gov.account).address);
  if (!govAddress) throw new Error("governance account not found");

  // The contracts proposals pay USDT from (the community sale), and the token.
  const saleAddresses = new Set();
  for (const p of all) for (const m of p.messages || []) {
    if (/MsgExecuteContract$/.test(m["@type"]) && m.msg && m.msg.withdraw_ibc) saleAddresses.add(m.contract);
  }
  let usdtDenom = null, usdtDecimals = 6;
  for (const p of all) for (const m of p.messages || []) {
    if (m.msg && m.msg.withdraw_ibc && m.msg.withdraw_ibc.denom) usdtDenom = usdtDenom || m.msg.withdraw_ibc.denom;
  }
  if (usdtDenom) {
    const md = await api("/cosmos/bank/v1beta1/denoms_metadata/" + encodeURIComponent(usdtDenom)).catch(() => null);
    const unit = md && md.metadata && (md.metadata.denom_units || []).find((u) => u.exponent > 0);
    if (unit) usdtDecimals = unit.exponent;
  }

  // What each passed proposal paid, and from where.
  const payouts = [];
  const paid = { fromPool: 0, toSale: 0, fromGov: 0, usdt: 0 };
  for (const p of all.filter((x) => /PASSED/.test(x.status))) {
    const row = { id: Number(p.id), title: p.title || "", ended: p.voting_end_time || null, fromPool: 0, toSale: 0, fromGov: 0, usdt: 0, recipients: 0 };
    const to = new Set();
    for (const m of p.messages || []) {
      const type = String(m["@type"]).split(".").pop();
      if (type === "MsgCommunityPoolSpend") {
        const a = ngonka(m.amount);
        if (saleAddresses.has(m.recipient)) row.toSale += a; else { row.fromPool += a; to.add(m.recipient); }
      } else if (type === "MsgBatchTransferWithVesting" && m.sender === govAddress) {
        for (const o of m.outputs || []) { row.fromGov += ngonka(o.amount); to.add(o.recipient); }
      } else if (type === "MsgTransferWithVesting" && (m.sender === govAddress || m.from_address === govAddress)) {
        row.fromGov += ngonka(m.amount); to.add(m.recipient || m.to_address);
      } else if (type === "MsgMultiSend") {
        if ((m.inputs || []).some((i) => i.address === govAddress)) for (const o of m.outputs || []) { row.fromGov += ngonka(o.coins); to.add(o.address); }
      } else if (type === "MsgExecuteContract" && m.msg && m.msg.withdraw_ibc && m.msg.withdraw_ibc.denom === usdtDenom) {
        row.usdt += Math.floor(Number(m.msg.withdraw_ibc.amount) || 0); to.add(m.msg.withdraw_ibc.recipient);
      }
    }
    to.delete(undefined);
    row.recipients = to.size;
    if (row.fromPool || row.toSale || row.fromGov || row.usdt) {
      payouts.push(row);
      for (const f of ["fromPool", "toSale", "fromGov", "usdt"]) paid[f] += row[f];
    }
  }
  payouts.sort((a, b) => b.id - a.id);

  // What each place holds now.
  const poolJ = await api("/cosmos/distribution/v1beta1/community_pool");
  const govBal = await api("/cosmos/bank/v1beta1/balances/" + govAddress);
  const sale = [];
  for (const addr of saleAddresses) {
    const info = await api("/cosmwasm/wasm/v1/contract/" + addr).catch(() => null);
    const bal = await api("/cosmos/bank/v1beta1/balances/" + addr).catch(() => null);
    const list = (bal && bal.balances) || [];
    sale.push({
      address: addr, label: (info && info.contract_info && info.contract_info.label) || "",
      ngonka: ngonka(list), usdt: Math.floor(Number((list.find((c) => c.denom === usdtDenom) || {}).amount || 0))
    });
  }

  const out = {
    asOf: new Date().toISOString(),
    proposals: all.length,
    pool: { ngonka: ngonka(poolJ && poolJ.pool) },
    govAccount: { address: govAddress, ngonka: ngonka(govBal && govBal.balances) },
    sale,
    usdt: { denom: usdtDenom, decimals: usdtDecimals },
    paid,
    payouts
  };
  fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
  const g = (n) => Math.round(n / 1e9).toLocaleString("en");
  console.log(`${all.length} proposals, ${payouts.length} paid something: ${g(paid.fromPool)} GNK from the pool to people, ` +
    `${g(paid.toSale)} GNK into the sale, ${g(paid.fromGov)} GNK from the governance account, ` +
    `${(paid.usdt / 10 ** usdtDecimals).toLocaleString("en")} USDT. Pool ${g(out.pool.ngonka)} GNK; ${asked} questions`);
})().catch((e) => { console.error("governance-snapshot failed: " + e.message); process.exit(1); });
