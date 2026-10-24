const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require("electron");
const path = require("path");
const fs = require("fs");

// Keep user data where every earlier version kept it. The app was called
// "Gonka Host Setup" until 1.1.0 and Electron names this folder after the app,
// so the rename would otherwise strand wallets, the SSH key, saved progress,
// language and theme. Must run before anything touches userData.
app.setPath("userData", path.join(app.getPath("appData"), "Gonka Host Setup"));

// One copy at a time. Two of them share the same folder and fight over the same
// files — wallets, saved progress, the keyring. Opening the app again just
// brings the window it already has to the front.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const K = require("./src/knowledge");
const { LocalDriver, SshDriver, localMachine, shq } = require("./src/executor");
const scan = require("./src/services/scan");
const fixes = require("./src/services/fixes");
const keys = require("./src/services/keys");
const configgen = require("./src/services/configgen");
const deploy = require("./src/services/deploy");
const netdata = require("./src/services/netdata");
const monitor = require("./src/services/monitor");
const earnings = require("./src/services/earnings");
const usage = require("./src/services/usage");
const updates = require("./src/update");
const updater = require("./src/updater");

let win = null;
let driver = null;          // active server driver (local or ssh)
let lastScanFacts = {};     // cached scan facts for fixes / config suggestions
let updateState = { state: "ok", checked: false };   // set once at boot
let confirmClose = true;    // ask before closing mid-setup (see createWindow)
let updating = false;

function log(line, stream = "stdout") {
  if (win && !win.isDestroyed()) win.webContents.send("wizard:log", { line, stream });
}
const onData = (t, s) => log(t, s);

/* How big the window opens, and how big everything in it is drawn. At a fixed
   1120 × 760 and actual size the app looked small on an ordinary screen, so it
   opens at most of the screen and draws everything a tenth larger — except on
   a small laptop screen, where actual size leaves more room. Ctrl + / Ctrl − /
   Ctrl 0 change it (the window has no menu, so nothing did before), and the
   choice is kept in ui.json. */
const uiFile = () => path.join(app.getPath("userData"), "ui.json");
function readUi() { try { return JSON.parse(fs.readFileSync(uiFile(), "utf8")) || {}; } catch (_) { return {}; } }
function saveUi(patch) { try { fs.writeFileSync(uiFile(), JSON.stringify({ ...readUi(), ...patch })); } catch (_) {} }
const ZOOM_MIN = 0.8, ZOOM_MAX = 1.5;
/** A tenth larger than actual size, unless the screen is small. */
function defaultZoom() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return wa.width >= 1500 && wa.height >= 860 ? 1.1 : 1;
}
function windowSize() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(wa.width, Math.max(980, Math.min(1440, Math.round(wa.width * 0.9))));
  const height = Math.min(wa.height, Math.max(680, Math.min(960, Math.round(wa.height * 0.9))));
  const saved = Number(readUi().zoom);
  return { width, height, zoom: saved >= ZOOM_MIN && saved <= ZOOM_MAX ? saved : defaultZoom() };
}

function createWindow() {
  const size = windowSize();
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#0e131c",
    title: "The Gonka Network Onboarding Tool",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: size.zoom
    }
  });
  win.removeMenu?.();
  // Bigger / smaller / back to the start, kept for next time.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const now = win.webContents.getZoomFactor();
    if (input.key === "0") {
      // Back to the size the app starts at on this screen; forget the choice.
      e.preventDefault();
      win.webContents.setZoomFactor(defaultZoom());
      saveUi({ zoom: null });
      return;
    }
    let next = null;
    if (input.key === "=" || input.key === "+") next = now + 0.1;
    else if (input.key === "-" || input.key === "_") next = now - 0.1;
    if (next === null) return;
    e.preventDefault();
    next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 100) / 100;
    win.webContents.setZoomFactor(next);
    saveUi({ zoom: next });
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Guard against accidentally closing mid-setup and losing an SSH session /
  // progress. The renderer turns it off on the home screen (unless a server
  // is still connected) and once a setup is finished.
  ipcMain.on("app:allowClose", () => { confirmClose = false; });
  ipcMain.on("app:closeGuard", (_e, on) => { confirmClose = !!on; });
  win.on("close", (e) => {
    if (!confirmClose || win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Stay", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Gonka Host Setup",
      message: "Close the setup wizard?",
      detail: "Your server keeps running and any progress on it is saved — but this window's connection will close, and you'll reconnect to continue. Close it?"
    });
    if (choice === 0) e.preventDefault();
  });
}

