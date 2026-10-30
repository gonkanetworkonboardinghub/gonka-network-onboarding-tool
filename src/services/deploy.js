/**
 * deploy.js — everything that runs on the SERVER, in the documented order:
 *
 *   clone → harden compose ports → write configs → pull images →
 *   start tmkms + node → create warm key (once!) → register host →
 *   [local grant happens in keys.js] → full launch → weights → verify
 */
const K = require("../knowledge");
const { shq } = require("../executor");

const JOIN = () => K.get().repo.joinDir; // e.g. gonka/deploy/join

async function cloneRepo(driver, onData) {
  const k = K.get();
  // Shallow clone: latest files only, several times faster than full history.
  // Depth grows to 50 when a pin (repo.checkout) is set, so the pinned
  // ancestor commit is actually present in the shallow history.
  // rm -rf first when there's no .git: an interrupted clone (network outage,
  // timeout kill) leaves a half-written directory that blocks every retry
  // with "destination path already exists".
  const cleanBranch = k.repo.branch.replace(/[^A-Za-z0-9._\/-]/g, "");
  // With a pin, fetch exactly that ref (works for tags and commits) and check
  // out FETCH_HEAD — no need for deep history.
  const ref = k.repo.checkout || k.repo.branch;
  // `git reset --hard` BEFORE checkout: the wizard's own port-hardening edits
  // the compose files in place, and git refuses to switch branches while
  // tracked files are modified ("local changes would be overwritten").
  // Deliberately no `git clean` — that would delete the untracked config.env
  // holding the user's keyring password.
  // A node already running from this repository is left exactly as it is:
  // the reset would put back the compose files GNOT locked down and the
  // node-config.json it wrote, ready to take effect at the next restart.
  const r = await driver.exec(
    `if [ -d gonka/.git ] && (cd ${JOIN()} 2>/dev/null && docker compose -f docker-compose.yml ps --status running --services 2>/dev/null | grep -qx node); then cd gonka && echo KEPT; ` +
    `elif [ -d gonka/.git ]; then cd gonka && git fetch --depth 1 origin ${shq(ref)} && git reset --hard && git checkout -f FETCH_HEAD && echo UPDATED; ` +
    `else rm -rf gonka && git clone --depth 1 --branch ${shq(ref)} ${shq(k.repo.url)} && cd gonka && echo CLONED; fi && ` +
    `git --no-pager log -1 --oneline`,
    { onData, timeoutMs: 300000 });
  if (!/CLONED|UPDATED|KEPT/.test(r.stdout)) throw new Error("Couldn't get the Gonka repository:\n" + (r.stderr || r.stdout).slice(-600));

  const cp = await driver.exec(
    `cd ${JOIN()} && [ -f config.env ] || cp config.env.template config.env; echo OK`);
  if (!cp.stdout.includes("OK")) throw new Error("Repo layout unexpected — config.env.template not found in " + JOIN());
  return { ok: true };
}

