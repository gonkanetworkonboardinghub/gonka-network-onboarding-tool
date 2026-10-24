/* monitor.js — GNOT's "Gonka Host Monitor/Vote".

   Four places, one menu: the network as a whole, everyone on it, the
   proposals being voted on, and the nodes this person keeps an eye on. Point
   it at any node and it shows what the network itself says about it: whether
   it is in the epoch, what it earned, how well it worked next to the other
   hosts, what its wallet holds for fees, its hardware. Everything here is
   public information (src/services/monitor.js does the reading, the data job
   prepares what the chain will not hand over cheaply), so it asks for
   nothing: no key, no password, no access to a server.

   Shares $, esc, t, api and APP_NAME with app.js. Every name here starts with
   "mon" or "MON": the renderer scripts share one global scope. */

const MON = {
  view: "network",    // "network" | "hosts" | "proposals" | "node" | "add"
  nodes: [],          // [{ address, name }] — the nodes this person keeps an eye on
  address: null,      // the node on screen
  data: null,         // what the network says about it
  at: 0,              // when `data` was read
  error: null,
  busy: false,
  overview: null,     // the network as a whole (network and hosts pages)
  overviewAt: 0,
  overviewBusy: false,
  hostFilter: "",
  gov: null,          // proposals
  votes: {},          // proposal id -> [{ name, vote }] for the nodes kept here
  price: null,        // USD per GNK, when it can be had
  timer: null
};
const MON_REFRESH_MS = 2 * 60 * 1000;
const MON_NGONKA = 1e9;

/* ---- words and numbers ------------------------------------------------ */

const monLang = () => window.I18N.lang();
const monNum = (n, max = 0) => Number(n).toLocaleString(monLang(), { maximumFractionDigits: max });
/** ngonka as GNK: 4,141.76 GNK. Small amounts keep the digits that matter. */
function monGnk(ngonka) {
  const g = Number(ngonka) / MON_NGONKA;
  if (!isFinite(g)) return "—";
  const max = g === 0 ? 0 : Math.abs(g) < 0.01 ? 6 : Math.abs(g) < 10 ? 3 : Math.abs(g) < 1000 ? 2 : 0;
  return g.toLocaleString(monLang(), { maximumFractionDigits: max }) + " GNK";
}
/** Big amounts made short: 451.7M, 102.7M, 195.6k. */
function monShortNum(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return monNum(n / 1e9, 2) + "B";
  if (a >= 1e6) return monNum(n / 1e6, 1) + "M";
  if (a >= 1e4) return monNum(n / 1e3, 1) + "k";
  return monNum(n, a < 10 ? 2 : 0);
}
const monGnkShort = (ngonka) => monShortNum(Number(ngonka) / MON_NGONKA) + " GNK";
const monUsd = (ngonka) => (MON.price ? "≈ $" + monShortNum(Number(ngonka) / MON_NGONKA * MON.price) : "");
const monPct = (share, max = 1) => (Number(share) * 100).toLocaleString(monLang(), { maximumFractionDigits: max }) + "%";
const monShort = (a) => (a && a.length > 20 ? a.slice(0, 10) + "…" + a.slice(-6) : a || "");
const monModel = (m) => String(m).split("/").pop();
const monDate = (iso) => { try { return new Date(iso).toLocaleDateString(monLang(), { year: "numeric", month: "short", day: "numeric" }); } catch (_) { return ""; } };
function monSpan(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 48) return t("{d} days", { d: Math.round(h / 24) });
  if (h >= 1) return t("{h} h {m} min", { h, m });
  return t("{m} min", { m: Math.max(1, m) });
}
/** "12 of 29" — written as figures so it reads the same in every language. */
const monPlace = (p) => (p ? t("{rank} of {of}", { rank: p.rank, of: p.of }) : "—");
const monName = (n) => (n.name ? n.name : monShort(n.address));
const monKept = (address) => MON.nodes.some((n) => n.address === address);
const monTile = (label, num, sub) => `
  <div class="mon-tile"><div class="mon-tile-label">${esc(label)}</div>
    <div class="mon-tile-num">${esc(num)}</div>
    <div class="mon-tile-sub">${sub ? esc(sub) : "&nbsp;"}</div></div>`;

/* ---- coming and going -------------------------------------------------- */

async function showMonitor() {
  document.body.classList.remove("on-home");
  document.body.classList.add("on-monitor");
  document.title = "Gonka Host Monitor/Vote — GNOT";
  window.gonka.setCloseGuard(!!S.connected && !S.setupFinished);
  $("#monitor").innerHTML = `
    <div class="mon-wrap">
      <nav class="use-rail">
        <div class="brand">
          <a href="#" class="rail-home" id="mon-home">${esc(t("← All tools"))}</a>
          <div class="gnot-mark"><b>GNOT</b><span>The Gonka Network Onboarding Tool</span></div>
          <div class="title">Gonka Host Monitor/Vote</div>
        </div>
        <div class="use-rail-body" id="mon-rail"></div>
        <div class="use-foot" id="mon-foot"></div>
      </nav>
      <main class="mon-main" id="mon-main"></main>
    </div>`;
  $("#mon-home").onclick = (e) => { e.preventDefault(); leaveMonitor(); };
  try { MON.nodes = await api("monitorNodes"); } catch (_) { MON.nodes = []; }
  api("gnkPrice").then((p) => { MON.price = p && p.usd ? p.usd : null; monRenderMain(); }).catch(() => {});
  monGo(MON.view === "add" ? "network" : MON.view, MON.address);
  if (!MON.timer) MON.timer = setInterval(monRefresh, MON_REFRESH_MS);
}

function leaveMonitor() {
  if (MON.timer) { clearInterval(MON.timer); MON.timer = null; }
  document.body.classList.remove("on-monitor");
  showHome();
}

/** Every move inside the tool goes through here. */
function monGo(view, address) {
  MON.view = view;
  if (view === "node") {
    if (address !== MON.address) { MON.data = null; MON.error = null; }
    MON.address = address;
  }
  monRenderRail();
  monRenderMain();
  const main = $("#mon-main");
  if (main) main.scrollTop = 0;
  if ((view === "network" || view === "hosts") && (!MON.overview || Date.now() - MON.overviewAt > MON_REFRESH_MS)) monLoadOverview();
  if (view === "proposals" && !MON.gov) monLoadProposals();
  if (view === "node" && !MON.data) monLoad();
}

