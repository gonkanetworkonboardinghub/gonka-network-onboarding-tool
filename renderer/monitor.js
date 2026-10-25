/* monitor.js — GNOT's "Gonka Host Monitor/Vote".

   Three places, one menu: My nodes (the nodes this person follows, locked
   until there is one), The network (everyone on it, with every host listed
   underneath), and Votes (what the network is deciding, and where its shared
   money is and went). Point
   it at any node and it shows what the network itself says about it: whether
   it is in the epoch, what it earned, how well it worked next to the other
   hosts, what its wallet holds for fees, its hardware. Everything here is
   public information (src/services/monitor.js does the reading, the data job
   prepares what the chain will not hand over cheaply), so it asks for
   nothing: no key, no password, no access to a server.

   A node whose wallet is on this computer is "yours", and its page can also
   act: vote with it, open a command line on its server, and shut it down the
   way Gonka's guide says to (src/services/mynode.js). Those ask for the
   wallet passphrase or the server password each time; neither is kept.

   Shares $, esc, t, api and APP_NAME with app.js. Every name here starts with
   "mon" or "MON": the renderer scripts share one global scope. */

const MON = {
  view: "hub",        // "hub" | "mine" | "network" | "votes" | "node" | "add"
  from: null,         // the section a node's page was opened from: "mine" | "network"
  opened: false,      // the first visit lands on the first node kept, if any
  open: new Set(),    // proposals unfolded on the Votes page
  nodes: [],          // [{ address, name, wallet?, server? }] — the nodes this person keeps an eye on
  keyNames: [],       // the wallets in this computer's keyring, by name
  panel: null,        // on your own node's page: "server" | "shutdown"
  srv: { address: null, busy: false, error: null, lines: [], cwd: "", history: [], idx: 0 },
  down: null,         // { address, data, busy, error, confirm } — the way out, for the node on screen
  link: null,         // { address, open, busy, error } — linking a node to its wallet here
  ballot: null,       // { id, address, option, stage, pass, fee, error, txhash } — a vote being cast
  plots: {},          // the charts on the page now, by id (monPlot)
  propFilter: "",     // the words looked for among the proposals
  propKind: "all",    // which proposals: "all" | "money" | "passed" | "rejected"
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
/** Yours: its wallet is in this computer's keyring, so it can sign for the node. */
const monOwn = (n) => !!(n && n.wallet && MON.keyNames.includes(n.wallet));
/** A clock time some seconds from now, with the time zone named. */
const monAt = (seconds) => new Date(Date.now() + seconds * 1000).toLocaleString(monLang(), { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const monTile = (label, num, sub) => `
  <div class="mon-tile"><div class="mon-tile-label">${esc(label)}</div>
    <div class="mon-tile-num">${esc(num)}</div>
    <div class="mon-tile-sub">${sub ? esc(sub) : "&nbsp;"}</div></div>`;

/* ---- coming and going -------------------------------------------------- */

/* The tool opens on its start page: three doors (My nodes, The network,
   Votes). Every other page has the same bar along the top: a back button
   that always says where it goes, the three sections as tabs, and Refresh. */

/** Open the tool on its start page; with an address, straight on that node's page. */
async function showMonitor(address) {
  document.body.classList.remove("on-home");
  document.body.classList.add("on-monitor");
  document.title = "Gonka Host Monitor/Vote — GNOT";
  window.gonka.setCloseGuard(!!S.connected && !S.setupFinished);
  $("#monitor").innerHTML = `
    <div class="mon-shell">
      <header class="mon-top" id="mon-top"></header>
      <main class="mon-main" id="mon-main"></main>
    </div>`;
  try { MON.nodes = await api("monitorNodes"); } catch (_) { MON.nodes = []; }
  try { MON.keyNames = await api("keyNames"); } catch (_) { MON.keyNames = []; }
  api("gnkPrice").then((p) => { MON.price = p && p.usd ? p.usd : null; monRenderMain(); }).catch(() => {});
  if (address) monGo("node", address, "mine");
  else monGo("hub");
  if (!MON.timer) MON.timer = setInterval(monRefresh, MON_REFRESH_MS);
}

function leaveMonitor() {
  if (MON.timer) { clearInterval(MON.timer); MON.timer = null; }
  document.body.classList.remove("on-monitor");
  showHome();
}

/**
 * Every move inside the tool goes through here. `from` says which section a
 * node's page was opened from ("mine" or "network"), so Back returns there.
 */
function monGo(view, address, from) {
  MON.view = view;
  if (view === "node") {
    if (address !== MON.address) { MON.data = null; MON.error = null; MON.panel = null; MON.down = null; MON.link = null; }
    MON.address = address;
    MON.from = from || (monKept(address) ? "mine" : "network");
  }
  monRenderTop();
  monRenderMain();
  const main = $("#mon-main");
  if (main) main.scrollTop = 0;
  // The start page and My nodes show figures from the network page's reading too.
  if ((view === "hub" || view === "mine" || view === "network" || view === "votes") && (!MON.overview || Date.now() - MON.overviewAt > MON_REFRESH_MS)) monLoadOverview();
  // Open votes are counted on the start page, the network page and your own node's Vote button.
  if ((view === "hub" || view === "votes" || view === "network" || (view === "node" && monOwn(MON.nodes.find((n) => n.address === address)))) && !MON.gov) monLoadProposals();
  if (view === "node" && !MON.data) monLoad();
}

function monRefresh() {
  if (!document.body.classList.contains("on-monitor")) return;
  if (MON.view === "network" || MON.view === "mine" || MON.view === "hub") monLoadOverview(true);
  // Never redraw under someone typing a passphrase.
  else if (MON.view === "votes") { if (!MON.ballot) monLoadProposals(); }
  else if (MON.view === "node") monLoad(true);
}
/** The Refresh button: read the page's figures again now. */
function monRefreshNow() {
  if (MON.view === "node") monLoad();
  else if (MON.view === "votes") { MON.gov = null; monRenderMain(); monLoadProposals(); }
  else { monLoadOverview(); if (MON.view === "hub") monLoadProposals(); }
}

/* ---- the bar along the top --------------------------------------------- */

function monRenderTop() {
  const top = $("#mon-top");
  if (!top) return;
  const v = MON.view;
  const section = v === "node" ? MON.from : v === "add" ? "mine" : v;
  const back = v === "hub" ? { label: t("All tools"), go: null }
    : v === "node" ? { label: MON.from === "network" ? t("The network") : t("My nodes"), go: MON.from === "network" ? "network" : "mine" }
    : v === "add" ? { label: t("My nodes"), go: "mine" }
    : { label: "Monitor/Vote", go: "hub" };
  const tab = (id, label) => `<button class="mon-tab2${section === id ? " on" : ""}" data-tab="${id}"${section === id ? ' aria-current="page"' : ""}>${esc(label)}</button>`;
  top.innerHTML = `
    <button class="mon-back" id="mon-back"><span aria-hidden="true">←</span> ${esc(back.label)}</button>
    ${v === "hub" ? `<span class="mon-top-title">Gonka Host Monitor/Vote</span>`
      : `<nav class="mon-tabs2" aria-label="Gonka Host Monitor/Vote">${tab("mine", t("My nodes"))}${tab("network", t("The network"))}${tab("votes", t("Votes"))}</nav>`}
    <button class="mon-quiet mon-top-refresh" id="mon-refresh">${esc(t("Refresh"))}</button>`;
  $("#mon-back").onclick = () => (back.go ? monGo(back.go) : leaveMonitor());
  top.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => monGo(b.dataset.tab); });
  $("#mon-refresh").onclick = monRefreshNow;
}

/* ---- the start page ----------------------------------------------------- */

const MON_ICONS = {
  mine: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><circle cx="7.5" cy="7.25" r="1"/><circle cx="7.5" cy="16.75" r="1"/><path d="M12 7.25h5M12 16.75h5"/></svg>`,
  network: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="17.5" r="2.2"/><circle cx="19" cy="17.5" r="2.2"/><circle cx="12" cy="12.5" r="1.6"/><path d="M12 7.2v3.7M10.7 13.5 6.8 16.2M13.3 13.5l3.9 2.7M7.2 17.5h9.6"/></svg>`,
  votes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5h16v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5z"/><path d="M8 12.5V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5v8"/><path d="m10 8 1.6 1.6L14.5 6.5"/><path d="M8.5 16.5h7"/></svg>`
};

function monHubHtml() {
  const o = MON.overview, g = MON.gov;
  const open = g && g.proposals ? g.proposals.filter((p) => p.status === "VOTING_PERIOD").length : null;
  const inEpoch = o ? MON.nodes.filter((n) => o.hosts.some((h) => h.address === n.address)).length : null;
  const own = MON.nodes.filter(monOwn).length;
  const door = (go, title, text, figure, sub) => `
    <button class="mon-door" data-go="${go}">
      <span class="mon-door-icon">${MON_ICONS[go]}</span>
      <span class="mon-door-title">${esc(title)}</span>
      <span class="mon-door-text">${esc(text)}</span>
      <span class="mon-door-foot"><span class="mon-door-figure">${esc(figure)}</span><span class="mon-door-sub">${esc(sub || "")}</span></span>
      <span class="mon-door-go" aria-hidden="true">→</span>
    </button>`;
  const mineFigure = MON.nodes.length ? t(MON.nodes.length === 1 ? "1 node" : "{n} nodes", { n: monNum(MON.nodes.length) }) : t("Add your node");
  const mineSub = !MON.nodes.length ? t("Follow it, vote with it, reach its server")
    : [inEpoch !== null ? t("{n} in this epoch", { n: monNum(inEpoch) }) : "", own ? t("{n} yours", { n: monNum(own) }) : ""].filter(Boolean).join(" · ");
  return `
    <div class="mon-hero">
      <div class="mon-eyebrow">GNOT</div>
      <h1>Gonka Host Monitor/Vote</h1>
      <p>${esc(t("Follow your nodes, see the whole network, and vote on what it decides."))}</p>
    </div>
    <div class="mon-doors">
      ${door("mine", t("My nodes"), t("How your nodes are doing, what they earn, and what you can do with them."), mineFigure, mineSub)}
      ${door("network", t("The network"), t("Every host, its GPUs and what it is paid, epoch by epoch."),
        o ? t("{n} hosts", { n: monNum(o.hosts.length) }) : "…",
        o ? [o.gpus ? t("{n} GPUs", { n: monNum(o.gpus.total) }) : "", t("epoch {n}", { n: o.epoch.index })].filter(Boolean).join(" · ") : "")}
      ${door("votes", t("Votes"), t("What the network is deciding, what each proposal asks for, and your vote."),
        open === null ? "…" : open === 0 ? t("No open votes") : open === 1 ? t("1 open vote") : t("{n} open votes", { n: open }),
        g && g.proposals ? t("{n} proposals so far", { n: monNum(g.proposals.length) }) : "")}
    </div>
    <p class="small mon-hub-foot">${esc(MON.nodes.some(monOwn)
      ? t("Public information from the Gonka network. Passwords and passphrases are asked for each time and never kept.")
      : t("Public information from the Gonka network. No key, no password."))}</p>`;
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
  MON.undoTimer = setTimeout(() => { MON.undo = null; if (MON.view === "mine") monRenderMain(); }, 10000);
  // Back to the list, where "Undo" is offered for a few seconds.
  monGo("mine");
}
async function monUndoForget() {
  const u = MON.undo;
  if (!u) return;
  clearTimeout(MON.undoTimer); MON.undo = null;
  if (!monKept(u.node.address)) MON.nodes.splice(Math.min(u.index, MON.nodes.length), 0, u.node);
  await monSave();
  monRenderMain();
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
  if (MON.view === "network" || MON.view === "mine" || MON.view === "hub" || MON.view === "votes") monRenderMain();
}

async function monLoadProposals() {
  try {
    MON.gov = await api("monitorProposals");
    MON.votes = {};
    for (const p of MON.gov.proposals.filter((x) => x.status === "VOTING_PERIOD")) {
      MON.votes[p.id] = [];
      for (const n of MON.nodes) {
        try { MON.votes[p.id].push({ address: n.address, name: monName(n), vote: await api("monitorVoteOf", { id: p.id, address: n.address }) }); } catch (_) { /* unknown */ }
      }
    }
  } catch (e) { MON.gov = { error: e.message, proposals: [] }; }
  // The network page and your node's Vote button count the open votes; the Votes page is all of it.
  if (MON.view === "votes" || MON.view === "network" || MON.view === "node" || MON.view === "hub") monRenderMain();
}

/* ---- pages ------------------------------------------------------------- */

function monRenderMain() {
  const main = $("#mon-main");
  if (!main || !document.body.classList.contains("on-monitor")) return;
  MON.plots = {};
  const tip = document.getElementById("mon-tip");
  if (tip) tip.style.display = "none";
  let html;
  if (MON.view === "hub") html = monHubHtml();
  else if (MON.view === "network") html = monNetworkHtml();
  else if (MON.view === "votes") html = monVotesHtml();
  else if (MON.view === "mine") html = monMineHtml();
  else if (MON.view === "add") html = monAddHtml();
  else html = monNodePageHtml();
  // Keep the place on the page when it redraws itself (a refresh, a filter),
  // and whatever was half typed into it: a refresh comes every two minutes.
  const keep = main.scrollTop;
  const page = MON.view + ":" + (MON.address || "");
  const typed = {};
  if (MON.rendered === page) main.querySelectorAll("input[id], select[id], textarea[id]").forEach((el) => { typed[el.id] = el.value; });
  const focused = document.activeElement && main.contains(document.activeElement) ? document.activeElement.id : "";
  main.innerHTML = `<div class="mon-page mon-page-${MON.view}">${html}</div>`;
  MON.rendered = page;
  for (const [id, v] of Object.entries(typed)) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
  monDrawPlots(main);
  main.scrollTop = keep;
  monWire(main);
}

/** The buttons and links a page carries; wired after every render. */
function monWire(main) {
  main.querySelectorAll("[data-go-node]").forEach((b) => { b.onclick = () => monGo("node", b.dataset.goNode, MON.view === "network" ? "network" : "mine"); });
  main.querySelectorAll("[data-go]").forEach((b) => { b.onclick = (e) => { e.preventDefault(); monGo(b.dataset.go); }; });
  // "Every host" is the lower half of the network page.
  main.querySelectorAll("[data-go-hosts]").forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); monGo("network"); setTimeout(() => { const h = $("#mon-hosts"); if (h) h.scrollIntoView({ block: "start" }); }, 50); };
  });
  main.querySelectorAll("[data-open]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); api("openExternal", { url: a.dataset.open }); }; });
  const f = $("#mon-filter");
  if (f) {
    f.oninput = () => { MON.hostFilter = f.value; const pos = f.selectionStart; monRenderMain(); const g = $("#mon-filter"); if (g) { g.focus(); g.setSelectionRange(pos, pos); } };
  }
  if (MON.view === "add") monWireAdd();
  if (MON.view === "node") monWireNode();
  if (MON.view === "votes") { monWireVotes(main); monWireBallots(main); }
  if ($("#mon-undo")) $("#mon-undo").onclick = monUndoForget;
}

