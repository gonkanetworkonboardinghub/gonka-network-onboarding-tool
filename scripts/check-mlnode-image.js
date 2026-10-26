/**
 * check-mlnode-image.js — does GNOT pick Gonka's fallback ML node image on a
 * server whose NVIDIA driver is too old for the main one?
 *
 *   node scripts/check-mlnode-image.js
 *
 * Runs the very shell command deploy.ensureMlnodeCompose sends to a server,
 * here, against pretend servers: a folder laid out like Gonka's deploy/join
 * and an nvidia-smi that reports a chosen driver. One of them uses Gonka's
 * compose file as it is on GitHub right now. Needs bash (Git Bash on Windows).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const K = require("../src/knowledge");
const deploy = require("../src/services/deploy");

const NEW = "    # CUDA 12.9 fallback: ghcr.io/gonka-ai/mlnode:3.0.16-cu129@sha256:f3db246b45dbe7f71cb9d8ad8ab15877d31bf28f742da04eed22b177d78e62c3\n" +
  "    image: ${MLNODE_IMAGE:-ghcr.io/gonka-ai/mlnode:3.0.16@sha256:1b9b7ce55feecab837f1d7ce974fc5f377ae0a04a4fb403eeeb50130e7728ee1}\n";
const OLD = "    # NVIDIA driver older than 580 (CUDA 12.x): ghcr.io/gonka-ai/mlnode:4.0.0-cu12\n" +
  "    image: ${MLNODE_IMAGE:-ghcr.io/gonka-ai/mlnode:4.0.0}\n";
const NONE = "    image: ghcr.io/gonka-ai/mlnode:3.0.12\n";
const compose = (lines) => `services:\n  mlnode-308:\n${lines}    environment:\n      - HF_HOME=/root/.cache\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n`;

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

async function pretend(name, composeText, driverVersion, configEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gnot-mlnode-"));
  const join = path.join(root, K.get().repo.joinDir);
  fs.mkdirSync(join, { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(join, "docker-compose.mlnode.yml"), composeText);
  fs.writeFileSync(path.join(join, "config.env"), configEnv || "export KEY_NAME=test\n");
  fs.writeFileSync(path.join(root, "bin", "nvidia-smi"), `#!/bin/sh\necho "${driverVersion}"\n`, { mode: 0o755 });
  const driver = {
    kind: "ssh",
    exec: async (cmd) => {
      const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, d) => "/" + d.toLowerCase());
      const stdout = execFileSync(bash, ["-c", `export PATH="${posix(path.join(root, "bin"))}:$PATH"; cd "${posix(root)}" && ${cmd}`], { encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    }
  };
  const r = await deploy.ensureMlnodeCompose(driver, 8);
  const env = fs.readFileSync(path.join(join, "config.env"), "utf8");
  const set = (env.match(/^export MLNODE_IMAGE=(\S+)/m) || [])[1] || null;
  fs.rmSync(root, { recursive: true, force: true });
  return { name, driverVersion, image: set, reported: r.image, driverMajor: r.driverMajor };
}

(async () => {
  let live = null;
  try {
    const k = K.get();
    const url = `https://raw.githubusercontent.com/gonka-ai/gonka/${k.repo.branch}/${k.repo.joinDir.split("/").slice(1).join("/")}/docker-compose.mlnode.yml`;
    live = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).text();
  } catch (_) { /* offline: the pretend files still run */ }
  const cases = [
    ["Gonka's compose today, driver 570 (CUDA 12.8)", live, "570.133.20", "cu129"],
    ["Gonka's compose today, driver 575 (CUDA 12.9)", live, "575.57.08", "cu129"],
    ["Gonka's compose today, driver 580 (CUDA 13.0)", live, "580.126.09", null],
    ["current wording, driver 570", compose(NEW), "570.133.20", "cu129"],
    ["current wording, driver 590", compose(NEW), "590.48.01", null],
    ["v0.2.17 test wording, driver 575", compose(OLD), "575.57.08", "4.0.0-cu12"],
    ["v0.2.17 test wording, driver 580", compose(OLD), "580.126.09", null],
    ["no fallback named, driver 570", compose(NONE), "570.133.20", null],
    ["MLNODE_IMAGE already set by the person, driver 570", compose(NEW), "570.133.20", "mine:1", "export MLNODE_IMAGE=mine:1\n"]
  ];
  let failed = 0;
  for (const [name, text, drv, want, env] of cases) {
    if (!text) { console.log(`skip  ${name} (could not read Gonka's file)`); continue; }
    const r = await pretend(name, text, drv, env);
    const ok = want === null ? r.image === null : !!(r.image && r.image.includes(want));
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${r.image ? "uses " + r.image.replace(/@sha256:.*/, "@…") : "keeps the main image"}`);
  }
  if (failed) { console.log(`\n${failed} failed`); process.exitCode = 1; } else console.log("\nall good");
})().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
