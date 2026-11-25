/**
 * check-checkup.js — does the Checkup's arithmetic hold?
 *
 *   node scripts/check-checkup.js
 *
 * No network: made-up epochs go through the same functions the data job and
 * the app use (src/services/checkup.js).
 */
const C = require("../src/services/checkup");

let ok = 0, bad = 0;
const near = (a, b) => Math.abs(a - b) < 1e-6;
function check(name, pass, detail) {
  if (pass) ok++; else { bad++; console.log(`FAIL  ${name}${detail !== undefined ? "\n   " + JSON.stringify(detail) : ""}`); }
}
// an epoch that mints 1,000 GNK among hosts weighing 10,000 in all; this host weighs 1,000 (worth 100 GNK)
const row = (over) => ({ e: 100, minted: 1000, all: 10000, w: 1000, cw: 1000, paid: 100, requests: 1000, missed: 0, reason: "", claimed: true, ...over });

// ---- one host in one epoch ----
let d = C.split(row({}));
check("paid in full: nothing missed", near(d.full, 100) && near(d.paid, 100) && near(d.cut, 0) && near(d.fees, 0) && near(d.received, 0) && d.cause === null && !d.close, d);

d = C.split(row({ cw: 900, paid: 81 }));      // confirmed 10% lower, then 10% fees: 100 → 90 → 81
check("confirmed lower, then fees: the two parts", near(d.cut, 10) && near(d.fees, 9) && near(d.received, 0), d);
check("the parts add up to what was missed", near(d.full - d.paid, d.cut + d.fees), d);

d = C.split(row({ paid: 130 }));              // paid more than its weight was worth: it received fees
check("paid over its weight: fees received, none paid", near(d.received, 30) && near(d.fees, 0) && near(d.cut, 0), d);

d = C.split(row({ cw: 300, paid: 0, reason: "failed_confirmation_poc" }));
check("failed confirmation: the whole epoch is lost", d.cause === "confirmation" && near(d.lost, 100) && near(d.cut, 0) && near(d.ratio, 0.3), d);

d = C.split(row({ paid: 0, requests: 800, missed: 200 }));
check("too many requests missed: the whole epoch is lost", d.cause === "missed" && near(d.lost, 100) && near(d.missed, 0.2), d);

d = C.split(row({ paid: 0, claimed: false }));
check("nothing paid, not claimed, nothing explains it: not judged yet", d === null, d);

d = C.split(row({ paid: 0, claimed: true }));
check("nothing paid and claimed: lost, cause not in the records", d && d.cause === "other" && near(d.lost, 100), d);

d = C.split(row({ cw: 600, paid: 60 }));
check("paid, but confirmed at 60%: a close call", d.close === true && d.cause === null, d);
d = C.split(row({ requests: 920, missed: 80 }));
check("paid, but 8% of requests missed: a close call", d.close === true, d);

// ---- a host's epochs added up ----
const window = [110, 109, 108, 107, 106, 105, 104, 103, 102, 101];        // newest first
const days = [
  C.split(row({ e: 110, cw: 900, paid: 81 })),                           // cut 10, fees 9
  C.split(row({ e: 109 })),                                              // clean
  C.split(row({ e: 105, cw: 0, paid: 0, reason: "failed_confirmation_poc" })),   // lost 100
  C.split(row({ e: 101, paid: 95 }))                                     // fees 5
];
const s = C.summarize(days, window, 20);
check("added up: made, lost, cut, fees", near(s.made, 276) && near(s.lost, 100) && near(s.confirmCut, 10) && near(s.feesPaid, 14) && s.epochs === 4, s);
check("made + lost + cut + fees = what its weight was worth", near(s.made + s.lost + s.confirmCut + s.feesPaid - s.feesReceived, s.worth), s);
check("lost epochs are listed, newest first", s.zero.length === 1 && s.zero[0].e === 105 && s.zero[0].cause === "confirmation", s.zero);
const w7 = s.windows[0];                       // the last 7 epochs: 110…104 → epochs 110, 109, 105
check("fixed 7 epochs ago: only the epochs it took part in since", w7.in === 3 && near(w7.made, 181) && near(w7.lost, 100) && near(w7.cut, 10) && near(w7.fees, 9) && near(w7.rough, 60), w7);
const w30 = s.windows[2];                      // a window longer than the record: everything
check("a window longer than the record takes everything there is", w30.in === 4 && near(w30.fees, 14), w30);

