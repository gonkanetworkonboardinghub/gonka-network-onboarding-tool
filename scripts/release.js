/**
 * release.js — cut a new version, build it for Windows and macOS, stage the upload.
 *
 *   node scripts/release.js 1.1.0 --notes="What changed" --mac
 *   node scripts/release.js 1.1.0 --mac=path/to/zips  (Mac builds made elsewhere)
 *   (no --mac: Windows only; Mac users stay on their current release)
 *
 * Windows builds here. macOS can only be built on a Mac, so `--mac` commits
 * the source, pushes a v<version> tag to the private source repo, lets its
 * GitHub Actions Mac runner build (see .github/workflows/build-mac.yml),
 * waits for it and downloads the two zips (Apple silicon + Intel). Needs the
 * GitHub CLI (`gh`), logged in.
 *
 * The apps are not code-signed: a trusted signature must carry a verified
 * legal name, and the publisher chose not to put one on it. People never
 * meet SmartScreen or Gatekeeper anyway, because nothing they run comes from
 * a browser download:
 *   - first install: the website's one-line command (install.ps1 on
 *     Windows, install.sh on macOS) fetches the build, checks its SHA-256
 *     and installs it;
 *   - every update after that: the app downloads, verifies and installs it
 *     itself (src/updater.js).
 * Both rely on manifest.json carrying the right URLs and hashes, which is
 * exactly what this script writes.
 *
 * Every release is required: minSupported is always the new version, so
 * every older copy is blocked until it updates (see src/update.js).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const RELEASE_BASE = process.env.GONKA_RELEASE_BASE || "https://github.com/gonkanetworkonboardinghub/gonka-host-setup";
const LIVE_MANIFEST = "https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/manifest.json";
const MAC_WORKFLOW = "build.yml";
// The GitHub CLI: on PATH, or where it was unpacked for this machine's user.
const GH = (() => {
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "gh", "bin", "gh.exe");
  return fs.existsSync(local) ? local : "gh";
})();

const version = process.argv[2];
const notes = (process.argv.find((a) => a.startsWith("--notes=")) || "").replace("--notes=", "");
const macArg = process.argv.find((a) => a === "--mac" || a.startsWith("--mac="));

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/release.js <x.y.z> [--notes="..."] [--mac | --mac=<dir>]');
  process.exit(1);
}

const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The mac block currently published, so a Windows-only release doesn't drop it. */
async function publishedMacBlock() {
  try {
    const res = await fetch(LIVE_MANIFEST, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return ((await res.json()).app || {}).mac || null;
  } catch (_) {}
  try { return (JSON.parse(fs.readFileSync(path.join(root, "website", "manifest.json"), "utf8")).app || {}).mac || null; } catch (_) {}
  return null;
}

/** Commit, tag, push; wait for the Mac runner; download its zips. Returns their folder. */
async function buildMacOnGitHub() {
  try { sh(GH, ["auth", "status"]); } catch (_) {
    throw new Error("--mac needs the GitHub CLI, logged in (gh auth login).");
  }
  if (!fs.existsSync(path.join(root, ".git"))) throw new Error("--mac needs this folder to be the git repo that GitHub builds from.");
  const tag = `v${version}`;
  sh("git", ["add", "-A"]);
  try { sh("git", ["commit", "-m", `Release ${tag}`]); } catch (_) { /* nothing new to commit */ }
  const commit = sh("git", ["rev-parse", "HEAD"]);
  sh("git", ["push", "origin", "HEAD"]);
  sh("git", ["tag", "-f", tag]);
  sh("git", ["push", "-f", "origin", tag]);
  console.log(`pushed ${commit.slice(0, 7)} as ${tag}; waiting for the Mac build to start…`);

  let runId = null;
  for (let i = 0; i < 40 && !runId; i++) {
    await sleep(6000);
    const runs = JSON.parse(sh(GH, ["run", "list", "--workflow", MAC_WORKFLOW, "--limit", "10", "--json", "databaseId,headSha,createdAt"]));
    const mine = runs.filter((r) => r.headSha === commit).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (mine) runId = mine.databaseId;
  }
  if (!runId) throw new Error("The Mac build never started on GitHub. Check the Actions tab of the source repo.");
  console.log(`Mac build running (run ${runId}) — usually 6–10 minutes…`);
  // Asynchronously, so the Windows build keeps running in the meantime.
  const code = await new Promise((resolve) => {
    require("child_process").spawn(GH, ["run", "watch", String(runId), "--exit-status", "--interval", "30"], { cwd: root, stdio: "ignore" })
      .on("exit", resolve).on("error", () => resolve(1));
  });
  if (code !== 0) throw new Error(`The Mac build failed. See: gh run view ${runId} --log-failed`);
  console.log("Mac build finished and passed its checks.");
  const dir = path.join(root, "dist", `mac-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  sh(GH, ["run", "download", String(runId), "-n", "mac-build", "-D", dir]);
  return dir;
}

(async () => {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const previous = { version: pkg.version, released: pkg.gonkaReleased };
  const restore = () => {
    pkg.version = previous.version;
    if (previous.released) pkg.gonkaReleased = previous.released; else delete pkg.gonkaReleased;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  };
  pkg.version = version;
  // The date the app shows in its version line. A re-run of the same version keeps the first date.
  if (previous.version !== version || !pkg.gonkaReleased) pkg.gonkaReleased = today();
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`version ${previous.version} -> ${version} (released ${pkg.gonkaReleased})`);

  // Start the Mac build first: it runs on GitHub while Windows builds here.
  let macDir = null, macError = null;
  const macJob = macArg === "--mac"
    ? buildMacOnGitHub().then((d) => { macDir = d; }, (e) => { macError = e; })
    : Promise.resolve(macArg ? (macDir = path.resolve(macArg.slice("--mac=".length))) : null);

  const { build, Platform } = require("electron-builder");
  try {
    // A copy: electron-builder may annotate the config it's given, and pkg is
    // written back to package.json below.
    const config = JSON.parse(JSON.stringify(pkg.build || {}));
    await build({ targets: Platform.WINDOWS.createTarget(), config, publish: "never", projectDir: root });
  } catch (e) {
    restore();
    console.error("\nWINDOWS BUILD FAILED — version restored to " + previous.version + ".\n" + (e && e.message ? e.message : e));
    process.exit(1);
  }
  await macJob;
  if (macError) {
    restore();
    console.error("\nMAC BUILD FAILED — version restored to " + previous.version + ". Nothing was staged.\n" + macError.message);
    process.exit(1);
  }

  const dist = path.join(root, "dist");
  const exe = fs.readdirSync(dist).find((f) => f.endsWith(`${version}.exe`) && !f.includes("__uninstaller"));
  if (!exe) {
    console.error("Built installer not found in dist/ — did the build fail?");
    process.exit(1);
  }
  const exePath = path.join(dist, exe);
  const sha256 = sha256Of(exePath);

  // Two names for the same Windows file. The versioned one is what the app and
  // install.ps1 download — it never changes once published, so it always
  // matches the manifest's checksum. The constant one is served by GitHub at
  // /releases/latest/download/<name>, so the website's direct link never changes.
  const constName = "Gonka-Network-Onboarding-Tool.exe";
  const fileName = exe.replace(/\s+/g, "-");   // GitHub turns spaces into dots
  const tag = `v${version}`;
  const download = (name) => `${RELEASE_BASE}/releases/download/${tag}/${name}`;

  const manifest = {
    app: {
      latest: version,
      minSupported: version,   // every update is required
      url: `${RELEASE_BASE}/releases/latest/download/${constName}`,
      installer: download(fileName),
      sha256,
      notes: notes || ""
    }
  };

  const macZips = [];
  if (macDir) {
    const mac = { latest: version, minSupported: version, notes: notes || "" };
    for (const arch of ["arm64", "x64"]) {
      const name = `Gonka-Network-Onboarding-Tool-${version}-mac-${arch}.zip`;
      const file = path.join(macDir, name);
      if (!fs.existsSync(file)) {
        restore();
        console.error(`Mac build is missing ${name} in ${macDir}. Nothing was staged.`);
        process.exit(1);
      }
      mac[arch] = { url: download(name), sha256: sha256Of(file) };
      macZips.push(file);
    }
    manifest.app.mac = mac;
  } else {
    const prior = await publishedMacBlock();
    if (prior) manifest.app.mac = prior;
  }

  pkg.gonkaMinSupported = manifest.app.minSupported;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const web = path.join(root, "website");
  fs.mkdirSync(web, { recursive: true });
  // Clear out the previous release's builds so the folder only ever holds
  // what needs uploading now.
  for (const f of fs.readdirSync(web)) {
    if (/^(Gonka-Host-Setup|Gonka-Network-Onboarding-Tool)(-Setup-.*\.exe|-.*-mac-.*\.zip|\.exe)$/.test(f)) fs.rmSync(path.join(web, f));
  }
  fs.copyFileSync(exePath, path.join(web, fileName));
  fs.copyFileSync(exePath, path.join(web, constName));
  for (const z of macZips) fs.copyFileSync(z, path.join(web, path.basename(z)));
  fs.writeFileSync(path.join(web, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.copyFileSync(path.join(root, "scripts", "install.ps1"), path.join(web, "install.ps1"));
  fs.copyFileSync(path.join(root, "scripts", "install.sh"), path.join(web, "install.sh"));

  console.log("\n────────────────────────────────────────────────────────");
  console.log(`release ${version}   Windows ${(fs.statSync(exePath).size / 1e6).toFixed(1)} MB   sha256 ${sha256}`);
  for (const z of macZips) console.log(`              ${path.basename(z)}   ${(fs.statSync(z).size / 1e6).toFixed(1)} MB`);
  if (!macDir) console.log("              (Windows only — Mac users keep " + ((manifest.app.mac && manifest.app.mac.latest) || "no Mac release") + ")");
  console.log("\nSTAGED FOR UPLOAD in website/ — in this order:");
  console.log(`  1. GitHub → Releases → new release, tag EXACTLY ${tag}, attach:`);
  console.log(`       ${fileName}`);
  console.log(`       ${constName}`);
  for (const z of macZips) console.log(`       ${path.basename(z)}`);
  console.log("  2. GitHub → Code tab → upload manifest.json, install.ps1 and install.sh");
  console.log("     (always all three; an unchanged file is simply skipped by GitHub).");
  console.log("  Step 2 goes live the moment it's committed, so do it after step 1.");
  console.log("\nRequired update: every older copy is blocked until it updates to " + version + ".");
  console.log("────────────────────────────────────────────────────────");
})();