/** List reference node-config-*.json files shipped in the repo. */
async function listNodeConfigs(driver) {
  const r = await driver.exec(`cd ${JOIN()} && ls -1 node-config-*.json 2>/dev/null || true`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function readRepoFile(driver, rel) {
  const r = await driver.exec(`cat ${shq(JOIN() + "/" + rel)}`);
  if (r.code !== 0) throw new Error("Couldn't read " + rel);
  return r.stdout;
}

/**
 * Bind internal-only ports to 127.0.0.1 in both compose files (Case 1 of
 * the quickstart's port-security section — single-machine setup).
 * Idempotent: re-running produces the same result.
 */
async function hardenPorts(driver, onData) {
  const cmd =
    `cd ${JOIN()} && ` +
    `for f in docker-compose.yml docker-compose.mlnode.yml; do ` +
    `  [ -f "$f" ] || continue; ` +
    `  sed -i -E 's/^(\\s*)- "(9100:9100|9200:9200)"/\\1- "127.0.0.1:\\2"/' "$f"; ` +
    `  sed -i -E 's/^(\\s*)- "\\$\\{PORT:-8080\\}:8080"/\\1- "127.0.0.1:\\$\\{PORT:-8080\\}:8080"/' "$f"; ` +
    `  sed -i -E 's/^(\\s*)- "\\$\\{INFERENCE_PORT:-5050\\}:5000"/\\1- "127.0.0.1:\\$\\{INFERENCE_PORT:-5050\\}:5000"/' "$f"; ` +
    `done; ` +
    `remaining=$(grep -RnE '^\\s*- "(0\\.0\\.0\\.0:)?(9100:9100|9200:9200|\\$\\{PORT:-8080\\}:8080|\\$\\{INFERENCE_PORT:-5050\\}:5000)"' ` +
    `  docker-compose.yml docker-compose.mlnode.yml 2>/dev/null); ` +
    `if [ -z "$remaining" ]; then echo HARDENED; else echo "STILL_EXPOSED:"; echo "$remaining"; fi`;
  const r = await driver.exec(cmd, { onData });
  if (!r.stdout.includes("HARDENED")) {
    throw new Error(
      "Couldn't confirm internal ports are bound to 127.0.0.1 — the compose files may not match the " +
      "expected format:\n" + r.stdout.slice(-800));
  }
  return { ok: true, preview: r.stdout };
}

async function writeConfigs(driver, { configEnv, nodeConfigJson, gpuCount }) {
  // Home-relative join dir → resolve to absolute for sftp writes.
  const pwd = await driver.exec(`cd ${JOIN()} && pwd`);
  const abs = pwd.stdout.trim();
  if (!abs) throw new Error("Deploy folder not found — run the clone step first.");
  await driver.writeFile(abs + "/config.env", configEnv);
  await driver.writeFile(abs + "/node-config.json", nodeConfigJson);

  // Same compose adjustments the launch step applies — see ensureMlnodeCompose.
  await ensureMlnodeCompose(driver, gpuCount);
  return { ok: true, dir: abs };
}

/** Image references named by the compose files on the server. */
async function listComposeImages(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && grep -h -oE '^[[:space:]]*image:[[:space:]]*[^[:space:]]+' ` +
    `docker-compose.yml docker-compose.mlnode.yml 2>/dev/null | sed 's/.*image:[[:space:]]*//' | sort -u`);
  return (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The server's CPU architecture in Docker's naming (amd64 / arm64). */
async function serverArch(driver) {
  const r = await driver.exec("uname -m");
  const m = (r.stdout || "").trim();
  if (/^(x86_64|amd64)$/.test(m)) return "amd64";
  if (/^(aarch64|arm64)$/.test(m)) return "arm64";
  return m || "amd64";
}

async function pullImages(driver, onData) {
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose -f docker-compose.yml -f docker-compose.mlnode.yml pull`,
    { onData, timeoutMs: 60 * 60 * 1000 });
  if (r.code !== 0) throw new Error("Image pull failed:\n" + (r.stderr || "").slice(-600));
  return { ok: true };
}

/**
 * Put the growing data directories on the biggest disk.
 *
 * Gonka's compose uses RELATIVE bind mounts (`.inference:/root/.inference`),
 * so chain state, the Ethereum bridge's data and cosmovisor all land beside
 * the repo — usually the small root disk on a rented GPU box. Left alone it
 * fills up mid-state-sync ("no space left on device"), which then corrupts the
 * half-written database ("version does not exist") and crash-loops the node.
 *
 * `.tmkms` is deliberately NOT moved: it holds the consensus key, it never
 * grows, and it must never be disturbed.
 */
async function prepareDataDirs(driver, bigMount, onData) {
  if (!bigMount || bigMount === "/") return { moved: [], skipped: true };
  const base = `${bigMount.replace(/\/$/, "")}/gonka-data`;
  const dirs = [".inference", ".inference-eth", ".dapi"];
  const r = await driver.exec(
    `set -e; cd ${JOIN()}; ` +
    `SUDO=""; sudo -n true 2>/dev/null && SUDO=sudo; ` +
    `$SUDO mkdir -p ${shq(base)}; $SUDO chown "$(id -un)" ${shq(base)} 2>/dev/null || true; ` +
    dirs.map((d) =>
      // Existing real directory (e.g. a keyring already created) is moved,
      // not discarded; anything already symlinked is left alone.
      `if [ -e ${d} ] && [ ! -L ${d} ]; then $SUDO mv ${d} ${shq(base)}/${d} && ln -s ${shq(base)}/${d} ${d} && echo "moved ${d}"; ` +
      `elif [ ! -e ${d} ]; then $SUDO mkdir -p ${shq(base)}/${d} && ln -s ${shq(base)}/${d} ${d} && echo "linked ${d}"; fi; `
    ).join("") +
    `df -h . | tail -1`,
    { onData, timeoutMs: 15 * 60 * 1000 });
  return { moved: (r.stdout.match(/^(moved|linked) \S+$/gm) || []), base };
}

/** The host name in a node's address ("node1.gonka.ai"), or null when it is not a plain one. */
const hostOf = (url) => { try { const h = new URL(url).hostname; return /^[A-Za-z0-9.-]+$/.test(h) ? h : null; } catch (_) { return null; } };

/**
 * Gonka's public nodes as this SERVER reaches them, fastest first: each one is
 * asked for the genesis file, the very first thing the chain node downloads,
 * with a time limit. Only the ones that answer come back.
 *
 * On 28 October 2026 a Spheron server's chain node hung for good on that first
 * download: Gonka's `inferenced download-genesis` uses Go's http.Get, which has
 * no timeout, and node2 never answered that server (node3 answered nobody that
 * day). What answers GNOT's computer says nothing about what answers the
 * server, so the server itself is asked.
 */
async function reachableSeeds(driver, seeds = K.get().seedNodes) {
  const list = seeds.map((s) => String(s).replace(/\/+$/, "")).filter((s) => hostOf(s));
  const r = await driver.exec(
    list.map((s) => `( echo "SEED ${s} $(curl -s -m 20 -o /dev/null -w '%{http_code} %{time_total}' ${shq(s + "/chain-rpc/genesis")} 2>/dev/null || echo '000 99')" ) &`).join(" ") + " wait",
    { timeoutMs: 120000 });
  const answered = [];
  for (const m of (r.stdout || "").matchAll(/^SEED (\S+) (\d{3}) ([\d.]+)/gm)) if (m[2] === "200") answered.push({ url: m[1], seconds: Number(m[3]) });
  return answered.sort((a, b) => a.seconds - b.seconds).map((x) => x.url);
}

/**
 * Point the chain node at another public node: every line of config.env that
 * names the old one (the seed, its peer address, the state-sync servers) now
 * names the new one, and the node container is made again on it. Its keys live
 * in .tmkms and the keyring and are not touched.
 */
async function switchSeed(driver, from, to, onData) {
  const a = hostOf(from), b = hostOf(to);
  if (!a || !b) throw new Error(`Can't switch the chain node from ${from} to ${to}.`);
  const r = await driver.exec(
    `cd ${JOIN()} && sed -i -E '/^ *(export +)?(SEED_API_URL|SEED_NODE_RPC_URL|SEED_NODE_P2P_URL|RPC_SERVER_URL_1|RPC_SERVER_URL_2)=/ s#${a.replace(/\./g, "\\.")}#${b}#g' config.env && ` +
    `source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose up -d --force-recreate --no-deps node 2>&1`,
    { onData, timeoutMs: 300000 });
  if (r.code !== 0) throw new Error(`Couldn't restart the chain node on ${b}:\n` + (r.stdout + r.stderr).slice(-600));
}

/** The public node config.env names for the chain node ("http://node1.gonka.ai:8000"), or null. */
async function configuredSeed(driver) {
  const r = await driver.exec(`cd ${JOIN()} && grep -m1 -E '^ *(export +)?SEED_NODE_RPC_URL=' config.env | sed 's/^[^=]*=//'`);
  const u = (r.stdout || "").trim().replace(/\/chain-rpc\/?$/, "").replace(/\/+$/, "");
  return hostOf(u) ? u : null;
}

/** A download of the genesis file, from this server itself or from inside a container on the node's network: { ok, code, bytes }. */
async function genesisDownload(driver, seedUrl, inContainer) {
  const url = String(seedUrl).replace(/\/+$/, "") + "/chain-rpc/genesis";
  const curl = `curl -s -m 40 -o /dev/null -w '%{http_code} %{size_download}' ${shq(url)}`;
  const r = await driver.exec(inContainer
    ? `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose run --rm --no-deps -T api sh -c ${shq(curl)} 2>/dev/null; echo`
    : `${curl}; echo`, { timeoutMs: 180000 });
  const [, code = "000", bytes = "0"] = /(\d{3}) (\d+)/.exec(r.stdout || "") || [];
  return { ok: code === "200" && Number(bytes) > 100000, code, bytes: Number(bytes) };
}

/**
 * Fit the containers' TCP packets to this server's network.
 *
 * Docker's networks use packets of up to 1,500 bytes, and many rented
 * machines sit on a smaller network (often 1,450, behind the provider's
 * overlay). The server's own connections offer the smaller size and work; a
 * container's offer 1,500, so anything big sent to it is lost on the way and
 * the download hangs or is reset, while small answers get through. On
 * 29 October 2026 that stopped a Spheron server's chain node twice: its
 * genesis download hung on node2, then node1 reset it, while the server
 * itself fetched the same file in 0.3 s. State sync and the API would have
 * hit the same wall.
 *
 * So the genesis download is tried from inside a container. Only when it
 * fails there and works from the server is anything changed: the size a
 * forwarded connection offers (TCP MSS) is capped to what this network
 * carries, the standard cure, and a small systemd unit keeps it after a
 * reboot. Nothing changes on a server where containers download fine.
 */
async function fitContainerPackets(driver, seedUrl, onData) {
  const say = (s) => onData && onData(`▶ Chain node: ${s}\n`);
  // This server's network, and whether GNOT's fix is already kept for reboots. A
  // network under 1,500 bytes is fitted at once, before anything fails (that
  // Spheron server's was 1,400), and so is a hand-made fix a reboot would lose.
  const net = await driver.exec(
    `IF=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}'); ` +
    `echo "MTU $IF $(cat /sys/class/net/$IF/mtu 2>/dev/null || echo 1500)"; [ -x /usr/local/sbin/gnot-container-mss.sh ] && echo HAVE_FIX; true`);
  const [, iface = "", mtuText = "1500"] = /MTU (\S*) (\d+)/.exec(net.stdout || "") || [];
  const mtu = Number(mtuText) || 1500;
  if (mtu < 1500 && !/HAVE_FIX/.test(net.stdout || "")) {
    say(`this server's network carries ${mtu.toLocaleString("en")}-byte packets (${iface}) and Docker's carry 1,500; fitting Docker's packets to it`);
  } else {
    const inside = await genesisDownload(driver, seedUrl, true);
    if (inside.ok) return { changed: false, ok: true };
    const outside = await genesisDownload(driver, seedUrl, false);
    if (!outside.ok) return { changed: false, ok: false, outside, inside };   // not this: the server itself can't download it
    say("downloads from inside Docker are cut off on this server's network; fitting Docker's packets to it");
  }
  // One small script does it, now and at every boot (systemd runs it again), so a
  // restarted server keeps it. It works the size out from the network it is on.
  const script = [
    "#!/bin/sh",
    "# Written by GNOT: fit Docker containers' TCP packets to this server's network (MSS clamp).",
    "IF=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"dev\"){print $(i+1); exit}}')",
    "MTU=$(cat /sys/class/net/$IF/mtu 2>/dev/null || echo 1500)",
    "MSS=$((MTU - 40)); [ \"$MSS\" -ge 1460 ] && MSS=1360",
    "RULE=\"-p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss $MSS\"",
    "iptables -t mangle -C FORWARD $RULE 2>/dev/null || iptables -t mangle -I FORWARD 1 $RULE || exit 1",
    "echo \"FITTED $IF mtu=$MTU mss=$MSS\"",
    ""
  ].join("\n");
  const unit = [
    "[Unit]",
    "Description=GNOT: fit Docker containers' TCP packets to this server's network (MSS clamp)",
    "After=network-online.target docker.service",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/usr/local/sbin/gnot-container-mss.sh",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
  const b64 = (x) => Buffer.from(x, "utf8").toString("base64");
  const r = await driver.exec(
    `SUDO=""; if [ "$(id -u)" != 0 ]; then sudo -n true 2>/dev/null && SUDO=sudo || { echo NO_ROOT; exit 0; }; fi; ` +
    `echo ${b64(script)} | base64 -d | $SUDO tee /usr/local/sbin/gnot-container-mss.sh >/dev/null && $SUDO chmod 755 /usr/local/sbin/gnot-container-mss.sh && ` +
    `$SUDO /usr/local/sbin/gnot-container-mss.sh || { echo NO_IPTABLES; exit 0; }; ` +
    `if command -v systemctl >/dev/null; then echo ${b64(unit)} | base64 -d | $SUDO tee /etc/systemd/system/gnot-container-mss.service >/dev/null && ` +
    `$SUDO systemctl daemon-reload && $SUDO systemctl enable gnot-container-mss.service >/dev/null 2>&1; fi; true`,
    { onData, timeoutMs: 120000 });
  const out = r.stdout || "";
  if (/NO_ROOT/.test(out)) {
    throw new Error(
      "Downloads from inside Docker are cut off on this server's network (the server itself downloads fine), and fixing it needs root, which this login doesn't have.\n\n" +
      "Log in as root, or give this user passwordless sudo, then press \"Run launch sequence\" again. The fix GNOT applies is the standard one for this: " +
      "iptables -t mangle -I FORWARD 1 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1410");
  }
  if (!/FITTED/.test(out)) throw new Error("Couldn't fit Docker's packets to this server's network:\n" + (out + (r.stderr || "")).slice(-600));
  const again = await genesisDownload(driver, seedUrl, true);
  say(again.ok ? "downloads from inside Docker work now" : "downloads from inside Docker still fail after the fix");
  return { changed: true, ok: again.ok, detail: (/FITTED (.*)/.exec(out) || [])[1] };
}

/**
 * Start tmkms and the chain node, and wait until the node really answers: its
 * RPC says how far it is, which is also what registration needs (it reads the
 * consensus key there). A running container is not enough. Before it answers,
 * the node downloads the genesis file, applies its settings and starts, and any
 * of that can stall; the old two-minute wait gave up on a node that was simply
 * stuck on its download.
 *
 * Every step shows in the activity log as it happens ("▶ Chain node: …"), so a
 * slow node never looks like a stuck app. When the genesis download sits for
 * over a minute, or fails, the public node is not answering this server: the
 * next one that does goes into config.env and the node starts again on it.
 */
async function startCore(driver, onData, { pollMs = 6000, stallMs = 60 * 1000, waitMs = 15 * 60 * 1000 } = {}) {
  const say = (s) => onData && onData(`▶ Chain node: ${s}\n`);
  const seedNow0 = await configuredSeed(driver);
  // Downloads from inside Docker have to work on this server's network first.
  const fit = seedNow0 ? await fitContainerPackets(driver, seedNow0, onData) : null;
  const up = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose up tmkms node -d --no-deps 2>&1` +
    // A node stuck on a download from before the fix has to start again to use it.
    (fit && fit.changed ? ` && docker compose up -d --force-recreate --no-deps node 2>&1` : ""),
    { onData, timeoutMs: 600000 });
  if (up.code !== 0) throw new Error("Couldn't start tmkms and the chain node:\n" + (up.stdout + up.stderr).slice(-600));

  const WAIT_MS = waitMs, STALL_MS = stallMs, CRASHES = 6;
  const started = Date.now(), tried = new Set();
  let phase = "", since = Date.now(), firstRestarts = null, alive = null, lastLogs = [], seedLast = "";
  const PHASES = {
    genesis: (h) => `downloading the network's starting file (genesis) from ${h}`,
    settings: () => "applying its settings",
    starting: () => "starting up",
    restarting: (h, n) => `restarted ${n} times, reading why`
  };
  while (Date.now() - started < WAIT_MS) {
    await new Promise((r) => setTimeout(r, pollMs));
    const s = await driver.exec(
      `cd ${JOIN()} && echo "STATE $(docker inspect -f '{{.State.Status}} {{.RestartCount}}' node 2>/dev/null)"; ` +
      `echo "SEED $(grep -m1 -E '^ *(export +)?SEED_NODE_RPC_URL=' config.env | sed 's/^[^=]*=//')"; ` +
      `docker logs --tail 12 node 2>&1 | tail -12 | sed 's/^/LOG /'; ` +
      // Asked inside the container; whichever of these its image has answers.
      `echo "RPC $(timeout 15 docker exec node sh -c 'inferenced status 2>/dev/null || curl -s -m 5 http://127.0.0.1:26657/status 2>/dev/null || wget -qO- -T 5 http://127.0.0.1:26657/status 2>/dev/null' | tr -d '\\n' | head -c 4000)"`,
      { timeoutMs: 90000 });
    const out = s.stdout || "";
    const [, status = "", restartText = ""] = /^STATE (\S*) ?(\d*)/m.exec(out) || [];
    const restarts = Number(restartText) || 0;
    if (firstRestarts === null) firstRestarts = restarts;
    const seedNow = ((/^SEED (\S*)/m.exec(out) || [])[1] || "").replace(/\/chain-rpc\/?$/, "").replace(/\/+$/, "");
    if (seedNow) seedLast = seedNow;
    lastLogs = [...out.matchAll(/^LOG (.*)$/gm)].map((m) => m[1]);
    const rpc = ((/^RPC (.*)$/m.exec(out) || [])[1] || "");

    // It answers: done. How far it has synced is the Verify step's to show.
    if (/sync_info|SyncInfo/.test(rpc)) {
      const height = Number((/"latest_block_height"\s*:\s*"?(\d+)/i.exec(rpc) || [])[1]) || null;
      const catchingUp = /"catching_up"\s*:\s*true/i.test(rpc);
      say(catchingUp ? `answering; catching up with the network${height ? ` (block ${height.toLocaleString("en")})` : ""}` : "answering");
      return { ok: true, seed: seedNow, catchingUp, height };
    }

    const last = lastLogs[lastLogs.length - 1] || "", all = lastLogs.join("\n");
    const failedDownload = /failed to download genesis/i.test(all);
    const now = /download-genesis/.test(last) ? "genesis"
      // (the settings lines also name state-sync and snapshots, so only the node's own start counts here)
      : /Starting node|cosmovisor run|CometBFT|INF.*(state ?sync|snapshot|Starting)/i.test(all) ? "starting"
      : /Applying configuration|set-seeds|set-statesync|\+ kv /i.test(all) ? "settings"
      : status === "restarting" || status === "exited" ? "restarting" : phase;
    if (now && now !== phase) {
      phase = now; since = Date.now();
      say(PHASES[phase](hostOf(seedNow) || "a public node", restarts - firstRestarts));
    }

    // The public node is not answering this server: on to the next one that does.
    if ((phase === "genesis" && Date.now() - since > STALL_MS) || failedDownload) {
      tried.add(seedNow);
      if (!alive) alive = await reachableSeeds(driver);
      const next = alive.find((x) => !tried.has(x));
      if (!next) {
        const inside = await genesisDownload(driver, seedNow, true), outside = await genesisDownload(driver, seedNow, false);
        if (outside.ok && !inside.ok) {
          throw new Error(
            `This server downloads the network's starting file from ${hostOf(seedNow)} fine, but the same download from inside Docker fails (${inside.code}, ${inside.bytes} bytes), even after GNOT fitted Docker's packets to this network.\n\n` +
            `Something on this server or at the provider blocks or cuts off large downloads from containers. "Copy the details" and ask in the Gonka Discord, or ask the provider about the network's MTU.\n\nThe chain node's last lines:\n${lastLogs.join("\n")}`);
        }
        throw new Error(
          `The chain node can't download the network's starting file: ${hostOf(seedNow) || seedNow} doesn't answer this server, ` +
          `and no other public Gonka node did either.\n\n` +
          `Check that the server can reach the internet (for example: curl -I http://node1.gonka.ai:8000/chain-rpc/status), ` +
          `then press "Run launch sequence" again.\n\nThe chain node's last lines:\n${lastLogs.join("\n")}`);
      }
      say(`${hostOf(seedNow)} isn't answering this server; switching to ${hostOf(next)}`);
      await switchSeed(driver, seedNow, next, onData);
      phase = ""; since = Date.now(); firstRestarts = null;
      continue;
    }

    // Starting over and over is not slowness: stop and say why.
    if (restarts - firstRestarts >= CRASHES) {
      throw new Error(
        `The chain node keeps stopping and starting again (${restarts - firstRestarts} times while GNOT waited), so it never gets to answer.\n\n` +
        `Its last lines usually say why:\n${lastLogs.join("\n")}`);
    }
  }
  throw new Error(
    `The chain node didn't answer within 15 minutes. It was ${phase ? PHASES[phase](hostOf(seedLast) || "a public node", 0) : "starting"} when GNOT stopped waiting.\n\n` +
    `Press "Run launch sequence" again: it carries on from where it is. Its last lines:\n${lastLogs.join("\n")}`);
}

/**
 * What the server looks like now, for whoever helps: the containers, the chain
 * node's last lines, disk, memory, and which public nodes answer it. Nothing
 * secret: config.env and the API container's log (which can carry settings)
 * are never read out.
 */
async function diagnostics(driver) {
  const seeds = K.get().seedNodes.map((s) => String(s).replace(/\/+$/, "")).filter((s) => hostOf(s));
  const r = await driver.exec(
    `cd ${JOIN()} 2>/dev/null; source config.env 2>/dev/null; echo "## docker compose ps"; docker compose ps -a 2>&1 | head -30; ` +
    `echo; echo "## chain node, last 60 lines"; docker logs --tail 60 node 2>&1; ` +
    `echo; echo "## disk"; df -h . / 2>&1 | head -6; echo; echo "## memory"; free -g 2>&1 | head -3; ` +
    `echo; echo "## GPUs"; nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>&1 | head -10; ` +
    `echo; echo "## network"; ip -o link show 2>/dev/null | awk '{print $2, "mtu", $5}'; iptables -t mangle -S FORWARD 2>/dev/null | grep TCPMSS; ` +
    `echo; echo "## public Gonka nodes, from this server"; ` +
    seeds.map((s) => `echo "${s}: $(curl -s -m 15 -o /dev/null -w '%{http_code} in %{time_total}s' ${shq(s + "/chain-rpc/status")} 2>/dev/null || echo 'no answer')"`).join("; "),
    { timeoutMs: 120000 });
  // The big download, from the server and from inside Docker: the two differ when the network cuts off containers.
  const seed = await configuredSeed(driver).catch(() => null);
  let both = "";
  if (seed) {
    const outside = await genesisDownload(driver, seed, false).catch(() => null);
    const inside = await genesisDownload(driver, seed, true).catch(() => null);
    const line = (x) => (x ? `${x.code}, ${x.bytes} bytes` : "couldn't try");
    both = `\n## the genesis file from ${hostOf(seed)}\nfrom this server: ${line(outside)}\nfrom inside Docker: ${line(inside)}\n`;
  }
  return (r.stdout || "") + (r.stderr || "") + both;
}

/**
 * KEY_NAME of the server's operational (warm) key, read from the config.env
 * already on the server. The wizard must never invent a new name on a second
 * run: that would silently create a SECOND warm key and orphan the first,
 * which the docs call out as destructive.
 */
async function readServerKeyName(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} 2>/dev/null && grep -m1 '^ *\\(export \\)\\?KEY_NAME=' config.env 2>/dev/null | sed 's/.*KEY_NAME=//' | tr -d '"'"'"' \\r'`);
  const name = (r.stdout || "").trim();
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

/** True if the warm key already exists inside the api container volume. */
async function warmKeyExists(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && ` +
    `printf '%s\\n' "$KEYRING_PASSWORD" | docker compose run --rm --no-deps -T api ` +
    `inferenced keys show "$KEY_NAME" --keyring-backend file --output json 2>/dev/null || true`);
  try { return !!JSON.parse(r.stdout.split("\n").find((l) => l.trim().startsWith("{")) || "null"); }
  catch (_) { return false; }
}

/**
 * Create the ML Operational (warm) key inside the api container.
 * Refuses to run twice — the docs are explicit that regenerating it is
 * destructive.
 */
async function createWarmKey(driver, onData) {
  if (await warmKeyExists(driver)) {
    const info = await driver.exec(
      `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && printf '%s\\n' "$KEYRING_PASSWORD" | ` +
      `docker compose run --rm --no-deps -T api inferenced keys show "$KEY_NAME" --keyring-backend file --output json 2>/dev/null`);
    const line = info.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    const j = JSON.parse(line);
    return { existed: true, address: j.address, mnemonic: null };
  }
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && ` +
    `printf '%s\\n%s\\n' "$KEYRING_PASSWORD" "$KEYRING_PASSWORD" | docker compose run --rm --no-deps -T api ` +
    `inferenced keys add "$KEY_NAME" --keyring-backend file --output json 2>&1`,
    { onData, timeoutMs: 180000 });
  const line = (r.stdout + r.stderr).split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("Warm key creation failed:\n" + (r.stdout + r.stderr).slice(-600));
  const j = JSON.parse(line);
  return { existed: false, address: j.address, mnemonic: j.mnemonic || null };
}

/** Fetch the Consensus Key (needed for the manual-registration fallback). */
async function getConsensusKey(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose run --rm --no-deps -T api ` +
    `sh -c 'curl -s $DAPI_CHAIN_NODE__URL/status' | jq -r '.result.validator_info.pub_key.value'`);
  const key = r.stdout.trim().split("\n").pop();
  if (!key || key === "null") throw new Error("Couldn't read the Consensus Key from the chain node — is it running and synced?");
  return key;
}