/* ---- the network ------------------------------------------------------- */

/* ---- charts ----------------------------------------------------------------
   A page only leaves a placeholder (monPlot); monDrawPlots draws it once the
   page is in place, at the size it really has, so the scale on the left and
   the dates underneath stay sharp at any width. Long histories are a line,
   short ones columns. Wherever the pointer is, or with the arrow keys once
   the chart has focus, it tells the exact figure and when. */

/**
 * A chart's place on the page. spec: { label, kind: "line" | "bars", unit, fmt(v),
 * points: [{ y, gap, x, tip: [value…, when] }] }. With `series: [{ label }]` it
 * is several lines on one scale (same unit only), each point carrying `ys`,
 * and a legend above it; the second line is dashed, so color is never alone.
 */
function monPlot(id, spec) {
  MON.plots[id] = spec;
  const legend = spec.series ? `<div class="mon-legend">${spec.series.map((s, i) => `<span><i class="mon-key s${i}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
  return `${legend}<div class="mon-plot" data-plot="${id}" tabindex="0" role="img" aria-label="${esc(spec.label)}" style="height:${spec.height || 190}px"></div>`;
}
/** Round steps for the scale: 0, 50, 100, 150… with the top at or above the largest value. */
function monTicks(max) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  const out = [];
  for (let v = 0; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(v);
  return out;
}
/** "Oct 3" under the chart; the full date and time, with its zone, in the readout. */
const monDay = (iso) => (iso ? new Date(iso).toLocaleDateString(monLang(), { month: "short", day: "numeric" }) : "");
const monWhenFull = (iso) => (iso ? new Date(iso).toLocaleString(monLang(), { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "");
/** "Epoch 435 · began Oct 23, 2026, 3:12 PM EDT"; "about" when it is worked out rather than recorded. */
const monEpochWhen = (p) => (p.at
  ? t(p.est ? "Epoch {n} · began about {when}" : "Epoch {n} · began {when}", { n: p.epoch, when: monWhenFull(p.at) })
  : t("Epoch {n}", { n: p.epoch }));

function monDrawPlots(root) {
  if (!root) return;
  const NS = "http://www.w3.org/2000/svg";
  root.querySelectorAll("[data-plot]").forEach((el) => {
    const spec = MON.plots[el.dataset.plot];
    const W = el.clientWidth, H = el.clientHeight;
    if (!spec || !spec.points.length || !W || !H) return;
    const pts = spec.points, n = pts.length;
    const lanes = spec.series ? spec.series.length : 1;
    const valOf = (p, s) => (spec.series ? (p.ys || [])[s] : p.y);
    const ticks = monTicks(Math.max(0, ...pts.flatMap((p) => Array.from({ length: lanes }, (_, s) => valOf(p, s) || 0))));
    const top = ticks[ticks.length - 1] || 1;
    const labels = ticks.map(spec.fmt);
    // Several lines are labelled at their right-hand end, so they need room there.
    const ends = spec.series ? Array.from({ length: lanes }, (_, s) => { for (let i = n - 1; i >= 0; i--) if (valOf(pts[i], s) != null) return { i, v: valOf(pts[i], s) }; return null; }) : [];
    const endW = ends.length ? Math.ceil(Math.max(...ends.map((x) => (x ? spec.fmt(x.v).length : 0))) * 7.2) + 12 : 0;
    const pad = { l: Math.ceil(Math.max(...labels.map((s) => s.length), (spec.unit || "").length) * 7.2) + 14, r: 12 + endW, t: spec.unit ? 24 : 10, b: 26 };
    const pw = Math.max(10, W - pad.l - pad.r), ph = Math.max(10, H - pad.t - pad.b);
    const bars = spec.kind === "bars";
    const slot = bars ? pw / n : (n > 1 ? pw / (n - 1) : pw);
    const xOf = (i) => pad.l + (bars ? slot * (i + 0.5) : (n > 1 ? i * slot : pw / 2));
    const yOf = (v) => pad.t + ph - (v / top) * ph;
    const base = pad.t + ph;
    let s = "";
    // The scale: hairlines with round figures at the left.
    ticks.forEach((v, i) => {
      const y = yOf(v).toFixed(1);
      s += `<line class="mon-plot-grid${i === 0 ? " base" : ""}" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
      s += `<text class="mon-plot-tick" x="${pad.l - 8}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${esc(labels[i])}</text>`;
    });
    if (spec.unit) s += `<text class="mon-plot-tick mon-plot-unit" x="${pad.l - 8}" y="12" text-anchor="end">${esc(spec.unit)}</text>`;
    // Dates underneath: the first, the last and a few between, never crowded.
    const count = Math.max(2, Math.min(n, Math.floor(pw / 96)));
    const marks = [...new Set(Array.from({ length: count }, (_, k) => Math.round(k * (n - 1) / Math.max(1, count - 1))))];
    marks.forEach((i, k) => {
      const anchor = bars ? "middle" : k === 0 ? "start" : k === marks.length - 1 ? "end" : "middle";
      s += `<text class="mon-plot-tick" x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(pts[i].x || "")}</text>`;
    });
    // The data.
    if (bars) {
      const bw = Math.max(1, Math.min(24, slot - 2));
      pts.forEach((p, i) => {
        const x = xOf(i) - bw / 2;
        if (p.gap === "unknown") s += `<rect class="mon-plot-unknown" data-i="${i}" x="${x.toFixed(1)}" y="${(base - 8).toFixed(1)}" width="${bw.toFixed(1)}" height="8"/>`;
        else if (p.gap || !(p.y > 0)) s += `<rect class="mon-plot-none" data-i="${i}" x="${x.toFixed(1)}" y="${(base - 2).toFixed(1)}" width="${bw.toFixed(1)}" height="2"/>`;
        else {
          const y = yOf(p.y), r = Math.min(4, bw / 2, base - y);
          s += `<path class="mon-plot-bar" data-i="${i}" d="M${x.toFixed(1)},${base}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)}V${base}Z"/>`;
        }
      });
    } else {
      // A gap in the record breaks the line rather than being drawn as zero.
      // The first series gets a faint wash under it; the others are lines only.
      for (let lane = lanes - 1; lane >= 0; lane--) {
        let line = "", area = "", run = [];
        const flush = () => {
          if (!run.length) return;
          line += run.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
          area += `M${run[0][0].toFixed(1)},${base}` + run.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("") + `L${run[run.length - 1][0].toFixed(1)},${base}Z`;
          run = [];
        };
        pts.forEach((p, i) => { const v = valOf(p, lane); if (p.gap || v == null) flush(); else run.push([xOf(i), yOf(v)]); });
        flush();
        s += `${lane === 0 ? `<path class="mon-plot-area" d="${area}"/>` : ""}<path class="mon-plot-line s${lane}" d="${line}"/>`;
        // With only a few points, each one is marked, so a short line still reads as measurements.
        if (n <= 30) pts.forEach((p, i) => { const v = valOf(p, lane); if (!p.gap && v != null) s += `<circle class="mon-plot-mark s${lane}" r="3" cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}"/>`; });
      }
      // Each line's latest figure at its end, unless two would sit on top of each other.
      const ys = ends.map((x) => (x ? yOf(x.v) : null));
      const apart = ys.every((y, a) => ys.every((z, b) => a === b || y === null || z === null || Math.abs(y - z) >= 15));
      if (ends.length && apart) ends.forEach((x, lane) => { if (x) s += `<text class="mon-plot-end" x="${(xOf(x.i) + 6).toFixed(1)}" y="${(yOf(x.v) + 4).toFixed(1)}">${esc(spec.fmt(x.v))}</text>`; });
    }
    s += `<line class="mon-plot-cross" x1="0" x2="0" y1="${pad.t}" y2="${base}" visibility="hidden"/>`;
    if (!bars) for (let lane = 0; lane < lanes; lane++) s += `<circle class="mon-plot-dot s${lane}" r="4" cx="0" cy="0" visibility="hidden"/>`;
    el.innerHTML = `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${s}</svg>`;
    el._plot = { spec, pad, pw, slot, bars, n, xOf, yOf, valOf, i: null };
    monWirePlot(el);
  });
}

// Charts are drawn to the size they have, so a resized or zoomed window redraws them.
let monResized = null;
window.addEventListener("resize", () => {
  clearTimeout(monResized);
  monResized = setTimeout(() => { if (document.body.classList.contains("on-monitor")) monDrawPlots($("#mon-main")); }, 120);
});

/** The readout: one for the whole page, placed beside the pointer. */
function monTip() {
  let tip = document.getElementById("mon-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "mon-tip";
    tip.className = "mon-tip";
    document.body.appendChild(tip);
  }
  return tip;
}
/**
 * Fill the readout: the figure first, then the details and when. With several
 * lines, one figure each, keyed to its line, then when.
 */
function monTipFill(tip, rows, keyed) {
  tip.textContent = "";
  rows.filter((r) => r).forEach((text, i, all) => {
    const strong = keyed ? i < all.length - 1 || all.length === 1 : i === 0;
    const row = document.createElement(strong ? "b" : "span");
    const last = !strong;
    if (keyed && !last) { const k = document.createElement("i"); k.className = "mon-key s" + i; row.appendChild(k); }
    row.appendChild(document.createTextNode(text || ""));
    tip.appendChild(row);
  });
}
function monPlotShow(el, i, clientX, clientY) {
  const P = el._plot;
  if (!P) return;
  i = Math.max(0, Math.min(P.n - 1, i));
  P.i = i;
  const p = P.spec.points[i];
  const svg = el.querySelector("svg");
  const x = P.xOf(i);
  const cross = svg.querySelector(".mon-plot-cross");
  cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
  svg.querySelectorAll(".mon-plot-dot").forEach((dot, lane) => {
    const v = P.valOf(p, lane);
    if (v != null && !p.gap) { dot.setAttribute("cx", x); dot.setAttribute("cy", P.yOf(v)); dot.setAttribute("visibility", "visible"); }
    else dot.setAttribute("visibility", "hidden");
  });
  svg.querySelectorAll("[data-i]").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
  const tip = monTip();
  monTipFill(tip, p.tip, !!P.spec.series);
  tip.style.display = "block";
  const box = el.getBoundingClientRect();
  const px = clientX != null ? clientX : box.left + x;
  const py = clientY != null ? clientY : box.top + P.pad.t;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = px + 16;
  if (left + w > window.innerWidth - 8) left = px - w - 16;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, py - h / 2)) + "px";
}
function monPlotHide(el) {
  const tip = document.getElementById("mon-tip");
  if (tip) tip.style.display = "none";
  const svg = el.querySelector("svg");
  if (!svg) return;
  svg.querySelectorAll(".mon-plot-cross, .mon-plot-dot").forEach((m) => m.setAttribute("visibility", "hidden"));
  svg.querySelectorAll("[data-i].on").forEach((b) => b.classList.remove("on"));
}
function monWirePlot(el) {
  const at = (e) => {
    const P = el._plot, x = e.clientX - el.getBoundingClientRect().left - P.pad.l;
    return P.bars ? Math.floor(x / P.slot) : Math.round(x / P.slot);
  };
  el.onpointermove = (e) => monPlotShow(el, at(e), e.clientX, e.clientY);
  el.onpointerleave = () => { if (document.activeElement !== el) monPlotHide(el); };
  el.onfocus = () => monPlotShow(el, el._plot.i == null ? el._plot.n - 1 : el._plot.i);
  el.onblur = () => monPlotHide(el);
  el.onkeydown = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -1e9, End: 1e9 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    monPlotShow(el, (el._plot.i == null ? el._plot.n - 1 : el._plot.i) + step);
  };
}