app.whenReady().then(async () => {
  await K.loadRemoteManifest();
  // The daily comparison with the live Gonka network: what to tell a person when
  // the network has changed, and Gonka's own permission list when ours is stale.
  await K.loadCompat();
  // The manifest doubles as the release channel. Never throws: an unreachable
  // website must not stop someone opening the app.
  try { updateState = updates.evaluate(VERSION, K.get().app, { platform: process.platform, arch: process.arch }); }
  catch (_) { updateState = { state: "ok", checked: false }; }
  createWindow();
  // Say the app is open, so the website can count computers exactly instead of
  // guessing from downloads. At most once an hour, whatever the timer does; the
  // timer covers a window left open for days.
  usage.opened().catch(() => {});
  setInterval(() => { usage.opened().catch(() => {}); }, 15 * 60 * 1000).unref?.();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const ok = (data) => ({ ok: true, data });
const fail = (e) => ({ ok: false, error: (e && e.message) || String(e) });
const wrap = (fn) => async (_evt, args) => { try { return ok(await fn(args || {})); } catch (e) { return fail(e); } };
const needDriver = () => { if (!driver) throw new Error("Not connected to a server yet."); return driver; };

/* ------------------------------------------------------------------ */
/* IPC: app + knowledge                                                */
/* ------------------------------------------------------------------ */
ipcMain.handle("app:knowledge", wrap(async () => K.get()));
// Release date stamped into package.json by scripts/release.js (absent in dev runs).
const RELEASED = (() => { try { return require("./package.json").gonkaReleased || null; } catch (_) { return null; } })();
// The app's own version. The same as app.getVersion() once packaged; in a run
// from source that call returns Electron's version instead, which made the
// version line read "v44.4.5".
const VERSION = (() => { try { return require("./package.json").version || app.getVersion(); } catch (_) { return app.getVersion(); } })();
ipcMain.handle("app:updateState", wrap(async () => ({
  ...updateState,
  current: VERSION,
  released: RELEASED,
  autoUpdate: updater.canSelfUpdate(updateState)
})));

// Download the new version, verify it, start its installer (Windows) or the
// bundle swap (macOS), and get out of the way. Either one waits for this
// process to exit and then reopens the app on the new version. Progress on
// the server is unaffected; the wizard resumes where it was.
ipcMain.handle("app:installUpdate", wrap(async () => {
  const u = updateState;
  if (!u || !u.checked || u.state === "ok") throw new Error("There's no update to install.");
  if (!updater.canSelfUpdate(u)) throw new Error("This copy can't update itself — download the new version from the website.");
  if (updating) throw new Error("Already updating.");
  updating = true;
  try {
    const onProgress = (got, total) => {
      if (win && !win.isDestroyed()) win.webContents.send("update:progress", { got, total });
    };
    if (process.platform === "darwin") await updater.startMacUpdate(u, app.getPath("temp"), onProgress);
    else await updater.startWindowsUpdate(u, app.getPath("temp"), onProgress);
    confirmClose = false;
    setTimeout(() => app.quit(), 400);   // let this reply reach the window first
    return { installing: u.latest };
  } catch (e) {
    updating = false;
    throw e;
  }
}));
ipcMain.handle("app:platform", wrap(async () => ({ platform: process.platform })));
ipcMain.handle("app:openExternal", wrap(async ({ url }) => { shell.openExternal(url); return true; }));
ipcMain.handle("app:pickFile", wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "showHiddenFiles"] });
  return r.canceled ? null : r.filePaths[0];
}));

/* ------------------------------------------------------------------ */
/* IPC: connection                                                     */
/* ------------------------------------------------------------------ */
ipcMain.handle("conn:connect", wrap(async ({ mode, ssh }) => {
  if (driver) { driver.dispose(); driver = null; }
  termCwd = null;   // new machine: forget the old terminal directory
  if (mode === "local") {
    driver = new LocalDriver();
    if (process.platform === "win32") {
      const wsl = await driver.exec("echo WSL_OK");
      if (!wsl.stdout.includes("WSL_OK")) {
        driver = null;
        throw new Error("Windows detected but WSL isn't available. Install WSL2 with Ubuntu (run `wsl --install` in PowerShell as admin), or choose the remote-server option.");
      }
    }
    const probe = await driver.exec("uname -a");
    return { kind: "local", info: probe.stdout.trim() };
  }
  const s = new SshDriver();
  await s.connect(ssh);
  driver = s;
  const probe = await driver.exec("uname -a && whoami");
  return { kind: "ssh", info: probe.stdout.trim() };
}));

