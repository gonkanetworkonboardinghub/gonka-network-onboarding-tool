/**
 * fixes.js — one-click repairs for issues found by scan.js.
 *
 * Every fix streams its output to the UI log. Fixes that install software
 * are shown to the user with the exact commands BEFORE running (the
 * renderer handles the confirmation), because the app never installs
 * anything silently.
 */
const K = require("../knowledge");

// Root-detection snippet embedded in every fix command. Kept as a single
// module-level constant so runFix() can strip it back out when turning a
// failed fix into a clean copy-paste command for the user.
const SUDO_PROBE = "sudo -n true 2>/dev/null && SUDO=sudo || SUDO=''; ";

/** Returns { cmd, description } or null if there is no automated fix. */
function planFix(id, facts) {
  const sudo = SUDO_PROBE;
  switch (id) {
    case "git":
    case "curl":
    case "jq":
      if (!facts.hasApt) return manualOnly(`Install ${id} with your distribution's package manager.`);
      return {
        description: `Install ${id} via apt`,
        cmd: `${sudo}$SUDO apt-get update -y && $SUDO apt-get install -y ${id}`
      };

    case "docker":
      return {
        description: "Install Docker using Docker's official convenience script",
        cmd: `curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && ${sudo}$SUDO sh /tmp/get-docker.sh`
      };

    case "docker-perm":
      // $USER is often unset over a non-interactive SSH exec (no login shell),
      // which would make usermod act on an empty name and "succeed" silently.
      // `id -un` always reports the real user. The wizard reconnects afterwards
      // so the new group actually applies — group changes need a fresh session.
      return {
        description: "Add this user to the docker group (the wizard reconnects afterwards so it takes effect)",
        cmd: `U=$(id -un) && ${sudo}$SUDO usermod -aG docker "$U" && echo "Added $U to the docker group."`
      };

    case "compose":
      if (!facts.hasApt) return manualOnly("Install the docker-compose-plugin package for your distribution.");
      return {
        description: "Install the Docker Compose v2 plugin via apt",
        cmd: `${sudo}$SUDO apt-get update -y && $SUDO apt-get install -y docker-compose-plugin`
      };

    case "nvidia-toolkit":
      if (!facts.hasApt) return manualOnly("Install the NVIDIA Container Toolkit for your distribution: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html");
      return {
        description: "Install NVIDIA Container Toolkit and wire it into Docker",
        cmd:
          sudo +
          `curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && ` +
          `curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | ` +
          `sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | ` +
          `$SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null && ` +
          `$SUDO apt-get update -y && $SUDO apt-get install -y nvidia-container-toolkit && ` +
          `$SUDO nvidia-ctk runtime configure --runtime=docker && $SUDO systemctl restart docker`
      };

    case "hf-cli":
      return {
        description: "Install the Hugging Face CLI (via pipx, falling back to pip)",
        cmd:
          sudo +
          `export PATH=$PATH:$HOME/.local/bin; ` +
          // Installing into whatever Python the image happens to ship is a
          // minefield: provider images variously use a root-owned virtualenv
          // (pip refuses --user AND the user can't write to it), a PEP 668
          // "externally managed" system python (plain install refused), or a
          // plain python. Rather than guess, build our OWN venv under the
          // user's home and symlink the binary into ~/.local/bin — which the
          // scan and the weights download already have on PATH. No root
          // needed, nothing shared is modified, same result everywhere.
          //
          // Package name is plain `huggingface_hub`: the [cli] extra was
          // removed in hub 1.x ("does not provide the extra 'cli'") and the
          // `hf` command ships in the base package. Older versions put
          // `huggingface-cli` there instead — both names are accepted.
          `mkdir -p "$HOME/.local/bin"; ` +
          `if command -v pipx >/dev/null; then pipx install huggingface_hub || true; fi; ` +
          `export PATH="$PATH:$HOME/.local/bin"; ` +
          `if ! (command -v hf || command -v huggingface-cli) >/dev/null 2>&1; then ` +
          `  VDIR="$HOME/.local/hfcli"; ` +
          `  python3 -m venv "$VDIR" 2>/dev/null || { $SUDO apt-get update -y && $SUDO apt-get install -y python3-venv && python3 -m venv "$VDIR"; }; ` +
          `  "$VDIR/bin/pip" install --upgrade pip >/dev/null 2>&1; ` +
          `  "$VDIR/bin/pip" install huggingface_hub; ` +
          `  for b in hf huggingface-cli; do [ -x "$VDIR/bin/$b" ] && ln -sf "$VDIR/bin/$b" "$HOME/.local/bin/$b"; done; ` +
          `fi; ` +
          `export PATH="$PATH:$HOME/.local/bin"; (command -v hf || command -v huggingface-cli) >/dev/null && echo OK`
      };

    case "cuda":
      if (!facts.hasApt) return manualOnly("Upgrade the NVIDIA driver to one supporting CUDA 12.6+ using your distribution's packages, then reboot.");
      return {
        description:
          "Upgrade the NVIDIA driver to a version supporting CUDA 12.6+ and REBOOT the server. " +
          "The connection will drop; wait ~2 minutes, then connect again and re-run the health check.",
        cmd:
          sudo +
          `export DEBIAN_FRONTEND=noninteractive; ` +
          `$SUDO apt-get update -y; ` +
          // Provider images often ship a partial/older driver (here: 535 →
          // CUDA 12.2) whose packages conflict with a newer one, so apt
          // refuses the upgrade. Purge every existing nvidia package first so
          // the new driver resolves cleanly. Safe on a rental — worst case is
          // destroy-and-re-rent.
          `$SUDO apt-get purge -y '^nvidia-.*' '^libnvidia-.*' 2>/dev/null; ` +
          `$SUDO apt-get -y autoremove 2>/dev/null; ` +
          `$SUDO apt-get install -y "linux-headers-$(uname -r)" 2>/dev/null; ` +
          `inst=""; ` +
          `for p in nvidia-driver-570-open nvidia-driver-570-server nvidia-open-570 nvidia-driver-565-open nvidia-open-560 nvidia-driver-560-open nvidia-open; do ` +
          `  if $SUDO apt-get install -y "$p"; then inst="$p"; break; fi; ` +
          `done; ` +
          `if [ -z "$inst" ]; then $SUDO apt-get install -y ubuntu-drivers-common && $SUDO ubuntu-drivers install && inst="auto"; fi; ` +
          // Verify a driver package is REALLY installed (dpkg state) before
          // rebooting — don't trust a fallback's exit code like last time.
          `if dpkg -l 2>/dev/null | grep -qE '^ii +nvidia-(driver|open|dkms)'; then ` +
          `  echo DRIVER_INSTALLED_REBOOTING && ($SUDO sh -c '(sleep 2 && reboot) >/dev/null 2>&1 &'); ` +
          `else echo "DRIVER_INSTALL_FAILED — this image has no clean recent driver available. Fastest fix: destroy this rental and start one whose image already ships CUDA 12.6+ (e.g. a CUDA 12.8 image)."; exit 1; fi`
      };

    case "hf-home": {
      const k = K.get();
      const dir = facts.hfHomePath || k.hfHome;   // the disk the scan picked
      return {
        description: `Create the model cache directory ${dir}`,
        cmd: `U=$(id -un); ${sudo}$SUDO mkdir -p ${dir} && $SUDO chown "$U" ${dir} 2>/dev/null || true; test -d ${dir} && echo OK`
      };
    }

    default:
      return null;
  }
}

