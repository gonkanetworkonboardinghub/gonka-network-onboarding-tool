/**
 * stats-snapshot.js — how much GNOT is actually being used, from sources
 * anyone can check for themselves.
 *
 *   node scripts/stats-snapshot.js <out.json>
 *
 * There is no account, no server and no tracking in this app, so there is no
 * private number to publish. What there is:
 *
 *   installs   the constant-named Windows file, which only the install
 *              command downloads (scripts/install.ps1 asks for it first)
 *   updates    the version-named Windows file, which only the in-app updater
 *              downloads (src/updater.js asks for it first) — plus anyone who
 *              downloads by hand from the Releases page
 *   mac        the Mac zips, which cannot be split the same way: the install
 *              script and the updater both fetch the same file
 *
 * These are GitHub's own download counters, public at
 * https://api.github.com/repos/<repo>/releases — so every figure here can be
 * checked against the source without trusting us. They count downloads, not
 * people: one person who installs on two computers is two.
 */
const fs = require("fs");
const path = require("path");

const REPO = process.env.GONKA_PUBLIC_REPO || "gonkanetworkonboardinghub/gonka-host-setup";
const CONST_WIN = /^Gonka-(Network-Onboarding-Tool|Host-Setup)\.exe$/;
const VERSIONED_WIN = /^Gonka-(Network-Onboarding-Tool|Host-Setup)-Setup-.*\.exe$/;
const MAC = /-mac-(arm64|x64)\.zip$/;

// Downloads that were our own test robot, not people. Until October 2026 the
// Windows build check downloaded the published 1.0.2 installer on every build
// to test upgrading from it — 17 times, counted from the Actions history (the
// "Updating an open 1.0.2 install" step of every windows job that ran it).
// The check now uses a copy kept in the ci-fixtures release of the source
// repository, so this number will never grow, and it is taken off here.
const ROBOT = { "1.0.2": 17 };

// Runs of the install command that were a test, not a person installing. On
// 26 September 2026 at 18:24 UTC the command was run once, on 1.3.4, purely to
// capture what it prints for a video. The snapshots on the data branch show
// the install counter going from 0 to 2 in that one hour and never moving
// since; the other one, about 19:09 UTC, was the publisher installing afresh
// to record the video now on the Download page — a person installing, so it
// stays.
const TEST_INSTALLS = { "1.3.4": 1 };

// How many of the downloads GitHub counted before the app could count for
// itself were made by people other than us. On 10 October 2026 all 58 were
// traced one by one — the automated runs' own logs, every command run while
// building, the update files still on the publisher's computer, and old
// readings of these counters — and the whole ledger is in
// docs/downloads-audit-2026-10-10.txt. 24 were our robots, 9 were checks made
// while building, 17 were the publisher's own computer, 6 came before anyone had
// been told the app existed, and 2 match nobody: both 1.1.0 for Windows, in the
// week the first messages went out. Those 2 are what the website adds to the
// computers the app itself has counted since. They may have been one person.
const AUDIT = {
  asOf: "2026-10-10",
  downloadsExamined: 58,
  byOtherPeople: 2,
  ledger: "https://github.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/blob/main/docs/downloads-audit-2026-10-10.txt"
};

const out = process.argv[2];
if (!out) {
  console.error("Usage: node scripts/stats-snapshot.js <out.json>");
  process.exit(1);
}

