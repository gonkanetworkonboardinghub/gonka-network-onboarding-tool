/**
 * Executor layer. One interface, two drivers:
 *   - LocalDriver  → the server is THIS machine (Linux, or Windows via WSL)
 *   - SshDriver    → the server is remote (rented from Spheron etc.)
 *
 * Both expose:
 *   exec(cmd, { onData, timeoutMs, env }) → { code, stdout, stderr }
 *   writeFile(remotePath, content)
 *   readFile(remotePath) → string
 *   dispose()
 *
 * All commands run through `bash -lc`, so the same command strings work
 * against both drivers. Sensitive values (passphrases) must be passed with
 * shq() escaping and are never logged.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Shell-escape a value for safe single-quoted interpolation. */
function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

class LocalDriver {
  constructor() {
    this.kind = "local";
    // On Windows, run everything inside WSL so bash/docker work.
    this.useWsl = process.platform === "win32";
  }

  exec(cmd, opts = {}) {
    return new Promise((resolve) => {
      // WSL note: `--exec` (-e) is required. Without it, wsl.exe routes the
      // command through interop that expands $VARIABLES before bash ever
      // parses them — a Windows PATH containing "Program Files (x86)" then
      // injects bare parentheses into the script (syntax error), and awk's
      // $2 silently vanishes (this corrupted the RAM reading). --exec passes
      // argv to bash verbatim.
      // Always run from $HOME, like an SSH session would. Otherwise relative
      // paths (the cloned gonka repo!) land in the app's install directory —
      // which every app update wipes, forcing a full re-download — and on
      // Windows that's also the slow /mnt/c filesystem instead of WSL-native.
      const homed = `cd "$HOME" 2>/dev/null; ${cmd}`;
      const args = this.useWsl ? ["-e", "bash", "-lc", homed] : ["-lc", homed];
      const bin = this.useWsl ? "wsl" : "bash";
      const child = spawn(bin, args, { env: { ...process.env, ...(opts.env || {}) } });
      let stdout = "", stderr = "", done = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => { if (!done) { child.kill("SIGKILL"); } }, opts.timeoutMs)
        : null;
      child.stdout.on("data", (d) => { const t = d.toString(); stdout += t; opts.onData && opts.onData(t, "stdout"); });
      child.stderr.on("data", (d) => { const t = d.toString(); stderr += t; opts.onData && opts.onData(t, "stderr"); });
      if (opts.stdin) { child.stdin.write(opts.stdin); }
      child.stdin.end();
      child.on("close", (code) => { done = true; if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      child.on("error", (err) => { done = true; if (timer) clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(err) }); });
    });
  }

  async writeFile(p, content) {
    if (this.useWsl) {
      // Write via a heredoc-free base64 round trip to avoid quoting issues.
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const r = await this.exec(`mkdir -p $(dirname ${shq(p)}) && echo ${shq(b64)} | base64 -d > ${shq(p)}`);
      if (r.code !== 0) throw new Error(r.stderr || "write failed");
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }

  async readFile(p) {
    if (this.useWsl) {
      const r = await this.exec(`cat ${shq(p)}`);
      if (r.code !== 0) throw new Error(r.stderr || "read failed");
      return r.stdout;
    }
    return fs.readFileSync(p, "utf8");
  }

  dispose() {}
}

/**
 * The private key in a key file, ready for ssh2, or an error that says what to
 * do. Takes "~/.ssh/key" as people write it, and the public half (".pub"),
 * often picked by mistake, when its private half sits beside it.
 */