function monNetworkHtml() {
  const o = MON.overview;
  const head = `<div class="mon-title-row"><h1>${esc(t("The Gonka network"))}</h1>
    ${o ? `<span class="mon-title-sub">${esc(t("Epoch {n} · next Proof of Compute in {when}", { n: o.epoch.index, when: monSpan(o.epoch.secondsToNextPoc) }))}</span>` : ""}</div>`;
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
      ${(() => {
        // The community pool lives on the Votes page now, with where its money went.
        const open = MON.gov && MON.gov.proposals ? MON.gov.proposals.filter((p) => p.status === "VOTING_PERIOD").length : null;
        return `<button class="mon-tile mon-tile-link" data-go="votes"><div class="mon-tile-label">${esc(t("Open votes"))}</div>
          <div class="mon-tile-num">${open === null ? "—" : esc(monNum(open))}</div>
          <div class="mon-tile-sub">${esc(t("See them under Votes →"))}</div></button>`;
      })()}
    </div>`;
  const past = o.past;
  const charts = past.length ? `
    <div class="mon-two">
      <div class="card"><h3>${esc(t("Hosts, epoch by epoch"))}</h3>
        ${monPlot("hosts", { label: t("Hosts, epoch by epoch"), kind: "line", fmt: (v) => monNum(v),
          points: past.map((p) => ({ y: p.hosts, x: monDay(p.at) || String(p.epoch), tip: [t("{n} hosts", { n: monNum(p.hosts) }), monEpochWhen(p)] })) })}
        <p class="small">${esc(t("{a} hosts then, {b} now.", { a: past[0].hosts, b: o.hosts.length }))}</p></div>
      ${monGpusCard(o)}
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
  // Every host, underneath the figures: one page for the whole network.
  const q = MON.hostFilter.trim().toLowerCase();
  const rows = q ? o.hosts.filter((h) => h.address.toLowerCase().includes(q) || h.models.join(" ").toLowerCase().includes(q) || (MON.nodes.find((n) => n.address === h.address && n.name.toLowerCase().includes(q)))) : o.hosts;
  const hosts = `
    <div class="card" id="mon-hosts">
      <div class="mon-card-head"><h3>${esc(t("Every host"))}</h3><span class="small">${esc(t("{n} hosts in epoch {e}. Click one to see everything about it.", { n: o.hosts.length, e: o.epoch.index }))}</span></div>
      <input type="text" id="mon-filter" class="mon-search" placeholder="${esc(t("Find a host by address, name or model"))}" value="${esc(MON.hostFilter)}" spellcheck="false">
      ${rows.length ? monHostRows(rows) : `<p class="small">${esc(t("No host matches."))}</p>`}
    </div>`;
  return head + tiles + charts + runs + hosts;
}

/* The GPUs that took part, epoch by epoch. A count of cards treats an H100
   and a B300 alike, so pointing at an epoch also tells its mix. */
const monKindsLine = (kinds) => Object.entries(kinds || {}).sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k === "Other" ? t("Other") : k} ${monNum(n)}`).join(" · ");
function monGpusCard(o) {
  const cap = o.capacity || [];
  const head = `<h3>${esc(t("GPUs, epoch by epoch"))}</h3>`;
  if (!cap.length) return `<div class="card">${head}<p class="small">${esc(t("Not collected yet. It fills in over the next few hours."))}</p></div>`;
  const now = cap[cap.length - 1];
  const plot = monPlot("gpus", {
    label: t("GPUs, epoch by epoch"), kind: "line", fmt: (v) => monNum(v),
    points: cap.map((c) => ({
      y: c.gpus, x: monDay(c.at) || String(c.epoch),
      tip: [t("{n} GPUs took part", { n: monNum(c.gpus) }), monKindsLine(c.kinds), monEpochWhen(c)]
    }))
  });
  return `<div class="card">${head}${plot}
    <p class="small">${esc(t("{a} GPUs then, {b} in epoch {n}. Point at an epoch to see which kinds.", { a: monNum(cap[0].gpus), b: monNum(now.gpus), n: now.epoch }))}</p>
    ${more("What does this count?", `
      <p>${esc(t("Every card the hosts report on the machines that did work in that epoch. The hosts report their own hardware; the network does not check it. GPUs differ a great deal, so the mix matters as much as the number."))}</p>
      <p>${esc(t("The network keeps only each host's latest hardware report, so the past comes from Gonkascan's record, which it has kept every epoch. GNOT measures each new epoch itself, and the two agree."))}
        <a href="#" data-open="https://gonkascan.com">gonkascan.com</a></p>`)}
  </div>`;
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

/* ---- My nodes -------------------------------------------------------- */

const MON_LOCK = `<svg class="mon-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>`;

/**
 * Every node kept here as a card: whether it is in the epoch, its share, what
 * it earned last epoch, its GPUs. The figures come from the network page's
 * reading, so one question covers every card. "Add a node" is the last card.
 */
