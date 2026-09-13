/**
 * publish.js — put the release staged in website/ live on the public repo.
 *
 *   node scripts/publish.js            → shows what would be published; changes nothing
 *   node scripts/publish.js --confirm  → publishes it
 *
 * Publishing, in this order:
 *   1. GitHub release v<version> on the public repo, with the Windows
 *      installer (twice: versioned + constant name) and the Mac zips;
 *   2. install.ps1, install.sh and README.md in the repo root;
 *   3. manifest.json — LAST, because the moment it changes every copy of the
 *      app and every install command starts using the new version.
 * Every build's SHA-256 is checked against the manifest before upload and
 * against GitHub's own digest after, so a wrong or truncated file never goes
 * live. Needs the GitHub CLI, logged in with write access to the public repo.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const web = path.join(root, "website");
const REPO = process.env.GONKA_PUBLIC_REPO || "gonkanetworkonboardinghub/gonka-host-setup";
const confirm = process.argv.includes("--confirm");
const GH = (() => {
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "gh", "bin", "gh.exe");
  return fs.existsSync(local) ? local : "gh";
})();
const gh = (args, input) => execFileSync(GH, args, { cwd: root, encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const die = (msg) => { console.error("\n" + msg + "\nNothing further was published."); process.exit(1); };

const manifest = JSON.parse(fs.readFileSync(path.join(web, "manifest.json"), "utf8"));
const app = manifest.app || {};
const version = app.latest;
if (!version) die("website/manifest.json has no app.latest — run scripts/release.js first.");
const tag = `v${version}`;

// The builds, each with the hash the manifest promises for it.
const builds = [
  { file: `Gonka-Host-Setup-Setup-${version}.exe`, sha: app.sha256 },
  { file: "Gonka-Host-Setup.exe", sha: app.sha256 }
];
const mac = app.mac && app.mac.latest === version ? app.mac : null;
if (mac) {
  for (const arch of ["arm64", "x64"]) builds.push({ file: `Gonka-Host-Setup-${version}-mac-${arch}.zip`, sha: mac[arch].sha256 });
}
for (const b of builds) {
  const p = path.join(web, b.file);
  if (!fs.existsSync(p)) die(`Missing website/${b.file}.`);
  if (sha256Of(p) !== b.sha) die(`website/${b.file} doesn't match the SHA-256 in manifest.json.`);
}
const repoFiles = ["install.ps1", "install.sh", "README.md", "manifest.json"];   // manifest last
for (const f of repoFiles) if (!fs.existsSync(path.join(web, f))) die(`Missing website/${f}.`);

console.log(`Release ${tag} → github.com/${REPO}`);
for (const b of builds) console.log(`  release file  ${b.file}  (${(fs.statSync(path.join(web, b.file)).size / 1e6).toFixed(1)} MB, sha256 ok)`);
for (const f of repoFiles) console.log(`  repo file     ${f}`);
console.log(`  Windows: latest ${app.latest}, minSupported ${app.minSupported}` + (mac ? ` | Mac: latest ${mac.latest}${mac.minSupported ? ", minSupported " + mac.minSupported : ""}` : " | Mac: unchanged"));
if (!confirm) { console.log("\nDry run. Re-run with --confirm to publish."); process.exit(0); }

// 1. The release and its files.
let exists = true;
try { gh(["release", "view", tag, "--repo", REPO, "--json", "tagName"]); } catch (_) { exists = false; }
const paths = builds.map((b) => path.join(web, b.file));
if (exists) {
  console.log(`\nRelease ${tag} exists — replacing its files…`);
  gh(["release", "upload", tag, ...paths, "--repo", REPO, "--clobber"]);
} else {
  console.log(`\nCreating release ${tag} and uploading ${paths.length} files…`);
  gh(["release", "create", tag, ...paths, "--repo", REPO, "--title", `Gonka Host Setup ${version}`, "--notes", app.notes || `Gonka Host Setup ${version}`]);
}
const assets = JSON.parse(gh(["api", `repos/${REPO}/releases/tags/${tag}`, "--jq", "[.assets[] | {name, digest, state}]"]));
for (const b of builds) {
  const a = assets.find((x) => x.name === b.file);
  if (!a || a.state !== "uploaded" || a.digest !== `sha256:${b.sha}`) die(`GitHub's copy of ${b.file} doesn't match (${a ? a.digest : "missing"}).`);
}
console.log("  all release files verified against GitHub's digests");

// 2 + 3. Repo files through the contents API (commits as the logged-in account).
for (const f of repoFiles) {
  const content = fs.readFileSync(path.join(web, f));
  let sha = null, same = false;
  try {
    const cur = JSON.parse(gh(["api", `repos/${REPO}/contents/${f}`, "--jq", "{sha, content}"]));
    sha = cur.sha;
    same = Buffer.from(cur.content.replace(/\s/g, ""), "base64").equals(content);
  } catch (_) { /* new file */ }
  if (same) { console.log(`  ${f} unchanged`); continue; }
  const body = JSON.stringify({ message: `${f} for ${tag}`, content: content.toString("base64"), ...(sha ? { sha } : {}) });
  gh(["api", "-X", "PUT", `repos/${REPO}/contents/${f}`, "--input", "-"], body);
  console.log(`  ${f} updated`);
}
console.log(`\nPublished ${tag}. The website's commands and every running copy now see ${version}.`);