/**
 * Register the Host from inside the api container. Detects the documented
 * "balance > 0 but sequence 0" nil-pointer edge case and reports
 * needsManualFallback so the wizard can register locally with the cold key.
 */
async function registerHost(driver, onData) {
  // The chain node may still be starting when we first try; its RPC has to be
  // reachable for the CLI to auto-fetch the consensus key. Retry a few times
  // rather than failing the whole sequence on a timing race.
  let r, out = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = await driver.exec(
      `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose run --rm --no-deps -T api ` +
      `inferenced register-new-participant "$PUBLIC_URL" "$ACCOUNT_PUBKEY" ` +
      `--node-address "$SEED_API_URL" 2>&1`,
      { onData, timeoutMs: 300000 });
    out = r.stdout + r.stderr;
    const nodeNotReady = /RPC endpoint not responding|dial tcp|lookup node|connection refused/i.test(out);
    if (!nodeNotReady) break;
    if (attempt === 5) {
      // Out of retries: the node is the real problem, so show ITS logs rather
      // than leaving the user staring at a DNS lookup failure.
      const lg = await driver.exec(
        `cd ${JOIN()} && docker compose ps node; echo '--- node log ---'; docker compose logs --tail 40 node 2>&1`);
      throw new Error(
        "The chain node isn't reachable, so registration can't fetch the consensus key.\n\n" +
        "This almost always means the node container isn't running. Its status and last log lines:\n\n" +
        (lg.stdout || lg.stderr || "(no output)").slice(-1500));
    }
    onData && onData(`\n▶ Chain node isn't answering yet — waiting 20s and retrying (${attempt}/5)...\n`);
    await new Promise((res) => setTimeout(res, 20000));
  }
  if (/nil pointer dereference|invalid memory address/i.test(out)) {
    return { ok: false, needsManualFallback: true, output: out };
  }
  if (/Found participant:|Participant is now available/i.test(out)) return { ok: true, output: out };
  if (/already exists|already registered/i.test(out)) return { ok: true, alreadyRegistered: true, output: out };
  // The registration POST returned success, but the follow-up availability
  // poll can time out — a new participant record often takes longer than the
  // CLI's 30s to become queryable (and only earns weight after the next PoC).
  // A 200 + "registration successful" is the authoritative accept signal.
  if (/registration successful/i.test(out) || /Response status code:\s*20[01]\b/i.test(out)) {
    return { ok: true, propagating: true, output: out };
  }
  // From Gonka v0.2.17 the seed no longer registers hosts for them: POST
  // /v1/participants answers 410 Gone and the CLI calls the command
  // deprecated. The way Gonka names instead (fund the account, sign
  // MsgSubmitNewParticipant) is the wallet registration the wizard already has.
  // Checked after the success lines, so a seed that still accepts (v0.2.16)
  // is never sent down this path by some unrelated warning.
  if (/status code:\s*410\b|is deprecated|are suspended/i.test(out) || /\bGone\b/.test(out)) {
    return { ok: false, needsManualFallback: true, deprecated: true, output: out };
  }
  return { ok: false, needsManualFallback: false, output: out };
}

