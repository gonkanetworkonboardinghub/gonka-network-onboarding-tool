/**
 * knowledge.js — the single place where Gonka-specific facts live.
 *
 * The Gonka quickstart changes often. When it does, you (the site owner)
 * update THIS file (or the remote manifest it can load) and re-release,
 * without touching the rest of the app.
 *
 * You can also host a JSON copy of `overridable` on your own website and
 * set REMOTE_MANIFEST_URL below. On every launch the app fetches it and
 * merges it over the built-in defaults, so most doc changes don't even
 * need a new app release.
 */

// Optional: e.g. "https://your-site.com/gonka-wizard-manifest.json"
// Set this to the JSON file on your website. It carries BOTH the release
// info (which version is current / minimum) and any Gonka fact overrides, so
// most changes reach users without shipping a new build at all.
// Example: "https://your-site.com/gonka-wizard/manifest.json"
const REMOTE_MANIFEST_URL =
  "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/manifest.json";

const overridable = {
  chainId: "gonka-mainnet",
  // checkout: optional tag/commit to pin the deploy tree to. Left unset.
  //
  // 2026-07-26 findings, kept here so nobody re-treads this: ghcr.io's
  // inferenced/api :0.2.14 are published ARM64-ONLY, while :0.2.13 is amd64.
  // Pinning back to 0.2.13 does NOT rescue an x86 host — the live chain
  // reports v0.2.14 (app_version 13), so the older node binary exits at
  // startup ("app exited, no upgrade", cosmovisor). x86 hosts therefore
  // cannot join until Gonka publishes amd64 0.2.14 images; the launch step's
  // architecture preflight now says so plainly instead of failing obscurely.
  repo: { url: "https://github.com/gonka-ai/gonka.git", branch: "main", joinDir: "gonka/deploy/join" },

  // Public seed / genesis nodes. First reachable one is used.
  seedNodes: [
    "http://node2.gonka.ai:8000",
    "http://node1.gonka.ai:8000",
    "http://node3.gonka.ai:8000"
  ],
  seedP2P: "tcp://node2.gonka.ai:5000",

  // Message types the node's ML-operational (warm) key may sign on the
  // account's behalf: the list `grant-ml-ops-permissions` grants in inferenced
  // v0.2.16 (inference-chain/x/inference/permissions.go). It must track the
  // chain — granting a type the chain has removed fails the whole tx (v0.2.14
  // dropped MsgStartInference, v0.2.16 dropped MsgRequestThresholdSignature →
  // "doesn't exist: invalid type") — so it lives here, where the remote
  // manifest can update it without an app release, and scripts/check-chain.js
  // compares it with Gonka's own file every day.
  mlOpsPermissions: [
    "/inference.inference.MsgClaimRewards",
    "/inference.inference.MsgSubmitPocBatch",
    "/inference.inference.MsgSubmitPocValidationsV2",
    "/inference.inference.MsgPoCV2StoreCommit",
    "/inference.inference.MsgSubmitPoCChallengeValidations",
    "/inference.inference.MsgPoCChallengeStoreCommit",
    "/inference.inference.MsgMLNodeWeightDistribution",
    "/inference.inference.MsgSubmitSeed",
    "/inference.inference.MsgBridgeExchange",
    "/inference.inference.MsgSubmitNewUnfundedParticipant",
    "/inference.inference.MsgSubmitHardwareDiff",
    "/inference.inference.MsgDeclarePoCIntent",
    "/inference.bls.MsgSubmitDealerPart",
    "/inference.bls.MsgSubmitVerificationVector",
    "/inference.bls.MsgRespondDealerComplaints",
    "/inference.bls.MsgSubmitPartialSignature",
    "/inference.bls.MsgSubmitGroupKeyValidationSignature"
  ],
  // Fee allowance granted to the warm key alongside (DefaultMLOpsFeeAllowance,
  // 10 GNK). From v0.2.16 the node pays its epoch fees out of this allowance.
  mlOpsFeeAllowanceNgonka: "10000000000",
  // Price per unit of gas for the wallet's transactions. From v0.2.16 the chain
  // sets it: 1 ngonka per gas for grants, sends and collateral (fee_params in
  // the chain's own parameters). Before that nothing was charged at all, and
  // this said 10.
  gasPriceNgonka: 1,
  // What Gonka's guide suggests a new host keeps in the wallet for fees: from
  // v0.2.16 a node pays for every Proof of Compute it takes part in, and
  // without the balance it stays registered but is left out of the epoch.
  feeStartGnk: 10,
  // Wrapped GNK on Ethereum, the traded form: the only official contract
  // (gonka.ai/docs FAQ), named where the app says how to get GNK.
  wgnkContract: "0x972a7a92d92796a98801a8818bcf91f1648f2f68",

  // The last state of the Gonka network a person checked this app against.
  // scripts/check-chain.js compares it with the live network every day: a newer
  // chain, or a kind of fee the chain charges that is not listed here, means
  // the app needs looking at before anyone trusts it with a rented server.
  // Overridable, so "we looked, it still fits" can be published without an app
  // update. realRun is the last time a node was set up from start to finish
  // on a real server — older than the chain it names until the next real run,
  // and the daily check keeps saying so.
  // "wasm" arrives with v0.2.17 (smart-contract transactions, at the cosmos
  // rate). The app sends none, so it changes nothing here.
  checkedAgainst: { chain: "v0.2.16", on: "2026-10-23", realRun: "2026-08-03", feeGroups: ["epoch", "cosmos", "wasm"] },

  // Where the daily comparison with the live network is published. The app
  // reads it at start: to say so plainly when Gonka has changed and this copy
  // has not been checked against it yet, and to take Gonka's own corrected
  // permission list by itself. Empty means never read.
  compatUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/compat.json",

  // Every host's results for the recent epochs, kept as one file by the same
  // job (scripts/epochs-snapshot.js). Gonka Host Monitor/Vote draws a node's
  // reward history from it; asking the chain for thirty epochs at once gets a
  // caller refused. Empty means the app asks the chain, a few epochs at a time.
  epochsUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/epochs.json",

  // Each host's GPUs and the network's totals (supply, community pool), kept by
  // the same job (scripts/network-snapshot.js) for the network page.
  networkUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/network.json",
  // Where the shared money is and what each passed proposal paid
  // (scripts/governance-snapshot.js), for Monitor/Vote's Votes page.
  governanceUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/governance.json",
  // The GPUs that took part each epoch, and of what kind
  // (scripts/capacity-snapshot.js), for the network page's GPU chart.
  capacityUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/capacity.json",
  // The network's total weight each epoch (scripts/usage-snapshot.js), for the
  // network page's weight chart.
  usageUrl: "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/usage.json",

  // API paths (relative to a node base URL)
  api: {
    governanceModels: "/v1/governance/models",
    participants: "/v2/participants/",           // + address
    accounts: "/v2/accounts/",                   // + address
    epochParticipants: "/v1/epochs/current/participants",
    latestEpoch: "/api/v1/epochs/latest",
    chainRpc: "/chain-rpc/",
    inferenceParams: "/chain-api/productscience/inference/inference/params",
    collateral: "/chain-api/productscience/inference/collateral/collateral/" // + address
  },

  // Hardware guidance shown in the scan step.
  requirements: {
    // Gonka's ML node images (deploy/join/docker-compose.mlnode.yml, and its
    // release notes in docs/release-candidate-gpu-profile.md, Oct 2026): the
    // main one is built for CUDA 13, an NVIDIA driver 580 or newer; a CUDA
    // 12.9 image is the fallback for older drivers, which GNOT picks by itself
    // (deploy.ensureMlnodeCompose). The quickstart's prerequisites still say
    // "between 12.6 and 12.9", but its model sections say CUDA 13, or 12.9
    // with the -cu129 image, and GLM needs CUDA 13. Below 12.9 is untested.
    cudaMin: "12.9",
    cudaMain: "13.0",
    driverMain: 580,
    // Below this a driver cannot run either image at all.
    cudaFloor: "12.6",
    networkNode: { cpuCores: 16, ramGB: 64, diskGB: 1000 },
    mlNodeRamToVramRatio: 1.5
  },

  // Ports policy from the quickstart.
  ports: {
    public: [5000, 8000, 8443],
    internalOnly: [26657, 9100, 9200, 5050, 8080]
  },

  // HTTPS / SSL questionnaire branches.
  // env: [{ key, label, secret, hint }] — extra config.env vars for this provider.
  // VERIFY these against the live gonka.ai questionnaire before each release;
  // Cloudflare is confirmed from the docs, the others follow the same issuer's
  // conventional variable names and should be double-checked.
  dnsProviders: [
    { id: "cloudflare", label: "Cloudflare", acmeName: "cloudflare",
      env: [{ key: "CF_DNS_API_TOKEN", label: "Cloudflare DNS API token", secret: true,
              hint: "Create in Cloudflare dashboard → My Profile → API Tokens → Edit zone DNS" }] },
    { id: "route53", label: "AWS Route 53", acmeName: "route53",
      env: [
        { key: "AWS_ACCESS_KEY_ID", label: "AWS access key ID", secret: false },
        { key: "AWS_SECRET_ACCESS_KEY", label: "AWS secret access key", secret: true },
        { key: "AWS_REGION", label: "AWS region (e.g. us-east-1)", secret: false }
      ] },
    { id: "gcloud", label: "Google Cloud DNS", acmeName: "gcloud",
      env: [
        { key: "GCE_PROJECT", label: "GCP project ID", secret: false },
        { key: "GCE_SERVICE_ACCOUNT_JSON_B64", label: "Service-account JSON key, base64-encoded", secret: true }
      ] },
    { id: "azuredns", label: "Azure DNS", acmeName: "azure",
      env: [
        { key: "AZURE_CLIENT_ID", label: "Azure client ID", secret: false },
        { key: "AZURE_CLIENT_SECRET", label: "Azure client secret", secret: true },
        { key: "AZURE_TENANT_ID", label: "Azure tenant ID", secret: false },
        { key: "AZURE_SUBSCRIPTION_ID", label: "Azure subscription ID", secret: false }
      ] },
    { id: "digitalocean", label: "DigitalOcean DNS", acmeName: "digitalocean",
      env: [{ key: "DO_AUTH_TOKEN", label: "DigitalOcean API token", secret: true }] },
    { id: "hetzner", label: "Hetzner DNS", acmeName: "hetzner",
      env: [{ key: "HETZNER_API_KEY", label: "Hetzner DNS API token", secret: true }] }
  ],

  // Friendly names for GPU classes, used to rank node-config-*.json matches.
  // Order matters: the first match wins, so longer/newer names come first
  // (B300 before B200 is not required here, but keep classes distinct).
  // Gonka adds hardware classes over time — B300 appeared with the DeepSeek
  // V4 configs. An unknown class isn't fatal any more (the UI is null-safe),
  // but until a class is listed here its config files can't be matched to a
  // machine. Overridable via the remote manifest.
  gpuClasses: [
    { match: /B300/i, id: "B300" },
    { match: /B200/i, id: "B200" },
    { match: /H200/i, id: "H200" },
    { match: /H100/i, id: "H100" },
    { match: /A100/i, id: "A100" }
  ],

  // Reference deployments published in the official docs (gonka.ai quickstart)
  // that are NOT shipped as files in the repo's deploy/join folder — the docs
  // name file paths for them, but those files 404 on the repo (verified
  // 2026-07-09). Transcribed verbatim from the docs page. Each entry is a
  // complete, paste-ready node-config.json. A repo file for the same
  // model+GPU class always takes precedence over an entry here; entries whose
  // model leaves the live governance-approved list are hidden automatically.
  // These are also overridable via the remote manifest.
  curatedConfigs: [
    {
      model: "MiniMaxAI/MiniMax-M2.7", gpuClass: "A100", gpuCount: 4,
      label: "MiniMax M2.7 — 4×A100",
      note: "Uses the marlin MoE backend (A100 can't use the FP8 FlashInfer path). Needs VLLM_USE_FLASHINFER_MOE_FP8=0 for the mlnode service — pre-set in the shipped docker-compose.mlnode.yml since MLNode 3.0.14.",
      nodeConfig: [{
        id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
        models: { "MiniMaxAI/MiniMax-M2.7": { args: [
          "--moe-backend", "marlin",
          "--tensor-parallel-size", "4",
          "--gpu-memory-utilization", "0.95",
          "--max-num-seqs", "128",
          "--enable-auto-tool-choice",
          "--max-model-len", "180000",
          "--kv-cache-dtype", "fp8",
          "--tool-call-parser", "minimax_m2",
          "--reasoning-parser", "minimax_m2_append_think"
        ] } }
      }]
    },
    {
      model: "MiniMaxAI/MiniMax-M2.7", gpuClass: "H100", gpuCount: 4,
      label: "MiniMax M2.7 — 4×H100",
      note: "FLASHINFER attention backend with FP8 kv-cache.",
      nodeConfig: [{
        id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
        models: { "MiniMaxAI/MiniMax-M2.7": { args: [
          "--tensor-parallel-size", "4",
          "--attention-backend", "FLASHINFER",
          "--gpu-memory-utilization", "0.92",
          "--max-num-seqs", "128",
          "--enable-auto-tool-choice",
          "--max-model-len", "180000",
          "--kv-cache-dtype", "fp8",
          "--tool-call-parser", "minimax_m2",
          "--reasoning-parser", "minimax_m2_append_think"
        ] } }
      }]
    },
    {
      model: "MiniMaxAI/MiniMax-M2.7", gpuClass: "H200", gpuCount: 2,
      label: "MiniMax M2.7 — 2×H200",
      note: "Hopper reference class for MiniMax — the PoC golden vectors for MiniMax M2.7 were recorded on this exact configuration.",
      nodeConfig: [{
        id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
        models: { "MiniMaxAI/MiniMax-M2.7": { args: [
          "--tensor-parallel-size", "2",
          "--attention-backend", "FLASHINFER",
          "--gpu-memory-utilization", "0.92",
          "--max-num-seqs", "128",
          "--enable-auto-tool-choice",
          "--max-model-len", "180000",
          "--kv-cache-dtype", "fp8",
          "--tool-call-parser", "minimax_m2",
          "--reasoning-parser", "minimax_m2_append_think"
        ] } }
      }]
    },
    {
      model: "MiniMaxAI/MiniMax-M2.7", gpuClass: "B200", gpuCount: 2,
      label: "MiniMax M2.7 — 2×B200",
      note: "Blackwell reference class for MiniMax. Uses the FLASHINFER_TRTLLM MoE backend with FP8 kv-cache.",
      nodeConfig: [{
        id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
        models: { "MiniMaxAI/MiniMax-M2.7": { args: [
          "--tensor-parallel-size", "2",
          "--moe-backend", "FLASHINFER_TRTLLM",
          "--gpu-memory-utilization", "0.92",
          "--max-num-seqs", "128",
          "--enable-auto-tool-choice",
          "--max-model-len", "180000",
          "--kv-cache-dtype", "fp8",
          "--tool-call-parser", "minimax_m2",
          "--reasoning-parser", "minimax_m2_append_think"
        ] } }
      }]
    }
  ],

  // Default HF cache dir on the server.
  hfHome: "/mnt/shared",

  // Collateral: recommended buffer multiplier over network max weight.
  collateralBufferX: 2,

  // What the app asks people to send before setting up, in ngonka (0.01 GNK):
  // the permissions grant costs about a tenth of it, and the registration, when
  // the network does not do it, less. scripts/check-chain.js dry-runs the grant
  // against the live chain daily and goes red if it ever costs more. (The
  // community faucet was dropped in October 2026: it paid 0.01 GNK into a
  // browser wallet of its own, often did not pay at all, and a node needs more
  // than that for its fees anyway.)
  setupNgonka: 10000000,

  // Where the app says it was opened (src/services/usage.js), which is how the
  // website's Impact page counts computers. Empty means nothing is ever sent;
  // the published manifest can set it without a release.
  usageEndpoint: "https://thegonkanetworkonboardinghub.com/functions/gnot-usage",

  docs: {
    // Community-run explorer/dashboard (same site as the faucet) — usually the
    // fastest to update; participants list is the page people check for "am I in".
    communityDashboard: "https://gonka.gg/network/participants",
    // The publisher's site, The Gonka Network Onboarding Hub (GNOH).
    website: "https://thegonkanetworkonboardinghub.com",
    // This app's own code, public so anyone can read what it does — and check
    // that the build they installed came from it (see the repository's README).
    sourceCode: "https://github.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool",
    quickstart: "https://gonka.ai/docs/host/quickstart/",
    // The guide's own part on what a host pays from v0.2.16, and how much to keep.
    fees: "https://gonka.ai/docs/host/quickstart/#fund-account-fees",
    // Getting GNK: Gonka's bridge turns WGNK on Ethereum into GNK, in the browser
    // on its dashboard; its wallet guide shows sending GNK from Keplr or Tangem.
    bridge: "https://gonka.ai/docs/cross-chain-transfers/ethereum-bridge/dashboard/",
    walletGuide: "https://gonka.ai/docs/wallet/wallet-and-transfer-guide/",
    keyManagement: "https://gonka.ai/host/key-management/",
    multiModelPoc: "https://gonka.ai/docs/host/multi_model_poc/",
    collateral: "https://gonka.ai/host/collateral/",
    faq: "https://gonka.ai/FAQ/",
    discord: "https://discord.com/invite/RADwCT2U6R",
    hardware: "https://gonka.ai/host/hardware-specifications/"
  }
};

