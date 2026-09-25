/* use.js — the "Use Gonka" tool: chat with Gonka's models through the
   person's own account at a service that connects to it (src/services/broker.js
   does the talking).

   Two faces: a three-step setup (get an account, add GNK, connect) until a key
   is saved, then the chat. Conversations are saved on this computer only.
   Shares $, esc, t and api with app.js. */

const U = {
  config: null,
  models: [],
  balance: null,
  chat: null,          // { id, title, model, messages: [{role, content, reasoning?, usage?, cost?}] }
  streaming: null,     // request id while a reply is coming in
  listening: false,
  folder: null,        // the folder the assistant may work in, if one is chosen
  pending: null        // a write waiting for a yes or no
};

/** Rough cost before the service confirms it: the chain's 10 ngonka per token,
    times an observed 1.5 for gateway retries. */
const EST_NGONKA_PER_TOKEN = 15;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtGnkSmall = (g) => {
  if (g === null || g === undefined || !isFinite(g)) return "—";
  if (g === 0) return "0 GNK";
  // Answers cost millionths of a GNK; show the real digits, not "<0.0001".
  if (g < 0.0001) return g.toFixed(Math.min(12, Math.ceil(-Math.log10(g)) + 1)) + " GNK";
  return (g < 1 ? g.toFixed(4) : g.toLocaleString(window.I18N.lang(), { maximumFractionDigits: 2 })) + " GNK";
};

/* ---- screen switching ------------------------------------------------- */

async function showUse() {
  document.body.classList.remove("on-home");
  document.body.classList.add("on-use");
  document.title = `Use Gonka — ${APP_NAME}`;
  window.gonka.setCloseGuard(!!S.connected && !S.setupFinished);
  if (!U.listening) {
    window.gonka.onUseDelta(onDelta);
    U.listening = true;
  }
  $("#use").innerHTML = `
    <div class="use-wrap">
      <nav class="use-rail">
        <div class="brand">
          <a href="#" class="rail-home" id="use-home">${esc(t("← All tools"))}</a>
          <div class="title">Use Gonka</div>
          <div class="sub">${esc(t("AI on the Gonka network"))}</div>
        </div>
        <div class="use-rail-body" id="use-rail-body"></div>
        <div class="use-foot" id="use-foot"></div>
      </nav>
      <main class="use-main" id="use-main"></main>
    </div>`;
  $("#use-home").onclick = (e) => { e.preventDefault(); leaveUse(); };
  U.config = await api("useConfig");
  try { U.folder = (await api("wsFolder")).folder || null; } catch (_) { U.folder = null; }
  if (U.config.hasKey) await openChatView(); else renderChooser();
}

function leaveUse() {
  if (U.streaming) api("useStop", { id: U.streaming }).catch(() => {});
  document.body.classList.remove("on-use");
  showHome();
}

/* ---- choosing a service, then connecting ------------------------------ */

/* The service list is data (knowledge.js useServices), and these turn each
   fixed value into the same words every time: two services that both sign up
   with an email and a password both say exactly "Email and password". */
const PAY_NAMES = { gnk: "GNK", wgnk: "WGNK", usdt: "USDT", usdc: "USDC", crypto: "other crypto", card: "card" };
const OTHER_SIGNUPS = { google: "Google", github: "GitHub", discord: "Discord" };
const NOT_STATED = "Not stated on their site";

const takesGnk = (s) => !!(s && (s.pay || []).includes("gnk"));

function listWords(items) {
  if (items.length <= 1) return items[0] || "";
  return items.slice(0, -1).join(", ") + " " + t("or") + " " + items[items.length - 1];
}
function bigNumber(n) {
  return n >= 1e6 ? t("{n} million", { n: +(n / 1e6).toFixed(1) }) : n.toLocaleString(window.I18N.lang());
}
/** Who runs a service, in the same shape for every one of them. */
function byText(s) {
  if (!s.byName) return t(s.by || "");   // an older manifest may still send one sentence
  return s.byKind === "official"
    ? t("{name}, the team behind Gonka", { name: s.byName })
    : t("{name}, a community project", { name: s.byName });
}

function signUpText(s) {
  const su = s.signUp || [];
  const main = su.includes("secret-code") ? t("No email: they give you a secret code")
    : su.includes("email-only") ? t("Email only, no password")
    : su.includes("email") ? t("Email and password") : t(NOT_STATED);
  const others = su.filter((x) => OTHER_SIGNUPS[x]).map((x) => OTHER_SIGNUPS[x]);
  return others.length ? t("{main}, or {others}", { main, others: listWords(others) }) : main;
}
function freeText(s) {
  const f = s.free;
  if (!f) return t(NOT_STATED);
  if (f.tokens) return t("{n} tokens", { n: bigNumber(f.tokens) });
  if (f.tokensPerWeek) return t("{n} tokens a week", { n: bigNumber(f.tokensPerWeek) });
  if (f.tokensPerMonth) return t("{n} tokens a month", { n: bigNumber(f.tokensPerMonth) });
  if (f.usd) return t("${n} of credit", { n: f.usd });
  return t(NOT_STATED);
}
function payText(s) {
  if (!s.pay || !s.pay.length) return t(NOT_STATED);
  const w = listWords(s.pay.map((p) => t(PAY_NAMES[p] || p)));
  const words = w.charAt(0).toUpperCase() + w.slice(1);
  return s.payNote ? `${words} (${t(s.payNote)})` : words;
}
function priceText(s) {
  const p = s.price;
  if (!p) return t(NOT_STATED);
  const d = (x) => "$" + (x < 0.01 ? String(+x.toPrecision(2)) : x.toFixed(2));
  const main = p.flat != null ? t("{p} per million tokens", { p: d(p.flat) })
    : p.from != null ? t("From {p} per million tokens", { p: d(p.from) })
    : t("{a} in, {b} out per million tokens", { a: d(p.in), b: d(p.out) });
  return s.priceNote ? `${main}. ${t(s.priceNote)}` : main;
}

