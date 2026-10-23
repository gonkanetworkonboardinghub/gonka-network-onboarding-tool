/**
 * check-monitor.js — the figures Gonka Host Monitor/Vote shows, and how it asks.
 *
 *   node scripts/check-monitor.js
 *
 * A host will act on what this tool says about their node, so each figure is
 * pinned down here against made-up network answers with known results:
 *
 *   - one epoch's line: reward, share, place among the hosts, and the middle
 *     ("typical") host it is compared with — and the difference between an
 *     epoch the node sat out and one that could not be read;
 *   - the whole picture, and the list of things worth a look: each warning
 *     appears when it should and not otherwise;
 *   - proposals: the yes share, the turnout, what is being asked for;
 *   - the list of watched nodes: nothing but real addresses is ever saved;
 *   - the asking itself, against small stand-in nodes on this computer: a node
 *     that fails is passed over, one that says "slow down" is waited for, a
 *     missing record is an answer and not a failure.
 *
 * No Electron, no Gonka node, no key, no money.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const M = require("../src/services/monitor");
const { median, place, epochLine, tidyProposal, askedIn, ask, unpackEpochs } = M._internal;

let failed = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, got, want) => {
  const ok = typeof want === "function" ? !!want(got) : same(got, want);
  console.log(`${ok ? "ok   " : "FAIL "} ${name}${ok ? "" : "  — got " + JSON.stringify(got) + (typeof want === "function" ? "" : ", wanted " + JSON.stringify(want))}`);
  if (!ok) failed++;
};
const near = (x) => (got) => Math.abs(got - x) < 1e-9;

const ME = "gonka1" + "a".repeat(38), B = "gonka1" + "c".repeat(38), C = "gonka1" + "d".repeat(38), D = "gonka1" + "e".repeat(38);
const row = (address, rewarded, requests, missed, validated, invalidated, claimed = true) =>
  ({ address, rewarded, earned: 0, burned: 0, requests, missed, validated, invalidated, claimed });

(async () => {
  /* ---- small sums ---- */
  check("middle of an odd list", median([5, 1, 3]), 3);
  check("middle of an even list", median([4, 1, 3, 2]), 2.5);
  check("middle of nothing", median([]), null);
  check("place among others", place([{ address: ME, w: 5 }, { address: B, w: 9 }, { address: C, w: 1 }], "w", ME), { rank: 2, of: 3 });
  check("ties share the better place", place([{ address: ME, w: 5 }, { address: B, w: 5 }, { address: C, w: 9 }], "w", ME), { rank: 2, of: 3 });
  check("not in the list: no place", place([{ address: B, w: 5 }], "w", ME), null);

  /* ---- one epoch ---- */
  const rows = [row(ME, 400e9, 90, 10, 80, 20), row(B, 300e9, 198, 2, 99, 1), row(C, 200e9, 100, 0, 50, 0), row(D, 100e9, 97, 3, 0, 0)];
  const l = epochLine(7, rows, ME);
  check("took part", [l.took, l.epoch, l.hosts], [true, 7, 4]);
  check("reward as the chain has it", l.reward, 400e9);
  check("share of all rewards", l.rewardShare, near(0.4));
  check("first by reward", l.rewardPlace, { rank: 1, of: 4 });
  check("missed share: 10 of 100 given", l.missedShare, near(0.1));
  check("judged-wrong share: 20 of 100 checked", l.invalidShare, near(0.2));
  check("a typical host's missed share is the middle one", l.typicalMissedShare, near((0.01 + 0.03) / 2));
  check("…and a host nobody checked is left out of the judged-wrong middle", l.typicalInvalidShare, near(0.01));
  check("sat the epoch out", epochLine(7, rows, "gonka1" + "f".repeat(38)), { epoch: 7, took: false, hosts: 4 });
  check("epoch that could not be read is not 'sat out'", epochLine(7, null, ME), { epoch: 7, took: false, unknown: true, hosts: 0 });
  check("no requests at all: nothing missed", epochLine(7, [row(ME, 1, 0, 0, 0, 0)], ME).missedShare, 0);

  /* ---- the whole picture ---- */
  const now = { index: 10, phase: "Inference", height: 1500, secPerBlock: 5, pocStart: 1000, nextPocStart: 2000, epochBlocks: 1000, confirmationPocActive: false };
  const member = (address, weight) => ({ address, weight, models: ["org/Model-A"], url: "", nodes: [{ id: "n1", pocWeight: weight }], votingPower: weight });
  const healthyRaw = () => ({
    address: ME,
    record: { participant: { status: "ACTIVE", epochs_completed: 4, join_time: "1791143840304", inference_url: "http://x", current_epoch_stats: { inference_count: "5", missed_requests: "0", validated_inferences: "5", invalidated_inferences: "0", confirmationPoCRatio: { value: "1", exponent: 0 } } } },
    hardware: { nodes: { hardware_nodes: [{ local_id: "n1", status: "INFERENCE", models: ["org/Model-A"], hardware: [{ type: "NVIDIA H100 | 80GB", count: 4 }], version: "v3" }] } },
    delegation: { delegations: [{ model_id: "org/Model-B", delegate_to: B }], refusals: [], intents: [] },
    maintenance: {}, credit: { credit_blocks: "0" },
    collateral: { amount: { denom: "ngonka", amount: "500000000" } }, unbonding: { unbondings: [] },
    balance: { balances: [{ denom: "ngonka", amount: "3000000000" }] },
    allowances: { allowances: [{ grantee: B, allowance: { spend_limit: [{ denom: "ngonka", amount: "9000000000" }], expiration: "2027-10-04T00:00:00Z" } }] },
    recipient: ME, schedule: { vesting_schedule: { epoch_amounts: [{ coins: [{ denom: "ngonka", amount: "10" }] }, { coins: [{ denom: "ngonka", amount: "20" }] }, { coins: [] }] } },
    recipientBalance: { balances: [{ denom: "ngonka", amount: "3000000000" }] },
    estimate: { settle_amount: { reward_coins: "123" } }
  });
  const mem = () => ({ epoch: 10, hosts: [member(ME, 300), member(B, 600), member(C, 100)], excluded: [] });
  const quiet = [row(ME, 400e9, 99, 1, 99, 1), row(B, 300e9, 99, 1, 99, 1), row(C, 200e9, 99, 1, 99, 1)];
  const hist = () => [{ epoch: 8, rows: null }, { epoch: 9, rows: quiet }];
  const view = (change = {}) => {
    const input = { address: ME, now, mem: mem(), hist: hist(), raw: healthyRaw() };
    if (change.raw) change.raw(input.raw);
    if (change.mem) change.mem(input.mem);
    if (change.hist) input.hist = change.hist;
    const v = M.summarise(input);
    v.attention = M.attention(v);
    return v;
  };
  const codes = (v) => v.attention.map((a) => a.code);

  const v = view();
  check("in the epoch, with its share and place", [v.standing.inEpoch, v.standing.weight, v.standing.place], [true, 300, { rank: 2, of: 3 }]);
  check("share of the network's weight", v.standing.share, near(0.3));
  check("time to the next Proof of Compute: 500 blocks at 5 s", v.epoch.secondsToNextPoc, 2500);
  check("halfway through the epoch", v.epoch.progress, near(0.5));
  check("the network's estimate for this epoch", v.now.estimate, 123);
  check("last finished epoch is the newest one that could be read", v.last.epoch, 9);
  check("an unread epoch is counted as unread, not as zero", [v.totals.epochs, v.totals.of, v.totals.unknown, v.totals.reward], [1, 2, 1, 400e9]);
  check("hardware: one machine, four GPUs, working", [v.hardware.nodes.length, v.hardware.gpuCount, v.hardware.working, v.hardware.gpuKinds], [1, 4, 1, { "NVIDIA H100": 4 }]);
  check("money: wallet, collateral, allowance left", [v.money.balance, v.money.collateral, v.money.allowance.left, v.money.allowance.limited], [3e9, 5e8, 9e9, true]);
  check("still to arrive: the stream added up", [v.money.vesting.total, v.money.vesting.epochs, v.money.vesting.next7], [30, 3, 30]);
  check("delegations as the chain lists them", v.poc.delegations, [{ model: "org/Model-B", to: B }]);
  check("a healthy node: nothing needs a look", codes(v), []);

  check("left out of the epoch, with the reason", view({ mem: (m) => { m.hosts = m.hosts.filter((h) => h.address !== ME); m.excluded = [{ address: ME, reason: "failed_confirmation_poc", height: 9 }]; } }).attention[0],
    { level: "bad", code: "excluded", reason: "failed_confirmation_poc" });
  check("registered but not in the epoch", codes(view({ mem: (m) => { m.hosts = m.hosts.filter((h) => h.address !== ME); } }))[0], "not-in-epoch");
  check("a machine that is not working", view({ raw: (r) => { r.hardware.nodes.hardware_nodes.push({ local_id: "n2", status: "FAILED", models: [], hardware: [] }); } }).attention[0],
    { level: "warn", code: "machines-down", machines: [{ id: "n2", status: "FAILED" }], of: 2 });
  check("no fee allowance", codes(view({ raw: (r) => { r.allowances = { allowances: [] }; } })), ["no-allowance"]);
  check("fee allowance nearly used up", codes(view({ raw: (r) => { r.allowances.allowances[0].allowance.spend_limit[0].amount = "900000000"; } })), ["allowance-low"]);
  check("an allowance with no limit is not 'low'", codes(view({ raw: (r) => { r.allowances.allowances[0].allowance.spend_limit = []; } })), []);
  check("wallet nearly empty", codes(view({ raw: (r) => { r.balance.balances[0].amount = "50000000"; } })), ["wallet-low"]);
  check("failed some confirmation checks", codes(view({ raw: (r) => { r.record.participant.current_epoch_stats.confirmationPoCRatio = { value: "5", exponent: -1 }; } })), ["confirmation"]);
  check("took part and was paid nothing", codes(view({ hist: [{ epoch: 9, rows: [row(ME, 0, 99, 1, 99, 1), row(B, 3, 99, 1, 99, 1), row(C, 2, 99, 1, 99, 1)] }] })), ["no-reward"]);
  check("missed clearly more than a typical host", codes(view({ hist: [{ epoch: 9, rows: [row(ME, 4, 90, 10, 99, 1), row(B, 3, 99, 1, 99, 1), row(C, 2, 99, 1, 99, 1)] }] })), ["missed"]);
  check("judged wrong clearly more than a typical host", codes(view({ hist: [{ epoch: 9, rows: [row(ME, 4, 99, 1, 90, 10), row(B, 3, 99, 1, 99, 1), row(C, 2, 99, 1, 99, 1)] }] })), ["judged-wrong"]);
  check("a little more than typical raises nothing", codes(view({ hist: [{ epoch: 9, rows: [row(ME, 4, 985, 15, 99, 1), row(B, 3, 99, 1, 99, 1), row(C, 2, 99, 1, 99, 1)] }] })), []);
  check("the worst comes first", codes(view({ mem: (m) => { m.hosts = m.hosts.filter((h) => h.address !== ME); }, raw: (r) => { r.balance.balances[0].amount = "1"; } })), ["not-in-epoch", "wallet-low"]);
  const nobody = view({ raw: (r) => { r.record = null; r.hardware = null; r.allowances = null; r.balance = null; }, mem: (m) => { m.hosts = m.hosts.filter((h) => h.address !== ME); } });
  check("an address the network does not know: said so, and no warnings invented", [nobody.standing.known, codes(nobody)], [false, []]);
  check("rewards paid to another address are followed there", view({ raw: (r) => { r.recipient = B; } }).money.paidElsewhere, true);

  /* ---- the prepared history file ---- */
  const kept = unpackEpochs({ hosts: [ME, B], epochs: [{ e: 5, r: [[0, 7, 1, 10, 2, 8, 1, 1], [1, 9, 0, 4, 0, 4, 0, 0]] }] });
  check("the history file opens back into rows", kept[5], [
    { address: ME, rewarded: 7, earned: 1, requests: 10, missed: 2, validated: 8, invalidated: 1, claimed: true, burned: 0 },
    { address: B, rewarded: 9, earned: 0, requests: 4, missed: 0, validated: 4, invalidated: 0, claimed: false, burned: 0 }]);
  check("an empty or broken history file is just empty", [unpackEpochs(null), unpackEpochs({})], [{}, {}]);

  /* ---- proposals ---- */
  const prop = tidyProposal({
    id: "9", title: "T", summary: "S", status: "PROPOSAL_STATUS_PASSED",
    messages: [{ "@type": "/cosmos.distribution.v1beta1.MsgCommunityPoolSpend", amount: [{ denom: "ngonka", amount: "50000000000000" }] },
      { "@type": "/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade", plan: { name: "v9", height: "77" } }],
    final_tally_result: { yes_count: "60", no_count: "10", no_with_veto_count: "10", abstain_count: "20" }
  }, { totalWeight: 400, quorum: 0.25, threshold: 0.5 });
  check("yes share leaves abstentions out", prop.yesShare, near(60 / 80));
  check("turnout counts everyone who voted", prop.turnout, near(0.25));
  check("what it asks for, added up", prop.asked, 50000e9);
  check("what it does, in kinds", prop.does, ["spend", "upgrade"]);
  check("which version an upgrade moves to", prop.upgradeTo, { name: "v9", height: 77 });
  check("a live tally replaces the final one", tidyProposal({ id: "1", status: "PROPOSAL_STATUS_VOTING_PERIOD", messages: [], final_tally_result: {} }, { totalWeight: 10, liveTally: { yes_count: "4" } }).tally.yes, 4);
  check("amounts in other coins are not counted as GNK", askedIn([{ amount: [{ denom: "uusdt", amount: "5" }] }]), 0);

  /* ---- the list of watched nodes ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnot-monitor-"));
  const saved = M.saveNodes(dir, [{ address: ME, name: "  My\u0007 node  " }, { address: "gonka1nope" }, { address: ME, name: "again" }, { address: " " + B + " ", name: "x".repeat(90) }, null, { address: "cosmos1" + "a".repeat(38) }]);
  check("only real addresses are saved, once each, names tidied", saved, [{ address: ME, name: "My node" }, { address: B, name: "x".repeat(40) }]);
  check("…and read back the same", M.loadNodes(dir), saved);
  fs.writeFileSync(path.join(dir, "nodes.json"), "not json");
  check("a damaged list reads as empty", M.loadNodes(dir), []);
  check("no more than fifty nodes", M.saveNodes(dir, Array.from({ length: 80 }, (_, i) => ({ address: "gonka1" + String(i).padStart(2, "0").replace(/1/g, "q") + "a".repeat(36) }))).length, (n) => n <= 50);
  check("an address is 'gonka1' and 38 more of the right letters", [M.looksLikeAddress(ME), M.looksLikeAddress("gonka1" + "b".repeat(38)), M.looksLikeAddress(ME + "a"), M.looksLikeAddress("")], [true, false, false, false]);
  fs.rmSync(dir, { recursive: true, force: true });

  /* ---- the asking, against stand-in nodes ---- */
  const hits = {};
  const node = (name, answer) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      hits[name] = (hits[name] || 0) + 1;
      const a = answer(req.url, hits[name]);
      setTimeout(() => { res.writeHead(a.status, { "content-type": "application/json" }); res.end(JSON.stringify(a.body || {})); }, a.wait || 0);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
  const good = await node("good", () => ({ status: 200, body: { from: "good" } }));
  const broken = await node("broken", () => ({ status: 500 }));
  const none = await node("none", () => ({ status: 404 }));
  const busy = await node("busy", (url, n) => (n === 1 ? { status: 503 } : { status: 200, body: { from: "busy" } }));
  const dead = "http://127.0.0.1:9";

  check("a node that fails is passed over", await ask([broken.url, good.url], "/kind-a/one"), { from: "good" });
  hits.broken = 0;
  await ask([broken.url, good.url], "/kind-a/two");
  check("…and is left alone for that kind of question afterwards", hits.broken, 0);
  check("a node that cannot be reached is passed over", await ask([dead, good.url], "/kind-b/one"), { from: "good" });
  check("a record that does not exist is an answer, not a failure", await ask([none.url], "/kind-c/one"), null);
  const t0 = Date.now();
  check("told to slow down: it waits and asks again", await ask([busy.url], "/kind-d/one"), { from: "busy" });
  check("…after a pause, not at once", Date.now() - t0, (ms) => ms >= 1900);
  check("when no node answers, it fails plainly", await ask([dead], "/kind-e/one").then(() => "answered", () => "failed"), "failed");
  for (const n of [good, broken, none, busy]) n.close();

  console.log(failed ? `\n${failed} FAILED` : "\nall good");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("check-monitor failed:", e); process.exit(1); });
