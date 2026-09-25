/**
 * service-probe.js — is a "Use Gonka" service answering right now?
 *
 * Up means the service answers a keyless request with a proper JSON reply —
 * even "missing key" proves the API is alive. No key is ever sent. Shared by
 * the app (the live dots in the service list) and the hourly job
 * (scripts/services-snapshot.js), so both judge a service the same way.
 * Plain Node, no Electron, so the job can load it.
 */
const trimBase = (b) => String(b || "").trim().replace(/\/+$/, "");

async function answersJson(url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
    if (r.status >= 500) return false;
    JSON.parse(await r.text());
    return true;
  } catch (_) { return false; }
}

async function probe(base) {
  const b = trimBase(base);
  if (await answersJson(b + "/models")) return true;
  return answersJson(b + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

module.exports = { probe };