function monMineHtml() {
  if (!MON.nodes.length) return monMineEmptyHtml();
  const o = MON.overview;
  const card = (n) => {
    const h = o ? o.hosts.find((x) => x.address === n.address) : null;
    const state = !o ? ["wait", t("Reading…")] : h ? (h.excluded ? ["bad", t("Left out of epoch {n}", { n: o.epoch.index })] : ["ok", t("In epoch {n}", { n: o.epoch.index })]) : ["bad", t("Not in epoch {n}", { n: o.epoch.index })];
    const fig = (label, value) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    return `
      <button class="mon-node-card" data-go-node="${esc(n.address)}">
        <span class="mon-nc-top"><span class="mon-nc-state ${state[0]}"><i></i>${esc(state[1])}</span>${monOwn(n) ? `<span class="pill ok mon-yours">${esc(t("Yours"))}</span>` : ""}</span>
        <span class="mon-nc-name">${esc(monName(n))}</span>
        <span class="mon-nc-addr mono">${esc(monShort(n.address))}</span>
        <span class="mon-nc-figs">
          ${fig(t("Share"), h ? monPct(h.share, 2) : "—")}
          ${fig(t("Last epoch"), h && h.lastReward !== null ? monGnkShort(h.lastReward) : "—")}
          ${fig(t("GPUs"), h && h.gpus !== null ? monNum(h.gpus) : "—")}
        </span>
      </button>`;
  };
  const linkable = MON.keyNames.length && !MON.nodes.some(monOwn);
  return `
    <div class="mon-title-row"><h1>${esc(t("My nodes"))}</h1>
      <span class="mon-title-sub">${esc(t(MON.nodes.length === 1 ? "1 node" : "{n} nodes", { n: monNum(MON.nodes.length) }))}</span></div>
    ${MON.undo ? `<div class="mon-undo-bar">${esc(t("Removed {name}.", { name: monName(MON.undo.node) }))} <button id="mon-undo">${esc(t("Undo"))}</button></div>` : ""}
    <div class="mon-nodes">
      ${MON.nodes.map(card).join("")}
      <button class="mon-node-card add" data-go="add">
        <span class="mon-nc-plus" aria-hidden="true">+</span>
        <span class="mon-nc-name">${esc(t("Add a node"))}</span>
        <span class="mon-nc-addr">${esc(t("Any node on the network, by its address"))}</span>
      </button>
    </div>
    ${linkable ? `<p class="small mon-mine-hint">${esc(t("To vote, reach the server and shut down from here, open your node and link its wallet."))}</p>` : ""}`;
}

/** Before there is a node: what My nodes will hold, locked, and the way in. */
function monMineEmptyHtml() {
  const what = [
    [t("Status"), t("whether it is in the epoch, and why not when it is not")],
    [t("Earnings"), t("what it earned, next to a typical host")],
    [t("Fees and collateral"), t("what is left for fees, and what is staked")],
    [t("Vote"), t("on the network's proposals, with your node")],
    [t("Your server"), t("a terminal to your server, from here")],
    [t("Shut down safely"), t("Gonka's steps for leaving, done for you")]
  ];
  return `
    <div class="mon-empty">
      <span class="mon-door-icon big">${MON_ICONS.mine}</span>
      <h1>${esc(t("My nodes"))}</h1>
      <p class="lede">${esc(t("Add your node to follow it here, and to act on it."))}</p>
      <div class="btn-row">
        <button class="primary" data-go="add">${esc(t("Add your node"))}</button>
        <button data-go-hosts="1">${esc(t("Find it among every host"))}</button>
      </div>
    </div>
    <div class="mon-locked">
      ${what.map(([a, b]) => `<div class="mon-lock-tile">${MON_LOCK}<b>${esc(a)}</b><span>${esc(b)}</span></div>`).join("")}
    </div>
    <p class="small" style="margin-top:12px">${esc(t("Voting, the command line and shutting down work for a node whose wallet is on this computer, such as one set up with GNOT here."))}</p>`;
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
      <p class="small">${esc(t("The address starts with gonka1. Any node works, however it was set up."))} <a href="#" data-go-hosts="1">${esc(t("Or pick one from every host on the network."))}</a></p>
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
  const own = monOwn(kept);
  const head = `
    <div class="mon-head">
      <div class="mon-head-id">
        <h1>${esc(monName(node))}${own ? ` <span class="pill ok mon-yours">${esc(t("Yours"))}</span>` : ""}</h1>
        <div class="mon-head-addr mono" id="mon-copy" title="${esc(t("Copy address"))}">${esc(node.address)}</div>
      </div>
      <div class="mon-head-tools">
        <span class="small" id="mon-age">${!MON.at || !MON.data ? "" : Date.now() - MON.at < 60000 ? esc(t("read just now")) : esc(t("read {when} ago", { when: monSpan((Date.now() - MON.at) / 1000) }))}</span>
        ${kept ? `<button id="mon-rename" class="mon-quiet">${esc(t("Rename"))}</button><button id="mon-remove" class="mon-quiet">${esc(t("Remove"))}</button>`
               : `<button id="mon-keep" class="primary">${esc(t("Add to your nodes"))}</button>`}
      </div>
    </div>`;
  let body;
  if (MON.error && !MON.data) body = `<div class="warn-banner">${esc(t("Couldn't read the network: {why}", { why: MON.error }))}</div>`;
  else if (!MON.data) body = `<div class="info-banner">${esc(t("Reading what the network says about this node…"))}</div>`;
  else body = monNodeHtml(MON.data);
  // Your own node can act; a kept one whose wallet may be here can be linked to it.
  const acts = own ? monActionsHtml(kept) : kept ? monLinkHtml(kept) : "";
  return head + acts + body;
}
function monWireNode() {
  const node = MON.nodes.find((n) => n.address === MON.address) || { address: MON.address, name: "" };
  $("#mon-copy").onclick = async () => { try { await navigator.clipboard.writeText(node.address); $("#mon-copy").classList.add("copied"); setTimeout(() => $("#mon-copy") && $("#mon-copy").classList.remove("copied"), 1200); } catch (_) {} };
  if ($("#mon-keep")) $("#mon-keep").onclick = async () => { await monKeep(MON.address, ""); monRenderMain(); };
  if ($("#mon-remove")) $("#mon-remove").onclick = () => monForget(MON.address);
  if ($("#mon-rename")) $("#mon-rename").onclick = () => monRename(node);
  if (monOwn(node)) monWireActions(node);
  else if ($("#mon-link") || $("#mon-link-go")) monWireLink(node);
}

/* ---- your own node: vote, its server, the way out ---------------------- */

