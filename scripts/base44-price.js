/**
 * base44-price.js — the GNK price for the website's Base44 functions, as close
 * to the app's as a shared server can get.
 *
 * The app takes the middle of four markets (src/services/earnings.js
 * gnkPrice), read from the computer it runs on. The markets refuse Base44's
 * servers when they please (they limit how often one address may ask, and that
 * address is shared with many other websites): CoinGecko did so steadily on
 * 26 October 2026, and on 28 October not one of the four answered for hours,
 * so every price on the website was hours old. So the website reads the
 * markets as the app does, from the visitor's own computer: the page reads
 * them in the browser (docs/base44/read-markets.js, the app's own gnkPrice)
 * and sends what it read with each question. A market the visitor's browser
 * could not read is taken from this server's own reading, and else from the
 * data job's last reading of that same market (earnings.json, every few
 * hours, marked readAt). With no market answering at all, the price is the
 * data job's own, marked "published" with when it was read.
 *
 * The build scripts put these into both functions (build-base44-monitor.js,
 * build-base44-rentals.js); scripts/check-base44-*.js compare the result with the app.
 */
const fs = require("fs");
const path = require("path");

/** The markets the app reads, in its order: the names in earnings.js gnkPrice. */
const MARKETS = [...fs.readFileSync(path.join(__dirname, "..", "src", "services", "earnings.js"), "utf8")
  .matchAll(/tryOne\("([^"]+)"/g)].map((m) => m[1]);

function fillInPrice(live, published) {
  const have = new Map(((live && live.sources) || []).map((s) => [s.name, s]));
  const answered = have.size;
  for (const s of (published && published.sources) || []) {
    if (!have.has(s.name) && s.usd > 0) have.set(s.name, { name: s.name, usd: s.usd, readAt: published.asOf });
  }
  const sources = [...have.values()];
  if (!sources.length) return { usd: null, sources: [] };
  const sorted = sources.map((s) => s.usd).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const usd = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return answered ? { usd, sources } : { usd, sources, published: published && published.asOf };
}

/** What the visitor's browser read, from a question's body: only the markets the app reads, each with a real price. */
function marketsFrom(body) {
  const seen = new Map();
  for (const m of (body && Array.isArray(body.markets) ? body.markets : [])) {
    const usd = Number(m && m.usd);
    if (m && MARKETS.includes(m.name) && usd > 0 && isFinite(usd) && !seen.has(m.name)) seen.set(m.name, { name: m.name, usd });
  }
  return [...seen.values()];
}

/** The price from the visitor's readings, this server's own for the markets they lack, and the data job's for the rest; in the app's order. */
function priceFrom(browser, own, published) {
  const have = new Map(browser.map((s) => [s.name, s]));
  for (const s of (own && own.sources) || []) if (!have.has(s.name)) have.set(s.name, { name: s.name, usd: s.usd });
  const p = fillInPrice({ sources: [...have.values()] }, published);
  p.sources.sort((a, b) => MARKETS.indexOf(a.name) - MARKETS.indexOf(b.name));
  return p;
}

/** All of the above as code, for the build scripts to put into a function. */
const priceCode = () => [
  `// The markets the app reads, in its order (src/services/earnings.js gnkPrice).`,
  `const MARKETS = ${JSON.stringify(MARKETS)};`,
  fillInPrice.toString(),
  marketsFrom.toString(),
  priceFrom.toString()
].join("\n");

module.exports = { MARKETS, fillInPrice, marketsFrom, priceFrom, priceCode };
