/* Gonka Host Setup — wizard renderer.
   Vanilla JS on purpose: no build step, easy to audit, easy to edit. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (k, vars) => window.I18N.t(k, vars);

/* Theme — "grey" (default), "blue" (the original navy/amber), "light".
   Set as data-theme on <html>, which selects one of the variable blocks in
   styles.css. Applied immediately at load, before first paint, so the window
   never flashes the wrong palette. */
const THEME = {
  KEY: "gonka-theme",
  valid: ["grey", "blue", "light"],
  get() {
    try {
      const v = localStorage.getItem(THEME.KEY);
      return THEME.valid.includes(v) ? v : "grey";
    } catch (_) { return "grey"; }
  },
  set(v) {
    if (!THEME.valid.includes(v)) v = "grey";
    document.documentElement.setAttribute("data-theme", v);
    try { localStorage.setItem(THEME.KEY, v); } catch (_) {}
  }
};
THEME.set(THEME.get());

// Chain amounts come as ngonka (1 GNK = 1,000,000,000 ngonka). People think in
// GNK, so show that — enough decimals to keep small gas amounts readable.
const NGONKA_PER_GNK = 1e9;
function gnk(ngonkaAmount) {
  const n = Number(ngonkaAmount);
  if (!isFinite(n)) return "—";
  const g = n / NGONKA_PER_GNK;
  const digits = g === 0 ? 0 : g < 0.001 ? 6 : g < 1 ? 4 : 2;
  return g.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits }) + " GNK";
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const S = {
  step: 0,
  K: null,                      // knowledge from main
  platform: null,
  mode: null,                   // "local" | "ssh"
  ssh: { host: "", port: 22, username: "root", auth: "key", privateKeyPath: "", password: "", passphrase: "" },
  connected: false,
  scan: null,                   // { items, facts, ok }
  seed: null,                   // reachable seed node base URL

  // wallet (cold key, LOCAL machine only)
  wallet: { name: "gonka-account-key", passphrase: "", address: "", pubkey: "", isNew: false, confirmed: false },

  // network questionnaire
  net: { scheme: "http", host: "", domain: "", email: "", dnsProviderId: "cloudflare", dnsEnv: {}, jwtSecret: "" },

  // model / node config
  repoReady: false,
  nodeConfigFiles: [],
  chosenConfigFile: null,
  nodeConfigText: "",
  models: [],                   // model ids in chosen config
  governance: [],               // live governance model list

  configEnvText: "",
  warm: { address: "", existed: false },
  registered: false,
  granted: false,
  launched: false,
  weightsDone: false,
  consoleBusy: false
};

const STEPS = [
  { id: "welcome",   label: "Welcome" },
  { id: "mode",      label: "Your server" },
  { id: "connect",   label: "Connect" },
  { id: "scan",      label: "Health check" },
  { id: "wallet",    label: "Wallet" },
  { id: "network",   label: "Network & SSL" },
  { id: "model",     label: "Model & GPUs" },
  { id: "review",    label: "Review config" },
  { id: "weights",   label: "Model weights" },
  { id: "deploy",    label: "Launch & register" },
  // Collateral BEFORE Verify: it must be on-chain before the epoch group
  // forms (right after PoC), and Verify is where people sit and wait for that
  // round. With the old order they waited past the one step that 5×s weight.
  { id: "collateral",label: "Collateral" },
  { id: "verify",    label: "Verify" },
  { id: "done",      label: "Finished" }
];
const doneSteps = new Set();
const errorSteps = new Set();

/* ------------------------------------------------------------------ */
/* Console                                                             */
/* ------------------------------------------------------------------ */
function logLine(line, stream) {
  const out = $("#console-out");
  const span = document.createElement("span");
  if (stream === "stderr") span.className = "err";
  span.textContent = line;
  out.appendChild(span);
  if (out.childNodes.length > 4000) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}
