/**
 * broker.js — "Use Gonka": chatting with Gonka's models through a service the
 * person picked.
 *
 * The network only takes payment through prepaid tabs that a short, governance
 * approved list of addresses may open, so people reach it through services
 * that hold those tabs (Gonka Proxy, JoinGonka Gateway, GonkaGate and others,
 * listed in knowledge.js useServices). The person's account and money live at
 * the service they chose; this app is only the window onto it. It never holds
 * anyone's money and there is no server of ours in between.
 *
 * The API key is stored encrypted with the operating system's own keychain
 * (Electron safeStorage) and is only ever sent to the service the person chose.
 * Conversations are saved on this computer and nowhere else.
 */
const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const K = require("../knowledge");
const usageCount = require("./usage");
const { probe } = require("./service-probe");

const dir = () => path.join(app.getPath("userData"), "use-gonka");
const configFile = () => path.join(dir(), "account.json");
const chatsDir = () => { const d = path.join(dir(), "chats"); fs.mkdirSync(d, { recursive: true }); return d; };
const trimBase = (b) => String(b || "").trim().replace(/\/+$/, "");
const services = () => K.get().useServices || [];

/**
 * Several services can be connected at once, and switching between them is
 * just a change of which one is active — nobody has to paste a key twice:
 *
 *   { active: "proxy", accounts: { proxy: { base, keyEnc, model }, … } }
 *
 * A config written by an earlier version held one account at the top level;
 * it is read into the new shape here, so nobody loses their key on update.
 */
function readAll() {
  let c;
  try { c = JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch (_) { return { active: null, accounts: {} }; }
  if (c.accounts) return { active: c.active || null, accounts: c.accounts };
  if (c.serviceId || c.base) {
    const id = c.serviceId || "custom";
    return { active: id, accounts: { [id]: { base: c.base, keyEnc: c.keyEnc, keyPlain: c.keyPlain, model: c.model } } };
  }
  return { active: null, accounts: {} };
}

/** The account in use right now. */
function readConfig() {
  const all = readAll();
  return (all.active && all.accounts[all.active]) ? { serviceId: all.active, ...all.accounts[all.active] } : {};
}
function writeAll(all) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(all, null, 2));
}

/**
 * Returns null when the saved key can't be read back. That happens for real:
 * the keyring a key was encrypted with belongs to this computer and this
 * profile, so a restored backup, a copied folder, or (as seen in testing) a
 * second copy of the app running at the same time can leave a key that nothing
 * can decrypt. Callers treat that as "not connected" and ask for it again,
 * rather than showing people a decryption error they can do nothing about.
 */
function keyOf(c) {
  if (!c.keyEnc) return null;
  try {
    const buf = Buffer.from(c.keyEnc, "base64");
    return c.keyPlain ? buf.toString("utf8") : safeStorage.decryptString(buf);
  } catch (_) { return null; }
}

/** The key rides in every request, so it may only travel encrypted — except to
    this computer itself, which is how the tool is tested. */
function checkBase(base) {
  let u;
  try { u = new URL(trimBase(base)); } catch (_) { throw new Error("That address isn't a web address. It should look like https://…/v1"); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !local) {
    throw new Error("Use the service's https:// address. Over plain http:// your key would travel unencrypted.");
  }
}

/** The name to show for an account, whether or not it is one of the listed ones. */
function nameOf(id, base) {
  const s = services().find((x) => x.id === id);
  if (s) return s.name;
  try { return new URL(trimBase(base)).host; } catch (_) { return "your service"; }
}

