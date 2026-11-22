/* watch.js — your own nodes, watched (2026-11-21).

   Every 15 minutes while GNOT runs (also hidden near the clock, when you chose
   that on closing it), each of your nodes is read the way its page in
   Monitor/Vote reads it, and its chosen hosts are looked at. Anything worth a
   look goes into the bell at the top right of every screen; the serious ones
   also as a desktop notice, once per thing per epoch. Same rules and the same
   words as the node's page: monitor.attention (src/services/monitor.js), and
   monDelegateIssues / monAttentionText (renderer/monitor.js).

   "Your nodes" are the nodes in My nodes whose wallet is on this computer.
   Nothing is sent anywhere: the reads are the same public network reads the
   Monitor makes, and what was noticed is kept in this computer's storage. */

const WATCH = { items: [], own: 0, at: 0, busy: false, open: false };
const WATCH_EVERY = 15 * 60 * 1000;
const WATCH_SEEN = "gnot.attentionNotices";

const BELL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`;

async function watchNow() {
  if (WATCH.busy) return;
  WATCH.busy = true;
  try {
    // The Monitor's own lists when it has them; else read the same way it does.
    const nodes = typeof MON !== "undefined" && MON.nodes && MON.nodes.length ? MON.nodes : await api("monitorNodes").catch(() => []);
    const keys = typeof MON !== "undefined" && MON.keyNames && MON.keyNames.length ? MON.keyNames : await api("keyNames").catch(() => []);
    const own = nodes.filter((n) => n && n.wallet && keys.includes(n.wallet));
    WATCH.own = own.length;
    const items = [];
    if (own.length) {
      // Each node, as its page reads it (a short history is enough here).
      for (const n of own) {
        let d = null;
        try { d = await api("monitorOverview", { address: n.address, epochs: 7 }); } catch (_) { continue; }
        for (const a of (d && d.attention) || []) {
          if (a.level === "note") continue;     // the page lists those; the bell keeps to what costs money
          items.push({ key: `${n.address}|${a.code}|${d.epoch.index}`, address: n.address, name: monName(n), level: a.level, text: monAttentionText(a), store: WATCH_SEEN });
        }
      }
      // Their chosen hosts: one that left counts as no choice (15% instead of 5%).
      try {
        if (!MON.choicesData || Date.now() - MON.choicesData.readAt > WATCH_EVERY) {
          const cd = await api("modelChoices");
          cd.readAt = Date.now();
          MON.choicesData = cd;
        }
        for (const n of own) for (const i of monDelegateIssues(n.address)) {
          items.push({ key: `${n.address}|${i.model}|${i.to}|${i.kind}|${MON.choicesData.epoch}`, address: n.address, name: monName(n),
            level: i.kind === "gone" ? "bad" : "warn", text: monDelegateText(i), delegate: true, store: "gnot.delegateNotices" });
        }
      } catch (_) { /* the node's own reads above still count */ }
    }
    // A GNOT release waiting: said here too, since a hidden GNOT shows no note.
    if (S.update && S.update.state === "required" && S.update.latest) {
      items.push({ key: `update|${S.update.latest}`, level: "warn", update: true, name: "GNOT",
        text: t("Version {v} of GNOT is out. Close GNOT and open it again to update.", { v: S.update.latest }), store: WATCH_SEEN });
    }
    WATCH.items = items;
    WATCH.at = Date.now();
    watchNotify(items);
  } finally {
    WATCH.busy = false;
    paintBell();
    if (window.gonka.watchState) window.gonka.watchState(watchSummary());
  }
}

/** A desktop notice for each serious thing not said before (kept 30 days, by its key). */
function watchNotify(items) {
  const stores = {};
  const seenIn = (name) => { if (!stores[name]) { try { stores[name] = JSON.parse(localStorage.getItem(name) || "{}"); } catch (_) { stores[name] = {}; } } return stores[name]; };
  const changed = new Set();
  for (const it of items) {
    if (it.level !== "bad" && !it.delegate && !it.update) continue;
    const seen = seenIn(it.store);
    if (seen[it.key]) continue;
    seen[it.key] = Date.now();
    changed.add(it.store);
    try {
      const title = it.update ? t("GNOT has an update") : t("{name} needs a look", { name: it.name });
      const note = new Notification(title, { body: it.text });
      note.onclick = () => watchOpen(it);
    } catch (_) { /* no desktop notices here: the bell still says it */ }
  }
  const cut = Date.now() - 30 * 24 * 3600 * 1000;
  for (const name of changed) {
    const seen = stores[name];
    for (const k of Object.keys(seen)) if (seen[k] < cut) delete seen[k];
    try { localStorage.setItem(name, JSON.stringify(seen)); } catch (_) { /* said again next time */ }
  }
}

/** Open what a notice is about: the window, then the node's page. */
async function watchOpen(it) {
  if (window.gonka.showWindow) window.gonka.showWindow();
  WATCH.open = false;
  paintBell();
  if (it.update || !it.address) return;
  await showMonitor(it.address);
}

/** What the tray icon near the clock says (main.js), in this window's language. */
function watchSummary() {
  const n = WATCH.items.length;
  return {
    own: WATCH.own, count: n,
    labels: {
      tip: n === 0 ? t("GNOT: nothing needs your attention") : n === 1 ? t("GNOT: one thing is worth a look") : t("GNOT: {n} things are worth a look", { n }),
      open: t("Open GNOT"), watch: t("Watch my nodes in the background"), login: t("Start GNOT with the computer"), quit: t("Quit GNOT"),
      // The question when the window is first closed with a node of your own.
      ask: t("Keep watching your nodes?"),
      askDetail: t("GNOT can stay near the clock and tell you when one of your nodes needs a look. You can quit it from there at any time."),
      keep: t("Keep watching"), quitNow: t("Quit GNOT")
    }
  };
}

/* The bell, top right on every screen: shown once you have a node of your own. */
function paintBell() {
  let el = document.getElementById("gnot-bell");
  if (!WATCH.own) { if (el) el.remove(); document.body.classList.remove("has-bell"); return; }
  if (!el) { el = document.createElement("div"); el.id = "gnot-bell"; document.body.appendChild(el); }
  document.body.classList.add("has-bell");
  const n = WATCH.items.length;
  const tone = n === 0 ? "" : WATCH.items.some((x) => x.level === "bad") ? " bad" : " warn";
  const when = WATCH.at ? new Date(WATCH.at).toLocaleTimeString(window.I18N.lang(), { hour: "numeric", minute: "2-digit" }) : "";
  el.innerHTML = `
    <button type="button" class="bell-btn${tone}" id="bell-btn" aria-expanded="${WATCH.open}"
      title="${esc(n === 0 ? t("Nothing needs your attention") : n === 1 ? t("One thing is worth a look") : t("{n} things are worth a look", { n }))}">
      ${BELL_ICON}${n ? `<span class="bell-n">${n}</span>` : ""}</button>
    ${WATCH.open ? `
    <div class="bell-panel" role="dialog">
      <div class="bell-head"><b>${esc(t("Your nodes"))}</b><span class="small">${when ? esc(t("checked at {time}", { time: when })) : ""}</span></div>
      ${n ? WATCH.items.map((it, i) => `
        <div class="bell-item ${it.level}">
          <b>${esc(it.name)}</b>
          <p>${esc(it.text)}</p>
          <button type="button" class="mon-quiet" data-bell="${i}">${esc(it.update ? t("Got it") : t("Open"))}</button>
        </div>`).join("")
      : `<p class="bell-none">${esc(t("Nothing needs your attention"))}</p>`}
      <p class="small bell-foot">${esc(t("GNOT looks at your nodes every 15 minutes while it runs, and tells you when something needs a look."))}</p>
    </div>` : ""}`;
  $("#bell-btn").onclick = (e) => { e.stopPropagation(); WATCH.open = !WATCH.open; paintBell(); };
  el.querySelectorAll("[data-bell]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); watchOpen(WATCH.items[Number(b.dataset.bell)]); }; });
  const panel = el.querySelector(".bell-panel");
  if (panel) panel.onclick = (e) => e.stopPropagation();
}
document.addEventListener("click", () => { if (WATCH.open) { WATCH.open = false; paintBell(); } });

/** Look soon: a node of your own was just added or linked. */
function watchSoon() { clearTimeout(watchSoon.t); watchSoon.t = setTimeout(watchNow, 4000); }

/* Start a little after the app opens (the first screen's own reads come first), then every 15 minutes. */
setTimeout(() => { watchNow(); setInterval(watchNow, WATCH_EVERY); }, 20000);