let busyTimer = null, busyStart = 0, busyLabel = "";
function setBusy(b, title) {
  S.consoleBusy = b;
  $("#console-dot").className = "dot" + (b ? " busy" : "");
  if (title) busyLabel = title;
  const titleEl = $("#console-title");
  if (b) {
    if (!busyTimer) {
      busyStart = Date.now();
      // Live "still working" indicator with elapsed time — so long steps
      // (image pulls, model weights) visibly show the app is active, not hung.
      busyTimer = setInterval(() => {
        const s = Math.floor((Date.now() - busyStart) / 1000);
        const mm = Math.floor(s / 60), ss = s % 60;
        const clock = mm ? `${mm}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
        titleEl.innerHTML = `<span class="working">●</span> ${esc(busyLabel)} · ${clock} · ${t("working — watch the log below for details")}`;
      }, 1000);
    } else if (title) {
      busyStart = Date.now();  // new sub-step: reset the timer + label
    }
    if (!$("#console").classList.contains("open")) toggleConsole(true);
  } else {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    titleEl.textContent = t("Activity log");
  }
}
function toggleConsole(open) {
  const c = $("#console");
  const willOpen = open !== undefined ? open : !c.classList.contains("open");
  c.classList.toggle("open", willOpen);
  $("#console-toggle").textContent = willOpen ? "hide ▼" : "show ▲";
}

/* ------------------------------------------------------------------ */
/* Rail + navigation                                                   */
/* ------------------------------------------------------------------ */
function renderRail() {
  const el = $("#rail-steps");
  el.innerHTML = STEPS.map((st, i) => {
    const cls = ["rack-unit"];
    if (i === S.step) cls.push("active");
    if (doneSteps.has(i)) cls.push("done");
    if (errorSteps.has(i)) cls.push("error");
    return `<div class="${cls.join(" ")}"><span class="screws"></span><span class="led"></span><span>${esc(t(st.label))}</span></div>`;
  }).join("");
}
function go(i) {
  S.step = Math.max(0, Math.min(STEPS.length - 1, i));
  // Furthest step ever reached — never decreases. Resume returns HERE, not to
  // wherever navigation happened to land last: without this, the resume flow's
  // own walk-back to Connect overwrote the saved position and made the wizard
  // re-run every step it had already completed.
  S.furthest = Math.max(S.furthest || 0, S.step);
  renderRail();
  RENDER[STEPS[S.step].id]();
  $("#stage").scrollTop = 0;
  saveSession();
}
function markDone(i = S.step) { doneSteps.add(i); errorSteps.delete(i); renderRail(); }

/**
 * Jump to a resumed step, making sure the server facts exist first.
 * Hardware details (GPUs, disk layout, the model-cache path) come from the
 * health check and live in the main process too — skipping straight past it
 * left later steps believing the machine had no GPUs at all.
 */
async function goResumed(target) {
  if (target > 3 && S.connected && !S.scan) {
    setBusy(true, "Re-checking your server…");
    try {
      S.scan = await api("scan");
      if (S.scan.facts.publicIp && !S.net.host) S.net.host = S.scan.facts.publicIp;
      if (S.scan.ok) markDone(3);
    } catch (e) {
      logLine("\nCouldn't re-check the server: " + e.message + "\n", "stderr");
      setBusy(false);
      return go(3);   // send them to the health check rather than guess
    }
    setBusy(false);
  }
  go(target);
}
function markError(i = S.step) { errorSteps.add(i); renderRail(); }

/* ------------------------------------------------------------------ */
/* Session memory — survive closing the app mid-setup.                 */
/* Passphrases, SSH passwords and mnemonics are NEVER written to disk;  */
/* they're re-entered on resume. Everything else is just convenience.   */
/* ------------------------------------------------------------------ */
const SESSION_KEY = "gonka-session";
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 1, at: Date.now(), step: S.step,
      furthest: Math.max(S.furthest || 0, S.step),
      mode: S.mode,
      ssh: { host: S.ssh.host, port: S.ssh.port, username: S.ssh.username,
             auth: S.ssh.auth, privateKeyPath: S.ssh.privateKeyPath },
      wallet: { name: S.wallet.name, address: S.wallet.address, pubkey: S.wallet.pubkey },
      net: S.net,
      chosenConfigFile: S.chosenConfigFile, nodeConfigText: S.nodeConfigText, models: S.models,
      serverKeyName: S.serverKeyName,
      done: [...doneSteps]
    }));
  } catch (_) {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (_) { return null; }
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
/**
 * The step a saved session resumes at: the furthest point ever reached. Older
 * sessions saved only the last-rendered step (which the resume walk-back
 * itself demoted), so also reconstruct from the completed-steps list:
 * everything marked done means the user got at least one step past the
 * highest of them.
 */
function resumePoint(prev) {
  if (!prev) return 0;
  const doneMax = (prev.done || []).length ? Math.max(...prev.done) + 1 : 0;
  return Math.min(STEPS.length - 1, Math.max(prev.step || 0, prev.furthest || 0, doneMax));
}

function stage(html) { $("#stage").innerHTML = html; }

/* ------------------------------------------------------------------ */
/* Epoch bar — always-visible countdown to the next Proof of Compute,  */
/* with a fill showing how much of the current epoch has passed.       */
/* ------------------------------------------------------------------ */
let pocState = null;

async function syncEpochBar() {
  try {
    if (!S.seed) S.seed = await api("seed");
    const p = await api("nextPoc", { seed: S.seed });
    pocState = { ...p, at: Date.now() };
    $("#epochbar").style.display = "flex";
    renderEpochBar();
  } catch (_) { /* offline — keep whatever we had; bar stays hidden if never synced */ }
}

function renderEpochBar() {
  if (!pocState) return;
  const remain = Math.max(0, pocState.etaMs - (Date.now() - pocState.at));
  const totalMs = pocState.totalBlocks * pocState.secPerBlock * 1000;
  const frac = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remain / totalMs)) : 0;
  $("#epoch-fill").style.width = (frac * 100).toFixed(2) + "%";
  const hh = Math.floor(remain / 3600000);
  const mm = Math.floor((remain % 3600000) / 60000);
  const ss = Math.floor((remain % 60000) / 1000);
  // timeZoneName makes the displayed zone explicit — it's always the viewer's
  // own OS clock/timezone (never detected from the network, VPN-immune).
  const at = new Date(Date.now() + remain).toLocaleString(undefined,
    { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  $("#epoch-text").textContent =
    `⏱ ${t("Next Proof of Compute")}: ${hh}h ${String(mm).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s · ${at} · ${(frac * 100).toFixed(1)}%`;
}
function header(eyebrow, title, lede) {
  // "Step N" eyebrows get the word translated; everything else goes through
  // the dictionary directly (unknown strings fall back to English).
  const m = /^Step (\d+)$/.exec(eyebrow);
  const eb = m ? `${t("Step")} ${m[1]}` : t(eyebrow);
  return `<div class="step-eyebrow">${esc(eb)}</div><h1>${esc(t(title))}</h1><p class="lede">${t(lede)}</p>`;
}
async function api(fn, args) {
  const res = await window.gonka[fn](args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
function toast(msg) { logLine("\n" + msg + "\n"); }

/* ------------------------------------------------------------------ */
/* Step renderers                                                      */
/* ------------------------------------------------------------------ */
const RENDER = {};

/* --- 0 Welcome ------------------------------------------------------ */
RENDER.welcome = () => {
  const req = S.K.requirements;
  stage(`
    ${header("Step 1", "Become a Gonka host", `
      This wizard takes you from a bare server to a registered, earning node on the Gonka network.
      It checks your machine, fixes what's missing, creates your keys the safe way, writes the
      configuration for you, and launches everything in the right order.`)}
    <div class="card" id="right-now-card">
      <h3>${esc(t("What's supported right now"))}</h3>
      <span class="small">Checking the live network and repository…</span>
    </div>
    <div class="card">
      <h3>${esc(t("What you'll need"))}</h3>
      <ul class="plain">
        <li>${t("About 30–60 minutes of your time. Model downloads run on their own and can take longer.")}</li>
        <li>${t("A pen and paper for your wallet recovery phrase. Seriously — paper.")}</li>
      </ul>
    </div>
    <div class="card">
      <h3>${esc(t("What this app never does"))}</h3>
      <ul class="plain">
        <li>${t("Your wallet's master key is created on <b>this computer</b> and never leaves it — not even to your own server.")}</li>
        <li>${t("Your recovery phrase is shown once and never saved by this app.")}</li>
        <li>${t("Nothing gets installed on your server without showing you the exact commands first.")}</li>
      </ul>
    </div>
    <div class="btn-row">
      <button class="primary" id="b-start">Start setup</button>
    </div>`);
  $("#b-start").onclick = () => { markDone(); go(1); };

  // Offer to pick up an interrupted setup. The SSH session and any passphrase
  // can't be restored, so this restores the answers and sends them to Connect.
  const prev = loadSession();
  const resumeTarget = resumePoint(prev);
  if (prev && resumeTarget > 1 && !S.connected) {
    S.furthest = Math.max(S.furthest || 0, resumeTarget);
    const when = new Date(prev.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const label = (STEPS[resumeTarget] && t(STEPS[resumeTarget].label)) || "";
    // Pinned at the very top of the stage so it's seen without scrolling.
    const bar = document.createElement("div");
    bar.className = "card resume-bar";
    bar.innerHTML = `
      <h3>${esc(t("Continue your previous setup?"))}</h3>
      <p class="small">${t("You were on \"{step}\" ({when}). Your server keeps running on its own — the wizard can restore your answers and take you back to reconnect. You'll re-enter your passphrase, since it's never saved.", { step: esc(label), when: esc(when) })}</p>
      <div class="btn-row">
        <button class="primary" id="b-resume">${esc(t("Continue where I left off"))}</button>
        <button id="b-fresh">${esc(t("Start over"))}</button>
      </div>`;
    $("#stage").insertBefore(bar, $("#stage").firstChild);
    $("#b-resume").onclick = () => {
      S.mode = prev.mode || S.mode;
      Object.assign(S.ssh, prev.ssh || {});
      Object.assign(S.wallet, prev.wallet || {});
      if (prev.net) S.net = prev.net;
      S.chosenConfigFile = prev.chosenConfigFile || null;
      S.nodeConfigText = prev.nodeConfigText || "";
      S.models = prev.models || [];
      S.serverKeyName = prev.serverKeyName || null;
      (prev.done || []).forEach((i) => doneSteps.add(i));
      // Remember where they actually were; the wizard walks itself back there
      // once the two things that can't be restored — the SSH session and the
      // wallet passphrase — have been re-supplied.
      S.resumeTo = resumeTarget;
      renderRail();
      go(2);   // Connect first: everything downstream needs a live session
    };
    $("#b-fresh").onclick = () => {
      clearSession();
      S.furthest = 0; S.resumeTo = null;
      doneSteps.clear(); errorSteps.clear();
      renderRail(); bar.remove();
    };
  }

  (async () => {
    const card = $("#right-now-card");
    try {
      const [seed, rows] = await Promise.all([
        S.seed ? Promise.resolve(S.seed) : api("seed"),
        api("repoGpuConfigs")
      ]);
      S.seed = seed;
      let models = [];
      try { models = await api("models", { seed }); } catch (_) {}
      // Who is actually earning on each model THIS epoch — the live
      // availability signal (approval alone doesn't mean a model is active).
      let act = {};
      try { act = await api("modelActivity", { seed }); } catch (_) {}
      const hostsOf = (id) => (act[id] ? act[id].hosts : null);
      const approvedIds = new Set(models.map((m) => m.id));

      // Merge two sources of ready-made configs: files that exist in the
      // repo (auto-fetched), and reference configs published only in the
      // official docs (bundled in knowledge.js, remote-manifest updatable).
      // A repo file for the same model+GPU class wins over a docs entry.
      const repoKeys = new Set(rows.map((r) => r.model + "|" + r.gpuClass));
      const curated = (S.K.curatedConfigs || [])
        .filter((c) => approvedIds.has(c.model) && !repoKeys.has(c.model + "|" + c.gpuClass))
        .map((c) => ({ model: c.model, gpuClass: c.gpuClass, gpuCount: c.gpuCount, src: "official docs" }));
      // Gonka ships several configs per model+GPU class that differ only by a
      // filename suffix (e.g. "-nvfp4", a 4-bit quantised build). Without
      // showing that suffix the table looks like it has duplicate rows.
      const variantOf = (r) => {
        if (!r.file || !r.gpuClass) return "";
        const m = new RegExp(`${r.gpuClass}-(.+)\\.json$`, "i").exec(r.file);
        return m ? m[1] : "";
      };
      const ready = [
        ...rows.filter((r) => approvedIds.has(r.model)).map((r) => ({ ...r, src: "repository" })),
        ...curated
      // Null-safe: a config file whose GPU class the app doesn't recognise yet
      // (Gonka added B300 with the DeepSeek V4 configs) has gpuClass === null.
      // Sorting on it directly threw and took out the whole Welcome page with a
      // misleading "couldn't reach the network" message.
      ].sort((a, b) => String(a.model || "").localeCompare(String(b.model || ""))
                    || String(a.gpuClass || "").localeCompare(String(b.gpuClass || ""))
                    || String(variantOf(a)).localeCompare(String(variantOf(b))));
      S.readyRows = ready;   // reused by the renting checklist on the server step

      const classes = [...new Set(ready.map((r) => r.gpuClass).filter(Boolean))];
      const readyIds = new Set(ready.map((r) => r.model));
      const notReady = models.filter((m) => !readyIds.has(m.id));

      card.innerHTML = `
        <h3>What's supported right now</h3>
        <div id="arch-warn"></div>
        <p class="small">Fetched live from the network and the official repository — this updates automatically as
          Gonka adds models or GPU classes, no app update needed.</p>

        <h4>Ready to deploy through this wizard</h4>
        ${ready.length ? `
          <table class="hw-table">
            <thead><tr><th>Model</th><th>GPU class</th><th class="num">GPUs needed</th><th class="num">Active hosts</th><th>Config source</th></tr></thead>
            <tbody>${ready.map((r) => `
              <tr><td><code>${esc(r.model)}</code></td>
                <td>${esc(r.gpuClass || "—")}${variantOf(r) ? ` <span class="small">${esc(variantOf(r))}</span>` : ""}</td>
                <td class="num">${r.gpuCount ?? "—"}</td>
                <td class="num">${hostsOf(r.model) === null ? "—" : hostsOf(r.model) === 0 ? "0 ⚠" : hostsOf(r.model)}</td>
                <td class="small">${esc(r.src)}</td></tr>`).join("")}</tbody>
          </table>
          <ul class="plain small" style="margin-top:10px">
            <li><b>${esc(t("Model"))}</b> — ${t("the AI model your node will run and earn on")}</li>
            <li><b>${esc(t("GPU class"))}</b> — ${t("the graphics-card type this configuration is built for")}</li>
            <li><b>${esc(t("GPUs needed"))}</b> — ${t("how many of that card the reference configuration uses — rent exactly that many of that GPU class to run it")}</li>
            <li><b>${esc(t("Active hosts"))}</b> — ${t("how many participants are serving that model in the current epoch, read live from the chain. One host can serve several models at once, so these counts overlap")}</li>
            <li><b>${esc(t("Config source"))}</b> — ${t("where the ready-made configuration comes from — \"repository\" ships inside Gonka's official code repository; \"official docs\" is published on Gonka's documentation site and bundled into this app")}</li>
          </ul>` :
          `<p class="small">Nothing is ready to deploy automatically right now — check back before renting.</p>`}

        ${notReady.length ? `
          <h4 style="margin-top:16px">Approved on the network, but not automated here yet</h4>
          <table class="hw-table">
            <thead><tr><th>Model</th><th class="num">Total VRAM needed</th><th class="num">Active hosts</th></tr></thead>
            <tbody>${notReady.map((m) => `
              <tr><td><code>${esc(m.id)}</code></td><td class="num">${m.v_ram ? m.v_ram + " GB" : "—"}</td>
                <td class="num">${hostsOf(m.id) === null ? "—" : hostsOf(m.id) === 0 ? "0 ⚠" : hostsOf(m.id)}</td></tr>`).join("")}</tbody>
          </table>
          <p class="hint">${t("These models are live and earning on the network, but no tested reference configuration has been published for them yet — in the repository or the official docs. If you know vLLM and want to try building your own <code>node-config.json</code>, you can paste one in the Model & GPUs step later — otherwise, stick with the models listed above as ready.")}
            ${t("As soon as a reference configuration for such a model appears in the repository, it moves to the ready table automatically.")}</p>` : ""}
        ${(() => {
          const inactive = Object.keys(act).length ? models.filter((m) => !hostsOf(m.id)) : [];
          return inactive.length ? `<div class="warn-banner">⚠ ${inactive.map((m) => `<code>${esc(m.id)}</code>`).join(", ")} — ${t("no hosts are earning on this model this epoch — ask in the community before renting hardware for it")}</div>` : "";
        })()}

        <h4 style="margin-top:16px">${esc(t("What your computer or server must have"))}</h4>
        <ul class="plain">
          <li>${t("GPUs: exactly like a row in the ready table above — same count and class, e.g. {ex}",
            { ex: ready.length ? `${ready[0].gpuCount}× ${ready[0].gpuClass} (${ready[0].model.split("/").pop()})` : "2× H200" })}</li>
          <li>${t("Disk / storage: at least {gb} GB — rental defaults are often 500 GB, upgrade if needed", { gb: req.networkNode.diskGB })}</li>
          <li>${t("RAM: at least {gb} GB, and at least 1.5× your GPUs' total VRAM", { gb: req.networkNode.ramGB })}</li>
          <li>${t("CPU: {n}+ cores", { n: req.networkNode.cpuCores })}</li>
          <li>${t("System: Linux (a distribution such as Ubuntu, Debian, Rocky, or AlmaLinux — Ubuntu is the most common and works great) with NVIDIA drivers (CUDA {range}). Not Windows or macOS. The wizard installs any missing software for you.", { range: `${req.cudaMin}–${req.cudaMax}` })}</li>
          <li>${t("Access: administrator (root) rights — on a rented server that means the SSH login your provider gives you")}</li>
          <li>${t("Network: a public IP, with ports 8000 and 5000 open to the internet (8443 instead of 8000 for HTTPS). You don't open these on the server — you open them in your rental provider's dashboard (look for \"firewall\", \"security group\", or \"port mapping\"). Many GPU providers leave all ports open already, so often there's nothing to do; the Verify step at the end tests it from the outside and tells you for sure.")}</li>
        </ul>
        <p class="small">${t("Check this list before paying for anything — once you connect, the health check verifies every item automatically.")}</p>
        <p class="small">${t("No SSH key yet? If you're renting a server and the provider asks for an \"SSH public key\" before you can deploy, choose \"A rented / remote server\" on the next screen — the wizard can create the key for you and show you exactly what to paste.")}</p>`;

      // Can a normal (x86/amd64) server even run the current release? Gonka has
      // shipped releases built only for arm64, which makes joining impossible
      // on ordinary rented hardware. Say so HERE — before anyone pays.
      (async () => {
        try {
          const st = await api("releaseArch", { arch: "amd64" });
          const slot = $("#arch-warn");
          if (!slot || !st || !st.bad || !st.bad.length) return;
          slot.innerHTML = `<div class="warn-banner">⚠ ${t("<b>Don't rent hardware yet.</b> Gonka's current release doesn't include builds for normal x86/amd64 servers ({list}), so a node can't run on one right now. This is an upstream packaging issue on Gonka's side — not something this wizard can work around. Ask in the Gonka Discord when amd64 builds will be published, and check back here: this warning disappears on its own once they are.",
            { list: st.bad.map((b) => `<code>${esc(b.image.split("/").pop())}</code>`).join(", ") })}</div>`;
        } catch (_) { /* offline — no warning rather than a false alarm */ }
      })();
    } catch (e) {
      card.innerHTML = `
        <h3>What's supported right now</h3>
        <p class="small">Couldn't reach the network or GitHub from here (${esc(e.message)}). You'll see this again once
          you're connected — for now, the baseline is ${req.networkNode.cpuCores}+ CPU cores, ${req.networkNode.ramGB}+ GB RAM,
          ${req.networkNode.diskGB}+ GB disk, CUDA ${req.cudaMin}–${req.cudaMax}, on a supported NVIDIA GPU (A100/H100/H200/B200).</p>`;
    }
  })();
};

/* --- 1 Mode --------------------------------------------------------- */
RENDER.mode = () => {
  stage(`
    ${header("Step 2", "Where is your server?", `
      The node runs on a Linux machine with a GPU. Tell the wizard where that machine is.`)}
    <div class="choice-grid">
      <div class="choice ${S.mode === "ssh" ? "selected" : ""}" id="c-ssh">
        <div class="c-title">A rented / remote server</div>
        <div class="c-desc">You rented a GPU machine (Spheron, a datacenter, a cloud VM…). The wizard connects to it over SSH and does everything for you.</div>
      </div>
      <div class="choice ${S.mode === "local" ? "selected" : ""}" id="c-local">
        <div class="c-title">This computer</div>
        <div class="c-desc">The GPU machine is the computer you're using right now (Linux, or Windows with WSL2).</div>
      </div>
    </div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-next" ${S.mode ? "" : "disabled"}>Continue</button>
    </div>`);
  const sel = (m) => { S.mode = m; RENDER.mode(); };
  $("#c-ssh").onclick = () => sel("ssh");
  $("#c-local").onclick = () => sel("local");
  $("#b-back").onclick = () => go(0);
  $("#b-next").onclick = () => { markDone(); go(2); };
};

/* --- 2 Connect ------------------------------------------------------ */
RENDER.connect = () => {
  if (S.mode === "local") {
    stage(`
      ${header("Step 3", "Use this computer as the server", `
        The wizard will run its checks and commands directly on this machine.
        ${S.platform === "win32" ? "You're on Windows, so everything runs inside WSL2 (Ubuntu)." : ""}`)}
      <div class="btn-row">
        <button id="b-back">Back</button>
        <button class="primary" id="b-conn">Check this machine</button>
      </div>`);
    $("#b-back").onclick = () => go(1);
    $("#b-conn").onclick = async () => {
      try {
        setBusy(true, "Checking local machine…");
        const r = await api("connect", { mode: "local" });
        S.connected = true;
        toast("Connected: " + r.info);
        refreshTermPrompt();   // the command line can work from here on
        markDone();
        // Same resume shortcut as the SSH path: skip ahead via the wallet stop.
        if (S.resumeTo && S.resumeTo > 3) { go(4); return; }
        go(3);
      } catch (e) { markError(); alert(e.message); }
      finally { setBusy(false); }
    };
    return;
  }

  const s = S.ssh;
  stage(`
    ${header("Step 3", "Connect to your server", `
      Enter the SSH details your provider gave you when the server started. The connection stays inside this app.`)}
    <div class="card">
      <label class="field" style="max-width:640px"><span class="lbl">${esc(t("Or paste the SSH command your provider shows — the fields below fill in automatically"))}</span>
        <input type="text" id="f-sshcmd" class="mono" placeholder="ssh -i key root@203.0.113.10"></label>
      <hr class="sep">
      <label class="field"><span class="lbl">Server address (IP or hostname)</span>
        <input type="text" id="f-host" class="mono" value="${esc(s.host)}" placeholder="e.g. 203.0.113.42"></label>
      <label class="field"><span class="lbl">SSH port</span>
        <input type="number" id="f-port" class="mono" value="${esc(s.port)}"></label>
      <label class="field"><span class="lbl">Username</span>
        <input type="text" id="f-user" class="mono" value="${esc(s.username)}"></label>
      <label class="field"><span class="lbl">How do you log in?</span>
        <select id="f-auth">
          <option value="key" ${s.auth === "key" ? "selected" : ""}>SSH key file (recommended)</option>
          <option value="password" ${s.auth === "password" ? "selected" : ""}>Password</option>
          <option value="create" ${s.auth === "create" ? "selected" : ""}>I don't have an SSH key — create one for me</option>
        </select></label>
      <div id="auth-key" style="display:${s.auth === "key" ? "block" : "none"}">
        <label class="field"><span class="lbl">Private key file</span>
          <input type="text" id="f-keypath" class="mono" value="${esc(s.privateKeyPath)}" placeholder="e.g. ~/.ssh/id_ed25519">
        </label>
        <button id="b-pick">Choose file…</button>
        <label class="field" style="margin-top:12px"><span class="lbl">Key passphrase (leave empty if none)</span>
          <input type="password" id="f-keypass" value="${esc(s.passphrase)}"></label>
      </div>
      <div id="auth-pass" style="display:${s.auth === "password" ? "block" : "none"}">
        <label class="field"><span class="lbl">Password</span>
          <input type="password" id="f-pass" value="${esc(s.password)}"></label>
      </div>
      <div id="auth-create" style="display:${s.auth === "create" ? "block" : "none"}">
        ${s.generated ? `
          <p class="small">${esc(t("Using the SSH key already created on this computer."))}</p>` : ""}
        ${s.generated ? `
          <p class="small">${esc(t("Your public SSH key — safe to share:"))}</p>
          <pre class="preview mono" style="user-select:text; white-space:pre-wrap; word-break:break-all">${esc(s.generated.publicKey)}</pre>
          <div class="btn-row" style="margin-top:8px"><button id="b-copypub">${esc(t("Copy public key"))}</button></div>
          <p class="small">${t('Paste this into your provider\'s "SSH Public Key" box when ordering the server. The private half stays on this computer, and the wizard uses it automatically when you connect.')}</p>
        ` : `
          <button id="b-genkey" class="primary">${esc(t("Create SSH key"))}</button>
        `}
      </div>
    </div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-conn">Connect</button>
    </div>`);
  $("#b-back").onclick = () => go(1);

  // If a key was already generated on this computer, show it straight away —
  // making someone press "Create SSH key" again to reveal a key they already
  // have (and already pasted at their provider) is pointless friction.
  if (s.auth === "create" && !s.generated && !s.sshPeeked) {
    s.sshPeeked = true;
    (async () => {
      try {
        const info = await api("sshKeyInfo");
        if (info && info.publicKey) {
          s.generated = info;
          s.privateKeyPath = info.privatePath;
          if (S.step === 2) RENDER.connect();
        }
      } catch (_) {}
    })();
  }

  // Providers hand out a full "ssh user@host" command — parse it so nobody
  // has to know that the word before @ is the username.
  $("#f-sshcmd").oninput = (e) => {
    const v = e.target.value;
    const uh = v.match(/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)/);
    const pp = v.match(/-p\s*(\d+)/);
    if (uh) {
      s.username = uh[1]; s.host = uh[2];
      $("#f-user").value = s.username;
      $("#f-host").value = s.host;
    }
    if (pp) { s.port = parseInt(pp[1], 10); $("#f-port").value = s.port; }
  };
  $("#f-auth").onchange = (e) => { s.auth = e.target.value; RENDER.connect(); };
  $("#b-pick") && ($("#b-pick").onclick = async () => {
    const p = await api("pickFile");
    if (p) { s.privateKeyPath = p; $("#f-keypath").value = p; }
  });
  $("#b-genkey") && ($("#b-genkey").onclick = async () => {
    try {
      setBusy(true, "Creating SSH key…");
      const r = await api("sshKeygen");
      s.generated = r;
      s.privateKeyPath = r.privatePath;
      s.passphrase = "";
      RENDER.connect();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  });
  $("#b-copypub") && ($("#b-copypub").onclick = async () => {
    const b = $("#b-copypub");
    try { await navigator.clipboard.writeText(s.generated.publicKey); }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = s.generated.publicKey; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
    }
    b.textContent = "✓";
    setTimeout(() => { b.textContent = t("Copy public key"); }, 2000);
  });
  $("#b-conn").onclick = async () => {
    s.host = $("#f-host").value.trim();
    s.port = parseInt($("#f-port").value, 10) || 22;
    s.username = $("#f-user").value.trim();
    if (s.auth === "key") { s.privateKeyPath = $("#f-keypath").value.trim(); s.passphrase = $("#f-keypass").value; s.password = ""; }
    else if (s.auth === "create") {
      if (!s.generated) return alert(t("Create the SSH key first."));
      s.privateKeyPath = s.generated.privatePath; s.passphrase = ""; s.password = "";
    }
    else { s.password = $("#f-pass").value; s.privateKeyPath = ""; }
    if (!s.host || !s.username) return alert("Address and username are required.");
    try {
      setBusy(true, "Connecting over SSH…");
      const r = await api("connect", { mode: "ssh", ssh: {
        host: s.host, port: s.port, username: s.username,
        password: s.password || undefined,
        privateKeyPath: s.privateKeyPath || undefined,
        passphrase: s.passphrase || undefined
      }});
      S.connected = true;
      toast("Connected: " + r.info);
      refreshTermPrompt();   // the command line can work from here on
      markDone();
      // Resuming: the wallet passphrase is never saved, so if the saved step is
      // past the wallet, stop there first — otherwise the config would be
      // written with an empty keyring password.
      if (S.resumeTo && S.resumeTo > 3) { go(4); return; }
      go(3);
    } catch (e) { markError(); alert("Connection failed: " + e.message); }
    finally { setBusy(false); }
  };
};

/* --- 3 Scan --------------------------------------------------------- */
RENDER.scan = () => {
  stage(`
    ${header("Step 4", "Server health check", `
      The wizard inspects your server against Gonka's requirements. Anything with a
      <b>Fix</b> button can be repaired with one click — you'll see the exact commands first.`)}
    <div class="card" id="scan-card"><span class="small">Press "Run health check" to begin.</span></div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button id="b-scan" class="primary">Run health check</button>
      <span class="spacer"></span>
      <button id="b-next" ${S.scan && S.scan.ok ? "" : "disabled"}>Continue</button>
    </div>`);
  $("#b-back").onclick = () => go(2);
  $("#b-next").onclick = () => { markDone(); go(4); };
  $("#b-scan").onclick = runScan;
  if (S.scan) paintScan();

  async function runScan() {
    // A scan started here can finish after the user has already moved on
    // (e.g. the re-scan that follows a Fix). Every DOM write below is guarded
    // so late results never throw into a dead screen.
    try {
      setBusy(true, "Scanning server…");
      const card0 = $("#scan-card");
      if (card0) card0.innerHTML = '<span class="small">Scanning… this takes ~20 seconds.</span>';
      S.scan = await api("scan");
      if (S.scan.facts.publicIp && !S.net.host) S.net.host = S.scan.facts.publicIp;
      if (!$("#scan-card")) return;          // user navigated away — result is stored in S.scan
      paintScan();
      const nextBtn = $("#b-next");
      if (nextBtn) nextBtn.disabled = !S.scan.ok;
      if (S.scan.ok) markDone();
    } catch (e) {
      markError();
      const card = $("#scan-card");
      if (card) card.innerHTML = `<span class="pill err">Scan failed</span> ${esc(e.message)}`;
    }
    finally { setBusy(false); }
  }

  function paintScan() {
    const icons = { pass: "●", warn: "▲", fail: "✕" };
    if (!$("#scan-card")) return;   // screen changed under us — nothing to paint
    $("#scan-card").innerHTML = S.scan.items.map((it, idx) => `
      <div class="check-item">
        <span class="check-icon ${it.status}">${icons[it.status]}</span>
        <div class="check-body">
          <div class="c-label">${esc(it.label)}</div>
          ${it.detail ? `<div class="c-detail">${esc(it.detail)}</div>` : ""}
        </div>
        ${it.fixable ? `<button data-fix="${esc(it.id)}">Fix</button>` : ""}
      </div>`).join("") +
      (S.scan.ok
        ? `<div class="info-banner">Everything required is in place. Warnings (▲) are worth reading but won't block setup.</div>`
        : `<div class="warn-banner">Fix the red items to continue. After fixing, run the health check again.</div>`);
    document.querySelectorAll("[data-fix]").forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.fix;
        try {
          const plan = await api("fixPlan", { id });
          if (!plan || !plan.cmd) return alert(plan ? plan.description : "No automated fix available.");
          const yes = confirm(`${plan.description}\n\nThe wizard will run this on your server:\n\n${plan.cmd}\n\nProceed?`);
          if (!yes) return;
          setBusy(true, "Fixing: " + id);
          b.disabled = true; b.textContent = "Fixing…";
          await api("fixRun", { id });
          if (id === "cuda") {
            // The driver upgrade reboots the server — the SSH session is gone.
            alert("Driver installed — the server is now rebooting.\n\nWait about 2 minutes, then press Connect again; the wizard will return you to the connect screen. After reconnecting, run the health check once more.");
            S.connected = false;
            S.scan = null;
            go(2);
            return;
          }
          // Group membership (docker) only applies to a NEW login session, so
          // re-scanning over the existing SSH connection would fail forever.
          // Reconnect first — same credentials, fresh session, new groups.
          if (id === "docker-perm" && S.mode === "ssh") {
            setBusy(true, "Reconnecting so the new permission takes effect…");
            try {
              await api("connect", { mode: "ssh", ssh: {
                host: S.ssh.host, port: S.ssh.port, username: S.ssh.username,
                password: S.ssh.password || undefined,
                privateKeyPath: S.ssh.privateKeyPath || undefined,
                passphrase: S.ssh.passphrase || undefined
              }});
              toast("Reconnected with the new docker permission.");
            } catch (e) {
              throw new Error("Added you to the docker group, but reconnecting failed: " + e.message +
                "\n\nGo back to Connect and reconnect manually, then run the health check again.");
            }
          }
          toast("Fixed: " + id + " — re-scanning…");
          await runScan();
        } catch (e) { showFixError(e.message); b.disabled = false; b.textContent = "Fix"; }
        finally { setBusy(false); }
      };
    });
  }

  // A fix failure shown in a native alert can't be copied — render it in the
  // page instead, with the runnable command in its own block and a Copy button.
  function showFixError(msg) {
    const card = $("#scan-card");
    if (!card) { logLine("\n" + msg + "\n", "stderr"); return; }  // navigated away — log it instead
    card.querySelectorAll(".fix-error").forEach((x) => x.remove());
    const m = msg.match(/:\n\n([\s\S]+?)\n\nThen come back/);
    const cmd = m ? m[1].trim() : null;
    const intro = msg.split("\n\n")[0];
    // Non-technical local users may not know how to open a terminal — give a
    // platform-specific hint. In SSH mode "a terminal" means their server shell.
    let termHint = "";
    if (S.mode === "local") {
      termHint = S.platform === "win32"
        ? t("To open one: press Start, type <b>wsl</b>, and hit Enter.")
        : t("To open one: look for <b>Terminal</b> in your applications (on Ubuntu, press Ctrl+Alt+T).");
    } else {
      termHint = t("Run it in the SSH session to your server (the same login your provider gave you).");
    }
    const div = document.createElement("div");
    div.className = "warn-banner fix-error";
    div.innerHTML = cmd ? `
      <div>${esc(intro)}</div>
      <pre class="preview mono" style="margin:10px 0 0">${esc(cmd)}</pre>
      <div class="btn-row" style="margin-top:10px">
        <button class="b-copy-fix">Copy command</button>
        <button class="b-dismiss-fix">Dismiss</button>
      </div>
      <p class="small" style="margin:8px 0 0">${termHint} ${t('Paste the command, run it, then press "Run health check" again.')}</p>` : `
      <div>Fix failed:</div>
      <pre class="preview mono" style="margin:10px 0 0">${esc(msg)}</pre>
      <div class="btn-row" style="margin-top:10px"><button class="b-dismiss-fix">Dismiss</button></div>`;
    card.insertBefore(div, card.firstChild);
    div.scrollIntoView({ block: "nearest" });
    const cb = div.querySelector(".b-copy-fix");
    if (cb) cb.onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); }
      catch (_) {
        const ta = document.createElement("textarea");
        ta.value = cmd; document.body.appendChild(ta);
        ta.select(); document.execCommand("copy"); ta.remove();
      }
      cb.textContent = "Copied ✓";
      setTimeout(() => { cb.textContent = "Copy command"; }, 2500);
    };
    div.querySelector(".b-dismiss-fix").onclick = () => div.remove();
  }
};

