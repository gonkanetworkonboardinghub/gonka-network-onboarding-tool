/**
 * netdata.js — live reads from the Gonka network, from the app's main
 * process. Nothing here is hard-coded: models, params, and weights are
 * fetched at runtime so the wizard stays correct when the network changes.
 */
const K = require("../knowledge");

async function firstReachableSeed() {
  const k = K.get();
  for (const base of k.seedNodes) {
    try {
      const res = await fetch(base + k.api.epochParticipants, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return base;
    } catch (_) {}
  }
  return k.seedNodes[0];
}

async function getJson(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Authoritative, governance-approved model list. */
async function governanceModels(seed) {
  const k = K.get();
  const j = await getJson(seed + k.api.governanceModels);
  return (j.models || []).map((m) => ({ id: m.id, args: m.model_args || m.args || null, v_ram: m.v_ram || null }));
}

async function participant(seed, address) {
  const k = K.get();
  try { return await getJson(seed + k.api.participants + address); }
  catch (_) { return null; }
}

async function account(seed, address) {
  const k = K.get();
  try { return await getJson(seed + k.api.accounts + address); }
  catch (_) { return null; }
}

async function epochParticipants(seed) {
  const k = K.get();
  return getJson(seed + k.api.epochParticipants);
}

/**
 * Which models are actually being served and earned on THIS epoch, by how
 * many hosts — the chain's own active-participant list, so it can't be
 * stale docs or marketing. A governance-approved model with zero active
 * hosts is a caution sign (paused, re-bootstrapping, or abandoned).
 */
async function modelActivity(seed) {
  const ep = await epochParticipants(seed);
  const list = (ep && ep.active_participants && ep.active_participants.participants) || [];
  const act = {};
  for (const p of list) {
    for (const m of p.models || []) {
      if (!act[m]) act[m] = { hosts: 0, weight: 0 };
      act[m].hosts++;
      act[m].weight += Number(p.weight) || 0;
    }
  }
  return act;
}

async function chainStatus(seed) {
  const k = K.get();
  try { return await getJson(seed + "/chain-rpc/status"); } catch (_) { return null; }
}

/**
 * When does the next Proof of Compute round start? The chain publishes the
 * exact start block (epoch_stages.next_poc_start); converting to wall-clock
 * time just needs the real block rate, measured from two block timestamps.
 * Epochs are ~23h, so the start time drifts earlier every day — this is the
 * only reliable way to plan a launch window.
 */
/** Current network tip height — cheap enough to poll from the Verify page. */
async function chainHeight(seed) {
  const now = await getJson(seed + "/chain-rpc/block");
  return { height: Number(now.result.block.header.height) };
}

async function nextPoc(seed) {
  const k = K.get();
  const j = await getJson(seed + k.api.latestEpoch);
  const now = await getJson(seed + "/chain-rpc/block");
  const h = Number(now.result.block.header.height);
  const tNow = Date.parse(now.result.block.header.time);
  const back = Math.max(1, h - 5000);
  const old = await getJson(seed + "/chain-rpc/block?height=" + back);
  const tOld = Date.parse(old.result.block.header.time);
  const secPerBlock = (tNow - tOld) / 1000 / (h - back);
  const nextStart = Number(j.epoch_stages && j.epoch_stages.next_poc_start);
  if (!nextStart || !isFinite(secPerBlock) || secPerBlock <= 0) throw new Error("Epoch data unavailable");
  const startBlock = Number(j.epoch_stages && j.epoch_stages.poc_start) || 0;
  const blocksLeft = nextStart - h;
  return {
    phase: j.phase || "",
    blocksLeft,
    etaMs: Math.max(0, blocksLeft * secPerBlock * 1000),
    secPerBlock,
    // for the epoch progress bar: how far along the current epoch is
    totalBlocks: startBlock ? nextStart - startBlock : 0
  };
}

function parseGithubRepo(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/.]+?)(\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * For every reference node-config-*.json file currently in the repo, reads
 * which GPU class it targets (from the filename) and how many GPUs each
 * model in it needs (from its --tensor-parallel-size vLLM arg) — read
 * directly from GitHub, so it reflects whatever the repo has right now
 * without needing a server connection or an app update.
 * Returns rows: { file, gpuClass, model, gpuCount }.
 */
/**
 * Do the Docker images this deployment needs actually have a build for the
 * server's CPU architecture? Gonka has shipped releases (0.2.14) published
 * arm64-only, which makes an x86 host fail deep into the launch sequence with
 * confusing errors — a failed pull, or a chain node that starts and dies.
 * Checking the registry first turns 20 wasted minutes into one clear message.
 * Returns [{ image, archs, ok }] for images that could be checked.
 */
async function checkImageArchs(images, wantArch = "amd64") {
  const out = [];
  for (const ref of images) {
    const m = /^ghcr\.io\/([^/]+)\/([^:@]+)(?::([^@]+))?/.exec(ref);
    if (!m) continue;                       // only ghcr images are checkable here
    const [, owner, name, tag] = m;
    if (!tag || ref.includes("@sha256:")) continue;   // digest-pinned: skip
    try {
      const tk = await fetch(`https://ghcr.io/token?scope=repository:${owner}/${name}:pull`,
        { signal: AbortSignal.timeout(8000) });
      const { token } = await tk.json();
      const res = await fetch(`https://ghcr.io/v2/${owner}/${name}/manifests/${tag}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json"
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) continue;
      const idx = await res.json();
      let archs = (idx.manifests || [])
        .map((x) => x.platform && x.platform.architecture)
        .filter((a) => a && a !== "unknown");

      // A single-architecture manifest has no platform list — the arch lives in
      // the config blob. Gonka has switched between multi-arch indexes and
      // single-arch images, and skipping the latter meant an arm64-only image
      // would pass silently, which is exactly the case this check exists for.
      if (!archs.length && idx.config && idx.config.digest) {
        try {
          const cfgRes = await fetch(`https://ghcr.io/v2/${owner}/${name}/blobs/${idx.config.digest}`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "follow",
            signal: AbortSignal.timeout(10000)
          });
          if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            if (cfg.architecture) archs = [cfg.architecture];
          }
        } catch (_) { /* leave unknown rather than guessing */ }
      }
      if (!archs.length) continue;          // genuinely undeterminable — don't guess
      out.push({ image: ref, archs: [...new Set(archs)], ok: archs.includes(wantArch) });
    } catch (_) { /* registry unreachable — never block setup on this check */ }
  }
  return out;
}