function manualOnly(text) {
  return { description: text, cmd: null };
}

async function runFix(driver, id, facts, onData) {
  const plan = planFix(id, facts);
  if (!plan) return { code: 1, stderr: "No automated fix for: " + id };
  if (!plan.cmd) return { code: 1, stderr: plan.description };

  // Every fix installs system software, which needs root or passwordless
  // sudo. If the user's sudo asks for a password (typical on WSL and some
  // VPS images), running anyway just produces a confusing apt permission
  // error — check first and explain what to do instead.
  if (plan.cmd.includes("$SUDO")) {
    const priv = await driver.exec(
      `[ "$(id -u)" = 0 ] && echo PRIV_OK || (sudo -n true 2>/dev/null && echo PRIV_OK || echo PRIV_NONE)`);
    if (!priv.stdout.includes("PRIV_OK")) {
      // Strip the embedded root-detection plumbing (it can sit mid-command,
      // e.g. the Docker fix) so the user gets a clean, runnable command.
      const manual = plan.cmd
        .split(SUDO_PROBE).join("")
        .replace(/\$SUDO\s+/g, "sudo ")
        .replace(/\$SUDO/g, "sudo");
      return { code: 1, stderr:
        "This fix needs administrator (root) rights, and your account's sudo asks for a password — " +
        "the wizard can't type it for you.\n\n" +
        "Run this in a terminal on this machine" + (driver.kind === "local" ? " (WSL)" : "") + ":\n\n" +
        manual + "\n\nThen come back and press \"Run health check\" again." };
    }
  }
  return driver.exec(plan.cmd, { onData, timeoutMs: 15 * 60 * 1000 });
}

module.exports = { planFix, runFix };
