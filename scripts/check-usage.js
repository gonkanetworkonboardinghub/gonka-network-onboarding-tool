/**
 * check-usage.js — run with `node scripts/check-usage.js`.
 *
 * Checks src/services/usage.js without Electron and without the real endpoint:
 * a stub "electron" pointing at a throwaway folder, a stub knowledge pointing
 * at a local server, and then the situations that matter for the count of
 * computers on the website being exact.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// These checks may themselves run on a build machine; the cases below set and
// clear these on purpose.
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
const ROOT = path.join(__dirname, "..");
let PORT = 0;
let endpoint = () => `http://127.0.0.1:${PORT}/functions/gnot-usage`;

// isPackaged is true for an installed copy and false for one run from source.
const electronApp = { getPath: () => DIR, getVersion: () => "0.0.0-test", isPackaged: true };
const real = Module._load;
Module._load = function (request, parent) {
  if (request === "electron") return { app: electronApp };
  if (parent && parent.filename.endsWith("usage.js") && request === "../knowledge") {
    return { get: () => ({ usageEndpoint: endpoint() }) };
  }
  return real.apply(this, arguments);
};

const usage = require(path.join(ROOT, "src", "services", "usage.js"));
const file = path.join(DIR, "use-gonka", "usage.json");
const readFile = () => JSON.parse(fs.readFileSync(file, "utf8"));
const setFile = (patch) => fs.writeFileSync(file, JSON.stringify({ ...readFile(), ...patch }));
const posts = [];
const ago = (ms) => Date.now() - ms;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    posts.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});

server.listen(0, "127.0.0.1", async () => {
  PORT = server.address().port;

  // 1. Opening the app says so, once.
  let r = await usage.opened();
  check("opening the app sends an 'open' note", [r.sent, posts.length], [true, 1]);
  check("  …carrying only number, version and system", Object.keys(posts[0]).sort(), ["at", "install", "kind", "os", "version"]);
  const install = posts[0].install;
  check("  …and the number is kept, not remade", readFile().install, install);
  r = await usage.opened();
  check("opening again within the hour sends nothing", [r.sent, posts.length], [false, 1]);
  setFile({ lastOpen: ago(61 * 60 * 1000) });
  r = await usage.opened();
  check("an hour later it says so again", [r.sent, posts.length], [true, 2]);
  check("  …under the same number", posts[1].install, install);

  // 2. A computer that ran an older version keeps its number. Its file still
  //    holds what Use Gonka counted; that is left alone, and never sent.
  fs.writeFileSync(file, JSON.stringify({ install: "0123456789abcdef", pending: { answers: 3, tokens: 900, models: {}, services: {} },
    lastSent: ago(60 * 1000), totals: { answers: 9, tokens: 2700 }, lastOpen: 0 }));
  posts.length = 0;
  await usage.opened();
  check("an older version's file keeps its number", posts[0] && posts[0].install, "0123456789abcdef");
  check("  …and only the 'open' note goes", posts.map((p) => p.kind), ["open"]);
  check("  …which is all usage.js can send now", Object.keys(usage), ["opened"]);

  // 3. A failed note never throws on its way out of the app's start.
  endpoint = () => "http://127.0.0.1:1/nowhere";
  setFile({ lastOpen: 0 });
  let threw = false;
  try { await usage.opened({ timeout: 2000 }); } catch (_) { threw = true; }
  check("a failed note rejects, and the app ignores it (main.js .catch)", threw, true);
  check("  …and is tried again next time, not marked as told", readFile().lastOpen, 0);
  endpoint = () => `http://127.0.0.1:${PORT}/functions/gnot-usage`;

  // 4. No address, nothing at all.
  const realEndpoint = endpoint;
  endpoint = () => "";
  check("no address: no 'open' note", (await usage.opened()).why, "no address set");
  endpoint = realEndpoint;

  // 5. Our own copies mark themselves.
  posts.length = 0;
  fs.writeFileSync(path.join(DIR, "team-copy.txt"), "ours");
  setFile({ lastOpen: 0 });
  await usage.opened();
  check("a team copy marks its 'open' note", posts[0].team, true);
  fs.rmSync(path.join(DIR, "team-copy.txt"));

  // 6. Our build machines and copies run from source never report. The first
  //    build after "opened" notes existed counted its own two machines as
  //    people; this is what stops that.
  setFile({ lastOpen: 0 });
  posts.length = 0;
  process.env.GITHUB_ACTIONS = "true";
  check("on a build machine: no 'open' note", (await usage.opened()).why, "no address set");
  delete process.env.GITHUB_ACTIONS;
  process.env.CI = "true";
  check("with CI set: no 'open' note", (await usage.opened()).why, "no address set");
  delete process.env.CI;
  electronApp.isPackaged = false;
  check("run from source: no 'open' note", (await usage.opened()).why, "no address set");
  electronApp.isPackaged = true;
  // A Mac build machine opens the app without the shell's settings, so it
  // says what it is with a file instead.
  fs.writeFileSync(path.join(DIR, "build-machine.txt"), "ours");
  check("build machine marked by a file: no 'open' note", (await usage.opened()).why, "no address set");
  fs.rmSync(path.join(DIR, "build-machine.txt"));
  check("  …and nothing went out in any of those", posts.length, 0);
  check("an installed copy, run by a person, still reports", (await usage.opened()).sent, true);

  // 7. Nothing personal ever goes.
  check("an 'open' note carries nothing it should not", Object.keys(posts[0]).sort(),
    ["at", "install", "kind", "os", "version"]);

  // Ends by itself rather than with process.exit: on Windows, exiting while
  // the refused connection in 3 is still closing trips a libuv assertion.
  server.close();
  server.closeAllConnections();
  console.log(failures ? `\n${failures} FAILED` : "\nall good");
  process.exitCode = failures ? 1 : 0;
});