/**
 * Compose adjustments the ML node needs on real rented hosts. Idempotent and
 * re-applied on every launch, because `git checkout` during clone resets the
 * repo's compose files and because a user can reach the launch step without
 * passing through config generation again.
 *
 *  1. device_ids instead of `count: all` — the NVIDIA runtime's "all"
 *     resolution silently dropped a healthy GPU on a real box, so vLLM died
 *     with "World size (4) is larger than the number of available GPUs (3)".
 *
 *  2. NVIDIA_DRIVER_CAPABILITIES=compute,utility — the mlnode image requests
 *     every driver capability, including graphics/display. That makes the
 *     container toolkit symlink /dev/dri/by-path graphics nodes, which fails
 *     on some hosts with "failed to create temporary symlink: bad file
 *     descriptor" and aborts the whole launch. Gonka only ever does compute;
 *     it never renders, so dropping the graphics capability changes nothing
 *     except that the broken hook is skipped.
 *
 *  3. The ML node image for an older NVIDIA driver. The default image needs
 *     CUDA 13, a driver 580 or newer, and Gonka's compose file names the image
 *     for older drivers in a comment: "# CUDA 12.9 fallback: <image>" (v0.2.16,
 *     mlnode 3.0.16), or "# NVIDIA driver older than 580 (CUDA 12.x): <image>"
 *     (a v0.2.17 test tag). When this server's driver is older, that image goes
 *     into config.env as MLNODE_IMAGE, unless MLNODE_IMAGE is already set
 *     there. Without such a comment nothing changes. scripts/check-chain.js
 *     reads Gonka's live compose file each day and warns when its fallback
 *     line is one this does not recognise.
 */
