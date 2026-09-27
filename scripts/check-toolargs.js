/**
 * check-toolargs.js — run with `node scripts/check-toolargs.js`.
 *
 * Every way a model has been seen to pack a tool call badly, and what we make
 * of it. The one that started this: a person asked for a little game, the
 * model sent the file with real line breaks inside the JSON string, parsing
 * threw, and the app wrote nothing and blamed the length limit.
 */
const path = require("path");
const A = require(path.join(__dirname, "..", "src", "services", "toolargs.js"));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const page = '<!DOCTYPE html>\n<html>\n<body class="game">\n  <h1>Hamichock</h1>\n</body>\n</html>';

// 1. packed properly
let r = A.read(JSON.stringify({ file: "a.md", content: "hello" }), "write_file");
check("a proper call is used as sent", [r.how, r.args.file, r.args.content], ["clean", "a.md", "hello"]);

// 2. real line breaks inside the string — the common one
r = A.read('{"file": "game.html", "content": "' + page + '"}', "write_file");
check("real line breaks are repaired", [r.how, r.args.file], ["repaired", "game.html"]);
check("  …and the file comes out whole", r.args.content, page);

// 3. an unescaped quote inside the text
r = A.read('{"file": "q.html", "content": "<p class="big">hi</p>"}', "write_file");
check("an unescaped quote is repaired", [r.how, r.args.file], ["repaired", "q.html"]);
check("  …keeping the quote in the text", r.args.content, '<p class="big">hi</p>');

// 4. the name after the text
r = A.read('{"content": "line one\nline two", "file": "notes.txt"}', "write_file");
check("the name may come last", [r.how, r.args.file, r.args.content], ["repaired", "notes.txt", "line one\nline two"]);

// 5. a trailing comma
r = A.read('{"file": "a.md", "content": "hi",}', "write_file");
check("a trailing comma is repaired", [r.how, r.args.file, r.args.content], ["repaired", "a.md", "hi"]);

// 6. wrapped in a code fence
r = A.read('```json\n{"file": "a.md", "content": "hi"}\n```', "write_file");
check("a code fence is ignored", [r.how, r.args.file], ["clean", "a.md"]);

// 7. encoded twice
r = A.read(JSON.stringify(JSON.stringify({ file: "a.md", content: "hi" })), "write_file");
check("encoded twice is unwrapped", [r.how, r.args.file], ["clean", "a.md"]);

// 8. it stops in the middle — the rest never arrived
r = A.read('{"file": "app.js", "content": "const a = document.getElem', "write_file");
check("a call that stops mid-file is not used", r.how, "cut");

// 9. an object, not a string
r = A.read({ file: "a.md", content: "hi" }, "write_file");
check("an object is taken as it is", [r.how, r.args.file], ["clean", "a.md"]);

// 10. nothing at all
r = A.read("", "write_file");
check("nothing is nothing, not an error", [r.how, JSON.stringify(r.args)], ["clean", "{}"]);

// 11. the short tools
r = A.read('{"folder": "src}', "list_files");
check("a broken short call is cut", r.how, "cut");
r = A.read('{"file": "notes.txt"}', "read_file");
check("a good short call is clean", [r.how, r.args.file], ["clean", "notes.txt"]);

// 12. adding to the end of a file survives the repair
r = A.read('{"file": "big.html", "append": true, "content": "more\nlines"}', "write_file");
check("append survives a repair", [r.how, r.args.append, r.args.file], ["repaired", true, "big.html"]);

// 13. a real file with backslashes and escapes in it keeps them
const tricky = 'const re = /\\d+/;\nconst s = "a\\tb";';
r = A.read(JSON.stringify({ file: "x.js", content: tricky }), "write_file");
check("escapes in the file itself are untouched", r.args.content, tricky);

console.log(failures ? `\n${failures} FAILED` : "\nall good");
process.exit(failures ? 1 : 0);