ipcMain.handle("conn:disconnect", wrap(async () => { if (driver) driver.dispose(); driver = null; termCwd = null; return true; }));

/* ------------------------------------------------------------------ */
/* IPC: scan + fixes                                                   */
/* ------------------------------------------------------------------ */
ipcMain.handle("scan:run", wrap(async () => {
  const res = await scan.runScan(needDriver());
  lastScanFacts = res.facts;
  return res;
}));
ipcMain.handle("fix:plan", wrap(async ({ id }) => fixes.planFix(id, lastScanFacts)));
ipcMain.handle("fix:run", wrap(async ({ id }) => {
  const r = await fixes.runFix(needDriver(), id, lastScanFacts, onData);
  if (r.code !== 0) throw new Error(r.stderr || "Fix failed — see the log.");
  return true;
}));

/* ------------------------------------------------------------------ */
/* IPC: local wallet (cold key) — never touches the server             */
/* ------------------------------------------------------------------ */
ipcMain.handle("keys:ensureCli", wrap(async () => keys.ensureCli((t) => log(t))));
ipcMain.handle("keys:create", wrap(async ({ name, passphrase }) => keys.createKey(name, passphrase)));
ipcMain.handle("keys:import", wrap(async ({ name, passphrase, mnemonic }) => keys.importKey(name, passphrase, mnemonic)));
ipcMain.handle("keys:show", wrap(async ({ name, passphrase }) => keys.showKey(name, passphrase)));
ipcMain.handle("keys:grant", wrap(async (a) => keys.grantMlOps(a, onData)));
ipcMain.handle("keys:manualRegister", wrap(async (a) => keys.manualRegister(a, onData)));
ipcMain.handle("keys:deposit", wrap(async (a) => keys.depositCollateral(a, onData)));
ipcMain.handle("keys:sequence", wrap(async ({ address, seedApiUrl }) => keys.accountSequence(address, seedApiUrl)));
ipcMain.handle("keys:sshKeygen", wrap(async () => keys.sshKeygen()));

ipcMain.handle("keys:sshKeyInfo", wrap(async () => keys.sshKeyInfo()));
ipcMain.handle("keys:names", wrap(async () => keys.keyringKeyNames()));
ipcMain.handle("keys:resetKeyring", wrap(async () => keys.resetKeyring()));

/* ------------------------------------------------------------------ */
/* IPC: config generation                                              */
/* ------------------------------------------------------------------ */
ipcMain.handle("config:generateEnv", wrap(async ({ answers, templateText }) =>
  // Default the model cache to the disk the scan found room on.
  configgen.generateConfigEnv({ hfHome: lastScanFacts.hfHomePath, ...answers }, templateText)));
ipcMain.handle("config:rankNodeConfigs", wrap(async ({ files, gpus }) =>
  configgen.rankNodeConfigs(files, gpus || lastScanFacts.gpus || [])));
ipcMain.handle("config:modelsIn", wrap(async ({ jsonText }) => configgen.modelsInConfig(jsonText)));

/* ------------------------------------------------------------------ */
/* IPC: deploy (server)                                                */
/* ------------------------------------------------------------------ */
ipcMain.handle("deploy:clone", wrap(async () => deploy.cloneRepo(needDriver(), onData)));
ipcMain.handle("deploy:listNodeConfigs", wrap(async () => deploy.listNodeConfigs(needDriver())));
ipcMain.handle("deploy:readRepoFile", wrap(async ({ rel }) => deploy.readRepoFile(needDriver(), rel)));
ipcMain.handle("deploy:hardenPorts", wrap(async () => deploy.hardenPorts(needDriver(), onData)));
ipcMain.handle("deploy:writeConfigs", wrap(async (a) =>
  deploy.writeConfigs(needDriver(), { gpuCount: (lastScanFacts.gpus || []).length, ...a })));