function monRefresh() {
  if (!document.body.classList.contains("on-monitor")) return;
  if (MON.view === "network" || MON.view === "hosts") monLoadOverview(true);
  else if (MON.view === "proposals") monLoadProposals();
  else if (MON.view === "node") monLoad(true);
}

/* ---- the menu ---------------------------------------------------------- */

function monRenderRail() {
  const body = $("#mon-rail");
  if (!body) return;
  const item = (view, label) => `<button class="mon-nav ${MON.view === view ? "on" : ""}" data-view="${view}">${esc(label)}</button>`;
  body.innerHTML = `
    ${item("network", t("The network"))}
    ${item("hosts", t("Every host"))}
    ${item("proposals", t("Proposals"))}
    <div class="mon-rail-label">${esc(t("Your nodes"))}</div>
    ${MON.nodes.map((n) => `
      <div class="mon-node-row">
        <button class="mon-node ${MON.view === "node" && n.address === MON.address ? "on" : ""}" data-addr="${esc(n.address)}">
          <span class="mon-node-name">${esc(monName(n))}</span>
          ${n.name ? `<span class="mon-node-addr">${esc(monShort(n.address))}</span>` : ""}
        </button>
        <button class="mon-node-x" data-forget="${esc(n.address)}" title="${esc(t("Remove from your nodes"))}" aria-label="${esc(t("Remove from your nodes"))}: ${esc(monName(n))}">×</button>
      </div>`).join("")}
    ${MON.undo ? `<div class="mon-undo">${esc(t("Removed {name}.", { name: monName(MON.undo.node) }))} <button id="mon-undo">${esc(t("Undo"))}</button></div>` : ""}
    <button class="mon-add ${MON.view === "add" ? "on" : ""}" id="mon-add">+ ${esc(t("Add a node"))}</button>`;
  body.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => monGo(b.dataset.view); });
  body.querySelectorAll("[data-addr]").forEach((b) => { b.onclick = () => monGo("node", b.dataset.addr); });
  body.querySelectorAll("[data-forget]").forEach((b) => { b.onclick = () => monForget(b.dataset.forget); });
  if ($("#mon-undo")) $("#mon-undo").onclick = monUndoForget;
  $("#mon-add").onclick = () => monGo("add");
  $("#mon-foot").innerHTML = `<div>${esc(t("Public information from the Gonka network. No key, no password."))}</div>`;
}

async function monSave() {
  try { MON.nodes = await api("monitorSaveNodes", { nodes: MON.nodes }); } catch (_) { /* kept for this session at least */ }
}
async function monKeep(address, name) {
  if (!monKept(address)) { MON.nodes.push({ address, name: String(name || "").trim() }); await monSave(); }
}
/** Take a node off the list, with a few seconds to change one's mind. */
async function monForget(address) {
  const index = MON.nodes.findIndex((n) => n.address === address);
  if (index < 0) return;
  MON.undo = { node: MON.nodes[index], index };
  MON.nodes.splice(index, 1);
  await monSave();
  clearTimeout(MON.undoTimer);
  MON.undoTimer = setTimeout(() => { MON.undo = null; monRenderRail(); }, 10000);
  monRenderRail();
  // Its page stays open, now offering "Add to your nodes" again.
  if (MON.view === "node" && MON.address === address) monRenderMain();
}
async function monUndoForget() {
  const u = MON.undo;
  if (!u) return;
  clearTimeout(MON.undoTimer); MON.undo = null;
  if (!monKept(u.node.address)) MON.nodes.splice(Math.min(u.index, MON.nodes.length), 0, u.node);
  await monSave();
  monRenderRail();
  if (MON.view === "node" && MON.address === u.node.address) monRenderMain();
}

/* ---- reading ----------------------------------------------------------- */

async function monLoad(quiet) {
  if (!MON.address || MON.busy) return;
  MON.busy = true;
  const asked = MON.address;
  if (!quiet) monRenderMain();
  try {
    const data = await api("monitorOverview", { address: asked, epochs: 30 });
    if (MON.address !== asked) return;                    // they moved on while it was loading
    MON.data = data; MON.at = Date.now(); MON.error = null;
  } catch (e) {
    if (MON.address === asked) MON.error = e.message;
  } finally {
    MON.busy = false;
  }
  if (MON.view === "node" && MON.address === asked) monRenderMain();
}

async function monLoadOverview(quiet) {
  if (MON.overviewBusy) return;
  MON.overviewBusy = true;
  if (!quiet) monRenderMain();
  try { MON.overview = await api("monitorNetworkOverview"); MON.overviewAt = Date.now(); MON.overviewError = null; }
  catch (e) { MON.overviewError = e.message; }
  finally { MON.overviewBusy = false; }
  if (MON.view === "network" || MON.view === "hosts") monRenderMain();
}

async function monLoadProposals() {
  try {
    MON.gov = await api("monitorProposals");
    MON.votes = {};
    for (const p of MON.gov.proposals.filter((x) => x.status === "VOTING_PERIOD")) {
      MON.votes[p.id] = [];
      for (const n of MON.nodes) {
        try { MON.votes[p.id].push({ name: monName(n), vote: await api("monitorVoteOf", { id: p.id, address: n.address }) }); } catch (_) { /* unknown */ }
      }
    }
  } catch (e) { MON.gov = { error: e.message, proposals: [] }; }
  if (MON.view === "proposals") monRenderMain();
}

/* ---- pages ------------------------------------------------------------- */

function monRenderMain() {
  const main = $("#mon-main");
  if (!main || !document.body.classList.contains("on-monitor")) return;
  let html;
  if (MON.view === "network") html = monNetworkHtml();
  else if (MON.view === "hosts") html = monHostsHtml();
  else if (MON.view === "proposals") html = `<div class="mon-title-row"><h1>${esc(t("Proposals"))}</h1></div>` + monProposalsHtml();
  else if (MON.view === "add") html = monAddHtml();
  else html = monNodePageHtml();
  main.innerHTML = `<div class="mon-page">${html}</div>`;
  monWire(main);
}

