/**
 * check-chain.js — does this app still fit the live Gonka network?
 *
 *   node scripts/check-chain.js                         report; exit 1 if something is broken
 *   node scripts/check-chain.js <previous.json> <out>   also write the result (compat.json)
 *
 * Gonka changes under the app's feet. On 8 October 2026 the chain went to
 * v0.2.16: one permission the app grants stopped existing, three new ones
 * appeared, and hosts began paying fees. Gonka Host Setup broke at the grant
 * step and nothing noticed, because nothing compared the app with the network.
 * This does, every day and before every release:
 *
 *   1. which version the chain runs, and whether an upgrade is scheduled;
 *   2. the permission list: ours against the one in Gonka's own code at the
 *      live version (and at the scheduled one, so we know BEFORE it happens);
 *   3. a dry run of the grant transaction on the live chain — the chain says
 *      whether it would go through; nothing is signed and nothing is sent;
 *   4. the chain's fee rules against what the app charges and tells people;
 *   5. the files and commands the setup relies on: Gonka's deploy folder, its
 *      settings template, and the quickstart guide;
 *   6. every network address the app reads;
 *   7. what is new since last time: models, proposals, version tags.
 *
 * "problems" are things that break a setup or mislead a person today.
 * "changes" are news: something at Gonka moved since the last look, and a
 * person should read it. A machine can catch a list that no longer matches; it
 * cannot understand a new idea such as "hosts now pay fees". That is why the
 * app records what it was last checked against (knowledge.js checkedAgainst)
 * and this goes red when the network has moved past it.
 *
 * If the chain cannot be reached at all it fails without writing, so the
 * previous result stays published. A single source being down (GitHub, the
 * docs site) is reported as "could not check", never as a problem.
 */
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const K = require("../src/knowledge");
const wallet = require("../src/services/wallet");

const [prevPath, outPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const UPSTREAM = "gonka-ai/gonka";
const RAW = `https://raw.githubusercontent.com/${UPSTREAM}`;
const PERMS_FILE = "inference-chain/x/inference/permissions.go";
// An account that exists on chain, used only as the "from" of the dry run. It
// is the first node this app ever registered; its address and public key are
// public. Nothing is signed with it and nothing is sent.
const DRY_RUN_ACCOUNT = "gonka1k5w0zarzz3maqh8t4y9cax6eqqfldy7kphzc74";
// keys.js grantMlOps sizes the grant at simulated gas x 1.2.
const GRANT_GAS_ADJUSTMENT = 1.2;
const NGONKA_PER_GNK = 1e9;
// Commands the app runs on the server, which must still be the guide's own.
const LAUNCH_COMMANDS = [
  "docker compose -f docker-compose.yml -f docker-compose.mlnode.yml up -d",
  "docker compose up tmkms node -d --no-deps"
];

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const short = (typeUrl) => String(typeUrl).split(".").pop();

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "gnot-check-chain", ...headers }, signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: "", json: null, error: e.message };
  }
}
const github = (p) => get(`https://api.github.com/repos/${UPSTREAM}/${p}`,
  process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {});