/** Plain-words comparison of the services people can reach Gonka through. */
async function renderChooser() {
  $("#use-rail-body").innerHTML = "";
  $("#use-foot").innerHTML = "";
  // A service the hourly check has seen silent for three days is left out,
  // unless it answers the live check below.
  let history = {};
  try { history = await api("useStatus"); } catch (_) {}
  if (!$("#use-main")) return;   // the screen was closed while we waited
  const longDown = (id) => {
    const h = history[id];
    return h && h.downSince && Date.now() - Date.parse(h.downSince) > 3 * 24 * 3600 * 1000;
  };
  const list = (U.config.services || []);
  const connected = new Set((U.config.connected || []).map((c) => c.id));
  const row = (label, value) => `<div class="svc-row"><span class="svc-k">${esc(t(label))}</span><span class="svc-v">${esc(value)}</span></div>`;
  $("#use-main").innerHTML = `
    <div class="use-setup wide">
      <h1>Use Gonka</h1>
      ${U.config.keyUnreadable ? `<p class="warn-banner">${esc(t("The key saved for {name} can't be read on this computer any more, so it needs pasting again. Your account there is untouched.", { name: U.config.name }))}</p>` : ""}
      <p class="small use-counted">${esc(t("So that the work on this app can be shown to be worth doing, it counts how much the Gonka network is used through it: how many answers and how many tokens, once a day, with a random number for this computer. Never what you type, never what comes back, never your key. Your own numbers are on the Account page, and the totals are public on the website."))}</p>
      <p class="lead">${esc(t("Pick a service to reach the Gonka network through. Each one gives you your own account; this app never touches your money. All of them start free, so you can try before you pay."))}</p>
      <div class="svc-grid">${list.map((s) => `
        <div class="svc-card" data-svc="${esc(s.id)}"${longDown(s.id) ? " hidden" : ""}>
          <div class="svc-head">
            <span class="svc-name">${esc(s.name)}</span>
            ${connected.has(s.id) ? `<span class="tool-badge live">${esc(t("Connected"))}</span>` : ""}
          </div>
          <div class="svc-by">${esc(byText(s))}</div>
          <div class="svc-live" data-live="${esc(s.id)}"><span class="dot"></span>${esc(t("Checking…"))}</div>
          ${row("Sign up", signUpText(s))}
          ${row("Try it free", freeText(s))}
          ${row("Pay with", payText(s))}
          ${row("Price (MiniMax)", priceText(s))}
          ${s.extras ? row("Also", t(s.extras)) : ""}
          <div class="svc-actions">
            <button class="primary" data-choose="${esc(s.id)}">${esc(connected.has(s.id)
              ? t("Switch to {name}", { name: s.name })
              : t("Choose {name}", { name: s.name }))}</button>
          </div>
        </div>`).join("")}
      </div>
      <p class="small">${esc(t("As each service states on its own site, checked {date}. Prices and offers change, so their site has the latest. These services are independent; Gonka does not vouch for any of them. They all run the same Gonka models, so you can switch later.", { date: fmtDate(S.K.useServicesChecked) }))}
        <a href="#" id="u-custom">${esc(t("I use another Gonka service"))}</a></p>
    </div>`;
  $("#use-main").querySelectorAll("[data-choose]").forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.choose;
      // Already connected: no key to paste, just make it the one in use.
      if (connected.has(id)) {
        U.config = await api("useSwitchTo", { serviceId: id });
        U.balance = null;
        await openChatView();
        return;
      }
      renderConnect(list.find((s) => s.id === id));
    };
  });
  $("#u-custom").onclick = (e) => { e.preventDefault(); renderConnect(null); };

  // Live: is each one answering right now? (No key is sent.)
  let live = {};
  try { live = await api("useProbe"); } catch (_) {}
  for (const s of list) {
    const el = $(`[data-live="${s.id}"]`);
    if (!el) continue;
    const up = live[s.id];
    el.className = "svc-live " + (up ? "up" : "down");
    el.innerHTML = `<span class="dot"></span>${esc(up ? t("Answering right now") : t("Not answering right now"))}`;
    const card = $(`[data-svc="${s.id}"]`);
    if (card && up) card.hidden = false;
    // Silent ones go to the end so a working choice is always first.
    if (card && !up) card.parentElement.appendChild(card);
  }
}
const fmtDate = (iso) => {
  try { return new Date(iso + "T12:00:00Z").toLocaleDateString(window.I18N.lang(), { day: "numeric", month: "long", year: "numeric" }); }
  catch (_) { return iso; }
};

