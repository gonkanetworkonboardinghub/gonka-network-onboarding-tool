/**
 * check-compat.js — the app mending its own permission list, and reading what
 * a node says about its fees.
 *
 *   node scripts/check-compat.js
 *
 * Two pieces of the app act on something published elsewhere, so both are
 * tested against every shape that something could take:
 *
 *   knowledge.loadCompat()  takes Gonka's corrected permission list from the
 *     daily comparison (scripts/check-chain.js). A permission is what lets the
 *     server's key act for the wallet, so this must take a list ONLY when it
 *     is fresh, of a believable size, and made of nothing but Gonka's own
 *     messages. A permission to send coins must never get in this way.
 *
 *   deploy.feeBudget()  reads the node's own estimate of an epoch's fees. A
 *     node that is not up, or an older node, must come back as "nothing to
 *     say", never as a wrong figure.
 *
 * No Electron, no network beyond this computer, no key, no money.
 */
const http = require("http");
const K = require("../src/knowledge");
const deploy = require("../src/services/deploy");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok   " : "FAIL "} ${name}${ok || !detail ? "" : "  — " + detail}`); if (!ok) failed++; };

const GOOD = [
  "/inference.inference.MsgClaimRewards", "/inference.inference.MsgSubmitPocBatch",
  "/inference.inference.MsgSubmitPocValidationsV2", "/inference.inference.MsgPoCV2StoreCommit",
  "/inference.inference.MsgSubmitSeed", "/inference.inference.MsgSubmitHardwareDiff",
  "/inference.inference.MsgDeclarePoCIntent", "/inference.bls.MsgSubmitDealerPart",
  "/inference.bls.MsgSubmitPartialSignature"
];
const now = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

(async () => {
  let body = "{}", status = 200;
  const server = http.createServer((req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const k = K.get();
  const builtIn = k.mlOpsPermissions.slice();
  k.compatUrl = `http://127.0.0.1:${server.address().port}/compat.json`;

  const load = async (answer, code = 200) => {
    k.mlOpsPermissions = builtIn.slice(); delete k.compat;
    body = typeof answer === "string" ? answer : JSON.stringify(answer); status = code;
    await K.loadCompat();
    return { taken: k.mlOpsPermissions.join() !== builtIn.join(), compat: k.compat };
  };
  const withFix = (list, extra = {}) => ({ asOf: now(), ok: false, chain: { version: "v9.9.9" }, problems: [{ id: "permissions-extra" }], fix: { mlOpsPermissions: list }, ...extra });

  let r = await load(withFix(GOOD));
  check("a fresh, clean list is taken", r.taken && r.compat.listMended === true && k.mlOpsPermissions.join() === GOOD.join());
  check("…and the app knows which chain is live and what is wrong", r.compat.chain === "v9.9.9" && r.compat.ok === false && r.compat.problems.join() === "permissions-extra");

  r = await load(withFix([...GOOD, "/cosmos.bank.v1beta1.MsgSend"]));
  check("a list with a permission to send coins is refused whole", !r.taken && !r.compat.listMended);
  r = await load(withFix([...GOOD, "/cosmos.authz.v1beta1.MsgGrant"]));
  check("a list with a permission to grant permissions is refused", !r.taken);
  r = await load(withFix([...GOOD, "/inference.inference.MsgClaimRewards; drop"]));
  check("a list with a malformed entry is refused", !r.taken);
  r = await load(withFix([...GOOD, "/inference.collateral.MsgWithdrawCollateral"]));
  check("a list reaching into another module is refused", !r.taken);
  r = await load(withFix(GOOD.slice(0, 3)));
  check("a list too short to be real is refused", !r.taken);
  r = await load(withFix(Array.from({ length: 60 }, (_, i) => `/inference.inference.MsgMadeUp${i}`)));
  check("a list too long to be real is refused", !r.taken);
  r = await load(withFix("not a list"));
  check("something that is not a list is refused", !r.taken);

  r = await load(withFix(GOOD, { asOf: daysAgo(10) }));
  check("a comparison ten days old is ignored altogether", !r.taken && r.compat === undefined);
  r = await load(withFix(GOOD, { asOf: new Date(Date.now() + 864e5).toISOString() }));
  check("a comparison dated in the future is ignored", !r.taken && r.compat === undefined);
  r = await load(withFix(GOOD, { asOf: undefined }));
  check("a comparison with no date is ignored", !r.taken && r.compat === undefined);

  r = await load({ asOf: now(), ok: true, chain: { version: "v9.9.9", upgrade: { name: "v9.9.10", height: 5 } }, problems: [], fix: null });
  check("no correction offered: the built-in list stays", !r.taken && r.compat.ok === true && r.compat.upgrade === "v9.9.10");
  r = await load(withFix(GOOD), 500);
  check("the address failing leaves everything as it was", !r.taken && r.compat === undefined);
  r = await load("<html>not json</html>");
  check("an answer that is not JSON leaves everything as it was", !r.taken && r.compat === undefined);
  k.compatUrl = "";
  r = await load(withFix(GOOD));
  check("with no address set, nothing is read at all", !r.taken && r.compat === undefined);
  server.close();

  // ---- what a node says about its fees ----
  const node = (stdout) => deploy.feeBudget({ exec: async () => ({ stdout }) });
  let f = await node('{"denom":"ngonka","spendable_balance":"10000000000","budget_balance":"2400000000","count":7,"count_source":"top_participant","budget_known":true,"spendable_covers_budget":true}');
  check("a node's answer is read as it is", f && f.budget === 2.4e9 && f.spendable === 1e10 && f.covers === true && f.known === true);
  f = await node('{"denom":"ngonka","spendable_balance":"5","budget_balance":"900","count":0,"count_source":"none","budget_known":false,"spendable_covers_budget":false}');
  check("not covered, and only a first guess, is read as that", f && f.covers === false && f.known === false);
  check("a node that is not up says nothing", (await node("")) === null);
  check("an error page says nothing", (await node("curl: (7) Failed to connect")) === null);
  check("an older node's 404 says nothing", (await node('{"message":"Not Found"}')) === null);

  console.log(failed ? `\n${failed} FAILED` : "\nall good");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("check-compat failed:", e); process.exit(1); });
