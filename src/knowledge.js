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
  // v0.2.15 (inference-chain/x/inference/permissions.go). It must track the
  // chain — granting a type the chain has removed fails the whole tx (v0.2.14
  // dropped MsgStartInference → "doesn't exist: invalid type") — so it lives
  // here, where the remote manifest can update it without an app release.
  mlOpsPermissions: [
    "/inference.inference.MsgClaimRewards",
    "/inference.inference.MsgSubmitPocBatch",
    "/inference.inference.MsgSubmitPocValidationsV2",
    "/inference.inference.MsgPoCV2StoreCommit",
    "/inference.inference.MsgMLNodeWeightDistribution",
    "/inference.inference.MsgSubmitSeed",
    "/inference.inference.MsgBridgeExchange",
    "/inference.inference.MsgSubmitNewUnfundedParticipant",
    "/inference.inference.MsgSubmitHardwareDiff",
    "/inference.bls.MsgSubmitDealerPart",
    "/inference.bls.MsgSubmitVerificationVector",
    "/inference.bls.MsgRespondDealerComplaints",
    "/inference.bls.MsgRequestThresholdSignature",
    "/inference.bls.MsgSubmitPartialSignature",
    "/inference.bls.MsgSubmitGroupKeyValidationSignature"
  ],
  // Fee allowance granted to the warm key alongside (DefaultMLOpsFeeAllowance, 10 GNK).
  mlOpsFeeAllowanceNgonka: "10000000000",
  // Price per unit of gas for the wallet's transactions — what the CLI
  // commands used; at or above the chain's minimum.
  gasPriceNgonka: 10,

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
    cudaMin: "12.6",
    cudaMax: "12.9",
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

  // Community faucet that dispenses a little starter GNK (for grant-gas).
  // Overridable via the remote manifest if the URL/amount ever changes.
  faucet: { url: "https://gonka.gg/faucet", amount: "0.01 GNK / 24h" },

  // "Use Gonka": services that give ordinary people access to Gonka's models.
  // Every field is a fixed value, not free text, so the app writes identical
  // things identically ("Email and password" is always exactly that). Each
  // service is independent; Gonka's own docs vouch for none. Checked on their
  // own sites on useServicesChecked; the manifest can replace this whole list
  // without a release, and the hourly job (scripts/services-snapshot.js) takes
  // down any that stop answering.
  //   signUp: "email" (email and password), "email-only" (no password),
  //           "secret-code" (no email at all), plus "google" / "github" / "discord"
  //   free:   { tokens } | { usd } | { tokensPerWeek } | { tokensPerMonth }
  //   pay:    "gnk" "wgnk" "usdt" "usdc" "crypto" "card"
  //   price:  USD per million tokens for MiniMax-M2.7: { flat } | { in, out } | { from } | null (not stated)
  // Where the daily Use Gonka total goes (src/services/usage.js). Empty means
  // nothing is ever sent; the published manifest can set it without a release.
  usageEndpoint: "https://thegonkanetworkonboardinghub.com/functions/gnot-usage",

  useServicesChecked: "2026-09-21",
  useServices: [
    {
      id: "proxy", name: "Gonka Proxy", byName: "Gonka Labs", byKind: "official",
      base: "https://api.proxy.gonka.gg/v1", signup: "https://proxy.gonka.gg/register", dashboard: "https://proxy.gonka.gg/login",
      keyStartsWith: "sk-",
      signUp: ["email"], free: { tokens: 1000000 }, pay: ["gnk", "wgnk", "crypto"],
      price: { flat: 0.0016 },
      extras: "Workspaces: an assistant that writes documents, slides, spreadsheets and code",
      extrasUrl: "https://proxy.gonka.gg/workspaces",
      priceIsNetwork: true
    },
    {
      id: "joingonka", name: "JoinGonka Gateway", byName: "JoinGonka", byKind: "community",
      base: "https://gate.joingonka.ai/v1", signup: "https://gate.joingonka.ai/register", dashboard: "https://gate.joingonka.ai/login",
      keyStartsWith: "jg-",
      signUp: ["email", "google", "github", "discord"], free: { tokens: 3000000 }, pay: ["gnk", "usdt"],
      payNote: "No fee on GNK, 5% on USDT",
      price: { in: 0.0065, out: 0.02 },
      extras: "Can search the web and read PDFs"
    },
    {
      id: "gonkagate", name: "GonkaGate", byName: "GonkaGate", byKind: "community",
      base: "https://api.gonkagate.com/v1", signup: "https://gonkagate.com/en/register", dashboard: "https://gonkagate.com/en/login",
      signUp: ["email", "google", "github"], free: { usd: 10 }, pay: ["card"],
      price: { flat: 0.00019 }, priceNote: "Network price plus a 10% fee"
    },
    {
      id: "gonkarouter", name: "GonkaRouter", byName: "GonkaRouter", byKind: "community",
      base: "https://api.gonkarouter.io/v1", signup: "https://gonkarouter.io/dashboard", dashboard: "https://gonkarouter.io/dashboard",
      signUp: ["email-only"], free: { usd: 20 }, pay: ["usdt"],
      price: { from: 0.0016 }
    },
    {
      id: "gonkabroker", name: "Gonka Broker", byName: "Gonka Broker", byKind: "community",
      base: "https://proxy.gonkabroker.com/v1", signup: "https://app.gonkabroker.com/signup", dashboard: "https://app.gonkabroker.com/",
      signUp: ["email", "google"], free: { tokensPerMonth: 1000000 }, pay: ["card"],
      price: { flat: 0.25 },
      extras: "Also works with Claude Code and other Anthropic tools"
    },
    {
      id: "mingles", name: "Mingles Router", byName: "Mingles AI", byKind: "community",
      base: "https://router.mingles.ai/v1", signup: "https://router.mingles.ai/app", dashboard: "https://router.mingles.ai/app",
      signUp: ["email", "google"], free: { tokensPerWeek: 3900000 }, pay: ["card", "usdt", "usdc"],
      price: { in: 0.18, out: 0.72 }, priceNote: "Or monthly plans from $9"
    },
    {
      id: "gonka24", name: "Gonka24", byName: "Gonka24", byKind: "community",
      base: "https://api.gonka24.com/v1", signup: "https://gonka24.com/login", dashboard: "https://gonka24.com/login",
      signUp: ["email", "google"], free: { usd: 10 }, pay: [],
      price: null
    },
    {
      id: "dahl", name: "Dahl Inference", byName: "Dahl", byKind: "community",
      base: "https://inference.dahl.global/v1", signup: "https://inference.dahl.global/account", dashboard: "https://inference.dahl.global/account",
      signUp: ["secret-code"], free: { tokens: 100000000 }, pay: [],
      price: null
    }
  ],


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

function get() { return merged; }

module.exports = { get, loadRemoteManifest, REMOTE_MANIFEST_URL };
