/**
 * check-usage.js — run with `node scripts/check-usage.js`.
 *
 * Checks src/services/usage.js without Electron and without the real endpoint:
 * a stub "electron" pointing at a throwaway folder, a stub knowledge pointing
 * at a local server, and then the situations that matter.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
const ROOT = path.join(__dirname, "..");
let PORT = 0;
let endpoint = () => `http://127.0.0.1:${PORT}/functions/gnot-usage`;

const real = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => DIR, getVersion: () => "0.0.0-test" } };
  if (parent && parent.filename.endsWith("usage.js") && request === "../knowledge") {
    return { get: () => ({ usageEndpoint: endpoint() }) };
  }
  return real.apply(this, arguments);
};

const usage = require(path.join(ROOT, "src", "services", "usage.js"));
const file = path.join(DIR, "use-gonka", "usage.json");
const readFile = () => JSON.parse(fs.readFileSync(file, "utf8"));
const posts = [];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, "127.0.0.1", async () => {
  PORT = server.address().port;

  // 1. A brand-new computer: the very first answer reports straight away.
  usage.record({ service: "proxy", model: "m", tokens: 100 });
  await sleep(150);
  check("first answer is sent at once", posts.length, 1);
  check("  …and says one answer", posts[0] && posts[0].answers, 1);

  // 2. More answers in the same session wait: no flood.
  usage.record({ service: "proxy", model: "m", tokens: 200 });
  usage.record({ service: "proxy", model: "m", tokens: 300 });
  await sleep(150);
  check("later answers do not each send", posts.length, 1);
  check("  …they are waiting in the file", readFile().pending.answers, 2);

  // 3. Closing the app sends what is waiting — the whole point of the change.
  const u = readFile(); u.lastSent = Date.now() - 60 * 1000; fs.writeFileSync(file, JSON.stringify(u));
  let r = await usage.flush();
  check("closing sends what is waiting", [r.sent, posts.length], [true, 2]);
  check("  …with both answers and their tokens", [posts[1].answers, posts[1].tokens], [2, 500]);
  check("  …and nothing is left waiting", readFile().pending.answers, 0);

  // 4. Closing with nothing new sends nothing.
  r = await usage.flush();
  check("closing again sends nothing", [r.sent, r.why, posts.length], [false, "nothing to send", 2]);

  // 5. Two closes within half a minute: only the first sends.
  usage.record({ service: "proxy", model: "m", tokens: 10 });
  await sleep(100);
  r = await usage.flush();
  check("a second close right away is held back", [r.sent, r.why], [false, "just sent"]);
  check("  …and keeps the answer for next time", readFile().pending.answers, 1);

  // 6. The daily cap holds.
  const capped = readFile();
  capped.lastSent = Date.now() - 60 * 1000;
  capped.sends = { day: new Date().toISOString().slice(0, 10), n: 8 };
  fs.writeFileSync(file, JSON.stringify(capped));
  r = await usage.flush();
  check("eight sends in a day is enough", [r.sent, r.why], [false, "enough for today"]);

  // 7. A send that fails loses nothing.
  const good = endpoint;
  endpoint = () => "http://127.0.0.1:1/nowhere";
  const broken = readFile();
  broken.lastSent = Date.now() - 60 * 1000;
  broken.sends = { day: "1970-01-01", n: 0 };
  fs.writeFileSync(file, JSON.stringify(broken));
  r = await usage.flush();
  check("a failed send never throws", r.sent, false);
  check("  …and the answer is still waiting", readFile().pending.answers, 1);
  endpoint = good;

  // 8. With no address set, nothing is ever sent (this is the test copy).
  endpoint = () => "";
  r = await usage.flush();
  check("no address means no sending", [r.sent, r.why], [false, "no address set"]);
  endpoint = good;

  // 9. And once the address is back, the waiting answer goes out.
  const back = readFile(); back.lastSent = Date.now() - 60 * 1000; fs.writeFileSync(file, JSON.stringify(back));
  r = await usage.flush();
  check("it goes out when the address works again", [r.sent, posts.length], [true, 3]);
  check("  …never carrying anything typed", Object.keys(posts[2]).sort(),
    ["answers", "install", "models", "os", "services", "since", "tokens", "until", "version"]);

  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall good");
  process.exit(failures ? 1 : 0);
});
