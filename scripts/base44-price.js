/**
 * base44-price.js — the GNK price for the website's Base44 functions, as close
 * to the app's as a shared server can get.
 *
 * The app takes the middle of four markets (src/services/earnings.js
 * gnkPrice). Some markets refuse Base44's servers (they limit how often one
 * address may ask, and that address is shared with many other websites):
 * CoinGecko does so steadily, and then the middle of the three left is not the
 * app's price — 6% lower on 26 October 2026. So each market that did not
 * answer is taken from the data job's last reading of that same market
 * (earnings.json, every few hours), and the middle is taken of all four, as
 * the app does. With no market answering at all, the price is the data job's
 * own, marked "published" with when it was read.
 *
 * The build scripts put fillInPrice into both functions (build-base44-monitor.js,
 * build-base44-rentals.js); scripts/check-base44-*.js compare the result with the app.
 */
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

module.exports = { fillInPrice };