let merged = { ...overridable };

async function loadRemoteManifest() {
  if (!REMOTE_MANIFEST_URL) return merged;
  try {
    const res = await fetch(REMOTE_MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const remote = await res.json();
      merged = deepMerge({ ...overridable }, remote);
    }
  } catch (e) {
    // Offline or manifest missing — built-in defaults are used.
  }
  return merged;
}

function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      base[k] = deepMerge(base[k], over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}

/**
 * Read the daily comparison with the live network (scripts/check-chain.js).
 *
 * Two things come out of it. `compat` is what the app shows a person when the
 * network has moved past what this copy was checked against. And when Gonka's
 * permission list has changed, the comparison carries Gonka's own current list,
 * already accepted by the live chain in a dry run — the app takes it, so a
 * changed list mends itself within a day instead of breaking the grant step
 * until somebody publishes a fix.
 *
 * Kept apart from loadRemoteManifest on purpose: the comparison itself must
 * judge the app WITHOUT its own correction, or it would call a stale list fine
 * and the correction would vanish the next day.
 */
const COMPAT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OWN_MESSAGE = /^\/inference\.(inference|bls)\.Msg[A-Za-z0-9]+$/;

async function loadCompat() {
  if (!merged.compatUrl) return merged;
  try {
    // Short on purpose: this runs before the window opens.
    const res = await fetch(merged.compatUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return merged;
    const c = await res.json();
    const age = Date.now() - Date.parse(c.asOf);
    if (!(age >= 0 && age < COMPAT_MAX_AGE_MS)) return merged;   // stale or undated: ignore it whole
    merged.compat = {
      ok: !!c.ok, asOf: c.asOf,
      chain: (c.chain && c.chain.version) || null,
      upgrade: (c.chain && c.chain.upgrade && c.chain.upgrade.name) || null,
      problems: (c.problems || []).map((p) => p.id)
    };
    // Only ever Gonka's own messages, and only a list of a believable size: a
    // permission to move coins must never arrive this way.
    const list = c.fix && c.fix.mlOpsPermissions;
    if (Array.isArray(list) && list.length >= 8 && list.length <= 40 && list.every((p) => OWN_MESSAGE.test(p))) {
      merged.mlOpsPermissions = list;
      merged.compat.listMended = true;
    }
  } catch (e) {
    // Offline or not published — the app goes on with what it has.
  }
  return merged;
}

function get() { return merged; }

module.exports = { get, loadRemoteManifest, loadCompat, REMOTE_MANIFEST_URL };