/** The buttons and links a page carries; wired after every render. */
function monWire(main) {
  main.querySelectorAll("[data-go-node]").forEach((b) => { b.onclick = () => monGo("node", b.dataset.goNode); });
  main.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => monGo(b.dataset.go); });
  main.querySelectorAll("[data-open]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); api("openExternal", { url: a.dataset.open }); }; });
  const f = $("#mon-filter");
  if (f) {
    f.oninput = () => { MON.hostFilter = f.value; const pos = f.selectionStart; monRenderMain(); const g = $("#mon-filter"); if (g) { g.focus(); g.setSelectionRange(pos, pos); } };
  }
  if (MON.view === "add") monWireAdd();
  if (MON.view === "node") monWireNode();
  const r = $("#mon-refresh");
  if (r) r.onclick = () => { if (MON.view === "node") monLoad(); else if (MON.view === "proposals") { MON.gov = null; monRenderMain(); monLoadProposals(); } else monLoadOverview(); };
}

/* ---- the network ------------------------------------------------------- */

function monMiniBars(values, { height = 70, cls = "mon-bar", title }) {
  if (!values.length) return "";
  const max = Math.max(1, ...values.map((v) => v.value));
  const W = 600, gap = values.length > 90 ? 0.6 : 1.5, bw = (W - gap * (values.length - 1)) / values.length;
  return `<svg class="mon-chart" style="height:${height}px" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" role="img">${values.map((v, i) => {
    const h = Math.max(1, v.value / max * (height - 4));
    return `<rect x="${(i * (bw + gap)).toFixed(2)}" y="${(height - h).toFixed(1)}" width="${bw.toFixed(2)}" height="${h.toFixed(1)}" class="${cls}"><title>${esc(title(v))}</title></rect>`;
  }).join("")}</svg>`;
}

function monNetworkHtml() {
  const o = MON.overview;
  const head = `<div class="mon-title-row"><h1>${esc(t("The Gonka network"))}</h1>
    ${o ? `<span class="mon-title-sub">${esc(t("Epoch {n} · next Proof of Compute in {when}", { n: o.epoch.index, when: monSpan(o.epoch.secondsToNextPoc) }))}</span>` : ""}
    <button id="mon-refresh" class="mon-quiet">${esc(t("Refresh"))}</button></div>`;
  if (!o) return head + (MON.overviewError ? `<div class="warn-banner">${esc(t("Couldn't read the network: {why}", { why: MON.overviewError }))}</div>` : `<div class="info-banner">${esc(t("Reading the network…"))}</div>`);
  const g = o.gpus, l = o.last;
  const tiles = `
    <div class="mon-tiles">
      ${monTile(t("GNK price"), MON.price ? "$" + monNum(MON.price, 4) : "—", t("from several markets"))}
      ${monTile(t("Hosts"), monNum(o.hosts.length), t("in epoch {n}", { n: o.epoch.index }))}
      ${monTile(t("GPUs"), g ? monNum(g.total) : "—", g ? t("{n} working", { n: monNum(g.working) }) : "")}
      ${monTile(t("Epoch {n}", { n: o.epoch.index }), monPct(o.epoch.progress, 0), t("about {h} hours an epoch", { h: monNum(o.epoch.hours, 0) }))}
      ${monTile(t("Paid out last epoch"), l ? monGnkShort(l.rewards) : "—", l ? [monUsd(l.rewards), t("epoch {n}", { n: l.epoch })].filter(Boolean).join(" · ") : "")}
      ${monTile(t("Per GPU, last epoch"), l && l.perGpu ? monGnk(l.perGpu) : "—", l && l.perGpu ? monUsd(l.perGpu) : "")}
      ${monTile(t("GNK in existence"), o.supply ? monGnkShort(o.supply) : "—", o.supply ? monUsd(o.supply) : "")}
      ${monTile(t("Community pool"), o.communityPool ? monGnkShort(o.communityPool) : "—", o.communityPool ? monUsd(o.communityPool) : "")}
    </div>`;
  const past = o.past;
  const charts = past.length ? `
    <div class="mon-two">
      <div class="card"><h3>${esc(t("Hosts, epoch by epoch"))}</h3>
        ${monMiniBars(past.map((p) => ({ value: p.hosts, epoch: p.epoch })), { title: (v) => t("Epoch {n}: {hosts} hosts", { n: v.epoch, hosts: v.value }) })}
        <div class="mon-chart-axis"><span>${esc(t("epoch {n}", { n: past[0].epoch }))}</span><span>${esc(t("epoch {n}", { n: past[past.length - 1].epoch }))}</span></div>
        <p class="small">${esc(t("{a} hosts then, {b} now.", { a: past[0].hosts, b: o.hosts.length }))}</p></div>
      <div class="card"><h3>${esc(t("Paid out, epoch by epoch"))}</h3>
        ${monMiniBars(past.map((p) => ({ value: p.rewards, epoch: p.epoch })), { title: (v) => t("Epoch {n}: {amount}", { n: v.epoch, amount: monGnk(v.value) }) })}
        <div class="mon-chart-axis"><span>${esc(t("epoch {n}", { n: past[0].epoch }))}</span><span>${esc(t("epoch {n}", { n: past[past.length - 1].epoch }))}</span></div>
        <p class="small">${esc(t("Shared among the hosts that took part."))}</p></div>
    </div>` : "";
  const bars = (rows) => {
    const top = Math.max(1, ...rows.map((r) => r.n));
    return `<div class="mon-hbars">${rows.map((r) => `
      <div class="mon-hbar"><span class="mon-hbar-label">${esc(r.label)}</span>
        <span class="mon-hbar-track"><i style="width:${Math.max(2, Math.round(r.n / top * 100))}%"></i></span>
        <span class="mon-hbar-n">${esc(r.text)}</span></div>`).join("")}</div>`;
  };
  const kinds = g ? Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ label: k.replace(/^NVIDIA\s+/i, ""), n, text: monNum(n) })) : [];
  const runs = `
    <div class="mon-two">
      <div class="card"><h3>${esc(t("What the hosts run"))}</h3>${kinds.length ? bars(kinds) : `<p class="small">—</p>`}
        ${g ? `<p class="small">${esc(t("GPUs counted machine by machine at {when}.", { when: monDate(g.countedAt) }))}</p>` : ""}</div>
      <div class="card"><h3>${esc(t("Models served"))}</h3>${bars(o.models.map((m) => ({ label: monModel(m.model), n: m.hosts, text: t("{n} hosts", { n: m.hosts }) })))}</div>
    </div>`;
  const top = o.hosts.slice(0, 5);
  const biggest = `
    <div class="card"><div class="mon-card-head"><h3>${esc(t("The biggest hosts"))}</h3><button class="mon-quiet" data-go="hosts">${esc(t("See all {n} →", { n: o.hosts.length }))}</button></div>
      ${monHostRows(top)}</div>`;
  return head + tiles + charts + runs + biggest;
}

