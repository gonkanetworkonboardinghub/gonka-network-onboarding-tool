/**
 * services-snapshot.js — which "Use Gonka" services are answering, and since
 * when each one has been silent.
 *
 *   node scripts/services-snapshot.js <previous.json> <out.json>
 *
 * Runs in the hourly job next to the earnings and node counts. The app reads
 * the result and stops listing a service that has been down for three days
 * (unless it answers the app's own live check), so a service that closes
 * drops off the list without anyone shipping an update. One bad hour never
 * removes anything: downSince only resets when the service answers again.
 */
const fs = require("fs");
const path = require("path");
const K = require("../src/knowledge");
const { probe } = require("../src/services/service-probe");

const [prevPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node scripts/services-snapshot.js <previous.json> <out.json>");
  process.exit(1);
}

(async () => {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")).services || {}; } catch (_) { /* first run */ }
  // The list the app will actually show, so use the published manifest's
  // version of it when there is one.
  await K.loadRemoteManifest();
  const now = new Date().toISOString();
  const out = {};
  for (const s of K.get().useServices || []) {
    const up = await probe(s.base);
    const before = prev[s.id] || {};
    out[s.id] = {
      name: s.name,
      up,
      lastChecked: now,
      lastUp: up ? now : (before.lastUp || null),
      downSince: up ? null : (before.downSince || now)
    };
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ asOf: now, services: out }, null, 2) + "\n");
  const down = Object.values(out).filter((x) => !x.up).map((x) => x.name);
  console.log(`${outPath}: ${Object.keys(out).length} services, ${down.length ? "not answering: " + down.join(", ") : "all answering"}`);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
