/**
 * check-host-setup.js — does every Host Setup step still open and draw?
 *
 *   node scripts/check-host-setup.js
 *
 * Starts the hidden test copy (dist/hidden-app: the current code, its window
 * never shown, its own profile, never counted as a user) unless it is already
 * running, and walks Host Setup from the first page to the last:
 *
 *   - the first page reads the live network and Gonka's ready-made setups, and
 *     a setup can be picked, which shows what the server needs;
 *   - every later step, from "Your server" to "Your node is live", draws with
 *     made-up but realistic answers for an 8 × H100 server (documentation IP
 *     203.0.113.7, a wallet made up on the spot), as scripts/shoot-walkthrough.js
 *     does for the website's pictures;
 *   - Monitor/Vote opens on the live network.
 *
 * A step fails when its page does not appear or the page throws. Nothing is
 * sent to any server and nothing is signed. This proves the app's pages still
 * work with the network as it is today; only a real run on a real server
 * proves a whole setup. Closes the copy it started. Exit 1 = a step failed.
 */
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const wallet = require("../src/services/wallet.js");

const ROOT = path.join(__dirname, "..");
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priv = crypto.randomBytes(32);
const ADDR = wallet.addressOf(wallet.pubOf(priv));
const PUB = Buffer.from(wallet.pubOf(priv)).toString("base64");

async function findPage() {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(2000) })).json()).find((t) => t.type === "page" && t.url.includes("/renderer/")); }
  catch (_) { return null; }
}

