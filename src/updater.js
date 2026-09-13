/**
 * updater.js — fetch a new installer and prove it's the one we published.
 *
 * Why the app downloads updates itself instead of opening a browser: files a
 * browser saves are tagged "came from the internet", and both Windows
 * SmartScreen and macOS Gatekeeper stop unsigned apps carrying that tag. A
 * file the app fetches over HTTPS isn't tagged, so an update installs with no
 * warning and nobody has to go hunting for the download.
 *
 * Nothing runs unless its SHA-256 matches the manifest. A mismatch — a broken
 * download, the wrong asset — deletes the file and reports why.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

/**
 * @param {string[]} urls      tried in order; falsy entries are skipped
 * @param {string}   sha256    expected hex digest from the manifest
 * @param {string}   dest      where to save the installer
 * @param {(got:number,total:number)=>void} [onProgress]
 */
async function downloadVerified(urls, sha256, dest, onProgress) {
  const want = String(sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) {
    throw new Error("The update has no valid checksum in the manifest, so it can't be verified — not installing it.");
  }
  let checksumErr = null;
  let lastErr = null;
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`The download server answered HTTP ${res.status}.`);
      const total = Number(res.headers.get("content-length")) || 0;
      const hash = crypto.createHash("sha256");
      let got = 0;
      let lastTick = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          got += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 150) { lastTick = now; onProgress(got, total); }
          cb(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
      if (onProgress) onProgress(got, total);

      const have = hash.digest("hex");
      if (have !== want) {
        fs.rmSync(dest, { force: true });
        checksumErr = new Error("The downloaded update doesn't match its published checksum, so it wasn't run. Try again in a few minutes.");
        continue;
      }
      return { path: dest, bytes: got };
    } catch (e) {
      fs.rmSync(dest, { force: true });
      lastErr = e;
    }
  }
  // A checksum failure says more than a later 404 from the fallback address.
  throw checksumErr || lastErr || new Error("The manifest has no download address for this update.");
}

const started = (child) => new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
// The environment for whatever relaunches the app. ELECTRON_RUN_AS_NODE must
// not leak through: macOS's `open` passes the caller's environment on, and an
// app started with it runs as bare Node and exits instead of opening a window.
const relaunchEnv = () => { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; return env; };
const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
});

/** The .app bundle this process runs from on macOS, or null (dev runs, other OSes). */
function macBundlePath(execPath = process.execPath) {
  const bundle = path.resolve(execPath, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** Can this copy replace itself? The folder holding it must be writable. */
function canSelfUpdate(u, platform = process.platform) {
  if (!u || !u.sha256) return false;
  if (platform === "win32") return !!(u.installer || u.url);
  if (platform === "darwin") {
    const bundle = macBundlePath();
    if (!u.installer || !bundle) return false;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return true; } catch (_) { return false; }
  }
  return false;
}

/**
 * Windows: run the new NSIS installer with --updated. It waits for this
 * process to exit instead of asking the user to close the app, installs over
 * it, and relaunches the new version.
 */
async function startWindowsUpdate(u, tmpDir, onProgress) {
  const dest = path.join(tmpDir, `Gonka-Host-Setup-${u.latest}.exe`);
  await downloadVerified([u.installer, u.url], u.sha256, dest, onProgress);
  const child = spawn(dest, ["--updated"], { detached: true, stdio: "ignore", env: relaunchEnv() });
  await started(child);
  child.unref();
}

/**
 * macOS: unpack the new .app beside the installed one, then hand off to a
 * detached shell that waits for this process to exit, swaps the bundles and
 * reopens the app. Staging next to the old bundle keeps the swap a rename on
 * one volume, so a half-copied app can never be what launches.
 */
async function startMacUpdate(u, tmpDir, onProgress) {
  const bundle = macBundlePath();
  if (!bundle) throw new Error("This copy isn't running from an installed app, so it can't update itself.");
  const work = fs.mkdtempSync(path.join(tmpDir, "gonka-update-"));
  const zip = path.join(work, "update.zip");
  await downloadVerified([u.installer], u.sha256, zip, onProgress);
  const unpacked = path.join(work, "unpacked");
  await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
  const inner = fs.readdirSync(unpacked).find((f) => f.endsWith(".app"));
  if (!inner) throw new Error("The update download doesn't contain the app.");
  const staged = `${bundle}.update`;
  fs.rmSync(staged, { recursive: true, force: true });
  await run("/usr/bin/ditto", [path.join(unpacked, inner), staged]);

  const log = path.join(tmpDir, "gonka-update.log");
  const swap = [
    'pid="$1"; app="$2"; staged="$3"; work="$4"; log="$5"',
    'exec >>"$log" 2>&1',
    'echo "$(date) update: waiting for pid $pid to exit"',
    // Wait (up to 30 s) for the running app to quit.
    'for i in $(seq 1 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done',
    'rm -rf "$app.old"',
    'if mv "$app" "$app.old" && mv "$staged" "$app"; then rm -rf "$app.old"; echo "swapped in the new version"',
    'else echo "swap failed, keeping the old version"; [ -d "$app" ] || mv "$app.old" "$app"; fi',
    'xattr -dr com.apple.quarantine "$app" 2>/dev/null',
    'rm -rf "$work"',
    // Reopen. `open` can quietly do nothing while LaunchServices still thinks
    // the old copy is running, so check, then insist, then launch it directly.
    'running() { pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1; }',
    'waitrun() { for i in $(seq 1 25); do running && return 0; sleep 0.4; done; return 1; }',
    'open "$app"; if waitrun; then echo "reopened"; exit 0; fi',
    'echo "open did not start it; trying open -n"; open -n "$app"; if waitrun; then echo "reopened (open -n)"; exit 0; fi',
    'echo "starting the executable directly"; nohup "$app/Contents/MacOS/$(basename "$app" .app)" >/dev/null 2>&1 &'
  ].join("\n");
  const child = spawn("/bin/bash", ["-c", swap, "gonka-update", String(process.pid), bundle, staged, work, log],
    { detached: true, stdio: "ignore", env: relaunchEnv() });
  await started(child);
  child.unref();
}

module.exports = { downloadVerified, canSelfUpdate, macBundlePath, startWindowsUpdate, startMacUpdate };
