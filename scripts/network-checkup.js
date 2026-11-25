/**
 * network-checkup.js — where the GNK minted for hosts goes, for the whole network, with no host named.
 *
 *   node scripts/network-checkup.js <checkup.json> <out.json>
 *
 * Reads the full Checkup that scripts/checkup-snapshot.js works out (every host, by address) and writes
 * only the network's totals: what was minted for hosts over the last finished epochs, what was paid, and
 * why the rest was not (whole epochs lost, weight confirmed lower, fees for models not run), epoch by
 * epoch; and how many hosts stand where in the epoch that is running. No address, no host list: the
 * website's "Where the GNK goes" page reads this file.
 *
 * What it says, and only that:
 *   window        the finished epochs looked at (the newest paid one is left out: its pay may still be landing)
 *   totals        minted, paid, lost (by cause, with how many times), confirmedLower, feesGivenUp,
 *                 feesReceived, notPaid = minted - paid; hostsAll, hostsLostAnEpoch
 *   lines         the two lines that cost a whole epoch, as the chain sets them and as the records show them
 *   epochs[]      [epoch, minted, paid, lost, confirmedLower, feesGivenUp, feesReceived] in whole GNK, oldest first
 *   now           the running epoch: hosts in it, left out, over a line, close to one, and the GNK at stake
 *   machines      machines listed now, and how many are not working
 */
const fs = require("fs");
const path = require("path");
const C = require("../src/services/checkup");

const [inPath, outPath] = process.argv.slice(2);
if (!outPath) { console.error("Usage: node scripts/network-checkup.js <checkup.json> <out.json>"); process.exit(1); }
const f = JSON.parse(fs.readFileSync(inPath, "utf8"));
if (!f || f.v !== 1 || !f.net || !f.hosts || !f.window) throw new Error("not a Checkup file");
const r = (n) => Math.round(n || 0);
const net = f.net;

// epoch by epoch, every host in them (also those gone since): worked out in checkup-snapshot.js
const epochs = (net.perEpoch || []).map((x) => x.slice());
if (!epochs.length) throw new Error("the Checkup file has no epoch-by-epoch totals (an older checkup-snapshot.js?)");
for (const [e, minted, paid, lostE, cut, fees, received] of epochs) {
  const gap = minted - (paid + lostE + cut + fees - received);
  if (Math.abs(gap) > minted * 0.02) throw new Error(`epoch ${e} does not add up: ${gap} GNK`);
}

// the running epoch: where each host stands, counted, never named
const now = { hosts: 0, leftOut: 0, overALine: 0, close: 0, clear: 0, gnkAtStake: 0, gnkLostAlready: 0 };
for (const h of Object.values(f.hosts)) {
  now.hosts++;
  const lv = C.live(h.live);
  const level = lv ? lv.level : 0;
  if (level === 3) { now.leftOut++; now.gnkLostAlready += h.fullDay || 0; }
  else if (level === 2) { now.overALine++; now.gnkAtStake += h.fullDay || 0; }
  else if (level === 1) now.close++;
  else now.clear++;
}
now.gnkAtStake = r(now.gnkAtStake); now.gnkLostAlready = r(now.gnkLostAlready);

const lost = Object.fromEntries(Object.entries(net.lost || {}).map(([k, v]) => [k, { times: v.n, gnk: r(v.gnk) }]));
const out = {
  v: 1, asOf: f.asOf, epoch: f.epoch,
  about: "Where the GNK minted for Gonka hosts goes, network totals only, read from the chain. No host is named. Worked out by scripts/checkup-snapshot.js and scripts/network-checkup.js in the GNOT repository.",
  window: f.window,
  totals: {
    minted: r(net.minted), paid: r(net.paid), notPaid: r(net.minted - net.paid),
    lost, lostAll: r(net.lostAll), confirmedLower: r(net.confirmCut),
    feesGivenUp: r(net.feesPaid), feesReceived: r(net.feesReceived),
    hostsAll: net.hostsAll, hostsLostAnEpoch: net.hostsHit
  },
  lines: {
    confirmation: { chainSetting: C.LINES.confirmation, highestFailed: net.rule ? +net.rule.highestFailedRatio.toFixed(3) : null, lowestPaid: net.rule ? +net.rule.lowestPaidRatio.toFixed(3) : null },
    missedRequests: { about: C.LINES.missed, lowestLost: net.rule ? +net.rule.lowestMissedLost.toFixed(3) : null, highestPaid: net.rule ? +net.rule.highestMissedPaid.toFixed(3) : null }
  },
  epochs,
  now,
  machines: { listed: net.machines, notWorking: net.machinesDown }
};
// The parts add up to what was not paid, or this file says nothing.
const parts = out.totals.lostAll + out.totals.confirmedLower + out.totals.feesGivenUp - out.totals.feesReceived;
if (Math.abs(parts - out.totals.notPaid) > out.totals.minted * 0.02) throw new Error(`the parts do not add up: ${parts} vs ${out.totals.notPaid}`);
if (JSON.stringify(out).match(/gonka1[0-9a-z]{20,}/)) throw new Error("an address slipped into the public file");
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out) + "\n");
console.log(`network checkup: epochs ${f.window.from}–${f.window.to}, minted ${out.totals.minted.toLocaleString("en")}, paid ${out.totals.paid.toLocaleString("en")} (${(100 * out.totals.paid / out.totals.minted).toFixed(1)}%), ${out.totals.hostsLostAnEpoch} of ${out.totals.hostsAll} hosts lost a whole epoch; now ${now.leftOut} left out, ${now.overALine} over a line, ${now.close} close`);
