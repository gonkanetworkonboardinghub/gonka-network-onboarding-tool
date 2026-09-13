/**
 * update.js — "is this copy of the app still allowed to run?"
 *
 * The app reads ONE JSON file from the website at launch (the same manifest
 * that can override Gonka facts — see knowledge.js). Its `app` section says
 * which version is current and which is the oldest still permitted:
 *
 *   { "app": { "latest": "0.3.0", "minSupported": "0.3.0",
 *              "url": "https://…/releases/latest/download/Gonka-Host-Setup.exe",
 *              "installer": "https://…/releases/download/v0.3.0/Gonka-Host-Setup-Setup-0.3.0.exe",
 *              "sha256": "…", "notes": "Fixes registration gas.",
 *              "mac": { "latest": "0.3.0", "minSupported": "0.3.0",
 *                       "arm64": { "url": "…-mac-arm64.zip", "sha256": "…" },
 *                       "x64":   { "url": "…-mac-x64.zip",   "sha256": "…" } } } }
 *
 * The top-level fields are Windows: that's what 1.0.0–1.0.2 read, so they
 * stay put. `installer` is the exact, versioned file the in-app updater
 * downloads (see updater.js); `url` always points at the newest release.
 * Macs read the `mac` block, which has its own latest/minSupported so a
 * Windows-only release never nags Mac users about a version they can't get.
 *
 * EVERY update is required: a copy older than `latest` can't be used until it
 * updates (about a minute, progress kept). Gonka changes often, and an
 * outdated setup tool fails in ways that cost people rented GPU time, so the
 * publisher wants nobody on an old version. `minSupported` is still honoured
 * (and release.js sets it to each new version) because copies up to 1.0.2
 * only block on it.
 *
 * FAILS OPEN. If the manifest can't be fetched — site down, hotel wifi, DNS —
 * the app runs normally. Blocking on a network hiccup would strand someone
 * mid-setup with a rented GPU burning money.
 */

// Where a Mac without a usable download is sent: the README's install section.
const MAC_INSTALL_PAGE = "https://github.com/gonkanetworkonboardinghub/gonka-host-setup#install";

function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The manifest fields that apply to this platform, in the Windows shape. */
function forPlatform(app, platform, arch) {
  if (platform !== "darwin") return app;
  const mac = app.mac || {};
  const build = mac[arch === "arm64" ? "arm64" : "x64"] || {};
  return {
    latest: mac.latest,
    minSupported: mac.minSupported,
    notes: mac.notes !== undefined ? mac.notes : app.notes,
    url: mac.page || MAC_INSTALL_PAGE,
    installer: build.url,
    sha256: build.sha256
  };
}

/**
 * @param {string} current  this build's version (app.getVersion())
 * @param {object} manifest the `app` section, or null/undefined when unknown
 * @param {{platform?:string, arch?:string}} [where] defaults to Windows
 * @returns {{state:"ok"|"required", ...}}
 */
function evaluate(current, manifest, where = {}) {
  if (!manifest) return { state: "ok", current, checked: false };
  const info = forPlatform(manifest, where.platform, where.arch);
  // The manifest arrived but lists no release for this platform: nothing newer exists.
  if (!info.latest) return { state: "ok", current, checked: !!manifest.latest };
  const out = {
    current,
    checked: true,
    latest: info.latest,
    url: info.url || null,
    installer: info.installer || null,
    sha256: info.sha256 || null,
    notes: info.notes || "",
    state: "ok"
  };
  if (cmpVer(current, info.latest) < 0 || (info.minSupported && cmpVer(current, info.minSupported) < 0)) {
    out.state = "required";
    out.minSupported = info.latest;
  }
  return out;
}

module.exports = { cmpVer, evaluate };
