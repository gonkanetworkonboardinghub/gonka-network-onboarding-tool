/**
 * check-steps.js — does Host Setup keep its place when a person moves around it?
 *
 *   node scripts/check-steps.js
 *
 * A real run on 2026-11-12 (a rented 2 × H200 server) showed what the page-by-
 * page walk of check-host-setup.js cannot: the launch sequence stopped the
 * moment an earlier page was looked at (its own page was gone, which threw)
 * and that other page was marked red; a provider's "ssh -i <private-key-path>
 * user@host" switched the login to a key file that does not exist; Continue on
 * Verify opened as soon as the node was registered, long before it was ready;
 * the countdown stood still and jumped. This drives the hidden test copy
 * (dist/hidden-app) through those, with a made-up server that answers at once:
 *
 *   - a long step carries on, and ends on its own step, while another page shows;
 *   - a failure belongs to its step and is said on its page;
 *   - a pasted SSH command fills in the address and the user, never a key that is not there;
 *   - no way on from Model weights or Verify before they are done;
 *   - the wallet says what fees a node pays, as measured, and how long 1 GNK lasts;
 *   - the countdown never stands still or runs backwards, and says when the round starts;
 *   - Finished can be closed, and an earlier setup is asked about first, on its own.
 *
 * Nothing is sent to any server and nothing is signed. Closes the copy it
 * started. Exit 1 = a check failed.
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
const OTHER = wallet.addressOf(wallet.pubOf(crypto.randomBytes(32)));

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
  let answerYes = true; const dialogs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
    // "Are you sure?" questions: what was asked is kept, and the answer is whatever the check wants (yes unless said otherwise).
    if (d.method === "Page.javascriptDialogOpening") { dialogs.push(d.params.message); ws.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: answerYes } })); } };
  const send = (method, params) => new Promise((r, no) => { const n = ++id; const timer = setTimeout(() => { waiting.delete(n); no(new Error(`no answer from the page in 60 seconds (${method})`)); }, 60000); waiting.set(n, (d) => { clearTimeout(timer); r(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (e) => { const d = await send("Runtime.evaluate", { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true }); if (d.result.exceptionDetails) throw new Error((d.result.exceptionDetails.exception && d.result.exceptionDetails.exception.description) || d.result.exceptionDetails.text); return d.result.result.value; };
  const until = async (cond, tries = 50) => { for (let i = 0; i < tries; i++) { try { if (await run(`return !!(${cond})`)) return true; } catch (_) {} await sleep(200); } return false; };
  const thrown = (from) => errors.slice(from).map((x) => String(x).split("\n")[0]).join(" | ").slice(0, 300);

  try {
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.reload", { ignoreCache: true }); await sleep(3000);
    const up = await until("document.querySelector('#tool-host') && typeof RENDER !== 'undefined' && typeof STEP !== 'undefined'", 80);
    note("the app opens", up);
    if (!up) throw new Error("the app did not open");
    await run(`window.I18N.set("en"); return 1;`);

    // A made-up server that answers at once, and a made-up setup that is under way.
    await run(`
      window.__real = window.__real || api; const real = window.__real;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__calls = []; window.__fail = null; window.__warm = { existed: true, address: "gonka1warm" };
      window.__sync = { height: 100, catchingUp: true, snapshot: null };
      window.__ml = { gpuTotal: 2, gpuReady: 0, weightsReady: false, state: "STOPPED" };
      window.__bal = 1000000000; window.__fileExists = false; window.__nodes = [];
      window.__fb = { covers: true, budget: 60000000, spendable: 900000000, known: true, biggest: false };
      window.__grant = { found: true, left: 10000000000, expires: "2027-11-13T22:29:56.697Z", over: false };
      window.__usual = { asOf: "2026-11-13T01:09:48Z", hours: 22.1, hosts: 25, small: { hosts: 13, low: 0, high: 62400000, typical: 22100000 }, most: 382500000 };
      const fake = {
        archPreflight: async () => ({ bad: [] }),
        pull: async () => { __calls.push("pull"); await wait(250); return true; },
        startCore: async () => { __calls.push("core"); await wait(250); return true; },
        createWarmKey: async () => { __calls.push("warm"); return __warm; },
        registerHost: async () => { __calls.push("register"); return { ok: true }; },
        grant: async () => { __calls.push("grant"); await wait(150); return true; },
        launchAll: async () => { __calls.push("launch"); await wait(250); if (__fail) throw new Error(__fail); return { ok: true }; },
        downloadWeights: async () => { __calls.push("weights"); await wait(300); return true; },
        participant: async () => ({ participant: { address: ${JSON.stringify(ADDR)}, inferenceUrl: "http://203.0.113.7:8000", status: "ACTIVE" } }),
        containers: async () => "api   Up 3 minutes", probe: async () => ({ reachable: true }),
        nodeSync: async () => __sync, chainHeight: async () => ({ height: 7030000, time: Date.now() - 2000 }),
        mlnode: async () => __ml, epochParticipants: async () => [],
        feeBudget: async () => __fb, typicalFees: async () => __usual,
        allowanceLeft: async () => { if (__grant === "fails") throw new Error("the network did not answer"); return __grant; },
        balance: async () => __bal, keyNames: async () => ["gonka-account-key"], ensureCli: async () => true,
        keyShow: async () => ({ address: ${JSON.stringify(ADDR)}, pubkey: ${JSON.stringify(PUB)} }),
        sshKeyInfo: async () => null, fileExists: async () => __fileExists,
        monitorNodes: async () => __nodes.map((n) => ({ ...n })), monitorSaveNodes: async (a) => { __nodes = a.nodes; return a.nodes; },
        nextPoc: () => new Promise(() => {}), seed: async () => "http://node1.gonka.ai:8000",
        disconnect: async () => { localStorage.setItem("gnot-check-disconnected", "1"); return true; }
      };
      api = async (fn, args) => (fn in fake ? fake[fn](args) : real(fn, args));
      window.__setup = () => {
        clearSession(); doneSteps.clear(); errorSteps.clear(); S.problems = {}; S.tasks = {}; S.warmPending = null;
        S.sessionOffered = null; S.resumeTo = null; S.furthest = 0;
        S.connected = true; S.mode = "ssh"; S.launched = false; S.weightsDone = false; S.verifyReady = false; S.verifyEarning = false; S.registeredVisible = false;
        Object.assign(S.ssh, { host: "203.0.113.7", port: 22, username: "root", auth: "key", privateKeyPath: "", generated: null, sshPeeked: true });
        S.wallet = { name: "gonka-account-key", address: ${JSON.stringify(ADDR)}, pubkey: ${JSON.stringify(PUB)}, confirmed: true, passphrase: "x" };
        S.net = { ...S.net, scheme: "http", host: "203.0.113.7" };
        S.models = ["deepseek-ai/DeepSeek-V4-Flash-0731"];
        __calls.length = 0; __fail = null; __warm = { existed: true, address: "gonka1warm" };
      };
      document.querySelector('#tool-host').click();
      return 1;`);

    // ---- 1. The launch sequence, with another page showing -------------------
    let from = errors.length;
    await run(`__setup(); for (let k = 0; k < STEP.deploy; k++) doneSteps.add(k); go(STEP.deploy); document.querySelector("#b-run").click(); return 1;`);
    await sleep(150);
    await run(`go(STEP.mode); return 1;`);                       // look back at an earlier page, mid-run
    const idle = await until("!S.consoleBusy", 60);
    let r = await run(`return { launched: S.launched, calls: __calls.join(","), done: doneSteps.has(STEP.deploy), red: [...errorSteps].map((i) => STEPS[i].id).join(","), step: STEPS[S.step].id };`);
    note("launch: carries on to the end while another page is showing", idle && r.launched && /launch$/.test(r.calls) && r.done, `ran: ${r.calls}`);
    note("launch: no page is marked red, and the page showing stays", r.red === "" && r.step === "mode", r.red ? "marked red: " + r.red : "");
    await run(`go(STEP.deploy); return 1;`);
    r = await run(`return { done: document.querySelectorAll("#stage .task.done").length, next: !document.querySelector("#b-next").disabled };`);
    note("launch: its page shows all six lines done, and Continue open, when opened again", r.done === 6 && r.next, `${r.done} of 6 done`);
    note("launch: nothing threw", errors.length === from, thrown(from));

    // ---- 2. A failure while another page is showing ------------------------
    from = errors.length;
    await run(`__setup(); for (let k = 0; k < STEP.deploy; k++) doneSteps.add(k); __fail = "Full launch failed: Port 9200 on your server is already used by node_exporter, and Gonka needs it.\\n\\nStop that program, then press Run launch sequence again. In the command line under the activity log:\\n\\nsudo systemctl disable --now node_exporter.service";
      go(STEP.deploy); document.querySelector("#b-run").click(); return 1;`);
    await sleep(150);
    await run(`go(STEP.review === undefined ? STEP.mode : STEP.mode); return 1;`);
    await until("!S.consoleBusy", 60);
    r = await run(`return { red: [...errorSteps].map((i) => STEPS[i].id).join(","), kept: !!(S.problems && S.problems[STEP.deploy]), card: !!document.querySelector("#stage .problem-card") };`);
    note("failure: only Launch & register is marked red", r.red === "deploy", "red: " + (r.red || "none"));
    note("failure: nothing is said on the page that happens to be showing", r.kept && !r.card);
    await run(`go(STEP.deploy); return 1;`);
    r = await run(`return { card: (document.querySelector("#deploy-extra .problem-card") || {}).innerText || "", err: !!document.querySelector("#task-launch.err"), run: !document.querySelector("#b-run").disabled };`);
    note("failure: said on its own page when that is opened, with the line that failed", /Port 9200/.test(r.card) && r.err && r.run, r.card.replace(/\s+/g, " ").slice(0, 110));
    note("failure: the command to run is in plain sight, not folded under Details", /sudo systemctl disable --now node_exporter\.service/.test(r.card));
    note("failure: nothing threw", errors.length === from, thrown(from));

    // ---- 3. The server key's phrase waits for its page ----------------------
    from = errors.length;
    await run(`__setup(); for (let k = 0; k < STEP.deploy; k++) doneSteps.add(k);
      __warm = { existed: false, address: "gonka1warm", mnemonic: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu" };
      go(STEP.deploy); document.querySelector("#b-run").click(); return 1;`);
    await sleep(150);
    await run(`go(STEP.mode); return 1;`);
    const held = await until("typeof S.warmPending === 'function'", 40);
    r = await run(`return { busy: S.consoleBusy, calls: __calls.join(",") };`);
    note("server key: the sequence waits with its backup phrase instead of failing", held && r.busy && !/register/.test(r.calls), `ran so far: ${r.calls}`);
    await run(`go(STEP.deploy); return 1;`);
    const shown = await until("document.querySelector('#b-warm-ok')", 20);
    await run(`document.querySelector("#b-warm-ok").click(); return 1;`);
    await until("!S.consoleBusy", 60);
    r = await run(`return { launched: S.launched, red: errorSteps.size };`);
    note("server key: shown on its page when that is opened, and the launch then finishes", shown && r.launched && r.red === 0);
    note("server key: nothing threw", errors.length === from, thrown(from));

    // ---- 4. A pasted SSH command -----------------------------------------
    from = errors.length;
    const paste = async (cmd) => { await run(`const el = document.querySelector("#f-sshcmd"); el.value = ${JSON.stringify(cmd)}; el.oninput({ target: el }); return 1;`); await sleep(250);
      return run(`return { auth: S.ssh.auth, host: S.ssh.host, user: S.ssh.username, port: S.ssh.port, key: document.querySelector("#f-keypath").value };`); };
    await run(`__setup(); S.connected = false; S.ssh.host = ""; S.ssh.username = ""; S.ssh.auth = "create"; S.ssh.generated = { publicKey: "ssh-ed25519 AAAATEST gnot", privatePath: "C:\\\\keys\\\\gnot_ed25519" }; S.ssh.privateKeyPath = S.ssh.generated.privatePath; go(STEP.connect); return 1;`);
    r = await paste("ssh -i <private-key-path> ubuntu@217.18.55.44");
    note("SSH paste: Spheron's command fills in the address and the user", r.host === "217.18.55.44" && r.user === "ubuntu", `${r.user}@${r.host}`);
    note("SSH paste: it keeps the key made in GNOT, and no placeholder goes into the key box", r.auth === "create" && !/[<>]/.test(r.key), `login: ${r.auth}, key box: "${r.key}"`);
    await run(`__fileExists = true; return 1;`);
    r = await paste("ssh -i ~/.ssh/id_ed25519 -p 2222 root@203.0.113.9");
    note("SSH paste: not even a real key file replaces the key made in GNOT", r.auth === "create" && r.port === 2222 && r.host === "203.0.113.9", `login: ${r.auth}`);
    await run(`__fileExists = false; S.ssh.generated = null; S.ssh.auth = "password"; S.ssh.privateKeyPath = ""; go(STEP.connect); return 1;`);
    r = await paste("ssh -i <private-key-path> ubuntu@217.18.55.44");
    note("SSH paste: with no key made in GNOT, a placeholder still changes nothing about the login", r.auth === "password" && r.key === "", `login: ${r.auth}, key box: "${r.key}"`);
    r = await paste("ssh -i ~/.ssh/nothing-here root@203.0.113.9");
    note("SSH paste: a key file that is not on this computer is not taken", r.auth === "password" && r.key === "");
    await run(`__fileExists = true; return 1;`);
    r = await paste("ssh -i ~/.ssh/id_ed25519 root@203.0.113.9");
    note("SSH paste: a key file that is on this computer is taken, and the login switches to it", r.auth === "key" && r.key === "~/.ssh/id_ed25519", `login: ${r.auth}, key box: "${r.key}"`);
    note("SSH paste: nothing threw", errors.length === from, thrown(from));

    // ---- 5. No way on before a step is done --------------------------------
    from = errors.length;
    await run(`__setup(); for (let k = 0; k < STEP.weights; k++) doneSteps.add(k); go(STEP.weights); return 1;`);
    r = await run(`return { closed: document.querySelector("#b-skip").disabled, label: document.querySelector("#b-skip").textContent.trim(), said: !document.querySelector("#weights-gate").hidden };`);
    note("Model weights: Continue is closed until the model is on the server, and says why", r.closed && r.label === "Continue" && r.said, `button: "${r.label}"`);
    await run(`document.querySelector("#b-dl").click(); return 1;`);
    await until("!S.consoleBusy && S.weightsDone", 40);
    r = await run(`return { open: !document.querySelector("#b-skip").disabled, done: doneSteps.has(STEP.weights) };`);
    note("Model weights: it opens once the download has finished", r.open && r.done);

    await run(`__setup(); for (let k = 0; k < STEP.verify; k++) doneSteps.add(k); __sync = { height: 100, catchingUp: true, snapshot: null }; __ml = { gpuTotal: 2, gpuReady: 0, weightsReady: false, state: "STOPPED" }; go(STEP.verify); return 1;`);
    const reg = await until("document.querySelector('#v-card .pill.ok') && document.querySelector('#sync-meter') && document.querySelector('#sync-meter').children.length > 1", 50);
    r = await run(`return { closed: document.querySelector("#b-next").disabled, done: doneSteps.has(STEP.verify), dash: !!document.querySelector("#b-dash-orig"), own: !!document.querySelector("#b-dash-own") };`);
    note("Verify: registered is not ready, so Continue stays closed and the step is not ticked", reg && r.closed && !r.done);
    note("Verify: only Monitor/Vote is offered, no other dashboard", !r.dash && r.own);
    await run(`__sync = { height: 7030000, catchingUp: false, snapshot: null }; __ml = { gpuTotal: 2, gpuReady: 2, weightsReady: true, state: "INFERENCE" };
      if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; } document.querySelector("#b-re").click(); return 1;`);
    const ready = await until("S.verifyReady && document.querySelector('#b-next') && !document.querySelector('#b-next').disabled", 50);
    r = await run(`return { done: doneSteps.has(STEP.verify) };`);
    note("Verify: Continue opens, and the step is ticked, once the node is ready", ready && r.done);
    await run(`if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; } return 1;`);
    note("gates: nothing threw", errors.length === from, thrown(from));

    // ---- 6. The wallet: fees as measured -----------------------------------
    from = errors.length;
    await run(`__setup(); for (let k = 0; k < STEP.wallet; k++) doneSteps.add(k); __bal = 1000000000; go(STEP.wallet); return 1;`);
    const funded = await until("document.querySelector('#bal-area .pill.ok')", 50);
    r = await run(`return document.querySelector("#bal-area").innerText;`);
    note("Wallet: 1 GNK counts as funded, and the page says about how many epochs it lasts", funded && /about 45 epochs/.test(r), r.replace(/\s+/g, " ").slice(0, 150));
    await run(`__bal = 300000000; go(STEP.wallet); return 1;`);
    const part = await until("document.querySelector('#bal-area .pill.warn') && /0\\.0221/.test(document.querySelector('#bal-area').innerText)", 50);
    r = await run(`return document.querySelector("#bal-area").innerText.replace(/\\s+/g, " ");`);
    note("Wallet: under that, it says what such a node paid last epoch and how long 1 GNK lasts", part && /typically paid 0\.0221 GNK, so 1 GNK lasts about 45 epochs/.test(r) && /a reserve that lasts a long time/.test(r), r.slice(0, 120));
    await run(`S.balPoll && clearInterval(S.balPoll); S.balTick && clearInterval(S.balTick); return 1;`);
    note("Wallet: nothing threw", errors.length === from, thrown(from));

    // ---- 7. The countdown --------------------------------------------------
    from = errors.length;
    r = await run(`
      const base = { phase: "Inference", epoch: 456, secPerBlock: 5.3, secPerBlockNow: 5.3, totalBlocks: 15391, nextStart: 7045042 };
      const shownNow = () => pocState.etaMs - (Date.now() - pocState.at);
      // The chain now says 8 seconds more than the clock shows: it must not jump back or stand still.
      pocState = { ...base, etaMs: 60000, at: Date.now() }; pocTrue = { ...base, etaMs: 68000, at: Date.now() }; renderEpochBar(true);
      const seen = [], texts = [];
      for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 250)); seen.push(shownNow()); texts.push(document.querySelector("#epoch-text").textContent); }
      const never = seen.every((v, i) => i === 0 || v < seen[i - 1]);
      const secs = texts.map((x) => Number((x.match(/(\\d\\d)s/) || [])[1]));
      const noBack = secs.every((v, i) => i === 0 || v <= secs[i - 1]);
      const closer = (pocTrue.etaMs - (Date.now() - pocTrue.at)) - shownNow();
      // A big difference (another epoch) is taken at once.
      pocTrue = { ...base, etaMs: 76000000, at: Date.now() }; renderEpochBar();
      const snapped = Math.abs(shownNow() - 76000000) < 2000;
      // At zero it says the round is starting.
      pocState = { ...base, etaMs: 0, at: Date.now() }; pocTrue = { ...pocState }; renderEpochBar(true);
      const zero = document.querySelector("#epoch-text").textContent;
      pocState = { ...base, etaMs: 3723000, at: Date.now() }; pocTrue = { ...pocState }; renderEpochBar(true);
      const hms = document.querySelector("#epoch-text").textContent;
      return { never, noBack, closer: Math.round(closer), secs: secs.join(","), snapped, zero, hms };`);
    note("countdown: steered towards a later reading, it never stands still or runs backwards", r.never && r.noBack && r.closer < 8000 && r.closer > 6000, `seconds shown: ${r.secs}; still ${r.closer} ms apart`);
    note("countdown: a big change (another epoch) is taken at once", r.snapped);
    note("countdown: at zero it says the Proof of Compute is starting", /Proof of Compute is starting/.test(r.zero) && !/00m 00s/.test(r.zero), r.zero);
    note("countdown: hours, minutes and seconds read right", /1h 02m 0[23]s/.test(r.hms), r.hms);
    note("countdown: nothing threw", errors.length === from, thrown(from));

    // ---- 8. Finished, and an earlier setup asked about first -----------------
    from = errors.length;
    await run(`__setup(); __nodes = [{ address: ${JSON.stringify(OTHER)}, name: "My node" }]; for (let k = 0; k < STEP.done; k++) doneSteps.add(k); go(STEP.done); return 1;`);
    await sleep(600);
    r = await run(`return { finish: !!document.querySelector("#b-finish"), again: !!document.querySelector("#b-again"), dash: !!document.querySelector("#d-dash"), n: document.querySelector("#rail-progress-n").textContent.trim(),
      text: document.querySelector("#stage").innerText, names: __nodes.map((n) => n.name).join(" | ") };`);
    note("Finished: Finish and Set up another node are both there", r.finish && r.again);
    note("Finished: no other dashboard is offered", !r.dash && !/network dashboard/i.test(r.text));
    note("Finished: the steps read 13 of 13", r.n === "13 / 13", r.n);
    note("Finished: the new node gets a name of its own in My nodes", r.names === "My node 2 | My node", r.names);

    await run(`const saved = JSON.parse(localStorage.getItem(SESSION_KEY)); __savedDone = saved;
      S.connected = false; doneSteps.clear(); S.step = 0; S.furthest = 0; RENDER.welcome(); return 1;`);
    r = await run(`const kids = [...document.querySelector("#stage").children]; return { first: !!document.querySelector(".resume-first"), showing: kids.filter((k) => !k.hidden).length, all: kids.length,
      text: (document.querySelector(".resume-first") || {}).innerText || "" };`);
    note("picking up: a finished setup is asked about first, alone on the page", r.first && r.showing === 1 && r.all > 3 && /Continue where I left off/.test(r.text) && /Set up another node/.test(r.text), `${r.showing} of ${r.all} blocks showing`);
    await run(`document.querySelector("#b-resume").click(); return 1;`);
    await sleep(400);
    r = await run(`return { step: STEPS[S.step].id, finish: !!document.querySelector("#b-finish") };`);
    note("picking up: Continue goes straight to the Finished page", r.step === "done" && r.finish, r.step);

    await run(`localStorage.setItem(SESSION_KEY, JSON.stringify({ ...__savedDone, step: STEP.deploy, furthest: STEP.deploy, done: [0, 1, 2, 3, 4, 5, 6, 7, 8] }));
      S.connected = false; doneSteps.clear(); S.sessionOffered = null; S.step = 0; S.furthest = 0; RENDER.welcome(); return 1;`);
    r = await run(`const kids = [...document.querySelector("#stage").children]; return { showing: kids.filter((k) => !k.hidden).length, text: (document.querySelector(".resume-first") || {}).innerText || "" };`);
    note("picking up: an unfinished setup is asked about the same way", r.showing === 1 && /Launch & register/.test(r.text) && /Start over/.test(r.text), r.text.replace(/\s+/g, " ").slice(0, 90));
    await run(`document.querySelector("#b-fresh").click(); return 1;`);
    r = await run(`const kids = [...document.querySelector("#stage").children]; return { hidden: kids.filter((k) => k.hidden).length, bar: !!document.querySelector(".resume-first"), start: !!document.querySelector("#b-start"), saved: localStorage.getItem(SESSION_KEY) };`);
    note("picking up: Start over shows the first step, with nothing kept", r.hidden === 0 && !r.bar && r.start && !r.saved);
    note("Finished and picking up: nothing threw", errors.length === from, thrown(from));

    // ---- 9. Voting with a node that has no weight ---------------------------
    from = errors.length;
    r = await run(`
      MON.nodes = [{ address: ${JSON.stringify(ADDR)}, name: "My node 2", wallet: "gonka-account-key" }]; MON.keyNames = ["gonka-account-key"];
      MON.votes = { 119: [] }; MON.ballot = null; MON.overview = { hosts: [] };
      const out = monBallotHtml({ id: 119 });
      MON.overview = { hosts: [{ address: ${JSON.stringify(ADDR)} }] };
      const inEpoch = monBallotHtml({ id: 119 });
      return { warned: /mon-noweight/.test(out) && /no weight right now/.test(out) && /You can still vote/.test(out), quiet: !/mon-noweight/.test(inEpoch) };`);
    note("Votes: a node outside the epoch is told its vote has no weight now, before it votes", r.warned);
    note("Votes: a node in the epoch is not", r.quiet);
    note("Votes: nothing threw", errors.length === from, thrown(from));

    // ---- 10. Verify's fee card: judged by what hosts really pay ----------------
    // The real case of 2026-11-13: a wallet with 0.9966 GNK and an untouched
    // allowance, while the node (still catching up) said it could spend 0 and
    // gave its ceiling, 3.54 GNK, sized on the biggest host. The card said
    // NOT ENOUGH FOR FEES, and kept saying it.
    from = errors.length;
    const feeCard = async (set) => {
      await run(`${set}; const c = document.querySelector("#fee-card"); if (c) delete c.dataset.state; if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; } document.querySelector("#b-re").click(); return 1;`);
      await until("document.querySelector('#fee-card') && document.querySelector('#fee-card').dataset.state", 50);
      return run(`const c = document.querySelector("#fee-card"); const tile = (label) => { const n = [...c.querySelectorAll(".need")].find((x) => x.querySelector(".need-label").textContent.trim().startsWith(label)); return n ? n.querySelector(".need-value").textContent.trim() : null; };
        return { state: c.dataset.state, text: c.innerText, pills: [...c.querySelectorAll(".pill")].map((p) => p.className.replace("pill ", "") + ":" + p.textContent.trim()).join(","), can: tile("Your node can spend"), ceiling: tile("Your node's ceiling"), old: tile("This epoch may need"), again: !!S.feePoll };`);
    };
    await run(`__setup(); for (let k = 0; k < STEP.verify; k++) doneSteps.add(k); __sync = { height: 7030000, catchingUp: false, snapshot: null }; __ml = { gpuTotal: 8, gpuReady: 8, weightsReady: true, state: "INFERENCE" }; go(STEP.verify); return 1;`);
    await until("document.querySelector('#b-re') && document.querySelector('#fee-card') && document.querySelector('#fee-card').dataset.state", 50);
    const REAL = `__bal = 996600000; __fb = { covers: false, budget: 3540000000, spendable: 0, known: true, biggest: true }; __grant = { found: true, left: 9999719389, expires: "2027-11-13T22:29:56.697Z", over: false }; __usual = { asOf: "2026-11-13T01:09:48Z", hours: 22.1, hosts: 25, small: { hosts: 13, low: 0, high: 44500000, typical: 24500000 }, most: 373600000 }`;
    r = await feeCard(REAL);
    note("fee card: 0.9966 GNK and a whole allowance are enough, whatever the node's ceiling says", r.state === "ok" && r.pills === "ok:FEES COVERED" && !/NOT ENOUGH/.test(r.text), `${r.state} · ${r.pills}`);
    note("fee card: what the node can spend is read from the chain, not from a node that is behind", r.can === "0.9966 GNK", String(r.can));
    note("fee card: the node's ceiling is shown as a ceiling, and said to be sized on the biggest host", r.ceiling === "3.54 GNK" && r.old === null && /sized for the biggest host/.test(r.text) && /does not wait for the ceiling/.test(r.text), String(r.ceiling));
    note("fee card: it says how long that lasts, and reads itself again by itself", /enough for at least 22 epochs/.test(r.text) && /lasts about 40 epochs/.test(r.text) && r.again);
    r = await feeCard(`${REAL}; __grant = { found: false }`);
    note("fee card: a wallet with GNK but no allowance is told that sending more does not help", r.state === "allowance" && r.pills === "err:ALLOWANCE USED UP" && r.can === "0 GNK" && /Sending more GNK does not help/.test(r.text) && /run the launch again/.test(r.text), `${r.state} · ${r.pills}`);
    r = await feeCard(`${REAL}; __grant = { found: true, left: 9000000000, expires: "2026-01-01T00:00:00Z", over: true }`);
    note("fee card: an allowance that has run out of time counts as none", r.state === "allowance" && r.can === "0 GNK", r.state);
    r = await feeCard(`${REAL}; __bal = 20000000`);
    note("fee card: less than hosts of this size paid is not enough, with what to send", r.state === "short" && r.pills === "err:NOT ENOUGH FOR FEES" && /Send at least 0\.425 GNK/.test(r.text), `${r.state} · ${r.pills}`);
    r = await feeCard(`${REAL}; __bal = 100000000`);
    note("fee card: one epoch's worth but not ten is enough for now", r.state === "soon" && r.pills === "warn:ENOUGH FOR NOW" && /not for many more/.test(r.text), `${r.state} · ${r.pills}`);
    r = await feeCard(`${REAL}; __bal = 5000000000`);
    note("fee card: a wallet above the node's ceiling is still judged by what hosts paid, in one voice", r.state === "ok" && r.pills === "ok:FEES COVERED" && /enough for at least 112 epochs/.test(r.text) && !/lasts at least/.test(r.text), `${r.state} · ${r.pills}`);
    r = await feeCard(`${REAL}; __bal = 5000000000; __usual = null`);
    note("fee card: with nothing measured, a wallet above the node's ceiling is covered on the node's word", r.state === "ceiling" && r.pills === "ok:FEES COVERED" && /needs up to 3\.54 GNK/.test(r.text), `${r.state} · ${r.pills}`);
    r = await feeCard(`${REAL}; __grant = "fails"; __fb = { covers: false, budget: 3540000000, spendable: 900000000, known: true, biggest: true }`);
    note("fee card: when the chain cannot be read, the node's own figure is used", r.state === "ok" && r.can === "0.9 GNK", `${r.state} · ${r.can}`);
    r = await feeCard(`${REAL}; __usual = null`);
    note("fee card: with nothing measured to compare with, it says so and raises no alarm", r.state === "unknown" && r.pills === "" && /could not read what hosts paid/.test(r.text), `${r.state} · ${r.pills}`);
    await run(`clearTimeout(S.feePoll); if (S.syncPoll) { clearInterval(S.syncPoll); S.syncPoll = null; }
      __bal = 1000000000; __fb = { covers: true, budget: 60000000, spendable: 900000000, known: true, biggest: false }; __grant = { found: true, left: 10000000000, expires: "2027-11-13T22:29:56.697Z", over: false };
      __usual = { asOf: "2026-11-13T01:09:48Z", hours: 22.1, hosts: 25, small: { hosts: 13, low: 0, high: 62400000, typical: 22100000 }, most: 382500000 }; return 1;`);
    note("fee card: nothing threw", errors.length === from, thrown(from));

    // ---- 11. Start over, from any step (last: it reloads the page) -------------
    from = errors.length;
    await run(`__setup(); S.step = 0; go(0); return 1;`);
    r = await run(`const b = document.querySelector("#rail-restart"); return { there: !!b, hidden: b && b.hidden };`);
    note("Start over: not offered on an untouched first page", r.there && r.hidden);
    await run(`for (let k = 0; k < STEP.wallet; k++) doneSteps.add(k); go(STEP.wallet); return 1;`);
    const everywhere = await run(`const seen = []; for (const s of STEPS.slice(1)) { S.step = STEP[s.id]; renderRail(); const b = document.querySelector("#rail-restart"); seen.push(!b.hidden && b.textContent.trim() === "Start over"); } S.step = STEP.wallet; renderRail(); return seen.every(Boolean) ? seen.length : 0;`);
    note("Start over: there on every later step", everywhere === 12, `${everywhere} of 12 steps`);
    answerYes = false; dialogs.length = 0;
    await run(`document.querySelector("#rail-restart").click(); return 1;`);
    await sleep(400);
    r = await run(`return { saved: !!localStorage.getItem(SESSION_KEY), step: STEPS[S.step].id, leaving: !!S.leaving, connected: S.connected };`);
    note("Start over: it asks first, and says nothing on the server is touched", dialogs.length === 1 && /Stop this setup and start over\?/.test(dialogs[0]) && /Nothing on your server is removed or stopped/.test(dialogs[0]) && !/still running/.test(dialogs[0]) && !/Shut down safely/.test(dialogs[0]), (dialogs[0] || "").replace(/\s+/g, " ").slice(0, 90));
    note("Start over: answering no changes nothing", r.saved && r.step === "wallet" && !r.leaving && r.connected);
    dialogs.length = 0;
    await run(`S.consoleBusy = true; S.launched = true; document.querySelector("#rail-restart").click(); return 1;`);
    await sleep(400);
    await run(`S.consoleBusy = false; S.launched = false; return 1;`);
    note("Start over: a running step and a node already up are each named in the question", dialogs.length === 1 && /A step is still running/.test(dialogs[0]) && /does not shut it down/.test(dialogs[0]) && /Shut down safely/.test(dialogs[0]));
    note("Start over: nothing threw", errors.length === from, thrown(from));
    answerYes = true; dialogs.length = 0;
    await run(`localStorage.removeItem("gnot-check-disconnected"); document.querySelector("#rail-restart").click(); return 1;`).catch(() => {});
    // The page starts again: wait for the new one (it no longer has this check's stand-ins).
    const back = await until("typeof RENDER !== 'undefined' && typeof STEP !== 'undefined' && !window.__real && document.querySelector('#b-start')", 120);
    // (The new page saves its own blank start, so "forgotten" means: nothing of the old setup is in it.)
    r = back ? await run(`const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); return { kept: s ? (s.step || 0) + (s.furthest || 0) + (s.done || []).length + (s.wallet && s.wallet.address ? 1 : 0) + (s.ssh && s.ssh.host ? 1 : 0) : 0,
      disc: localStorage.getItem("gnot-check-disconnected"), step: S.step, home: document.body.classList.contains("on-home"), hidden: document.querySelector("#rail-restart").hidden, done: doneSteps.size };`) : {};
    await run(`localStorage.removeItem("gnot-check-disconnected"); return 1;`).catch(() => {});
    note("Start over: answering yes ends the connection and forgets the setup", back && r.disc === "1" && r.kept === 0 && r.done === 0, back ? `connection ended: ${r.disc === "1"}, left of the old setup: ${r.kept}` : "the page did not come back");
    note("Start over: Host Setup opens again on its first step, ready for a new setup", back && r.step === 0 && !r.home && r.hidden);

    await run("if (window.__real) api = window.__real; clearSession(); doneSteps.clear(); errorSteps.clear(); return 1;").catch(() => {});
  } catch (e) {
    note("the checks", false, String(e.message).split("\n")[0]);
  }

  const failed = results.filter((x) => !x.ok);
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
})().catch((e) => { console.error("check-steps could not finish:", e.message); process.exit(2); });