/**
 * Can a server of this architecture run the CURRENT release at all? Reads the
 * compose files straight from GitHub (no server needed), then checks the
 * registry. This runs on the Welcome page so someone learns "x86 can't join
 * right now" BEFORE renting hardware — not twenty minutes into a paid launch.
 */
async function releaseArchStatus(wantArch = "amd64") {
  const k = K.get();
  const gh = parseGithubRepo(k.repo.url);
  if (!gh) return null;
  const inRepoPath = k.repo.joinDir.split("/").slice(1).join("/");
  const ref = k.repo.checkout || k.repo.branch;
  const base = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${inRepoPath}`;
  const images = new Set();
  for (const f of ["docker-compose.yml", "docker-compose.mlnode.yml"]) {
    try {
      const res = await fetch(`${base}/${f}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const text = await res.text();
      for (const m of text.matchAll(/^\s*image:\s*(\S+)/gm)) images.add(m[1]);
    } catch (_) { /* offline — caller treats null as "unknown", never blocks */ }
  }
  if (!images.size) return null;
  const results = await checkImageArchs([...images], wantArch);
  if (!results.length) return null;
  return { arch: wantArch, checked: results.length, bad: results.filter((r) => !r.ok) };
}

async function repoGpuConfigs() {
  const k = K.get();
  const gh = parseGithubRepo(k.repo.url);
  if (!gh) return [];
  // joinDir's first segment is the local clone directory name (== repo name),
  // an artifact of `git clone` with no destination arg — not part of the
  // repo's own tree, which is what GitHub's contents API expects.
  const inRepoPath = k.repo.joinDir.split("/").slice(1).join("/");
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${inRepoPath}?ref=${k.repo.branch}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "gonka-setup-wizard" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const list = await res.json();
  // Includes the plain node-config.json (no GPU-class suffix) too, so its
  // model reference gets cross-checked against governance approval just
  // like the classed files do.
  const files = (list || []).filter((f) => /^node-config(-.*)?\.json$/.test(f.name));

  const rows = [];
  await Promise.all(files.map(async (f) => {
    if (!f.download_url) return;
    const cls = k.gpuClasses.find((c) => c.match.test(f.name));
    try {
      const cfgRes = await fetch(f.download_url, { signal: AbortSignal.timeout(10000) });
      const cfg = await cfgRes.json();
      for (const node of cfg) {
        for (const [model, def] of Object.entries(node.models || {})) {
          const args = def.args || [];
          const idx = args.indexOf("--tensor-parallel-size");
          const gpuCount = idx >= 0 ? parseInt(args[idx + 1], 10) : null;
          rows.push({ file: f.name, gpuClass: cls ? cls.id : null, model, gpuCount });
        }
      }
    } catch (_) { /* skip files that fail to fetch/parse */ }
  }));
  return rows;
}