function usableKey(file, passphrase) {
  let p = String(file).trim().replace(/^["']|["']$/g, "");
  if (/^~(?=$|[\\/])/.test(p)) p = path.join(os.homedir(), p.slice(1));
  if (/\.pub$/i.test(p) && fs.existsSync(p.slice(0, -4))) p = p.slice(0, -4);
  let data;
  try { data = fs.readFileSync(p); }
  catch (e) { throw new Error("Could not read the SSH key file: " + e.message); }
  const { utils } = require("ssh2");
  const key = utils.parseKey(data, passphrase || undefined);
  if (key instanceof Error) {
    if (/passphrase|encrypted/i.test(key.message)) throw new Error("This SSH key is protected by a passphrase. Enter it under Key passphrase.");
    throw new Error("This file isn't an SSH private key (" + key.message + "). Choose the key file without .pub, or paste the key itself.");
  }
  const k = Array.isArray(key) ? key[0] : key;
  if (k && typeof k.isPrivateKey === "function" && !k.isPrivateKey()) throw new Error("This is the public half of the key (the .pub file). Choose the private one, the file without .pub.");
  return data;
}

class SshDriver {
  constructor() {
    this.kind = "ssh";
    this.conn = null;
    this.cfg = null;          // how to connect, kept in memory only, to connect again
    this.reopening = null;
    this.disposed = false;
  }

  /**
   * cfg: { host, port, username, password?, privateKeyPath?, passphrase? }
   */
  connect(cfg) {
    this.cfg = cfg;
    this.disposed = false;
    return this.open();
  }

  /**
   * Open the connection. One that drops later (providers close idle ones, and
   * networks blip: on 29 October 2026 a Spheron server's connection was gone
   * after the setup sat waiting, and every command after it said "Not
   * connected") is marked gone, and the next command opens a new one.
   */
  open() {
    const cfg = this.cfg;
    const { Client } = require("ssh2");
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const connCfg = {
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000
      };
      // A key and a password can both be given: each is tried in turn. A key
      // that can't be used only stops the connection when there is no password.
      if (cfg.privateKeyPath) {
        try {
          connCfg.privateKey = usableKey(cfg.privateKeyPath, cfg.passphrase);
          if (cfg.passphrase) connCfg.passphrase = cfg.passphrase;
        } catch (e) {
          if (!cfg.password) return reject(e);
        }
      }
      if (cfg.password) {
        connCfg.password = cfg.password;
        connCfg.tryKeyboard = true;
        conn.on("keyboard-interactive", (n, i, il, prompts, finish) => finish(prompts.map(() => cfg.password)));
      }
      if (!connCfg.privateKey && !connCfg.password) return reject(new Error("Enter a password, or an SSH key file."));
      const gone = () => { if (this.conn === conn) this.conn = null; };
      conn
        .on("ready", () => { settled = true; this.conn = conn; resolve(); })
        .on("error", (err) => { if (!settled) { settled = true; reject(err); } else gone(); })
        .on("close", gone)
        .on("end", gone)
        .connect(connCfg);
    });
  }

  /** The live connection, opened again when it has dropped. */
  async live(onData) {
    if (this.conn) return this.conn;
    if (this.disposed || !this.cfg) throw new Error("Not connected to a server yet.");
    if (!this.reopening) this.reopening = this.open().finally(() => { this.reopening = null; });
    try { await this.reopening; }
    catch (e) { throw new Error("The connection to your server dropped, and GNOT couldn't connect again: " + (e.message || e)); }
    onData && onData("(The connection to your server had dropped; GNOT connected again.)\n", "stdout");
    return this.conn;
  }

  /** Run fn on the live connection; if the connection turns out to be gone before anything started, connect again and run it once more. */
  async withConn(fn, onData) {
    const conn = await this.live(onData);
    try { return await fn(conn); }
    catch (e) {
      if (!/Not connected|No response from server|socket|ECONNRESET|EPIPE/i.test(String(e && e.message))) throw e;
      if (this.conn === conn) this.conn = null;
      return fn(await this.live(onData));
    }
  }

  async exec(cmd, opts = {}) {
    const full = `bash -lc ${shq(cmd)}`;
    try {
      return await this.withConn((conn) => new Promise((resolve, reject) => {
        // ssh2 throws "Not connected" right away when the socket has closed: nothing ran, so it can run again.
        conn.exec(full, { pty: false, env: opts.env }, (err, stream) => {
          if (err) return /Not connected|No response from server/i.test(String(err.message || err)) ? reject(err) : resolve({ code: 255, stdout: "", stderr: String(err) });
          let stdout = "", stderr = "";
          const timer = opts.timeoutMs ? setTimeout(() => { try { stream.close(); } catch (_) {} }, opts.timeoutMs) : null;
          stream.on("data", (d) => { const t = d.toString(); stdout += t; opts.onData && opts.onData(t, "stdout"); });
          stream.stderr.on("data", (d) => { const t = d.toString(); stderr += t; opts.onData && opts.onData(t, "stderr"); });
          if (opts.stdin) stream.write(opts.stdin);
          stream.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
        });
      }), opts.onData);
    } catch (e) {
      return { code: 255, stdout: "", stderr: String((e && e.message) || e) };
    }
  }

  writeFile(remotePath, content) {
    return this.withConn((conn) => new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const dir = remotePath.split("/").slice(0, -1).join("/") || "/";
        // mkdir -p over exec (sftp has no recursive mkdir)
        this.exec(`mkdir -p ${shq(dir)}`).then(() => {
          const ws = sftp.createWriteStream(remotePath);
          ws.on("close", () => resolve());
          ws.on("error", reject);
          ws.end(Buffer.from(content, "utf8"));
        });
      });
    }));
  }

  readFile(remotePath) {
    return this.withConn((conn) => new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.readFile(remotePath, (e, buf) => (e ? reject(e) : resolve(buf.toString("utf8"))));
      });
    }));
  }

  dispose() {
    this.disposed = true;
    try { this.conn && this.conn.end(); } catch (_) {}
    this.conn = null;
  }
}

/**
 * localExec — always runs on THIS machine (used for cold-key operations,
 * which must never touch the server, even in SSH mode).
 */
const localMachine = new LocalDriver();

module.exports = { LocalDriver, SshDriver, localMachine, shq, _internal: { usableKey } };
