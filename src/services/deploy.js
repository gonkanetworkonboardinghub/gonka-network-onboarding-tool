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
  const r = await driver.exec(
    `if [ -d gonka/.git ]; then cd gonka && git fetch --depth 1 origin ${shq(ref)} && git reset --hard && git checkout -f FETCH_HEAD && echo UPDATED; ` +
    `else rm -rf gonka && git clone --depth 1 --branch ${shq(ref)} ${shq(k.repo.url)} && cd gonka && echo CLONED; fi && ` +
    `git --no-pager log -1 --oneline`,
    { onData, timeoutMs: 300000 });
  if (!/CLONED|UPDATED/.test(r.stdout)) throw new Error("Couldn't get the Gonka repository:\n" + (r.stderr || r.stdout).slice(-600));

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

async function startCore(driver, onData) {
  // A fresh chain node needs far longer than a fixed `sleep 8` before its RPC
  // answers — registering too early fails with "node RPC endpoint not
  // responding". Poll until the container is actually up, then give the RPC a
  // moment to bind.
  const r = await driver.exec(
    `cd ${JOIN()} && source config.env && export DOCKER_DEFAULT_PLATFORM=linux/amd64 && ` +
    `docker compose up tmkms node -d --no-deps && ` +
    `cid=""; for i in $(seq 1 60); do ` +
    `  cid=$(docker compose ps -q node 2>/dev/null); ` +
    `  if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]; then echo NODE_UP; break; fi; ` +
    `  sleep 5; ` +
    `done; ` +
    // A crash-looping node passes a single "is it running?" check during the
    // brief window between restarts, then is gone by registration time — which
    // surfaces as a baffling DNS error. Re-check after a pause, and report the
    // restart count so a loop is obvious.
    `sleep 20; cid=$(docker compose ps -q node 2>/dev/null); ` +
    `if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]; then ` +
    `  echo "NODE_STABLE restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null)"; fi; ` +
    `docker compose logs --tail 40 node`,
    { onData, timeoutMs: 900000 });
  if (r.code !== 0) throw new Error("Couldn't start tmkms/node:\n" + (r.stderr || "").slice(-600));
  if (!/NODE_UP/.test(r.stdout)) {
    throw new Error("The chain node container never started. Its last log lines are above — " +
      "they usually say why.");
  }
  if (!/NODE_STABLE/.test(r.stdout)) {
    throw new Error("The chain node started but then stopped again (it's crash-looping), so registration " +
      "would fail with a confusing DNS error. Its last log lines are above — they usually say why.");
  }
  return { ok: true };
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
    `grep -q 'device_ids' "$F" && echo IDS_OK; true`,
    { onData });
  return { caps: /CAPS_OK/.test(r.stdout), deviceIds: /IDS_OK/.test(r.stdout) };
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

async function containersStatus(driver) {
  const r = await driver.exec(
    `cd ${JOIN()} && docker compose -f docker-compose.yml -f docker-compose.mlnode.yml ps --format json 2>/dev/null || ` +
    `docker ps --format '{{.Names}}: {{.Status}}'`);
  return r.stdout;
}

module.exports = {
  cloneRepo, listNodeConfigs, readRepoFile, hardenPorts, writeConfigs, readServerKeyName,
  listComposeImages, serverArch,
  pullImages, startCore, warmKeyExists, createWarmKey, getConsensusKey,
  registerHost, launchAll, downloadWeights, containersStatus, nodeSyncStatus, prepareDataDirs, mlnodeStatus, ensureMlnodeCompose, ensureGpuRuntime
};
