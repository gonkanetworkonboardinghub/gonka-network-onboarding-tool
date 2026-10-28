/**
 * check-base44-monitor.js — does the website's gnot-monitor function answer
 * what the app's Gonka Host Monitor/Vote would?
 *
 *   node scripts/check-base44-monitor.js           runs docs/base44/gnot-monitor.js here
 *   node scripts/check-base44-monitor.js <url>     asks the deployed function
 *
 * For the network, the proposals, the busiest host's page and one vote, it
 * compares the function's answer with the app's own src/services/monitor.js,
 * figure by figure. Balances and open tallies move, so a difference is read
 * again once before it counts. Exit 1 = they differ.
 */
const fs = require("fs");
const path = require("path");
const K = require("../src/knowledge");
const monitor = require("../src/services/monitor");

const url = process.argv[2];
const seeds = K.get().seedNodes;

let handler = null;
async function ask(params) {
  if (url) {
    const res = await fetch(url + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) });
    const j = await res.json().catch(() => ({ error: `answered ${res.status} without JSON` }));
    if (j.error) throw new Error(`${params.view}: ${j.error}`);
    return j;
  }
  // Run the generated file here, with a stand-in for Base44's Deno.serve.
  if (!handler) {
    globalThis.Deno = { serve: (h) => { handler = h; } };
    new Function(fs.readFileSync(path.join(__dirname, "..", "docs", "base44", "gnot-monitor.js"), "utf8"))();
  }
  const res = await handler(new Request("https://example.test/functions/gnot-monitor?" + new URLSearchParams(params)));
  const j = await res.json();
  if (j.error) throw new Error(`${params.view}: ${j.error}`);
  return j;
}

// An epoch's start that is worked out from the pace of blocks moves by seconds between two reads.
const settled = (x) => x && JSON.stringify({ ...x, at: x.est ? "(estimated)" : x.at });
const pick = {
  network: (o) => ({
    epoch: o.epoch.index,
    hosts: o.hosts.map((h) => `${h.address} ${h.weight} ${h.gpus} ${h.lastReward} ${h.excluded}`),
    last: o.last && `${o.last.epoch} ${o.last.rewards} ${o.last.hosts} ${o.last.payout && o.last.payout.minted} ${o.last.payout && o.last.payout.paid}`,
    gpus: o.gpus && `${o.gpus.total} ${o.gpus.working} ${o.gpus.machines}`,
    models: o.models.map((m) => `${m.model} ${m.hosts}`),
    supply: o.supply, pool: o.communityPool,
    past: `${o.past.length} ${settled(o.past[o.past.length - 1])}`,
    capacity: `${o.capacity.length} ${settled(o.capacity[o.capacity.length - 1])}`
  }),
  votes: (g) => ({
    rules: g.rules, hosts: g.hosts,
    proposals: g.proposals.map((p) => `#${p.id} ${p.status} ${p.title} | ${p.does.join(",")} | ${JSON.stringify(p.pays)} | ${p.tally.yes} ${p.tally.no} ${p.tally.veto} ${p.tally.abstain}`),
    money: g.money && `${g.money.pool && g.money.pool.ngonka} ${g.money.govAccount && g.money.govAccount.ngonka}`
  }),
  node: (d) => ({
    standing: `${d.standing.known} ${d.standing.inEpoch} ${d.standing.weight} ${d.standing.place && d.standing.place.rank} ${d.standing.models.join(",")} ${d.standing.epochsCompleted}`,
    last: d.last && `${d.last.epoch} ${d.last.reward} ${d.last.requests} ${d.last.missed}`,
    totals: d.totals,
    history: d.history.map((l) => `${l.epoch} ${l.took} ${l.reward}`),
    money: `${d.money.balance} ${d.money.collateral} ${d.money.vesting.total} ${d.money.vesting.epochs} ${d.money.allowance && d.money.allowance.left}`,
    hardware: `${d.hardware.gpuCount} ${d.hardware.nodes.map((n) => n.id + ":" + n.status).join(",")}`,
    attention: d.attention.map((a) => a.code)
  })
};

function differences(name, a, b) {
  const out = [];
  for (const key of Object.keys(a)) {
    const x = JSON.stringify(a[key]), y = JSON.stringify(b[key]);
    if (x !== y) out.push(`${name}.${key}:\n    app      ${x.slice(0, 300)}\n    function ${String(y).slice(0, 300)}`);
  }
  return out;
}

(async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const diffs = [];
    const siteNet = await ask({ view: "network" });
    const appNet = await monitor.networkOverview(seeds);
    diffs.push(...differences("network", pick.network(appNet), pick.network(siteNet)));
    console.log(`network: epoch ${siteNet.epoch.index}, ${siteNet.hosts.length} hosts, ${siteNet.gpus ? siteNet.gpus.total : "?"} GPUs, GNK $${siteNet.price && siteNet.price.usd}`);
    // The price: the app's middle of four markets. Markets move between two reads, so within 1%.
    const appPrice = await require("../src/services/earnings").gnkPrice();
    const sitePrice = siteNet.price && siteNet.price.usd;
    if (appPrice.usd && !(sitePrice && Math.abs(sitePrice - appPrice.usd) / appPrice.usd < 0.01)) diffs.push(`price: app $${appPrice.usd}, function $${sitePrice}`);

    const siteGov = await ask({ view: "votes" });
    const appGov = await monitor.proposals(seeds);
    diffs.push(...differences("votes", pick.votes(appGov), pick.votes(siteGov)));
    const live = siteGov.proposals.filter((p) => p.status === "VOTING_PERIOD");
    console.log(`votes: ${siteGov.proposals.length} proposals, ${live.length} open`);

    const top = siteNet.hosts[0].address;
    const siteNode = await ask({ view: "node", address: top, epochs: 30 });
    const appNode = await monitor.overview(seeds, top, { epochs: 30 });
    diffs.push(...differences("node", pick.node(appNode), pick.node(siteNode)));
    console.log(`node ${top.slice(0, 12)}…: in epoch ${siteNode.standing.inEpoch}, last reward ${siteNode.last && siteNode.last.reward}, ${siteNode.hardware.gpuCount} GPUs`);

    const id = (live[0] || siteGov.proposals[0]).id;
    const siteVote = await ask({ view: "vote", id, address: top });
    const appVote = await monitor.voteOf(seeds, id, top);
    if (siteVote.vote !== appVote) diffs.push(`vote #${id}: app ${appVote}, function ${siteVote.vote}`);
    console.log(`vote on #${id}: ${siteVote.vote}`);

    if (!diffs.length) { console.log(`${url ? "deployed function" : "generated function, run here"}: same as the app, figure for figure`); return; }
    if (attempt === 2) { console.log("DIFFERENT:\n  " + diffs.join("\n  ")); process.exitCode = 1; return; }
    console.log(`${diffs.length} differences on the first read; reading again in case something moved in between…`);
  }
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
