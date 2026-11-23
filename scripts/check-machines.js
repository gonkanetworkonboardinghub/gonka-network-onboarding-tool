/**
 * check-machines.js — does the machine history fold readings together correctly?
 *
 *   node scripts/check-machines.js
 *
 * No network: it feeds made-up readings to the same merge() the data job uses
 * (scripts/machines-snapshot.js) and checks what the epoch's file then says.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { merge, indexOf } = require("./machines-snapshot");

let ok = 0, bad = 0;
function check(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) ok++; else { bad++; console.log(`FAIL  ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
}
const machine = (id, status, w = 100, extra = {}) => ({ id, status, v: "3.0.14", model: "model-a", w, gpus: 8, hw: "8× NVIDIA H100 | 80GB", ...extra });
const reading = (epoch, at, hosts) => ({ epoch, at, hosts });

// 1. the epoch's first reading
let f = merge(null, reading(466, "t1", { hostA: { w: 5000, live: { requests: 100, missed: 2, confirmation: 1 }, machines: [machine("a1", "INFERENCE"), machine("a2", "FAILED", 0)] } }));
check("first reading: one reading, its time", [f.epoch, f.readings, f.times], [466, 1, ["t1"]]);
check("first reading: the host's weight and its running record", [f.hosts.hostA.w, f.hosts.hostA.live], [5000, [[0, 100, 2, 1]]]);
check("first reading: a machine as it was read", f.hosts.hostA.m.a1, { model: "model-a", hw: "8× NVIDIA H100 | 80GB", gpus: 8, v: "3.0.14", w: 100, seen: 1, st: { INFERENCE: 1 }, last: "INFERENCE" });
check("first reading: a machine that is down is kept, with its status", [f.hosts.hostA.m.a2.st, f.hosts.hostA.m.a2.last, f.hosts.hostA.m.a2.w], [{ FAILED: 1 }, "FAILED", 0]);

// 2. a second reading of the same epoch: a1 went down, a2 came back, a3 is new, hostB joined the list
f = merge(f, reading(466, "t2", {
  hostA: { w: 5000, live: { requests: 400, missed: 60, confirmation: 0.93 }, machines: [machine("a1", "FAILED"), machine("a2", "INFERENCE", 0), machine("a3", "POC", 80)] },
  hostB: { w: 900, live: null, machines: [machine("b1", "INFERENCE", 40, { v: "4.0.0" })] }
}));
check("second reading: counted, with its time", [f.readings, f.times], [2, ["t1", "t2"]]);
check("second reading: statuses add up per machine", [f.hosts.hostA.m.a1.st, f.hosts.hostA.m.a1.last, f.hosts.hostA.m.a1.seen], [{ INFERENCE: 1, FAILED: 1 }, "FAILED", 2]);
check("second reading: the work a machine proved is not lost when it goes down", f.hosts.hostA.m.a1.w, 100);
check("second reading: a machine first seen later says so", [f.hosts.hostA.m.a3.seen, f.hosts.hostA.m.a3.st], [1, { POC: 1 }]);
check("second reading: the running record grows by one row", f.hosts.hostA.live, [[0, 100, 2, 1], [1, 400, 60, 0.93]]);
check("second reading: a host with no running record gets no row", [f.hosts.hostB.live, f.hosts.hostB.m.b1.v], [[], "4.0.0"]);

// 3. a machine that is gone from the list keeps what was read, and is not counted as seen
f = merge(f, reading(466, "t3", { hostA: { w: 5000, live: { requests: 900, missed: 61, confirmation: 0.93 }, machines: [machine("a1", "INFERENCE")] } }));
check("third reading: a machine no longer listed keeps its record", [f.hosts.hostA.m.a3.seen, f.hosts.hostA.m.a3.last], [1, "POC"]);
check("third reading: readings against seen shows the gap", [f.readings, f.hosts.hostA.m.a1.seen, f.hosts.hostA.m.a2.seen], [3, 3, 2]);
check("third reading: a host missing from a reading keeps its record", Object.keys(f.hosts.hostB.m), ["b1"]);

// 4. a machine with no status at all, and a changed version
f = merge(f, reading(466, "t4", { hostA: { w: 5000, live: null, machines: [machine("a1", "", 100, { v: "4.0.0" })] } }));
check("no status is recorded as none", [f.hosts.hostA.m.a1.st.none, f.hosts.hostA.m.a1.last], [1, "none"]);
check("the newest software version stands", f.hosts.hostA.m.a1.v, "4.0.0");

// 5. the next epoch never mixes into this one
const g = merge(f, reading(467, "u1", { hostA: { w: 5100, live: null, machines: [machine("a1", "INFERENCE", 120)] } }));
check("a new epoch starts its own file", [g.epoch, g.readings, g.times, Object.keys(g.hosts), Object.keys(g.hosts.hostA.m)], [467, 1, ["u1"], ["hostA"], ["a1"]]);
check("the old epoch's file is untouched by it", [f.epoch, f.readings], [466, 4]);

// 6. the index lists the epochs kept
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnot-machines-"));
fs.writeFileSync(path.join(dir, "466.json"), JSON.stringify(f));
fs.writeFileSync(path.join(dir, "467.json"), JSON.stringify(g));
fs.writeFileSync(path.join(dir, "index.json"), "{}");
const ix = indexOf(dir, 467, "u1");
check("the index lists epochs in order and leaves itself out", [ix.epochs, ix.current, ix.asOf], [[466, 467], 467, "u1"]);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`check-machines: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