function monActionsHtml(node) {
  const open = MON.gov && MON.gov.proposals ? MON.gov.proposals.filter((p) => p.status === "VOTING_PERIOD").length : null;
  const on = MON.srv.address === node.address;
  const act = (id, title, sub, lit) => `
    <button class="mon-action${lit ? " on" : ""}" data-act="${id}" aria-expanded="${lit ? "true" : "false"}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  const panel = MON.panel === "server" ? monServerHtml(node) : MON.panel === "shutdown" ? monShutdownHtml(node) : "";
  return `
    <div class="mon-actions">
      ${act("vote", t("Vote"), open === null ? t("on the network's proposals") : open === 0 ? t("No open votes") : open === 1 ? t("1 open vote") : t("{n} open votes", { n: open }), false)}
      ${act("server", t("Your server"), on ? t("connected") : t("a command line on your server"), MON.panel === "server")}
      ${act("shutdown", t("Shut down safely"), t("Gonka's steps for leaving"), MON.panel === "shutdown")}
    </div>
    ${panel}`;
}
function monWireActions(node) {
  document.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === "vote") { monGo("votes"); return; }
      MON.panel = MON.panel === a ? null : a;
      if (MON.panel === "shutdown") monLoadShutdown(node);
      monRenderMain();
    };
  });
  if (MON.panel === "server") monWireServer(node);
  if (MON.panel === "shutdown") monWireShutdown(node);
}

/* Linking a node to its wallet, so it can vote, reach its server and shut
   down from here. Two ways: a wallet already saved on this computer (unlock
   it once; its address must be the node's), or the wallet's 24 words (checked
   against the node before anything is saved). Only the wallet's name is kept
   with the node; passphrases and words never are. */
const MON_KEY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>`;

function monLinkHtml(node) {
  const l = MON.link && MON.link.address === node.address ? MON.link : null;
  if (!l || !l.open) {
    return `
      <div class="mon-linkcta">
        <span class="mon-yv-icon">${MON_KEY_ICON}</span>
        <div class="mon-yv-body">
          <b>${esc(t("Link your wallet"))}</b>
          <span>${esc(t("Is this your node? Voting, the command line and shutting down sign with its own wallet. Link it once, and they work from here."))}</span>
        </div>
        <button class="primary" id="mon-link">${esc(t("Link your wallet"))}</button>
      </div>`;
  }
  const saved = MON.keyNames.length > 0;
  const mode = l.mode || (saved ? "saved" : "words");
  const tab = (id, label) => `<button type="button" class="${mode === id ? "on" : ""}" data-link-mode="${id}" role="radio" aria-checked="${mode === id}">${esc(label)}</button>`;
  return `
    <div class="card mon-link-form">
      <div class="mon-card-head"><h3>${esc(t("Link your wallet"))}</h3><button class="mon-quiet" id="mon-link-cancel">${esc(t("Cancel"))}</button></div>
      <div class="seg" role="radiogroup">
        ${saved ? tab("saved", t("A wallet on this computer")) : ""}
        ${tab("words", t("Bring it here with its 24 words"))}
      </div>
      ${mode === "saved" ? `
        <div class="field-row two">
          <label class="field"><span class="lbl">${esc(t("Wallet on this computer"))}</span>
            <select id="mon-link-name">${MON.keyNames.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select></label>
          <label class="field"><span class="lbl">${esc(t("Wallet passphrase"))}</span>
            <input type="password" id="mon-link-pass" autocomplete="off"></label>
        </div>
        <p class="small">${esc(t("The passphrase only unlocks the wallet to check its address. It is not kept."))}</p>` : `
        <label class="field"><span class="lbl">${esc(t("The wallet's 24 recovery words, in order"))}</span>
          <textarea id="mon-link-words" class="mono" rows="3" spellcheck="false" autocomplete="off"></textarea></label>
        <div class="field-row two">
          <label class="field"><span class="lbl">${esc(saved ? t("Passphrase of the wallets on this computer") : t("Choose a passphrase to lock it"))}</span>
            <input type="password" id="mon-link-pass" autocomplete="off"></label>
          ${saved ? "" : `<label class="field"><span class="lbl">${esc(t("The passphrase again"))}</span>
            <input type="password" id="mon-link-pass2" autocomplete="off"></label>`}
        </div>
        <p class="small">${esc(t("The words are checked against this node first: nothing is saved unless they are its wallet. The wallet is then kept on this computer, locked with the passphrase, the same way Host Setup does it. The words themselves are not kept, and never leave this computer."))}</p>`}
      <div class="btn-row"><button class="primary" id="mon-link-go" ${l.busy ? "disabled" : ""}>${esc(l.busy ? t("Checking…") : t("Link"))}</button></div>
      ${l.error ? `<p class="small mon-err">${esc(l.error)}</p>` : ""}
    </div>`;
}

function monWireLink(node) {
  const l = MON.link && MON.link.address === node.address ? MON.link : null;
  if (!l || !l.open) {
    $("#mon-link").onclick = () => { MON.link = { address: node.address, open: true }; monRenderMain(); monFocusLink(); };
    return;
  }
  $("#mon-link-cancel").onclick = () => { MON.link = null; monRenderMain(); };
  document.querySelectorAll("[data-link-mode]").forEach((b) => { b.onclick = () => { l.mode = b.dataset.linkMode; l.error = null; monRenderMain(); monFocusLink(); }; });
  const mode = l.mode || (MON.keyNames.length ? "saved" : "words");
  const go = async () => {
    const passphrase = $("#mon-link-pass").value;
    let words = "";
    if (mode === "words") {
      words = $("#mon-link-words").value.trim().split(/\s+/).join(" ");
      if (words.split(" ").length < 12) { l.error = t("Enter the wallet's 24 recovery words."); monRenderMain(); return; }
      if (!MON.keyNames.length && passphrase !== ($("#mon-link-pass2") || {}).value) { l.error = t("The two passphrases are not the same."); monRenderMain(); return; }
      if (passphrase.length < 8) { l.error = t("Use a passphrase of at least 8 characters."); monRenderMain(); return; }
    } else if (!passphrase) { l.error = t("Enter the wallet passphrase."); monRenderMain(); return; }
    l.busy = true; l.error = null; monRenderMain();
    try {
      let name;
      if (mode === "words") {
        name = (await api("keyImportForNode", { address: node.address, mnemonic: words, passphrase })).name;
        MON.keyNames = await api("keyNames");
      } else {
        name = $("#mon-link-name") ? $("#mon-link-name").value : "";
        const k = await api("keyShow", { name, passphrase });
        if (k.address !== node.address) throw new Error(t("The wallet \"{name}\" is {address}, not this node's wallet.", { name, address: monShort(k.address) }));
      }
      node.wallet = name;
      // The setup on this computer may still know how to reach its server.
      const s = typeof loadSession === "function" ? loadSession() : null;
      if (!node.server && s && s.wallet && s.wallet.address === node.address) {
        node.server = s.mode === "local" ? { mode: "local" } : { mode: "ssh", ...s.ssh, auth: s.ssh && s.ssh.auth === "password" ? "password" : "key" };
      }
      await monSave();
      MON.link = null;
    } catch (e) { l.busy = false; l.error = e.message; }
    monRenderMain();
  };
  $("#mon-link-go").onclick = go;
  $("#mon-link-pass").onkeydown = (e) => { if (e.key === "Enter") go(); };
}
function monFocusLink() {
  const f = $("#mon-link-words") || $("#mon-link-pass");
  if (f) f.focus();
}

/* ---- a command line on your server ------------------------------------- */

const MON_QUICK = [
  ["Containers", "docker compose -f docker-compose.yml -f docker-compose.mlnode.yml ps"],
  ["Node log", "docker compose -f docker-compose.yml logs --tail 60 node"],
  ["GPUs", "nvidia-smi"],
  ["Disk space", "df -h"]
];

function monServerHtml(node) {
  const s = node.server || {};
  const v = MON.srv;
  if (v.address !== node.address) {
    // Not connected: how to reach it, filled in from last time.
    const local = s.mode === "local";
    const auth = s.auth === "password" ? "password" : "key";
    return `
      <div class="card mon-panel">
        <h3>${esc(t("Connect to your server"))}</h3>
        ${local ? `<p class="small">${esc(t("This node runs on this computer."))}</p>` : `
        <div class="field-row">
          <label class="field"><span class="lbl">${esc(t("Server address (IP or hostname)"))}</span><input type="text" id="mon-s-host" class="mono" value="${esc(s.host || "")}" placeholder="203.0.113.42"></label>
          <label class="field"><span class="lbl">${esc(t("SSH port"))}</span><input type="number" id="mon-s-port" class="mono" value="${esc(String(s.port || 22))}"></label>
          <label class="field"><span class="lbl">${esc(t("Username"))}</span><input type="text" id="mon-s-user" class="mono" value="${esc(s.username || "root")}"></label>
        </div>
        <div class="field"><span class="lbl">${esc(t("How do you log in?"))}</span>
          <select id="mon-s-auth"><option value="key" ${auth === "key" ? "selected" : ""}>${esc(t("SSH key file"))}</option><option value="password" ${auth === "password" ? "selected" : ""}>${esc(t("Password"))}</option></select></div>
        <div id="mon-s-keybox" ${auth === "key" ? "" : "hidden"}>
          <div class="field-row two">
            <label class="field"><span class="lbl">${esc(t("Private key file"))}</span><input type="text" id="mon-s-key" class="mono" value="${esc(s.privateKeyPath || "")}"></label>
            <label class="field"><span class="lbl">${esc(t("Key passphrase (leave empty if none)"))}</span><input type="password" id="mon-s-keypass" autocomplete="off"></label>
          </div>
          <button id="mon-s-pick" class="mon-quiet">${esc(t("Choose file…"))}</button>
        </div>
        <div id="mon-s-passbox" ${auth === "password" ? "" : "hidden"}>
          <label class="field"><span class="lbl">${esc(t("Password"))}</span><input type="password" id="mon-s-pass" autocomplete="off"></label>
        </div>`}
        <div class="btn-row"><button class="primary" id="mon-s-connect" ${v.busy ? "disabled" : ""}>${esc(v.busy ? t("Connecting…") : t("Connect"))}</button></div>
        ${v.error ? `<p class="small mon-err">${esc(v.error)}</p>` : ""}
        <p class="small">${esc(t("Passwords and passphrases are used to connect and then forgotten. The address and username are kept for next time."))}</p>
      </div>`;
  }
  return `
    <div class="card mon-panel">
      <div class="mon-card-head"><h3>${esc(t("Your server"))}</h3><span class="small mono">${esc(v.info || "")}</span><button id="mon-s-off" class="mon-quiet">${esc(t("Disconnect"))}</button></div>
      <div class="mon-quick">${MON_QUICK.map(([label, cmd], i) => `<button class="mon-quiet" data-quick="${i}" title="${esc(cmd)}">${esc(t(label))}</button>`).join("")}</div>
      <pre class="mon-term-out mono" id="mon-term-out">${v.lines.map((l) => `<span class="${l.err ? "err" : l.cmd ? "cmd" : ""}">${esc(l.text)}</span>`).join("")}</pre>
      <form class="mon-term-form" id="mon-term-form" autocomplete="off">
        <span class="mono mon-term-prompt">${esc((v.cwd || "~") + " $")}</span>
        <input type="text" id="mon-term-in" class="mono" spellcheck="false" placeholder="${esc(t("run a command on your server — try: docker compose ps"))}" ${v.busy ? "disabled" : ""}>
      </form>
      <p class="small mon-ai">${esc(t("Stuck? Copy what you see here into an AI such as ChatGPT or Claude and ask what to do. Never paste a password or your 24 words."))}
        <button class="mon-quiet" id="mon-term-copy">${esc(t("Copy the output"))}</button></p>
    </div>`;
}
function monWireServer(node) {
  const v = MON.srv;
  if (v.address !== node.address) {
    const auth = $("#mon-s-auth");
    if (auth) auth.onchange = () => { $("#mon-s-keybox").hidden = auth.value !== "key"; $("#mon-s-passbox").hidden = auth.value !== "password"; };
    if ($("#mon-s-pick")) $("#mon-s-pick").onclick = async () => { const p = await api("pickFile"); if (p) $("#mon-s-key").value = p; };
    $("#mon-s-connect").onclick = () => monConnect(node);
    ["mon-s-pass", "mon-s-keypass"].forEach((id) => { const el = $("#" + id); if (el) el.onkeydown = (e) => { if (e.key === "Enter") monConnect(node); }; });
    return;
  }
  const out = $("#mon-term-out");
  if (out) out.scrollTop = out.scrollHeight;
  $("#mon-s-off").onclick = async () => { try { await api("mineDisconnect"); } catch (_) {} MON.srv = { address: null, busy: false, error: null, lines: [], cwd: "", history: v.history, idx: v.history.length }; monRenderMain(); };
  document.querySelectorAll("[data-quick]").forEach((b) => { b.onclick = () => monRun(MON_QUICK[Number(b.dataset.quick)][1]); });
  const input = $("#mon-term-in");
  $("#mon-term-form").onsubmit = (e) => { e.preventDefault(); const c = input.value.trim(); if (c) { input.value = ""; monRun(c); } };
  input.onkeydown = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!v.history.length) return;
    e.preventDefault();
    v.idx = Math.max(0, Math.min(v.history.length, v.idx + (e.key === "ArrowUp" ? -1 : 1)));
    input.value = v.history[v.idx] || "";
  };
  $("#mon-term-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(v.lines.map((l) => l.text).join("")); $("#mon-term-copy").textContent = "✓"; setTimeout(() => { const b = $("#mon-term-copy"); if (b) b.textContent = t("Copy the output"); }, 1500); } catch (_) {}
  };
}

async function monConnect(node) {
  const v = MON.srv;
  const old = node.server || {};
  const server = old.mode === "local" ? { mode: "local" } : {
    mode: "ssh",
    host: $("#mon-s-host").value.trim(), port: Number($("#mon-s-port").value) || 22, username: $("#mon-s-user").value.trim(),
    auth: $("#mon-s-auth").value, privateKeyPath: $("#mon-s-key").value.trim()
  };
  const password = $("#mon-s-pass") ? $("#mon-s-pass").value : "";
  const passphrase = $("#mon-s-keypass") ? $("#mon-s-keypass").value : "";
  if (server.mode === "ssh" && (!server.host || !server.username)) { v.error = t("Address and username are required."); monRenderMain(); return; }
  if (server.mode === "ssh" && server.auth === "password" && !password) { v.error = t("Enter the password."); monRenderMain(); return; }
  if (server.mode === "ssh" && server.auth === "key" && !server.privateKeyPath) { v.error = t("Choose the private key file."); monRenderMain(); return; }
  v.busy = true; v.error = null; monRenderMain();
  try {
    const r = await api("mineConnect", { server, password, passphrase });
    MON.srv = { address: node.address, busy: false, error: null, info: r.info, cwd: r.cwd, lines: [], history: v.history, idx: v.history.length };
    node.server = server;
    await monSave();
  } catch (e) { v.busy = false; v.error = t("Couldn't connect: {why}", { why: e.message }); }
  monRenderMain();
  const input = $("#mon-term-in");
  if (input) input.focus();
}

/** Run one command and add what it said to the panel, without redrawing the page. */
async function monRun(cmd) {
  const v = MON.srv;
  if (v.busy) return;
  v.history.push(cmd); v.idx = v.history.length;
  const add = (text, kind) => {
    v.lines.push({ text, err: kind === "err", cmd: kind === "cmd" });
    if (v.lines.length > 1500) v.lines.splice(0, v.lines.length - 1500);
    const out = $("#mon-term-out");
    if (out) { const s = document.createElement("span"); if (kind) s.className = kind; s.textContent = text; out.appendChild(s); out.scrollTop = out.scrollHeight; }
  };
  add(`${v.cwd || "~"} $ ${cmd}\n`, "cmd");
  v.busy = true;
  const input = $("#mon-term-in");
  if (input) input.disabled = true;
  try {
    const r = await api("mineRun", { command: cmd });
    if (r.output) add(r.output.endsWith("\n") ? r.output : r.output + "\n");
    if (r.code) add(`(exit code ${r.code})\n`, "err");
    if (r.cwd) v.cwd = r.cwd;
  } catch (e) { add(e.message + "\n", "err"); }
  v.busy = false;
  const again = $("#mon-term-in");
  if (again) { again.disabled = false; again.focus(); }
  const p = document.querySelector(".mon-term-prompt");
  if (p) p.textContent = (v.cwd || "~") + " $";
}