// ---- this epoch so far ----
check("clear of both lines", C.live({ requests: 5000, missed: 20, confirmation: 1 }).level === 0);
let l = C.live({ requests: 850, missed: 150, confirmation: 1 });
check("15% of requests missed: over the line", l.level === 2 && l.flags[0].code === "missed" && near(l.flags[0].share, 0.15), l);
l = C.live({ requests: 930, missed: 70, confirmation: 1 });
check("7% of requests missed: close", l.level === 1 && l.flags[0].code === "missed", l);
check("a share of very few requests is not flagged", C.live({ requests: 8, missed: 4, confirmation: 1 }).level === 0);
l = C.live({ requests: 0, missed: 0, confirmation: 0 });
check("weight confirmed at nothing: over the line", l.level === 2 && l.flags[0].code === "confirmation", l);
check("weight confirmed at 60%: close", C.live({ requests: 0, missed: 0, confirmation: 0.6 }).level === 1);
check("confirmation unknown is not flagged", C.live({ requests: 0, missed: 0, confirmation: null }).level === 0);
l = C.live({ requests: 0, missed: 0, confirmation: 0, leftOut: "failed_confirmation_poc" });
check("already left out of the epoch: said once, as lost", l.level === 3 && l.flags.length === 1 && l.flags[0].code === "left-out" && l.flags[0].reason === "failed_confirmation_poc", l);
check("no record at all: nothing to say", C.live(null) === null);

// ---- the to-do list ----
const host = { ...s, fullDay: 100, moves: [{ kind: "fees", gnkDay: 9, size: 9 }, { kind: "down", gnkDay: 40, size: 40 }, { kind: "model", gnkDay: null, perGpuDay: 3, fits: 8, size: 24 }] };
let list = C.todo(host, null);
check("biggest first: by GNK per epoch", list.map((m) => m.kind).join(",") === "down,lost,model,fees,confirm", list.map((m) => [m.kind, m.size]));
list = C.todo(host, C.live({ requests: 850, missed: 150, confirmation: 1 }));
check("an epoch being lost now comes first, with what is at stake", list[0].kind === "live-missed" && list[0].atStake === 100 && list[0].level === 2, list[0]);
check("every thing has a key to be marked by", list.every((m) => typeof m.key === "string" && m.key.length > 0), list.map((m) => m.key));
check("could add: the moves with a figure, never a model move", near(C.couldAdd(host), 49));
check("a host with nothing found has an empty list", C.todo({ epochs: 30, zero: [], lost: 0, confirmCut: 0, paidWorth: 3000, moves: [] }, C.live({ requests: 9000, missed: 9, confirmation: 1 })).length === 0);
check("a cut under 1% of its pay is not worth a line", !C.todo({ epochs: 30, zero: [], lost: 0, confirmCut: 20, paidWorth: 3000, moves: [] }, null).some((m) => m.kind === "confirm"));

// ---- measured again, machine by machine ----
// a network of 12 machines of 1,000 each; host "me" has four of them; this re-measurement reads 10% under the start for everyone
const allM = [];
for (let i = 0; i < 8; i++) allM.push({ host: "other", id: "o" + i, w: 1000, eff: 300 });
for (const id of ["a", "b", "c", "d"]) allM.push({ host: "me", id, w: 1000, eff: 300 });
const rawOf = (over) => { const r = {}; for (const x of allM) r[`${x.host}|${x.id}`] = 900; return { ...r, ...over }; };
let rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({}), kept: [] }]);
check("every machine did as the network's middle machine: nothing flagged", rm.flagged.length === 0 && rm.events[0].held === 4 && near(rm.worst, 0), rm);
rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({ "me|b": 720 }), kept: [] }]);
check("a machine 20% under the middle is low, and sized", rm.flagged.length === 1 && rm.flagged[0].id === "b" && rm.flagged[0].got[0].state === "low" && near(rm.flagged[0].got[0].rel, 0.8) && near(rm.events[0].short, 0.05), rm);
rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({ "me|b": 830 }), kept: [] }]);
check("8% under the middle is inside the chain's tolerance: held", rm.flagged.length === 0 && rm.events[0].held === 4, rm.events);
rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({ "me|c": 0, "me|d": 0 }), kept: ["me|c"] }]);
check("no reading: kept serving counts in full, not kept counts as nothing", rm.events[0].kept === 1 && rm.events[0].none === 1 && rm.flagged.length === 1 && rm.flagged[0].id === "d" && near(rm.events[0].short, 0.25), rm);
rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({ "me|c": 0 }), kept: null }]);
check("no reading and the chain no longer says why: unknown, never called missing", rm.flagged.length === 0 && rm.unknown.join() === "c" && rm.events[0].unknown === 1 && near(rm.events[0].short, 0), rm);
rm = C.remeasured("me", allM, [{ n: 0, height: 10, raw: rawOf({}), kept: [] }, { n: 1, height: 20, raw: rawOf({ "me|a": 450 }), kept: [] }]);
check("two re-measurements: the worst one is the one that counts", rm.events.length === 2 && near(rm.events[0].short, 0) && near(rm.events[1].short, 0.125) && near(rm.worst, 0.125) && rm.flagged[0].got.length === 2, rm);
rm = C.remeasured("me", allM.slice(8), [{ n: 0, height: 10, raw: { "me|a": 900, "me|b": 500 }, kept: [] }]);
check("too few machines measured to call a middle: nobody is called low", rm.events[0].judged === false && rm.events[0].low === 0, rm.events);

