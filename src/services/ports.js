/**
 * ports.js — who already listens on the ports Gonka's containers publish on
 * the server.
 *
 * Seen on a rented 2 × H200 server, 2026-11-12: a program on the machine
 * already held port 9100, so Docker refused to start Gonka's `api` container
 * a minute into the launch ("failed to bind host port 127.0.0.1:9100/tcp:
 * address already in use"). 9100 is also the default port of Prometheus
 * node_exporter, which providers install to draw their usage graphs.
 *
 * Three of the ports Gonka publishes are only conveniences on a server that
 * runs the network node and the ML node together, the one layout GNOT sets
 * up: the containers reach each other by name inside Docker's own network
 * (api:9100, inference:8080, inference:5000) and nothing on the server
 * itself uses them. GNOT publishes those on another port when theirs is
 * taken (deploy.stepAroundTakenPorts). The others have to be the port they
 * are: peers and users reach 5000 and the API port from outside, and GNOT
 * itself talks to the admin API on 9200. For those GNOT names the program.
 */

// Process names need root for sockets other users own; without it the lines
// still come back, only without their "users:" part.
const LISTEN_CMD = "(sudo -n ss -lntpH 2>/dev/null || ss -lntpH 2>/dev/null || netstat -lntp 2>/dev/null) | head -400";

/**
 * `ss -lntpH` (or `netstat -lntp`) → [{ addr, port, program, pid }].
 * program and pid are null when the listing carries no process.
 */
function parseListeners(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const local = line.trim().split(/\s+/).find((c) => /:\d+$/.test(c));
    const m = local && local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const addr = m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, "") || "*";
    let program = null, pid = null;
    const ss = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const ns = !ss && line.match(/\s(\d+)\/(\S+)\s*$/);
    if (ss) { program = ss[1]; pid = Number(ss[2]); }
    else if (ns) { pid = Number(ns[1]); program = ns[2]; }
    out.push({ addr, port: Number(m[2]), program, pid });
  }
  return out;
}

/** Does a listener on `addr` stop Docker from publishing the same port on `bind`? */
function blocks(addr, bind) {
  // An IPv6-only listener ([::] in ss; a dual one shows as *) leaves 127.0.0.1 alone.
  if (bind === "127.0.0.1") return addr === "127.0.0.1" || addr === "0.0.0.0" || addr === "*";
  return true;   // published on every address: any listener on the port is in the way
}

/** `docker ps --format '{{.Ports}}'` → the set of server ports running containers publish. */
function dockerPublished(text) {
  const set = new Set();
  for (const m of String(text || "").matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= b && p - a < 200; p++) set.add(p);
  }
  return set;
}

/**
 * Who holds `port` so that Docker cannot publish it on `bind`: the listener,
 * with `docker: true` when it is Docker publishing a container's port (a
 * node already running here, or another container), or null when it is clear.
 */
function holder(listeners, port, bind, published) {
  const hits = listeners.filter((l) => l.port === port && blocks(l.addr, bind));
  if (!hits.length) return null;
  // A port a running container publishes is Docker's, whatever the process
  // that listens for it is called (docker-proxy, or rootlesskit when Docker
  // runs without root): never "another program".
  if (published && published.has(port)) return { ...hits[0], docker: true };
  const named = hits.find((l) => l.program && l.program !== "docker-proxy");
  if (named) return { ...named, docker: false };
  return { ...hits[0], docker: hits.some((l) => l.program === "docker-proxy") };
}

/** The first port from `from` up that nothing listens on and that is not in `skip`. */
function sparePort(listeners, from, skip = []) {
  const used = new Set(listeners.map((l) => l.port));
  for (let p = from; p < from + 50; p++) if (!used.has(p) && !skip.includes(p)) return p;
  return null;
}

const num = (v, d) => { const x = parseInt(v, 10); return x > 0 && x < 65536 ? x : d; };

/**
 * The ports Gonka's two compose files publish on the server (deploy/join,
 * v0.2.16). `env` is config.env's API_PORT, API_SSL_PORT, PORT and
 * INFERENCE_PORT when it exists. `movable` ports are published only for the
 * operator's convenience on a one-machine node: { file, container, spare }.
 */
function gonkaPorts(env = {}) {
  return [
    { port: 5000, bind: "0.0.0.0", use: "the port other nodes reach yours on" },
    { port: num(env.API_PORT, 8000), bind: "0.0.0.0", use: "the port the network and users reach your node on" },
    { port: num(env.API_SSL_PORT, 8443), bind: "0.0.0.0", use: "the HTTPS port of your node" },
    { port: 9200, bind: "127.0.0.1", use: "the node's admin port, which GNOT itself uses" },
    { port: 30303, bind: "0.0.0.0", use: "the port of Gonka's bridge" },
    { port: 9100, bind: "127.0.0.1", use: "the API's port for ML nodes",
      movable: { file: "docker-compose.yml", container: 9100, spare: 19100 } },
    { port: num(env.PORT, 8080), bind: "127.0.0.1", use: "the ML node's port",
      movable: { file: "docker-compose.mlnode.yml", container: 8080, spare: 18080 } },
    { port: num(env.INFERENCE_PORT, 5050), bind: "127.0.0.1", use: "the ML node's inference port",
      movable: { file: "docker-compose.mlnode.yml", container: 5000, spare: 15050 } }
  ];
}