/** Sign up (in the browser), then paste the key here. service null = any other service. */
function renderConnect(service) {
  const custom = !service;
  $("#use-main").innerHTML = `
    <div class="use-setup">
      <p class="small"><a href="#" id="c-back">${esc(t("← All services"))}</a></p>
      <h1>${esc(custom ? t("Another Gonka service") : service.name)}</h1>
      ${custom ? "" : `
      <div class="card">
        <h3>${esc(t("1. Create your account"))}</h3>
        <p>${esc(t("Sign up on their site. It opens in your browser. {free} to start.", { free: freeText(service) }))}</p>
        <div class="btn-row"><button class="primary" id="c-signup">${esc(t("Open {name} sign-up", { name: service.name }))}</button></div>
      </div>`}
      <div class="card">
        <h3>${esc(custom ? t("Connect") : t("2. Connect"))}</h3>
        <p>${esc(custom
          ? t("Paste the service's API address and your key. The key is kept encrypted on this computer and only ever sent to that service.")
          : t("In your {name} dashboard, create an API key and paste it here. It is kept encrypted on this computer and only ever sent to {name}.", { name: service.name }))}</p>
        ${custom ? `<label class="field"><span class="lbl">${esc(t("API address"))}</span>
          <input id="c-base" spellcheck="false" placeholder="https://…/v1" /></label>` : ""}
        <label class="field"><span class="lbl">${esc(t("API key"))}</span>
          <input id="c-key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(service && service.keyStartsWith ? service.keyStartsWith + "…" : "")}" /></label>
        <div class="btn-row"><button class="primary" id="c-connect">${esc(t("Connect"))}</button></div>
        <div id="c-msg" class="small"></div>
      </div>
      ${takesGnk(service) ? `
      <div class="card">
        <h3>${esc(t("Later: add GNK"))}</h3>
        <p>${esc(t("When the free allowance runs out, top up with GNK. Copy the deposit address from your {name} dashboard, and this app can send GNK to it from a wallet saved here.", { name: service.name }))}</p>
        <p class="small">${esc(t("No GNK yet? Hosts earn it by running a node. It can also be bought as WGNK on Ethereum and moved over with Gonka's bridge. Native GNK is on no exchange, and anything calling itself GNK on Solana is fake."))}</p>
      </div>` : ""}
    </div>`;
  $("#c-back").onclick = (e) => { e.preventDefault(); renderChooser(); };
  if ($("#c-signup")) $("#c-signup").onclick = () => api("openExternal", { url: service.signup });
  $("#c-connect").onclick = async () => {
    const key = $("#c-key").value.trim();
    const base = custom ? $("#c-base").value.trim() : service.base;
    const msg = $("#c-msg");
    if (custom && !base) { msg.textContent = t("Enter the service's API address."); return; }
    if (!key) { msg.textContent = t("Paste your API key first."); return; }
    msg.textContent = t("Checking the key with {name}…", { name: custom ? t("the service") : service.name });
    $("#c-connect").disabled = true;
    try {
      await api("useTestKey", { base, key });
      U.config = await api("useSetConfig", { serviceId: custom ? "custom" : service.id, base, key });
      await openChatView();
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      const b = $("#c-connect"); if (b) b.disabled = false;
    }
  };
}

