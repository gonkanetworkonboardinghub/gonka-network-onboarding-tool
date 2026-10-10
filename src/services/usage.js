/**
 * usage.js — counting, exactly, how many computers use this app and how much
 * of the Gonka network goes through it.
 *
 * The funding case for this work rests on two numbers: how many people use the
 * app, and how much they use Gonka through it. Both used to be estimates —
 * computers guessed from download counts, use reported once a day. Now both
 * are exact and recent, and both are written plainly in the app and on the
 * website, because people should never discover this by reading the code.
 *
 * Two kinds of note go to The Gonka Network Onboarding Hub:
 *
 *   "open"   the app was opened:
 *            { kind, install, version, os, at }
 *            at most once an hour, so a computer counts once however often it
 *            is opened. This is what makes "how many computers use the app" a
 *            count rather than a guess.
 *
 *   "usage"  answers that came back in Use Gonka:
 *            { kind, install, version, os, answers, tokens, models, services,
 *              since, until }
 *            every fifteen minutes while there is something new, when the app
 *            closes, and when it opens.
 *
 *   install   a random number made on this computer the first time, so two
 *             computers are not counted as one. It is not derived from
 *             anything — not the machine, not the wallet, not a person.
 *   team      present and true on our own copies, so we never count ourselves
 *             (see teamCopy below).
 *
 * What is never sent: anything typed or answered, any file, any API key, any
 * wallet or address, any server, any name or email, and nothing about what
 * anyone does in Gonka Host Setup — only that the app was opened.
 *
 * Nothing is lost if a send fails: what is waiting stays in the file and goes
 * with the next one. And nothing is counted twice: only what a successful send
 * actually carried is taken off what is waiting, so an answer that arrives
 * during a send waits for the next one instead of vanishing.
 *
 * The address lives in knowledge.js and can be changed through the published
 * manifest. If it is unset, nothing is ever sent.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const K = require("../knowledge");

const EVERY = 15 * 60 * 1000;       // what is waiting goes out at most this often
const OPEN_EVERY = 60 * 60 * 1000;  // an "opened" note at most hourly
const MIN_GAP = 30 * 1000;          // closing the app: never twice in half a minute
const MAX_A_DAY = 100;              // a ceiling well under what the endpoint accepts
const QUIT_MS = 2500;               // how long closing the app may wait for the send
const file = () => path.join(app.getPath("userData"), "use-gonka", "usage.json");

const blank = () => ({ answers: 0, tokens: 0, models: {}, services: {}, since: new Date().toISOString() });

function write(u) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(u, null, 2));
  } catch (_) { /* counting must never get in the way of using the app */ }
}

/**
 * The computer's random number is made once and kept. It used to be made on
 * every read until something happened to save it — harmless while only usage
 * was sent, but an "opened" note on a fresh install would have gone out under
 * one number and been followed by another.
 */
function read() {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) {
    const u = { install: crypto.randomBytes(8).toString("hex"), pending: blank(), lastSent: 0, totals: { answers: 0, tokens: 0 } };
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

/** One answer came back. Called wherever a reply finishes. */
function record({ service, model, tokens } = {}) {
  const u = read();
  u.pending = u.pending || blank();
  u.pending.answers += 1;
  u.pending.tokens += Number(tokens) || 0;
  if (model) u.pending.models[model] = (u.pending.models[model] || 0) + 1;
  if (service) u.pending.services[service] = (u.pending.services[service] || 0) + 1;
  u.totals.answers += 1;
  u.totals.tokens += Number(tokens) || 0;
  write(u);
  send().catch(() => {});      // goes only if fifteen minutes have passed; see send()
}

/** What this computer has counted, so the app can show the person their own numbers. */
function mine() {
  const u = read();
  return { install: u.install, totals: u.totals, waiting: u.pending || blank(), lastSent: u.lastSent || 0, endpoint: endpoint(), team: teamCopy() };
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

const today = () => new Date().toISOString().slice(0, 10);
const sentToday = (u) => ((u.sends || {}).day === today() ? u.sends.n : 0);
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

/** Take what a send carried off what is waiting — and only that. */
function taken(body, servicesSent) {
  const u = read();
  const p = u.pending || blank();
  p.answers = Math.max(0, p.answers - body.answers);
  p.tokens = Math.max(0, p.tokens - body.tokens);
  for (const [m, n] of Object.entries(body.models)) {
    p.models[m] = (p.models[m] || 0) - n;
    if (p.models[m] <= 0) delete p.models[m];
  }
  for (const [s, n] of Object.entries(servicesSent)) {
    p.services[s] = (p.services[s] || 0) - n;
    if (p.services[s] <= 0) delete p.services[s];
  }
  u.pending = p.answers > 0 ? { ...p, since: body.until } : blank();
  u.lastSent = Date.now();
  u.sends = { day: today(), n: sentToday(u) + 1 };
  write(u);
}

let sending = null;   // one send at a time, or two could carry the same answers

/**
 * Sends what is waiting: at most every fifteen minutes, or straight away when
 * `now` (the app is closing) — still not twice within half a minute.
 */
async function send({ now = false, timeout = 10000 } = {}) {
  if (!endpoint()) return { sent: false, why: "no address set" };
  if (sending) return { sent: false, why: "already sending" };
  const u = read();
  const p = u.pending || blank();
  if (!p.answers) return { sent: false, why: "nothing to send" };
  const since = Date.now() - (u.lastSent || 0);
  if (since < (now ? MIN_GAP : EVERY)) return { sent: false, why: now ? "just sent" : "sent recently" };
  if (sentToday(u) >= MAX_A_DAY) return { sent: false, why: "enough for today" };
  const servicesSent = { ...p.services };
  const body = {
    kind: "usage",
    ...stamp(),
    answers: p.answers,
    tokens: p.tokens,
    models: { ...p.models },
    services: Object.keys(servicesSent),
    since: p.since,
    until: new Date().toISOString()
  };
  sending = (async () => {
    await post(body, timeout);
    taken(body, servicesSent);
    return { sent: true, body };
  })();
  try { return await sending; } finally { sending = null; }
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
    const u = read();          // read again: a usage send may have written meanwhile
    u.lastOpen = Date.now();
    write(u);
    return { sent: true, body };
  })();
  try { return await opening; } finally { opening = null; }
}

/**
 * The app is closing. Send what is waiting, give up quickly, and never throw —
 * a total that cannot be sent is not a reason to keep somebody's app open.
 */
async function flush() {
  try { return await send({ now: true, timeout: QUIT_MS }); }
  catch (_) { return { sent: false, why: "could not be sent" }; }
}

module.exports = { record, mine, send, opened, flush };
