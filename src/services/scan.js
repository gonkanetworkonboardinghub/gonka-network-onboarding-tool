/**
 * scan.js — inspects the SERVER (via the active driver) and returns a
 * checklist of pass / warn / fail items, each with a machine-readable id
 * that fixes.js knows how to repair.
 */
const K = require("../knowledge");

function verLte(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return true;
}

async function runScan(driver) {
  const k = K.get();
  const items = [];
  const facts = {};
  const add = (id, label, status, detail, fixable = false) =>
    items.push({ id, label, status, detail, fixable });

  // --- OS / arch ---
  const uname = await driver.exec("uname -sm 2>/dev/null");
  facts.uname = uname.stdout.trim();
  if (uname.code !== 0 || !/Linux/i.test(uname.stdout)) {
    add("os", "Operating system", "fail",
      "The server must run Linux. Detected: " + (facts.uname || "unknown") +
      ". If you're on Windows locally, install WSL2 (Ubuntu) and restart the wizard.");
  } else {
    const archOk = /x86_64|amd64/.test(uname.stdout);
    add("os", "Operating system", archOk ? "pass" : "warn",
      facts.uname + (archOk ? "" : " — Gonka expects amd64 servers."));
  }

  // --- Package manager (used by fixes) ---
  const apt = await driver.exec("command -v apt-get >/dev/null && echo yes || echo no");
  facts.hasApt = apt.stdout.trim() === "yes";

  // --- CPU / RAM / disk ---
  const cpu = await driver.exec("nproc 2>/dev/null");
  facts.cpuCores = parseInt(cpu.stdout.trim(), 10) || 0;
  add("cpu", `CPU cores (need ${k.requirements.networkNode.cpuCores}+)`,
    facts.cpuCores >= k.requirements.networkNode.cpuCores ? "pass" : "warn",
    `${facts.cpuCores} cores detected`);

  const mem = await driver.exec("awk '/MemTotal/ {printf \"%d\", $2/1024/1024}' /proc/meminfo");
  facts.ramGB = parseInt(mem.stdout.trim(), 10) || 0;
  const ramOk = facts.ramGB >= k.requirements.networkNode.ramGB;
  add("ram", `RAM (need ${k.requirements.networkNode.ramGB}+ GB)`, ramOk ? "pass" : "fail",
    `${facts.ramGB} GB detected` + (ramOk ? "" :
      ` — below Gonka's minimum. Any supported GPU setup also needs RAM of at least ` +
      `${k.requirements.mlNodeRamToVramRatio}× its total VRAM, which is far more than this. ` +
      `Use a machine with more memory.`));

  // Model weights are hundreds of GB, and rented GPU boxes almost always put
  // the big volume somewhere other than / (e.g. a 3 TB /ephemeral beside a
  // 97 GB root). Checking only / made the wizard both warn wrongly AND then
  // download weights onto the small disk until it filled. Pick the roomiest
  // real filesystem and put the model cache there.
  // NB: -P and --output are mutually exclusive in coreutils df. Use --output
  // alone (avail first so the mount point, which may contain spaces, is last).
  const dfOut = await driver.exec(
    "df -B1 --output=avail,target -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2");
  const mounts = dfOut.stdout.trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.+?)\s*$/);
    return m ? { target: m[2], gb: Math.floor(parseInt(m[1], 10) / 1e9) } : null;
  }).filter(Boolean).filter((x) => !/^\/(boot|snap)/.test(x.target));

  const rootMount = mounts.find((m) => m.target === "/");
  facts.diskGB = rootMount ? rootMount.gb : 0;
  const best = mounts.slice().sort((a, b) => b.gb - a.gb)[0] || rootMount;
  facts.weightsMount = best ? best.target : "/";
  facts.weightsGB = best ? best.gb : 0;
  // Keep the documented default when / really is the biggest disk.
  facts.hfHomePath = facts.weightsMount === "/" ? k.hfHome
    : `${facts.weightsMount.replace(/\/$/, "")}/gonka-shared`;

  // Docker images alone are ~60 GB and always land on Docker's own storage
  // dir, which the wizard can't relocate. Check that filesystem separately —
  // a roomy /ephemeral doesn't help if / can't hold the images.
  const dockerRoot = await driver.exec(
    "docker info 2>/dev/null | grep -i 'docker root dir' | sed 's/.*: *//'");
  const drPath = dockerRoot.stdout.trim() || "/var/lib/docker";
  const safePath = /^[A-Za-z0-9._\/-]+$/.test(drPath) ? drPath : "/var/lib/docker";
  const drAvail = await driver.exec(`df -B1 --output=avail ${safePath} 2>/dev/null | tail -1 | tr -dc '0-9'`);
  facts.dockerDiskGB = Math.floor((parseInt(drAvail.stdout.trim(), 10) || 0) / 1e9);
  if (facts.dockerDiskGB) {
    add("docker-disk", "Room for Gonka's software (~60 GB of container images)",
      facts.dockerDiskGB >= 70 ? "pass" : "warn",
      `${facts.dockerDiskGB} GB free where Docker stores images (${drPath})` +
      (facts.dockerDiskGB >= 70 ? "" :
        ". The images need roughly 60 GB and can't be moved to another disk — if this fills up, the download fails partway."));
  }

  const needGB = k.requirements.networkNode.diskGB;
  const elsewhere = facts.weightsMount !== "/";
  add("disk", `Free disk (need ~${needGB} GB, plus model weights)`,
    facts.weightsGB >= needGB ? "pass" : "warn",
    `${facts.weightsGB} GB free on ${facts.weightsMount}` +
    (elsewhere ? ` — model weights go to ${facts.hfHomePath} (your largest disk; / has only ${facts.diskGB} GB)` : "") +
    (/ephemeral|scratch|tmp/i.test(facts.weightsMount)
      ? ". Note: this volume is labelled ephemeral by your provider — weights may be wiped if the server is stopped, and would need re-downloading."
      : ""));

  // --- git / curl / jq / unzip ---
  for (const tool of ["git", "curl", "jq"]) {
    const r = await driver.exec(`command -v ${tool} >/dev/null && echo yes || echo no`);
    const ok = r.stdout.trim() === "yes";
    facts[tool] = ok;
    add(tool, `${tool} installed`, ok ? "pass" : "fail", ok ? "" : `${tool} is required.`, !ok);
  }

  // --- Docker + compose ---
  const docker = await driver.exec("docker --version 2>/dev/null");
  facts.docker = docker.code === 0;
  add("docker", "Docker installed", facts.docker ? "pass" : "fail",
    facts.docker ? docker.stdout.trim() : "Docker is required to run all Gonka services.", !facts.docker);

  if (facts.docker) {
    const dperm = await driver.exec("docker info >/dev/null 2>&1 && echo yes || echo no");
    facts.dockerUsable = dperm.stdout.trim() === "yes";
    add("docker-perm", "Docker usable by this user", facts.dockerUsable ? "pass" : "fail",
      facts.dockerUsable ? "" : "This user can't talk to the Docker daemon (needs the `docker` group or root).",
      !facts.dockerUsable);

    const compose = await driver.exec("docker compose version 2>/dev/null");
    facts.compose = compose.code === 0;
    add("compose", "Docker Compose v2", facts.compose ? "pass" : "fail",
      facts.compose ? compose.stdout.trim() : "The `docker compose` plugin is required.", !facts.compose);
  }

  // --- NVIDIA GPU / driver / CUDA ---
  const smi = await driver.exec(
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null");
  if (smi.code === 0 && smi.stdout.trim()) {
    facts.gpus = smi.stdout.trim().split("\n").map((l) => {
      const [name, mem] = l.split(",").map((s) => s.trim());
      return { name, vramMiB: parseInt(mem, 10) || 0 };
    });
    const totVram = Math.round(facts.gpus.reduce((a, g) => a + g.vramMiB, 0) / 1024);
    // "Some NVIDIA GPU responds" is not the same as "a GPU Gonka supports" —
    // check the name against the supported classes so a laptop/consumer card
    // doesn't show up green and mislead someone into deploying on it.
    const gpuClass = k.gpuClasses.find((c) => c.match.test(facts.gpus[0].name));
    facts.gpuClass = gpuClass ? gpuClass.id : null;
    add("gpu", "NVIDIA GPU(s)", gpuClass ? "pass" : "fail",
      `${facts.gpus.length}× ${facts.gpus[0].name} — ${totVram} GB total VRAM` +
      (gpuClass ? "" :
        " — NOT a supported GPU class (" + k.gpuClasses.map((c) => c.id).join(" / ") + "). " +
        "This machine cannot run any approved model or earn Proof of Compute rewards, so setup " +
        "can't continue. Use a server with supported GPUs — see the table on the Welcome page."));
    // Per-GPU health probe. A dying GPU can still ENUMERATE (nvidia-smi lists
    // it) while CUDA can't initialize it — seen live on a rented 4×A100 where
    // GPU 3 answered "[N/A]" to the utilization query, was silently dropped
    // from containers, and killed vLLM at the next PoC with "World size (4) is
    // larger than the number of available GPUs (3)". Mixed readings (some
    // GPUs report %, one reports [N/A]) are that exact signature. All-[N/A]
    // is different: some virtualized stacks never expose utilization at all.
    const util = await driver.exec(
      "nvidia-smi --query-gpu=index,utilization.gpu --format=csv,noheader 2>/dev/null");
    if (util.code === 0 && util.stdout.trim()) {
      const rows = util.stdout.trim().split("\n").map((l) => {
        const [idx, u] = l.split(",").map((s) => s.trim());
        return { idx, na: /n\/?a/i.test(u) };
      });
      const bad = rows.filter((r) => r.na);
      if (bad.length && bad.length < rows.length) {
        add("gpu-health", "All GPUs responding to the driver", "fail",
          `GPU ${bad.map((b) => b.idx).join(", ")} is not answering health queries while the others are — ` +
          `on real hardware this means that GPU is faulty even though it appears in the list. ` +
          `The model needs every GPU, so Proof of Compute would fail. ` +
          `Contact your provider (ask for a reboot of the HOST machine, or a replacement instance) before continuing.`);
      } else {
        add("gpu-health", "All GPUs responding to the driver", "pass",
          `${rows.length} GPU(s) answering health queries`);
      }
    }

    // RAM vs VRAM ratio
    // MemTotal is always a few % under the advertised size (firmware/kernel
    // reservations), so a machine sold as "480 GB" reports ~472 GB and would
    // fail an exact 1.5× test on rounding alone. Allow 5% before warning —
    // a genuinely undersized box misses by far more than that.
    const needRam = Math.ceil(totVram * k.requirements.mlNodeRamToVramRatio);
    add("ram-vram", `RAM ≥ ${k.requirements.mlNodeRamToVramRatio}× VRAM (${needRam} GB)`,
      facts.ramGB >= needRam * 0.95 ? "pass" : "warn",
      `${facts.ramGB} GB RAM vs ${totVram} GB VRAM` +
      (facts.ramGB < needRam && facts.ramGB >= needRam * 0.95
        ? " — within the normal reporting margin, fine to proceed" : ""));

    const cudaLine = await driver.exec("nvidia-smi | grep -o 'CUDA Version: [0-9.]*' | head -1");
    const cuda = (cudaLine.stdout.match(/([0-9]+\.[0-9]+)/) || [])[1];
    facts.cuda = cuda || null;
    if (cuda) {
      // Too-old and too-new are very different situations: an old driver
      // genuinely can't run Gonka's CUDA 12.6+ containers (blocker, but
      // fixable by upgrading the driver); a newer driver is backward-
      // compatible and usually fine, just untested.
      const tooOld = !verLte(k.requirements.cudaMin, cuda);
      const tooNew = !verLte(cuda, k.requirements.cudaMax);
      if (tooOld) {
        add("cuda", `CUDA ${k.requirements.cudaMin}–${k.requirements.cudaMax}`, "fail",
          `CUDA ${cuda} detected — the NVIDIA driver is too old to run Gonka's containers. ` +
          `The Fix upgrades the driver and reboots the server (fine on a rental — reconnect afterwards).`,
          facts.hasApt && driver.kind === "ssh");
      } else if (tooNew) {
        add("cuda", `CUDA ${k.requirements.cudaMin}–${k.requirements.cudaMax}`, "warn",
          `CUDA ${cuda} detected — newer than the tested range. NVIDIA drivers are backward-compatible, ` +
          `so this usually works fine; it just hasn't been validated by Gonka yet.`);
      } else {
        add("cuda", `CUDA ${k.requirements.cudaMin}–${k.requirements.cudaMax}`, "pass", `CUDA ${cuda} detected`);
      }
    } else {
      add("cuda", "CUDA version", "warn", "Couldn't read the CUDA version from nvidia-smi.");
    }

    const toolkit = await driver.exec(
      "command -v nvidia-ctk >/dev/null && echo yes || (docker info 2>/dev/null | grep -qi nvidia && echo yes || echo no)");
    facts.nvidiaToolkit = toolkit.stdout.includes("yes");
    add("nvidia-toolkit", "NVIDIA Container Toolkit", facts.nvidiaToolkit ? "pass" : "fail",
      facts.nvidiaToolkit ? "" : "Required so Docker containers can use the GPU.", !facts.nvidiaToolkit);
  } else {
    facts.gpus = [];
    add("gpu", "NVIDIA GPU(s)", "fail",
      "No NVIDIA GPU detected (nvidia-smi failed). An ML node needs at least one supported GPU. " +
      "If this machine will run ONLY the Network Node, you can continue, but you won't earn PoC rewards without a GPU.");
  }

  // --- HF cache dir + huggingface-cli ---
  const cacheDir = facts.hfHomePath || k.hfHome;
  const hf = await driver.exec(`test -d ${cacheDir} && echo yes || echo no`);
  facts.hfHome = hf.stdout.trim() === "yes";
  add("hf-home", `Model cache directory (${cacheDir})`, facts.hfHome ? "pass" : "warn",
    facts.hfHome ? "" : "Will be created automatically before downloading weights.", !facts.hfHome);

  // huggingface_hub 1.x renamed the CLI from `huggingface-cli` to `hf` (the
  // old name still installs but refuses to run) — accept either.
  const hfcli = await driver.exec(
    "export PATH=$PATH:$HOME/.local/bin; (command -v hf || command -v huggingface-cli) >/dev/null && echo yes || echo no");
  facts.hfCli = hfcli.stdout.trim().endsWith("yes");
  add("hf-cli", "Hugging Face CLI (weights downloader)", facts.hfCli ? "pass" : "fail",
    facts.hfCli ? "" : "Needed to pre-download model weights.", !facts.hfCli);

  // --- Dangerous ports publicly bound? ---
  const listen = await driver.exec("ss -lntH 2>/dev/null || netstat -lnt 2>/dev/null");
  const bad = [];
  for (const p of k.ports.internalOnly) {
    const re = new RegExp(`(0\\.0\\.0\\.0|\\*|::):${p}\\b`);
    if (re.test(listen.stdout)) bad.push(p);
  }
  facts.publicInternalPorts = bad;
  add("ports", "Internal ports not publicly exposed", bad.length ? "fail" : "pass",
    bad.length
      ? `Ports ${bad.join(", ")} are listening on all interfaces. These must be localhost-only — a third party could overload your node or knock it out of an epoch. The wizard binds them to 127.0.0.1 in the compose files it writes.`
      : "No internal Gonka ports are currently exposed.");

  // --- Public IP (for PUBLIC_URL suggestion) ---
  const ip = await driver.exec("curl -s --max-time 8 https://api.ipify.org || true");
  facts.publicIp = /^[0-9.]+$/.test(ip.stdout.trim()) ? ip.stdout.trim() : null;

  const failCount = items.filter((i) => i.status === "fail").length;
  return { items, facts, ok: failCount === 0 };
}

module.exports = { runScan };