/** Send GNK from a wallet saved in this app to the person's own deposit address. */
async function renderSend(box) {
  let names = [];
  try { names = await api("keyNames"); } catch (_) {}
  if (!names.length) {
    box.innerHTML = `<p class="small">${esc(t("There's no wallet saved in this app yet. Send the GNK from the wallet that holds it, to your deposit address."))}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="use-send">
      <label class="field"><span class="lbl">${esc(t("Wallet"))}</span>
        <select id="s-key">${names.map((n) => `<option>${esc(n)}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">${esc(t("Keyring passphrase"))}</span>
        <input id="s-pass" type="password" autocomplete="off" /></label>
      <label class="field"><span class="lbl">${esc(t("Your deposit address"))}</span>
        <input id="s-to" spellcheck="false" placeholder="gonka1…" /></label>
      <label class="field"><span class="lbl">${esc(t("Amount (GNK)"))}</span>
        <input id="s-amt" type="number" min="0" step="0.000001" /></label>
      <div class="btn-row"><button class="primary" id="s-go">${esc(t("Send"))}</button></div>
      <div id="s-msg" class="small"></div>
    </div>`;
  $("#s-go").onclick = async () => {
    const amt = Number($("#s-amt").value);
    const m = $("#s-msg");
    if (!(amt > 0)) { m.textContent = t("Enter how much GNK to send."); return; }
    const ngonka = BigInt(Math.round(amt * 1e6)) * 1000n;   // whole ngonka, no float drift
    if (!confirm(t("Send {amt} GNK to {to}? This can't be undone.", { amt, to: $("#s-to").value.trim() }))) return;
    $("#s-go").disabled = true;
    m.textContent = t("Signing on this computer and sending…");
    try {
      if (!S.seed) S.seed = await api("seed");
      const r = await api("sendGnk", {
        keyName: $("#s-key").value, passphrase: $("#s-pass").value,
        to: $("#s-to").value.trim(), amountNgonka: ngonka.toString(), seedApiUrl: S.seed
      });
      m.innerHTML = esc(t("Sent. Transaction:")) + ` <a href="#" data-tx="${esc(r.txhash)}">${esc(r.txhash.slice(0, 12))}…</a>`;
      m.querySelector("[data-tx]").onclick = (e) => { e.preventDefault(); api("openExternal", { url: "https://gonka.gg/transactions/" + r.txhash }); };
      $("#s-pass").value = "";
    } catch (e) {
      m.textContent = e.message;
    } finally {
      const b = $("#s-go"); if (b) b.disabled = false;
    }
  };
}

/* ---- chat ---------------------------------------------------------------- */

async function openChatView() {
  try { U.folder = (await api("wsFolder")).folder || null; } catch (_) { U.folder = null; }
  try { U.models = await api("useModels"); } catch (_) { U.models = []; }
  if (!U.config.model || !U.models.includes(U.config.model)) {
    U.config.model = U.models.find((m) => /MiniMax/i.test(m)) || U.models[0] || null;
  }
  renderRail();
  startChat(null);
  refreshBalance();
}

async function renderRail() {
  let chats = [];
  try { chats = await api("useChats"); } catch (_) {}
  // Leaving the screen while that was in flight takes the rail with it.
  if (!$("#use-rail-body")) return;
  $("#use-rail-body").innerHTML = `
    <div class="use-rail-actions"><button class="primary" id="use-new">${esc(t("+ New chat"))}</button></div>
    <div class="use-chats">${chats.map((c) => `
      <div class="use-chat-item${U.chat && U.chat.id === c.id ? " active" : ""}" data-id="${esc(c.id)}">
        <span class="use-chat-title">${esc(c.title || t("New chat"))}</span>
        <button class="use-chat-del" data-del="${esc(c.id)}" title="${esc(t("Delete"))}">×</button>
      </div>`).join("")}</div>`;
  $("#use-new").onclick = () => startChat(null);
  $("#use-rail-body").querySelectorAll(".use-chat-item").forEach((el) => {
    el.onclick = (e) => { if (!e.target.dataset.del) startChat(el.dataset.id); };
  });
  $("#use-rail-body").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(t("Delete this conversation? It is only saved on this computer."))) return;
      await api("useChatDelete", { id: b.dataset.del });
      if (U.chat && U.chat.id === b.dataset.del) startChat(null); else renderRail();
    };
  });
  renderFoot();
}

function renderFoot() {
  const b = U.balance;
  $("#use-foot").innerHTML = `
    ${b ? `<div class="use-bal"><b>${esc(fmtGnkSmall(b.availableGnk))}</b> ${esc(t("available"))}</div>` : ""}
    <div class="small">${esc(U.config.name)} · <a href="#" id="use-acct">${esc(t("Account"))}</a></div>`;
  $("#use-acct").onclick = (e) => { e.preventDefault(); renderAccount(); };
}

async function refreshBalance() {
  try { U.balance = await api("useBalance"); } catch (_) { U.balance = null; }
  if ($("#use-foot") && U.config.hasKey) renderFoot();
}

function renderAccount() {
  const s = U.config.service;
  const others = (U.config.connected || []).filter((c) => !c.active);
  $("#use-main").innerHTML = `
    <div class="use-setup">
      <h1>${esc(t("Your account"))}</h1>
      <div class="card">
        <p>${esc(t("Connected to {name}.", { name: U.config.name }))}</p>
        ${U.balance ? `<p>${esc(t("Available: {gnk}.", { gnk: fmtGnkSmall(U.balance.availableGnk) }))}</p>`
          : `<p class="small">${esc(t("Your balance and spending are in your {name} dashboard.", { name: U.config.name }))}</p>`}
        <div class="btn-row">
          ${s && s.dashboard ? `<button class="primary" id="a-dash">${esc(t("Open my {name} dashboard", { name: s.name }))}</button>` : ""}
          ${s && s.extrasUrl ? `<button id="a-extras">${esc(t("{name} Workspaces ↗", { name: U.config.service.name }))}</button>` : ""}
          ${!s || takesGnk(s) ? `<button id="a-topup">${esc(t("Add GNK from a wallet here"))}</button>` : ""}
          <button id="a-add">${esc(t("Connect another service"))}</button>
          <button id="a-change">${esc(t("Disconnect from {name}", { name: U.config.name }))}</button>
          <button id="a-back">${esc(t("Back to chat"))}</button>
        </div>
        <div id="a-send"></div>
        ${others.length ? `
          <div class="svc-switch">
            <div class="svc-switch-title">${esc(t("Also connected on this computer"))}</div>
            ${others.map((o) => `<button class="svc-switch-btn" data-switch="${esc(o.id)}">${esc(t("Switch to {name}", { name: o.name }))}</button>`).join("")}
            <p class="small">${esc(t("Switching keeps both keys, so you can go back and forth without pasting anything again."))}</p>
          </div>` : ""}
        <p class="small">${esc(t("Your money sits in your account at {name}, not in this app. Your conversations are saved only on this computer.", { name: U.config.name }))}</p>
      </div>
      <div class="card">
        <h3>${esc(t("What this app counts"))}</h3>
        <p class="small">${esc(t("Use Gonka exists to bring people to the Gonka network, so the app counts how much of it goes through here and sends a daily total to The Gonka Network Onboarding Hub, where anyone can see it. From this computer, so far:"))}</p>
        <div id="a-usage" class="small">${esc(t("Reading…"))}</div>
        <p class="small">${esc(t("Sent with it: a random number for this computer, the app's version, and which models and services were used. Never what you type, never the answers, never your key, your wallet or your name. Nothing at all is counted in Gonka Host Setup."))}</p>
      </div>
    </div>`;
  api("useUsage").then((u) => {
    const box = $("#a-usage");
    if (!box) return;
    box.innerHTML = `<b>${esc(t("{answers} answers · {tokens} tokens", {
      answers: (u.totals.answers || 0).toLocaleString(window.I18N.lang()),
      tokens: (u.totals.tokens || 0).toLocaleString(window.I18N.lang())
    }))}</b><br>${esc(u.lastSent
      ? t("Last sent {when}.", { when: new Date(u.lastSent).toLocaleString(window.I18N.lang()) })
      : t("Nothing has been sent yet."))}`;
  }).catch(() => {});
  if ($("#a-dash")) $("#a-dash").onclick = () => api("openExternal", { url: s.dashboard });
  if ($("#a-extras")) $("#a-extras").onclick = () => api("openExternal", { url: s.extrasUrl });
  if ($("#a-topup")) $("#a-topup").onclick = () => renderSend($("#a-send"));
  $("#use-main").querySelectorAll("[data-switch]").forEach((b) => {
    b.onclick = async () => {
      U.config = await api("useSwitchTo", { serviceId: b.dataset.switch });
      U.balance = null;
      await openChatView();
    };
  });
  $("#a-add").onclick = () => renderChooser();
  $("#a-change").onclick = async () => {
    if (!confirm(t("Disconnect from {name}? Your account there stays as it is, and your conversations stay on this computer.", { name: U.config.name }))) return;
    U.config = await api("useSetConfig", { key: "" });
    U.balance = null;
    if (!$("#use-rail-body")) return;
    if (U.config.hasKey) { await openChatView(); return; }   // another one is still connected
    $("#use-rail-body").innerHTML = "";
    renderChooser();
  };
  $("#a-back").onclick = () => startChat(U.chat && U.chat.id);
}

async function startChat(id) {
  if (U.streaming) return;
  if (id) {
    try { U.chat = await api("useChatLoad", { id }); } catch (_) { U.chat = null; }
  }
  if (!id || !U.chat) U.chat = { id: newId(), title: "", model: U.config.model, messages: [] };
  renderChat();
  renderRail();
}

function renderChat() {
  const c = U.chat;
  $("#use-main").innerHTML = `
    <div class="use-chat">
      <header class="use-bar">
        <label>${esc(t("Service"))}
          <select id="u-service">
            ${(U.config.connected || []).map((x) => `<option value="${esc(x.id)}"${x.active ? " selected" : ""}>${esc(x.name)}</option>`).join("")}
            <option value="__add">${esc(t("Connect another service…"))}</option>
          </select>
        </label>
        <label>${esc(t("Model"))}
          <select id="u-model">${U.models.map((m) => `<option value="${esc(m)}"${m === (c.model || U.config.model) ? " selected" : ""}>${esc(m.split("/").pop())}</option>`).join("")}</select>
        </label>
        ${U.folder
          ? `<span class="ws-chip" title="${esc(U.folder)}">${esc(t("Folder: {name}", { name: folderName(U.folder) }))}
              <button class="ws-chip-x" id="u-folder-off" title="${esc(t("Stop working in this folder"))}">×</button></span>`
          : `<button id="u-folder">${esc(t("Work in a folder…"))}</button>`}
        <span class="small use-bar-note">${esc(U.config.service && U.config.service.priceIsNetwork
          ? t("Each answer shows about what it cost.")
          : t("Your spending is in your {name} dashboard.", { name: U.config.name }))}</span>
      </header>
      <div class="use-msgs" id="u-msgs">${c.messages.length ? c.messages.map(msgHtml).join("") : `
        <div class="use-empty">
          <h2>${esc(t("Ask anything"))}</h2>
          <p>${esc(t("Answers come from open models running on the Gonka network. Your conversations are saved only on this computer."))}</p>
        </div>`}</div>
      <div class="use-compose">
        <textarea id="u-input" rows="1" placeholder="${esc(t("Message Gonka…"))}"></textarea>
        <button class="primary" id="u-send-btn">${esc(t("Send"))}</button>
      </div>
    </div>`;
  const input = $("#u-input");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; };
  input.oninput = grow;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $("#u-send-btn").onclick = () => (U.streaming ? stopReply() : send());
  if ($("#u-folder")) $("#u-folder").onclick = () => pickFolder();
  if ($("#u-folder-off")) $("#u-folder-off").onclick = () => clearFolder();
  $("#u-service").onchange = async (e) => {
    const id = e.target.value;
    if (id === "__add") { renderChooser(); return; }
    U.config = await api("useSwitchTo", { serviceId: id });
    U.balance = null;
    await openChatView();
  };
  $("#u-model").onchange = async (e) => {
    U.config.model = e.target.value;
    U.chat.model = e.target.value;
    await api("useSetConfig", { model: e.target.value });
  };
  wireLinks($("#u-msgs"));
  scrollDown();
  input.focus();
}

/** Reasoning models put their thinking inside <think>…</think> in the text. */
function splitThinking(text) {
  const s = String(text || "");
  const open = s.indexOf("<think>");
  if (open < 0) return { thinking: "", answer: s, thinkingOpen: false };
  const close = s.indexOf("</think>", open);
  if (close < 0) return { thinking: s.slice(open + 7), answer: s.slice(0, open), thinkingOpen: true };
  return { thinking: s.slice(open + 7, close), answer: (s.slice(0, open) + s.slice(close + 8)).replace(/^\s+/, ""), thinkingOpen: false };
}

function msgHtml(m, i) {
  if (m.role === "user") return `<div class="use-msg user"><div class="bubble">${esc(m.content).replace(/\n/g, "<br>")}
</div></div>`;
  const parts = splitThinking(m.content);
  const thinking = (m.reasoning || "") + parts.thinking;
  const tokens = m.usage ? (m.usage.prompt_tokens || 0) + (m.usage.completion_tokens || 0) : null;
  // An exact cost when the service reports one; an estimate only where the
  // service charges the network's own price, since others add their own fee.
  const estimate = U.config.service && U.config.service.priceIsNetwork;
  const costText = m.cost ? fmtGnkSmall(m.cost.gnk)
    : (estimate && tokens ? t("about") + " " + fmtGnkSmall(tokens * EST_NGONKA_PER_TOKEN / 1e9) : null);
  return `
    <div class="use-msg assistant" data-i="${i}">
      ${thinking.trim() ? `<details class="think"${parts.thinkingOpen ? " open" : ""}><summary>${esc(t("Thinking"))}</summary><div>${esc(thinking).replace(/\n/g, "<br>")}</div></details>` : ""}
      ${(m.steps || []).map((st) => stepHtml(st, !!(U.pending && U.pending.step === st))).join("")}
      <div class="md">${md(parts.answer)}${m.pending && !parts.answer && !m.working ? `<span class="typing">…</span>` : ""}</div>
      ${m.working ? `<div class="ws-working"><span class="typing">…</span>${esc(m.working)}</div>` : ""}
      ${m.error ? `<div class="use-err">${esc(m.error)}</div>` : ""}
      ${tokens !== null ? `<div class="use-cost">${esc(costText
        ? t("{tokens} tokens · {cost}", { tokens: tokens.toLocaleString(window.I18N.lang()), cost: costText })
        : t("{tokens} tokens", { tokens: tokens.toLocaleString(window.I18N.lang()) }))}</div>` : ""}
    </div>`;
}

/* ---- Workspace: the assistant working in a folder on this computer ------

   The folder someone picks is the whole permission: every tool is bound to it
   (src/services/workspace.js), and anything that writes is shown here and
   waits for a yes. The loop lives in this screen rather than in the main
   process precisely so that pause is natural.

   It works through whichever service is connected — the tools are ordinary
   OpenAI-style function definitions, which every service in the list passes
   through to the network. That is the part nobody else offers: their
   assistants run on their machines and only with them. */

const MAX_STEPS = 12;   // a runaway loop costs real money, so it stops itself

/* Plain chat can't reach this computer at all. Models asked to write a file
   will otherwise reply "Done!" and have done nothing, so they are told. */
/* What the assistant is told when it has a folder. It says what it can read
   as well as what it can do, so it answers "that is a picture, I can't look at
   it" instead of guessing at the contents of a PNG. */
const WS_SYSTEM = `You are working inside one folder on the person's own computer, through The Gonka Network Onboarding Tool.
Use the tools to look at what is there before writing anything. Paths are always relative to that folder.
Write real, complete files — never a sketch or a placeholder. When you are done, say plainly what you did in one or two sentences.
You can read and write text: notes, markdown, CSV, JSON, code, logs. You cannot read pictures, PDFs, Word or Excel files — no model on the Gonka network can look at an image yet.
If you are asked about a file of that kind, say so plainly instead of guessing at what is in it.`;

/* Without a folder the model can't touch this computer at all. Left to
   itself it answers "Done! I created the file" having done nothing — and if
   the conversation began in a folder, it goes on believing it is still there,
   which is what happened in testing. So it is told, every turn. */
const noFolderNote = (chat) => {
  const wasInFolder = (chat.messages || []).some((m) => (m.steps || []).length);
  return {
    role: "system",
    content: "You are in a plain chat and have no access to this computer: no files, no folders, no commands. " +
      (wasInFolder ? "Earlier in this conversation you did have a folder. You do not any more — ignore anything above that suggests otherwise. " : "") +
      "If asked to read, create or change a file, or which folder you are in, say plainly that you have no folder right now " +
      "and that they should press \"Work in a folder\" at the top of this screen and choose one. Never claim to have done it."
  };
};

/** Ask for a folder, then remember it on the chat. */
async function pickFolder() {
  const r = await api("wsPick");
  U.folder = r.folder || null;
  renderChat();
  if (U.folder) $("#u-input").focus();
}

async function clearFolder() {
  await api("wsClear");
  U.folder = null;
  renderChat();
}

/** The name of the folder, without the whole path, for the bar. */
const folderName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;

/** One run: keep answering tool calls until the model has nothing left to ask. */
async function runWithTools(c, reply, id) {
  const { tools } = await api("wsFolder");
  // The conversation as the service sees it: the folder instruction, the
  // history so far, then whatever the tools return as we go.
  const convo = [
    { role: "system", content: WS_SYSTEM + `\nThe folder is called "${folderName(U.folder)}".` },
    ...c.messages.filter((m) => !m.pending && !m.error && (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role, content: m.role === "assistant" ? splitThinking(m.content).answer : m.content }))
  ];

  for (let round = 0; round < MAX_STEPS; round++) {
    if (U.streaming !== id) return;                     // stopped
    reply.working = round === 0 ? t("Thinking…") : t("Thinking about what to do next…");
    redrawMessages();
    const r = await api("useChatOnce", { model: c.model, messages: convo, tools });
    reply.working = null;
    if (U.streaming !== id) return;
    if (r.usage) reply.usage = r.usage;

    if (!r.toolCalls.length) {
      reply.content = cleanAnswer(r.content);
      reply.reasoning = r.reasoning;
      return;
    }

    // The model asked for tools. Show each one, run it, and feed the result back.
    convo.push({
      role: "assistant",
      content: r.content || "",
      tool_calls: r.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.rawArgs } }))
    });
    // Its running commentary between tool calls is the model talking to
    // itself — and some models leak their raw tool markup into it — so only
    // the answer it finishes with is shown.

    for (const tc of r.toolCalls) {
      const step = { tool: tc.name, args: tc.args, state: "running" };
      reply.steps = (reply.steps || []).concat(step);
      redrawMessages();

      let result;
      try {
        reply.working = tc.name === "read_file" ? t("Reading {file}…", { file: (tc.args && tc.args.file) || "" })
          : tc.name === "list_files" ? t("Looking at the folder…")
          : t("Waiting for you to allow the file to be written…");
        redrawMessages();
        if (tc.name === "write_file") {
          const about = await api("wsDescribe", { name: tc.name, args: tc.args });
          step.about = about;
          step.state = "asking";
          redrawMessages();
          const yes = await askPermission(step);
          if (!yes) {
            step.state = "refused";
            result = { refused: true, reason: "The person did not allow this write." };
            redrawMessages();
            convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
            continue;
          }
        }
        result = await api("wsRun", { name: tc.name, args: tc.args });
        step.state = "done";
        step.result = result;
      } catch (e) {
        step.state = "failed";
        step.error = e.message;
        result = { error: e.message };
      }
      redrawMessages();
      convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 20000) });
    }
  }
  reply.content = (reply.content || "") + "\n\n" + t("Stopped after {n} steps, so this doesn't run away on its own. Ask it to carry on if it should keep going.", { n: MAX_STEPS });
}

/** Some models spill the shape of their tool calls into ordinary text. */
function cleanAnswer(text) {
  return String(text || "")
    .replace(/<\/?(?:invoke|parameter|function_calls|tool_call|tools?)[^>]*>/gi, "")
    .replace(/\|?\s*DSML\s*\|?/g, "")
    .replace(/<\/?\s*\|?\s*tool_calls?\s*\|?\s*>?\]?\}?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A write waits here until the person answers. */
function askPermission(step) {
  return new Promise((resolve) => {
    U.pending = { step, resolve };
    redrawMessages();
  });
}

function answerPermission(yes) {
  if (!U.pending) return;
  const { resolve } = U.pending;
  U.pending = null;
  resolve(yes);
}

/** What each tool step looks like in the conversation. */
function stepHtml(s, isPending) {
  const icon = s.state === "done" ? "✓" : s.state === "failed" ? "⚠" : s.state === "refused" ? "✕"
    : s.state === "asking" ? "?" : "…";
  const label = s.tool === "write_file" ? t("Write {file}", { file: (s.args && s.args.file) || "" })
    : s.tool === "read_file" ? t("Read {file}", { file: (s.args && s.args.file) || "" })
    : (!s.args || !s.args.folder || s.args.folder === ".") ? t("Look at the folder")
      : t("List {folder}", { folder: s.args.folder });
  const about = s.about || {};
  return `<div class="ws-step ${esc(s.state)}">
    <div class="ws-step-line"><span class="ws-icon">${icon}</span><span>${esc(label)}</span>
      ${s.state === "done" && s.result && s.result.bytes ? `<span class="small">${esc(t("{n} bytes", { n: s.result.bytes }))}</span>` : ""}
      ${s.error ? `<span class="small">${esc(s.error)}</span>` : ""}</div>
    ${isPending ? `
      <div class="ws-ask">
        <p class="small">${esc(about.replaces
          ? t("This replaces a file that is already there.")
          : t("This creates a new file in your folder."))}</p>
        ${about.preview ? `<pre class="ws-preview">${esc(about.preview)}${about.bytes > about.preview.length ? "\n…" : ""}</pre>` : ""}
        <div class="btn-row">
          <button class="primary" id="ws-yes">${esc(t("Write it"))}</button>
          <button id="ws-no">${esc(t("Skip this"))}</button>
        </div>
      </div>` : ""}
  </div>`;
}

async function send() {
  const input = $("#u-input");
  const text = input.value.trim();
  if (!text || U.streaming) return;
  if (!U.config.model) { alert(t("No model is available from this service right now.")); return; }
  const c = U.chat;
  if (!c.title) c.title = text.slice(0, 60);
  c.model = $("#u-model").value;
  c.messages.push({ role: "user", content: text });
  const reply = { role: "assistant", content: "", reasoning: "", pending: true };
  c.messages.push(reply);
  input.value = "";
  input.style.height = "auto";
  redrawMessages();

  const id = newId();
  U.streaming = id;
  $("#u-send-btn").textContent = t("Stop");
  // Only the answers go back as history, never the thinking.
  const history = c.messages.filter((m) => !m.pending && !m.error)
    .map((m) => ({ role: m.role, content: m.role === "assistant" ? splitThinking(m.content).answer : m.content }));
  try {
    if (U.folder) {
      await runWithTools(c, reply, id);
    } else {
      reply.working = t("Thinking…");   // until the first words arrive
      redrawMessages();
      const r = await api("useChat", { id, model: c.model, messages: [noFolderNote(c)].concat(history) });
      reply.content = r.content;
      reply.reasoning = r.reasoning;
      reply.usage = r.usage;
      reply.responseId = r.responseId;
    }
  } catch (e) {
    if (!/abort/i.test(e.message)) reply.error = e.message;
  } finally {
    reply.pending = false;
    reply.working = null;
    U.streaming = null;
    const b = $("#u-send-btn"); if (b) b.textContent = t("Send");
  }
  redrawMessages();
  await api("useChatSave", { chat: c }).catch(() => {});
  renderRail();
  refreshBalance();
  // The service can confirm the exact cost a moment after the reply.
  if (reply.responseId) {
    setTimeout(async () => {
      try {
        const cost = await api("useCostOf", { responseId: reply.responseId });
        if (cost) { reply.cost = cost; redrawMessages(); api("useChatSave", { chat: c }).catch(() => {}); }
      } catch (_) {}
    }, 4000);
  }
}

function stopReply() {
  if (U.pending) answerPermission(false);   // a waiting write must not hang
  if (U.streaming) api("useStop", { id: U.streaming }).catch(() => {});
}

function onDelta(ev) {
  if (!U.chat || ev.id !== U.streaming) return;
  const reply = U.chat.messages[U.chat.messages.length - 1];
  if (!reply || reply.role !== "assistant") return;
  reply.content += ev.content || "";
  reply.reasoning += ev.reasoning || "";
  if (reply.content || reply.reasoning) reply.working = null;   // it is talking now
  redrawMessages();
}

function redrawMessages() {
  const box = $("#u-msgs");
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = U.chat.messages.map(msgHtml).join("");
  wireLinks(box);
  if ($("#ws-yes")) $("#ws-yes").onclick = () => answerPermission(true);
  if ($("#ws-no")) $("#ws-no").onclick = () => answerPermission(false);
  if (nearBottom) scrollDown();
}
const scrollDown = () => { const b = $("#u-msgs"); if (b) b.scrollTop = b.scrollHeight; };

function wireLinks(root) {
  root.querySelectorAll("a[data-href]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); api("openExternal", { url: a.dataset.href }); };
  });
}

/* ---- a small, safe Markdown renderer ------------------------------------
   Everything is escaped first; only these shapes are turned back into markup:
   fenced code, inline code, bold, italic, headings, lists, links (opened in
   the browser, never inside the app). */
function md(src) {
  const text = String(src || "");
  const out = [];
  const blocks = text.split(/```/);
  blocks.forEach((block, bi) => {
    if (bi % 2 === 1) {
      const nl = block.indexOf("\n");
      const code = nl >= 0 ? block.slice(nl + 1) : block;
      out.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    const lines = block.split("\n");
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
  });
  return out.join("");
}
function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="#" data-href="${url}">${label}</a>`);
  return h;
}