/* ---- every host -------------------------------------------------------- */

function monHostRows(rows) {
  const topShare = Math.max(0.0001, ...rows.map((h) => h.share));
  return `
    <div class="mon-table mon-hosts-table">
      <div class="mon-row mon-row-head"><span>#</span><span>${esc(t("Host"))}</span><span class="r">${esc(t("GPUs"))}</span><span>${esc(t("Models"))}</span><span>${esc(t("Share of the network"))}</span><span class="r">${esc(t("Last epoch"))}</span><span class="r">${esc(t("Missed"))}</span></div>
      ${rows.map((h) => {
        const mine = MON.nodes.find((n) => n.address === h.address);
        return `
        <button class="mon-row mon-row-link" data-go-node="${esc(h.address)}">
          <span class="mon-rank">${esc(String(MON.overview.hosts.indexOf(h) + 1))}</span>
          <span class="mono">${mine && mine.name ? `<b class="mon-mine">${esc(mine.name)}</b> ` : ""}${esc(monShort(h.address))}${h.excluded ? ` <i class="mon-flag">${esc(t("left out"))}</i>` : ""}</span>
          <span class="r">${h.gpus === null ? "—" : esc(monNum(h.gpus))}</span>
          <span class="mon-muted">${esc(h.models.map(monModel).join(", "))}</span>
          <span class="mon-share"><i style="width:${Math.max(2, Math.round(h.share / topShare * 100))}%"></i><b>${esc(monPct(h.share))}</b></span>
          <span class="r">${h.lastReward === null ? "—" : esc(monGnkShort(h.lastReward))}</span>
          <span class="r ${h.missedShare !== null && h.missedShare > 0.05 ? "mon-bad" : ""}">${h.missedShare === null ? "—" : esc(monPct(h.missedShare))}</span>
        </button>`;
      }).join("")}
    </div>`;
}

function monHostsHtml() {
  const o = MON.overview;
  const head = `<div class="mon-title-row"><h1>${esc(t("Every host"))}</h1>
    ${o ? `<span class="mon-title-sub">${esc(t("{n} hosts in epoch {e}. Click one to see everything about it.", { n: o.hosts.length, e: o.epoch.index }))}</span>` : ""}
    <button id="mon-refresh" class="mon-quiet">${esc(t("Refresh"))}</button></div>`;
  if (!o) return head + `<div class="info-banner">${esc(t("Reading the network…"))}</div>`;
  const q = MON.hostFilter.trim().toLowerCase();
  const rows = q ? o.hosts.filter((h) => h.address.toLowerCase().includes(q) || h.models.join(" ").toLowerCase().includes(q) || (MON.nodes.find((n) => n.address === h.address && n.name.toLowerCase().includes(q)))) : o.hosts;
  return head + `
    <input type="text" id="mon-filter" class="mon-search" placeholder="${esc(t("Find a host by address, name or model"))}" value="${esc(MON.hostFilter)}" spellcheck="false">
    ${rows.length ? monHostRows(rows) : `<p class="small">${esc(t("No host matches."))}</p>`}`;
}

/* ---- adding a node ----------------------------------------------------- */

function monAddHtml() {
  return `
    <div class="mon-title-row"><h1>${esc(t("Add a node"))}</h1></div>
    <div class="card">
      <label class="field"><span class="lbl">${esc(t("Node address"))}</span>
        <input type="text" id="mon-addr" class="mono" spellcheck="false" autocomplete="off" placeholder="gonka1…"></label>
      <label class="field"><span class="lbl">${esc(t("A name for it (optional)"))}</span>
        <input type="text" id="mon-name" maxlength="40" placeholder="${esc(t("My first node"))}"></label>
      <div class="btn-row"><button class="primary" id="mon-watch">${esc(t("Add"))}</button></div>
      <p class="small" id="mon-add-err" style="color:var(--red)"></p>
      <p class="small">${esc(t("The address starts with gonka1. Any node works, however it was set up."))} <a href="#" data-go="hosts">${esc(t("Or pick one from every host on the network."))}</a></p>
    </div>`;
}
function monWireAdd() {
  const add = async () => {
    const address = String($("#mon-addr").value || "").trim();
    if (!/^gonka1[02-9ac-hj-np-z]{38}$/.test(address)) { $("#mon-add-err").textContent = t("That does not look like a Gonka address. It starts with gonka1 and is 44 characters long."); return; }
    await monKeep(address, $("#mon-name").value);
    monGo("node", address);
  };
  $("#mon-watch").onclick = add;
  $("#mon-addr").onkeydown = (e) => { if (e.key === "Enter") add(); };
  $("#mon-addr").focus();
}

/* ---- one node ---------------------------------------------------------- */

function monNodePageHtml() {
  const kept = MON.nodes.find((n) => n.address === MON.address);
  const node = kept || { address: MON.address, name: "" };
  const head = `
    <div class="mon-head">
      <div class="mon-head-id">
        <h1>${esc(monName(node))}</h1>
        <div class="mon-head-addr mono" id="mon-copy" title="${esc(t("Copy address"))}">${esc(node.address)}</div>
      </div>
      <div class="mon-head-tools">
        <span class="small" id="mon-age">${!MON.at || !MON.data ? "" : Date.now() - MON.at < 60000 ? esc(t("read just now")) : esc(t("read {when} ago", { when: monSpan((Date.now() - MON.at) / 1000) }))}</span>
        <button id="mon-refresh" class="mon-quiet">${esc(t("Refresh"))}</button>
        ${kept ? `<button id="mon-rename" class="mon-quiet">${esc(t("Rename"))}</button><button id="mon-remove" class="mon-quiet">${esc(t("Remove"))}</button>`
               : `<button id="mon-keep" class="primary">${esc(t("Add to your nodes"))}</button>`}
      </div>
    </div>`;
  let body;
  if (MON.error && !MON.data) body = `<div class="warn-banner">${esc(t("Couldn't read the network: {why}", { why: MON.error }))}</div>`;
  else if (!MON.data) body = `<div class="info-banner">${esc(t("Reading what the network says about this node…"))}</div>`;
  else body = monNodeHtml(MON.data);
  return head + body;
}
function monWireNode() {
  const node = MON.nodes.find((n) => n.address === MON.address) || { address: MON.address, name: "" };
  $("#mon-copy").onclick = async () => { try { await navigator.clipboard.writeText(node.address); $("#mon-copy").classList.add("copied"); setTimeout(() => $("#mon-copy") && $("#mon-copy").classList.remove("copied"), 1200); } catch (_) {} };
  if ($("#mon-keep")) $("#mon-keep").onclick = async () => { await monKeep(MON.address, ""); monRenderRail(); monRenderMain(); };
  if ($("#mon-remove")) $("#mon-remove").onclick = () => monForget(MON.address);
  if ($("#mon-rename")) $("#mon-rename").onclick = () => monRename(node);
}

