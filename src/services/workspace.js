/**
 * workspace.js — the tools the model is allowed to use on this computer.
 *
 * Everything here is bound to one folder the person picks. A path that would
 * land outside it is refused, every time, however it is written: "..", an
 * absolute path, a drive letter, or a symbolic link pointing away. The folder
 * IS the permission — nothing outside it can be read or written, and the model
 * never sees a path it wasn't given.
 *
 * Reading and listing happen straight away. Writing does not: the renderer
 * shows what would be written and only calls run() for a write after the
 * person says yes. Nothing here runs commands — that comes later, if at all.
 *
 * The tool definitions are plain OpenAI-style JSON, so they work through any
 * of the services in the Use Gonka list. That is the point: the assistant is
 * ours and runs here, whichever service the person pays.
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_READ = 200 * 1024;        // a file bigger than this is summarised, not sent
const MAX_WRITE = 2 * 1024 * 1024;  // a single write
const MAX_LIST = 400;               // entries per listing

let root = null;

// The chosen folder is remembered between sessions, the way a recent project
// is: it saves picking it again every morning. It is only ever a path — the
// moment the folder is gone, or unreadable, it is forgotten.
const memory = () => path.join(app.getPath("userData"), "use-gonka", "workspace.json");

const setFolder = (dir) => {
  if (!dir) {
    root = null;
    try { fs.rmSync(memory(), { force: true }); } catch (_) {}
    return null;
  }
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) throw new Error("That isn't a folder.");
  root = real;
  try {
    fs.mkdirSync(path.dirname(memory()), { recursive: true });
    fs.writeFileSync(memory(), JSON.stringify({ folder: root }, null, 2));
  } catch (_) { /* remembering is a convenience, never a requirement */ }
  return root;
};

const getFolder = () => {
  if (root) return root;
  try {
    const saved = JSON.parse(fs.readFileSync(memory(), "utf8")).folder;
    if (saved && fs.statSync(saved).isDirectory()) root = fs.realpathSync(saved);
  } catch (_) { root = null; }
  return root;
};

/** The one rule: everything stays inside the chosen folder. */
function resolveInside(p) {
  if (!getFolder()) throw new Error("No folder has been chosen yet.");
  const joined = path.resolve(root, String(p || "."));
  // realpath what exists (so a symbolic link can't lead out), and check the
  // rest by name — the file being written may not exist yet.
  let check = joined;
  while (!fs.existsSync(check) && path.dirname(check) !== check) check = path.dirname(check);
  const real = fs.realpathSync(check) + joined.slice(check.length);
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("That path is outside the folder you chose.");
  return real;
}

const shortPath = (abs) => path.relative(root, abs).split(path.sep).join("/") || ".";

/* ---- the tools themselves --------------------------------------------- */

function listFiles({ folder = "." } = {}) {
  const dir = resolveInside(folder);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_LIST) { out.push({ note: "…more files not listed" }); break; }
    if (e.name === "node_modules" || e.name.startsWith(".git")) { out.push({ name: e.name, kind: "skipped" }); continue; }
    let size = null;
    try { size = e.isFile() ? fs.statSync(path.join(dir, e.name)).size : null; } catch (_) {}
    out.push({ name: e.name, kind: e.isDirectory() ? "folder" : "file", ...(size === null ? {} : { size }) });
  }
  return { folder: shortPath(dir), entries: out };
}

function readFile({ file } = {}) {
  const abs = resolveInside(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error("That is a folder, not a file.");
  const kind = KIND_BY_EXT[path.extname(abs).toLowerCase()];
  if (kind && kind !== "text") {
    throw new Error(kind === "picture" ? "That is a picture, and no model on Gonka can look at pictures yet."
      : kind === "pdf" ? "That is a PDF, and this app can't read PDFs yet."
      : `That is a ${kind} file, and this app can only read text.`);
  }
  if (fs.readFileSync(abs).includes(0)) throw new Error("That file isn't text, so there is nothing to read out of it.");
  if (st.size > MAX_READ) {
    return { file: shortPath(abs), size: st.size, truncated: true, text: fs.readFileSync(abs, "utf8").slice(0, MAX_READ) };
  }
  return { file: shortPath(abs), size: st.size, text: fs.readFileSync(abs, "utf8") };
}

function writeFile({ file, content } = {}) {
  const abs = resolveInside(file);
  const text = String(content == null ? "" : content);
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE) throw new Error("That file is too big to write in one go.");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, text, "utf8");
  return { file: shortPath(abs), bytes: Buffer.byteLength(text, "utf8"), replaced: existed };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List the files and folders inside the working folder, or inside one of its subfolders.",
      parameters: {
        type: "object",
        properties: { folder: { type: "string", description: "Subfolder to list, relative to the working folder. Defaults to the working folder itself." } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the working folder.",
      parameters: {
        type: "object",
        properties: { file: { type: "string", description: "Path of the file, relative to the working folder." } },
        required: ["file"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a text file in the working folder. The person is asked before this happens.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path of the file to write, relative to the working folder." },
          content: { type: "string", description: "The complete contents of the file." }
        },
        required: ["file", "content"]
      }
    }
  }
];

/** Does this tool change anything on disk? Those need a yes first. */
const NEEDS_PERMISSION = new Set(["write_file"]);

/** System errors read like a stack trace; the person reads these. */
function plainError(e, args) {
  const what = (args && (args.file || args.folder)) || "that";
  if (e.code === "ENOENT") return new Error(`There is no "${what}" in this folder.`);
  if (e.code === "EISDIR") return new Error(`"${what}" is a folder, not a file.`);
  if (e.code === "ENOTDIR") return new Error(`"${what}" is a file, not a folder.`);
  if (e.code === "EACCES" || e.code === "EPERM") return new Error(`This computer won't let the app open "${what}".`);
  if (e.code === "EBUSY") return new Error(`"${what}" is open in another program.`);
  return e;
}

function run(name, args = {}) {
  try {
    switch (name) {
      case "list_files": return listFiles(args);
      case "read_file": return readFile(args);
      case "write_file": return writeFile(args);
      default: throw new Error("Unknown tool: " + name);
    }
  } catch (e) { throw plainError(e, args); }
}

/** A short line describing what a call would do, for the person to approve. */
function describe(name, args = {}) {
  if (name === "write_file") {
    const bytes = Buffer.byteLength(String(args.content || ""), "utf8");
    let exists = false;
    try { exists = fs.existsSync(resolveInside(args.file)); } catch (_) {}
    return { file: String(args.file || ""), bytes, replaces: exists, preview: String(args.content || "").slice(0, 2000) };
  }
  if (name === "read_file") return { file: String(args.file || "") };
  if (name === "list_files") return { folder: String(args.folder || ".") };
  return {};
}

/* What can be read at all. No model on Gonka can look at a picture (tested:
   all three accept the request and then say they cannot see it), and nothing
   here decodes PDFs or Office files yet, so those are refused by name rather
   than handed over as broken text. */
const KIND_BY_EXT = {
  ".png": "picture", ".jpg": "picture", ".jpeg": "picture", ".gif": "picture", ".webp": "picture",
  ".bmp": "picture", ".svg": "text", ".pdf": "pdf", ".doc": "document", ".docx": "document",
  ".xls": "spreadsheet", ".xlsx": "spreadsheet", ".ppt": "slides", ".pptx": "slides",
  ".zip": "archive", ".exe": "program", ".mp3": "sound", ".mp4": "video", ".mov": "video"
};

module.exports = { setFolder, getFolder, TOOLS, NEEDS_PERMISSION, run, describe, resolveInside };