/* ---- shutting down, Gonka's way ---------------------------------------- */

async function monLoadShutdown(node) {
  const asked = node.address;
  MON.down = { ...(MON.down && MON.down.address === asked ? MON.down : {}), address: asked, busy: true, error: null };
  try {
    const data = await api("mineShutdownStatus", { address: asked });
    if (MON.down && MON.down.address === asked) { MON.down.data = data; MON.down.busy = false; }
  } catch (e) {
    if (MON.down && MON.down.address === asked) { MON.down.error = e.message; MON.down.busy = false; }
  }
  if (MON.view === "node" && MON.address === asked && MON.panel === "shutdown") monRenderMain();
}

function monShutdownHtml(node) {
  const d = MON.down && MON.down.address === node.address ? MON.down : null;
  const linked = MON.srv.address === node.address;
  const guide = `<a href="#" data-open="https://gonka.ai/host/quickstart/#how-to-stop-your-node">${esc(t("Gonka's guide"))}</a>`;
  const head = `<div class="mon-card-head"><h3>${esc(t("Shut down safely"))}</h3>
    <button class="mon-quiet" id="mon-down-refresh">${esc(t("Check again"))}</button></div>
    <p class="small mon-panel-lede">${t("Four steps, as in {guide}. Leaving early can lose the last epoch's reward.", { guide })}</p>`;
  if (!d || (!d.data && d.busy)) return `<div class="card mon-panel">${head}<div class="info-banner">${esc(t("Reading where your node stands…"))}</div></div>`;
  if (!d.data) return `<div class="card mon-panel">${head}<div class="warn-banner">${esc(t("Couldn't read the network: {why}", { why: d.error }))}</div></div>`;
  const s = d.data;
  const step = (state, title, text, extra = "") => `
    <div class="mon-step ${state}"><i aria-hidden="true">${state === "done" ? "✓" : ""}</i>
      <div><b>${esc(title)}</b><p>${text}</p>${extra}</div></div>`;
  const needServer = linked ? "" : `<button class="mon-quiet" data-act-panel="server">${esc(t("Connect to your server"))}</button>`;

  // 1. Stop joining new epochs.
  let one;
  if (!d.off && (!linked || !s.machines)) {
    one = step("now", t("Stop joining new epochs"), esc(linked ? t("The node's admin API on the server did not answer. Is the node running?") : t("Connect to your server first: this step runs there.")), needServer);
  } else if (s.stopped || d.off) {
    one = step("done", t("Stop joining new epochs"), esc(t("Its GPUs will not take part in the next Proof of Compute.")),
      s.inEpoch ? `<button class="mon-quiet" id="mon-down-undo" ${d.doing ? "disabled" : ""}>${esc(t("Changed your mind? Switch them back on"))}</button>` : "");
  } else {
    const n = s.machines.length;
    one = step("now", t("Stop joining new epochs"),
      esc(t("The node keeps working until this epoch ends, then stays out of the next one. Until the next Proof of Compute this can be undone.")) +
      `<br><span class="small">${esc(t(n === 1 ? "1 machine: {list}" : "{n} machines: {list}", { n, list: s.machines.map((m) => `${m.id}${m.enabled ? "" : " (" + t("off") + ")"}`).join(", ") }))}</span>`,
      `<button class="primary" id="mon-down-stop" ${d.doing ? "disabled" : ""}>${esc(d.doing === "stop" ? t("Stopping…") : t("Stop joining new epochs"))}</button>`);
  }
  // 2. Finish this epoch.
  const two = s.inEpoch
    ? step(s.stopped ? "wait" : "later", t("Let it finish this epoch"), esc(t("It is still working in epoch {n}. Leave it running: it is paid for this epoch at about {when}, {span} from now.", { n: s.finish.epoch, when: monAt(s.finish.seconds), span: monSpan(s.finish.seconds) })))
    : step("done", t("Let it finish this epoch"), esc(t("The network no longer counts it in the current epoch.")));
  // 3. Collect the last reward.
  let three;
  const r = s.reward;
  if (!r) three = step("later", t("Collect its last reward"), esc(t("After this epoch, the node claims its reward by itself. Keep it running until then.")));
  else if (r.state === "none") three = step("done", t("Collect its last reward"), esc(t("Nothing is left to collect.")));
  else if (r.state === "claimed") three = step("done", t("Collect its last reward"), esc(t("Epoch {n}'s reward, {amount}, was claimed.", { n: r.epoch, amount: monGnk(r.amount) })));
  else if (r.state === "waiting") three = step("wait", t("Collect its last reward"), esc(t("Epoch {n}'s reward, {amount}, is claimed at about {when}, {span} from now. Keep the node running until then.", { n: r.epoch, amount: monGnk(r.amount), when: monAt(r.seconds), span: monSpan(r.seconds) })));
  else three = step("now", t("Collect its last reward"), esc(t("Epoch {n}'s reward, {amount}, has not been claimed. Claim it by hand, the way Gonka's guide does.", { n: r.epoch, amount: monGnk(r.amount) })),
    linked ? `<button class="primary" id="mon-down-claim" ${d.doing ? "disabled" : ""}>${esc(d.doing === "claim" ? t("Claiming…") : t("Claim it now"))}</button>` : needServer);
  // 4. Switch it off.
  let four;
  if (d.off) four = step("done", t("Switch it off"), esc(t("Every container on the server is stopped. The node is off.")));
  else if (!s.ready) four = step("later", t("Switch it off"), esc(t("Once the steps above are done.")));
  else if (!linked) four = step("now", t("Switch it off"), esc(t("Connect to your server first: this step runs there.")), needServer);
  else if (!d.confirm) four = step("now", t("Switch it off"), esc(t("Stops every container on the server.")), `<button class="primary" id="mon-down-off">${esc(t("Switch off the node"))}</button>`);
  else four = step("now", t("Switch it off"), esc(t("This stops the node for good: it earns nothing more until it is started and registered for an epoch again. Your wallet, its GNK and the server's files stay as they are.")),
    `<div class="btn-row"><button class="danger" id="mon-down-off-yes" ${d.doing ? "disabled" : ""}>${esc(d.doing === "off" ? t("Switching off…") : t("Yes, switch it off"))}</button><button id="mon-down-off-no">${esc(t("Cancel"))}</button></div>`);

  return `<div class="card mon-panel">${head}
    ${d.error ? `<div class="warn-banner">${esc(d.error)}</div>` : ""}
    <div class="mon-steps">${one}${two}${three}${four}</div>
    ${d.said ? `<pre class="mon-term-out mono small-out">${esc(d.said)}</pre>` : ""}
  </div>`;
}

