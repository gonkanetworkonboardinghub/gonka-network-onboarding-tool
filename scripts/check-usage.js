/**
 * check-usage.js — run with `node scripts/check-usage.js`.
 *
 * Checks src/services/usage.js without Electron and without the real endpoint:
 * a stub "electron" pointing at a throwaway folder, a stub knowledge pointing
 * at a local server, and then the situations that matter for the numbers on
 * the website being exact.
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
let slow = 0;   // ms the server waits before answering

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
const usagePosts = () => posts.filter((p) => p.kind === "usage");
const openPosts = () => posts.filter((p) => p.kind === "open");
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
  req.on("end", () => setTimeout(() => {
    posts.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }, slow));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, "127.0.0.1", async () => {
  PORT = server.address().port;

  // 1. Opening the app says so, once.
  let r = await usage.opened();
  check("opening the app sends an 'open' note", [r.sent, openPosts().length], [true, 1]);
  check("  …carrying only number, version and system", Object.keys(openPosts()[0]).sort(), ["at", "install", "kind", "os", "version"]);
  const install = openPosts()[0].install;
  check("  …and the number is kept, not remade", readFile().install, install);
  r = await usage.opened();
  check("opening again within the hour sends nothing", [r.sent, openPosts().length], [false, 1]);
  setFile({ lastOpen: ago(61 * 60 * 1000) });
  r = await usage.opened();
  check("an hour later it says so again", [r.sent, openPosts().length], [true, 2]);
  check("  …under the same number", openPosts()[1].install, install);

  // 2. The first answer goes at once; the next ones wait fifteen minutes.
  usage.record({ service: "proxy", model: "m", tokens: 100 });
  await sleep(150);
  check("the first answer is sent at once", usagePosts().length, 1);
  check("  …marked as usage, under the same number", [usagePosts()[0].kind, usagePosts()[0].install], ["usage", install]);
  usage.record({ service: "proxy", model: "m", tokens: 200 });
  await sleep(150);
  check("the next answer waits", [usagePosts().length, readFile().pending.answers], [1, 1]);
  setFile({ lastSent: ago(16 * 60 * 1000) });
  r = await usage.send();
  check("fifteen minutes on, it goes", [r.sent, usagePosts().length, usagePosts()[1].answers], [true, 2, 1]);
  check("  …and nothing is left waiting", readFile().pending.answers, 0);

  // 3. An answer that arrives during a send is not lost.
  setFile({ lastSent: ago(16 * 60 * 1000) });
  usage.record({ service: "proxy", model: "m", tokens: 10 });   // goes now…
  await sleep(10);
  slow = 300;
  setFile({ lastSent: ago(16 * 60 * 1000) });
  const inFlight = usage.send();                                // (already sending: refused)
  usage.record({ service: "proxy", model: "m", tokens: 20 });   // …this one arrives meanwhile
  await inFlight; await sleep(450); slow = 0;
  const waiting = readFile().pending;
  check("an answer arriving mid-send waits for the next send", [waiting.answers, waiting.tokens], [1, 20]);

  // 4. Two sends at once never carry the same answers twice.
  posts.length = 0;
  setFile({ lastSent: ago(16 * 60 * 1000) });
  slow = 200;
  const both = await Promise.all([usage.send(), usage.send()]);
  slow = 0;
  check("two sends at once: only one goes", [both.filter((b) => b.sent).length, usagePosts().length], [1, 1]);
  check("  …and the answer is counted once", usagePosts()[0].answers, 1);

  // 5. Closing the app sends what is waiting.
  usage.record({ service: "proxy", model: "m", tokens: 5 });
  setFile({ lastSent: ago(60 * 1000) });
  r = await usage.flush();
  check("closing sends what is waiting", [r.sent, r.body && r.body.answers], [true, 1]);
  usage.record({ service: "proxy", model: "m", tokens: 5 });
  r = await usage.flush();
  check("closing twice in a row: the second waits", [r.sent, r.why], [false, "just sent"]);

  // 6. A failed send loses nothing.
  endpoint = () => "http://127.0.0.1:1/nowhere";
  setFile({ lastSent: ago(60 * 1000) });
  r = await usage.flush();
  check("a failed send never throws", r.sent, false);
  check("  …and the answer is still waiting", readFile().pending.answers, 1);
  endpoint = () => `http://127.0.0.1:${PORT}/functions/gnot-usage`;

  // 7. No address, nothing at all.
  const realEndpoint = endpoint;
  endpoint = () => "";
  check("no address: no usage", (await usage.send()).why, "no address set");
  check("no address: no 'open' note", (await usage.opened()).why, "no address set");
  endpoint = realEndpoint;

  // 8. Our own copies mark themselves.
  posts.length = 0;
  fs.writeFileSync(path.join(DIR, "team-copy.txt"), "ours");
  setFile({ lastOpen: 0, lastSent: ago(16 * 60 * 1000) });
  await usage.opened();
  await usage.send();
  check("a team copy marks its 'open' note", openPosts()[0].team, true);
  check("a team copy marks its usage", usagePosts()[0].team, true);
  check("the person can see it is marked", usage.mine().team, true);
  fs.rmSync(path.join(DIR, "team-copy.txt"));

  // 9. Our build machines and copies run from source never report. The first
  //    build after "opened" notes existed counted its own two machines as
  //    people; this is what stops that.
  setFile({ lastSent: Date.now() });                           // so the answer below waits
  usage.record({ service: "proxy", model: "m", tokens: 5 });   // something to send
  await sleep(100);
  setFile({ lastOpen: 0, lastSent: ago(16 * 60 * 1000) });     // both would go now
  posts.length = 0;
  process.env.GITHUB_ACTIONS = "true";
  check("on a build machine: no 'open' note", (await usage.opened()).why, "no address set");
  check("on a build machine: no usage", (await usage.send()).why, "no address set");
  check("on a build machine: nothing on closing", (await usage.flush()).why, "no address set");
  delete process.env.GITHUB_ACTIONS;
  process.env.CI = "true";
  check("with CI set: no 'open' note", (await usage.opened()).why, "no address set");
  delete process.env.CI;
  electronApp.isPackaged = false;
  check("run from source: no 'open' note", (await usage.opened()).why, "no address set");
  check("run from source: no usage", (await usage.send()).why, "no address set");
  electronApp.isPackaged = true;
  // A Mac build machine opens the app without the shell's settings, so it
  // says what it is with a file instead.
  fs.writeFileSync(path.join(DIR, "build-machine.txt"), "ours");
  check("build machine marked by a file: no 'open' note", (await usage.opened()).why, "no address set");
  check("build machine marked by a file: no usage", (await usage.send()).why, "no address set");
  fs.rmSync(path.join(DIR, "build-machine.txt"));
  check("  …and nothing went out in any of those", posts.length, 0);
  check("an installed copy, run by a person, still reports", (await usage.opened()).sent, true);
  check("  …and sends the answer that was waiting", (await usage.send()).sent, true);

  // 10. Nothing personal ever goes.
  check("usage carries nothing it should not", Object.keys(usagePosts()[0]).sort(),
    ["answers", "install", "kind", "models", "os", "services", "since", "tokens", "until", "version"]);
  check("an 'open' note carries nothing it should not", Object.keys(openPosts()[0]).sort(),
    ["at", "install", "kind", "os", "version"]);

  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall good");
  process.exit(failures ? 1 : 0);
});