/** What the renderer may know: never the key itself. */
function getConfig() {
  const all = readAll();
  const c = readConfig();
  const list = services();
  const service = list.find((s) => s.id === c.serviceId) || null;
  const base = trimBase(c.base || (service && service.base) || "");
  return {
    base,
    serviceId: c.serviceId || null,
    service,
    name: c.serviceId ? nameOf(c.serviceId, base) : "your service",
    hasKey: !!(c.keyEnc && base && keyOf(c)),
    // Saved, but no longer readable on this computer: ask for it again.
    keyUnreadable: !!(c.keyEnc && base && !keyOf(c)),
    model: c.model || null,
    services: list,
    // Every service already connected, so switching is one click and no key.
    connected: Object.entries(all.accounts)
      .filter(([, a]) => a && a.keyEnc && a.base)
      .map(([id, a]) => ({ id, name: nameOf(id, a.base), base: trimBase(a.base), active: id === all.active }))
  };
}

/**
 * serviceId picks one from the list; "custom" with a base address is any other
 * Gonka service the person already uses. An empty key disconnects.
 */
function setConfig({ serviceId, base, key, model }) {
  const all = readAll();
  if (serviceId !== undefined) {
    const s = services().find((x) => x.id === serviceId);
    const b = s ? s.base : trimBase(base);
    if (!b) throw new Error("Enter the service's API address.");
    checkBase(b);
    const id = s ? s.id : "custom";
    all.active = id;
    all.accounts[id] = { ...(all.accounts[id] || {}), base: b };
  }
  const id = all.active;
  if (!id || !all.accounts[id]) throw new Error("Choose a service first.");
  const c = all.accounts[id];
  if (model !== undefined) c.model = model;
  if (key !== undefined) {
    const k = String(key).trim();
    if (!k) {
      // Disconnecting: forget this one, and fall back to another if there is one.
      delete all.accounts[id];
      all.active = Object.keys(all.accounts)[0] || null;
    }
    else if (safeStorage.isEncryptionAvailable()) { c.keyEnc = safeStorage.encryptString(k).toString("base64"); delete c.keyPlain; }
    else { c.keyEnc = Buffer.from(k, "utf8").toString("base64"); c.keyPlain = true; }   // no keychain on this system
  }
  writeAll(all);
  return getConfig();
}

/** Switch to a service already connected. The keys of both are kept. */
function switchTo(serviceId) {
  const all = readAll();
  if (!all.accounts[serviceId]) throw new Error("That service isn't connected on this computer.");
  all.active = serviceId;
  writeAll(all);
  return getConfig();
}

/** Services answer errors as {error: "…"} or OpenAI's {error: {message}}. */
async function errorText(res) {
  let body = null;
  try { body = await res.json(); } catch (_) {}
  const e = body && body.error;
  const msg = typeof e === "string" ? e : (e && e.message) || (body && (body.message || body.detail)) || res.statusText;
  if (res.status === 401 || res.status === 403) return "The service didn't accept this key. " + (msg || "");
  if (res.status === 402) return "Your account is out of credit. Top it up and try again. " + (msg || "");
  if (res.status === 429) return "The service is asking to slow down. Wait a moment and try again. " + (msg || "");
  return `The service answered ${res.status}: ${msg}`;
}

async function call(pathname, { method = "GET", body, auth = true, signal, timeout = 30000, base: baseOverride, key: keyOverride } = {}) {
  const c = readConfig();
  const base = trimBase(baseOverride || c.base || "");
  if (!base) throw new Error("Choose a service first.");
  const headers = { "Content-Type": "application/json" };
  const key = keyOverride || (auth ? keyOf(c) : null);
  if (auth && !key) {
    throw new Error(readConfig().keyEnc
      ? "The key saved for this service can't be read on this computer any more. Paste it again to reconnect."
      : "Connect your account first.");
  }
  if (key) headers.Authorization = "Bearer " + key;
  const res = await fetch(base + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: signal || AbortSignal.timeout(timeout)
  });
  if (!res.ok) {
    const err = new Error(await errorText(res));
    err.status = res.status;
    throw err;
  }
  return res;
}

/** The models the service offers. Some list them publicly; others need the key. */
async function models(opts = {}) {
  let res;
  try { res = await call("/models", { auth: false, ...opts }); }
  catch (_) { res = await call("/models", opts); }
  const j = await res.json();
  return (j.data || []).map((m) => m.id).filter(Boolean);
}