/* --- 4 Wallet ------------------------------------------------------- */
RENDER.wallet = () => {
  const w = S.wallet;
  if (w.address && w.confirmed) return walletDone();

  stage(`
    ${header("Step 5", "Your Gonka wallet (Account Key)", `
      This is the master key of your whole operation. It is created <b>on this computer</b> — never
      on the server — and it's the only thing that can grant permissions, register your node, and
      move your rewards.`)}
    <div class="choice-grid">
      <div class="choice" id="c-new">
        <div class="c-title">Create a new wallet</div>
        <div class="c-desc">Recommended if this is your first Gonka node. You'll get a 24-word recovery phrase to write down.</div>
      </div>
      <div class="choice" id="c-import">
        <div class="c-title">I already have a wallet</div>
        <div class="c-desc">Restore it here from your 24-word recovery phrase, or unlock a key already on this computer.</div>
      </div>
    </div>
    <div id="wallet-form"></div>
    <div class="btn-row"><button id="b-back">Back</button></div>`);
  $("#b-back").onclick = () => go(3);
  $("#c-new").onclick = () => form("new");
  $("#c-import").onclick = () => form("import");

  function form(kind) {
    $("#wallet-form").innerHTML = `
      <div class="card" style="margin-top:16px">
        ${kind === "import" ? `
          <label class="field"><span class="lbl">What do you want to do?</span>
            <select id="f-imode">
              <option value="mnemonic">Restore from my 24-word recovery phrase</option>
              <option value="existing">Unlock a key already saved on this computer</option>
            </select></label>
          <div id="f-mn-wrap">
            <label class="field" style="max-width:640px"><span class="lbl">Recovery phrase (24 words, separated by spaces)</span>
              <textarea id="f-mn" class="mono" rows="3" spellcheck="false"></textarea></label>
          </div>` : ""}
        <label class="field"><span class="lbl">Key name</span>
          <input type="text" id="f-name" class="mono" value="${esc(w.name)}"></label>
        <label class="field"><span class="lbl" id="lbl-pass1"></span>
          <input type="password" id="f-pass1"></label>
        <label class="field" id="row-pass2"><span class="lbl">Repeat passphrase</span>
          <input type="password" id="f-pass2"></label>
        <div class="btn-row" style="margin-top:8px">
          <button class="primary" id="b-go">${kind === "new" ? "Create wallet" : "Continue"}</button>
        </div>
        <div id="keyring-note"></div>
      </div>`;

    // If keys already live here, say so up front — all wallets on one computer
    // share a single keyring passphrase, which is the #1 source of confusion.
    (async () => {
      let names = [];
      try { names = await api("keyNames"); } catch (_) {}
      const note = $("#keyring-note");
      if (!note || !names.length) return;
      note.innerHTML = `
        <hr class="sep">
        <p class="small">${t("This computer already holds {n}: {list}. All wallets here share one keyring passphrase, so use that same passphrase — or reset the keyring to start fresh.",
          { n: names.length === 1 ? t("1 wallet") : t("{c} wallets", { c: names.length }), list: names.map((x) => `<code>${esc(x)}</code>`).join(", ") })}</p>
        <div class="btn-row"><button class="danger" id="b-reset-kr">${esc(t("Reset the keyring"))}</button></div>`;
      $("#b-reset-kr").onclick = async () => {
        if (!confirm(t("Delete every wallet saved on this computer?\n\nThis permanently removes: {list}\n\nYou can only get them back with their 24-word recovery phrases. Your funds stay safe on the blockchain — this only deletes the local copies.", { list: names.join(", ") }))) return;
        try {
          await api("resetKeyring");
          alert(t("Keyring cleared. You can now create a new wallet with a fresh passphrase."));
          RENDER.wallet();
        } catch (e) { alert(e.message); }
      };
    })();

    const imode = $("#f-imode");
    // Unlocking an existing key means TYPING the passphrase you already set —
    // not choosing a new one, and no need to repeat it.
    const unlockMode = () => kind === "import" && imode && imode.value === "existing";
    const syncLabels = () => {
      if (imode) $("#f-mn-wrap").style.display = imode.value === "mnemonic" ? "block" : "none";
      $("#lbl-pass1").textContent = unlockMode()
        ? t("Enter your passphrase (the one you set when this key was created)")
        : t("Choose a passphrase (protects the key on this computer — min 8 characters)");
      $("#row-pass2").style.display = unlockMode() ? "none" : "block";
    };
    if (imode) imode.onchange = syncLabels;
    syncLabels();
    $("#b-go").onclick = async () => {
      const name = $("#f-name").value.trim();
      const p1 = $("#f-pass1").value, p2 = $("#f-pass2").value;
      if (!name) return alert("Give the key a name.");
      if (unlockMode()) {
        if (!p1) return alert("Enter your passphrase.");
      } else {
        if (p1.length < 8) return alert("The passphrase must be at least 8 characters.");
        if (p1 !== p2) return alert("The passphrases don't match.");
      }
      w.name = name; w.passphrase = p1;
      try {
        setBusy(true, "Preparing the Gonka CLI…");
        await api("ensureCli");
        if (kind === "new") {
          const r = await api("keyCreate", { name, passphrase: p1 });
          w.address = r.address; w.pubkey = extractPubkey(r.pubkey); w.isNew = true;
          mnemonicCeremony(r.mnemonic);
        } else if (imode && imode.value === "mnemonic") {
          // Recovery words are pure lowercase letters — strip numbering
          // ("1buyer2volcano…"), commas, and stray punctuation people add.
          const mn = $("#f-mn").value.toLowerCase().replace(/[^a-z]+/g, " ").trim();
          if (mn.split(" ").length < 12) return alert("That doesn't look like a full recovery phrase.");
          const r = await api("keyImport", { name, passphrase: p1, mnemonic: mn });
          w.address = r.address; w.pubkey = extractPubkey(r.pubkey); w.confirmed = true;
          markDone(); walletDone();
        } else {
          const r = await api("keyShow", { name, passphrase: p1 });
          w.address = r.address; w.pubkey = extractPubkey(r.pubkey); w.confirmed = true;
          markDone(); walletDone();
        }
      } catch (e) { alert(e.message); }
      finally { setBusy(false); }
    };
  }

  function extractPubkey(pk) {
    // CLI returns a JSON string like {"@type":"...","key":"Au+a..."} — Gonka wants the key value.
    try { const j = typeof pk === "string" ? JSON.parse(pk) : pk; return j.key || pk; } catch (_) { return pk; }
  }

  function mnemonicCeremony(mnemonic) {
    const words = mnemonic.trim().split(/\s+/);
    const idxA = Math.floor(Math.random() * words.length);
    let idxB = Math.floor(Math.random() * words.length);
    if (idxB === idxA) idxB = (idxB + 7) % words.length;
    stage(`
      ${header("Step 5", "Write down your recovery phrase", `
        These ${words.length} words are the <b>only</b> way to recover your wallet — and your rewards —
        if this computer dies or you forget the passphrase. This app does not save them anywhere.`)}
      <div class="mnemonic-box">${words.map((w2, i) =>
        `<span class="word"><span class="idx">${i + 1}</span>${esc(w2)}</span>`).join("")}</div>
      <div class="warn-banner">
        Write them on paper, in order. Don't screenshot, don't email them to yourself, don't put them
        in a notes app. Anyone with these words controls your money.
      </div>
      <div class="card">
        <h3>Prove you wrote them down</h3>
        <label class="field"><span class="lbl">Word #${idxA + 1}</span><input type="text" id="q-a" class="mono" autocomplete="off"></label>
        <label class="field"><span class="lbl">Word #${idxB + 1}</span><input type="text" id="q-b" class="mono" autocomplete="off"></label>
        <div class="btn-row"><button class="primary" id="b-verify">I wrote them down — verify</button></div>
      </div>`);
    $("#b-verify").onclick = () => {
      const a = $("#q-a").value.trim().toLowerCase();
      const b = $("#q-b").value.trim().toLowerCase();
      if (a !== words[idxA] || b !== words[idxB]) return alert("One of the words doesn't match. Check your paper copy and try again.");
      S.wallet.confirmed = true;
      markDone(); walletDone();
    };
  }

  function walletDone() {
    const fa = S.K.faucet || {};
    stage(`
      ${header("Step 5", "Wallet ready", "Your Account Key is set up on this computer.")}
      <div class="card">
        <div class="kv">address&nbsp; <b>${esc(w.address)}</b></div>
        <div class="kv">pubkey&nbsp;&nbsp; <b>${esc(w.pubkey)}</b></div>
        <p class="small">The pubkey goes into your server's configuration automatically. The key itself stays here.</p>
      </div>
      <div id="bal-area"><div class="info-banner">${esc(t("Checking your GNK balance…"))}</div></div>
      <div class="btn-row">
        <button id="b-back">Back</button>
        <button class="primary" id="b-next">Continue</button>
      </div>`);
    $("#b-back").onclick = () => { S.balPoll && clearInterval(S.balPoll); S.balPoll = null; RENDER.wallet(); };
    $("#b-next").onclick = () => {
      S.balPoll && clearInterval(S.balPoll); S.balPoll = null;
      // Wallet is unlocked, so a resumed session can now jump the rest of the
      // way back to where the user actually left off.
      const target = S.resumeTo && S.resumeTo > 5 ? S.resumeTo : 5;
      S.resumeTo = null;
      goResumed(target);
    };

    // Live funding helper: shows how to fund the wallet, and auto-detects the
    // moment GNK arrives (polls the address) so there's no guessing.
    function fundingCard() {
      return `
        <div class="card">
          <h3>${esc(t("Fund this wallet"))}</h3>
          <p class="small">${t("Registering is free, but the \"grant permissions\" step (during launch) needs GNK for gas. One faucet claim ({amt}) covers it with little to spare — if the grant later stops with \"insufficient funds,\" claim again or top up. Collateral is optional and needs much more.", { amt: fa.amount ? esc(fa.amount) : "0.01 GNK" })}</p>
          <div class="kv">${esc(t("Send GNK to"))}&nbsp; <b>${esc(w.address)}</b></div>
          <div class="btn-row" style="margin-top:6px">
            <button id="b-copy-addr">${esc(t("Copy address"))}</button>
            ${fa.url ? `<button id="b-faucet" class="primary">${esc(t("Open the Gonka faucet"))}</button>` : ""}
          </div>
          <p class="hint" style="margin-top:10px">${t("The faucet sends GNK to a browser \"gg wallet,\" not directly here. Two ways to get it into this wallet:")}</p>
          <ul class="plain small">
            <li>${t("Easiest — when you set up the gg wallet, use its 24-word phrase: go Back, choose \"Restore from my 24-word recovery phrase,\" and this wallet becomes the funded one (no transfer).")}</li>
            <li>${t("Or claim to the gg wallet, then send the GNK from it to the address above.")}</li>
          </ul>
          <div class="info-banner" id="bal-live">${esc(t("Watching this address for incoming GNK…"))}</div>
        </div>`;
    }

    const paint = async () => {
      try {
        if (!S.seed) S.seed = await api("seed");
        const bal = await api("balance", { seed: S.seed, address: w.address });
        const area = $("#bal-area");
        if (!area) { S.balPoll && clearInterval(S.balPoll); S.balPoll = null; return; }
        if (bal === null) {
          area.innerHTML = `<div class="info-banner">${esc(t("Couldn't read the balance right now — that's fine, you can continue."))}</div>`;
        } else if (bal > 0) {
          S.balPoll && clearInterval(S.balPoll); S.balPoll = null;
          area.innerHTML = `<div class="info-banner"><span class="pill ok">FUNDED</span> ${t("Balance: {n}. The steps that pay gas (granting permissions, and collateral) will work.", { n: `<b>${gnk(bal)}</b>` })}</div>`;
        } else {
          // Only (re)render the funding card once, then just refresh the live line.
          if (!$("#bal-live")) {
            area.innerHTML = fundingCard();
            $("#b-copy-addr").onclick = async () => {
              try { await navigator.clipboard.writeText(w.address); } catch (_) {}
              $("#b-copy-addr").textContent = "✓";
              setTimeout(() => { $("#b-copy-addr").textContent = t("Copy address"); }, 1500);
            };
            if ($("#b-faucet")) $("#b-faucet").onclick = () => api("openExternal", { url: fa.url });
          }
        }
      } catch (_) {}
    };
    paint();
    S.balPoll && clearInterval(S.balPoll);
    S.balPoll = setInterval(paint, 8000);   // auto-detect funds arriving
  }
};

