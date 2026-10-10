/**
 * publish-settings.js — change the app's published settings without a release.
 *
 *   node scripts/publish-settings.js            → shows what would change; changes nothing
 *   node scripts/publish-settings.js --confirm  → publishes it
 *
 * manifest.json on the public repo is read by every installed copy each time
 * it starts, and whatever it holds replaces the facts built into the app
 * (src/knowledge.js `overridable`). That is how a change at Gonka can be
 * answered the same day: when the chain's v0.2.16 dropped a permission the app
 * granted, the corrected list went out this way.
 *
 * This publishes website/manifest.json, and only when:
 *   - the `app` block (which version is current, its files and hashes) is
 *     untouched — that belongs to scripts/release.js and scripts/publish.js;
 *   - no setting the live file has is lost;
 *   - every permission is one of Gonka's own messages;
 *   - the live chain accepts, in a dry run, the grant an installed copy would
 *     send with these settings (nothing is signed, nothing is sent).
 * Needs the GitHub CLI, logged in with write access to the public repo.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const K = require("../src/knowledge");
const wallet = require("../src/services/wallet");

const root = path.join(__dirname, "..");
const REPO = process.env.GONKA_PUBLIC_REPO || "gonkanetworkonboardinghub/gonka-host-setup";
const confirm = process.argv.includes("--confirm");
const GH = (() => {
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "gh", "bin", "gh.exe");
  return fs.existsSync(local) ? local : "gh";
})();
const gh = (args, input) => execFileSync(GH, args, { cwd: root, encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }).trim();
const die = (msg) => { console.error("\n" + msg + "\nNothing was published."); process.exit(1); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The account the dry run pretends to send from: the first node this app
// registered. Its address and public key are public; nothing is signed with it.
const DRY_RUN_ACCOUNT = "gonka1k5w0zarzz3maqh8t4y9cax6eqqfldy7kphzc74";

(async () => {
  const stagedText = fs.readFileSync(path.join(root, "website", "manifest.json"), "utf8");
  const staged = JSON.parse(stagedText);
  const file = JSON.parse(gh(["api", `repos/${REPO}/contents/manifest.json?ref=main`]));
  const liveText = Buffer.from(file.content, "base64").toString("utf8");
  const live = JSON.parse(liveText);

  if (stagedText === liveText) { console.log("website/manifest.json is already what is published. Nothing to do."); return; }
  if (!same(staged.app, live.app)) die("The `app` block differs from the published one. A new version goes out with scripts/publish.js, not this.");
  const lost = Object.keys(live).filter((key) => !(key in staged));
  if (lost.length) die("The published file has settings this one lacks: " + lost.join(", "));
  const changed = Object.keys(staged).filter((key) => !same(staged[key], live[key]));

  console.log("Settings that change for every installed copy at its next start:");
  for (const key of changed) {
    console.log(`  ${key}:`);
    console.log("    now      " + (key in live ? JSON.stringify(live[key]) : "(not set — the app uses its built-in value: " + JSON.stringify(K.get()[key]) + ")").slice(0, 400));
    console.log("    becomes  " + JSON.stringify(staged[key]).slice(0, 400));
  }

  const perms = staged.mlOpsPermissions || K.get().mlOpsPermissions;
  const foreign = perms.filter((p) => !/^\/inference\.(inference|bls)\.Msg[A-Za-z0-9]+$/.test(p));
  if (foreign.length) die("These are not Gonka's own messages, so the app must never grant them: " + foreign.join(", "));

  // What an installed copy would hold, and whether the chain accepts its grant.
  const k = { ...K.get(), ...staged };
  const seed = k.seedNodes[1];
  const acct = (await (await fetch(`${seed}/chain-api/cosmos/auth/v1beta1/accounts/${DRY_RUN_ACCOUNT}`, { signal: AbortSignal.timeout(20000) })).json()).account;
  const grantee = wallet.addressOf(wallet.pubOf(crypto.randomBytes(32)));
  const expiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const messages = k.mlOpsPermissions.map((p) => wallet.Msg.grant(DRY_RUN_ACCOUNT, grantee, p, expiration));
  messages.push(wallet.Msg.grantAllowance(DRY_RUN_ACCOUNT, grantee, [{ denom: wallet.DENOM, amount: String(k.mlOpsFeeAllowanceNgonka) }], expiration));
  const { txBody, authInfo, txRaw } = wallet._internal;
  let gas;
  try {
    gas = await wallet.simulate(seed, txRaw(txBody(messages, "dry run"),
      authInfo(Buffer.from(acct.pub_key.key, "base64"), BigInt(acct.sequence || 0), { amount: [], gas: 0 }), [Buffer.alloc(0)]));
  } catch (e) {
    die("The live chain refuses the grant these settings would send:\n  " + e.message);
  }
  const fee = Math.floor(gas * 1.2) * Number(k.gasPriceNgonka);
  console.log(`\nDry run on the live chain: the grant goes through (${k.mlOpsPermissions.length} permissions, ` +
    `${fee.toLocaleString("en")} ngonka in fees, ${fee / 1e9} GNK).`);

  if (!confirm) { console.log("\nNothing was published. Run again with --confirm to publish."); return; }

  const note = (process.argv.find((a) => a.startsWith("--note=")) || "").replace("--note=", "") || "Settings: " + changed.join(", ");
  const done = JSON.parse(gh(["api", "--method", "PUT", `repos/${REPO}/contents/manifest.json`, "--input", "-"],
    JSON.stringify({ message: note, content: Buffer.from(stagedText, "utf8").toString("base64"), sha: file.sha, branch: "main" })));
  console.log(`\nPublished: ${done.commit.html_url}`);
  console.log("Installed copies pick it up the next time they start (GitHub can take a few minutes to serve the new file).");
})().catch((e) => die(e.message));