async function ensureMlnodeCompose(driver, gpuCount, onData) {
  const ids = gpuCount > 0
    ? Array.from({ length: gpuCount }, (_, i) => `"${i}"`).join(",")
    : null;
  const r = await driver.exec(
    `cd ${JOIN()} && F=docker-compose.mlnode.yml; [ -f "$F" ] || exit 0; ` +
    (ids ? `sed -i 's/^\\( *\\)count: all$/\\1device_ids: [${ids}]/' "$F"; ` : "") +
    // Insert after the FIRST `environment:` block (the mlnode service), only
    // when the setting isn't already there.
    `grep -q NVIDIA_DRIVER_CAPABILITIES "$F" || ` +
    `  sed -i '0,/^ *environment:$/s//&\\n      - NVIDIA_DRIVER_CAPABILITIES=compute,utility/' "$F"; ` +
    `grep -q NVIDIA_DRIVER_CAPABILITIES "$F" && echo CAPS_OK; ` +
    `grep -q 'device_ids' "$F" && echo IDS_OK; ` +
    `L=$(grep -m1 -E '^ *# *NVIDIA driver older than [0-9]+' "$F"); ` +
    `N=$(echo "$L" | grep -oE 'older than [0-9]+' | grep -oE '[0-9]+'); ` +
    // Gonka's current wording names no driver: the main image is CUDA 13 (driver 580+).
    `if [ -z "$L" ]; then L=$(grep -m1 -iE '^ *# *CUDA 12(\\.[0-9]+)? fallback:' "$F"); [ -n "$L" ] && N=${Number(K.get().requirements.driverMain) || 580}; fi; ` +
    `I=$(echo "$L" | grep -oE '[^ ]+-cu12[^ ]*' | head -1 | grep -E '^[A-Za-z0-9._/:@-]+$'); ` +
    `D=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | grep -oE '^[0-9]+'); ` +
    `if [ -n "$N" ] && [ -n "$I" ] && [ -n "$D" ] && [ "$D" -lt "$N" ] && [ -f config.env ] && ! grep -qE '^ *(export +)?MLNODE_IMAGE=' config.env; then ` +
    `  { echo; echo "# Set by GNOT: this server's NVIDIA driver ($D) is older than $N."; echo "export MLNODE_IMAGE=$I"; } >> config.env; fi; ` +
    `[ -f config.env ] && grep -E '^ *(export +)?MLNODE_IMAGE=' config.env | tail -1 | sed 's/^[^=]*=/IMAGE=/'; ` +
    `[ -n "$D" ] && echo "DRIVER=$D"; true`,
    { onData });
  const image = (r.stdout.match(/^IMAGE=(\S+)/m) || [])[1] || null;
  const driverMajor = Number((r.stdout.match(/^DRIVER=(\d+)/m) || [])[1]) || null;
  return { caps: /CAPS_OK/.test(r.stdout), deviceIds: /IDS_OK/.test(r.stdout), image, driverMajor };
}

