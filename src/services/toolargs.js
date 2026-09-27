/**
 * toolargs.js — reading the arguments of a tool call, even when the model
 * packed them badly.
 *
 * A model asks for a tool by sending its arguments as a JSON string. For
 * "write_file" that string has to carry an entire file inside it, with every
 * line break written as \n and every quote escaped. Models get that wrong
 * often, and the bigger the file the likelier they do: a game, a web page,
 * anything with code in it. What arrives is JSON.parse throwing, and what the
 * person saw was their work quietly not happening.
 *
 * The strict parse is tried first and nothing here touches it. Only when it
 * fails do we look harder — and we can, because we know what the arguments
 * are meant to look like: a file name, and the file's text. So the text is
 * taken literally from between its quotes, whatever it contains.
 *
 * Nothing repaired here is ever written without the person seeing it: a write
 * stops and shows its whole content first, so a bad repair shows up as
 * nonsense on the screen and gets refused, not written.
 *
 * read() returns { args, how }, where how is
 *   "clean"     parsed as sent
 *   "repaired"  read out of malformed JSON — usable, show it to the person
 *   "cut"       it stops in the middle; the rest never arrived
 *   "unreadable"nothing could be made of it
 */

/** Line breaks and tabs inside a JSON string must be escaped; models forget. */
function escapeRawControls(text) {
  let out = "", inString = false, escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Does this text stop in the middle of a string or an object? */
function looksCut(text) {
  let inString = false, escaped = false, depth = 0;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return inString || depth > 0;
}

/** Turn the escapes in a JSON string body back into the characters they mean. */
function unescape(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (whole, what) => {
    if (what[0] === "u") return String.fromCharCode(parseInt(what.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\", "/": "/" }[what] ?? what;
  });
}

/** Where a key's value starts, for a top-level key of this object. */
function valueStart(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*').exec(text);
  return m ? m.index + m[0].length : -1;
}

/**
 * The arguments we care about are a short name and a long body. Read the name
 * strictly and take the body literally, so whatever quotes and line breaks it
 * contains no longer matter.
 */
function readFileAndContent(text) {
  const out = {};
  const fileAt = valueStart(text, "file");
  const contentAt = valueStart(text, "content");
  if (contentAt < 0) return null;

  // the name: an ordinary short string, so the plain reading is enough
  if (fileAt >= 0 && text[fileAt] === '"') {
    const end = (() => {
      for (let i = fileAt + 1; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === '"') return i;
      }
      return -1;
    })();
    if (end > fileAt) out.file = unescape(text.slice(fileAt + 1, end));
  }

  if (text[contentAt] !== '"') return null;
  let body;
  if (fileAt > contentAt) {
    // content comes first: it ends where the next key begins
    const nextKey = text.lastIndexOf('"', text.lastIndexOf('"file"'));
    const comma = text.lastIndexOf(",", text.indexOf('"file"'));
    const stop = comma > contentAt ? text.lastIndexOf('"', comma) : nextKey;
    if (stop <= contentAt) return null;
    body = text.slice(contentAt + 1, stop);
  } else {
    // content is last: it ends at the object's closing brace
    const brace = text.lastIndexOf("}");
    const quote = text.lastIndexOf('"', brace < 0 ? text.length : brace);
    if (quote <= contentAt) return null;
    body = text.slice(contentAt + 1, quote);
  }
  out.content = unescape(body);
  // a booleanish flag, if the model sent one
  if (/"append"\s*:\s*true/.test(text)) out.append = true;
  return out.file || out.content ? out : null;
}

/** Other tools take one short value; a lenient read is enough for those. */
function readShort(text) {
  const out = {};
  for (const key of ["file", "folder"]) {
    const at = valueStart(text, key);
    if (at < 0 || text[at] !== '"') continue;
    const end = text.indexOf('"', at + 1);
    if (end > at) out[key] = unescape(text.slice(at + 1, end));
  }
  return Object.keys(out).length ? out : null;
}

function read(raw, toolName) {
  if (raw && typeof raw === "object") return { args: raw, how: "clean" };
  let text = String(raw == null ? "" : raw).trim();
  if (!text) return { args: {}, how: "clean" };

  // some services wrap it in a code fence, or encode it twice
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const once = JSON.parse(text);
    if (typeof once === "string") {
      try { return { args: JSON.parse(once), how: "clean" }; } catch (_) { text = once; }
    } else if (once && typeof once === "object") {
      return { args: once, how: "clean" };
    }
  } catch (_) { /* on to the repairs */ }

  // the common mistake: real line breaks inside the file's text
  try { return { args: JSON.parse(escapeRawControls(text)), how: "repaired" }; } catch (_) {}
  // a trailing comma
  try { return { args: JSON.parse(escapeRawControls(text).replace(/,\s*([}\]])/g, "$1")), how: "repaired" }; } catch (_) {}

  const cut = looksCut(text);
  const salvaged = toolName === "write_file" ? readFileAndContent(text) : readShort(text);
  if (salvaged && !cut) return { args: salvaged, how: "repaired" };
  if (cut) return { args: salvaged || {}, how: "cut" };
  return { args: {}, how: "unreadable" };
}

module.exports = { read, escapeRawControls, looksCut };