ipcMain.handle("deploy:serverKeyName", wrap(async () => deploy.readServerKeyName(needDriver())));
// Preflight: verify the compose images actually have a build for this
// server's CPU architecture before pulling gigabytes and launching.
ipcMain.handle("deploy:archPreflight", wrap(async () => {
  const driver = needDriver();
  const [images, arch] = await Promise.all([deploy.listComposeImages(driver), deploy.serverArch(driver)]);
  const results = await netdata.checkImageArchs(images, arch);
  return { arch, checked: results.length, bad: results.filter((r) => !r.ok) };
}));
ipcMain.handle("deploy:pull", wrap(async () => deploy.pullImages(needDriver(), onData)));
ipcMain.handle("deploy:startCore", wrap(async () => {
  const d = needDriver();
  // Relocate the growing data dirs onto the roomiest disk BEFORE the node
  // starts writing chain state — on rented boxes the root disk is far too
  // small and fills mid-sync, corrupting the database.
  const big = lastScanFacts.weightsMount;
  if (big && big !== "/") {
    const res = await deploy.prepareDataDirs(d, big, onData);
    if (res.moved && res.moved.length) {
      log(`Chain data will live on ${big} (the largest disk): ${res.moved.join(", ")}\n`);
    }
  }
  return deploy.startCore(d, onData);
}));
ipcMain.handle("deploy:warmKeyExists", wrap(async () => deploy.warmKeyExists(needDriver())));
ipcMain.handle("deploy:createWarmKey", wrap(async () => deploy.createWarmKey(needDriver(), onData)));
ipcMain.handle("deploy:getConsensusKey", wrap(async () => deploy.getConsensusKey(needDriver())));
ipcMain.handle("deploy:register", wrap(async () => deploy.registerHost(needDriver(), onData)));
ipcMain.handle("deploy:launchAll", wrap(async () =>
  deploy.launchAll(needDriver(), onData, (lastScanFacts.gpus || []).length)));
ipcMain.handle("deploy:downloadWeights", wrap(async ({ models }) =>
  deploy.downloadWeights(needDriver(), models, onData, lastScanFacts.hfHomePath)));
ipcMain.handle("deploy:containers", wrap(async () => deploy.containersStatus(needDriver())));
ipcMain.handle("deploy:nodeSync", wrap(async () => deploy.nodeSyncStatus(needDriver())));
ipcMain.handle("deploy:feeBudget", wrap(async () => deploy.feeBudget(needDriver())));
ipcMain.handle("deploy:mlnode", wrap(async () => deploy.mlnodeStatus(needDriver())));

/* ------------------------------------------------------------------ */
/* IPC: live network data                                              */
/* ------------------------------------------------------------------ */
ipcMain.handle("net:seed", wrap(async () => netdata.firstReachableSeed()));
ipcMain.handle("net:models", wrap(async ({ seed }) => netdata.governanceModels(seed)));
ipcMain.handle("net:participant", wrap(async ({ seed, address }) => netdata.participant(seed, address)));
ipcMain.handle("net:balance", wrap(async ({ seed, address }) => netdata.balanceOf(seed, address)));
ipcMain.handle("net:epochParticipants", wrap(async ({ seed }) => netdata.epochParticipants(seed)));
ipcMain.handle("net:recommendCollateral", wrap(async ({ seed, myWeight }) => netdata.recommendCollateral(seed, myWeight)));
ipcMain.handle("net:collateralOf", wrap(async ({ seed, address }) => netdata.collateralOf(seed, address)));
ipcMain.handle("net:repoGpuConfigs", wrap(async () => netdata.repoGpuConfigs()));
ipcMain.handle("net:earnings", wrap(async ({ seed, force }) => earnings.estimate(seed, { force })));
ipcMain.handle("net:gnkPrice", wrap(async () => earnings.gnkPrice()));
ipcMain.handle("net:probe", wrap(async ({ url }) => netdata.probeUrl(url)));
ipcMain.handle("net:nextPoc", wrap(async ({ seed }) => netdata.nextPoc(seed)));
ipcMain.handle("net:modelActivity", wrap(async ({ seed }) => netdata.modelActivity(seed)));
ipcMain.handle("net:payingModels", wrap(async ({ seed }) => netdata.payingModels(seed)));
ipcMain.handle("net:releaseArch", wrap(async ({ arch }) => netdata.releaseArchStatus(arch || "amd64")));
ipcMain.handle("net:chainHeight", wrap(async ({ seed }) => netdata.chainHeight(seed)));

