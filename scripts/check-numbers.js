/**
 * check-numbers.js — do the numbers people see still make sense?
 *
 *   node scripts/check-numbers.js <last.json> <now.json>
 *
 * The daily watch runs this beside scripts/check-chain.js. That one asks
 * whether the app still fits Gonka; this one asks whether what the app and the
 * website show is fresh, consistent and believable, and what moved since the
 * last look:
 *
 *   - the data job's files (the data branch): how old each one is;
 *   - the release: the published settings, GitHub's latest release, its files
 *     and their checksums, and this folder's version, all saying the same;
 *   - people: computers that opened the app (the website's own count),
 *     downloads and installs, and nodes set up with GNOT (the note GNOT leaves
 *     on the chain), with anything new since the last look named;
 *   - what nodes set up with GNOT were paid, from the chain's own rewards,
 *     against what the website shows;
 *   - the network: hosts, GPUs and weight, and any jump since the last look;
 *   - Mine or buy: every rig's figures, the GNK price and its four markets,
 *     and the provider's price list.
 *
 * It only reads. Nothing here downloads a release file (each download counts
 * as a person on the website): files are checked by the digests GitHub
 * publishes for them. Prints a report, writes now.json for the next run to
 * compare with. Exit 1 = a problem; warnings and news alone exit 0.
 */
const fs = require("fs");
const path = require("path");

const [lastPath, nowPath] = process.argv.slice(2);
if (!nowPath) { console.error("Usage: node scripts/check-numbers.js <last.json> <now.json>"); process.exit(2); }

const DATA = "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data";
const MANIFEST = "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/manifest.json";
const LATEST = "https://api.github.com/repos/gonkanetworkonboardinghub/gonka-host-setup/releases/latest";
const USAGE = "https://thegonkanetworkonboardinghub.com/api/apps/6a30335a7788e73f356c2536/functions/gnot-usage-stats";
const FILES = ["capacity", "compat", "earnings", "epochs", "fees", "governance", "network", "onboarded", "rentals", "stats", "usage"];
// The data job asks GitHub for a run every 15 minutes; GitHub runs it every 3 to 6 hours.
const OLD_HOURS = 12, STALE_HOURS = 24;
// A move this large between two looks is worth a word, not an alarm.
const JUMP = 0.25;