/**
 * Check a key before saving it. A balance page is the cheapest proof where the
 * service has one. Several services list their models without any key, so for
 * the rest the only real proof is one tiny question (a handful of tokens out of
 * the free allowance).
 */
async function testKey({ base, key }) {
  checkBase(base);
  try {
    const res = await call("/balance", { base, key });
    return { ok: true, balance: parseBalance(await res.json().catch(() => ({}))) };
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e;
  }
  const list = await models({ base, key });
  if (!list.length) throw new Error("The service didn't list any models.");
  await call("/chat/completions", {
    method: "POST", base, key, timeout: 60000,
    body: { model: list[0], messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1 }
  });
  return { ok: true, balance: null };
}

function parseBalance(j) {
  const g = (v) => (v === undefined || v === null ? null : Number(v) / 1e9);
  if (!j || j.balance_ngonka === undefined) return null;
  return {
    status: j.status || null,
    balanceGnk: g(j.balance_ngonka),
    availableGnk: g(j.available_ngonka),
    reservedGnk: g(j.reserved_ngonka),
    minReserveGnk: g(j.min_reserve_ngonka)
  };
}

/** Balance, where the service publishes one in GNK; null otherwise. */
async function balance() {
  try { return parseBalance(await (await call("/balance")).json()); }
  catch (_) { return null; }
}

/** What a finished reply cost, when the service can say. */
async function costOf(responseId) {
  if (!responseId) return null;
  try {
    const j = await (await call("/usage/" + encodeURIComponent(responseId))).json();
    return j && j.cost_ngonka !== undefined ? { gnk: Number(j.cost_ngonka) / 1e9, source: j.cost_source || null } : null;
  } catch (_) { return null; }
}

/* ---- is each service still there? ---------------------------------------- */

async function probeAll() {
  const list = services();
  return Object.fromEntries(await Promise.all(list.map(async (s) => [s.id, await probe(s.base)])));
}

/** The hourly job's record: which services have been down, and since when. */
const STATUS_URL = "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/data/services.json";
async function statusHistory() {
  try {
    const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(8000) });
    return r.ok ? (await r.json()).services || {} : {};
  } catch (_) { return {}; }
}

/* ---- chatting ------------------------------------------------------------ */

const running = new Map();   // request id -> AbortController

/**
 * Streams one reply. onEvent receives {type: "delta", content, reasoning}
 * pieces as they arrive; the promise resolves with the whole reply and usage.
 * Reasoning models send their thinking either as reasoning_content or inside
 * <think> tags; both are passed through and the renderer folds them away.
 */
/**
 * One turn of a conversation that has tools. Plain request, plain answer: the
 * model either replies with words, or asks for one or more tools to be run.
 *
 * The loop around this lives in the screen, not here, because each tool call
 * that changes something has to be shown to the person and agreed to before it
 * happens. Deliberately not streamed: a half-arrived tool call is no use, and
 * the answer is short when tools are in play.
 */
async function chatOnce({ model, messages, tools, signal }) {
  const cfg = getConfig();
  const m = model || cfg.model;
  if (!m) throw new Error("No model chosen yet.");
  const res = await call("/chat/completions", {
    method: "POST", timeout: 180000, signal,
    body: { model: m, messages, ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}), stream: false }
  });
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  countAnswer(m, data.usage);
  return {
    content: msg.content || "",
    reasoning: msg.reasoning_content || "",
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function && c.function.name,
      args: (() => { try { return JSON.parse((c.function && c.function.arguments) || "{}"); } catch (_) { return {}; } })(),
      rawArgs: (c.function && c.function.arguments) || "{}"
    })),
    finish: choice.finish_reason || null,
    usage: data.usage || null
  };
}