function monWireShutdown(node) {
  const d = MON.down;
  const act = async (kind, call, args) => {
    d.doing = kind; d.error = null; monRenderMain();
    try {
      const r = await api(call, args);
      if (kind === "off") { d.off = true; d.said = r.output || ""; }
      else if (kind === "claim") d.said = r.message || "";
      else d.said = (r.results || []).filter((x) => !x.ok).map((x) => `${x.id}: ${x.said}`).join("\n");
    } catch (e) { d.error = e.message; }
    d.doing = null; d.confirm = false;
    await monLoadShutdown(node);
  };
  if ($("#mon-down-refresh")) $("#mon-down-refresh").onclick = () => monLoadShutdown(node).then(() => monRenderMain());
  document.querySelectorAll("[data-act-panel]").forEach((b) => { b.onclick = () => { MON.panel = b.dataset.actPanel; monRenderMain(); }; });
  if (!d) return;
  if ($("#mon-down-stop")) $("#mon-down-stop").onclick = () => act("stop", "mineSetMachines", { enabled: false });
  if ($("#mon-down-undo")) $("#mon-down-undo").onclick = () => act("undo", "mineSetMachines", { enabled: true });
  if ($("#mon-down-claim")) $("#mon-down-claim").onclick = () => act("claim", "mineClaimReward");
  if ($("#mon-down-off")) $("#mon-down-off").onclick = () => { d.confirm = true; monRenderMain(); };
  if ($("#mon-down-off-no")) $("#mon-down-off-no").onclick = () => { d.confirm = false; monRenderMain(); };
  if ($("#mon-down-off-yes")) $("#mon-down-off-yes").onclick = () => act("off", "mineSwitchOff");
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
    if (keep) { node.name = input.value.trim(); await monSave(); }
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
  const max = Math.max(0, ...lines.map((l) => (l.took ? l.reward : 0)));
  const tot = d.totals;
  if (tot.unknown === tot.of) {
    return `<div class="card"><h3>${esc(t("Rewards, epoch by epoch"))}</h3><p class="small">${esc(t("The record of past epochs could not be downloaded just now. Try Refresh in a moment."))}</p></div>`;
  }
  const plot = monPlot("rewards", { label: t("Rewards, epoch by epoch"), kind: lines.length > 48 ? "line" : "bars", unit: "GNK", fmt: (v) => monShortNum(v),
    points: lines.map((l) => ({
      y: l.took ? l.reward / MON_NGONKA : null,
      gap: l.unknown ? "unknown" : l.took ? null : "none",
      x: monDay(l.at) || String(l.epoch),
      tip: [l.unknown ? t("Not collected yet") : l.took ? [monGnk(l.reward), monUsd(l.reward)].filter(Boolean).join(" · ") : t("Did not take part"), monEpochWhen(l)]
    })) });
  return `
    <div class="card">
      <h3>${esc(t("Rewards, epoch by epoch"))}</h3>
      ${plot}
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
    // Slice n arrives about n-1 epochs after the next Proof of Compute.
    const when = (i) => new Date(Date.now() + (d.epoch.secondsToNextPoc + i * d.epoch.hours * 3600) * 1000).toISOString();
    chart = monPlot("vesting", { label: t("Still to arrive"), kind: stream.length > 48 ? "line" : "bars", unit: "GNK", height: 150, fmt: (x) => monShortNum(x),
      points: stream.map((a, i) => ({ y: a / MON_NGONKA, x: monDay(when(i)),
        tip: [monGnk(a), t(i === 0 ? "In 1 epoch, about {when}" : "In {n} epochs, about {when}", { n: i + 1, when: monWhenFull(when(i)) })] })) });
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

/* ---- votes and the shared money -------------------------------------------- */

/** USDT in its smallest unit, as "1.3M USDT" (short) or "1,295,000 USDT". */
function monUsdt(units, short = true) {
  const dec = (MON.gov && MON.gov.money && MON.gov.money.usdt && MON.gov.money.usdt.decimals) || 6;
  const v = Number(units) / 10 ** dec;
  return (short ? monShortNum(v) : monNum(v, v < 100 ? 2 : 0)) + " USDT";
}

/** What a proposal pays and from where, in plain lines; "would pay" until it has passed. */
function monPays(p) {
  const x = p.pays || {};
  const did = p.status === "PASSED";
  const lines = [];
  if (x.toSale) lines.push(t(did ? "Moves {amount} from the community pool into the community sale" : "Would move {amount} from the community pool into the community sale", { amount: monGnk(x.toSale) }));
  if (x.pool) lines.push(t(did ? "Pays {amount} from the community pool" : "Would pay {amount} from the community pool", { amount: monGnk(x.pool) }));
  if (x.gov) lines.push(t(did ? "Pays {amount} from the governance account, unlocking over time" : "Would pay {amount} from the governance account, unlocking over time", { amount: monGnk(x.gov) }));
  if (x.usdt) lines.push(t(did ? "Pays {amount} from the community sale" : "Would pay {amount} from the community sale", { amount: monUsdt(x.usdt, false) }));
  return lines;
}

/** Where the network's shared money is: four figures, and how it works. */
function monMoneyHtml() {
  const m = MON.gov && MON.gov.money;
  if (!m) return "";
  const sale = (m.sale || [])[0] || null;
  const paidGnk = (m.paid.fromPool || 0) + (m.paid.fromGov || 0);
  const into = (m.payouts || []).find((r) => r.toSale);
  return `
    <h2 class="mon-h2">${esc(t("The network's shared money"))}</h2>
    <div class="mon-tiles">
      ${monTile(t("Community pool"), monGnkShort(m.pool.ngonka), monUsd(m.pool.ngonka))}
      ${sale ? monTile(t("Community sale"), monGnkShort(sale.ngonka), t("left to sell · {usdt} in hand", { usdt: monUsdt(sale.usdt) })) : ""}
      ${monTile(t("Governance account"), monGnkShort(m.govAccount.ngonka), monUsd(m.govAccount.ngonka))}
      ${monTile(t("Paid out by proposals"), monUsdt(m.paid.usdt), t("and {gnk}", { gnk: monGnkShort(paidGnk) }))}
    </div>
    ${more("How does this money work?", `
      <p>${esc(t("Only a passed proposal can spend from the community pool, the governance account or the community sale."))}</p>
      ${into ? `<p>${esc(t("Proposal #{id} ({date}) moved {amount} from the community pool into the community sale, a contract that sells it for USDT. Grants and bounties are paid in that USDT.", { id: into.id, date: monDate(into.ended), amount: monGnk(into.toSale) }))}</p>` : ""}
      <p>${esc(t("The governance account pays compensation and restitution, in coins that unlock over time."))}</p>`)}`;
}

/**
 * What a proposal asks for, in plain figures on the right of its card: GNK
 * with its value at today's price, and USDT. "Paid" once it has passed.
 */
function monAskHtml(p) {
  const x = p.pays || {};
  const gnk = (x.pool || 0) + (x.gov || 0) + (x.toSale || 0);
  const usdt = x.usdt || 0;
  if (!gnk && !usdt) return "";
  const dec = (MON.gov && MON.gov.money && MON.gov.money.usdt && MON.gov.money.usdt.decimals) || 6;
  const label = p.status === "PASSED" ? t("Paid") : p.status === "VOTING_PERIOD" ? t("Asks for") : t("Asked for");
  return `
    <div class="mon-ask${p.status === "PASSED" ? " paid" : ""}">
      <span class="mon-ask-label">${esc(label)}</span>
      ${gnk ? `<b>${esc(monGnk(gnk))}</b>${MON.price ? `<span title="${esc(t("at today's price"))}">≈ $${esc(monNum(gnk / MON_NGONKA * MON.price))}</span>` : ""}` : ""}
      ${usdt ? `<b>${esc(monNum(usdt / Math.pow(10, dec)))} USDT</b>` : ""}
    </div>`;
}

/**
 * The top of the Votes page: which of your nodes votes, and whether it is
 * ready, or what it takes to vote from here.
 */
function monYourVoteHtml(live) {
  const own = MON.nodes.filter(monOwn);
  const o = MON.overview;
  if (own.length) {
    const weight = (n) => { const h = o && o.hosts.find((x) => x.address === n.address); return h ? t("{share} of the network's weight", { share: monPct(h.share, 2) }) : ""; };
    const weights = own.map((n) => ({ n, w: weight(n) })).filter((x) => x.w);
    return `
      <div class="mon-yourvote ready">
        <span class="mon-yv-icon">${MON_ICONS.votes}</span>
        <div class="mon-yv-body">
          <b>${esc(t("You vote with {names}", { names: own.map(monName).join(", ") }))}</b>
          <span>${esc(live ? t("Choose Yes, No, No with veto or Abstain on the proposal below. Your node's vote counts by its weight.")
            : t("Ready. When a proposal opens, it appears here with Yes, No, No with veto and Abstain."))}</span>
          ${weights.length ? `<span class="mon-yv-weight">${esc(weights.map((x) => (own.length > 1 ? monName(x.n) + ": " : "") + x.w).join(" · "))}</span>` : ""}
        </div>
        <span class="mon-yv-state"><i></i>${esc(live ? t("Vote open") : t("Ready"))}</span>
      </div>`;
  }
  const kept = MON.nodes.length > 0;
  return `
    <div class="mon-yourvote">
      <span class="mon-yv-icon">${MON_ICONS.votes}</span>
      <div class="mon-yv-body">
        <b>${esc(kept ? t("Link your node to vote from here") : t("Add your node to vote with it"))}</b>
        <span>${esc(kept ? t("A host votes with its node, and the vote counts by the node's weight. Link its wallet once, and its votes are cast from here.")
          : t("A host votes with its node, and the vote counts by the node's weight. Add yours, and its votes are cast from here."))}</span>
      </div>
      ${kept ? `<button class="primary" id="mon-vote-link">${esc(t("Link your wallet"))}</button>` : `<button class="primary" data-go="add">${esc(t("Add your node"))}</button>`}
    </div>`;
}

function monVotesHtml() {
  const g = MON.gov;
  const head = `<div class="mon-title-row"><h1>${esc(t("Votes"))}</h1>
    <span class="mon-title-sub">${esc(t("What the network is deciding, and what each proposal asks for."))}</span></div>`;
  if (!g) return head + `<div class="info-banner">${esc(t("Reading the proposals…"))}</div>`;
  if (g.error) return head + `<div class="warn-banner">${esc(t("Couldn't read the proposals: {why}", { why: g.error }))}</div>`;
  const live = g.proposals.filter((p) => p.status === "VOTING_PERIOD");
  const past = g.proposals.filter((p) => p.status !== "VOTING_PERIOD");
  const voteWord = { YES: t("Yes"), NO: t("No"), ABSTAIN: t("Abstain"), NO_WITH_VETO: t("No, with veto") };
  const outcome = { PASSED: t("Passed"), REJECTED: t("Rejected"), FAILED: t("Failed"), DEPOSIT_PERIOD: t("Waiting for its deposit") };
  const links = (text) => { const m = String(text).match(/https?:\/\/[^\s)]+/g) || []; return [...new Set(m)].slice(0, 3); };

  // A proposal folds to what it is, what it asks for and how the vote went;
  // click anywhere on it to see the votes by weight, what it pays, and its text.
  const card = (p, isLive) => {
    const cast = p.tally.voted;
    const pc = (n) => (cast > 0 ? n / cast : 0);
    const seg = (n) => (pc(n) * 100).toFixed(2);
    const turnout = p.turnout === null ? null : Math.min(1, p.turnout);
    // Your own nodes vote right here; the others kept here only show their vote.
    const mine = (MON.votes[p.id] || []).filter((v) => !monOwn(MON.nodes.find((n) => n.address === v.address)));
    const open = isLive || MON.open.has(p.id);
    const why = !isLive && p.status === "REJECTED" && p.yesShare > p.threshold && turnout !== null && turnout < p.quorum
      ? t("Most votes were yes, but too few voted for it to count.") : "";
    const pays = monPays(p);
    const weightRow = (cls, label, n) => `
      <div class="mon-w-row"><span><i class="${cls}"></i>${esc(label)}</span><b>${esc(monNum(n))}</b><span>${esc(cast > 0 ? monPct(pc(n)) : "—")}</span></div>`;
    return `
      <div class="card mon-prop${open ? " open" : ""}${isLive ? " live" : ""}" data-prop="${p.id}" ${isLive ? "" : `role="button" tabindex="0" aria-expanded="${open}"`}>
        <div class="mon-prop-top">
          <span class="mon-prop-id">#${p.id}</span>
          ${isLive ? `<span class="pill ok">${esc(t("VOTING NOW"))}</span>` : `<span class="pill ${p.status === "PASSED" ? "ok" : "err"}">${esc(outcome[p.status] || p.status)}</span>`}
          <span class="small">${isLive ? esc(t("ends {date}", { date: monDate(p.ends) })) : esc(monDate(p.ends))}</span>
        </div>
        <div class="mon-prop-main">
          <div class="mon-prop-what">
            <h3>${esc(p.title)}</h3>
            <div class="mon-prop-does">${esc(monDoes(p))}</div>
          </div>
          ${monAskHtml(p)}
          ${isLive ? "" : `<span class="mon-prop-chev" aria-hidden="true">›</span>`}
        </div>
        ${cast > 0 ? `
          <div class="mon-tally" title="${esc(t("Yes {y} · No {n} · Veto {v} · Abstain {a}", { y: monPct(pc(p.tally.yes)), n: monPct(pc(p.tally.no)), v: monPct(pc(p.tally.veto)), a: monPct(pc(p.tally.abstain)) }))}">
            <i class="yes" style="width:${seg(p.tally.yes)}%"></i><i class="no" style="width:${seg(p.tally.no)}%"></i><i class="veto" style="width:${seg(p.tally.veto)}%"></i><i class="abs" style="width:${seg(p.tally.abstain)}%"></i>
          </div>` : `<p class="small">${esc(t("Nobody has voted yet."))}</p>`}
        <div class="mon-prop-more">
          ${cast > 0 ? `
            <div class="mon-w-table">
              <div class="mon-w-row mon-w-head"><span>${esc(t("Vote"))}</span><b>${esc(t("Weight"))}</b><span>${esc(t("Share of the votes"))}</span></div>
              ${weightRow("yes", t("Yes"), p.tally.yes)}
              ${weightRow("no", t("No"), p.tally.no)}
              ${weightRow("veto", t("No, with veto"), p.tally.veto)}
              ${weightRow("abs", t("Abstain"), p.tally.abstain)}
              <div class="mon-w-row mon-w-total"><span>${esc(t("Total"))}</span><b>${esc(monNum(cast))}</b><span></span></div>
            </div>` : ""}
          ${isLive && turnout !== null ? `
            <div class="mon-turnout"><div class="mon-turnout-bar"><i style="width:${(turnout * 100).toFixed(1)}%"></i><b style="left:${(p.quorum * 100).toFixed(1)}%"></b></div>
            <span class="small">${esc(t("{voted} of the network's weight has voted. It needs {needs} to count.", { voted: monPct(turnout, 0), needs: monPct(p.quorum, 0) }))}</span></div>` : ""}
          ${isLive ? monBallotHtml(p) : ""}
          ${why ? `<p class="small">${esc(why)}</p>` : ""}
          ${pays.length ? `<div class="mon-prop-pays">${pays.map((l) => `<div>${esc(l)}</div>`).join("")}${p.pays.recipients ? `<div class="small">${esc(t("recipients: {n}", { n: p.pays.recipients }))}</div>` : ""}</div>` : ""}
          ${p.upgradeTo && p.upgradeTo.height ? `<p class="small">${esc(t("At block {h}.", { h: monNum(p.upgradeTo.height) }))}</p>` : ""}
          ${p.summary ? `<div class="mon-prop-text"><p>${esc(p.summary)}</p>
            ${links(p.summary).map((u) => `<a href="#" data-open="${esc(u)}">${esc(u.length > 70 ? u.slice(0, 70) + "…" : u)}</a>`).join("<br>")}</div>` : ""}
          ${isLive && mine.length ? `<div class="mon-myvote">${mine.map((v) => `${esc(v.name)}: <b>${v.vote ? esc(voteWord[v.vote] || v.vote) : esc(t("has not voted"))}</b>`).join(" · ")}</div>` : ""}
        </div>
      </div>`;
  };

  // Which past proposals: all, the ones that ask for money, passed, rejected; and the search.
  const asks = (p) => { const x = p.pays || {}; return !!(x.pool || x.gov || x.toSale || x.usdt); };
  const kinds = [["all", t("All"), past], ["money", t("Ask for money"), past.filter(asks)],
    ["passed", t("Passed"), past.filter((p) => p.status === "PASSED")], ["rejected", t("Rejected"), past.filter((p) => p.status !== "PASSED")]];
  const kind = kinds.find((k) => k[0] === MON.propKind) || kinds[0];
  const raw = MON.propFilter.trim().toLowerCase();
  const q = raw.replace(/^#/, "");
  // "#12" or "12" finds proposal 12; anything else, the words in its title and text.
  const byId = /^#?\d+$/.test(raw) ? past.filter((p) => String(p.id) === q) : [];
  const shown = !q ? kind[2] : byId.length || raw.startsWith("#") ? byId : kind[2].filter((p) => `${p.title} ${p.summary || ""}`.toLowerCase().includes(q));

  return head + `
    ${monYourVoteHtml(live.length > 0)}
    ${live.length ? `<h2 class="mon-h2">${esc(t("Voting now"))}</h2>${live.map((p) => card(p, true)).join("")}`
      : `<div class="mon-none-open">${esc(t("Nothing is being voted on right now."))}</div>`}
    ${more("How does voting work?", `<p>${esc(t("A host votes with its node; a proposal passes when at least {quorum} of the network's weight votes and more than {threshold} of those votes are yes.", { quorum: monPct(g.rules.quorum, 0), threshold: monPct(g.rules.threshold, 0) }))}</p>`)}
    <h2 class="mon-h2">${esc(t("Every proposal ({n})", { n: monNum(g.proposals.length) }))}</h2>
    <div class="mon-prop-tools">
      <div class="mon-chips" role="tablist">${kinds.map(([id, label, list]) => `<button class="mon-chip${kind[0] === id ? " on" : ""}" data-kind="${id}" role="tab" aria-selected="${kind[0] === id}">${esc(label)} <span>${monNum(list.length)}</span></button>`).join("")}</div>
      <input type="text" id="mon-prop-filter" class="mon-search" placeholder="${esc(t("Find a proposal by its number or words in it"))}" value="${esc(MON.propFilter)}" spellcheck="false">
    </div>
    ${shown.length ? shown.map((p) => card(p, false)).join("") : `<p class="small">${esc(t("No proposal matches."))}</p>`}
    ${monMoneyHtml()}`;
}

/* Voting with your own node: choose, unlock the wallet, let the network check
   the vote without sending it, then send. The passphrase lives in memory only
   while the vote is being cast. */
const MON_OPTIONS = ["YES", "NO", "NO_WITH_VETO", "ABSTAIN"];
const monVoteWord = (o) => ({ YES: t("Yes"), NO: t("No"), ABSTAIN: t("Abstain"), NO_WITH_VETO: t("No, with veto") })[o] || o;

function monBallotHtml(p) {
  return MON.nodes.filter(monOwn).map((n) => {
    const now = ((MON.votes[p.id] || []).find((v) => v.address === n.address) || {}).vote || null;
    const b = MON.ballot && MON.ballot.id === p.id && MON.ballot.address === n.address ? MON.ballot : null;
    const busy = b && b.stage !== "done";
    const outOfEpoch = MON.overview && !MON.overview.hosts.some((h) => h.address === n.address);
    let flow = "";
    if (b && (b.stage === "pass" || b.stage === "checking")) flow = `
      <div class="mon-ballot-flow">
        <label>${esc(t("Vote {option} with {name}. Wallet passphrase:", { option: monVoteWord(b.option), name: monName(n) }))}
          <input type="password" id="mon-b-pass" autocomplete="off" ${b.stage === "checking" ? "disabled" : ""}></label>
        <button class="primary" id="mon-b-check" ${b.stage === "checking" ? "disabled" : ""}>${esc(b.stage === "checking" ? t("Checking…") : t("Continue"))}</button>
        <button id="mon-b-cancel">${esc(t("Cancel"))}</button>
      </div>`;
    else if (b && (b.stage === "confirm" || b.stage === "sending")) flow = `
      <div class="mon-ballot-flow">
        <span>${esc(t("The network accepts this vote. The fee is about {fee}.", { fee: monGnk(b.fee) }))}</span>
        <button class="primary" id="mon-b-send" ${b.stage === "sending" ? "disabled" : ""}>${esc(b.stage === "sending" ? t("Sending…") : t("Send the vote: {option}", { option: monVoteWord(b.option) }))}</button>
        <button id="mon-b-cancel" ${b.stage === "sending" ? "disabled" : ""}>${esc(t("Cancel"))}</button>
      </div>`;
    else if (b && b.stage === "done") flow = `<div class="mon-ballot-flow ok">${esc(t("Voted {option}. You can change the vote until it ends; the last one counts.", { option: monVoteWord(b.option) }))}</div>`;
    if (b && b.error) flow += `<p class="small mon-err">${esc(b.error)}</p>`;
    return `
      <div class="mon-ballot" data-ballot="${esc(n.address)}">
        <div class="mon-ballot-head"><b>${esc(t("Vote with {name}", { name: monName(n) }))}</b>
          <span class="small">${now ? esc(t("Its vote now: {vote}", { vote: monVoteWord(now) })) : esc(t("It has not voted."))}</span></div>
        <div class="mon-ballot-opts">${MON_OPTIONS.map((o) => `<button data-option="${o}" class="${b && b.option === o ? "on" : now === o ? "cast" : ""}" ${busy ? "disabled" : ""}>${esc(monVoteWord(o))}</button>`).join("")}</div>
        ${outOfEpoch ? `<p class="small">${esc(t("This node is not in the current epoch. Its vote only counts if it is in the epoch when the vote ends."))}</p>` : ""}
        ${flow}
      </div>`;
  }).join("");
}

function monWireBallots(main) {
  main.querySelectorAll("[data-ballot]").forEach((box) => {
    const id = Number(box.closest("[data-prop]").dataset.prop);
    box.querySelectorAll("[data-option]").forEach((btn) => {
      btn.onclick = () => {
        MON.ballot = { id, address: box.dataset.ballot, option: btn.dataset.option, stage: "pass" };
        monRenderMain();
        const p = $("#mon-b-pass");
        if (p) p.focus();
      };
    });
  });
  const b = MON.ballot;
  const node = b && MON.nodes.find((n) => n.address === b.address);
  if (!b || !node) return;
  const ask = (dryRun) => api("mineVote", { keyName: node.wallet, passphrase: b.pass, address: b.address, proposalId: b.id, option: b.option, dryRun });
  if ($("#mon-b-cancel")) $("#mon-b-cancel").onclick = () => { MON.ballot = null; monRenderMain(); };
  const check = async () => {
    const pass = $("#mon-b-pass").value;
    if (!pass) return;
    b.pass = pass; b.stage = "checking"; b.error = null; monRenderMain();
    try { b.fee = (await ask(true)).fee; b.stage = "confirm"; }
    catch (e) { b.stage = "pass"; b.pass = null; b.error = e.message; }
    if (MON.ballot === b) monRenderMain();
  };
  if ($("#mon-b-check")) { $("#mon-b-check").onclick = check; $("#mon-b-pass").onkeydown = (e) => { if (e.key === "Enter") check(); }; }
  if ($("#mon-b-send")) $("#mon-b-send").onclick = async () => {
    b.stage = "sending"; b.error = null; monRenderMain();
    try {
      b.txhash = (await ask(false)).txhash;
      b.stage = "done"; b.pass = null;
      const list = MON.votes[b.id] || (MON.votes[b.id] = []);
      const had = list.find((v) => v.address === b.address);
      if (had) had.vote = b.option; else list.push({ address: b.address, name: monName(node), vote: b.option });
      // Then read the tally again, once the message has been seen.
      setTimeout(() => { if (MON.ballot === b) { MON.ballot = null; monLoadProposals(); } }, 20000);
    } catch (e) { b.stage = "confirm"; b.error = e.message; }
    if (MON.ballot === b) monRenderMain();
  };
}

/** A click anywhere on a past proposal folds it open or shut; links inside still work. */
function monWireVotes(main) {
  main.querySelectorAll(".mon-prop[data-prop]:not(.live)").forEach((el) => {
    const toggle = () => {
      const id = Number(el.dataset.prop);
      if (MON.open.has(id)) MON.open.delete(id); else MON.open.add(id);
      el.classList.toggle("open", MON.open.has(id));
      el.setAttribute("aria-expanded", MON.open.has(id) ? "true" : "false");
    };
    el.onclick = (e) => { if (e.target.closest("a, button, input, select")) return; if (window.getSelection && String(window.getSelection()).length) return; toggle(); };
    el.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); toggle(); } };
  });
  main.querySelectorAll("[data-kind]").forEach((b) => { b.onclick = () => { MON.propKind = b.dataset.kind; monRenderMain(); }; });
  // One node to link: straight to its form. Several: the list, to pick which.
  const vl = $("#mon-vote-link");
  if (vl) vl.onclick = () => {
    const left = MON.nodes.filter((n) => !monOwn(n));
    if (left.length !== 1) { monGo("mine"); return; }
    monGo("node", left[0].address, "mine");
    MON.link = { address: left[0].address, open: true };
    monRenderMain();
    monFocusLink();
  };
  const f = $("#mon-prop-filter");
  if (f) f.oninput = () => { MON.propFilter = f.value; const pos = f.selectionStart; monRenderMain(); const g = $("#mon-prop-filter"); if (g) { g.focus(); g.setSelectionRange(pos, pos); } };
}
