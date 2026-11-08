/**
 * check-server-password.js — run with `node scripts/check-server-password.js`.
 *
 * The server's own key gets a random password of its own (renderer/app.js
 * newServerPassword), so the wallet's passphrase never goes to the server; a
 * password already in the server's config.env is kept word for word
 * (deploy.writeConfigs), because the key there opens only with it.
 *
 * Runs deploy.js's real commands in bash against a throwaway folder standing
 * in for the server's home. No Electron, no server, no network.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const deploy = require(path.join(ROOT, "src", "services", "deploy.js"));
const configgen = require(path.join(ROOT, "src", "services", "configgen.js"));

let failed = 0, passed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log("  ok   " + what); } else { failed++; console.log("  FAIL " + what); } };

// newServerPassword, taken from the renderer as written.
const appJs = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
const src = (appJs.match(/function newServerPassword\(\) \{[\s\S]*?\n\}/) || [])[0];
if (!src) { console.log("FAIL newServerPassword not found in renderer/app.js"); process.exit(1); }
const newServerPassword = new Function("crypto", src + "\nreturn newServerPassword;")(require("crypto").webcrypto);
if (/keyringPassword:\s*S\.wallet\.passphrase/.test(appJs)) { failed++; console.log("  FAIL renderer still puts the wallet passphrase into config.env"); }

// A stand-in for the server: every command runs in bash with HOME as its folder.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gnot-server-"));
const JOIN = path.join(HOME, "gonka", "deploy", "join");
// On Windows (Git Bash) a path bash prints, such as /tmp/..., is turned into the real one.
const fromBash = (p) => (process.platform === "win32" ? execFileSync("cygpath", ["-w", p], { encoding: "utf8" }).trim() : p);
const driver = {
  kind: "ssh",
  async exec(cmd) {
    try { return { code: 0, stdout: execFileSync("bash", ["-c", cmd], { cwd: HOME, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
    catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  },
  async writeFile(p, content) { fs.mkdirSync(path.dirname(fromBash(p)), { recursive: true }); fs.writeFileSync(fromBash(p), content); }
};
const sourced = (key) => execFileSync("bash", ["-c", `cd gonka/deploy/join && source config.env && printf '%s' "$${key}"`], { cwd: HOME, encoding: "utf8" });
const serverEnv = () => fs.readFileSync(path.join(JOIN, "config.env"), "utf8");
const setServerEnv = (text) => { fs.mkdirSync(JOIN, { recursive: true }); fs.writeFileSync(path.join(JOIN, "config.env"), text); };

// Gonka's template, as far as these lines go.
const TEMPLATE = "export KEY_NAME=<FILLIN>\nexport KEYRING_PASSWORD=<FILLIN>\nexport KEYRING_BACKEND=file\nexport PUBLIC_URL=<FILLIN>\nexport ACCOUNT_PUBKEY=<FILLIN>\n";
const PASS = "a correct horse; battery staple";   // a wallet passphrase, to be sure it never appears
const generate = (keyringPassword) => configgen.generateConfigEnv({
  keyName: "node-123456", keyringPassword, mode: "http", host: "203.0.113.7",
  accountPubkey: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2", seeds: ["http://node1.gonka.ai:8000"]
}, TEMPLATE);

(async () => {
  console.log("The password itself");
  const a = newServerPassword(), b = newServerPassword();
  ok(/^[0-9a-f]{48}$/.test(a), "48 hex characters");
  ok(a !== b, "a new one each time");

  console.log("A new server (config.env is Gonka's template, as the clone step copies it)");
  setServerEnv(TEMPLATE);
  ok(await deploy.serverKeyringLine(driver) === null, "the template's <FILLIN> is not a password to keep");
  const fresh = newServerPassword();
  let r = await deploy.writeConfigs(driver, { configEnv: generate(fresh), nodeConfigJson: "{}", gpuCount: 0 });
  ok(r.keptKeyringPassword === false, "nothing kept");
  ok(sourced("KEYRING_PASSWORD") === fresh, "config.env carries the new random password, and bash reads it back exactly");
  ok(!serverEnv().includes(PASS), "the wallet passphrase is nowhere in config.env");
  ok(sourced("KEY_NAME") === "node-123456", "the rest of config.env still reads normally");

  console.log("The same server again (a second run or a resumed setup)");
  r = await deploy.writeConfigs(driver, { configEnv: generate(newServerPassword()), nodeConfigJson: "{}", gpuCount: 0 });
  ok(r.keptKeyringPassword === true, "the password already there is kept");
  ok(sourced("KEYRING_PASSWORD") === fresh, "so the server's key still opens");

  console.log("A server set up by an earlier GNOT (its config.env holds the wallet passphrase)");
  const oldLine = "export KEYRING_PASSWORD=Tr0ub4dor&3";
  setServerEnv(TEMPLATE.replace("export KEYRING_PASSWORD=<FILLIN>", oldLine));
  ok(await deploy.serverKeyringLine(driver) === oldLine, "the old line is found word for word");
  r = await deploy.writeConfigs(driver, { configEnv: generate(newServerPassword()), nodeConfigJson: "{}", gpuCount: 0 });
  ok(r.keptKeyringPassword === true && serverEnv().split("\n").includes(oldLine), "and written back exactly as it was");
  ok(serverEnv().split("\n").filter((l) => /KEYRING_PASSWORD=/.test(l)).length === 1, "with only one KEYRING_PASSWORD line");

  console.log("Other shapes of config.env");
  setServerEnv("export KEYRING_PASSWORD=abc123def456      #\n");
  ok(await deploy.serverKeyringLine(driver) === "export KEYRING_PASSWORD=abc123def456      #", "a padded line with a trailing # is kept whole");
  setServerEnv("KEYRING_PASSWORD=\n");
  ok(await deploy.serverKeyringLine(driver) === null, "an empty password is not kept");
  setServerEnv("export KEYRING_PASSWORD=x\r\nexport KEY_NAME=n\r\n");
  ok(await deploy.serverKeyringLine(driver) === "export KEYRING_PASSWORD=x", "Windows line endings are dropped from the kept line");
  fs.rmSync(path.join(JOIN, "config.env"));
  ok(await deploy.serverKeyringLine(driver) === null, "no config.env: nothing to keep");
  fs.rmSync(path.join(HOME, "gonka"), { recursive: true });
  ok(await deploy.serverKeyringLine(driver) === null, "no Gonka folder at all: nothing to keep");

  console.log("withKeyringLine");
  ok(deploy.withKeyringLine("A=1\nexport KEYRING_PASSWORD=new\nB=2\n", "export KEYRING_PASSWORD=old") === "A=1\nexport KEYRING_PASSWORD=old\nB=2\n", "replaces the line in place");
  ok(deploy.withKeyringLine("A=1\n", "export KEYRING_PASSWORD=old") === "export KEYRING_PASSWORD=old\nA=1\n", "adds it when missing");

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; });
