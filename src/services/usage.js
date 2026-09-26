/**
 * usage.js — counting how much the Gonka network is used through this app.
 *
 * The whole point of Use Gonka is to bring people to the Gonka network, and
 * nobody can see whether that is working unless something says so. So the app
 * keeps a running count of answers and tokens and sends the total to The Gonka
 * Network Onboarding Hub — once a day, and when the app is closed. It is written plainly in the app and on the
 * website, because people should never discover this by reading the code.
 *
 * What is sent, once a day and when the app is closed:
 *
 *   { install, version, os, answers, tokens, models: {...}, services: [...] }
 *
 *   install   a random number made on this computer the first time, so two
 *             computers are not counted as one. It is not derived from
 *             anything — not the machine, not the wallet, not a person.
 *   answers   how many replies came back
 *   tokens    how many tokens those replies cost, as the service reported
 *   models    which models, and how many answers from each
 *   services  which services were used (by name, not by account)
 *
 * What is never sent: anything typed or answered, any file, any API key, any
 * wallet or address, any name or email. Nothing from Gonka Host Setup either —
 * this counts Use Gonka only.
 *
 * WHEN it is sent matters as much as what. Counting only on the way in was
 * wrong: somebody who opened the app, used it all afternoon and then did not
 * come back for a fortnight was not counted at all in the meantime, and if
 * they never came back, never. So it goes out on the way out too — closing the
 * app sends whatever is waiting, with a short deadline so quitting is never
 * held up. Nothing is lost either way: what is waiting stays in the file until
 * a send succeeds.
 *
 * The address it is sent to lives in knowledge.js and can be changed through
 * the published manifest. If it is unset, nothing is ever sent.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const K = require("../knowledge");

const DAY = 24 * 60 * 60 * 1000;
const MIN_GAP = 30 * 1000;      // never two sends within half a minute of each other
const MAX_A_DAY = 8;            // the endpoint refuses more than 20 from one computer
const QUIT_MS = 2500;           // how long closing the app may wait for the send
const file = () => path.join(app.getPath("userData"), "use-gonka", "usage.json");

function read() {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch (_) {
    return { install: crypto.randomBytes(8).toString("hex"), pending: blank(), lastSent: 0, totals: { answers: 0, tokens: 0 } };
  }
}
const blank = () => ({ answers: 0, tokens: 0, models: {}, services: {}, since: new Date().toISOString() });

function write(u) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(u, null, 2));
  } catch (_) { /* counting must never get in the way of using the app */ }
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
  send().catch(() => {});      // posts only if a day has passed; see send()
}

/** What this computer has counted, so the app can show the person their own numbers. */
function mine() {
  const u = read();
  return { install: u.install, totals: u.totals, waiting: u.pending || blank(), lastSent: u.lastSent || 0, endpoint: endpoint() };
}

const endpoint = () => (K.get().usageEndpoint || "").trim();

/** The app's own version. app.getVersion() reports Electron's in a dev run. */
function appVersion() {
  try { return require("../../package.json").version; } catch (_) { return app.getVersion(); }
}

/** Which day it is where this computer is, for the daily cap. */
const today = () => new Date().toISOString().slice(0, 10);
const sentToday = (u) => ((u.sends || {}).day === today() ? u.sends.n : 0);

/**
 * Sends what is waiting. Routinely that is once a day; `now` is the app
 * closing, which sends whatever is waiting there and then — still not twice
 * within half a minute, and no more than a handful of times a day.
 */
async function send({ now = false, timeout = 10000 } = {}) {
  const url = endpoint();
  if (!url) return { sent: false, why: "no address set" };
  const u = read();
  const p = u.pending || blank();
  if (!p.answers) return { sent: false, why: "nothing to send" };
  const since = Date.now() - (u.lastSent || 0);
  if (!now && since < DAY) return { sent: false, why: "sent recently" };
  if (now && since < MIN_GAP) return { sent: false, why: "just sent" };
  if (now && sentToday(u) >= MAX_A_DAY) return { sent: false, why: "enough for today" };
  const body = {
    install: u.install,
    version: appVersion(),
    os: process.platform,
    answers: p.answers,
    tokens: p.tokens,
    models: p.models,
    services: Object.keys(p.services),
    since: p.since,
    until: new Date().toISOString()
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error("usage endpoint answered " + res.status);
  u.pending = blank();
  u.lastSent = Date.now();
  u.sends = { day: today(), n: sentToday(u) + 1 };
  write(u);
  return { sent: true, body };
}

/**
 * The app is closing. Send what is waiting, give up quickly, and never throw —
 * a total that cannot be sent is not a reason to keep somebody's app open.
 */
async function flush() {
  try { return await send({ now: true, timeout: QUIT_MS }); }
  catch (_) { return { sent: false, why: "could not be sent" }; }
}

module.exports = { record, mine, send, flush };
