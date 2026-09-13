/**
 * configgen.js — turns the wizard's answers into config.env and picks the
 * right node-config.json.
 *
 * answers = {
 *   keyName, keyringPassword,
 *   mode: "http" | "https",
 *   host,               // public IP or domain
 *   accountPubkey,
 *   ssl?: { method: "auto"|"manual", domain, email, jwtSecret, dnsProviderId, dnsEnv: {k:v} }
 * }
 */
const crypto = require("crypto");
const K = require("../knowledge");

/**
 * Values the wizard knows how to fill in, keyed by the variable name the
 * repo's own config.env.template uses. Anything the template defines that
 * isn't in this map is left exactly as the template has it — so new
 * variables the repo adds show up correctly without touching this file.
 */
function answerDrivenVars(answers) {
  const k = K.get();
  const https = answers.mode === "https";
  const port = https ? 8443 : 8000;
  const publicUrl = `${https ? "https" : "http"}://${answers.host}:${port}`;
  const seed = k.seedNodes[0];

  const vars = {
    KEY_NAME: answers.keyName,
    KEYRING_PASSWORD: answers.keyringPassword,
    KEYRING_BACKEND: "file",
    NGINX_MODE: https ? "https" : "http",
    [https ? "API_SSL_PORT" : "API_PORT"]: String(port),
    PUBLIC_URL: publicUrl,
    P2P_EXTERNAL_ADDRESS: `tcp://${answers.host}:5000`,
    ACCOUNT_PUBKEY: answers.accountPubkey,
    NODE_CONFIG: "./node-config.json",
    // Set by the health check to whichever disk actually has room for weights.
    HF_HOME: answers.hfHome || k.hfHome,
    SEED_API_URL: seed,
    SEED_NODE_RPC_URL: seed + "/chain-rpc/",
    SEED_NODE_P2P_URL: k.seedP2P,
    DAPI_API__POC_CALLBACK_URL: "http://api:9100",
    DAPI_CHAIN_NODE__URL: "http://node:26657",
    DAPI_CHAIN_NODE__P2P_URL: "http://node:26656",
    PORT: "8080",
    INFERENCE_PORT: "5050"
  };

  if (https && answers.ssl) {
    const s = answers.ssl;
    vars.CERT_ISSUER_DOMAIN = s.domain;
    vars.CERT_ISSUER_JWT_SECRET = s.jwtSecret || crypto.randomBytes(24).toString("hex");
    vars.ACME_ACCOUNT_EMAIL = s.email;
    const provider = k.dnsProviders.find((p) => p.id === s.dnsProviderId);
    if (provider) {
      vars.ACME_DNS_PROVIDER = provider.acmeName;
      for (const v of provider.env) vars[v.key] = (s.dnsEnv || {})[v.key] || "";
    }
  }
  return vars;
}

/**
 * templateText, if provided, is the repo's own config.env.template — the
 * source of truth for which variables exist. We only override the keys we
 * have real answers for and leave everything else (including future
 * variables the repo adds) untouched. Without a template (e.g. offline
 * preview), falls back to writing just the known variables.
 */
function generateConfigEnv(answers, templateText) {
  const vars = answerDrivenVars(answers);

  if (templateText) {
    const seen = new Set();
    const lines = templateText.split("\n").map((line) => {
      const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return line;
      const [, prefix, key, value] = m;
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        seen.add(key);
        return `${prefix}${key}=${vars[key]}`;
      }
      // Placeholders the wizard doesn't fill (e.g. <FILLIN> on optional,
      // disabled features): to bash, `X=<FILLIN>` is redirection syntax, and
      // one such line makes every `source config.env` on the server die with
      // a syntax error. Comment them out instead of leaving them live.
      if (/<[^>]*>/.test(value)) {
        return `# ${line.trim()}   # disabled by the wizard — set a real value and uncomment to enable`;
      }
      return line;
    });
    for (const [key, value] of Object.entries(vars)) {
      if (!seen.has(key)) lines.push(`export ${key}=${value}`);
    }
    return lines.join("\n") + "\n";
  }

  const pad = (s) => s + " ".repeat(Math.max(1, 66 - s.length));
  return Object.entries(vars)
    .map(([k2, v]) => pad(`export ${k2}=${v}`) + "#")
    .join("\n") + "\n";
}

/**
 * Pick reference node-config files from the cloned repo that match the
 * detected GPUs. Returns candidates sorted by relevance.
 */
function rankNodeConfigs(files, gpus) {
  const k = K.get();
  const gpuName = gpus && gpus.length ? gpus[0].name : "";
  const myClass = (k.gpuClasses.find((c) => c.match.test(gpuName)) || {}).id || null;
  const count = gpus ? gpus.length : 0;

  return files
    .filter((f) => /node-config-.*\.json$/.test(f))
    .map((f) => {
      // gpuClass is the class the CONFIG is written for (from its filename) —
      // NOT the class of this machine. Stamping the machine's class here made
      // a B200 config read as "Fits your machine — 4× A100" on an A100 box,
      // because the count happened to match and the class check compared the
      // machine against itself.
      const cfgClass = (k.gpuClasses.find((c) => c.match.test(f)) || {}).id || null;
      const matchesGpu = !!(myClass && cfgClass && myClass === cfgClass);
      return { file: f, score: matchesGpu ? 10 : 0, matchesGpu, gpuClass: cfgClass, myClass, myCount: count };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

/** Extract model IDs from a node-config.json string. */
function modelsInConfig(jsonText) {
  try {
    const arr = JSON.parse(jsonText);
    const models = new Set();
    for (const node of arr) for (const id of Object.keys(node.models || {})) models.add(id);
    return [...models];
  } catch (_) { return []; }
}

module.exports = { generateConfigEnv, rankNodeConfigs, modelsInConfig };
