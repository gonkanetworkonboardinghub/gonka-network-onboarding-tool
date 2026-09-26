/**
 * check-tools.js — run with `node scripts/check-tools.js`.
 *
 * What a tool-using turn does when the service cuts the answer short.
 *
 * This is the bug it exists to stop coming back: services cap an answer at
 * their own default (Gonka Proxy at 3,072 tokens), so a reply that is busy
 * writing a long file stops in the middle of the tool call. The arguments
 * arrive as half a line of JSON. Parsing that and carrying on turned "write
 * this 6 KB file" into "no file name was given", three times in a row, with
 * nothing written and the tokens spent.
 *
 * So: ask for the room up front, cope with a service that refuses the number,
 * and never run a call that did not arrive whole.
 *
 * No Electron, no service, no key: a stub of each.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-"));
const ROOT = path.join(__dirname, "..");
const real = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return { app: { getPath: () => DIR, getVersion: () => "0.0.0-test" }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return real.apply(this, arguments);
};

const broker = require(path.join(ROOT, "src", "services", "broker.js"));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// What the stub service does next, and what it was asked for.
let mode = "whole";
const asked = [];

const reply = (toolArguments, finish) => ({
  choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: toolArguments } }] }, finish_reason: finish }],
  usage: { completion_tokens: 3072, prompt_tokens: 100, total_tokens: 3172 }
});

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const sent = JSON.parse(body || "{}");
    asked.push(sent);
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (mode === "refuses-room" && sent.max_tokens) {
      return json(400, { error: { message: "max_tokens is too large for this model" } });
    }
    if (mode === "cut-off") {
      // exactly what a capped answer looks like: the JSON stops mid-string
      return json(200, reply('{"file":"app.js","content":"/* Task Tracker */\\nconst a = doc', "length"));
    }
    if (mode === "no-name") {
      return json(200, reply('{"content":"hello"}', "stop"));
    }
    return json(200, reply('{"file":"notes.md","content":"hello"}', "stop"));
  });
});

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  fs.mkdirSync(path.join(DIR, "use-gonka"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "use-gonka", "account.json"), JSON.stringify({
    active: "test",
    accounts: { test: { base: `http://127.0.0.1:${port}/v1`, keyEnc: Buffer.from("test-key").toString("base64"), keyPlain: true, model: "m" } }
  }));

  const ask = () => broker.chatOnce({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "write_file", parameters: {} } }] });

  // 1. A whole call runs, and the room was asked for.
  let r = await ask();
  check("the request asks for room", asked[0].max_tokens, 8192);
  check("a whole call is marked whole", [r.toolCalls[0].whole, r.toolCalls[0].args.file], [true, "notes.md"]);

  // 2. A cut-off call is marked, and its arguments are not half-guessed.
  mode = "cut-off";
  r = await ask();
  check("a cut-off call is not whole", r.toolCalls[0].whole, false);
  check("  …and carries no guessed arguments", r.toolCalls[0].args, {});
  check("  …and the reason is passed on", r.finish, "length");
  check("  …with the half-written JSON kept", r.toolCalls[0].rawArgs.endsWith("const a = doc"), true);

  // 3. A call that really has no file name is still just that — not cut off.
  mode = "no-name";
  r = await ask();
  check("a genuinely nameless call is whole", [r.toolCalls[0].whole, r.toolCalls[0].args.file], [true, undefined]);

  // 4. A service that refuses the number is asked again without it.
  mode = "refuses-room";
  asked.length = 0;
  r = await ask();
  check("a refused number is dropped and retried", [asked.length, asked[0].max_tokens, asked[1].max_tokens], [2, 8192, undefined]);
  check("  …and the answer still arrives", r.toolCalls[0].args.file, "notes.md");

  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall good");
  process.exit(failures ? 1 : 0);
});