/** `export PORT=8080` lines of a config.env → { PORT: "8080", … }. */
function portEnv(text) {
  const env = {};
  for (const m of String(text || "").matchAll(/^\s*(?:export\s+)?(API_PORT|API_SSL_PORT|PORT|INFERENCE_PORT)=["']?(\d+)/gm)) env[m[1]] = m[2];
  return env;
}

// A `ports:` entry that publishes `container`: - "9100:9100", - "127.0.0.1:9100:9100",
// - "${PORT:-8080}:8080", - "127.0.0.1:${INFERENCE_PORT:-5050}:5000".
const published = (container) =>
  new RegExp(`^(\\s*-\\s*")(?:(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):)?(\\$\\{[A-Z_]+:-\\d+\\}|\\d+):${container}("\\s*(?:#.*)?)$`, "m");

/** The server port a compose file publishes `container` on now, or null when it publishes none. */
function publishedOn(composeText, container, env = {}) {
  const m = String(composeText || "").match(published(container));
  if (!m) return null;
  const v = m[2].match(/^\$\{([A-Z_]+):-(\d+)\}$/);
  return v ? num(env[v[1]], Number(v[2])) : Number(m[2]);
}

/** The compose file with `container` published on 127.0.0.1:`to` instead. */
function movePublished(composeText, container, to) {
  return String(composeText || "").replace(published(container), `$1127.0.0.1:${to}:${container}$3`);
}

/**
 * What stands in Gonka's way among `listeners`:
 *   blocked — ports that must be free and are not: [{ port, use, program, pid, docker }]
 *   stepped — movable ports another program holds:  [{ port, use, program, pid }]
 * Docker's own listeners count only when `docker` asks for them (at a failed
 * launch): during a health check they are a node already running here.
 */
function clashes(listeners, env, publishedSet, { docker = false } = {}) {
  const blocked = [], stepped = [];
  for (const g of gonkaPorts(env)) {
    const h = holder(listeners, g.port, g.bind, publishedSet);
    if (!h || (h.docker && !docker)) continue;
    const hit = { port: g.port, use: g.use, program: h.program, pid: h.pid, docker: h.docker };
    (g.movable && !h.docker ? stepped : blocked).push(hit);
  }
  return { blocked, stepped };
}

/** "node_exporter" / "another program": how a holder is named in a sentence. */
const nameOf = (h) => (h && h.docker ? "another Docker container" : (h && h.program) || "another program");

/**
 * The port a Docker error says it could not get, or null:
 *   failed to bind host port 127.0.0.1:9100/tcp: address already in use
 *   Bind for 0.0.0.0:8000 failed: port is already allocated
 *   listen tcp4 0.0.0.0:8000: bind: address already in use
 */
function refusedPort(text) {
  const m = String(text || "").match(/(?:host port|Bind for|listen tcp[46]?)\s+\[?[0-9a-fA-F.:]*?\]?:(\d+)(?:\/tcp)?[^\n]*(?:address already in use|port is already allocated)/);
  return m ? Number(m[1]) : null;
}

/**
 * One look at the server: what listens now, which ports running containers
 * publish, and the port settings of config.env in `joinDir` if it is there.
 */
async function look(driver, joinDir) {
  const r = await driver.exec(
    `${LISTEN_CMD}; echo '#DOCKER'; docker ps --format '{{.Ports}}' 2>/dev/null; echo '#ENV'; ` +
    (joinDir ? `grep -E '^ *(export +)?(API_PORT|API_SSL_PORT|PORT|INFERENCE_PORT)=' ${joinDir}/config.env 2>/dev/null; ` : "") + `true`,
    { timeoutMs: 30000 });
  const [listen = "", rest = ""] = String(r.stdout || "").split("#DOCKER");
  const [ps = "", env = ""] = rest.split("#ENV");
  return { listeners: parseListeners(listen), published: dockerPublished(ps), env: portEnv(env) };
}

/**
 * The command that stops what holds a port, for the user to run: the systemd
 * service the process belongs to when it has one (so it stays off after a
 * reboot too), else the process itself. null when the process is unknown.
 */
async function stopCommand(driver, h) {
  if (!h || !h.pid || h.docker) return null;
  // Never the door GNOT itself comes in through, nor Docker or the system.
  const KEEP = /^(sshd?|systemd.*|init|dockerd|docker-proxy|containerd.*)$/;
  if (KEEP.test(h.program || "")) return null;
  const r = await driver.exec(`ps -o unit= -p ${Number(h.pid)} 2>/dev/null; true`);
  const unit = String(r.stdout || "").trim().split(/\s+/)[0] || "";
  if (/^(ssh|sshd|docker|containerd|systemd-|init\.scope)/.test(unit)) return null;
  const service = /^[A-Za-z0-9@_.:-]+\.service$/.test(unit) && !/^user@/.test(unit);
  return service ? `sudo systemctl disable --now ${unit}` : `sudo kill ${Number(h.pid)}`;
}

module.exports = {
  look, stopCommand,
  LISTEN_CMD, parseListeners, blocks, dockerPublished, holder, sparePort, gonkaPorts, portEnv,
  publishedOn, movePublished, clashes, nameOf, refusedPort
};