(async () => {
  const results = [];
  const note = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  let child = null;
  let page = await findPage();
  if (!page) {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
    child = spawn(exe, [path.join(ROOT, "dist", "hidden-app")], { cwd: ROOT, stdio: "ignore", detached: false });
    for (let i = 0; i < 120 && !page; i++) { await sleep(500); page = await findPage(); }
  }
  if (!page) { console.log("FAIL the hidden test copy did not open (dist/hidden-app, DevTools port 9336)"); if (child) child.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
    // A copy left open partway through a setup asks before it reloads; nobody is there to answer.
    if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } })); };
  // A page that never answers is a failed check, not a check that never ends.
  const send = (method, params) => new Promise((r, no) => { const n = ++id; const timer = setTimeout(() => { waiting.delete(n); no(new Error(`no answer from the page in 90 seconds (${method})`)); }, 90000); waiting.set(n, (d) => { clearTimeout(timer); r(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (e) => { const d = await send("Runtime.evaluate", { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true }); if (d.result.exceptionDetails) throw new Error(d.result.exceptionDetails.exception ? d.result.exceptionDetails.exception.description : d.result.exceptionDetails.text); return d.result.result.value; };
  const until = async (cond, tries = 60) => { for (let i = 0; i < tries; i++) { try { if (await run(`return !!(${cond})`)) return true; } catch (_) {} await sleep(400); } return false; };
  const fresh = () => errors.length;
  const thrown = (from) => errors.slice(from).map((x) => String(x).split("\n")[0]).join(" | ").slice(0, 300);

  try {
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.reload", { ignoreCache: true }); await sleep(3000);
    note("the app opens", await until("document.querySelector('#tool-host') && typeof RENDER !== 'undefined'", 80));
    await run(`window.I18N.set("en"); return 1;`);

    // 1. The first page, on the live network and Gonka's own setups.
    let from = fresh();
    await run("clearSession(); doneSteps.clear(); S.furthest = 0; document.querySelector('#tool-host').click(); clearSession(); S.step = 0; renderRail(); RENDER.welcome(); return 1;");
    const listed = await until("document.querySelectorAll('#stage .gpu-chip').length > 0", 90);
    const chips = listed ? await run("return document.querySelectorAll('#stage .gpu-chip').length;") : 0;
    note("Welcome: the setups available now", listed && errors.length === from, listed ? `${chips} setups listed` : "no setup appeared (the network or Gonka's setups did not answer)" + (errors.length > from ? "; page threw: " + thrown(from) : ""));
    if (listed) {
      from = fresh();
      await run("const c = [...document.querySelectorAll('#stage .gpu-chip')].find((c) => c.dataset.gpu === 'H100') || document.querySelector('#stage .gpu-chip'); pickSetup(c); return 1;");
      const needs = await until("document.querySelector('#needs-card')", 40);
      note("Welcome: picking a setup shows what the server needs", needs && errors.length === from, errors.length > from ? "page threw: " + thrown(from) : "");
    }

    // 2. Every later step, with made-up answers for what would need the server.
    const H100 = { name: "NVIDIA H100 80GB HBM3", vramMiB: 81559 };
    const scan = { ok: false, facts: { gpus: Array.from({ length: 8 }, () => H100), gpuClass: "H100", publicIp: "203.0.113.7", ramGB: 1512, cuda: "13.0", driverVersion: "580.126.09", hasApt: true },
      items: [
        { id: "os", label: "Operating system", status: "pass", detail: "Ubuntu 22.04.5 LTS (x86_64)" },
        { id: "cpu", label: "CPU cores (need 16+)", status: "pass", detail: "192 cores detected" },
        { id: "ram", label: "RAM (need 64+ GB)", status: "pass", detail: "1512 GB detected" },
        { id: "disk", label: "Free disk (need ~1000 GB, plus model weights)", status: "pass", detail: "3150 GB free on /" },
        { id: "docker", label: "Docker installed", status: "fail", detail: "Docker is required to run all Gonka services.", fixable: true },
        { id: "gpu", label: "NVIDIA GPU(s)", status: "pass", detail: "8× NVIDIA H100 80GB HBM3" },
        { id: "cuda", label: "CUDA 13, or 12.9", status: "pass", detail: "CUDA 13.0 detected" },
        { id: "nvidia-toolkit", label: "NVIDIA Container Toolkit", status: "fail", detail: "", fixable: true },
        { id: "ports", label: "Internal ports not publicly exposed", status: "pass", detail: "" }] };
    from = fresh();
    const files = await run(`
      window.__real = window.__real || api; const real = window.__real;
      const files = (await real("repoGpuConfigs")).map((r) => r.file);
      const cfg = JSON.stringify([{ id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
        models: { "deepseek-ai/DeepSeek-V4-Flash-0731": { args: ["--tensor-parallel-size", "4"] } } }], null, 2);
      const fake = {
        scan: ${JSON.stringify(scan)},
        clone: true, listNodeConfigs: files, rankConfigs: files.map((f) => ({ file: f })),
        readRepoFile: (a) => a.rel === "config.env.template" ? "" : cfg,
        modelsIn: ["deepseek-ai/DeepSeek-V4-Flash-0731"], serverKeyName: null,
        genEnv: "export KEY_NAME=gonka-node\\nexport PUBLIC_URL=http://203.0.113.7:8000\\n",
        keyNames: ["gonka-account-key"], keyShow: { address: ${JSON.stringify(ADDR)}, pubkey: ${JSON.stringify(PUB)} },
        balance: 12500000000, ensureCli: true,
        containers: "api   Up 3 hours\\nnode  Up 3 hours\\nmlnode Up 3 hours",
        probe: { reachable: true }, nodeSync: { height: 6750000, catchingUp: false, snapshot: null },
        mlnode: { gpuTotal: 8, gpuReady: 8, weightsReady: true, state: "INFERENCE" },
        feeBudget: { covers: true, budget: 2400000000, spendable: 12400000000, known: true },
        participant: { participant: { address: ${JSON.stringify(ADDR)}, inferenceUrl: "http://203.0.113.7:8000", status: "ACTIVE" } },
        monitorNodes: [], monitorSaveNodes: true
      };
      api = async (fn, args) => (fn in fake ? (typeof fake[fn] === "function" ? fake[fn](args) : fake[fn]) : real(fn, args));
      S.connected = true; S.mode = "ssh";
      Object.assign(S.ssh, { host: "203.0.113.7", port: 22, username: "root", auth: "key", privateKeyPath: "C:\\\\Users\\\\you\\\\.ssh\\\\gnot_ed25519" });
      S.wallet = { name: "gonka-account-key", address: ${JSON.stringify(ADDR)}, pubkey: ${JSON.stringify(PUB)}, confirmed: true, passphrase: "x" };
      S.net = { ...S.net, scheme: "http", host: "203.0.113.7" };
      S.scan = ${JSON.stringify(scan)};
      return files.length;`);
    note("Gonka's ready-made setups can be read", files > 0 && errors.length === from, `${files} setup files`);

    const steps = [
      ["Your server", "mode", "#stage .c-title"],
      ["Connect", "connect", "#b-conn"],
      ["Health check", "scan", ".scan-sum"],
      ["Wallet", "wallet", "#bal-live, #stage .pill"],
      ["Network & SSL", "network", "#net-form .card"],
      ["Model & GPUs", "model", ".model-list"],
      ["Review config", "review", ".need-grid, #stage pre, #stage textarea"],
      ["Model weights", "weights", "#stage .card"],
      ["Launch & register", "deploy", "#stage .card"],
      ["Collateral", "collateral", "#b-dep, #stage .warn-banner, #stage .info-banner"],
      ["Verify", "verify", "#fee-card .need-grid"],
      ["Your node is live", "done", "#stage .after-setup"]
    ];
    for (const [name, step, ready] of steps) {
      from = fresh();
      let drew = true, why = "";
      try { await run(`const i = STEPS.findIndex((s) => s.id === ${JSON.stringify(step)}); if (i < 0) throw new Error("no such step"); S.step = i; doneSteps.clear(); for (let k = 0; k < i; k++) doneSteps.add(k); renderRail(); RENDER[${JSON.stringify(step)}](); return 1;`); }
      catch (e) { drew = false; why = String(e.message).split("\n")[0]; }
      const shown = drew && await until(ready.split(", ").map((r) => `document.querySelector(${JSON.stringify(r.startsWith("#stage") ? r : "#stage " + r)})`).join(" || "), 50);
      await sleep(1200);
      const threw = errors.length > from;
      note(`Step: ${name}`, shown && !threw, !drew ? why : !shown ? "its page did not appear" : threw ? "page threw: " + thrown(from) : "");
    }

    // 3. Monitor/Vote on the live network.
    from = fresh();
    await run("api = window.__real; await api('monitorSaveNodes', { nodes: [] }); showMonitor(); return 1;");
    const mon = await until("document.querySelector('.mon-doors') && !document.querySelector('.mon-door-figure .chain-mini')", 90);
    note("Monitor/Vote opens on the live network", mon && errors.length === from, !mon ? "it did not finish reading the network" : errors.length > from ? "page threw: " + thrown(from) : "");
    await run("clearSession(); doneSteps.clear(); return 1;").catch(() => {});
  } catch (e) {
    note("the walkthrough", false, String(e.message).split("\n")[0]);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `${failed.length} of ${results.length} FAILED` : `all ${results.length} passed`}`);
  try {
    if (child) {
      const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (bws.onopen = r));
      bws.send(JSON.stringify({ id: 1, method: "Browser.close" })); await sleep(1500);
    }
  } catch (_) { /* closed already */ }
  if (child && child.exitCode === null) child.kill();
  ws.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("check-host-setup could not finish:", e.message); process.exit(2); });
