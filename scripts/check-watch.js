/**
 * check-watch.js — watching your nodes, and step 1's count of hosts.
 *
 *   node scripts/check-watch.js
 *
 *   - closing GNOT's window: when it closes GNOT and when GNOT keeps watching
 *     near the clock (src/background.js), and when it was started by the
 *     computer to watch quietly;
 *   - step 1's hosts per model (netdata.modelActivity): a host counts for a
 *     model only when the network measured its machines doing that model's
 *     work, never for naming it; and each model's share of the network.
 *
 * No Electron, no server, no network (the network's answer is made up).
 */
const B = require("../src/background");

let failed = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, got, want) => {
  const ok = same(got, want);
  console.log(`${ok ? "ok   " : "FAIL "} ${name}${ok ? "" : "  — got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want)}`);
  if (!ok) failed++;
};

/* ---- closing the window ---- */
check("no node of your own: closing closes GNOT", B.onClose({ watchOn: true, own: 0, updatePending: false }), "close");
check("a node of your own, never asked: ask once", B.onClose({ watchOn: undefined, own: 1, updatePending: false }), "ask");
check("said yes before: keep watching near the clock", B.onClose({ watchOn: true, own: 2, updatePending: false }), "hide");
check("said no before: closing closes GNOT", B.onClose({ watchOn: false, own: 2, updatePending: false }), "close");
check("an update waiting: closing closes GNOT, so it installs at the next opening", B.onClose({ watchOn: true, own: 2, updatePending: true }), "close");
check("started by the computer to watch: no window", B.startsHidden(["gnot.exe", "--hidden"], null), true);
check("…or as a hidden login item on a Mac", B.startsHidden(["GNOT"], { wasOpenedAsHidden: true }), true);
check("opened by a person: the window shows", B.startsHidden(["gnot.exe"], { wasOpenedAsHidden: false }), false);

/* ---- step 1: hosts per model, as the network measured them ---- */
const P = (address, models, weights) => ({ index: address, weight: 10, models,
  ml_nodes: weights.map((ws) => ({ ml_nodes: ws.map((w) => ({ node_id: "n", poc_weight: String(w) })) })) });
const answer = { active_participants: { epoch_id: 465, participants: [
  P("a", ["m/A", "m/B"], [[100, 50], [30]]),
  P("b", ["m/A"], [[200]]),
  P("c", ["m/B"], [[0]]),          // names m/B, but no measured work on it
  P("d", ["m/C"], [[]])            // names m/C with no machines at all
] } };
global.fetch = async () => ({ ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) });

(async () => {
  const N = require("../src/services/netdata");
  const act = await N.modelActivity("http://made-up");
  check("hosts with measured work only (a host naming a model is not counted)", [act["m/A"].hosts, act["m/B"].hosts, act["m/C"].hosts], [2, 1, 0]);
  const share = (m) => Math.round(act[m].share * 1000) / 1000;
  check("each model's share of the measured work", [share("m/A"), share("m/B"), share("m/C")], [Math.round(350 / 380 * 1000) / 1000, Math.round(30 / 380 * 1000) / 1000, 0]);

  console.log(failed ? `\n${failed} FAILED` : "\nAll good.");
  process.exit(failed ? 1 : 0);
})();
