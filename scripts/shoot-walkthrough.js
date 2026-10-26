// The website's step-by-step pictures: every Host Setup step in the hidden test
// copy, with made-up but realistic server answers for an 8× H100 server
// (documentation IP 203.0.113.7, a wallet made up on the spot), the whole app
// window, sharp (2×), as WebP. Each picture is refused if anything private
// shows: this computer's user name, a recovery phrase, a real key path.
//   node scripts/shoot-walkthrough.js <outdir>
// with the hidden test copy running (dist/hidden-app, DevTools on port 9336).
// The pictures are uploaded to the website through Base44, not kept here.
const fs = require("fs"), crypto = require("crypto");
const wallet = require("../src/services/wallet.js");
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priv = crypto.randomBytes(32);
const ADDR = wallet.addressOf(wallet.pubOf(priv));
const PUB = Buffer.from(wallet.pubOf(priv)).toString("base64");
// Nothing about whoever runs this may show: their user name (read here, never written
// into this file), or any Windows user folder other than the example one.
const ME = require("os").userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRIVATE = new RegExp(`${ME}|\\\\Users\\\\(?!you\\\\)`, "i");
const W = 1360, H = 900;

(async () => {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch("http://127.0.0.1:9336/json")).json()).find((t) => t.type === "page" && t.url.includes("/renderer/")); } catch (_) {}
    if (!page) await sleep(500);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text); };
  const send = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (e) => { const d = await send("Runtime.evaluate", { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true }); if (d.result.exceptionDetails) throw new Error(d.result.exceptionDetails.exception ? d.result.exceptionDetails.exception.description : d.result.exceptionDetails.text); return d.result.result.value; };
  const until = async (cond, tries = 60) => { for (let i = 0; i < tries; i++) { if (await run(`return !!(${cond})`)) return true; await sleep(400); } return false; };
  const shot = async (name, scrollSel) => {
    await run(`toggleConsole(false); document.querySelectorAll('#stage details.more').forEach((d) => d.open = false); const s = document.querySelector('#stage'); const m = s && s.closest('main, .main, #main') || document.scrollingElement; ${scrollSel
      ? `const e = document.querySelector(${JSON.stringify(scrollSel)}); if (e) e.scrollIntoView({ block: "start", behavior: "instant" });`
      : `(document.querySelector('#stage') || document.body).scrollIntoView({ block: "start" }); document.querySelectorAll('*').forEach((x) => { if (x.scrollTop > 0) x.scrollTo({ top: 0, behavior: "instant" }); });`} return 1;`);
    await sleep(700);
    // Nothing private may show, in the text or in any field.
    const leak = await run(`const t = document.body.innerText + " " + [...document.querySelectorAll('input, textarea')].map((i) => i.value).join(" "); const m = t.match(${PRIVATE}); return m ? m[0] + " … " + t.slice(Math.max(0, m.index - 60), m.index + 60) : null;`);
    if (leak) throw new Error(`private text on "${name}": ${leak}`);
    for (let a = 0; a < 4; a++) {
      const d = await Promise.race([send("Page.captureScreenshot", { format: "webp", quality: 90 }), sleep(9000).then(() => ({}))]);
      if (d.result && d.result.data) { fs.writeFileSync(`${OUT}/${name}.webp`, Buffer.from(d.result.data, "base64")); console.log(`   ${name}.webp`); return; }
      await run("document.body.style.opacity = '0.999'; await new Promise(r => setTimeout(r, 60)); document.body.style.opacity = ''; return 1;");
    }
    console.log(`   (no picture: ${name})`);
  };

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await send("Page.reload", { ignoreCache: true }); await sleep(3000);
  await until("document.querySelector('#tool-host') && typeof RENDER !== 'undefined'");
  await run(`window.I18N.set("en"); THEME.set && THEME.set("grey"); return 1;`);

  // 1. The first page: pick a whole 8× H100 server for DeepSeek.
  await run("clearSession(); doneSteps.clear(); S.furthest = 0; document.querySelector('#tool-host').click(); clearSession(); S.step = 0; renderRail(); RENDER.welcome(); return 1;");
  await until("[...document.querySelectorAll('#stage .gpu-chip')].some((c) => c.dataset.per === '4' && c.dataset.gpu === 'H100')", 80);
  // Picking jumps to "What your server needs"; the first picture shows the top, so no jump.
  await run("window.__siv = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function () {}; const c = [...document.querySelectorAll('#stage .gpu-chip')].find((c) => c.dataset.per === '4' && c.dataset.gpu === 'H100' && /DeepSeek/.test(c.dataset.model)); pickSetup(c); return 1;");
  await sleep(1800);
  await shot("01-welcome");
  await run("Element.prototype.scrollIntoView = window.__siv; return 1;");
  await shot("02-welcome-needs", "#needs-card");

  // Made-up answers for everything that would need the server.
  const H100 = { name: "NVIDIA H100 80GB HBM3", vramMiB: 81559 };
  const scan = { ok: false, facts: { gpus: Array.from({ length: 8 }, () => H100), gpuClass: "H100", publicIp: "203.0.113.7", ramGB: 1512, cuda: "13.0", driverVersion: "580.126.09", hasApt: true },
    items: [
      { id: "os", label: "Operating system", status: "pass", detail: "Ubuntu 22.04.5 LTS (x86_64)" },
      { id: "cpu", label: "CPU cores (need 16+)", status: "pass", detail: "192 cores detected" },
      { id: "ram", label: "RAM (need 64+ GB)", status: "pass", detail: "1512 GB detected" },
      { id: "disk", label: "Free disk (need ~1000 GB, plus model weights)", status: "pass", detail: "3150 GB free on /" },
      { id: "git", label: "git installed", status: "pass", detail: "" },
      { id: "docker", label: "Docker installed", status: "fail", detail: "Docker is required to run all Gonka services.", fixable: true },
      { id: "gpu", label: "NVIDIA GPU(s)", status: "pass", detail: "8× NVIDIA H100 80GB HBM3 — 637 GB total VRAM" },
      { id: "gpu-health", label: "All GPUs responding to the driver", status: "pass", detail: "8 of 8" },
      { id: "ram-vram", label: "RAM ≥ 1.5× VRAM (956 GB)", status: "pass", detail: "1512 GB RAM vs 637 GB VRAM" },
      { id: "cuda", label: "CUDA 13, or 12.9", status: "pass", detail: "CUDA 13.0 detected — Gonka's main ML node image runs on it" },
      { id: "nvidia-toolkit", label: "NVIDIA Container Toolkit", status: "fail", detail: "Required so Docker containers can use the GPU.", fixable: true },
      { id: "hf-cli", label: "Hugging Face CLI (weights downloader)", status: "fail", detail: "", fixable: true },
      { id: "ports", label: "Internal ports not publicly exposed", status: "pass", detail: "" }] };
  await run(`
    window.__real = window.__real || api; const real = window.__real;
    const files = (await real("repoGpuConfigs")).map((r) => r.file);
    const cfg = JSON.stringify([{ id: "node1", host: "inference", inference_port: 5000, poc_port: 8080, max_concurrent: 500,
      models: { "deepseek-ai/DeepSeek-V4-Flash-0731": { args: ["--tensor-parallel-size", "4", "--gpu-memory-utilization", "0.85"] } } }], null, 2);
    const fake = {
      scan: ${JSON.stringify(scan)},
      clone: true, listNodeConfigs: files, rankConfigs: files.map((f) => ({ file: f })),
      readRepoFile: (a) => a.rel === "config.env.template" ? "" : cfg,
      modelsIn: ["deepseek-ai/DeepSeek-V4-Flash-0731"], serverKeyName: null,
      genEnv: "export KEY_NAME=gonka-node\\nexport PUBLIC_URL=http://203.0.113.7:8000\\nexport HF_HOME=/mnt/shared\\n",
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
    return 1;`);

  const steps = [
    ["03-your-server", "mode", "#stage .c-title"],
    ["04-connect", "connect", "#b-conn"],
    ["05-health-check", "scan", ".scan-sum"],
    ["06-wallet", "wallet", "#bal-live, #stage .pill"],
    ["07-network", "network", "#net-form .card"],
    ["08-model", "model", ".model-list"],
    ["09-review", "review", ".need-grid, #stage pre, #stage textarea"],
    ["10-weights", "weights", "#stage .card"],
    ["11-launch", "deploy", "#stage .card"],
    ["12-collateral", "collateral", "#b-dep, #stage .warn-banner, #stage .info-banner"],
    ["13-verify", "verify", "#fee-card .need-grid"],
    ["14-finished", "done", "#stage .after-setup"]
  ];
  for (const [name, step, ready] of steps) {
    const before = errors.length;
    await run(`const i = STEPS.findIndex((s) => s.id === ${JSON.stringify(step)}); S.step = i; doneSteps.clear(); for (let k = 0; k < i; k++) doneSteps.add(k); renderRail(); RENDER[${JSON.stringify(step)}](); return 1;`);
    
    const ok = await until(ready.split(", ").map((r) => `document.querySelector(${JSON.stringify(r.startsWith("#stage") ? r : "#stage " + r)})`).join(" || "), 50);
    await sleep(1500);
    await shot(name);
    console.log(`${name.padEnd(18)} ${ok ? "ok" : "NOT READY"} ${errors.length > before ? "ERRORS " + errors.slice(before).join(" | ").slice(0, 300) : ""}`);
  }

  // After setup: the node's place in Gonka Host Monitor/Vote.
  await run("api = window.__real; await api('monitorSaveNodes', { nodes: [] }); showMonitor(); return 1;");
  await until("document.querySelector('.mon-doors') && !document.querySelector('.mon-door-figure .chain-mini')", 80);
  await sleep(1000);
  await shot("15-monitor");
  await run("clearSession(); doneSteps.clear(); return 1;");
  await send("Emulation.clearDeviceMetricsOverride");
  console.log("page errors:", errors.length ? errors : "none");
  ws.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
