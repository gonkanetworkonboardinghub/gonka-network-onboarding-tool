/**
 * check-base44-rentals.js — does the website's gnot-rentals function answer
 * exactly what the app would?
 *
 *   node scripts/check-base44-rentals.js           runs docs/base44/gnot-rentals.js here
 *   node scripts/check-base44-rentals.js <url>     asks the deployed function
 *
 * Either way it then works the same comparison out with the app's own code
 * (src/services/rentals.js), from the same earnings.json and the same price,
 * and compares every row. Offers can change between the two reads, so a
 * difference is read again once before it counts. Exit 1 = they differ.
 */
const fs = require("fs");
const path = require("path");
const rentals = require("../src/services/rentals");

const url = process.argv[2];

async function fromFunction() {
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  // Run the generated file here, with a stand-in for Base44's Deno.serve.
  let handler = null;
  globalThis.Deno = { serve: (h) => { handler = h; } };
  const src = fs.readFileSync(path.join(__dirname, "..", "docs", "base44", "gnot-rentals.js"), "utf8");
  new Function(src)();
  const res = await handler(new Request("https://example.test/functions/gnot-rentals"));
  return res.json();
}

async function fromApp(site) {
  const earningsUrl = require("../src/knowledge").get().epochsUrl.replace(/epochs\.json$/, "earnings.json");
  const earnings = await (await fetch(earningsUrl)).json();
  if (site.price && site.price.usd) for (const c of earnings.configs) {
    c.usdPerDay = c.gnkPerDay * site.price.usd;
    c.breakEvenPerHour = c.usdPerDay / 24;
  }
  return rentals.estimate(earnings, { force: true });
}

const line = (r) => `${r.gpuCount}x ${r.gpuClass}: ${r.best ? "$" + r.best.pricePerHour + " " + r.best.region
  : r.cheapest ? "lacks " + r.cheapest.short.join("+") + " ($" + r.cheapest.pricePerHour + ")" : "none"} | pays under ${r.runs[0].breakEvenPerHour == null ? "n/m" : r.runs[0].breakEvenPerHour.toFixed(4)} | day ${r.gapPerDay == null ? "-" : r.gapPerDay.toFixed(2)}`;

(async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const site = await fromFunction();
    if (site.error) throw new Error("the function answered an error: " + site.error);
    const app = await fromApp(site);
    const diffs = [];
    for (const p of app.providers) {
      const q = (site.providers || []).find((x) => x.id === p.id);
      if (!q) { diffs.push(`${p.name}: missing from the function's answer`); continue; }
      const a = p.rows.map(line), b = q.rows.map(line);
      if (a.length !== b.length) diffs.push(`${p.name}: ${a.length} rows in the app, ${b.length} from the function`);
      a.forEach((x, i) => { if (x !== b[i]) diffs.push(`${p.name} row ${i + 1}:\n    app      ${x}\n    function ${b[i] || "(none)"}`); });
    }
    console.log(`${url ? "deployed function" : "generated function, run here"}: price $${site.price && site.price.usd}, ${site.providers.map((p) => `${p.name} ${p.rows.filter((r) => r.best).length} of ${p.rows.length}`).join(", ")}`);
    if (!diffs.length) { console.log("same as the app, row for row"); return; }
    if (attempt === 2) { console.log("DIFFERENT:\n  " + diffs.join("\n  ")); process.exitCode = 1; return; }
    console.log("differences on the first read; reading again in case offers moved in between…");
  }
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
