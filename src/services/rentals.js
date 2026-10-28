/**
 * rentals.js — what renting a server for each setup costs right now, from the
 * providers' own public price lists, next to what that setup earns.
 *
 * Only dedicated (on-demand) servers. A spot, interruptible or preemptible
 * server can be taken back at any moment, and a node stopped partway through
 * an epoch is paid nothing for it, so those are never offered.
 *
 * Each offer is checked against what a node needs before it counts: RAM of at
 * least 1.5 × the GPUs' memory (5% leeway, as the health check allows), the
 * disk Gonka asks for, and a system image with an NVIDIA driver new enough for
 * Gonka's ML node images (CUDA 12.9 or newer; knowledge.requirements). The
 * app works this out live; the website's Base44 function is built from this
 * very code (scripts/build-base44-rentals.js), and the data job publishes the
 * same as a fallback (scripts/rentals-snapshot.js). Same code, same numbers.
 *
 * Spheron first: its documented GET /api/gpu-offers needs no key
 * (docs.spheron.ai/api-reference), and every price there is for the whole
 * server, per hour. Another provider is one more entry in PROVIDERS, returning
 * offers in the same shape.
 */
const K = require("../knowledge");

/** GPU kinds GNOT can set up, as providers name them. Grace (GH200, GB200/GB300) machines are a different platform. */
const KINDS = [[/B300/i, "B300"], [/B200/i, "B200"], [/H200/i, "H200"], [/H100/i, "H100"], [/A100/i, "A100"]];
const NOT_THESE = /\bG[BH]\d00\b|\bCC\b/i;
/** Gonka's A100 setup splits the model over 4 × 80 GB, so a 40 GB A100 cannot run it. */
const MIN_GPU_GB = { A100: 75 };
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

async function getJson(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "gonka-network-onboarding-tool (price comparison)", Accept: "application/json" },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const kindOf = (name) => (NOT_THESE.test(name) ? null : (KINDS.find(([re]) => re.test(name)) || [, null])[1]);

/** Is CUDA version a at least b? ("13.0" vs "12.9") */
function cudaAtLeast(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}
/** The newest CUDA version named in a list of system images, or null. */
function newestCuda(images) {
  let best = null;
  for (const name of images) {
    const m = /CUDA\s*(\d+\.\d+)/i.exec(name);
    if (m && (!best || cudaAtLeast(m[1], best))) best = m[1];
  }
  return best;
}

/** Spheron's dedicated offers, in the shared shape. */
async function spheron() {
  const j = await getJson("https://app.spheron.ai/api/gpu-offers?page=1&limit=200&computeType=gpu");
  const out = [];
  for (const g of j.data || []) {
    const gpu = kindOf(`${g.displayName || ""} ${g.gpuType || ""}`);
    if (!gpu) continue;
    for (const o of g.offers || []) {
      if (!o.available || o.instanceType !== "DEDICATED") continue;
      const gpuGB = Number(o.gpu_memory) || 0;
      if (MIN_GPU_GB[gpu] && gpuGB < MIN_GPU_GB[gpu]) continue;
      out.push({
        provider: "Spheron",
        gpu, gpuName: g.displayName || gpu,
        gpus: Number(o.gpuCount) || 0,
        gpuGB,
        ramGB: Number(o.memory) || 0,
        diskGB: Number(o.storage) || 0,
        cpus: Number(o.vcpus) || 0,
        // Some regions carry an internal prefix: "ce32df2f:tokyo-japan-5".
        region: String((o.clusters || [])[0] || "").replace(/^[0-9a-f]{6,}:/i, ""),
        pricePerHour: Number(o.price) || 0,
        // The newest CUDA among the images on offer ("Ubuntu 24.04 LTS (CUDA 13.0)",
        // "Ubuntu Server 22.04 LTS R570 CUDA 12.8"), or null when none comes with it.
        cuda: newestCuda(o.os_options || [])
      });
    }
  }
  return out.filter((o) => o.gpus > 0 && o.pricePerHour > 0);
}

const PROVIDERS = [{ id: "spheron", name: "Spheron", site: "https://www.spheron.network/", read: spheron }];

/** What an offer lacks for a node: "memory", "disk" and/or "driver". */
function shortOf(o) {
  const req = K.get().requirements;
  const short = [];
  const needRam = o.gpus * o.gpuGB * req.mlNodeRamToVramRatio;
  if (o.ramGB < needRam * 0.95) short.push("memory");
  if (o.diskGB < req.networkNode.diskGB) short.push("disk");
  // Gonka's images need CUDA 13, or 12.9 for the fallback one (knowledge.requirements).
  if (!o.cuda || !cudaAtLeast(o.cuda, req.cudaMin)) short.push("driver");
  return short;
}

/**
 * One row per server a GNOT setup can run on: a GPU kind and a GPU count that
 * is a whole multiple of a setup's (one copy per set of GPUs). Each row has the
 * cheapest dedicated offer that has everything a node needs, or else the
 * cheapest offer and what it lacks, and what the server earns with each model
 * it can run, from the earnings figures (`earnings` is earnings.estimate()).
 */