(async () => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "gonka-onboarding-hub" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const releases = await res.json();
  if (!Array.isArray(releases)) throw new Error("unexpected answer from GitHub");

  // Before 1.3.0 the install command and the updater fetched the SAME file, so
  // those downloads cannot be told apart and are not pretended to be. From
  // 1.3.0 they fetch different files and the split is real.
  const SPLIT_FROM = "1.3.0";
  const atLeast = (a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return true;
  };
  // The day the first message went out about GNOT. Downloads have no date of
  // their own, so this counts releases published since then — which is a floor,
  // not a total: older versions have been downloaded since that day too.
  const FIRST_MESSAGE = "2026-09-16";

  const versions = releases
    .filter((r) => !r.draft)
    .map((r) => {
      const count = (re) => (r.assets || []).filter((a) => re.test(a.name)).reduce((n, a) => n + a.download_count, 0);
      const version = r.tag_name.replace(/^v/, "");
      const robot = ROBOT[r.tag_name.replace(/^v/, "")] || 0;
      const tests = TEST_INSTALLS[r.tag_name.replace(/^v/, "")] || 0;
      const constName = Math.max(0, count(CONST_WIN) - tests), versioned = Math.max(0, count(VERSIONED_WIN) - robot), mac = count(MAC);
      const split = atLeast(version, SPLIT_FROM);
      return {
        version,
        published: r.published_at,
        windows: constName + versioned,
        mac,
        downloads: constName + versioned + mac,
        ...(robot ? { robotLeftOut: robot } : {}),
        split,
        ...(split ? { installs: constName, updates: versioned } : {})
      };
    })
    .sort((a, b) => (a.published < b.published ? 1 : -1));

  const sum = (list, k) => list.reduce((n, v) => n + (v[k] || 0), 0);
  const sinceFirstMessage = versions.filter((v) => v.published >= FIRST_MESSAGE);
  const data = {
    asOf: new Date().toISOString(),
    source: `https://api.github.com/repos/${REPO}/releases`,
    latest: versions[0] ? { version: versions[0].version, published: versions[0].published } : null,
    releases: versions.length,
    audited: AUDIT,
    // What the website shows. Exact where GitHub makes it exact, and labelled
    // as mixed where it cannot be split, never turned into a number of people.
    exact: {
      // From 1.3.0 the install command and the updater fetch different files:
      // every download of the constant-named file is the install command being
      // run, and every download of the versioned file is an update.
      since: (versions.filter((v) => v.split).map((v) => v.published).sort()[0] || "").slice(0, 10),
      installs: sum(versions.filter((v) => v.split), "installs"),
      updates: sum(versions.filter((v) => v.split), "updates"),
      testInstallsLeftOut: Object.values(TEST_INSTALLS).reduce((a, b) => a + b, 0)
    },
    mixed: {
      // Windows before 1.3.0 used one file for both, and the Mac zips always
      // do, so these cannot be told apart. Our own test robot is taken off;
      // our own computer's updates are in here and cannot be separated.
      downloads: sum(versions.filter((v) => !v.split), "windows") + sum(versions, "mac"),
      robotLeftOut: Object.values(ROBOT).reduce((a, b) => a + b, 0)
    },
    totals: {
      downloads: sum(versions, "downloads"),
      windows: sum(versions, "windows"),
      mac: sum(versions, "mac"),
      // Only counted where the two files actually differ.
      installs: sum(versions.filter((v) => v.split), "installs"),
      updates: sum(versions.filter((v) => v.split), "updates"),
      splitFrom: SPLIT_FROM
    },
    // Every release is a forced update, so the computer this app is built on
    // downloads each one too. Taking one copy per version out leaves what other
    // people downloaded. It is stated on the page as the subtraction it is, so
    // anyone can redo it from GitHub's own figures.
    byOthers: {
      downloads: Math.max(0, sum(versions, "downloads") - versions.length),
      ownCopyPerVersion: 1
    },
    // How many different computers, not how many downloads. A copy downloads a
    // given version once, so the busiest single version is a floor: that many
    // computers had to exist for it. The ceiling is every download being a
    // different computer. The truth is between the two, and the page says so
    // rather than picking a number out of the middle.
    computers: (() => {
      const busiest = versions.reduce((m, v) => (v.downloads > m.downloads ? v : m), versions[0] || { downloads: 0, version: null });
      return {
        atLeast: Math.max(0, busiest.downloads - 1),   // less the machine it is built on
        atMost: Math.max(0, sum(versions, "downloads") - versions.length),
        busiestVersion: busiest.version
      };
    })(),
    sinceFirstMessage: {
      date: FIRST_MESSAGE,
      releases: sinceFirstMessage.length,
      downloads: sum(sinceFirstMessage, "downloads"),
      atLeast: true          // older versions were downloaded after that date too
    },
    versions,
    note: "GitHub's own download counters, public at the address above. They count downloads, not people. " +
      "Versions before " + SPLIT_FROM + " used one file for both installing and updating, so those cannot be told apart; " +
      "from " + SPLIT_FROM + " the install command and the app's updater fetch different files, and the split is exact. " +
      "Mac uses one file for both either way."
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`${out}: ${versions.length} releases, ${data.byOthers.downloads} downloads by other people ` +
    `(${data.totals.downloads} counted, less one per version for the build machine) ` +
    `(${data.totals.mac} of them Mac); at least ${data.sinceFirstMessage.downloads} since ${FIRST_MESSAGE}; ` +
    `installs vs updates separated from ${SPLIT_FROM}`);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