/** Naming a node happens in the page: Electron has no prompt(). */
function monRename(node) {
  const h1 = document.querySelector(".mon-head-id h1");
  if (!h1) return;
  h1.innerHTML = `<input type="text" id="mon-name-edit" maxlength="40" value="${esc(node.name || "")}" placeholder="${esc(t("A name for it (optional)"))}">`;
  const input = $("#mon-name-edit");
  input.focus(); input.select();
  let finished = false;
  const done = async (keep) => {
    if (finished) return;
    finished = true;
    if (keep) { node.name = input.value.trim(); await monSave(); monRenderRail(); }
    monRenderMain();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
  input.onblur = () => done(true);
}

/* Why the network left a node out, in plain words. Unknown reasons are shown
   as the network wrote them rather than guessed at. */
function monReason(reason) {
  const known = {
    failed_confirmation_poc: t("it failed a confirmation Proof of Compute"),
    inactive: t("it stopped answering"),
    invalid: t("too many of its answers were judged wrong")
  };
  return known[reason] || String(reason || "").replace(/_/g, " ");
}

function monNodeHtml(d) {
  const st = d.standing, ep = d.epoch, last = d.last, m = d.money;

  // ---- the one-line verdict ----
  let verdict;
  if (st.excluded) verdict = `<div class="mon-verdict bad"><span class="mon-dot"></span><div><b>${esc(t("Left out of epoch {n}", { n: ep.index }))}</b><span>${esc(t("The network removed it from this epoch: {why}.", { why: monReason(st.excluded.reason) }))}</span></div></div>`;
  else if (st.inEpoch) verdict = `<div class="mon-verdict good"><span class="mon-dot"></span><div><b>${esc(t("Taking part in epoch {n}", { n: ep.index }))}</b><span>${esc(t("The network counts this node in the current epoch, with {models}.", { models: st.models.map(monModel).join(", ") || "—" }))}</span></div></div>`;
  else if (st.known) verdict = `<div class="mon-verdict bad"><span class="mon-dot"></span><div><b>${esc(t("Not in epoch {n}", { n: ep.index }))}</b><span>${esc(t("The node is registered, but it is not among the {hosts} hosts in the current epoch. It earns nothing until it passes a Proof of Compute.", { hosts: ep.hosts }))}</span></div></div>`;
  else verdict = `<div class="mon-verdict bad"><span class="mon-dot"></span><div><b>${esc(t("The network has no node at this address"))}</b><span>${esc(t("Check the address. A node appears here once it has registered."))}</span></div></div>`;

  // ---- four figures across the top ----
  const tiles = `
    <div class="mon-tiles">
      <div class="mon-tile"><div class="mon-tile-label">${esc(t("Weight this epoch"))}</div>
        <div class="mon-tile-num">${st.inEpoch ? esc(monNum(st.weight)) : "—"}</div>
        <div class="mon-tile-sub">${st.inEpoch ? esc(t("{place} hosts · {share} of the network", { place: monPlace(st.place), share: monPct(st.share, 2) })) : "&nbsp;"}</div></div>
      <div class="mon-tile"><div class="mon-tile-label">${esc(t("Last epoch's reward"))}</div>
        <div class="mon-tile-num">${last ? esc(monGnk(last.reward)) : "—"}</div>
        <div class="mon-tile-sub">${last ? esc([monUsd(last.reward), t("epoch {n}", { n: last.epoch }), monPlace(last.rewardPlace)].filter(Boolean).join(" · ")) : "&nbsp;"}</div></div>
      ${d.now.estimate ? `
      <div class="mon-tile"><div class="mon-tile-label">${esc(t("This epoch, estimated"))}</div>
        <div class="mon-tile-num">${esc(monGnk(d.now.estimate))}</div>
        <div class="mon-tile-sub">${esc([monUsd(d.now.estimate), t("the network's own estimate")].filter(Boolean).join(" · "))}</div></div>` : `
      <div class="mon-tile"><div class="mon-tile-label">${esc(t("GPUs"))}</div>
        <div class="mon-tile-num">${d.hardware.gpuCount ? esc(monNum(d.hardware.gpuCount)) : "—"}</div>
        <div class="mon-tile-sub">${d.hardware.gpuCount ? esc(t("{n} working · {m} machines", { n: monNum(d.hardware.nodes.filter((n) => /INFERENCE|POC|POW/i.test(n.status)).reduce((x, n) => x + n.gpus.reduce((y, g) => y + g.count, 0), 0)), m: monNum(d.hardware.nodes.length) })) : "&nbsp;"}</div></div>`}
      <div class="mon-tile"><div class="mon-tile-label">${esc(t("Next Proof of Compute"))}</div>
        <div class="mon-tile-num">${esc(monSpan(ep.secondsToNextPoc))}</div>
        <div class="mon-tile-sub">${esc(t("epoch {n} is {pct} through", { n: ep.index, pct: monPct(ep.progress, 0) }))}</div></div>
    </div>`;

  return verdict + monAttentionCard(d) + tiles + monRewardsCard(d) + `<div class="mon-two">${monWorkCard(d)}${monMoneyCard(d)}</div>` + monHardwareCard(d) + monPocCard(d);
}

/* What deserves a look, in plain sentences. The codes and figures come from
   the service; the words are written here so they can be translated. */
function monAttentionCard(d) {
  if (!d.standing.known) return "";
  const say = (a) => {
    switch (a.code) {
      case "excluded": return t("The network left this node out of the current epoch: {why}.", { why: monReason(a.reason) });
      case "not-in-epoch": return t("The node is registered but is not in the current epoch, so it is earning nothing.");
      case "machines-down": return t(a.machines.length === 1 ? "One of its {of} machines is not working: {list}." : "{n} of its {of} machines are not working: {list}.", { n: a.machines.length, of: a.of, list: a.machines.map((m) => `${m.id} (${m.status || "?"})`).join(", ") });
      case "no-allowance": return t("The wallet has no fee allowance for the node. Since Gonka v0.2.16 the node cannot pay its fees without one.");
      case "allowance-low": return t("Only {left} is left of the fee allowance. When it runs out the node cannot pay its fees until the allowance is renewed.", { left: monGnk(a.left) });
      case "wallet-low": return t("The wallet holds only {balance}. The node's fees are paid from it.", { balance: monGnk(a.balance) });
      case "confirmation": return t("It passed {pct} of the confirmation checks this epoch.", { pct: monPct(a.ratio, 0) });
      case "no-reward": return t("It took part in epoch {n} but was paid nothing for it.", { n: a.epoch });
      case "missed": return t("In epoch {n} it missed {mine} of its requests. A typical host missed {typical}.", { n: a.epoch, mine: monPct(a.mine), typical: monPct(a.typical) });
      case "judged-wrong": return t("In epoch {n}, {mine} of its checked answers were judged wrong. For a typical host it was {typical}.", { n: a.epoch, mine: monPct(a.mine), typical: monPct(a.typical) });
      default: return a.code;
    }
  };
  if (!d.attention.length) return `<div class="mon-attention none"><b>${esc(t("Nothing needs your attention"))}</b><span>${esc(t("Nothing in what the network reports about this node stands out."))}</span></div>`;
  return `
    <div class="mon-attention">
      <b>${esc(d.attention.length === 1 ? t("One thing is worth a look") : t("{n} things are worth a look", { n: d.attention.length }))}</b>
      <ul>${d.attention.map((a) => `<li class="${a.level}">${esc(say(a))}</li>`).join("")}</ul>
    </div>`;
}

/* Rewards, one bar an epoch. An epoch the node sat out leaves a gap with a
   mark on the line, so a missing bar is never mistaken for a missing reading. */
function monRewardsCard(d) {
  const lines = d.history;
  if (!lines.length) return "";
  const max = Math.max(1, ...lines.map((l) => (l.took ? l.reward : 0)));
  const W = 900, H = 150, gap = 3, bw = (W - gap * (lines.length - 1)) / lines.length;
  const bars = lines.map((l, i) => {
    const x = i * (bw + gap);
    if (l.unknown) return `<rect x="${x.toFixed(1)}" y="${H - 10}" width="${bw.toFixed(1)}" height="10" class="mon-bar-unknown"><title>${esc(t("Epoch {n}: not collected yet", { n: l.epoch }))}</title></rect>`;
    if (!l.took) return `<rect x="${x.toFixed(1)}" y="${H - 2}" width="${bw.toFixed(1)}" height="2" class="mon-bar-none"><title>${esc(t("Epoch {n}: did not take part", { n: l.epoch }))}</title></rect>`;
    const h = Math.max(2, l.reward / max * (H - 6));
    return `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="mon-bar"><title>${esc(t("Epoch {n}: {amount}", { n: l.epoch, amount: monGnk(l.reward) }))}</title></rect>`;
  }).join("");
  const tot = d.totals;
  if (tot.unknown === tot.of) {
    return `<div class="card"><h3>${esc(t("Rewards, epoch by epoch"))}</h3><p class="small">${esc(t("The record of past epochs could not be downloaded just now. Try Refresh in a moment."))}</p></div>`;
  }
  return `
    <div class="card">
      <h3>${esc(t("Rewards, epoch by epoch"))}</h3>
      <svg class="mon-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("Rewards, epoch by epoch"))}">${bars}</svg>
      <div class="mon-chart-axis"><span>${esc(t("epoch {n}", { n: lines[0].epoch }))}</span><span>${esc(t("epoch {n}", { n: lines[lines.length - 1].epoch }))}</span></div>
      <p class="small">${esc(t("{total} over the {n} epochs it took part in, out of the last {of}. The tallest bar is {max}.", { total: monGnk(tot.reward), n: tot.epochs, of: tot.of, max: monGnk(max) }))} ${tot.unknown ? esc(tot.unknown === 1 ? t("The newest epoch is not collected yet; epochs are added a few times a day.") : t("{n} epochs are not collected yet; epochs are added a few times a day.", { n: tot.unknown })) : ""} ${MON.price ? esc(t("At today's price that is {usd}.", { usd: monUsd(tot.reward).replace("≈ ", "") })) : ""}</p>
    </div>`;
}

/* How well it worked, set beside a typical host: the middle one of all hosts
   that epoch. Worse is only called worse when it is clearly so. */
function monWorkCard(d) {
  const l = d.last;
  if (!l) return `<div class="card"><h3>${esc(t("How well it worked"))}</h3><p class="small">${esc(t("No finished epoch to show yet. This fills in after the node's first full epoch."))}</p></div>`;
  const row = (label, mine, typical, count) => {
    const worse = typical !== null && mine > typical * 1.5 && mine - typical > 0.01;
    const better = typical !== null && mine < typical;
    const top = Math.max(mine, typical || 0, 0.0001);
    const word = typical === null ? "" : worse ? t("more than a typical host") : better ? t("less than a typical host") : t("about the same as a typical host");
    return `
      <div class="mon-compare">
        <div class="mon-compare-top"><span>${esc(label)}</span><b class="${worse ? "bad" : ""}">${esc(monPct(mine))}</b></div>
        <div class="mon-compare-bars">
          <div class="mon-cbar ${worse ? "bad" : ""}"><i style="width:${Math.max(1, Math.round(mine / top * 100))}%"></i><span>${esc(t("this node"))} · ${esc(count)}</span></div>
          ${typical === null ? "" : `<div class="mon-cbar typ"><i style="width:${Math.max(1, Math.round(typical / top * 100))}%"></i><span>${esc(t("a typical host"))} · ${esc(monPct(typical))}</span></div>`}
        </div>
        ${word ? `<div class="small">${esc(word)}</div>` : ""}
      </div>`;
  };
  return `
    <div class="card">
      <h3>${esc(t("How well it worked in epoch {n}", { n: l.epoch }))}</h3>
      <div class="mon-kv">${esc(t("Requests answered"))} <b>${esc(monNum(l.requests))}</b></div>
      ${row(t("Requests it missed"), l.missedShare, l.typicalMissedShare, t("{n} missed", { n: monNum(l.missed) }))}
      ${l.validated + l.invalidated > 0 ? row(t("Answers judged wrong"), l.invalidShare, l.typicalInvalidShare, t("{n} of {of} checked", { n: monNum(l.invalidated), of: monNum(l.validated + l.invalidated) })) : ""}
      <p class="small">${esc(t("A typical host is the middle one of the {hosts} that took part in that epoch.", { hosts: l.hosts }))}</p>
    </div>`;
}

function monMoneyCard(d) {
  const m = d.money, v = m.vesting;
  const stream = v.next;
  let chart = "";
  if (stream.length) {
    const max = Math.max(1, ...stream), W = 420, H = 46, gap = 1, bw = (W - gap * (stream.length - 1)) / stream.length;
    chart = `<svg class="mon-chart small-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${stream.map((a, i) => {
      const h = Math.max(1, a / max * H);
      return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" class="mon-bar"><title>${esc(t("In {n} epochs: {amount}", { n: i + 1, amount: monGnk(a) }))}</title></rect>`;
    }).join("")}</svg>`;
  }
  return `
    <div class="card">
      <h3>${esc(t("Money"))}</h3>
      <div class="mon-kv">${esc(t("In the node's wallet"))} <b>${esc(monGnk(m.balance))}</b></div>
      ${m.allowance
        ? `<div class="mon-kv">${esc(t("Left for fees"))} <b>${m.allowance.limited ? esc(monGnk(m.allowance.left)) : esc(t("no limit"))}</b>${m.allowance.expires ? ` <span class="small">${esc(t("until {date}", { date: monDate(m.allowance.expires) }))}</span>` : ""}</div>
           ${more("How does the fee allowance work?", `<p>${esc(t("Since Gonka v0.2.16 the node pays network fees out of the wallet, up to this allowance. When it runs out it has to be renewed; sending more GNK does not raise it."))}</p>`)}`
        : (d.standing.known ? `<div class="warn-banner">${esc(t("No fee allowance was found for this wallet. Since Gonka v0.2.16 a node needs one to pay its fees, or it is left out of the epoch."))}</div>` : "")}
      <div class="mon-kv">${esc(t("Collateral"))} <b>${esc(monGnk(m.collateral))}</b></div>
      ${m.unbonding.length ? `<div class="mon-kv">${esc(t("Being withdrawn"))} <b>${esc(monGnk(m.unbonding.reduce((a, u) => a + u.amount, 0)))}</b></div>` : ""}
      ${m.paidElsewhere ? `<div class="mon-kv">${esc(t("Rewards are paid to"))} <b class="mono">${esc(monShort(m.recipient))}</b></div>
        <div class="mon-kv">${esc(t("That address holds"))} <b>${esc(monGnk(m.recipientBalance))}</b></div>` : ""}
      <div class="mon-sep"></div>
      <div class="mon-kv">${esc(t("Still to arrive"))} <b>${esc(monGnk(v.total))}</b> <span class="small">${esc(monUsd(v.total))}</span></div>
      ${v.epochs ? `
        <div class="mon-kv">${esc(t("In the next 7 epochs"))} <b>${esc(monGnk(v.next7))}</b></div>
        <div class="mon-kv">${esc(t("In the next 30 epochs"))} <b>${esc(monGnk(v.next30))}</b></div>
        ${chart}
        ${more("When do the rewards arrive?", `<p>${esc(t("Rewards are released a slice each epoch. This is what is already earned and still on its way, over the next {n} epochs{where}.", { n: v.epochs, where: m.paidElsewhere ? t(", at the address the rewards are paid to") : "" }))}</p>`)}`
        : `<p class="small">${esc(t("Nothing is waiting to be released."))}</p>`}
    </div>`;
}

function monHardwareCard(d) {
  const h = d.hardware;
  if (!h.nodes.length) return `<div class="card"><h3>${esc(t("Hardware"))}</h3><p class="small">${esc(t("The network has no hardware listed for this node."))}</p></div>`;
  const kinds = Object.entries(h.gpuKinds).map(([k, n]) => `${n}× ${k}`).join(", ");
  return `
    <div class="card">
      <h3>${esc(t("Hardware the network sees"))}</h3>
      <p class="small">${esc(t("{working} of {n} machines working · {gpus}", { working: h.working, n: h.nodes.length, gpus: kinds || "—" }))}</p>
      <div class="mon-table">
        <div class="mon-row mon-row-head"><span>${esc(t("Machine"))}</span><span>${esc(t("State"))}</span><span>${esc(t("GPUs"))}</span><span>${esc(t("Model"))}</span><span class="r">${esc(t("Weight"))}</span></div>
        ${h.nodes.map((n) => {
          const ok = /INFERENCE|POC|POW/i.test(n.status);
          return `<div class="mon-row">
            <span class="mono">${esc(n.id)}</span>
            <span><i class="mon-led ${ok ? "ok" : "bad"}"></i>${esc(n.status || "—")}</span>
            <span>${esc(n.gpus.map((g) => `${g.count}× ${g.type}${g.memory ? " (" + g.memory + ")" : ""}`).join(", ") || "—")}</span>
            <span>${esc(n.models.map(monModel).join(", ") || "—")}</span>
            <span class="r">${n.pocWeight ? esc(monNum(n.pocWeight)) : "—"}</span>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

function monPocCard(d) {
  const p = d.poc, st = d.standing, mt = d.maintenance;
  const lines = [];
  if (st.confirmationRatio !== null && st.known) lines.push(`<div class="mon-kv">${esc(t("Confirmation checks passed this epoch"))} <b>${esc(monPct(st.confirmationRatio, 0))}</b></div>`);
  if (st.epochsCompleted) lines.push(`<div class="mon-kv">${esc(t("Epochs completed"))} <b>${esc(monNum(st.epochsCompleted))}</b>${st.joined ? ` <span class="small">${esc(t("joined {date}", { date: monDate(st.joined) }))}</span>` : ""}</div>`);
  if (mt.credit) lines.push(`<div class="mon-kv">${esc(t("Maintenance time saved up"))} <b>${esc(t("{n} blocks", { n: monNum(mt.credit) }))}</b></div>`);
  if (mt.active) lines.push(`<div class="info-banner">${esc(t("The node is in a maintenance window right now."))}</div>`);
  const deleg = p.delegations.length ? `
    <h4>${esc(t("Validation weight it has delegated"))}</h4>
    <div class="mon-table">${p.delegations.map((x) => `<div class="mon-row two"><span>${esc(monModel(x.model))}</span><span class="mono">${esc(monShort(x.to))}</span></div>`).join("")}</div>
    <p class="small">${esc(t("For each model, the host this node lets validate on its behalf."))}</p>` : "";
  const refuse = p.refusals.length ? `<div class="mon-kv">${esc(t("Models it has refused"))} <b>${esc(p.refusals.map((x) => monModel(x.model)).join(", "))}</b></div>` : "";
  const intent = p.intents.length ? `<div class="mon-kv">${esc(t("Models it has declared for"))} <b>${esc(p.intents.map((x) => monModel(x.model)).join(", "))}</b></div>` : "";
  if (!lines.length && !deleg && !refuse && !intent) return "";
  return `<div class="card"><h3>${esc(t("Proof of Compute"))}</h3>${lines.join("")}${refuse}${intent}${deleg}</div>`;
}

/* ---- proposals --------------------------------------------------------- */

function monDoes(p) {
  const words = {
    upgrade: p.upgradeTo ? t("Upgrades the network to {name}", { name: p.upgradeTo.name }) : t("Upgrades the network's software"),
    settings: t("Changes the network's settings"),
    spend: t("Spends from the community pool"),
    contract: t("Runs a contract, often a payment"),
    payout: t("Pays out coins that unlock over time"),
    "model-add": t("Adds a model"),
    "model-remove": t("Removes a model"),
    other: t("Other")
  };
  return p.does.map((k) => words[k] || k).join(" · ");
}

function monProposalsHtml() {
  const g = MON.gov;
  if (!g) return `<div class="info-banner">${esc(t("Reading the proposals…"))}</div>`;
  if (g.error) return `<div class="warn-banner">${esc(t("Couldn't read the proposals: {why}", { why: g.error }))}</div>`;
  const live = g.proposals.filter((p) => p.status === "VOTING_PERIOD");
  const past = g.proposals.filter((p) => p.status !== "VOTING_PERIOD");
  const voteWord = { YES: t("Yes"), NO: t("No"), ABSTAIN: t("Abstain"), NO_WITH_VETO: t("No, with veto") };
  const outcome = { PASSED: t("Passed"), REJECTED: t("Rejected"), FAILED: t("Failed"), DEPOSIT_PERIOD: t("Waiting for its deposit") };
  const links = (text) => { const m = String(text).match(/https?:\/\/[^\s)]+/g) || []; return [...new Set(m)].slice(0, 3); };

  const card = (p, isLive) => {
    const cast = p.tally.voted;
    const seg = (n) => (cast > 0 ? (n / cast * 100).toFixed(2) : 0);
    const turnout = p.turnout === null ? null : Math.min(1, p.turnout);
    const needs = p.quorum;
    const mine = MON.votes[p.id] || [];
    const why = !isLive && p.status === "REJECTED" && p.yesShare > p.threshold && turnout !== null && turnout < needs
      ? t("Most votes were yes, but too few voted for it to count.") : "";
    return `
      <div class="card mon-prop">
        <div class="mon-prop-top">
          <span class="mon-prop-id">#${p.id}</span>
          ${isLive ? `<span class="pill ok">${esc(t("VOTING NOW"))}</span>` : `<span class="pill ${p.status === "PASSED" ? "ok" : "err"}">${esc(outcome[p.status] || p.status)}</span>`}
          <span class="small">${isLive ? esc(t("ends {date}", { date: monDate(p.ends) })) : esc(monDate(p.ends))}</span>
        </div>
        <h3>${esc(p.title)}</h3>
        <div class="mon-prop-does">${esc(monDoes(p))}${p.asked ? ` · ${esc(t("asks for {amount}", { amount: monGnk(p.asked) }))}` : ""}</div>
        ${p.summary ? `<details class="mon-prop-text"><summary>${esc(t("What it says"))}</summary><p>${esc(p.summary)}</p>
          ${links(p.summary).map((u) => `<a href="#" data-open="${esc(u)}">${esc(u.length > 70 ? u.slice(0, 70) + "…" : u)}</a>`).join("<br>")}</details>` : ""}
        ${cast > 0 ? `
          <div class="mon-tally" title="${esc(t("Yes {y} · No {n} · Veto {v} · Abstain {a}", { y: monPct(p.tally.yes / cast), n: monPct(p.tally.no / cast), v: monPct(p.tally.veto / cast), a: monPct(p.tally.abstain / cast) }))}">
            <i class="yes" style="width:${seg(p.tally.yes)}%"></i><i class="no" style="width:${seg(p.tally.no)}%"></i><i class="veto" style="width:${seg(p.tally.veto)}%"></i><i class="abs" style="width:${seg(p.tally.abstain)}%"></i>
          </div>
          <div class="mon-tally-key">
            <span><i class="yes"></i>${esc(t("Yes"))} ${esc(monPct(p.tally.yes / cast))}</span>
            <span><i class="no"></i>${esc(t("No"))} ${esc(monPct((p.tally.no + p.tally.veto) / cast))}</span>
            <span><i class="abs"></i>${esc(t("Abstain"))} ${esc(monPct(p.tally.abstain / cast))}</span>
          </div>` : `<p class="small">${esc(t("Nobody has voted yet."))}</p>`}
        ${isLive && turnout !== null ? `
          <div class="mon-turnout"><div class="mon-turnout-bar"><i style="width:${(turnout * 100).toFixed(1)}%"></i><b style="left:${(needs * 100).toFixed(1)}%"></b></div>
          <span class="small">${esc(t("{voted} of the network's weight has voted. It needs {needs} to count.", { voted: monPct(turnout, 0), needs: monPct(needs, 0) }))}</span></div>` : ""}
        ${why ? `<p class="small">${esc(why)}</p>` : ""}
        ${isLive && mine.length ? `<div class="mon-myvote">${mine.map((v) => `${esc(v.name)}: <b>${v.vote ? esc(voteWord[v.vote] || v.vote) : esc(t("has not voted"))}</b>`).join(" · ")}</div>` : ""}
      </div>`;
  };

  return `
    <p class="lede">${esc(t("What the network is deciding."))}</p>
    ${more("How does voting work?", `<p>${esc(t("A host votes with its node; a proposal passes when at least {quorum} of the network's weight votes and more than {threshold} of those votes are yes.", { quorum: monPct(g.rules.quorum, 0), threshold: monPct(g.rules.threshold, 0) }))}</p>`)}
    ${live.length ? live.map((p) => card(p, true)).join("") : `<div class="info-banner">${esc(t("Nothing is being voted on right now."))}</div>`}
    <h2 class="mon-h2">${esc(t("Recent proposals"))}</h2>
    ${past.map((p) => card(p, false)).join("")}`;
}