/**
 * Repair a CDI spec that can't start GPU containers on this host.
 *
 * The NVIDIA toolkit (>=1.17, mode "auto") pre-generates /var/run/cdi/nvidia.yaml
 * and bakes a `create-symlinks` createContainer hook into EVERY GPU device, to
 * recreate /dev/dri/by-path graphics links inside the container. On many rented
 * hosts that hook dies with:
 *
 *   failed to create link [../card1 /dev/dri/by-path/pci-0000:05:00.0-card]:
 *   failed to create temporary symlink: bad file descriptor
 *
 * and every GPU container fails to start. It is NOT gated by
 * NVIDIA_DRIVER_CAPABILITIES, so limiting capabilities doesn't help — the hook
 * lives in the CDI spec itself.
 *
 * Regenerating the spec with --disable-hook=create-symlinks removes just that
 * hook and keeps device nodes and driver libraries, which is all Gonka needs
 * (it computes, it never renders). Verified on a 4×H100 host where it turned a
 * total launch failure into a clean start.
 */
async function ensureGpuRuntime(driver, onData) {
  const r = await driver.exec(
    `SUDO=""; sudo -n true 2>/dev/null && SUDO=sudo; ` +
    `command -v nvidia-ctk >/dev/null || { echo NO_CTK; exit 0; }; ` +
    `SPEC=$(ls /var/run/cdi/nvidia.yaml /etc/cdi/nvidia.yaml 2>/dev/null | head -1); ` +
    `[ -n "$SPEC" ] || { echo NO_SPEC; exit 0; }; ` +
    // Only touch a spec that actually carries the broken hook.
    `grep -q 'create-symlinks' "$SPEC" && grep -q '/dev/dri/by-path' "$SPEC" || { echo SPEC_OK; exit 0; }; ` +
    `$SUDO cp "$SPEC" "$SPEC.gonka-backup" 2>/dev/null; ` +
    `$SUDO nvidia-ctk cdi generate --disable-hook=create-symlinks --output="$SPEC" >/dev/null 2>&1 || { echo REGEN_FAILED; exit 0; }; ` +
    `grep -q 'create-symlinks' "$SPEC" && echo STILL_PRESENT || echo CDI_FIXED`,
    { onData, timeoutMs: 120000 });
  const out = r.stdout || "";
  if (/CDI_FIXED/.test(out)) {
    onData && onData("Repaired this host's GPU runtime config (removed a broken /dev/dri symlink hook that blocks GPU containers).\n");
    return { fixed: true };
  }
  return { fixed: false, state: (out.match(/NO_CTK|NO_SPEC|SPEC_OK|REGEN_FAILED|STILL_PRESENT/) || ["unknown"])[0] };
}