const out = { problems: [], warnings: [], news: [], ok: [] };
const say = (kind, text) => out[kind].push(text);
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const gnk = (n) => (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600e3;

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

(async () => {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(lastPath, "utf8")); } catch (_) { /* first look */ }
  const now = { at: new Date().toISOString() };

  // ---- the data job's files ----
  const d = {};
  for (const f of FILES) {
    try { d[f] = await getJson(`${DATA}/${f}.json`); }
    catch (e) { say("problems", `${f}.json could not be read: ${e.message}`); continue; }
    const h = hoursSince(d[f].asOf);
    if (!isFinite(h)) say("warnings", `${f}.json carries no date`);
    else if (h > STALE_HOURS) say("problems", `${f}.json is ${Math.round(h)} hours old: the data job has not run for a day`);
    else if (h > OLD_HOURS) say("warnings", `${f}.json is ${Math.round(h)} hours old (the data job usually runs every 3 to 6 hours)`);
  }
  const ages = FILES.filter((f) => d[f]).map((f) => hoursSince(d[f].asOf)).filter(isFinite);
  if (ages.length) say("ok", `data job files: ${ages.length} read, the oldest ${Math.round(Math.max(...ages))} hours old`);

  // ---- the release ----
  const pkg = require(path.join(__dirname, "..", "package.json"));
  let manifest = null, release = null;
  try { manifest = await getJson(MANIFEST, { headers: { "Cache-Control": "no-cache" } }); } catch (e) { say("problems", `the published settings (manifest.json) could not be read: ${e.message}`); }
  try { release = await getJson(LATEST, { headers: { Accept: "application/vnd.github+json" } }); } catch (e) { say("warnings", `GitHub's latest release could not be read: ${e.message}`); }
  if (manifest) {
    const app = manifest.app || {}, mac = app.mac || {};
    const v = app.latest;
    now.version = v;
    if (mac.latest !== v) say("problems", `Windows offers ${v} but Mac offers ${mac.latest}`);
    if (app.minSupported !== v || mac.minSupported !== v) say("warnings", `not every copy must update: latest ${v}, must be at least ${app.minSupported} (Windows) / ${mac.minSupported} (Mac)`);
    if (release) {
      const tag = String(release.tag_name || "").replace(/^v/, "");
      if (tag !== v) say("problems", `the published settings offer ${v} but GitHub's latest release is ${tag}`);
      const assets = release.assets || [];
      const digest = (name) => { const a = assets.find((x) => x.name === name); return a ? String(a.digest || "").replace(/^sha256:/, "") : undefined; };
      const want = [
        [`Gonka-Network-Onboarding-Tool-Setup-${v}.exe`, app.sha256, "Windows installer"],
        [`Gonka-Network-Onboarding-Tool-${v}-mac-arm64.zip`, mac.arm64 && mac.arm64.sha256, "Mac (Apple silicon)"],
        [`Gonka-Network-Onboarding-Tool-${v}-mac-x64.zip`, mac.x64 && mac.x64.sha256, "Mac (Intel)"]
      ];
      for (const [name, sha, label] of want) {
        const got = digest(name);
        if (got === undefined) say("problems", `${label}: ${name} is missing from GitHub's release ${tag}`);
        else if (got && sha && got !== sha) say("problems", `${label}: GitHub's file does not match the checksum the app and the install commands expect`);
      }
      if (!assets.some((a) => a.name === "Gonka-Network-Onboarding-Tool.exe")) say("problems", `the plain Gonka-Network-Onboarding-Tool.exe (what install.ps1 downloads) is missing from release ${tag}`);
    }
    if (pkg.version !== v) {
      const newer = pkg.version.split(".").map(Number), live = String(v).split(".").map(Number);
      const ahead = newer[0] - live[0] || newer[1] - live[1] || newer[2] - live[2];
      say(ahead > 0 ? "warnings" : "problems", ahead > 0 ? `this folder is at ${pkg.version}, ahead of the live ${v}: a release is built but not published` : `this folder is at ${pkg.version}, behind the live ${v}`);
    }
    if (!out.problems.some((p) => /release|settings|installer|Mac|GitHub/.test(p))) say("ok", `release ${v}: settings, GitHub's release and its files agree`);
  }

  // ---- people ----
  let usage = null;
  try { usage = await getJson(USAGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
  catch (e) { say("warnings", `the website's count of computers could not be read: ${e.message}`); }
  const st = d.stats, on = d.onboarded;
  now.people = {
    computers: usage ? num(usage.computersGnot) : null,
    opened30: usage ? num(usage.opened30) : null,
    downloads: st ? num(st.totals && st.totals.downloads) : null,
    installs: st ? num(st.totals && st.totals.installs) : null,
    nodesEver: on ? num(on.totals && on.totals.nodesEver) : null,
    nodesNow: on ? num(on.totals && on.totals.activeNow) : null,
    gpusNow: on ? num(on.totals && on.totals.gpusNow) : null
  };
  now.gnotNodes = on ? on.nodes.map((n) => n.address) : [];
  const was = (last && last.people) || {};
  const moved = (key, label) => {
    const a = was[key], b = now.people[key];
    if (a == null || b == null || a === b) return;
    say("news", `${label}: ${fmt(a)} → ${fmt(b)}`);
  };
  moved("computers", "computers that ever opened GNOT");
  moved("opened30", "computers that opened GNOT in the last 30 days");
  moved("downloads", "downloads on GitHub");
  moved("installs", "first installs on GitHub");
  moved("nodesEver", "nodes ever set up with GNOT");
  moved("nodesNow", "nodes set up with GNOT in the current epoch");
  moved("gpusNow", "GPUs on nodes set up with GNOT, current epoch");
  if (last && last.gnotNodes) for (const a of now.gnotNodes.filter((x) => !last.gnotNodes.includes(x))) say("news", `NEW node set up with GNOT: ${a}`);
  if (now.people.computers != null) say("ok", `people: ${now.people.computers} computer(s) ever opened GNOT, ${now.people.nodesEver} node(s) ever set up with it, ${now.people.nodesNow} in the network now with ${now.people.gpusNow} GPUs`);

  // ---- what GNOT nodes were paid, against what the website shows ----
  const ep = d.epochs;
  if (on && ep && Array.isArray(ep.epochs) && Array.isArray(ep.hosts)) {
    const idx = new Set(on.nodes.map((n) => ep.hosts.indexOf(n.address)).filter((i) => i >= 0));
    let paid = 0;
    for (const e of ep.epochs) for (const r of e.r || []) if (idx.has(r[0])) paid += Number(r[1]) || 0;
    now.gnotPaid = paid;
    const shown = num(on.totals && on.totals.gnkMinedAllEpochs);
    if (shown != null) {
      const shownN = shown * 1e9;
      if (Math.abs(shownN - paid) > Math.max(1e9, 0.05 * paid)) say("warnings", `the website shows ${gnk(shownN)} GNK mined by nodes set up with GNOT; the chain paid them ${gnk(paid)} GNK (the data job should show what the chain paid)`);
      else say("ok", `GNK paid to nodes set up with GNOT: ${gnk(paid)}, as the website shows`);
    }
  }

  // ---- the network ----
  const nw = d.network;
  if (nw && nw.totals) {
    const t = nw.totals;
    now.network = { epoch: nw.epoch, hosts: num(t.hosts), gpus: num(t.gpus), gpusWorking: num(t.gpusWorking), h100: num(t.h100) };
    if (!t.hosts || !t.gpus) say("problems", `network.json shows ${t.hosts} hosts and ${t.gpus} GPUs`);
    const p = (last && last.network) || {};
    for (const [k, label] of [["hosts", "hosts"], ["gpus", "GPUs hosts report"], ["h100", "the network's weight in H100s"]]) {
      const a = p[k], b = now.network[k];
      if (a && b && Math.abs(b - a) / a > JUMP) say("warnings", `${label} moved from ${fmt(a)} to ${fmt(b)} since the last look (${b > a ? "+" : ""}${Math.round((b - a) / a * 100)}%): real, or a reading that went wrong?`);
    }
    say("ok", `network, epoch ${nw.epoch}: ${t.hosts} hosts, ${t.gpus} GPUs reported (${t.gpusWorking} working)`);
  }

  // ---- Mine or buy ----
  const ea = d.earnings;
  if (ea) {
    const price = ea.price || {};
    now.price = num(price.usd);
    if (!(price.usd > 0)) say("problems", `the GNK price is ${price.usd}`);
    const srcs = (price.sources || []).map((s) => s.usd).filter((x) => x > 0);
    if (srcs.length < 2) say("warnings", `the GNK price came from ${srcs.length} market(s) out of 4`);
    else if (Math.max(...srcs) / Math.min(...srcs) > 1.15) say("warnings", `the four GNK markets disagree by more than 15%: ${(price.sources || []).map((s) => `${s.name} $${s.usd}`).join(", ")}`);
    if (last && last.price && now.price && Math.abs(now.price - last.price) / last.price > JUMP) say("news", `GNK price $${last.price.toFixed(3)} → $${now.price.toFixed(3)}`);
    const bad = (ea.configs || []).filter((c) => !(num(c.gnkPerDay) > 0) || !(num(c.usdPerDay) >= 0));
    if (bad.length) say("problems", `Mine or buy: ${bad.length} rig(s) with no believable figure: ${bad.map((c) => `${c.gpuCount}× ${c.gpuClass} ${String(c.model).split("/").pop()} = ${c.gnkPerDay}`).join("; ")}`);
    // Same GPUs, same model: more copies must earn more, never less.
    const by = {};
    for (const c of ea.configs || []) (by[`${c.gpuClass}|${c.model}`] ||= []).push(c);
    for (const list of Object.values(by)) {
      list.sort((a, b) => a.gpuCount - b.gpuCount);
      for (let i = 1; i < list.length; i++) if (list[i].gnkPerDay < list[i - 1].gnkPerDay) say("warnings", `Mine or buy: ${list[i].gpuCount}× ${list[i].gpuClass} earns less than ${list[i - 1].gpuCount}× for ${String(list[i].model).split("/").pop()}`);
    }
    if (!bad.length) say("ok", `Mine or buy: ${(ea.configs || []).length} rigs with figures, GNK $${(price.usd || 0).toFixed(3)} from ${srcs.length} markets`);
  }
  const rn = d.rentals;
  if (rn) for (const p of rn.providers || []) {
    if (p.error) say("warnings", `${p.name || p.id}'s price list: ${p.error}`);
    else if (!p.offers) say("warnings", `${p.name || p.id}'s price list has no offers`);
    else say("ok", `${p.name || p.id}: ${p.offers} offers read, ${(p.rows || []).filter((r) => r.best).length} setups a node can run on`);
  }

  // ---- what people have: the published comparison with Gonka ----
  if (d.compat && d.compat.ok === false) say("problems", `the published comparison with Gonka (compat.json) is red: ${(d.compat.problems || []).map((p) => p.id || p.text || JSON.stringify(p)).join("; ")}`);

  // ---- report ----
  now.problems = out.problems; now.warnings = out.warnings;
  fs.mkdirSync(path.dirname(nowPath), { recursive: true });
  fs.writeFileSync(nowPath, JSON.stringify(now, null, 2));
  const block = (title, list) => list.length && console.log(`\n${title}\n${list.map((x) => "  - " + x).join("\n")}`);
  console.log(`check-numbers — ${now.at}${last ? `, compared with ${last.at}` : ", first look"}`);
  block("PROBLEMS", out.problems);
  block("WORTH A LOOK", out.warnings);
  block("NEW SINCE LAST TIME", out.news);
  block("FINE", out.ok);
  process.exitCode = out.problems.length ? 1 : 0;
})().catch((e) => { console.error("check-numbers could not finish:", e.message); process.exitCode = 2; });