/**
 * Can this service's models be given tools to call? That is what an assistant
 * needs before it can do anything on someone's computer: the model has to be
 * able to answer "call this function with these arguments" instead of prose.
 *
 * Sends one small request with a single made-up tool and reports three things:
 * whether the service accepted the request at all, whether the model answered
 * with a tool call, and how long it took. Costs a few hundred tokens.
 */
async function toolCheck({ model } = {}) {
  const cfg = getConfig();
  const m = model || cfg.model;
  if (!m) throw new Error("No model chosen yet.");
  const tools = [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather in a city",
      parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] }
    }
  }];
  const started = Date.now();
  try {
    const res = await call("/chat/completions", {
      method: "POST", timeout: 90000,
      body: {
        model: m,
        messages: [{ role: "user", content: "What is the weather in Paris right now? Use the tool." }],
        tools, tool_choice: "auto", max_tokens: 200, stream: false
      }
    });
    const data = await res.json();
    const choice = (data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const calls = msg.tool_calls || [];
    return {
      service: cfg.name, model: m, accepted: true,
      toolCalled: calls.length > 0,
      call: calls.length ? { name: calls[0].function && calls[0].function.name, args: calls[0].function && calls[0].function.arguments } : null,
      finish: choice.finish_reason || null,
      text: String(msg.content || "").slice(0, 300),
      usage: data.usage || null,
      ms: Date.now() - started
    };
  } catch (e) {
    return { service: cfg.name, model: m, accepted: false, error: e.message, ms: Date.now() - started };
  }
}

async function chat({ id, model, messages }, onEvent) {
  const ctl = new AbortController();
  running.set(id, ctl);
  try {
    const res = await call("/chat/completions", {
      method: "POST", signal: ctl.signal,
      body: { model, messages, stream: true, stream_options: { include_usage: true } }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", content = "", reasoning = "", usage = null, responseId = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch (_) { continue; }
        if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || "The service reported an error.");
        responseId = responseId || j.id || null;
        if (j.usage) usage = j.usage;
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) continue;
        const piece = { type: "delta", content: d.content || "", reasoning: d.reasoning_content || d.reasoning || "" };
        if (piece.content || piece.reasoning) {
          content += piece.content;
          reasoning += piece.reasoning;
          onEvent(piece);
        }
      }
    }
    countAnswer(model, usage);
    return { content, reasoning, usage, responseId };
  } finally {
    running.delete(id);
  }
}

function stop(id) {
  const ctl = running.get(id);
  if (ctl) ctl.abort();
  return !!ctl;
}

/** One finished answer, for the daily total (src/services/usage.js). */
function countAnswer(model, usage) {
  try {
    const tokens = usage ? (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) : 0;
    usageCount.record({ service: readConfig().serviceId || "custom", model, tokens });
  } catch (_) { /* counting never breaks a conversation */ }
}

/* ---- conversations, on this computer only ------------------------------- */

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "");

function listChats() {
  const out = [];
  for (const f of fs.readdirSync(chatsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(chatsDir(), f), "utf8"));
      out.push({ id: c.id, title: c.title || "", updated: c.updated || 0 });
    } catch (_) {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}
function loadChat(id) {
  return JSON.parse(fs.readFileSync(path.join(chatsDir(), safeId(id) + ".json"), "utf8"));
}
function saveChat(chat) {
  chat.id = safeId(chat.id);
  chat.updated = Date.now();
  fs.writeFileSync(path.join(chatsDir(), chat.id + ".json"), JSON.stringify(chat));
  return { id: chat.id, updated: chat.updated };
}
function deleteChat(id) {
  fs.rmSync(path.join(chatsDir(), safeId(id) + ".json"), { force: true });
  return true;
}

module.exports = {
  getConfig, setConfig, switchTo, testKey, toolCheck, chatOnce, models, balance, costOf, probe, probeAll, statusHistory,
  chat, stop, listChats, loadChat, saveChat, deleteChat
};
