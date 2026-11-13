/**
 * check-ports.js — run with `node scripts/check-ports.js`.
 *
 * A port on the server that another program already holds must not end a
 * launch a minute in. Seen on a rented 2 × H200 server on 2026-11-12: Docker
 * refused to start Gonka's api container, "failed to bind host port
 * 127.0.0.1:9100/tcp: address already in use".
 *
 * What is checked (src/services/ports.js, deploy.js, fixes.js):
 *   - the listing of what listens on the server is read right (ss and netstat);
 *   - the three ports Gonka needs only inside Docker (9100, 8080, 5050) are
 *     published elsewhere when another program holds them, and only then;
 *   - a second launch changes nothing, and a node already running is left alone;
 *   - a port that has to be free is named with the program that holds it and
 *     the command that stops it, never sshd or Docker;
 *   - Docker's own error is turned into that plain sentence.
 *
 * Runs deploy.js's real commands in bash against a throwaway folder standing
 * in for the server's home, with stand-ins for ss, sudo, docker and ps. No
 * Electron, no server, no network.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const Ports = require(path.join(ROOT, "src", "services", "ports.js"));
const deploy = require(path.join(ROOT, "src", "services", "deploy.js"));
const fixes = require(path.join(ROOT, "src", "services", "fixes.js"));

let failed = 0, passed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log("  ok   " + what); } else { failed++; console.log("  FAIL " + what); } };

// The port lines of Gonka's two compose files (deploy/join, v0.2.16), as published.
const COMPOSE = [
  "services:",
  "  node:",
  "    ports:",
  '      - "5000:26656" #p2p',
  "  api:",
  "    environment:",
  "      - DAPI_API__ML_SERVER_PORT=9100",
  "    ports:",
  '      - "9100:9100"',
  '      - "127.0.0.1:9200:9200"',
  "    restart: always",
  "  proxy:",
  "    ports:",
  '      - "${API_PORT:-8000}:80"',
  '      - "${API_SSL_PORT:-8443}:443"',
  ""].join("\n");
const MLNODE = [
  "services:",
  "  inference:",
  "    image: nginx:1.28.0",
  "    ports:",
  '      - "${PORT:-8080}:8080"',
  '      - "${INFERENCE_PORT:-5050}:5000"',
  ""].join("\n");

// What `ss -lntpH` prints on a server, as root.
const SS = (...lines) => lines.join("\n") + "\n";
const SSHD = 'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=901,fd=3))';
const SSHD6 = 'LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=901,fd=4))';
const EXPORTER = 'LISTEN 0      4096               *:9100             *:*    users:(("node_exporter",pid=777,fd=3))';
const EXPORTER_LOCAL = 'LISTEN 0      4096       127.0.0.1:9100       0.0.0.0:*    users:(("node_exporter",pid=777,fd=3))';

// A stand-in for the server: every command runs in bash with HOME as its
// folder and stand-ins for ss, sudo, docker and ps first on the PATH.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gnot-ports-"));
const JOIN = path.join(HOME, "gonka", "deploy", "join");
const BIN = path.join(HOME, "bin");
fs.mkdirSync(JOIN, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
const toBash = (p) => (process.platform === "win32" ? execFileSync("cygpath", ["-u", p], { encoding: "utf8" }).trim() : p);
const fromBash = (p) => (process.platform === "win32" ? execFileSync("cygpath", ["-w", p], { encoding: "utf8" }).trim() : p);
const BASH_BIN = toBash(BIN);
const stub = (name, body) => fs.writeFileSync(path.join(BIN, name), "#!/bin/bash\n" + body + "\n", { mode: 0o755 });
stub("ss", `cat "${BASH_BIN}/ss.txt" 2>/dev/null`);
stub("sudo", `[ "$1" = "-n" ] && shift; exec "$@"`);
stub("docker", `[ "$1" = "ps" ] && cat "${BASH_BIN}/docker.txt" 2>/dev/null; true`);
stub("ps", `cat "${BASH_BIN}/unit.txt" 2>/dev/null`);
const server = ({ ss = "", docker = "", unit = "", compose = COMPOSE, mlnode = MLNODE, env = "export PORT=8080\nexport INFERENCE_PORT=5050\nexport API_PORT=8000\n" } = {}) => {
  fs.writeFileSync(path.join(BIN, "ss.txt"), ss);
  fs.writeFileSync(path.join(BIN, "docker.txt"), docker);
  fs.writeFileSync(path.join(BIN, "unit.txt"), unit);
  fs.writeFileSync(path.join(JOIN, "docker-compose.yml"), compose);
  fs.writeFileSync(path.join(JOIN, "docker-compose.mlnode.yml"), mlnode);
  fs.writeFileSync(path.join(JOIN, "config.env"), env);
};
const read = (f) => fs.readFileSync(path.join(JOIN, f), "utf8");
const driver = {
  kind: "ssh",
  async exec(cmd) {
    const env = { ...process.env, PATH: BASH_BIN + ":" + process.env.PATH };
    try { return { code: 0, stdout: execFileSync("bash", ["-c", `export PATH="${BASH_BIN}:$PATH"; ` + cmd], { cwd: HOME, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
    catch (e) { return { code: e.status || 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  },
  async writeFile(p, content) { fs.writeFileSync(fromBash(p), content); }
};

(async () => {
  console.log("Reading what listens on the server");
  let L = Ports.parseListeners(SS(SSHD, SSHD6, EXPORTER, 'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=600,fd=14))'));
  ok(L.length === 4, "four listeners out of four lines");
  ok(L[2].port === 9100 && L[2].addr === "*" && L[2].program === "node_exporter" && L[2].pid === 777, "node_exporter on *:9100, with its process");
  ok(L[1].addr === "::" && L[1].port === 22, "an IPv6 address loses its brackets");
  ok(L[3].addr === "127.0.0.53" && L[3].port === 53, "an address with an interface name");
  const N = Ports.parseListeners("Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n" +
    "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      901/sshd\ntcp6       0      0 :::9100                 :::*                    LISTEN      777/node_exporter\n");
  ok(N.length === 2 && N[1].port === 9100 && N[1].addr === "::" && N[1].program === "node_exporter" && N[1].pid === 777, "netstat's listing is read too");
  const bare = Ports.parseListeners("LISTEN 0 4096 0.0.0.0:8000 0.0.0.0:*\n");
  ok(bare.length === 1 && bare[0].program === null && bare[0].pid === null, "a line with no process (no root) still counts as a listener");

  console.log("Who is in the way");
  ok(Ports.blocks("*", "127.0.0.1") && Ports.blocks("0.0.0.0", "127.0.0.1") && Ports.blocks("127.0.0.1", "127.0.0.1"), "a listener on every address or on 127.0.0.1 blocks 127.0.0.1");
  ok(!Ports.blocks("::", "127.0.0.1") && !Ports.blocks("10.0.0.5", "127.0.0.1"), "an IPv6-only listener or another address does not");
  ok(Ports.blocks("::", "0.0.0.0") && Ports.blocks("127.0.0.1", "0.0.0.0"), "anything on the port blocks a port published everywhere");
  ok(Ports.holder(L, 9100, "127.0.0.1").program === "node_exporter" && Ports.holder(L, 9100, "127.0.0.1").docker === false, "9100 is held by node_exporter");
  ok(Ports.holder(L, 9200, "127.0.0.1") === null, "9200 is clear");
  const ours = Ports.parseListeners('LISTEN 0 4096 127.0.0.1:9100 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=4))\n');
  ok(Ports.holder(ours, 9100, "127.0.0.1").docker === true, "Docker publishing a port is told apart from another program");
  ok(Ports.holder(bare, 8000, "0.0.0.0", Ports.dockerPublished("0.0.0.0:8000->80/tcp, [::]:8000->80/tcp")).docker === true, "with no process shown, a port a running container publishes is Docker's");
  ok(Ports.holder(bare, 8000, "0.0.0.0", new Set()).docker === false, "with no process shown and no container on it, it is another program");
  const rootless = Ports.parseListeners('LISTEN 0 4096 127.0.0.1:9100 0.0.0.0:* users:(("rootlesskit",pid=77,fd=9))');
  ok(Ports.holder(rootless, 9100, "127.0.0.1", Ports.dockerPublished("127.0.0.1:9100->9100/tcp")).docker === true, "a port a running container publishes is Docker's, whatever its listener is called (Docker without root)");
  ok([...Ports.dockerPublished("1317/tcp, 0.0.0.0:5000->26656/tcp, [::]:5000->26656/tcp\n127.0.0.1:8080->8080/tcp, 127.0.0.1:5050->5000/tcp\n")].sort().join() === "5000,5050,8080", "the ports running containers publish");

  console.log("The compose files");
  ok(Ports.publishedOn(COMPOSE, 9100) === 9100, "9100 is published on 9100 as Gonka ships it");
  ok(Ports.publishedOn(COMPOSE.replace('"9100:9100"', '"127.0.0.1:9100:9100"'), 9100) === 9100, "and after GNOT bound it to 127.0.0.1");
  ok(Ports.publishedOn(MLNODE, 8080, { PORT: "8081" }) === 8081 && Ports.publishedOn(MLNODE, 8080) === 8080, "the ML node's port follows config.env's PORT");
  ok(Ports.publishedOn(MLNODE, 5000) === 5050, "the inference port is 5050 on the server, 5000 inside");
  ok(Ports.publishedOn(COMPOSE, 26656) === 5000 && Ports.publishedOn(COMPOSE, 1234) === null, "other lines are read the same, and a missing one is null");
  const movedText = Ports.movePublished(COMPOSE, 9100, 19100);
  ok(movedText.includes('      - "127.0.0.1:19100:9100"') && !movedText.includes('"9100:9100"'), "moving 9100 rewrites that one line");
  ok(movedText.includes('"127.0.0.1:9200:9200"') && movedText.includes('"5000:26656" #p2p') && movedText.includes("DAPI_API__ML_SERVER_PORT=9100"), "and nothing else");
  ok(Ports.publishedOn(movedText, 9100) === 19100, "the moved port reads back");
  const mm = Ports.movePublished(MLNODE, 5000, 15050);
  ok(mm.includes('"127.0.0.1:15050:5000"') && mm.includes('"${PORT:-8080}:8080"'), "the inference line moves without touching the line above it");

  console.log("Docker's own words");
  ok(Ports.refusedPort("Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint api (a4f9ecabadb1): failed to bind host port 127.0.0.1:9100/tcp: address already in use") === 9100, "the error from the 2 × H200 server names 9100");
  ok(Ports.refusedPort("Error response from daemon: driver failed programming external connectivity on endpoint proxy: Bind for 0.0.0.0:8000 failed: port is already allocated") === 8000, "a port another container holds");
  ok(Ports.refusedPort("Error starting userland proxy: listen tcp4 0.0.0.0:5000: bind: address already in use") === 5000, "older Docker's wording");
  ok(Ports.refusedPort("failed to bind host port [::]:8443/tcp: address already in use") === 8443, "an IPv6 address");
  ok(Ports.refusedPort("Error response from daemon: could not select device driver nvidia") === null, "any other failure is left alone");

  console.log("At launch: stepping around a taken port");
  server({ ss: SS(SSHD, EXPORTER) });
  let log = "";
  let r = await deploy.stepAroundTakenPorts(driver, (s) => { log += s; });
  ok(r.moved.length === 1 && r.moved[0].from === 9100 && r.moved[0].to === 19100, "node_exporter on *:9100: Gonka's 9100 goes to 19100");
  ok(read("docker-compose.yml").includes('- "127.0.0.1:19100:9100"'), "the compose file on the server says so");
  ok(read("docker-compose.mlnode.yml") === MLNODE, "the ML node's file is untouched");
  ok(/Port 9100 on this server is already used by node_exporter/.test(log) && /19100/.test(log), "and the activity log says it in a sentence");
  const h = await deploy.hardenPorts(driver);
  ok(h.ok && read("docker-compose.yml").includes('- "127.0.0.1:19100:9100"'), "binding the internal ports to 127.0.0.1 still passes afterwards");

  server({ ss: SS(SSHD, EXPORTER, 'LISTEN 0 4096 127.0.0.1:19100 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=4))'), docker: "127.0.0.1:19100->9100/tcp, 127.0.0.1:9200->9200/tcp\n", compose: movedText });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0 && read("docker-compose.yml") === movedText, "a second launch, with the node now running on 19100, changes nothing");

  server({ ss: SS(SSHD, 'LISTEN 0 4096 127.0.0.1:19100 0.0.0.0:*'), docker: "127.0.0.1:19100->9100/tcp\n", compose: movedText });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0, "the same without root to see process names");

  server({ ss: SS(SSHD, 'LISTEN 0 4096 127.0.0.1:9100 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=4))'), docker: "127.0.0.1:9100->9100/tcp\n", compose: COMPOSE.replace('"9100:9100"', '"127.0.0.1:9100:9100"') });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0, "a node already running here on 9100 is left alone");

  server({ ss: SS(SSHD, SSHD6) });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0 && read("docker-compose.yml") === COMPOSE && read("docker-compose.mlnode.yml") === MLNODE, "nothing in the way: both files stay as they are, byte for byte");

  server({ ss: SS(SSHD, 'LISTEN 0 4096 [::]:9100 [::]:* users:(("node_exporter",pid=777,fd=3))') });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0, "an IPv6-only listener on 9100 does not block 127.0.0.1, so nothing moves");

  server({ ss: SS(EXPORTER_LOCAL, 'LISTEN 0 4096 0.0.0.0:19100 0.0.0.0:* users:(("other",pid=5,fd=3))', 'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("jupyter-lab",pid=888,fd=7))', 'LISTEN 0 128 0.0.0.0:5050 0.0.0.0:* users:(("python3",pid=889,fd=7))') });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 3, "9100, 8080 and 5050 all taken: all three move");
  ok(read("docker-compose.yml").includes('- "127.0.0.1:19101:9100"'), "19100 is taken too, so 9100 goes to 19101");
  ok(read("docker-compose.mlnode.yml").includes('- "127.0.0.1:18080:8080"') && read("docker-compose.mlnode.yml").includes('- "127.0.0.1:15050:5000"'), "the ML node's two ports go to 18080 and 15050");

  server({ ss: "" });
  r = await deploy.stepAroundTakenPorts(driver, null);
  ok(r.moved.length === 0 && read("docker-compose.yml") === COMPOSE, "a server that lists nothing (no ss, no netstat) is left as it is");

  console.log("Ports that have to be free");
  const seen = (ss, docker = "") => ({ L: Ports.parseListeners(ss), P: Ports.dockerPublished(docker) });
  let s = seen(SS(SSHD, EXPORTER, 'LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:(("python3",pid=555,fd=7))'));
  let c = Ports.clashes(s.L, {}, s.P);
  ok(c.blocked.length === 1 && c.blocked[0].port === 8000 && c.blocked[0].program === "python3", "the API port held by python3 is a port that has to be freed");
  ok(c.stepped.length === 1 && c.stepped[0].port === 9100, "while 9100 is only stepped around");
  s = seen(SS('LISTEN 0 4096 0.0.0.0:8000 0.0.0.0:* users:(("docker-proxy",pid=1,fd=4))', 'LISTEN 0 4096 0.0.0.0:5000 0.0.0.0:* users:(("docker-proxy",pid=2,fd=4))'), "0.0.0.0:8000->80/tcp\n0.0.0.0:5000->26656/tcp\n");
  c = Ports.clashes(s.L, {}, s.P);
  ok(c.blocked.length === 0 && c.stepped.length === 0, "a node already running on this server is not a clash in the health check");
  ok(Ports.clashes(s.L, {}, s.P, { docker: true }).blocked.length === 2, "but is one when a launch has just been refused");
  s = seen(SS('LISTEN 0 128 0.0.0.0:8001 0.0.0.0:* users:(("python3",pid=555,fd=7))'));
  ok(Ports.clashes(s.L, { API_PORT: "8001" }, s.P).blocked[0].port === 8001, "the API port follows config.env");

  console.log("The command that stops it");
  server({ unit: "node_exporter.service\n" });
  ok(await Ports.stopCommand(driver, { program: "node_exporter", pid: 777 }) === "sudo systemctl disable --now node_exporter.service", "a service is switched off as a service");
  server({ unit: "session-3.scope\n" });
  ok(await Ports.stopCommand(driver, { program: "python3", pid: 555 }) === "sudo kill 555", "a program started by hand is stopped by its process");
  server({ unit: "ssh.service\n" });
  ok(await Ports.stopCommand(driver, { program: "sshd", pid: 901 }) === null, "never sshd");
  ok(await Ports.stopCommand(driver, { program: "weird", pid: 901 }) === null, "nor anything that belongs to the ssh service");
  ok(await Ports.stopCommand(driver, { program: "docker-proxy", pid: 4242, docker: true }) === null && await Ports.stopCommand(driver, { program: null, pid: null }) === null, "nor Docker, nor a program it cannot see");

  console.log("The Fix in the health check");
  let plan = fixes.planFix("ports-free", { takenPorts: [{ port: 8000, program: "python3", pid: 555, stop: "sudo kill 555" }, { port: 9200, program: "node_exporter", pid: 777, stop: "sudo systemctl disable --now node_exporter.service" }] });
  ok(plan && /\$SUDO kill 555; \$SUDO systemctl disable --now node_exporter\.service/.test(plan.cmd), "runs each stop command, with root");
  ok(/python3 on port 8000/.test(plan.description) && /node_exporter on port 9200/.test(plan.description), "and says what it will stop before it does");
  plan = fixes.planFix("ports-free", { takenPorts: [{ port: 8000, program: "sshd", pid: 901, stop: null }] });
  ok(plan && plan.cmd === null, "no command when a holder must not be stopped");
  plan = fixes.planFix("ports-free", { takenPorts: [{ port: 8000, program: "x", pid: 1, stop: "sudo rm -rf /; echo" }] });
  ok(plan && plan.cmd === null, "and nothing but the two known commands is ever run");

  console.log("A refused launch, in plain words");
  server({ ss: SS(SSHD, 'LISTEN 0 4096 127.0.0.1:9200 0.0.0.0:* users:(("node_exporter",pid=777,fd=3))'), unit: "node_exporter.service\n" });
  let msg = await deploy.portClashMessage(driver, "Error response from daemon: failed to bind host port 127.0.0.1:9200/tcp: address already in use");
  ok(/Port 9200 on your server is already used by node_exporter/.test(msg), "names the port and the program");
  ok(/sudo systemctl disable --now node_exporter\.service/.test(msg) && /Run launch sequence/.test(msg), "gives the command and says what to press after");
  server({ ss: SS('LISTEN 0 4096 0.0.0.0:8000 0.0.0.0:* users:(("docker-proxy",pid=1,fd=4))'), docker: "0.0.0.0:8000->8000/tcp\n" });
  stub("docker", `[ "$1" = "ps" ] && { case "$*" in *Names*) echo "portainer 0.0.0.0:8000->8000/tcp";; *) cat "${BASH_BIN}/docker.txt";; esac; }; true`);
  msg = await deploy.portClashMessage(driver, "Bind for 0.0.0.0:8000 failed: port is already allocated");
  ok(/another Docker container \(portainer\)/.test(msg) && /docker stop portainer/.test(msg), "another container is named, with docker stop");
  server({ ss: SS('LISTEN 0 4096 0.0.0.0:5000 0.0.0.0:*') });
  stub("docker", `true`);
  msg = await deploy.portClashMessage(driver, "listen tcp4 0.0.0.0:5000: bind: address already in use");
  ok(/Port 5000 on your server is already used by another program/.test(msg) && /sudo ss -ltnp \| grep -w 5000/.test(msg), "with no process to name, it gives the command that shows it");
  ok(await deploy.portClashMessage(driver, "could not select device driver nvidia") === null, "any other failure keeps Docker's own words");

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* a temp folder */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL the check itself broke: " + (e && e.stack || e)); process.exit(1); });