/* --- 5 Network & SSL ------------------------------------------------ */
RENDER.network = () => {
  const n = S.net;
  const K = S.K;
  stage(`
    ${header("Step 6", "How will the network reach your node?", `
      Other participants send you inference work over the internet. Choose how they connect.`)}
    <div class="choice-grid">
      <div class="choice ${n.scheme === "http" ? "selected" : ""}" id="c-http">
        <div class="c-title">Simple — HTTP with my server's IP</div>
        <div class="c-desc">No domain name needed. Fine to get started; traffic isn't encrypted.</div>
      </div>
      <div class="choice ${n.scheme === "https" ? "selected" : ""}" id="c-https">
        <div class="c-title">Secure — HTTPS with my own domain</div>
        <div class="c-desc">Requires a domain name pointing at the server. Certificates are issued automatically. Recommended for production.</div>
      </div>
    </div>
    <div id="net-form" style="margin-top:16px"></div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-next">Continue</button>
    </div>`);
  $("#c-http").onclick = () => { n.scheme = "http"; RENDER.network(); };
  $("#c-https").onclick = () => { n.scheme = "https"; RENDER.network(); };
  $("#b-back").onclick = () => go(4);

  const portsHelp = (ports) => `
    <p class="small"><b>How to open ports ${ports}:</b> on a rented server this is done in your provider's
      dashboard, not on the server itself — look for "port mappings", "firewall rules", or "security groups"
      in the instance settings and allow TCP ${ports} from anywhere. On your own machine at home, it means
      port-forwarding ${ports} on your router to this computer. You don't have to get this perfect now —
      the <b>Verify</b> step at the end tests from the outside whether your node is actually reachable.</p>`;

  const form = $("#net-form");
  if (n.scheme === "http") {
    form.innerHTML = `
      <div class="card">
        <label class="field"><span class="lbl">Your server's public IP address</span>
          <input type="text" id="f-host" class="mono" value="${esc(n.host)}" placeholder="e.g. 203.0.113.42"></label>
        <p class="small">Detected automatically during the health check when possible. Ports <b>8000</b> and <b>5000</b>
          must be open to the internet — everything else stays private.</p>
        ${portsHelp("8000 and 5000")}
      </div>`;
  } else {
    const prov = K.dnsProviders.find((p) => p.id === n.dnsProviderId) || K.dnsProviders[0];
    form.innerHTML = `
      <div class="card">
        <label class="field"><span class="lbl">Your domain name (must already point to the server's IP)</span>
          <input type="text" id="f-domain" class="mono" value="${esc(n.domain)}" placeholder="e.g. mynode.example.com"></label>
        <label class="field"><span class="lbl">Email for the certificate authority</span>
          <input type="text" id="f-email" class="mono" value="${esc(n.email)}"></label>
        <label class="field"><span class="lbl">Who manages your domain's DNS?</span>
          <select id="f-dns">${K.dnsProviders.map((p) =>
            `<option value="${p.id}" ${p.id === n.dnsProviderId ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
        <div id="dns-fields">${prov.env.map((v) => `
          <label class="field"><span class="lbl">${esc(v.label)}</span>
            <input type="${v.secret ? "password" : "text"}" class="mono" data-env="${esc(v.key)}"
                   value="${esc(n.dnsEnv[v.key] || "")}" ${v.hint ? `placeholder="${esc(v.hint)}"` : ""}></label>`).join("")}
        </div>
        <p class="small">The wizard uses these to prove domain ownership and issue certificates automatically. Ports <b>8443</b> and <b>5000</b> must be open to the internet.</p>
        ${portsHelp("8443 and 5000")}
      </div>`;
    $("#f-dns").onchange = (e) => { n.dnsProviderId = e.target.value; RENDER.network(); };
  }

  $("#b-next").onclick = () => {
    if (n.scheme === "http") {
      n.host = $("#f-host").value.trim();
      if (!n.host) return alert("Enter your server's public IP.");
    } else {
      n.domain = $("#f-domain").value.trim();
      n.email = $("#f-email").value.trim();
      if (!n.domain || !/\./.test(n.domain)) return alert("Enter a valid domain name.");
      if (!n.email || !/@/.test(n.email)) return alert("Enter a valid email address.");
      n.host = n.domain;
      document.querySelectorAll("[data-env]").forEach((i) => { n.dnsEnv[i.dataset.env] = i.value.trim(); });
      const prov = K.dnsProviders.find((p) => p.id === n.dnsProviderId);
      for (const v of prov.env) if (!n.dnsEnv[v.key]) return alert(`"${v.label}" is required for ${prov.label}.`);
    }
    markDone(); go(6);
  };
};

/* --- 6 Model & GPUs -------------------------------------------------- */
RENDER.model = () => {
  stage(`
    ${header("Step 7", "Pick your model configuration", `
      Gonka ships a ready-made configuration for every approved model and common GPU class.
      The wizard downloads the latest ones from the official repository and highlights the match for your GPUs.`)}
    <div class="card" id="model-card"><span class="small">Fetching the Gonka repository and the live model list…</span></div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-next" ${S.chosenConfigFile ? "" : "disabled"}>Continue</button>
    </div>`);
  $("#b-back").onclick = () => go(5);
  $("#b-next").onclick = () => { markDone(); go(7); };

  async function load() {
    try {
      setBusy(true, "Preparing repository…");
      $("#model-card").innerHTML = '<span class="small">Fetching the Gonka repository and the live model list…</span>';
      if (!S.repoReady) { await api("clone"); S.repoReady = true; }
      const files = await api("listNodeConfigs");
      S.nodeConfigFiles = files;
      if (!S.seed) S.seed = await api("seed");
      try { S.governance = await api("models", { seed: S.seed }); } catch (_) { S.governance = []; }
      let repoRows = [];
      try { repoRows = await api("repoGpuConfigs"); } catch (_) {}
      const ranked = await api("rankConfigs", { files });
      paint(ranked, repoRows);
    } catch (e) {
      markError();
      $("#model-card").innerHTML = `
        <span class="pill err">Failed</span> ${esc(e.message)}
        <div class="btn-row" style="margin-top:12px"><button id="b-retry-model" class="primary">Try again</button></div>
        <p class="small" style="margin-top:8px">This step downloads from the internet — if your connection blipped, trying again usually works.</p>`;
      $("#b-retry-model").onclick = load;
    } finally { setBusy(false); }
  }
  load();

  function paint(ranked, repoRows) {
    const gpus = (S.scan && S.scan.facts.gpus) || [];
    const gpuLine = gpus.length
      ? `Detected: <b>${gpus.length}× ${esc(gpus[0].name)}</b>`
      : `<span class="pill warn">No GPU detected</span> — you can still prepare a config, but inference won't run.`;
    const gov = S.governance.length
      ? `<p class="small">Live governance-approved models right now: ${S.governance.map((m) => `<code>${esc(m.id)}</code>`).join(", ")}</p>`
      : `<p class="small">Couldn't fetch the live model list — using the repository's reference configs.</p>`;

    // Cross-check each file against the live approved-models list so a stale
    // config for a model the network no longer scores for PoC can't be picked
    // by accident — the repo doesn't clean these up automatically.
    const approvedIds = new Set(S.governance.map((m) => m.id));
    const fileModel = new Map(repoRows.map((r) => [r.file, r.model]));
    const knownApproved = (file) => {
      const m = fileModel.get(file);
      return m === undefined ? null : approvedIds.has(m); // null = couldn't cross-check
    };
    const shown = S.governance.length ? ranked.filter((r) => knownApproved(r.file) !== false) : ranked;
    const stale = S.governance.length ? ranked.filter((r) => knownApproved(r.file) === false) : [];

    // Reference configs published only in the official docs (bundled in
    // knowledge.js) — offered alongside repo files, same approval filter,
    // repo file wins for the same model + GPU class.
    const gpuName = gpus.length ? gpus[0].name.toUpperCase() : "";
    const myCount = gpus.length;
    const repoKeys = new Set(repoRows.map((r) => r.model + "|" + r.gpuClass));
    const curated = (S.K.curatedConfigs || [])
      .filter((c) => approvedIds.has(c.model) && !repoKeys.has(c.model + "|" + c.gpuClass))
      .map((c, i) => ({
        ...c, idx: i,
        classOk: !!gpuName && gpuName.includes(c.gpuClass),
        matchesGpu: !!gpuName && gpuName.includes(c.gpuClass) && c.gpuCount === myCount
      }));

    // A config only fits if the GPU class AND the GPU count match. Matching on
    // class alone was misleading: e.g. the Kimi H200 config needs 8 GPUs, so
    // it "matched" a 2× H200 box it cannot actually run.
    const fileCount = new Map(repoRows.map((r) => [r.file, r.gpuCount]));
    // Authoritative class for each repo config, read from the file itself.
    const fileClass = new Map(repoRows.map((r) => [r.file, r.gpuClass]));
    const fitDetail = (cls, need) => {
      const classOk = !!gpuName && !!cls && gpuName.includes(cls);
      if (!classOk) return { ok: false, text: t("Different GPU class — pick only if you know why") };
      if (!need || !myCount) return { ok: true, text: t("Matches your GPU class") };
      if (need === myCount) return { ok: true, text: t("Fits your machine — {n}× {cls}", { n: need, cls }) };
      return { ok: false, text: t("Needs {need}× {cls}, but this machine has {have} — won't run here", { need, cls, have: myCount }) };
    };

    const item = (attr, key, matches, label, detail, extra = "") => {
      const sel = S.chosenConfigFile === label;
      return `
      <div class="check-item ${sel ? "selected" : ""}" style="cursor:pointer" ${attr}="${esc(key)}">
        <span class="check-icon ${sel ? "sel" : matches ? "pass" : ""}">${sel ? "●" : "○"}</span>
        <div class="check-body">
          <div class="c-label">${esc(label)}${sel ? ' <span class="sel-tag">✓ selected</span>' : ""}</div>
          <div class="c-detail">${detail}${extra}</div>
        </div>
      </div>`;
    };

    $("#model-card").innerHTML = `
      <p>${gpuLine}</p>${gov}
      ${shown.length === 0 && curated.length === 0 ? `<div class="warn-banner">No reference configs for a currently approved model were found. You can paste a node-config.json manually below.</div>` : ""}
      <div>${shown.map((r) => {
        const fit = fitDetail(fileClass.get(r.file) || r.gpuClass, fileCount.get(r.file));
        return item("data-cfg", r.file, fit.ok, r.file, fit.text);
      }).join("")}
      ${curated.map((c) => {
        const fit = fitDetail(c.gpuClass, c.gpuCount);
        return item("data-curated", String(c.idx), fit.ok, c.label,
          `${fit.text} · ${t("from the official Gonka docs")}`);
      }).join("")}
      </div>
      ${stale.length ? `
        <hr class="sep">
        <p class="small">Hidden from the list above — these reference a model that isn't on the current approved-models
          list, so deploying them would run a model the network won't score for Proof of Compute:
          ${stale.map((r) => `<code>${esc(r.file)}</code>`).join(", ")}.</p>` : ""}
      <hr class="sep">
      ${S.chosenConfigFile
        ? `<div class="info-banner">Selected configuration: <b>${esc(S.chosenConfigFile)}</b></div>`
        : `<p class="small">Nothing selected yet — click a configuration above.</p>`}
      <h3>Configuration preview (editable)</h3>
      <p class="hint">Advanced users can tweak vLLM arguments here. Most people should leave it as generated.</p>
      <div id="cfg-note"></div>
      <textarea id="f-nodecfg" class="mono" rows="14" spellcheck="false">${esc(S.nodeConfigText)}</textarea>`;
    document.querySelectorAll("[data-cfg]").forEach((el) => {
      el.onclick = async () => {
        try {
          setBusy(true, "Loading config…");
          const text = await api("readRepoFile", { rel: el.dataset.cfg });
          S.chosenConfigFile = el.dataset.cfg;
          S.nodeConfigText = text;
          S.models = await api("modelsIn", { jsonText: text });
          paint(ranked, repoRows);
          $("#b-next").disabled = false;
        } catch (e) { alert(e.message); }
        finally { setBusy(false); }
      };
    });
    document.querySelectorAll("[data-curated]").forEach((el) => {
      el.onclick = async () => {
        const c = curated.find((x) => String(x.idx) === el.dataset.curated);
        if (!c) return;
        S.chosenConfigFile = c.label;
        S.nodeConfigText = JSON.stringify(c.nodeConfig, null, 4);
        try { S.models = await api("modelsIn", { jsonText: S.nodeConfigText }); } catch (_) { S.models = [c.model]; }
        paint(ranked, repoRows);
        if (c.note) $("#cfg-note").innerHTML = `<div class="info-banner">${esc(c.note)}</div>`;
        $("#b-next").disabled = false;
      };
    });
    const ta = $("#f-nodecfg");
    ta.onchange = async () => {
      S.nodeConfigText = ta.value;
      try { S.models = await api("modelsIn", { jsonText: ta.value }); } catch (_) {}
      $("#b-next").disabled = !S.nodeConfigText.trim();
      if (S.nodeConfigText.trim() && !S.chosenConfigFile) S.chosenConfigFile = "(custom)";
    };
  }
};

/* --- 7 Review ------------------------------------------------------- */
RENDER.review = () => {
  stage(`
    ${header("Step 8", "Review and write the configuration", `
      This is exactly what the wizard will place on your server. The security hardening
      (locking internal ports to localhost) is applied automatically.`)}
    <div class="card"><h3>config.env</h3><pre class="preview mono" id="pv-env">generating…</pre></div>
    <div class="card"><h3>node-config.json</h3><pre class="preview mono" id="pv-node">${esc(S.nodeConfigText)}</pre>
      <p class="small">Models in this config: ${S.models.map((m) => `<code>${esc(m)}</code>`).join(", ") || "—"}</p></div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-write">Write to server & continue</button>
    </div>`);
  $("#b-back").onclick = () => go(6);

  let envText = "";
  (async () => {
    // Never invent a new KEY_NAME if the server already has one: a different
    // name means a SECOND operational key gets created and the first is
    // orphaned. Prefer, in order: what's on the server → this session → new.
    if (!S.serverKeyName) {
      try {
        const existing = await api("serverKeyName");
        if (existing) {
          S.serverKeyName = existing;
          logLine(`\nReusing the server's existing operational key name: ${existing}\n`);
        }
      } catch (_) {}
    }
    const answers = {
      keyName: S.serverKeyName || ("node-" + Math.floor(100000 + Math.random() * 900000)),
      keyringPassword: S.wallet.passphrase,   // reuse — one passphrase to remember
      mode: S.net.scheme,
      host: S.net.host,
      accountPubkey: S.wallet.pubkey,
      ssl: S.net.scheme === "https" ? {
        method: "auto", domain: S.net.domain, email: S.net.email,
        dnsProviderId: S.net.dnsProviderId, dnsEnv: S.net.dnsEnv, jwtSecret: S.net.jwtSecret
      } : undefined
    };
    if (!S.serverKeyName) S.serverKeyName = answers.keyName; else answers.keyName = S.serverKeyName;
    let template = "";
    try { template = await api("readRepoFile", { rel: "config.env.template" }); } catch (_) {}
    envText = await api("genEnv", { answers, templateText: template });
    S.configEnvText = envText;
    // Hide the passphrase in the preview only.
    $("#pv-env").textContent = envText.replace(/(KEYRING_PASSWORD=)[^\s#]+/, "$1••••••••");
  })();

  $("#b-write").onclick = async () => {
    if (!S.configEnvText) return;
    try {
      setBusy(true, "Hardening ports & writing configuration…");
      await api("hardenPorts");
      await api("writeConfigs", { configEnv: S.configEnvText, nodeConfigJson: S.nodeConfigText });
      toast("Configuration written to the server.");
      markDone(); go(8);
    } catch (e) { markError(); alert(e.message); }
    finally { setBusy(false); }
  };
};

/* --- 8 Weights ------------------------------------------------------- */
RENDER.weights = () => {
  stage(`
    ${header("Step 9", "Download model weights", `
      Your node needs the model files (hundreds of GB) before it can serve inference.
      This is the longest step — you can leave it running.`)}
    <div class="card">
      <p>Models to download: ${S.models.map((m) => `<code>${esc(m)}</code>`).join(", ") || "<i>none detected</i>"}</p>
      <p class="hint">Downloads go to the server's shared cache and resume automatically if interrupted.</p>
    </div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-dl" ${S.models.length ? "" : "disabled"}>${S.weightsDone ? "Download again" : "Start download"}</button>
      <span class="spacer"></span>
      <button id="b-skip">${S.weightsDone ? "Continue" : "Skip for now"}</button>
    </div>`);
  $("#b-back").onclick = () => go(7);
  $("#b-skip").onclick = () => { markDone(); go(9); };
  $("#b-dl").onclick = async () => {
    try {
      setBusy(true, "Downloading model weights…");
      $("#b-dl").disabled = true;
      await api("downloadWeights", { models: S.models });
      S.weightsDone = true;
      toast("All model weights downloaded.");
      markDone(); RENDER.weights();
    } catch (e) { markError(); alert(e.message); $("#b-dl").disabled = false; }
    finally { setBusy(false); }
  };
};

/* --- 9 Deploy -------------------------------------------------------- */
RENDER.deploy = () => {
  const tasks = [
    { id: "pull",    label: "Download Gonka software (Docker images)" },
    { id: "core",    label: "Start the blockchain core (tmkms + chain node)" },
    { id: "warm",    label: "Create the server's operational key" },
    { id: "register",label: "Register your host on the network" },
    { id: "grant",   label: "Grant permissions (signed on this computer)" },
    { id: "launch",  label: "Launch the full node (API + ML node)" }
  ];
  stage(`
    ${header("Step 10", "Launch and register", `
      The wizard now runs the official launch sequence, in the exact order Gonka requires.
      Watch the activity log below for details.`)}
    <div class="card">${tasks.map((tk) => `
      <div class="task" id="task-${tk.id}">
        <span class="t-led"></span><span class="t-label">${esc(t(tk.label))}</span><span class="t-note"></span>
      </div>`).join("")}</div>
    <div id="deploy-extra"></div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button class="primary" id="b-run">Run launch sequence</button>
      <span class="spacer"></span>
      <button id="b-next" ${S.launched ? "" : "disabled"}>Continue</button>
    </div>`);
  $("#b-back").onclick = () => go(8);
  $("#b-next").onclick = () => { markDone(); go(10); };   // -> Collateral
  if (S.launched) tasks.forEach((tk) => set(tk.id, "done"));

  function set(id, cls, note) {
    const el = $("#task-" + id);
    el.className = "task " + cls;
    if (note !== undefined) el.querySelector(".t-note").textContent = note;
  }

  $("#b-run").onclick = async () => {
    $("#b-run").disabled = true;
    try {
      setBusy(true, "Checking image compatibility…");
      set("pull", "running");
      // Fail fast on an architecture mismatch instead of pulling gigabytes and
      // then dying — or worse, starting a chain node that immediately exits.
      try {
        const pre = await api("archPreflight");
        if (pre && pre.bad && pre.bad.length) {
          const list = pre.bad.map((b) => `• ${b.image} — published for: ${b.archs.join(", ")}`).join("\n");
          throw new Error(
            `This server is ${pre.arch}, but Gonka hasn't published ${pre.arch} builds of the images this ` +
            `release needs:\n\n${list}\n\n` +
            `That's an upstream packaging problem, not something this wizard can work around — the node ` +
            `cannot run here until those images are published for ${pre.arch}. Ask in the Gonka Discord ` +
            `whether an ${pre.arch} build is available or coming.`);
        }
      } catch (e) {
        if (/hasn't published/.test(e.message)) throw e;   // real mismatch
        // otherwise the check itself failed (offline etc.) — carry on
      }
      setBusy(true, "Pulling Docker images…");
      await api("pull");
      set("pull", "done");

      setBusy(true, "Starting core services…");
      set("core", "running");
      await api("startCore");
      set("core", "done");

      setBusy(true, "Creating operational key…");
      set("warm", "running");
      const warm = await api("createWarmKey");
      S.warm = warm;
      set("warm", "done", warm.existed ? "already existed — kept" : "created");
      if (!warm.existed && warm.mnemonic) {
        await warmMnemonicNotice(warm);
      }

      setBusy(true, "Registering your host…");
      set("register", "running");
      // Sign the registration with the user's own wallet. Fully automatic —
      // no button, no question.
      const walletRegister = async () => {
        set("register", "running", "signing with your wallet");
        const consensusKey = await api("getConsensusKey");
        const publicUrl = (S.net.scheme === "https" ? "https://" : "http://") + S.net.host + ":" + (S.net.scheme === "https" ? 8443 : 8000);
        await api("manualRegister", {
          keyName: S.wallet.name, passphrase: S.wallet.passphrase,
          publicUrl, consensusKey, seedApiUrl: S.seed || S.K.seedNodes[0], chainId: S.K.chainId
        });
      };
      // Is the record REALLY on the chain? The seed answers 200 "successful"
      // even when it creates nothing, so only the chain itself counts.
      const wantUrl = (S.net.scheme === "https" ? "https://" : "http://") + S.net.host +
        ":" + (S.net.scheme === "https" ? 8443 : 8000);
      const onChain = async (tries, delayMs) => {
        for (let i = 0; i < tries; i++) {
          try {
            const p = await api("participant", { seed: S.seed || S.K.seedNodes[0], address: S.wallet.address });
            const pd = p && (p.participant || p);
            // Must point at THIS server: on a re-run from a new machine an old
            // record still exists, and accepting it would leave the network
            // sending work to the previous address.
            const url = pd && (pd.inferenceUrl || pd.inference_url);
            if (pd && (pd.address || pd.status) && (!url || url === wantUrl)) return true;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return false;
      };
      const reg = await api("registerHost");
      if (!reg.ok && !reg.needsManualFallback) {
        throw new Error("Registration failed. Log tail:\n" + reg.output.slice(-500));
      }
      if (reg.needsManualFallback) {
        toast("Standard registration hit a known edge case — signing with your wallet instead (automatic).");
        await walletRegister();
      }
      if (await onChain(5, 5000)) {
        set("register", "done", reg.alreadyRegistered ? "was already registered" : "confirmed on-chain");
        S.registered = true;
      } else if (!reg.needsManualFallback) {
        // Seed said yes, chain says no — do it ourselves, then re-verify.
        toast("The network reported success but no record appeared — registering with your wallet instead (automatic)…");
        await walletRegister();
        if (await onChain(6, 5000)) {
          set("register", "done", "confirmed on-chain (signed with your wallet)");
          S.registered = true;
        } else {
          throw new Error("Registration was submitted twice (seed + your wallet) but the chain still doesn't show your participant record. Check the activity log for the transaction output.");
        }
      } else {
        throw new Error("Registration was signed and sent, but the chain doesn't show your participant record yet. Press \"Run launch sequence\" again in a minute — it skips everything already done.");
      }

      setBusy(true, "Granting permissions with your wallet…");
      set("grant", "running");
      await api("grant", {
        keyName: S.wallet.name, passphrase: S.wallet.passphrase,
        warmAddress: S.warm.address, seedApiUrl: S.seed || S.K.seedNodes[0],
        granterAddress: S.wallet.address
      });
      set("grant", "done");
      S.granted = true;

      setBusy(true, "Launching the full node…");
      set("launch", "running");
      await api("launchAll");
      set("launch", "done");
      S.launched = true;
      $("#b-next").disabled = false;
      markDone();
      toast("Node launched. Continue to verification.");
    } catch (e) {
      markError();
      const running = document.querySelector(".task.running");
      if (running) running.className = "task err";
      alert(e.message);
      $("#b-run").disabled = false;
    } finally { setBusy(false); }
  };

  function warmMnemonicNotice(warm) {
    return new Promise((resolve) => {
      $("#deploy-extra").innerHTML = `
        <div class="card">
          <h3>Server key backup phrase</h3>
          <p class="hint">The server got its own small operational key (address <code>${esc(warm.address)}</code>).
          Its recovery phrase is below — write it down too, then continue. It will not be shown again.</p>
          <div class="mnemonic-box">${warm.mnemonic.split(/\s+/).map((w, i) =>
            `<span class="word"><span class="idx">${i + 1}</span>${esc(w)}</span>`).join("")}</div>
          <div class="btn-row"><button class="primary" id="b-warm-ok">I wrote it down — continue</button></div>
        </div>`;
      $("#b-warm-ok").onclick = () => { $("#deploy-extra").innerHTML = ""; resolve(); };
    });
  }
};

/* --- 10 Verify ------------------------------------------------------- */
RENDER.verify = () => {
  if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; }
  stage(`
    ${header("Step 12", "Setup is done — now it just runs", `
      Everything is installed, configured and registered. Nothing below needs
      you to do anything: this page watches your node until it is fully ready
      and tells you exactly what it is doing.`)}
    <div class="info-banner">
      ${t("<b>You can leave this running and walk away.</b> The steps below finish on their own — the slow one is the network snapshot, which can take up to an hour. Your node only needs to stay switched on.")}
    </div>
    <div class="card">
      <h3>${t("This is you on the network")}</h3>
      <p class="small">${t("Your wallet address is your identity everywhere on Gonka. On every dashboard and list, this is the name to look for:")}</p>
      <pre class="preview mono" style="user-select:text; word-break:break-all; font-size:15px">${esc(S.wallet.address || "—")}</pre>
      <div class="btn-row">
        <button id="b-copy-addr">${t("Copy address")}</button>
        <button id="b-dash-gg">${t("gonka.gg dashboard")}</button>
        <button id="b-dash-orig">${t("original network dashboard")}</button>
      </div>
      <p class="small">${t("Both dashboards list every participant — search for your address there. gonka.gg is community-run and usually the quickest to update; the original dashboard is the network's own.")}</p>
    </div>
    <div class="card" id="v-card"><span class="small">${t("Checking…")}</span></div>
    <div class="card">
      <h3>${t("What each line above means")}</h3>
      <ul class="plain">
        <li><b>${t("Network snapshot")}</b> — ${t("your node copies a recent picture of the blockchain instead of replaying years of history. The slowest part, and it pauses near the end while it saves everything to disk. That pause is normal.")}</li>
        <li><b>${t("Catching up")}</b> — ${t("replaying the last few thousand blocks to reach the network's current position. Usually a minute or two.")}</li>
        <li><b>${t("Registered")}</b> — ${t("your wallet address is recorded on the chain as this server. Already done.")}</li>
        <li><b>${t("Proof of Compute")}</b> — ${t("about every 24 hours the network asks every node to prove its GPUs work. This is what earns your weight. The countdown at the top of the window shows when the next one starts.")}</li>
        <li><b>${t("Earning")}</b> — ${t("once a round is passed your node joins the active list and is paid for the work it does. Rewards are settled at the end of each roughly 24-hour epoch.")}</li>
      </ul>
      <p class="small">${t("Keep the server switched on. If you stop it, your node drops out and has to catch up again — and it earns nothing while it is off.")}</p>
    </div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button id="b-re">Check again</button>
      <span class="spacer"></span>
      <button class="primary" id="b-next">Continue</button>
    </div>`);
  $("#b-back").onclick = () => { if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; } go(10); };
  $("#b-next").onclick = () => { if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; } markDone(); go(12); };
  $("#b-re").onclick = check;
  $("#b-copy-addr").onclick = () => { navigator.clipboard.writeText(S.wallet.address || ""); toast(t("Address copied.")); };
  $("#b-dash-gg").onclick = () => api("openExternal", { url: S.K.docs.communityDashboard });
  $("#b-dash-orig").onclick = () => api("openExternal", { url: (S.seed || S.K.seedNodes[0]) + "/dashboard/gonka/validator" });
  check();

  // Live sync meter: a fresh node must catch up with the chain before its API
  // can start — and registration only lands once the API is up. Showing the
  // node crawling toward the network tip (with an ETA) turns a silent
  // 30-60 minute wait into something a person can actually watch.
  let lastSample = null;

  /**
   * Register by signing the transaction with the cold wallet on this computer,
   * instead of asking the seed node to do it. The seed's /v1/participants
   * returns 200 "registration successful" even in cases where no participant
   * record is ever created, so this is the reliable path when the record
   * doesn't show up on-chain.
   */
  async function selfRegister() {
    if (S.selfRegTried || !S.connected) return;
    if (!S.wallet.passphrase || !S.wallet.name) {
      logLine("\n" + t("Can't self-register: the wallet is locked. Go back to the Wallet step and re-enter your passphrase.") + "\n", "stderr");
      return;
    }
    S.selfRegTried = true;
    try {
      setBusy(true, "Registering with your own wallet…");
      toast(t("The seed node reported success but no record appeared — signing the registration with your wallet instead…"));
      const consensusKey = await api("getConsensusKey");
      const publicUrl = (S.net.scheme === "https" ? "https://" : "http://") + S.net.host +
        ":" + (S.net.scheme === "https" ? 8443 : 8000);
      await api("manualRegister", {
        keyName: S.wallet.name, passphrase: S.wallet.passphrase,
        publicUrl, consensusKey, seedApiUrl: S.seed || S.K.seedNodes[0], chainId: S.K.chainId
      });
      toast(t("Registration transaction sent from your wallet."));
      setTimeout(check, 6000);
    } catch (e) {
      logLine("\n" + t("Self-registration failed") + ": " + e.message + "\n", "stderr");
    } finally { setBusy(false); }
  }

  function startSyncMeter() {
    if (S.syncPoll) return;
    const tick = async () => {
      const el = $("#sync-meter");
      if (!el) { clearInterval(S.syncPoll); S.syncPoll = null; return; }
      try {
        const [local, net] = await Promise.all([
          api("nodeSync"),
          api("chainHeight", { seed: S.seed || S.K.seedNodes[0] })
        ]);
        const now = Date.now();
        const sn = local.snapshot;
        // Remember the snapshot facts — once block sync starts the log line is
        // gone, but the finished step should still show what it accomplished.
        if (sn && sn.total) S.snapDone = { total: sn.total, atHeight: sn.atHeight };

        // Palette comes from the stylesheet so the meter can never drift from
        // the rest of the UI (greyscale for progress, colour only for status).
        const bar = (pct, colour = "var(--accent)") => `
          <div style="background:var(--wash-strong); border-radius:6px; height:12px; overflow:hidden; margin:6px 0">
            <div style="background:${colour}; height:100%; width:${pct}%"></div>
          </div>`;
        const eta = (remaining, perSec) => {
          if (!(perSec > 0)) return "";
          const secs = remaining / perSec;
          const h = Math.floor(secs / 3600), m2 = Math.round((secs % 3600) / 60);
          return ` · ${t("about {eta} left", { eta: h ? `${h}h ${m2}m` : `${m2}m` })}`;
        };
        // One row per stage: done / active / waiting — so it's always obvious
        // what finished and what is happening now.
        const row = (state, title, detail) => {
          const icon = state === "done" ? "✓" : state === "active" ? "●" : "○";
          const colour = state === "done" ? "var(--green)" : state === "active" ? "var(--accent)" : "var(--muted)";
          return `
            <div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid var(--line)">
              <span style="color:${colour}; font-weight:700; line-height:1.4">${icon}</span>
              <div style="flex:1; min-width:0">
                <div style="${state === "waiting" ? "opacity:.55" : ""}">${title}</div>
                ${detail ? `<div class="small">${detail}</div>` : ""}
              </div>
            </div>`;
        };

        const inSnapshot = local.height === 0;
        const behind = inSnapshot ? null : Math.max(0, net.height - local.height);
        const synced = !inSnapshot && (!local.catchingUp || behind < 20);

        /* --- stage 1: snapshot --- */
        let s1;
        if (inSnapshot && sn && sn.total) {
          const pct = Math.min(99.9, (sn.chunk / sn.total) * 100);
          let e = "";
          if (lastSample && lastSample.chunk != null && sn.chunk > lastSample.chunk) {
            e = eta(sn.total - sn.chunk, (sn.chunk - lastSample.chunk) / ((now - lastSample.t) / 1000));
          }
          lastSample = { chunk: sn.chunk, t: now };
          // The final piece writes the whole restored state to disk and can sit
          // at ~99% for many minutes — say so, or it reads as a freeze.
          const finishing = sn.chunk >= sn.total - 2;
          s1 = row("active", t("Downloading the network snapshot"),
            bar(pct) + `<span class="mono">${pct.toFixed(1)}% · ${t("piece")} ${sn.chunk.toLocaleString()} / ${sn.total.toLocaleString()}${e}</span>` +
            (finishing ? `<br>${t("Saving the last piece — this one writes the whole snapshot to disk and can take several minutes. It hasn't stalled.")}` : ""));
        } else if (inSnapshot) {
          s1 = row("active", t("Looking for a network snapshot"), t("Your node is starting up and finding peers."));
        } else {
          s1 = row("done", t("Network snapshot downloaded"),
            S.snapDone
              ? t("{n} pieces · snapshot of block {h}", { n: S.snapDone.total.toLocaleString(), h: S.snapDone.atHeight.toLocaleString() })
              : t("Complete"));
        }

        /* --- stage 2: catching up --- */
        let s2;
        if (inSnapshot) {
          s2 = row("waiting", t("Catching up with the network"), "");
        } else if (synced) {
          s2 = row("done", t("Caught up with the network"),
            t("Block {h} — level with the network", { h: local.height.toLocaleString() }));
        } else {
          let e = "";
          if (lastSample && lastSample.h != null && local.height > lastSample.h) {
            const rate = (local.height - lastSample.h) / ((now - lastSample.t) / 1000);
            e = eta(behind, rate - 1 / 5.3);   // the network keeps moving too
          }
          lastSample = { h: local.height, t: now };
          const pct = Math.min(99.9, (local.height / net.height) * 100);
          s2 = row("active", t("Catching up with the network"),
            bar(pct) + `<span class="mono">${t("your node")}: ${local.height.toLocaleString()} / ${t("network")}: ${net.height.toLocaleString()} · ${behind.toLocaleString()} ${t("blocks behind")}${e}</span>`);
        }

        /* --- stage 3: registration --- */
        const s3 = S.registeredVisible
          ? row("done", t("Registered on the chain"), t("Your address is on the network."))
          : row(synced ? "active" : "waiting", t("Registering your node on the chain"),
              synced ? t("Submitting automatically — no action needed.") : "");

        /* --- stages 4 & 5: doing the work, and being paid for it ---
           Two different things, so two lines. The chain can say "registered
           and synced" while the ML side can't actually serve Proof of Compute
           (that gap cost two windows); and the GPUs can be working hard while
           the node still has no weight and earns nothing. */
        let s4 = row("waiting", t("Proof of Compute"), "");
        let s5 = row("waiting", t("Earning"), "");
        try {
          const [ml, epochList] = await Promise.all([
            api("mlnode"),
            api("epochParticipants", { seed: S.seed || S.K.seedNodes[0] }).catch(() => null)
          ]);
          // Membership in the CURRENT EPOCH's active set is what "earning"
          // means. The participant record's `weight` field stays -1 forever —
          // it is not the epoch weight, and reading it reports a node that
          // passed Proof of Compute as though it had earned nothing.
          // Also note the set is only finalised after the PoC *validation*
          // phase (~21 min after the compute window), so a node can look
          // absent for a while and still be admitted.
          const listStr = epochList ? JSON.stringify(epochList) : "";
          const earning = !!(S.wallet.address && listStr.includes(S.wallet.address));

          if (ml && !ml.noContainer && !ml.unknown) {
            const gpuOk = ml.gpuTotal > 0 && ml.gpuReady === ml.gpuTotal;
            const bits = [];
            if (ml.gpuTotal) bits.push(t("{ready} of {total} GPUs available", { ready: ml.gpuReady, total: ml.gpuTotal }));
            bits.push(ml.weightsReady ? t("model weights ready") : t("model weights still downloading"));

            if (ml.state === "POW") {
              s4 = row("active", t("Proof of Compute is running RIGHT NOW"),
                t("Your GPUs are computing proofs — this is the work that earns your weight. Leave the server running; this line turns green when the round finishes.")
                + `<br><span class="mono">${bits.join(" · ")}</span>`);
            } else if (earning) {
              s4 = row("done", t("Proof of Compute completed"),
                t("Your node passed and was given weight for this epoch.") + `<br><span class="mono">${bits.join(" · ")}</span>`);
            } else if (gpuOk && ml.weightsReady) {
              s4 = row(synced ? "done" : "waiting", t("Ready for Proof of Compute"),
                bits.join(" · ") + " · " + t("waiting for the next round — see the countdown at the top"));
            } else {
              s4 = row("active", t("Preparing to serve Proof of Compute"), bits.join(" · "));
            }
          }

          if (earning) {
            s5 = row("done", t("Earning"),
              t("Your node is in this epoch's active set — it passed Proof of Compute and is being paid for the work it does. Rewards settle at the end of the epoch, so keep the server running until then."));
          } else if (S.registeredVisible) {
            s5 = row("waiting", t("Earning"),
              t("Not yet. Your node joins the active set after a completed Proof of Compute round — that list is finalised about 20 minutes after the round ends, so this can take a while to turn green."));
          }
        } catch (_) { /* never block the meter on these probes */ }

        el.innerHTML = s1 + s2 + s3 + s4 + s5;

        if (synced) {
          // Keep polling once synced — stage 4 is the interesting one from here
          // (it shows the ML node picking up Proof of Compute work). The tick
          // stops itself when the user navigates away.
          // Synced but still invisible → the earlier registration attempt ran
          // while the API couldn't start. Submit it again, once, automatically.
          if (!S.registeredVisible && !S.autoRegTried && S.connected) {
            S.autoRegTried = true;
            toast(t("Node is synced — submitting your registration again automatically…"));
            try { await api("registerHost"); } catch (e2) { logLine("\n" + e2.message + "\n", "stderr"); }
            setTimeout(check, 4000);
            // The seed answers 200 even when no participant is created, so a
            // successful HTTP call proves nothing. If the record still isn't
            // on-chain shortly after, sign the registration ourselves.
            setTimeout(() => { if (!S.registeredVisible) selfRegister(); }, 25000);
          }
        }
      } catch (e) {
        el.innerHTML = `<p class="small">${t("Can't read the node's sync state")} (${esc(e.message)})</p>`;
      }
    };
    tick();
    S.syncPoll = setInterval(tick, 10000);
  }

  async function check() {
    const card = $("#v-card");
    card.innerHTML = '<span class="small">Checking…</span>';
    try {
      if (!S.seed) S.seed = await api("seed");
      const p = await api("participant", { seed: S.seed, address: S.wallet.address });
      const containers = await api("containers").catch(() => "");

      // Outside-in port test: this app runs on the user's computer, which is
      // outside the server's network — so an HTTP response from the public
      // URL genuinely proves the provider firewall / port mapping is open.
      let reachHtml = "";
      if (S.net.host) {
        const publicUrl = (S.net.scheme === "https" ? "https://" : "http://") + S.net.host +
          ":" + (S.net.scheme === "https" ? 8443 : 8000);
        const probe = await api("probe", { url: publicUrl }).catch(() => null);
        reachHtml = probe && probe.reachable
          ? `<p><span class="pill ok">PORT OPEN</span> <span class="small">Your node answers from the internet at <code>${esc(publicUrl)}</code>.</span></p>`
          : `<p><span class="pill warn">NOT REACHABLE</span> <span class="small">Nothing answered at <code>${esc(publicUrl)}</code> from the outside.
              If the containers below are running, the port is being blocked — open TCP ${S.net.scheme === "https" ? 8443 : 8000} and 5000
              in your provider's dashboard (port mappings / firewall / security group), then press "Check again".</span></p>`;
      }

      const pd = p && (p.participant || p);
      // A record can exist yet point at a PREVIOUS server. Re-registering the
      // same wallet updates the URL in place (chain-side SubmitNewParticipant
      // overwrites Url/ValidatorKey for an existing participant), so the test
      // that matters is "does the chain point at THIS machine", not "does a
      // record exist". Without this, moving to a new box shows REGISTERED
      // while the network still sends work to the old, dead address.
      const wantUrl = S.net.host
        ? (S.net.scheme === "https" ? "https://" : "http://") + S.net.host +
          ":" + (S.net.scheme === "https" ? 8443 : 8000)
        : null;
      const chainUrl = pd && (pd.inferenceUrl || pd.inference_url);
      const urlStale = !!(wantUrl && chainUrl && chainUrl !== wantUrl);
      if (pd && (pd.address || pd.status) && !urlStale) {
        S.registeredVisible = true;
        card.innerHTML = `
          <p><span class="pill ok">REGISTERED</span> <span class="small">${t("Your address is on the chain — the dashboards above will show it.")}</span></p>
          ${reachHtml}
          <div class="kv">address&nbsp;&nbsp;&nbsp;&nbsp; <b>${esc(pd.address || S.wallet.address)}</b></div>
          <div class="kv">inference url <b>${esc(pd.inferenceUrl || pd.inference_url || "—")}</b></div>
          <div class="kv">status&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>${esc(pd.status || "—")}</b></div>
          <hr class="sep">
          <p class="small">${t("Registering no longer waits for the node to finish syncing, so keep watching this until every line is ticked — your node can only take part in Proof of Compute once it's caught up.")}</p>
          <div id="sync-meter"><span class="small">${t("Reading your node's sync state…")}</span></div>
          <p class="small" style="margin-top:12px">Containers on the server:</p>
          <pre class="preview mono" style="max-height:140px">${esc(containers || "(couldn't read)")}</pre>`;
        markDone();
        // Registration can now land BEFORE the node is synced (the wizard signs
        // it with the cold wallet, which needs no local node). So the progress
        // meter has to keep running after REGISTERED — otherwise the page looks
        // finished while the node is still restoring a snapshot.
        startSyncMeter();
      } else {
        card.innerHTML = `
          <p><span class="pill warn">${urlStale ? t("POINTING AT YOUR OLD SERVER") : t("NOT VISIBLE YET")}</span></p>
          ${reachHtml}
          <p class="small">${urlStale
            ? t("Your wallet is already registered, but the network still has the address of a previous server ({old}). It needs to be updated to this one ({new}) — the wizard does that automatically; no new wallet is needed and you keep your existing record.",
                { old: `<code>${esc(chainUrl)}</code>`, new: `<code>${esc(wantUrl)}</code>` })
            : t("Your participant record isn't on the chain yet. The usual reason: a brand-new node first has to catch up with the network before it can register — watch it happen below.")}</p>
          <div id="sync-meter"><span class="small">${t("Reading your node's sync state…")}</span></div>`;
        startSyncMeter();
      }
    } catch (e) {
      card.innerHTML = `<span class="pill err">CHECK FAILED</span> <span class="small">${esc(e.message)}</span>`;
    }
  }
};

/* --- 11 Collateral ---------------------------------------------------- */
RENDER.collateral = () => {
  stage(`
    ${header("Step 11", "Collateral — unlock full rewards", `
      Collateral is GNK you lock up as a stake to unlock your node's full earning power.
      It's held in your name and withdrawable later — but it can be slashed if your node misbehaves.
      Read how it works below before deciding.`)}
    <div class="card">
      <h3>${esc(t("How collateral works"))}</h3>
      <ul class="plain small">
        <li>${t("Your Proof of Compute earns your node a <b>weight</b> (based on your GPUs' work). Without collateral, the network only counts <b>20%</b> of that weight — so you collect about a fifth of what your hardware actually earned.")}</li>
        <li>${t("Depositing collateral unlocks the other <b>80%</b>, scaling you up toward the full 100%. Same GPUs, up to 5× the rewards.")}</li>
        <li>${t("The rate is <b>4.2 ngonka per unit of weight</b> — and a ngonka is a billionth of a GNK, so the amounts involved are tiny. A node earning several hundred weight needs a few thousand ngonka, i.e. small fractions of one GNK. The exact figure is calculated for you below.")}</li>
        <li>${t("Your collateral is <b>not spent</b> — it's locked in your name and you can withdraw it later (after a short unbonding wait).")}</li>
        <li>${t("<b>Partial deposits work.</b> You don't have to unlock everything at once — the network scales your weight in proportion to what you stake. Deposit half of the full amount and you land around 60% of your potential; deposit a third and you're near 47%. You can add more later at any time. (Staking beyond the full-unlock amount does nothing extra for weight.)")}</li>
        <li>${t("<b>But it can be slashed:</b> the network takes <b>20%</b> of your collateral if your node submits invalid inference work, and <b>10%</b> for excessive downtime. A healthy, honest, reliably-online node keeps it all; a flaky or cheating one loses a chunk. So only stake what you're comfortable backing your node's good behavior with.")}</li>
      </ul>
      <div class="info-banner">${t("<b>Simple example:</b> say your node would earn 100 GNK/day at full weight. With no collateral you'd get ~20 GNK/day. Stake enough collateral to unlock 100%, and you'd get ~100 GNK/day — 5× more — while your stake sits locked and refundable. Run it reliably and honestly, and you never lose the stake; the extra ~80 GNK/day is pure upside.")}</div>
    </div>
    <div id="col-body" style="margin-top:16px"></div>
    <p class="small" style="margin-top:14px">${t("Would rather wait and stake the exact amount for your real weight? {link} — you'd spend your first epoch at 20% and can come back tomorrow.",
      { link: `<a href="#" id="c-later">${t("See how")}</a>` })}</p>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <span class="spacer"></span>
      <button id="b-skip">Skip — I'll do this later</button>
      <button class="primary" id="b-next" style="display:none" id2="b-next">Continue</button>
    </div>`);
  $("#b-back").onclick = () => go(9);
  $("#b-skip").onclick = () => { markDone(); go(11); };
  const laterLink = $("#c-later");
  if (laterLink) laterLink.onclick = (e) => {
    e.preventDefault();
    alert(t("Skip the deposit for now and finish setup. After your first Proof of Compute (about 24 hours), reopen this app and come back to this step — it will then size the deposit from YOUR measured weight instead of the network maximum. You earn at 20% until you do."));
  };
  // No choice card: the deposit is the point of this step, so compute and show
  // it straight away. Waiting is a link, not an equal option.
  (async () => {
    const body = $("#col-body");
    body.innerHTML = '<div class="card"><span class="small">Reading live network parameters…</span></div>';
    try {
      if (!S.seed) S.seed = await api("seed");
      // If our own weight is already visible, prefer it (precise Option B).
      let myWeight = null;
      try {
        const ep = await api("epochParticipants", { seed: S.seed });
        const mine = (ep?.active_participants?.participants || []).find((p) => p.index === S.wallet.address || p.address === S.wallet.address);
        if (mine && Number(mine.weight) > 0) myWeight = Number(mine.weight);
      } catch (_) {}
      // Authoritative source: the epoch group's validation_weights. Collateral
      // must cover confirmation_weight (what PoC earned), not the post-ratio
      // weight — and not the network maximum, which is what this fell back to.
      try {
        const w = await api("myEpochWeight", { seed: S.seed, address: S.wallet.address });
        if (w && w.confirmationWeight > 0) myWeight = w.confirmationWeight;
      } catch (_) {}
      const rec = await api("recommendCollateral", { seed: S.seed, myWeight });
      const bal = await api("balance", { seed: S.seed, address: S.wallet.address });
      const enough = bal !== null && bal >= rec.depositNgonka;
      body.innerHTML = `
        <div class="card">
          <h3>${t("Unlock your full rewards")}</h3>
          <div class="info-banner">${t("This deposit is <b>{amt}</b> and it multiplies what your node earns by up to <b>5×</b>. It stays yours — locked, not spent — and you can withdraw it later. There is no sensible reason to skip it.",
            { amt: gnk(rec.depositNgonka) })}</div>
          <div class="kv">deposit <b>${gnk(rec.depositNgonka)}</b> <span class="small">(${rec.depositNgonka.toLocaleString()} ngonka)</span></div>
          <div class="kv">your balance <b>${bal === null ? "unknown" : gnk(bal)}</b>${bal !== null && bal > rec.depositNgonka ? ` <span class="small">${t("— {x}× more than you need", { x: Math.floor(bal / Math.max(1, rec.depositNgonka)).toLocaleString() })}</span>` : ""}</div>
          <p class="small">${t("Sized from {basis} ({w}) at the chain's live collateral rate, with a {b}× safety buffer.",
            { basis: myWeight ? t("your own measured weight") : t("the network's current maximum weight"),
              w: rec.weightUsed.toLocaleString(), b: rec.buffer })}</p>
          ${enough ? "" : `<div class="warn-banner">Your wallet balance looks lower than the recommended deposit.
            You can deposit a smaller amount now and top up later — deposits are cumulative.</div>`}
          <label class="field" style="margin-top:10px"><span class="lbl">Amount to deposit (in ngonka — 1 GNK = 1,000,000,000 ngonka)</span>
            <input type="text" id="f-amt" class="mono" value="${rec.depositNgonka}"></label>
          <p class="small" id="amt-gnk">= ${gnk(rec.depositNgonka)}</p>
          <div class="btn-row"><button class="primary" id="b-dep">${t("Deposit {amt} and unlock full rewards", { amt: gnk(rec.depositNgonka) })}</button></div>
        </div>`;
      // Live GNK echo, so nobody mis-reads how many zeros they just typed.
      $("#f-amt").oninput = () => {
        const raw = String($("#f-amt").value).replace(/[^\d]/g, "");
        const el = $("#amt-gnk");
        if (el) el.textContent = raw ? "= " + gnk(raw) : "";
      };
      $("#b-dep").onclick = async () => {
        const amt = String($("#f-amt").value).replace(/[^\d]/g, "");
        if (!amt || amt === "0") return alert("Enter an amount.");
        const yes = confirm(t("Deposit {n} as collateral?\n\nThis signs a transaction with your Account Key on this computer. You can withdraw unused collateral later (after an unbonding wait). Remember it can be slashed — 20% for invalid work, 10% for downtime — so keep your node reliable and honest.", { n: gnk(amt) }));
        if (!yes) return;
        try {
          setBusy(true, "Depositing collateral…");
          await api("deposit", {
            keyName: S.wallet.name, passphrase: S.wallet.passphrase,
            amountNgonka: amt, seedApiUrl: S.seed, chainId: S.K.chainId
          });
          // Only the chain counts. Poll until the collateral record exists —
          // a broadcast transaction still takes a block or two to land, and
          // claiming success without checking is how the last one slipped
          // through as "deposited" when nothing had happened.
          let onChain = null;
          for (let i = 0; i < 8 && !onChain; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const c = await api("collateralOf", { seed: S.seed, address: S.wallet.address }).catch(() => null);
            const amt = c && c.amount && Number(c.amount.amount);
            if (amt > 0) onChain = c;
          }
          if (!onChain) {
            body.innerHTML = `<div class="warn-banner">${t("The transaction was sent, but the chain still doesn't show any collateral for your wallet. Give it a minute and press Continue → Back to re-check, or try again. Nothing was lost — an unlanded deposit costs only the gas.")}</div>`;
            return;
          }
          body.innerHTML = `<div class="info-banner">${t("<b>Collateral confirmed on-chain: {amt}.</b> From the next Proof of Compute round your node earns at full weight instead of 20%.",
            { amt: gnk(onChain.amount.amount) })}</div>`;
          markDone();
          setTimeout(() => go(11), 1200);   // -> Verify, where the waiting happens
        } catch (e) { alert(e.message); }
        finally { setBusy(false); }
      };
    } catch (e) {
      body.innerHTML = `<div class="warn-banner">Couldn't compute a recommendation: ${esc(e.message)}. You can skip and deposit later.</div>`;
    }
  })();
};

/* --- 12 Done ---------------------------------------------------------- */
RENDER.done = () => {
  window.gonka.allowClose && window.gonka.allowClose();  // setup finished — no close-confirm needed
  S.setupFinished = true;
  stage(`
    ${header("Complete", "Your node is live", `
      Registration is done, permissions are granted, and your services are running.`)}
    <div class="card">
      <h3>${t("The only three things that matter from here")}</h3>
      <ul class="plain">
        <li><b>${t("Leave the server on.")}</b> ${t("Proof of Compute runs about every 24 hours and it is the only way to earn. A node that is switched off earns nothing and loses its place.")}</li>
        <li><b>${t("Keep your paper backup safe.")}</b> ${t("Those 24 words ARE your wallet and your earnings. This app never stored them, and nobody can recover them for you.")}</li>
        <li><b>${t("Never delete the {tmkms} folder on the server, and never re-create the operational key.", { tmkms: "<code>.tmkms</code>" })}</b> ${t("Both are unrecoverable and would cost you the node's identity.")}</li>
      </ul>
      <p class="small">${t("Check on it any time:")} <a href="#" id="d-part">${t("your participant page")}</a> · <a href="#" id="d-dash">${t("network dashboard")}</a>.</p>
    </div>
    <div class="card">
      <h3>Useful commands (on the server, in <code>gonka/deploy/join</code>)</h3>
      <pre class="preview mono"># watch logs
source config.env && docker compose -f docker-compose.yml -f docker-compose.mlnode.yml logs -f

# stop everything (read the "stopping your node" guide first!)
docker compose -f docker-compose.yml -f docker-compose.mlnode.yml down</pre>
      <p class="small">Before stopping for good, follow the graceful shutdown guide so you don't lose rewards or reputation — see the <a href="#" id="d-doc">official docs</a>.</p>
    </div>
    <div class="btn-row">
      <button id="b-back">Back</button>
      <button id="b-again">Set up another node</button>
    </div>`);
  $("#b-back").onclick = () => go(11);
  const seed = S.seed || S.K.seedNodes[0];
  $("#d-part").onclick = (e) => { e.preventDefault(); api("openExternal", { url: seed + S.K.api.participants + S.wallet.address }); };
  $("#d-dash").onclick = (e) => { e.preventDefault(); api("openExternal", { url: seed + "/dashboard/gonka/validator" }); };
  $("#d-doc").onclick = (e) => { e.preventDefault(); api("openExternal", { url: S.K.docs.quickstart }); };
  $("#b-again").onclick = () => location.reload();
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
function applyChrome() {
  document.documentElement.dir = window.I18N.lang() === "ar" ? "rtl" : "ltr";
  $("#t-sub").textContent = t("from zero to earning node");
  $("#t-needhelp").textContent = t("Need help?");
  $("#link-home").textContent = t("← All tools");
  if (!S.consoleBusy) $("#console-title").textContent = t("Activity log");
  renderVersionLine();
}

// Every static string in the stage is auto-translated by exact match on its
// text node, so templates don't need individual t() wrapping. Strings with
// embedded HTML (<b>, <code>) are wrapped with t() at the template instead.
// Code, logs, and editable content are never touched.
function translateShortStrings() {
  const walker = document.createTreeWalker($("#stage"), NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "PRE" || tag === "CODE" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE")
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const core = raw.replace(/\s+/g, " ").trim();
    if (!core) continue;
    const tr = window.I18N.maybe(core);
    if (tr && tr !== core) {
      n.nodeValue = (/^\s/.test(raw) ? " " : "") + tr + (/\s$/.test(raw) ? " " : "");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Home — The Gonka Network Onboarding Tool's tool picker. Gonka Host  */
/* Setup is the wizard above, unchanged; the other tools come later.   */
/* ------------------------------------------------------------------ */
const APP_NAME = "The Gonka Network Onboarding Tool";

const languageOptions = () => window.I18N.langs.map((l) =>
  `<option value="${l.id}" ${l.id === window.I18N.lang() ? "selected" : ""}>${l.label}</option>`).join("");

function setLanguage(id) {
  window.I18N.set(id);
  $("#lang-pick").value = id;
  applyChrome();
  renderRail();
  RENDER[STEPS[S.step].id]();   // re-render the current step in the new language, state intact
  if (document.body.classList.contains("on-home")) renderHome();
}

function setTheme(value) {
  THEME.set(value);
  $("#theme-pick").value = value;
  const h = $("#home-theme");
  if (h) h.value = value;
}

/* Tools that are announced but not built yet. Their cards are clickable: the
   panel says what the tool will do, so "coming soon" explains itself instead
   of being a dead end. */
const SOON_TOOLS = [
  {
    id: "monitor",
    name: "Gonka Host Monitor",
    desc: "Check on a node you already run: how it's doing, what it earns and where that goes. Change settings like collateral, or shut it down cleanly.",
    lead: "A window into a node you already run.",
    points: [
      "See at a glance whether the node is registered, in this epoch's group, and passing validation.",
      "Follow what it earns, epoch by epoch, and which wallet the coins land in.",
      "Change what can be changed, like collateral, and shut the node down cleanly when you are done."
    ],
    foot: "Point it at any node you run, whether Gonka Host Setup built it or you set it up yourself."
  },
  {
    id: "vote",
    name: "Gonka Vote",
    desc: "Vote with your node, read what each proposal says and see how past ones ended, no command lines.",
    lead: "Your node gives you a say in how the network changes.",
    points: [
      "Read every live proposal in plain language, with what it would actually change.",
      "See how past proposals ended and how the network voted.",
      "Cast your vote from the app, with the key you already have, this app's or your own."
    ],
    foot: "Today voting means the command line. This turns it into a few clicks."
  }
];

function openSoon(id) {
  const tool = SOON_TOOLS.find((x) => x.id === id);
  if (!tool || $("#sheet")) return;
  const el = document.createElement("div");
  el.id = "sheet";
  el.innerHTML = `
    <div class="sheet-box" role="dialog" aria-modal="true" aria-label="${esc(tool.name)}">
      <div class="sheet-top">
        <span class="tool-name">${esc(tool.name)}</span>
        <span class="tool-badge">${esc(t("Coming soon"))}</span>
      </div>
      <p class="sheet-lead">${esc(t(tool.lead))}</p>
      <ul>${tool.points.map((p) => `<li>${esc(t(p))}</li>`).join("")}</ul>
      <p class="sheet-foot">${esc(t(tool.foot))}</p>
      <div class="btn-row"><button class="primary" id="sheet-close">${esc(t("Close"))}</button></div>
    </div>`;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() { el.remove(); document.removeEventListener("keydown", onKey); }
  el.onclick = (e) => { if (e.target === el) close(); };
  document.body.appendChild(el);
  $("#sheet-close").onclick = close;
  document.addEventListener("keydown", onKey);
  $("#sheet-close").focus();
}

/* ---- What a rig mines --------------------------------------------------
   A strip on the home screen, and a panel with every deployable rig, what it
   earned over the last epoch and what it can cost to rent before it stops
   paying for itself. All of it measured from the chain (src/services/
   earnings.js); the numbers change on their own as the network does. */
let EARN = null;

const shortModel = (m) => String(m).split("/").pop();
const fmtGnk = (n) => Math.round(n).toLocaleString(window.I18N.lang());
const fmtUsd = (n, dp = 2) =>
  "$" + Number(n).toLocaleString(window.I18N.lang(), { minimumFractionDigits: dp, maximumFractionDigits: dp });

async function loadEarnings(force) {
  if (EARN && !force) return EARN;
  if (!S.seed) S.seed = await api("seed");
  EARN = await api("earnings", { seed: S.seed, force: !!force });
  return EARN;
}

/** Headline rig for the strip: the most common class on the network today. */
function headlineConfig(d) {
  const common = (d.classes || []).slice().sort((a, b) => b.gpus - a.gpus)[0];
  return (common && d.configs.find((c) => c.gpuClass === common.id)) || d.configs[0] || null;
}

function renderEarnStrip() {
  const el = $("#earn-strip");
  if (!el) return;
  loadEarnings().then((d) => {
    const strip = $("#earn-strip");
    if (!strip) return;
    strip.innerHTML =
      `<span class="led on"></span><span class="earn-text">${esc(
        d.price.usd ? t("GNK is {price} right now", { price: fmtUsd(d.price.usd, 4) }) : t("What the network pays for a day of mining")
      )}</span><span class="earn-go">${esc(t("Mine it or buy it? →"))}</span>`;
    strip.hidden = false;
    strip.onclick = () => openEarnings();
  }).catch(() => { /* offline or the chain is unreachable: no strip, no noise */ });
}

function openEarnings() {
  if ($("#sheet")) return;
  const el = document.createElement("div");
  el.id = "sheet";
  el.innerHTML = `<div class="sheet-box wide" role="dialog" aria-modal="true" aria-label="${esc(t("Mine it or buy it?"))}">
      <div class="sheet-top"><span class="tool-name">${esc(t("Mine it or buy it?"))}</span></div>
      <div class="earn-now" id="earn-now"></div>
      <p class="sheet-lead">${esc(t("What each rig mined over the last epoch, measured from the chain, against what that much GNK costs to buy."))}</p>
      <div id="earn-body" class="earn-body">${esc(t("Reading the chain…"))}</div>
      <div class="btn-row"><button class="primary" id="sheet-close">${esc(t("Close"))}</button></div>
    </div>`;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // The price ticks on its own while the panel is open, so what you read is current.
  const ticker = setInterval(() => refreshPrice(), 60000);
  function close() { clearInterval(ticker); el.remove(); document.removeEventListener("keydown", onKey); }
  el.onclick = (e) => { if (e.target === el) close(); };
  document.body.appendChild(el);
  $("#sheet-close").onclick = close;
  document.addEventListener("keydown", onKey);
  $("#sheet-close").focus();

  loadEarnings()
    .then((d) => { renderEarnBody(d); refreshPrice(d.price); })
    .catch((e) => { const b = $("#earn-body"); if (b) b.textContent = t("Could not read the network right now.") + " " + (e.message || ""); });
}

/** The live price line at the top of the panel. Re-reads the sources on a timer. */
async function refreshPrice(known) {
  const row = $("#earn-now");
  if (!row) return;
  let price = known;
  if (!price) {
    try { price = await api("gnkPrice"); } catch (_) { return; }
  }
  if (!$("#earn-now") || !price || !price.usd) return;
  const time = new Date().toLocaleTimeString(window.I18N.lang(), { hour: "2-digit", minute: "2-digit" });
  $("#earn-now").innerHTML =
    `<span class="earn-now-price">${esc(fmtUsd(price.usd, 4))}</span>` +
    `<span class="earn-now-label">${esc(t("GNK right now, from {n} sources · {time}", { n: price.sources.length, time }))}</span>`;
}

function renderEarnBody(d) {
  const body = $("#earn-body");
  if (!body) return;
  const rows = d.configs.map((c, i) => `
    <tr>
      <td class="mono">${c.gpuCount}× ${esc(c.gpuClass)}</td>
      <td>${esc(shortModel(c.model))}</td>
      <td class="num">${esc(fmtGnk(c.gnkPerDay))}</td>
      <td class="num">${c.usdPerDay == null ? "—" : esc(fmtUsd(c.usdPerDay))}</td>
      <td class="num">${c.breakEvenPerHour == null ? "—" : esc(fmtUsd(c.breakEvenPerHour)) + "/h"}</td>
    </tr>`).join("");

  body.innerHTML = `
    <table class="earn-table">
      <thead><tr>
        <th>${esc(t("Rig"))}</th><th>${esc(t("Model"))}</th>
        <th class="num">${esc(t("GNK a day"))}</th><th class="num">${esc(t("Worth"))}</th>
        <th class="num">${esc(t("Rent below"))}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="earn-calc">
      <div class="earn-calc-title">${esc(t("What would it cost you?"))}</div>
      <div class="earn-calc-row">
        <select id="earn-pick">${d.configs.map((c, i) =>
          `<option value="${i}">${c.gpuCount}× ${esc(c.gpuClass)} — ${esc(shortModel(c.model))}</option>`).join("")}</select>
        <input id="earn-cost" type="number" min="0" step="0.01" placeholder="${esc(t("what you pay"))}" />
        <select id="earn-unit">
          <option value="24">${esc(t("per hour"))}</option>
          <option value="1">${esc(t("per day"))}</option>
          <option value="0.0333333">${esc(t("per month"))}</option>
        </select>
      </div>
      <div id="earn-out" class="earn-out"></div>
    </div>

    <ul class="earn-notes">
      <li>${esc(t("A rough estimate, not a promise: this is what the network paid last epoch, shared out over the GPUs that earned it."))}</li>
      <li>${esc(t("Mining is not paid out at once: each epoch's reward is released in {epochs} slices, one per epoch, so it arrives over about {days} days.", { epochs: d.vesting.epochs, days: Math.round(d.vesting.days) }))}</li>
      <li>${esc(t("A new node earns less at first, while it proves itself to the network."))}</li>
      <li>${esc(t("Every GPU that joins lowers what each one earns, because the amount minted per epoch does not grow with them."))}</li>
      <li>${esc(t("Mined GNK is only money once sold, and the price moves."))}</li>
      <li>${esc(t("Native GNK is on no exchange. The traded form is WGNK on Ethereum, contract {addr}. Anything calling itself GNK on Solana is fake.", { addr: d.contract }))}</li>
    </ul>
    <div class="earn-src">
      ${esc(t("Epoch {epoch}: {gnk} GNK shared between {hosts} hosts over {hours} hours.", {
        epoch: d.epoch.index, gnk: fmtGnk(d.epoch.mintedGnk), hosts: d.epoch.participants, hours: d.epoch.hours.toFixed(1)
      }))}
      ${d.price.usd ? esc(t("GNK price {price}, the middle of {n} sources: {list}.", {
        price: fmtUsd(d.price.usd, 4), n: d.price.sources.length, list: d.price.sources.map((s) => s.name).join(", ")
      })) : ""}
    </div>`;

  const pick = $("#earn-pick"), cost = $("#earn-cost"), unit = $("#earn-unit"), out = $("#earn-out");
  const recalc = () => {
    const c = d.configs[Number(pick.value)];
    const paid = Number(cost.value);
    if (!c || !isFinite(paid) || paid <= 0) { out.innerHTML = ""; return; }
    const perDayCost = paid * Number(unit.value);
    const earnUsd = c.usdPerDay;
    const lines = [t("It mines {gnk} GNK a day{usd}.", {
      gnk: fmtGnk(c.gnkPerDay), usd: earnUsd == null ? "" : ", " + t("worth {usd}", { usd: fmtUsd(earnUsd) })
    })];
    lines.push(t("You pay {usd} a day.", { usd: fmtUsd(perDayCost) }));
    if (earnUsd != null) {
      const diff = earnUsd - perDayCost;
      lines.push(`<b>${esc(diff >= 0
        ? t("Ahead by {usd} a day, {month} over 30 days.", { usd: fmtUsd(diff), month: fmtUsd(diff * 30) })
        : t("Behind by {usd} a day, {month} over 30 days.", { usd: fmtUsd(-diff), month: fmtUsd(-diff * 30) }))}</b>`);
      // The whole question in one number: what mining a coin costs you, next
      // to what a coin costs on the market.
      lines.push(t("That is {price} per GNK, against {market} to buy it right now.", {
        price: fmtUsd(perDayCost / c.gnkPerDay, 4), market: fmtUsd(d.price.usd, 4)
      }));
      // Rent is due now; the coins trickle out over the vesting period, so the
      // first month pays a fraction of what it earns.
      if (d.vesting.epochs > 0) {
        const epochsIn30 = 30 * 24 / d.epoch.hours;
        const share = Math.min(1, (epochsIn30 + 1) / (2 * d.vesting.epochs));
        lines.push(t("In the first 30 days you would actually receive about {pct}% of that, because of the slow release; the rest keeps arriving after you stop.",
          { pct: (share * 100).toFixed(0) }));
      }
    }
    out.innerHTML = lines.map((l) => `<div>${l.startsWith("<b>") ? l : esc(l)}</div>`).join("");
  };
  pick.onchange = recalc;
  unit.onchange = recalc;
  cost.oninput = recalc;
}

function renderHome() {
  const el = $("#home");
  if (!el) return;
  // A setup underway in this session, or one saved by an earlier run (the
  // same "worth resuming" threshold the Welcome step uses).
  const saved = resumePoint(loadSession());
  const stepIdx = S.step > 0 ? S.step : (saved > 1 ? saved : 0);
  const progress = stepIdx ? t(STEPS[stepIdx].label) : "";
  el.innerHTML = `
    <div class="home-wrap">
      <header class="home-brand">
        <div class="title">${APP_NAME}</div>
        <div class="sub">GNOT · ${esc(t("by The Gonka Network Onboarding Hub"))}</div>
      </header>
      <button class="earn-strip" id="earn-strip" hidden></button>
      <h1>${esc(t("What would you like to do?"))}</h1>
      <div class="tool-grid">
        <button class="tool-card" id="tool-host">
          <span class="tool-top">
            <span class="led on"></span><span class="tool-name">Gonka Host Setup</span>
          </span>
          ${progress ? `<span class="tool-badge live">${esc(t("In progress: {step}", { step: progress }))}</span>` : ""}
          <span class="tool-desc">${esc(t("Take a GPU server from bare metal to a registered, earning Gonka node, step by step."))}</span>
          <span class="tool-go">${esc(progress ? t("Continue →") : t("Open →"))}</span>
        </button>
        ${SOON_TOOLS.map((tool) => `
        <button class="tool-card soon" data-soon="${tool.id}">
          <span class="tool-top">
            <span class="led"></span><span class="tool-name">${esc(tool.name)}</span>
          </span>
          <span class="tool-badge">${esc(t("Coming soon"))}</span>
          <span class="tool-desc">${esc(t(tool.desc))}</span>
          <span class="tool-go">${esc(t("See what's coming →"))}</span>
        </button>`).join("")}
      </div>
      <footer class="home-foot">
        <div>
          <div class="pickers">
            <select id="home-lang">${languageOptions()}</select>
            <select id="home-theme">${$("#theme-pick").innerHTML}</select>
          </div>
          <div style="margin-top:10px">${esc(t("Need help?"))} <a href="#" data-doc="discord">Gonka Discord</a> ·
            <a href="#" data-doc="faq">FAQ</a> · <a href="#" data-doc="website">Onboarding Hub</a></div>
        </div>
        <div class="version-line" id="home-version"></div>
      </footer>
    </div>`;
  $("#tool-host").onclick = () => showHostSetup();
  el.querySelectorAll("[data-soon]").forEach((b) => { b.onclick = () => openSoon(b.dataset.soon); });
  renderEarnStrip();
  $("#home-lang").onchange = (e) => setLanguage(e.target.value);
  const ht = $("#home-theme");
  ht.value = THEME.get();
  ht.onchange = () => setTheme(ht.value);
  el.querySelectorAll("a[data-doc]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); api("openExternal", { url: S.K.docs[a.dataset.doc] }); };
  });
  renderVersionLine();
}

function showHome() {
  document.body.classList.add("on-home");
  document.title = APP_NAME;
  renderHome();
  // Nothing to lose by closing from here, unless a server is still connected.
  window.gonka.setCloseGuard(!!S.connected && !S.setupFinished);
}

function showHostSetup() {
  document.body.classList.remove("on-home");
  document.title = `Gonka Host Setup — ${APP_NAME}`;
  window.gonka.setCloseGuard(!S.setupFinished);
}

(async function boot() {
  window.gonka.onLog(({ line, stream }) => logLine(line, stream));
  $("#console-bar").onclick = () => toggleConsole();
  initTerminal();
  // Gate before anything else renders: a blocked version must not be able
  // to start a setup it can only get wrong.
  if (await checkForUpdate()) return;
  S.K = await api("knowledge");
  S.platform = (await api("platform")).platform;
  $("#link-discord").onclick = (e) => { e.preventDefault(); api("openExternal", { url: S.K.docs.discord }); };
  $("#link-faq").onclick = (e) => { e.preventDefault(); api("openExternal", { url: S.K.docs.faq }); };
  $("#link-hub").onclick = (e) => { e.preventDefault(); api("openExternal", { url: S.K.docs.website }); };
  $("#link-home").onclick = (e) => { e.preventDefault(); showHome(); };

  // Theme: applied to <html> so the CSS variable blocks switch wholesale.
  // Chosen once, remembered forever — the setup can span days across restarts.
  const tp = $("#theme-pick");
  tp.value = THEME.get();
  tp.onchange = () => setTheme(tp.value);

  const lp = $("#lang-pick");
  lp.innerHTML = languageOptions();
  lp.onchange = () => setLanguage(lp.value);
  new MutationObserver(() => translateShortStrings()).observe($("#stage"), { childList: true, subtree: true });

  applyChrome();
  renderRail();
  go(0);
  showHome();

  // Epoch countdown bar: tick locally every second, re-sync with the chain
  // every 2 minutes (also catches the rollover into a new epoch).
  syncEpochBar();
  setInterval(renderEpochBar, 1000);
  setInterval(syncEpochBar, 120000);
})();

/* ------------------------------------------------------------------ */
/* Command line in the activity log                                    */
/* Lets someone poke at their own server without leaving the wizard —  */
/* check containers, tail a log, look at disk — at any step.           */
/* ------------------------------------------------------------------ */
const TERM = { history: [], idx: -1, busy: false };

async function refreshTermPrompt() {
  const promptEl = $("#console-prompt");
  const input = $("#console-input");
  if (!promptEl || !input) return;
  try {
    const r = await api("termCwd");
    if (r && r.connected) {
      TERM.cwd = r.cwd;
      promptEl.textContent = (r.cwd || "~") + " $";
      input.disabled = false;
      input.placeholder = t("run a command on your server — try: docker compose ps");
      return;
    }
  } catch (_) {}
  promptEl.textContent = t("not connected");
  input.disabled = true;
  input.placeholder = t("connect to a server first");
}

function initTerminal() {
  const form = $("#console-cmd");
  const input = $("#console-input");
  if (!form || !input) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd || TERM.busy) return;
    TERM.history.push(cmd);
    TERM.idx = TERM.history.length;
    input.value = "";
    // Echo it so the log reads like a transcript rather than loose output.
    logLine(`\n${TERM.cwd || "~"} $ ${cmd}\n`);
    TERM.busy = true;
    input.disabled = true;
    try {
      const r = await api("termRun", { command: cmd });
      if (r && r.output) logLine(r.output.endsWith("\n") ? r.output : r.output + "\n");
      if (r && r.cwd) TERM.cwd = r.cwd;
      if (r && r.code) logLine(`(exit code ${r.code})\n`, "stderr");
    } catch (err) {
      logLine(err.message + "\n", "stderr");
    } finally {
      TERM.busy = false;
      input.disabled = false;
      await refreshTermPrompt();
      input.focus();
    }
  };

  // Up/down through previous commands, like a real shell.
  input.onkeydown = (e) => {
    if (e.key === "ArrowUp") {
      if (!TERM.history.length) return;
      e.preventDefault();
      TERM.idx = Math.max(0, TERM.idx - 1);
      input.value = TERM.history[TERM.idx] || "";
    } else if (e.key === "ArrowDown") {
      if (!TERM.history.length) return;
      e.preventDefault();
      TERM.idx = Math.min(TERM.history.length, TERM.idx + 1);
      input.value = TERM.history[TERM.idx] || "";
    }
  };
  refreshTermPrompt();
}

/* ------------------------------------------------------------------ */
/* Update gate                                                         */
/* Every update is required: an outdated copy can't be used until it   */
/* updates. Gonka changes often, and a stale setup tool fails in ways  */
/* that cost people rented GPU time.                                   */
/* ------------------------------------------------------------------ */
// Installed copies on Windows and macOS download, verify and install updates
// themselves (updater.js): no browser, so no SmartScreen/Gatekeeper prompt
// and no hunting for the file. Anything else, or a failed attempt, gets the link.
async function checkForUpdate() {
  let u = null;
  try { u = await api("updateState"); } catch (_) { return false; }
  S.update = u;                                  // for the version line in the rail
  if (!u || !u.checked) return false;            // offline / no manifest: carry on
  const auto = !!u.autoUpdate;

  if (u.state === "required") {
    document.body.innerHTML = `
      <div style="height:100vh; display:flex; align-items:center; justify-content:center; padding:40px">
        <div style="max-width:560px">
          <div class="step-eyebrow">${t("Update required")}</div>
          <h1 style="font-size:26px; margin:0 0 10px">${t("A new version is ready")}</h1>
          <p class="lede">${t("You have version {have}, and version {need} is out. Every update is required, so everyone runs the version that works with the Gonka network today.",
            { have: esc(u.current), need: esc(u.latest) })}</p>
          ${u.notes ? `<div class="card"><h4>${t("What changed")}</h4><p class="small">${esc(u.notes)}</p></div>` : ""}
          <div class="btn-row">
            ${auto ? `<button class="primary" id="u-auto">${t("Update now")}</button>`
              : u.url ? `<button class="primary" id="u-get">${t("Download version {v}", { v: esc(u.latest) })}</button>` : ""}
            <button id="u-quit">${t("Quit")}</button>
          </div>
          <p class="small" id="u-status" style="margin-top:14px">${auto
            ? t("Takes about a minute: the app closes, installs version {v} and reopens by itself. Your progress, wallet and settings are kept.", { v: esc(u.latest) })
            : t("Install it over the top of this one — your progress, wallet and settings are kept.")}</p>
          ${u.sha256 ? `<p class="small mono" style="margin-top:10px; word-break:break-all">SHA-256: ${esc(u.sha256)}</p>` : ""}
        </div>
      </div>`;
    const get = $("#u-get");
    if (get) get.onclick = () => api("openExternal", { url: u.url });
    const upd = $("#u-auto");
    if (upd) upd.onclick = () => runUpdate(u, upd, $("#u-status"));
    $("#u-quit").onclick = () => { window.gonka.allowClose && window.gonka.allowClose(); window.close(); };
    return true;                                  // stop the wizard from booting
  }
  return false;
}

async function runUpdate(u, trigger, status) {
  if (trigger.dataset.busy) return;
  trigger.dataset.busy = "1";
  trigger.disabled = true;
  trigger.style.pointerEvents = "none";
  runUpdate.status = status;
  if (!runUpdate.listening) {
    runUpdate.listening = true;
    window.gonka.onUpdateProgress(({ got, total }) => {
      if (!runUpdate.status || runUpdate.done) return;
      const mb = (n) => Math.round(n / 1e6);
      runUpdate.status.textContent = total
        ? t("Downloading update… {pct}% ({got} of {total} MB)", { pct: Math.floor((got * 100) / total), got: mb(got), total: mb(total) })
        : t("Downloading update… {got} MB", { got: mb(got) });
    });
  }
  status.textContent = t("Downloading update…");
  try {
    await api("installUpdate");
    runUpdate.done = true;
    status.textContent = t("Installing version {v} — the app will close and reopen by itself in a few seconds.", { v: u.latest });
  } catch (err) {
    delete trigger.dataset.busy;
    trigger.disabled = false;
    trigger.style.pointerEvents = "";
    status.innerHTML = esc(t("The automatic update didn't work: {err}", { err: err.message })) +
      (u.url ? ` <a href="#" class="u-fallback">${t("Download it from the website instead")}</a>` : "");
    const f = status.querySelector(".u-fallback");
    if (f) f.onclick = (ev) => { ev.preventDefault(); api("openExternal", { url: u.url }); };
  }
}

/* Version line at the foot of the rail: which build this is, whether it's
   the newest, and when it was released — the first thing anyone helping
   with a problem will ask. */
function fmtReleaseDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  try {
    return new Date(y, m - 1, d).toLocaleDateString(window.I18N.lang(), { year: "numeric", month: "short", day: "numeric" });
  } catch (_) { return String(iso); }
}

function renderVersionLine() {
  const u = S.update;
  if (!u || !u.current) return;
  // No "update available" state: an outdated copy never gets past the update gate.
  let led = "", status, tip;
  if (u.checked) {
    led = "ok";
    status = esc(t("Up to date"));
    tip = t("This is the newest version of The Gonka Network Onboarding Tool.");
  } else {
    status = esc(t("Couldn't check for updates"));
    tip = t("The update check needs an internet connection. It runs again next time the app opens.");
  }
  const html = `
    <div class="v-row"><span class="led ${led}"></span><span><span class="v-ver">v${esc(u.current)}</span> · <span class="v-status">${status}</span></span></div>
    ${u.released ? `<div class="v-date">${esc(t("Updated {date}", { date: fmtReleaseDate(u.released) }))}</div>` : ""}`;
  // The rail footer (inside Gonka Host Setup) and the home screen.
  for (const el of document.querySelectorAll("#app-version, #home-version")) {
    el.title = tip;
    el.innerHTML = html;
  }
}