function decToNumber(d) {
  // { value, exponent } decimal encoding used by inference params
  return Number(d.value) * Math.pow(10, Number(d.exponent));
}

/**
 * Recommended collateral, Option A from the quickstart:
 * MAX_WEIGHT × (1 − BASE_WEIGHT_RATIO) × COLLATERAL_PER_UNIT × buffer
 * If myWeight is provided (Option B), it is used instead of the network max.
 */
/**
 * This node's own weight in the current epoch.
 *
 * `/v1/epochs/current/participants` lists membership only — no weights — so
 * reading a weight from it always came back undefined and the collateral
 * advice silently fell back to the whole network's maximum. The real numbers
 * live in the epoch group's validation_weights:
 *   confirmation_weight = what Proof of Compute actually earned
 *   weight              = what counts after the collateral ratio is applied
 * Collateral has to cover the FORMER, so that is what callers should size to.
 */
async function myEpochWeight(seed, address) {
  if (!address) return null;
  const j = await getJson(seed + "/chain-api/productscience/inference/inference/current_epoch_group_data");
  const list = (j && j.epoch_group_data && j.epoch_group_data.validation_weights) || [];
  const mine = list.find((x) => x.member_address === address);
  if (!mine) return null;
  return {
    weight: Number(mine.weight) || 0,
    confirmationWeight: Number(mine.confirmation_weight) || 0,
    reputation: Number(mine.reputation) || 0
  };
}

async function recommendCollateral(seed, myWeight = null) {
  const k = K.get();
  const params = await getJson(seed + k.api.inferenceParams);
  const cp = params.params.collateral_params;
  const baseRatio = decToNumber(cp.base_weight_ratio);
  const perUnit = decToNumber(cp.collateral_per_weight_unit);

  let weight = myWeight;
  if (weight == null) {
    const ep = await epochParticipants(seed);
    const list = ep?.active_participants?.participants || [];
    weight = Math.max(...list.map((p) => Number(p.weight) || 0), 0);
  }
  const deposit = Math.round(weight * (1 - baseRatio) * perUnit * k.collateralBufferX);
  return {
    weightUsed: weight,
    baseWeightRatio: baseRatio,
    collateralPerUnit: perUnit,
    buffer: k.collateralBufferX,
    depositNgonka: deposit
  };
}

async function collateralOf(seed, address) {
  const k = K.get();
  try { return await getJson(seed + k.api.collateral + address); } catch (_) { return null; }
}

/**
 * Balance in ngonka for an address. A brand-new wallet has no on-chain
 * account until it receives funds — the chain answers 404, which means
 * "0 balance", not "couldn't check". null is reserved for real network
 * failures where the balance is genuinely unknown.
 */
async function balanceOf(seed, address) {
  const k = K.get();
  // Primary source: the chain's own bank module. The /v2/accounts index only
  // knows addresses that are already participants, so it 404s for a freshly
  // funded wallet — which made the funding watcher report 0 forever.
  try {
    const bank = await getJson(seed + "/chain-api/cosmos/bank/v1beta1/balances/" + address);
    const coins = (bank && bank.balances) || [];
    const n = coins.find((c) => /ngonka/i.test(c.denom));
    if (n) return Number(n.amount);
    if (Array.isArray(coins)) return 0;   // account exists, holds nothing
  } catch (_) { /* fall through to the participant index */ }

  let acc;
  try { acc = await getJson(seed + k.api.accounts + address); }
  catch (e) {
    if (/HTTP 404/.test(String(e && e.message))) return 0;
    return null;
  }
  const bal = acc.balances || acc.balance || acc.coins || null;
  if (Array.isArray(bal)) {
    const n = bal.find((b) => /ngonka/i.test(b.denom));
    return n ? Number(n.amount) : 0;
  }
  if (bal && bal.amount != null) return Number(bal.amount);
  if (typeof acc.balance === "number") return acc.balance;
  return 0;
}

/**
 * Probe a public URL from THIS machine — a genuine outside-in reachability
 * test for the user's node (any HTTP response, even an error page, proves
 * the port is open; only a connection failure/timeout means unreachable).
 */
async function probeUrl(url, timeout = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "manual" });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String((e && e.cause) || e).slice(0, 200) };
  }
}

module.exports = {
  firstReachableSeed, governanceModels, participant, account,
  epochParticipants, chainStatus, recommendCollateral, collateralOf, balanceOf,
  repoGpuConfigs, probeUrl, nextPoc, modelActivity, checkImageArchs, releaseArchStatus, chainHeight, myEpochWeight
};
