/**
 * epoch-watch.js — starts the data job (earnings.yml) within minutes of the
 * moment the website's numbers change on the chain.
 *
 *   node scripts/epoch-watch.js            (in .github/workflows/epoch-watch.yml)
 *   DRY_RUN=1 WATCH_MINUTES=2 node scripts/epoch-watch.js   (try it: says what it would do)
 *
 * WHY. GitHub runs the data job's "every fifteen minutes" schedule only every
 * four to six hours, so on 9 November 2026 the website still showed epoch 450's
 * pay deep into epoch 452. Each epoch's numbers settle at one predictable block:
 * the claim block, about 400 blocks (35 minutes) after the epoch's Proof of
 * Compute starts, when hosts claim the previous epoch's reward. By then the new
 * epoch's hosts and weights are known too. So this waits for that block and
 * starts the data job right after it.
 *
 * HOW LONG IT RUNS. Only while that block is within reach of one run (about five
 * and a half hours); when it is further away it stops at once and leaves it to
 * the next start. It is started on its own schedule and at the end of every data
 * job run, so one of them is nearly always waiting when an epoch turns. When the
 * data is behind the chain it starts the data job straight away.
 */
const K = require("../src/knowledge");
const monitor = require("../src/services/monitor");

const REPO = process.env.GITHUB_REPOSITORY || "gonkanetworkonboardinghub/gonka-network-onboarding-tool";
const TOKEN = process.env.GH_TOKEN || "";
const DRY = !!process.env.DRY_RUN;
const MAX_MS = (Number(process.env.WATCH_MINUTES) || 335) * 60 * 1000;
const MARGIN_BLOCKS = 20;               // about two minutes after the claim block
const START = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const left = () => MAX_MS - (Date.now() - START);
const say = (s) => console.log(new Date().toISOString().slice(11, 19) + "  " + s);

/** What the data branch says now: the epoch it read and the last epoch whose pay it has. */
async function published() {
  const url = TOKEN
    ? `https://api.github.com/repos/${REPO}/contents/earnings.json?ref=data`
    : `https://raw.githubusercontent.com/${REPO}/data/earnings.json?t=${Date.now()}`;
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github.raw" } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`earnings.json -> ${res.status}`);
  const j = await res.json();
  return { epoch: Number(j.epoch && j.epoch.index) || 0, paid: Number(j.epoch && j.epoch.paidEpoch) || 0, asOf: j.asOf };
}

async function startDataJob(why) {
  if (DRY) { say(`would start the data job now: ${why}`); return; }
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/earnings.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: "main" }),
    signal: AbortSignal.timeout(20000)
  });
  if (res.status !== 204) throw new Error(`could not start the data job: ${res.status} ${await res.text()}`);
  say(`started the data job: ${why}`);
}

(async () => {
  const seeds = K.get().seedNodes;
  let tries = 0;
  while (left() > 60 * 1000) {
    const [now, pub] = await Promise.all([monitor.epochNow(seeds), published()]);
    const behind = pub.epoch < now.index || pub.paid < now.index - 1;
    const settled = now.height >= now.claimMoney + MARGIN_BLOCKS;
    if (behind && settled) {
      if (tries >= 3) { say("the data job ran three times and the data is still behind; stopping"); return; }
      tries++;
      await startDataJob(`chain epoch ${now.index}, published ${pub.epoch} (pay of ${pub.paid})`);
      // The data job takes about four minutes; look again after it.
      await sleep(Math.min(8 * 60 * 1000, Math.max(0, left() - 30 * 1000)));
      if (DRY) return;
      continue;
    }
    // The next moment the numbers change: this epoch's claim block if it has
    // not passed yet, otherwise the next epoch's.
    const target = (settled ? now.nextClaimMoney : now.claimMoney) + MARGIN_BLOCKS;
    const waitMs = Math.max(0, (target - now.height) * now.secPerBlock * 1000);
    if (waitMs > left() - 60 * 1000) {
      say(`up to date (epoch ${pub.epoch}, pay of ${pub.paid}); the next change is ${(waitMs / 3600000).toFixed(1)} h away, beyond this run; stopping`);
      return;
    }
    say(`waiting ${(waitMs / 60000).toFixed(0)} min for block ${target} (epoch ${now.index}, published ${pub.epoch}, pay of ${pub.paid})`);
    if (DRY) return;
    // Wake a little early and look again: block times drift.
    await sleep(Math.max(60 * 1000, Math.min(waitMs - 30 * 1000, 20 * 60 * 1000)));
  }
  say("this run's time is up");
})().catch((e) => { console.error("epoch-watch: " + e.message); process.exit(1); });