async function launchAll(driver, onData, gpuCount) {
  // Self-heal before launching: these are the two compose defaults that fail
  // on real hardware, and a user hitting "Run launch sequence" again after a
  // failure should simply get a working launch.
  const fixed = await ensureMlnodeCompose(driver, gpuCount, onData);
  if (fixed.caps) onData && onData("ML node limited to compute capabilities.\n");
  if (fixed.image) onData && onData(`ML node image: ${fixed.image}\n`);
  // Host-level: repair a CDI spec whose /dev/dri symlink hook breaks every GPU
  // container on this machine. No-op when the host is healthy.
  await ensureGpuRuntime(driver, onData);
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && docker compose -f docker-compose.yml -f docker-compose.mlnode.yml up -d`,
    { onData, timeoutMs: 900000 });
  if (r.code !== 0) throw new Error("Full launch failed:\n" + (r.stderr || "").slice(-600));
  return { ok: true };
}

async function downloadWeights(driver, models, onData, hfHome) {
  const k = K.get();
  // Whichever disk the health check found room on (rented boxes usually keep
  // the terabytes off /), falling back to the documented default.
  const cacheDir = hfHome || k.hfHome;
  for (const m of models) {
    onData && onData(`\n▶ Downloading weights for ${m} (this can take a long time)...\n`);
    // huggingface_hub 1.x renamed the CLI to `hf`; older installs only have
    // `huggingface-cli`. Prefer the new name, fall back to the old one.
    const r = await driver.exec(
      `export PATH=$PATH:$HOME/.local/bin && mkdir -p ${cacheDir} && ` +
      `if command -v hf >/dev/null; then HF_HOME=${cacheDir} hf download ${shq(m)}; ` +
      `else HF_HOME=${cacheDir} huggingface-cli download ${shq(m)}; fi`,
      { onData, timeoutMs: 12 * 60 * 60 * 1000 });
    if (r.code !== 0) throw new Error(`Weights download for ${m} failed:\n` + (r.stderr || "").slice(-600));
  }
  return { ok: true };
}

/**
 * The chain node's own view of its sync progress, straight from tendermint
 * inside the node container. Height 0 + catching_up means the state-sync
 * snapshot is still restoring (blockstore empty) — normal for ~the first hour.
 */
async function nodeSyncStatus(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && docker compose -f docker-compose.yml exec -T node inferenced status 2>/dev/null`,
    { timeoutMs: 20000 });
  const m = r.stdout.match(/"latest_block_height":"(\d+)"/);
  const c = r.stdout.match(/"catching_up":(true|false)/);
  if (!m) throw new Error("Node isn't answering yet — it may still be starting.");
  const out = { height: parseInt(m[1], 10), catchingUp: c ? c[1] === "true" : true };

  // While state-syncing, height stays 0 for the whole restore — which looks
  // identical to "stuck". The real progress is the snapshot chunk counter in
  // the node log, so surface that instead of showing nothing.
  if (out.height === 0) {
    // The node colourises its own log, so `chunk=` and its number are split by
    // escape sequences — strip ANSI first or the match silently finds nothing.
    // (docker compose --no-color only removes Docker's prefix, not this.)
    const lg = await driver.exec(
      `cd ${JOIN()} && docker compose -f docker-compose.yml logs --tail 300 node 2>&1 | ` +
      `sed 's/\\x1b\\[[0-9;]*m//g' | ` +
      `grep -o 'chunk=[0-9]* format=[0-9]* height=[0-9]* module=statesync total=[0-9]*' | tail -1`,
      { timeoutMs: 25000 });
    const s = lg.stdout.match(/chunk=(\d+).*height=(\d+).*total=(\d+)/);
    if (s) {
      out.snapshot = {
        chunk: parseInt(s[1], 10),
        total: parseInt(s[3], 10),
        atHeight: parseInt(s[2], 10)
      };
      // The last pieces write the whole restored state to disk, with no log
      // line for many minutes. How much the chain's data folder holds, read
      // each time, is what shows that it is still working.
      if (out.snapshot.chunk >= out.snapshot.total - 2) {
        const du = await driver.exec(
          `cd ${JOIN()} && D=.inference/data/; (sudo -n timeout 20 du -sb "$D" 2>/dev/null || timeout 20 du -sb "$D" 2>/dev/null) | tail -1 | cut -f1`,
          { timeoutMs: 30000 });
        const bytes = parseInt(du.stdout.trim(), 10);
        if (bytes > 0) out.snapshot.writtenBytes = bytes;
      }
    }
  }
  return out;
}

