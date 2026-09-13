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

class SshDriver {
  constructor() {
    this.kind = "ssh";
    this.conn = null;
  }

  /**
   * cfg: { host, port, username, password?, privateKeyPath?, passphrase? }
   */
  connect(cfg) {
    const { Client } = require("ssh2");
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const connCfg = {
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000
      };
      if (cfg.privateKeyPath) {
        try {
          connCfg.privateKey = fs.readFileSync(cfg.privateKeyPath);
          if (cfg.passphrase) connCfg.passphrase = cfg.passphrase;
        } catch (e) {
          return reject(new Error("Could not read the SSH key file: " + e.message));
        }
      } else if (cfg.password) {
        connCfg.password = cfg.password;
        connCfg.tryKeyboard = true;
        conn.on("keyboard-interactive", (n, i, il, prompts, finish) => finish(prompts.map(() => cfg.password)));
      } else {
        return reject(new Error("Provide a password or an SSH key file."));
      }
      conn
        .on("ready", () => { this.conn = conn; resolve(); })
        .on("error", (err) => reject(err))
        .connect(connCfg);
    });
  }

  exec(cmd, opts = {}) {
    return new Promise((resolve) => {
      if (!this.conn) return resolve({ code: 255, stdout: "", stderr: "Not connected" });
      const full = `bash -lc ${shq(cmd)}`;
      this.conn.exec(full, { pty: false, env: opts.env }, (err, stream) => {
        if (err) return resolve({ code: 255, stdout: "", stderr: String(err) });
        let stdout = "", stderr = "";
        const timer = opts.timeoutMs ? setTimeout(() => { try { stream.close(); } catch (_) {} }, opts.timeoutMs) : null;
        stream.on("data", (d) => { const t = d.toString(); stdout += t; opts.onData && opts.onData(t, "stdout"); });
        stream.stderr.on("data", (d) => { const t = d.toString(); stderr += t; opts.onData && opts.onData(t, "stderr"); });
        if (opts.stdin) stream.write(opts.stdin);
        stream.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      });
    });
  }

  writeFile(remotePath, content) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error("Not connected"));
      this.conn.sftp((err, sftp) => {
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
    });
  }

  readFile(remotePath) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error("Not connected"));
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.readFile(remotePath, (e, buf) => (e ? reject(e) : resolve(buf.toString("utf8"))));
      });
    });
  }

  dispose() {
    try { this.conn && this.conn.end(); } catch (_) {}
    this.conn = null;
  }
}

/**
 * localExec — always runs on THIS machine (used for cold-key operations,
 * which must never touch the server, even in SSH mode).
 */
const localMachine = new LocalDriver();

module.exports = { LocalDriver, SshDriver, localMachine, shq };