// ---- before and after ----
// Before: it kept 80% of what its weight was worth (made 800 of 1,000). Its machines proved 1,000 on model "m".
const base = C.baseline({ epochs: 10, worth: 1000, made: 800, paidWorth: 900, confirmCut: 45, feesPaid: 85.5, zero: [{ e: 3 }], work: { m: 1000 } }, { from: 1, to: 10 });
check("the day it starts: what it kept, lost, was cut and paid in fees before", near(base.keep, 0.8) && base.lostTimes === 1 && near(base.cutShare, 0.05) && near(base.feeShare, 0.1) && base.work.m === 1000, base);
// Each epoch mints 1,000 GNK among hosts weighing 10,000; the model's rate is 1.
const eps = { 12: { minted: 1000, all: 10000, rates: { m: 1 } }, 13: { minted: 1000, all: 10000, rates: { m: 1 } } };
check("no epoch has finished since: nothing to compare yet", C.since({ epoch: 11, base }, { days: [[11, 80, 0, 5, 9, 1000]] }, eps).epochs === 0);
// same weight as before (1,000 of 10,000 = worth 100), but now paid in full: it keeps 100% instead of 80%
let sn = C.since({ epoch: 11, base }, { days: [[11, 80, 0, 5, 9, 1000], [12, 100, 0, 0, 0, 1000], [13, 100, 0, 0, 0, 1000]] }, eps);
check("same machines, keeps everything now: all of it comes from keeping more", sn.epochs === 2 && near(sn.made, 200) && near(sn.without, 160) && near(sn.brought, 40) && near(sn.fromWeight, 0) && near(sn.fromKeeping, 40) && near(sn.keepSince, 1), sn);
// machines now prove 2,000 (its weight is 2,000 of 11,000 = worth 181.8), and it still keeps 80%
sn = C.since({ epoch: 11, base }, { days: [[12, 145.4545, 0, 0, 0, 2000]] }, { 12: { minted: 1000, all: 11000, rates: { m: 1 } } });
check("machines prove twice as much, keeps the same share: all of it comes from weight", near(sn.without, 80) && Math.abs(sn.brought - 65.4545) < 1e-3 && Math.abs(sn.fromWeight - 65.4545) < 1e-3 && Math.abs(sn.fromKeeping) < 1e-3, sn);
check("the two parts add up to what the changes brought", near(sn.fromWeight + sn.fromKeeping, sn.brought), sn);
// the model's rate halves: without the changes its weight would have halved too, so no change is credited to it
sn = C.since({ epoch: 11, base }, { days: [[12, 40.404, 0, 0, 0, 500]] }, { 12: { minted: 1000, all: 9900, rates: { m: 0.5 } } });
check("a model's rate moving is not counted as the node's doing", Math.abs(sn.brought) < 0.5 && Math.abs(sn.fromWeight) < 0.5, sn);
sn = C.since({ epoch: 11, base }, { days: [[12, 0, 100, 0, 0, 1000], [13, 90, 0, 5, 5, 1000]] }, eps);
check("an epoch lost since is counted, and what was cut and paid in fees since", sn.lostSince[0] === 1 && sn.lostSince[1] === 2 && near(sn.cutSince, 0.05) && near(sn.feeSince, 5 / 95), sn);
sn = C.since({ epoch: 11, base: { ...base, work: null } }, { days: [[12, 100, 0, 0, 0, 1000]] }, eps);
check("no record of the machines that day: only what it keeps is compared", sn.weightKnown === false && near(sn.fromWeight, 0) && near(sn.brought, 20), sn);
// the file only holds the last 30 epochs: rows compared on an earlier visit are handed back and still count
sn = C.since({ epoch: 11, base, rows: [[12, 100, 80, 100, 100, 0, 0, 0], [5, 1, 1, 1, 1, 0, 0, 0]] }, { days: [[13, 100, 0, 0, 0, 1000]] }, { 13: eps[13] });
check("epochs compared on an earlier visit stay in the total; one from before the start does not", sn.epochs === 2 && sn.from === 12 && sn.to === 13 && near(sn.made, 200) && near(sn.without, 160), sn);
sn = C.since({ epoch: 11, base, rows: [[12, 1, 1, 1, 1, 0, 0, 0]] }, { days: [[12, 100, 0, 0, 0, 1000]] }, eps);
check("a fresh reading of an epoch replaces the kept one", sn.epochs === 1 && near(sn.made, 100) && near(sn.without, 80), sn);
check("a start with nothing to compare with says nothing", C.since({ epoch: 11, base: { keep: null } }, { days: [[12, 100, 0, 0, 0, 1000]] }, eps) === null);

console.log(`check-checkup: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