/**
 * What the ML node itself reports — the half of readiness the chain can't see.
 * A node can be registered and fully synced and still earn nothing if the ML
 * side can't serve Proof of Compute (twice now: a GPU that enumerated but
 * couldn't run CUDA, and vLLM refusing to start). Reads the mlnode's own API:
 *   /api/v1/state        → STOPPED | POW | INFERENCE, loaded_model, poc_status
 *   /api/v1/gpu/devices  → per-GPU is_available + free VRAM
 *   /api/v1/models/list  → weights DOWNLOADED for the configured model
 */
async function mlnodeStatus(driver) {
  const get = (path) =>
    `docker exec "$CID" sh -c 'curl -s -m 6 http://localhost:8080${path}' 2>/dev/null`;
  const r = await driver.exec(
    `CID=$(docker ps -q --filter name=mlnode | head -1); ` +
    `if [ -z "$CID" ]; then echo '{"noContainer":true}'; exit 0; fi; ` +
    `echo '{"state":'; ${get("/api/v1/state")}; ` +
    `echo ',"gpu":'; ${get("/api/v1/gpu/devices")}; ` +
    `echo ',"models":'; ${get("/api/v1/models/list")}; echo '}'`,
    { timeoutMs: 30000 });
  let j;
  try { j = JSON.parse(r.stdout.replace(/\n/g, "")); } catch (_) { return { unknown: true }; }
  if (j.noContainer) return { noContainer: true };
  const devices = (j.gpu && j.gpu.devices) || [];
  const models = (j.models && j.models.models) || [];
  return {
    state: (j.state && j.state.state) || null,          // STOPPED / POW / INFERENCE
    loadedModel: (j.state && j.state.loaded_model) || null,
    pocStatus: (j.state && j.state.poc_status) || null,
    gpuTotal: devices.length,
    gpuReady: devices.filter((d) => d.is_available).length,
    weightsReady: models.some((m) => m.status === "DOWNLOADED"),
    modelName: models.length && models[0].model ? models[0].model.hf_repo : null
  };
}

/**
 * What the node itself says about this epoch's fees. From Gonka v0.2.16 a host
 * pays for each Proof of Compute commit and hardware report out of the cold
 * wallet, through the fee allowance granted to the warm key; a node that
 * cannot pay stays registered but is left out of the epoch. The node's admin
 * API (it only listens on the server itself) works the sum out:
 *   budget_balance     ngonka this epoch may need — an upper estimate
 *   spendable_balance  what it can spend: the wallet's balance, capped by what
 *                      is left of the allowance
 * null when the node is not up yet or is older than v0.2.16.
 */
async function feeBudget(driver) {
  const r = await driver.exec("curl -s -m 8 http://127.0.0.1:9200/admin/v1/epoch-fee-budget", { timeoutMs: 15000 });
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { return null; }
  if (!j || j.budget_balance === undefined || j.spendable_balance === undefined) return null;
  return {
    budget: Number(j.budget_balance),
    spendable: Number(j.spendable_balance),
    covers: !!j.spendable_covers_budget,
    // false while the node has not seen a Proof of Compute to size the estimate from
    known: j.budget_known !== false
  };
}

async function containersStatus(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && docker compose -f docker-compose.yml -f docker-compose.mlnode.yml ps --format json 2>/dev/null || ` +
    `docker ps --format '{{.Names}}: {{.Status}}'`);
  return r.stdout;
}

module.exports = {
  cloneRepo, listNodeConfigs, readRepoFile, hardenPorts, writeConfigs, readServerKeyName,
  listComposeImages, serverArch,
  pullImages, startCore, reachableSeeds, switchSeed, diagnostics, warmKeyExists, createWarmKey, getConsensusKey,
  registerHost, launchAll, downloadWeights, containersStatus, nodeSyncStatus, prepareDataDirs, mlnodeStatus, ensureMlnodeCompose, ensureGpuRuntime,
  feeBudget
};
