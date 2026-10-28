/**
 * check-base44-rentals.js — does the website's gnot-rentals function answer
 * exactly what the app would?
 *
 *   node scripts/check-base44-rentals.js           runs docs/base44/gnot-rentals.js here
 *   node scripts/check-base44-rentals.js <url>     asks the deployed function
 *
 * Three checks, each with the app's own code:
 *   - the earnings: the function's live figures against the app's own live
 *     src/services/earnings.js, rig by rig (what each earns, the machines and
 *     hosts running it, what was left out);
 *   - the price: the app's middle of four markets, read here and sent as a
 *     visitor's browser sends them (read-markets.js);
 *   - the comparison: src/services/rentals.js worked out from the function's
 *     own earnings and price, row by row.
 * The network and the offers can move between two reads, so a difference is
 * read again once before it counts. Exit 1 = they differ.
 */
const fs = require("fs");
const path = require("path");
const rentals = require("../src/services/rentals");
const earnings = require("../src/services/earnings");
const K = require("../src/knowledge");

const url = process.argv[2];

let handler = null;
async function fromFunction(markets) {
  const ask = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markets }) };
  if (url) {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "x=" + Date.now(), { ...ask, signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  // Run the generated file here, with a stand-in for Base44's Deno.serve.
  if (!handler) {
    globalThis.Deno = { serve: (h) => { handler = h; } };
    new Function(fs.readFileSync(path.join(__dirname, "..", "docs", "base44", "gnot-rentals.js"), "utf8"))();
  }
  return (await handler(new Request("https://example.test/functions/gnot-rentals", ask))).json();
}

/** The app's own earnings, read now from the first node that answers. */
async function appEarnings() {
  for (const seed of K.get().seedNodes) {
    try { return await earnings.estimate(seed, { force: true }); } catch (_) { /* the next one */ }
  }
  throw new Error("no Gonka node answered the app's own read");
}

const rig = (c) => `${c.gpuCount}x ${c.gpuClass} ${c.model.split("/").pop()}`;
const near = (a, b) => (a === b) || (a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.005);
const line = (r) => `${r.gpuCount}x ${r.gpuClass}: ${r.best ? "$" + r.best.pricePerHour + " " + r.best.region
  : r.cheapest ? "lacks " + r.cheapest.short.join("+") + " ($" + r.cheapest.pricePerHour + ")" : "none"} | pays under ${r.runs[0].breakEvenPerHour == null ? "n/m" : r.runs[0].breakEvenPerHour.toFixed(4)} | day ${r.gapPerDay == null ? "-" : r.gapPerDay.toFixed(2)}`;

(async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The markets as a visitor's browser reads them (read-markets.js is the app's gnkPrice).
    const appPrice = await earnings.gnkPrice();
    const site = await fromFunction(appPrice.sources);
    if (site.error) throw new Error("the function answered an error: " + site.error);
    const diffs = [];

    // The earnings, against the app's own live read.
    const e = site.earnings;
    if (!e) diffs.push("the function's answer has no earnings (an older version of it?)");
    else {
      if (!site.earningsLive) diffs.push("the function answered the published file, not a live read");
      const mine = await appEarnings();
      if (mine.epoch.index !== e.epoch.index) diffs.push(`epoch: app ${mine.epoch.index}, function ${e.epoch.index}`);
      const theirs = new Map(e.configs.map((c) => [rig(c), c]));
      for (const c of mine.configs) {
        const s = theirs.get(rig(c));
        if (!s) { diffs.push(`${rig(c)}: missing from the function`); continue; }
        if (!near(c.gnkPerDay, s.gnkPerDay) || c.machines !== s.machines || c.hosts !== s.hosts || c.sampleGpus !== s.sampleGpus)
          diffs.push(`${rig(c)}: app ${c.gnkPerDay.toFixed(1)} GNK/day, ${c.machines} machines, ${c.hosts} hosts, ${c.sampleGpus} GPUs; function ${s.gnkPerDay.toFixed(1)}, ${s.machines}, ${s.hosts}, ${s.sampleGpus}`);
        theirs.delete(rig(c));
      }
      for (const k of theirs.keys()) diffs.push(`${k}: in the function, not in the app`);
      if (JSON.stringify(mine.leftOut) !== JSON.stringify(e.leftOut)) diffs.push(`left out: app ${JSON.stringify(mine.leftOut)}, function ${JSON.stringify(e.leftOut)}`);
      // The setup files arrive in whatever order GitHub answers, so the order does not count.
      if (JSON.stringify(mine.noHosts.map(rig).sort()) !== JSON.stringify(e.noHosts.map(rig).sort())) diffs.push("the setups no host runs differ");
    }

    // The price: worked out from the markets sent, it is the app's to the cent.
    if (appPrice.usd && !(site.price && site.price.usd && Math.abs(site.price.usd - appPrice.usd) / appPrice.usd < 0.0001)) diffs.push(`price: app ${appPrice.usd}, function ${site.price && site.price.usd}`);
    const filled = ((site.price && site.price.sources) || []).filter((s) => s.readAt).map((s) => s.name);
    if (filled.length) diffs.push(`price: ${filled.join(", ")} taken from the published file, though the markets were sent`);

    // The comparison, worked out by the app's code from the function's own earnings and price.
    const app = await rentals.estimate(JSON.parse(JSON.stringify(e || {})), { force: true });
    for (const p of app.providers) {
      const q = (site.providers || []).find((x) => x.id === p.id);
      if (!q) { diffs.push(`${p.name}: missing from the function's answer`); continue; }
      const a = p.rows.map(line), b = q.rows.map(line);
      if (a.length !== b.length) diffs.push(`${p.name}: ${a.length} rows in the app, ${b.length} from the function`);
      a.forEach((x, i) => { if (x !== b[i]) diffs.push(`${p.name} row ${i + 1}:\n    app      ${x}\n    function ${b[i] || "(none)"}`); });
    }

    console.log(`${url ? "deployed function" : "generated function, run here"}: earnings ${site.earningsLive ? "live" : "PUBLISHED FILE"} (epoch ${e && e.epoch.index}, read ${e && e.asOf}), price $${site.price && site.price.usd}, ${site.providers.map((p) => `${p.name} ${p.rows.filter((r) => r.best).length} of ${p.rows.length}`).join(", ")}`);
    if (!diffs.length) { console.log("same as the app: every rig's earnings, the price, and the comparison row for row"); return; }
    if (attempt === 2) { console.log("DIFFERENT:\n  " + diffs.join("\n  ")); process.exitCode = 1; return; }
    console.log(`${diffs.length} differences on the first read; reading again in case something moved in between…`);
  }
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