// Gonka Host Monitor/Vote: public facts about a node somebody already runs.
// Nothing here needs a key or a server; the seed is remembered for a while so
// every refresh does not start by looking for one again.
const monitorDir = () => path.join(app.getPath("userData"), "monitor");
// Gonka's public nodes do not all answer the same questions, so the tool is
// given every one of them, the one that answers first in front.
let monitorSeed = { url: null, at: 0 };
async function seedForMonitor() {
  if (!monitorSeed.url || Date.now() - monitorSeed.at > 5 * 60 * 1000) monitorSeed = { url: await netdata.firstReachableSeed(), at: Date.now() };
  return [...new Set([monitorSeed.url, ...K.get().seedNodes])];
}
ipcMain.handle("monitor:network", wrap(async () => monitor.network(await seedForMonitor())));
ipcMain.handle("monitor:networkOverview", wrap(async () => monitor.networkOverview(await seedForMonitor())));
ipcMain.handle("monitor:hardwareSetups", wrap(async () => monitor.hardwareSetups()));
ipcMain.handle("monitor:overview", wrap(async ({ address, epochs }) => {
  if (!monitor.looksLikeAddress(address)) throw new Error("That is not a Gonka address.");
  return monitor.overview(await seedForMonitor(), String(address).trim(),
    { epochs: Math.min(180, Math.max(7, Number(epochs) || 30)) });
}));
ipcMain.handle("monitor:nodes", wrap(async () => monitor.loadNodes(monitorDir())));
ipcMain.handle("monitor:saveNodes", wrap(async ({ nodes }) => monitor.saveNodes(monitorDir(), nodes)));
ipcMain.handle("monitor:proposals", wrap(async () => monitor.proposals(await seedForMonitor())));
ipcMain.handle("monitor:voteOf", wrap(async ({ id, address }) => {
  if (!monitor.looksLikeAddress(address)) throw new Error("That is not a Gonka address.");
  return monitor.voteOf(await seedForMonitor(), Number(id), String(address).trim());
}));
ipcMain.handle("net:myEpochWeight", wrap(async ({ seed, address }) => netdata.myEpochWeight(seed, address)));

/* ------------------------------------------------------------------ */
/* IPC: user terminal — run a command on the connected server          */
/* ------------------------------------------------------------------ */
// Deliberately simple: one command per press, with a remembered working
// directory so `cd` behaves the way people expect. Not a PTY, so interactive
// programs (vim, top, less) can't work — we say so plainly instead of leaving
// someone staring at a hung prompt.
let termCwd = null;
const INTERACTIVE = /^(vi|vim|nano|top|htop|less|more|man|watch|tmux|screen)\b/;

ipcMain.handle("term:cwd", wrap(async () => {
  if (!driver) return { cwd: null, connected: false };
  if (!termCwd) {
    // Start where the deployment lives when it exists — that's where nearly
    // every useful command wants to run.
    const join = K.get().repo.joinDir;
    const r = await driver.exec(`cd ${join} 2>/dev/null && pwd || pwd`);
    termCwd = (r.stdout || "").trim() || "~";
  }
  return { cwd: termCwd, connected: true };
}));

ipcMain.handle("term:run", wrap(async ({ command }) => {
  const d = needDriver();
  const cmd = String(command || "").trim();
  if (!cmd) return { output: "" };
  if (INTERACTIVE.test(cmd)) {
    throw new Error(
      `"${cmd.split(/\s+/)[0]}" needs a full interactive terminal, which this window can't provide. ` +
      `Use a non-interactive form instead — for example "tail -n 50 <file>" rather than less, ` +
      `or "nvidia-smi" rather than watch.`);
  }
  if (!termCwd) {
    const j = await d.exec(`cd ${K.get().repo.joinDir} 2>/dev/null && pwd || pwd`);
    termCwd = (j.stdout || "").trim() || "~";
  }
  // `cd` must be handled here: every exec is its own shell, so a plain
  // `cd foo` would succeed and then be immediately forgotten.
  const cdOnly = cmd.match(/^cd(?:\s+(.*))?$/);
  if (cdOnly) {
    const target = (cdOnly[1] || "~").trim();
    const r = await d.exec(`cd ${shq(termCwd)} && cd ${target} && pwd`);
    const next = (r.stdout || "").trim();
    if (r.code !== 0 || !next) throw new Error((r.stderr || `cd: ${target}: no such file or directory`).trim());
    termCwd = next;
    return { output: "", cwd: termCwd };
  }
  const r = await d.exec(`cd ${shq(termCwd)} 2>/dev/null; ${cmd}`, { timeoutMs: 120000 });
  return { output: (r.stdout || "") + (r.stderr || ""), code: r.code, cwd: termCwd };
}));
