/**
 * usage.js — counting, exactly, how many computers use this app.
 *
 * The funding case for this work rests on how many people use the app. That
 * used to be guessed from download counts; now it is a count, and it is
 * written plainly in the app and on the website, because people should never
 * discover this by reading the code.
 *
 * One kind of note goes to The Gonka Network Onboarding Hub:
 *
 *   "open"   the app was opened:
 *            { kind, install, version, os, at }
 *            at most once an hour, so a computer counts once however often it
 *            is opened.
 *
 *   install   a random number made on this computer the first time, so two
 *             computers are not counted as one. It is not derived from
 *             anything — not the machine, not the wallet, not a person.
 *   team      present and true on our own copies, so we never count ourselves
 *             (see teamCopy below).
 *
 * What is never sent: anything typed, any file, any key, any wallet or
 * address, any server, any name or email, and nothing about what anyone does
 * in the app — only that it was opened.
 *
 * The address lives in knowledge.js and can be changed through the published
 * manifest. If it is unset, nothing is ever sent.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const K = require("../knowledge");

const OPEN_EVERY = 60 * 60 * 1000;  // an "opened" note at most hourly
// The folder is named after Use Gonka, which this file once counted too. It
// keeps that name: the computer's random number lives in it, and a new file
// would make every existing copy count as a new computer.
const file = () => path.join(app.getPath("userData"), "use-gonka", "usage.json");

function write(u) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(u, null, 2));
  } catch (_) { /* counting must never get in the way of using the app */ }
}

/** The computer's random number is made once and kept. */
function read() {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) {
    const u = { install: crypto.randomBytes(8).toString("hex") };
    write(u);
    return u;
  }
}

/**
 * Our own copies say so, so the public numbers never include us. A copy is
 * ours when a file called team-copy.txt sits in its data folder. It can only
 * make a computer stop counting, never start, so nobody gains anything by
 * creating it — and the website also leaves out the copies we know are ours.
 */
function teamCopy() {
  try { return fs.existsSync(path.join(app.getPath("userData"), "team-copy.txt")); } catch (_) { return false; }
}

/**
 * Only a real installed copy, run by a person, ever reports. Two things look
 * exactly like one and are not:
 *
 *   - our automated build checks start the freshly built app to test it. The
 *     first build after "opened" notes were added counted its own Windows and
 *     Mac machines as two computers using GNOT, eight minutes before anyone
 *     could have downloaded that version.
 *   - a copy run straight from the source code while working on the app.
 *
 * Both send nothing at all. isPackaged is false for anything not built into an
 * installer. A build machine is known two ways, because one was not enough:
 * CI and GITHUB_ACTIONS are set in its shell — but on a Mac the app is opened
 * through `open`, which starts it without the shell's settings, so the 1.4.0
 * build's Mac machine reported itself and was counted as a person. So the
 * build also leaves a file called build-machine.txt in the app's data folder
 * before it starts the app (.github/workflows/build.yml), and that is checked
 * here too.
 */
function buildMachine() {
  try { return fs.existsSync(path.join(app.getPath("userData"), "build-machine.txt")); } catch (_) { return false; }
}
const automated = () => !!(process.env.CI || process.env.GITHUB_ACTIONS) || app.isPackaged === false || buildMachine();
const endpoint = () => (automated() ? "" : (K.get().usageEndpoint || "").trim());

/** The app's own version. app.getVersion() reports Electron's in a dev run. */
function appVersion() {
  try { return require("../../package.json").version; } catch (_) { return app.getVersion(); }
}

const stamp = () => ({ install: read().install, version: appVersion(), os: process.platform, ...(teamCopy() ? { team: true } : {}) });

async function post(body, timeout) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error("usage endpoint answered " + res.status);
}

let opening = null;

/** The app is open. At most once an hour; see the note at the top. */
async function opened({ timeout = 10000 } = {}) {
  if (!endpoint()) return { sent: false, why: "no address set" };
  if (opening) return { sent: false, why: "already sending" };
  if (Date.now() - (read().lastOpen || 0) < OPEN_EVERY) return { sent: false, why: "told recently" };
  const body = { kind: "open", ...stamp(), at: new Date().toISOString() };
  opening = (async () => {
    await post(body, timeout);
    const u = read();
    u.lastOpen = Date.now();
    write(u);
    return { sent: true, body };
  })();
  try { return await opening; } finally { opening = null; }
}

module.exports = { opened };