/** "v0.2.16-post1" -> [0, 2, 16]; null when it is not a version. */
function versionOf(name) {
  const m = String(name || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const baseVersion = (name) => { const v = versionOf(name); return v ? "v" + v.join(".") : String(name); };

/** The permission list in Gonka's code at one tag, as type URLs. */
async function upstreamPermissions(tagName) {
  const refs = [`release/${tagName}`, `release/${baseVersion(tagName)}`];
  for (const ref of [...new Set(refs)]) {
    const r = await get(`${RAW}/${ref}/${PERMS_FILE}`);
    if (r.status !== 200) continue;
    const block = (r.text.match(/InferenceOperationKeyPerms\s*=\s*\[\]sdk\.Msg\{([\s\S]*?)\n\}/) || [])[1];
    if (!block) return { ref, error: "the list was not where it used to be in permissions.go" };
    const list = [], unknown = [];
    for (const m of block.matchAll(/&(\w+)\.(Msg\w+)\{\}/g)) {
      if (m[1] === "types") list.push(`/inference.inference.${m[2]}`);
      else if (m[1] === "blstypes") list.push(`/inference.bls.${m[2]}`);
      else unknown.push(`${m[1]}.${m[2]}`);
    }
    if (unknown.length) return { ref, error: "message types from a package this check does not know: " + unknown.join(", ") };
    return { ref, list };
  }
  return { error: `no permissions.go found for ${tagName} (looked at ${refs.join(", ")})` };
}

/** Would the chain accept a grant of these permissions? Nothing is sent. */
async function dryRunGrant(seed, perms, feeAllowance) {
  const acct = await get(`${seed}/chain-api/cosmos/auth/v1beta1/accounts/${DRY_RUN_ACCOUNT}`);
  const a = acct.json && acct.json.account;
  if (!a || !a.pub_key) return { unknown: "could not read the dry-run account from the chain" };
  const pub = Buffer.from(a.pub_key.key, "base64");
  // A grantee nobody owns: made up now, thrown away at once.
  const grantee = wallet.addressOf(wallet.pubOf(crypto.randomBytes(32)));
  const expiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const messages = perms.map((p) => wallet.Msg.grant(DRY_RUN_ACCOUNT, grantee, p, expiration));
  messages.push(wallet.Msg.grantAllowance(DRY_RUN_ACCOUNT, grantee,
    [{ denom: wallet.DENOM, amount: String(feeAllowance) }], expiration));
  const { txBody, authInfo, txRaw } = wallet._internal;
  const raw = txRaw(txBody(messages, "dry run"), authInfo(pub, BigInt(a.sequence || 0), { amount: [], gas: 0 }), [Buffer.alloc(0)]);
  try {
    return { gas: await wallet.simulate(seed, raw) };
  } catch (e) {
    const said = String(e.message).replace(/^failed to simulate gas:\s*/, "");
    // The chain's own refusal is the answer; anything else is a failed check.
    const refused = said.match(/message index: \d+: (.*?)(?: \[|$)/);
    return refused ? { refused: refused[1].trim() } : { unknown: said.slice(0, 200) };
  }
}

/** Lines of the quickstart that are commands, so a changed command shows up. */
function commandsIn(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<\/(p|div|pre|li|h\d|tr)>/g, "\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length < 240 && /^(sudo )?(\.\/)?(docker compose|inferenced |curl |git clone|export [A-Z_]+=)/.test(l));
  return [...new Set(lines)].sort();
}

(async () => {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch (_) { /* first run */ }
  const was = prev.seen || {};
  await K.loadRemoteManifest();
  const k = K.get();
  const now = new Date().toISOString();

  const problems = [], warnings = [], unknown = [], changes = [];
  const problem = (id, text) => problems.push({ id, text });
  const changed = (text) => changes.push({ at: now, text });
  const seen = {};

  /* ---- 1. the chain itself ------------------------------------------- */
  let seed = null, version = null, height = 0;
  for (const s of k.seedNodes) {
    const r = await get(`${s}/chain-rpc/abci_info`);
    const info = r.json && r.json.result && r.json.result.response;
    if (info && info.version) { seed = s; version = info.version; height = Number(info.last_block_height); break; }
  }
  if (!seed) throw new Error("no Gonka node answered — nothing can be checked");
  seen.chainVersion = version;
  if (was.chainVersion && was.chainVersion !== version) changed(`Gonka's chain went from ${was.chainVersion} to ${version}.`);

  const checked = k.checkedAgainst || {};
  const live = versionOf(version), known = versionOf(checked.chain);
  if (live && known && cmp(live, known) > 0) {
    problem("chain-newer", `Gonka runs ${version}. This app was last checked against ${checked.chain} (${checked.on}), ` +
      `and a node was last set up with it from start to finish on ${checked.realRun}. It needs a look and a real run.`);
  }
  // Everything below compares lists and files. Only setting up a real node
  // proves the whole thing, so say how long ago that last happened.
  const sinceRun = Math.floor((Date.now() - Date.parse(checked.realRun)) / 864e5);
  if (sinceRun > 45) {
    warnings.push(`No node has been set up with this app from start to finish for ${sinceRun} days (last: ${checked.realRun}).`);
  }

  const plan = (await get(`${seed}/chain-api/cosmos/upgrade/v1beta1/current_plan`)).json;
  const upgrade = plan && plan.plan ? { name: plan.plan.name, height: Number(plan.plan.height) } : null;
  seen.upgrade = upgrade ? upgrade.name : null;
  if (upgrade) {
    warnings.push(`An upgrade to ${upgrade.name} is scheduled at block ${upgrade.height} (${upgrade.height - height} blocks from now).`);
    if (was.upgrade !== upgrade.name) changed(`Gonka scheduled an upgrade to ${upgrade.name} at block ${upgrade.height}.`);
  }

  /* ---- 2. the permission list ---------------------------------------- */
  const ours = k.mlOpsPermissions || [];
  const up = await upstreamPermissions(version);
  let fix = null;
  if (up.list) {
    const missing = up.list.filter((p) => !ours.includes(p)), extra = ours.filter((p) => !up.list.includes(p));
    if (missing.length) problem("permissions-missing", `The chain's own list (${up.ref}) grants ${missing.map(short).join(", ")}; the app does not.`);
    if (extra.length) problem("permissions-extra", `The app grants ${extra.map(short).join(", ")}, which Gonka's list (${up.ref}) no longer has.`);
    seen.permissions = sha(up.list.join("\n"));
    if (was.permissions && was.permissions !== seen.permissions) changed(`Gonka's permission list changed (${up.ref}).`);
    if (missing.length || extra.length) fix = up.list;
  } else {
    unknown.push("permission list: " + up.error);
    seen.permissions = was.permissions;
  }
  if (upgrade) {
    const next = await upstreamPermissions(upgrade.name);
    if (next.list) {
      const add = next.list.filter((p) => !ours.includes(p)), drop = ours.filter((p) => !next.list.includes(p));
      if (add.length || drop.length) {
        warnings.push(`The scheduled upgrade ${upgrade.name} changes the permission list: ` +
          [add.length && "adds " + add.map(short).join(", "), drop.length && "drops " + drop.map(short).join(", ")].filter(Boolean).join("; ") + ".");
      }
    } else unknown.push(`permission list of the scheduled upgrade: ${next.error}`);
  }

  /* ---- 3. dry run of the grant on the live chain --------------------- */
  const run = await dryRunGrant(seed, ours, k.mlOpsFeeAllowanceNgonka);
  let grantFee = null;
  if (run.refused) problem("grant-refused", `The live chain refuses the grant this app sends: "${run.refused}"`);
  else if (run.unknown) unknown.push("dry run of the grant: " + run.unknown);
  else grantFee = Math.floor(run.gas * GRANT_GAS_ADJUSTMENT) * Number(k.gasPriceNgonka);
  // A corrected list is only worth publishing if the chain accepts it.
  if (fix) {
    const again = await dryRunGrant(seed, fix, k.mlOpsFeeAllowanceNgonka);
    if (again.gas && fix.every((p) => p.startsWith("/inference."))) {
      fix = { mlOpsPermissions: fix, gas: again.gas };
    } else {
      fix = null;
    }
  }

  /* ---- 4. fees -------------------------------------------------------- */
  const params = (await get(`${seed}${k.api.inferenceParams}`)).json;
  const fees = params && params.params && params.params.fee_params;
  if (fees) {
    const groups = (fees.groups || []).filter((g) => (fees.enabled_fee_groups || []).includes(g.name));
    seen.fees = sha(JSON.stringify(fees));
    if (was.fees && was.fees !== seen.fees) changed("Gonka's fee rules changed.");
    const handled = checked.feeGroups || [];
    for (const g of groups) {
      if (handled.includes(g.name)) continue;
      const what = (g.msgs || []).map((m) => short(m.type_url)).join(", ");
      problem("fees-" + g.name, `The chain charges fees in a group the app was never taught about: "${g.name}"` +
        (what ? ` (${what})` : "") + ` at ${g.min_gas_price} ngonka per gas.`);
    }
    const cosmos = groups.find((g) => g.name === "cosmos");
    const need = cosmos ? Number(cosmos.min_gas_price) : Number(fees.min_gas_price_ngonka || 0);
    const pay = Number(k.gasPriceNgonka);
    if (pay < need) problem("gas-price-low", `The app pays ${pay} ngonka per gas; the chain asks at least ${need}. Its transactions would be refused.`);
    else if (need > 0 && pay > need) warnings.push(`The app pays ${pay} ngonka per gas where the chain asks ${need}: ${pay / need} times what is needed.`);
  } else {
    unknown.push("fee rules: the chain's parameters could not be read");
    seen.fees = was.fees;
  }
  const claim = Math.round(parseFloat((k.faucet || {}).amount) * NGONKA_PER_GNK);
  if (grantFee && claim && grantFee > claim) {
    problem("grant-over-faucet", `The grant would cost ${grantFee.toLocaleString("en")} ngonka, more than the one faucet claim ` +
      `(${claim.toLocaleString("en")}) the app tells people is enough.`);
  }

  /* ---- 5. the files and commands the setup relies on ------------------ */
  const branch = k.repo.branch, dir = k.repo.joinDir.replace(/^gonka\//, "");
  const tpl = await get(`${RAW}/${branch}/${dir}/config.env.template`);
  if (tpl.status === 200) {
    const keys = {};
    for (const m of tpl.text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) keys[m[1]] = m[2];
    // Settings Gonka leaves as <a placeholder> must be filled by someone; the
    // wizard comments out the ones it has no answer for, so a new one matters.
    const blanks = Object.keys(keys).filter((x) => /<[^>]*>/.test(keys[x])).sort();
    seen.templateKeys = Object.keys(keys).sort();
    seen.templateBlanks = blanks;
    if (was.templateKeys) {
      const added = seen.templateKeys.filter((x) => !was.templateKeys.includes(x));
      const gone = was.templateKeys.filter((x) => !seen.templateKeys.includes(x));
      if (added.length) changed(`Gonka's settings template has new settings: ${added.join(", ")}.`);
      if (gone.length) changed(`Gonka's settings template dropped: ${gone.join(", ")}.`);
      const newBlanks = blanks.filter((x) => !(was.templateBlanks || []).includes(x));
      if (newBlanks.length) changed(`New settings that need a value from the person: ${newBlanks.join(", ")}.`);
    }
  } else {
    unknown.push("settings template: could not be fetched");
    seen.templateKeys = was.templateKeys; seen.templateBlanks = was.templateBlanks;
  }
  const compose = await get(`${RAW}/${branch}/${dir}/docker-compose.yml`);
  const mlnode = await get(`${RAW}/${branch}/${dir}/docker-compose.mlnode.yml`);
  if (compose.status === 200) {
    for (const svc of ["tmkms", "node", "api"]) {
      if (!new RegExp(`^  ${svc}:`, "m").test(compose.text)) problem("compose-" + svc, `Gonka's docker-compose.yml no longer has the "${svc}" service the app starts.`);
    }
  } else if (compose.status === 404) problem("compose-gone", "docker-compose.yml is no longer in Gonka's deploy folder.");
  else unknown.push("docker-compose.yml: could not be fetched");
  if (mlnode.status === 404) problem("mlnode-gone", "docker-compose.mlnode.yml is no longer in Gonka's deploy folder.");

  const commits = await github(`commits?path=${dir}&per_page=1`);
  const last = Array.isArray(commits.json) && commits.json[0];
  if (last) {
    seen.deploy = last.sha.slice(0, 12);
    if (was.deploy && was.deploy !== seen.deploy) {
      changed(`Gonka changed its deploy folder on ${last.commit.committer.date.slice(0, 10)}: "${last.commit.message.split("\n")[0].slice(0, 100)}".`);
    }
  } else { unknown.push("deploy folder history: GitHub did not answer"); seen.deploy = was.deploy; }

  const guide = await get(k.docs.quickstart);
  if (guide.status === 200) {
    const cmds = commandsIn(guide.text);
    seen.guide = cmds;
    for (const c of LAUNCH_COMMANDS) {
      if (!cmds.includes(c)) problem("guide-command", `The quickstart no longer has the command the app runs: "${c}".`);
    }
    if (was.guide) {
      const added = cmds.filter((c) => !was.guide.includes(c)), gone = was.guide.filter((c) => !cmds.includes(c));
      if (added.length || gone.length) {
        changed(`The quickstart's commands changed (${added.length} new, ${gone.length} gone)` +
          (added.length ? `. New: ${added.slice(0, 4).join(" | ")}` : "") + ".");
      }
    }
  } else { unknown.push("quickstart guide: could not be fetched"); seen.guide = was.guide; }

  /* ---- 6. every address the app reads --------------------------------- */
  const reads = [k.api.governanceModels, k.api.epochParticipants, k.api.latestEpoch, k.api.inferenceParams,
    k.api.accounts + DRY_RUN_ACCOUNT, k.api.participants + DRY_RUN_ACCOUNT, k.api.chainRpc + "status"];
  for (const p of reads) {
    const r = await get(seed + p);
    if (r.status === 404) problem("address-gone", `The network no longer answers at ${p} — the app reads it.`);
    else if (r.status !== 200) unknown.push(`${p}: answered ${r.status || r.error}`);
  }

  /* ---- 7. what is new -------------------------------------------------- */
  const models = (await get(seed + k.api.governanceModels)).json;
  if (models && Array.isArray(models.models)) {
    seen.models = models.models.map((m) => m.id).sort();
    if (was.models) {
      const added = seen.models.filter((m) => !was.models.includes(m)), gone = was.models.filter((m) => !seen.models.includes(m));
      if (added.length) changed(`New model on the network: ${added.join(", ")}.`);
      if (gone.length) changed(`Model removed from the network: ${gone.join(", ")}.`);
    }
  } else seen.models = was.models;

  const gov = (await get(`${seed}/chain-api/cosmos/gov/v1/proposals?pagination.reverse=true&pagination.limit=8`)).json;
  if (gov && Array.isArray(gov.proposals)) {
    seen.proposal = Math.max(0, ...gov.proposals.map((p) => Number(p.id)));
    for (const p of gov.proposals.filter((x) => was.proposal && Number(x.id) > was.proposal).reverse()) {
      const kinds = (p.messages || []).map((m) => short(m["@type"]));
      changed(`New proposal #${p.id}: "${String(p.title).slice(0, 110)}", voting until ${String(p.voting_end_time).slice(0, 10)}` +
        (kinds.includes("MsgSoftwareUpgrade") ? " — this one upgrades the chain." : "."));
    }
  } else seen.proposal = was.proposal;

  try {
    const out = execFileSync("git", ["ls-remote", "--tags", `https://github.com/${UPSTREAM}.git`, "refs/tags/release/v*"],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
    const tags = [...new Set(out.split("\n").map((l) => (l.split("refs/tags/release/")[1] || "").replace(/\^\{\}$/, "")).filter(Boolean))];
    // Only this version and later ones: that is where the next upgrade appears.
    seen.tags = tags.filter((t) => { const v = versionOf(t); return v && live && cmp(v, live) >= 0; }).sort();
    if (was.tags) {
      const fresh = seen.tags.filter((t) => !was.tags.includes(t));
      if (fresh.length) changed(`Gonka tagged ${fresh.join(", ")} in its code — a sign of what comes next.`);
    }
  } catch (_) { unknown.push("version tags: git could not list them"); seen.tags = was.tags; }

  /* ---- result ---------------------------------------------------------- */
  const result = {
    asOf: now,
    ok: problems.length === 0,
    chain: { version, height, upgrade },
    checkedAgainst: checked,
    problems, warnings, unknown,
    // What a corrected permission list would be: Gonka's own, inference
    // messages only, and accepted by the live chain in a dry run.
    fix,
    grant: grantFee ? { feeNgonka: grantFee, faucetClaimNgonka: claim || null } : null,
    // News, newest first; the last sixty are kept.
    changes: [...changes.reverse(), ...(prev.changes || [])].slice(0, 60),
    seen
  };

  console.log(`Gonka ${version} at block ${height}. App last checked against ${checked.chain || "nothing"}.`);
  if (changes.length) console.log("\nNew since last time:\n" + changes.map((c) => "  - " + c.text).join("\n"));
  if (warnings.length) console.log("\nWorth knowing:\n" + warnings.map((w) => "  - " + w).join("\n"));
  if (unknown.length) console.log("\nCould not check:\n" + unknown.map((u) => "  - " + u).join("\n"));
  if (fix) console.log(`\nA corrected permission list (${fix.mlOpsPermissions.length} types) passes a dry run on the live chain.`);
  console.log(problems.length ? "\nBROKEN — " + problems.length + " problem(s):\n" + problems.map((p) => "  x " + p.text).join("\n")
    : "\nOK — the app fits the live network.");

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 1) + "\n");
  // Written out, the answer is in the file; on its own, the exit code is the answer.
  if (problems.length && (!outPath || process.argv.includes("--strict"))) process.exit(1);
})().catch((e) => { console.error("check-chain failed: " + e.message); process.exit(2); });