function compare(earnings, offers) {
  // Per GPU kind and model: the setup's GPU count and what each GPU may cost per hour.
  const setups = new Map();
  for (const c of earnings.configs || []) {
    if (c.deployable === false || !(c.copies <= 1)) continue;
    setups.set(`${c.gpuClass}|${c.model}`, { gpuClass: c.gpuClass, model: c.model, per: c.gpuCount,
      perGpuHour: c.breakEvenPerHour != null ? c.breakEvenPerHour / c.gpuCount : null });
  }
  for (const c of earnings.noHosts || []) {
    if (c.copies > 1 || setups.has(`${c.gpuClass}|${c.model}`)) continue;
    setups.set(`${c.gpuClass}|${c.model}`, { gpuClass: c.gpuClass, model: c.model, per: c.gpuCount, perGpuHour: null });
  }
  // The servers worth a row: each setup's own size and a whole 8-GPU server,
  // plus any size on offer that is a whole multiple of a setup's.
  const sizes = new Map();
  const want = (gpu, n) => { if (!sizes.has(gpu)) sizes.set(gpu, new Set()); sizes.get(gpu).add(n); };
  for (const s of setups.values()) {
    want(s.gpuClass, s.per);
    if (s.per < 8 && 8 % s.per === 0) want(s.gpuClass, 8);
  }
  for (const o of offers) for (const s of setups.values()) if (o.gpu === s.gpuClass && o.gpus % s.per === 0) want(o.gpu, o.gpus);

  const rows = [];
  for (const [gpu, counts] of sizes) for (const n of counts) {
    const runs = [...setups.values()].filter((s) => s.gpuClass === gpu && n % s.per === 0)
      .map((s) => ({ model: s.model, copies: n / s.per, breakEvenPerHour: s.perGpuHour != null ? s.perGpuHour * n : null }))
      .sort((a, b) => (b.breakEvenPerHour || 0) - (a.breakEvenPerHour || 0));
    if (!runs.length) continue;
    const here = offers.filter((o) => o.gpu === gpu && o.gpus === n).map((o) => ({ ...o, short: shortOf(o) }))
      .sort((a, b) => a.pricePerHour - b.pricePerHour);
    const best = here.find((o) => !o.short.length) || null;
    const top = runs[0].breakEvenPerHour;
    rows.push({
      gpuClass: gpu, gpuCount: n, runs,
      offers: here.length,
      best,
      // Nothing with all a node needs: the cheapest anyway, with what it lacks.
      cheapest: best ? null : here[0] || null,
      // What the best-earning model leaves after the rent, per day.
      gapPerDay: best && top != null ? (top - best.pricePerHour) * 24 : null
    });
  }
  // Cheapest first: what can be rented as it is, then offers lacking something,
  // then sizes nobody offers, each from the cheapest to the most expensive.
  const order = ["B300", "B200", "H200", "H100", "A100"];
  const rank = (r) => (r.best ? 0 : r.cheapest ? 1 : 2);
  const price = (r) => (r.best || r.cheapest || { pricePerHour: Infinity }).pricePerHour;
  rows.sort((a, b) => rank(a) - rank(b) || price(a) - price(b)
    || order.indexOf(a.gpuClass) - order.indexOf(b.gpuClass) || a.gpuCount - b.gpuCount);
  return rows;
}

/**
 * A provider's offers, read again when the list comes back much shorter than
 * it was: on 26 October 2026 the website read Spheron's list with a single
 * offer GNOT could use, where there are usually dozens, and five minutes later
 * every one was back. A short list (under 10 usable offers, or under half of
 * the last read) is read up to twice more, a few seconds apart, and the
 * fullest read counts. A list that stays short is shown as it is.
 */
const lastCount = {};
const THIN_RETRIES = 2;
const THIN_WAIT_MS = 4000;
async function readFull(p) {
  const thin = (list) => list.length < Math.max(10, (lastCount[p.id] || 0) / 2);
  let list = await p.read();
  for (let i = 0; i < THIN_RETRIES && thin(list); i++) {
    await new Promise((r) => setTimeout(r, THIN_WAIT_MS));
    const again = await p.read().catch(() => []);
    if (again.length > list.length) list = again;
  }
  lastCount[p.id] = list.length;
  return list;
}

/**
 * Every provider's dedicated offers, read now, each compared on its own with
 * the earnings figures: one list per provider, so people can look at them one
 * provider at a time.
 */
async function estimate(earnings, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS && cache.epoch === (earnings.epoch && earnings.epoch.index)) return cache.data;
  const providers = [];
  for (const p of PROVIDERS) {
    const at = new Date().toISOString();
    try {
      const list = await readFull(p);
      providers.push({ id: p.id, name: p.name, site: p.site, at, offers: list.length, error: null, rows: compare(earnings, list) });
    } catch (e) {
      providers.push({ id: p.id, name: p.name, site: p.site, at, offers: 0, error: e.message, rows: [] });
    }
  }
  const data = { asOf: new Date().toISOString(), providers };
  cache = { at: Date.now(), epoch: earnings.epoch && earnings.epoch.index, data };
  return data;
}

module.exports = { estimate, compare, spheron, shortOf };
// The pieces the website's Base44 function is built from (scripts/build-base44-rentals.js),
// so the website compares with exactly this code.
module.exports._parts = { KINDS, NOT_THESE, MIN_GPU_GB, CACHE_MS, getJson, kindOf, cudaAtLeast, newestCuda, spheron, PROVIDERS, shortOf, compare, THIN_RETRIES, THIN_WAIT_MS, readFull, estimate };
