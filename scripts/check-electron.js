/**
 * check-electron.js — is the Electron we ship still getting security fixes?
 *
 *   node scripts/check-electron.js
 *
 * Electron is Chrome plus Node, so a browser hole is our hole. Only the three
 * newest Electron majors get security fixes; anything older keeps known holes
 * for good, and a new one is found most months. This checks two things against
 * Electron's own published release list:
 *
 *   1. the major we build with is still supported;
 *   2. we are on its newest patch, so the fixes that exist are in.
 *
 * It fails loudly rather than quietly, because "we'll update later" is how an
 * app ends up years behind. If the release list can't be reached it says so
 * and passes: a website being down is not a reason to block a release.
 *
 * Run weekly by .github/workflows/security.yml, and before every release.
 */
const fs = require("fs");
const path = require("path");

const LIST = "https://endoflife.date/api/electron.json";
const root = path.join(__dirname, "..");

/** The version actually installed, falling back to the range in package.json. */
function installedVersion() {
  try { return require(path.join(root, "node_modules", "electron", "package.json")).version; } catch (_) {}
  const range = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies || {}).electron || "";
  return range.replace(/^[^\d]*/, "");
}

const cmp = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
};

(async () => {
  const version = installedVersion();
  if (!version) { console.error("Can't tell which Electron this project uses."); process.exitCode = 1; return; }
  const major = version.split(".")[0];

  let releases;
  // A plain controller, cleared straight after: a pending timer can still be
  // holding the process open when it ends, and Node trips over that on Windows.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15000);
  try {
    const res = await fetch(LIST, { signal: stop.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    releases = await res.json();
  } catch (e) {
    console.log(`Electron ${version}: couldn't reach the release list (${e.message}). Skipping this check.`);
    return;
  } finally { clearTimeout(timer); }

  const supported = releases.filter((r) => new Date(r.eol) > new Date());
  const ours = releases.find((r) => String(r.cycle) === major);
  const newest = supported[0];
  const problems = [];

  if (!ours || new Date(ours.eol) <= new Date()) {
    problems.push(`Electron ${major} stopped getting security fixes${ours ? " on " + ours.eol : ""}. ` +
      `Every Chrome and Node hole found since then is still in the app.`);
  } else if (cmp(version, ours.latest) < 0) {
    problems.push(`Electron ${version} is behind ${ours.latest}, the newest ${major}.x. ` +
      `The fixes in between are not in the app.`);
  }

  console.log(`Electron in this project: ${version}`);
  console.log(`Still getting security fixes: ${supported.map((r) => r.cycle + " (until " + r.eol + ")").join(", ")}`);
  if (!problems.length) { console.log("OK — up to date on a supported version."); return; }

  console.error("\n" + problems.map((p) => "PROBLEM: " + p).join("\n"));
  console.error(`\nFix: npm install --save-dev electron@^${newest.latest}, then run the build and test it.`);
  console.error("The app only uses windows, dialogs, safe storage and the two IPC bridges, so upgrades are usually small.");
  process.exitCode = 1;
})();
