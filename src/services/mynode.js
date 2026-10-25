/**
 * mynode.js — shutting your own node down safely, from Gonka Host Monitor/Vote.
 *
 * The steps are Gonka's own ("How to stop your node", gonka.ai/host/quickstart):
 *
 *   1. Disable every ML node through the node's admin API. Each one finishes
 *      the epoch it is in, but does not join the next Proof of Compute, so
 *      the node is not in the next epoch. Reversible until then.
 *   2. Keep the Network Node running: it claims the reward for the last epoch
 *      it worked by itself, at that epoch's claim block.
 *   3. Check the chain says that reward was claimed; claim it by hand if not.
 *   4. Check the network no longer counts the node as a participant.
 *   5. Only then stop the containers.
 *
 * Nothing is remembered between steps: where the node stands is read fresh
 * from the chain and the server every time, so the app can be closed for the
 * day between one step and the next.
 */
const K = require("../knowledge");
const monitor = require("./monitor");
const { ask } = monitor._internal;

const INF = "/chain-api/productscience/inference";
// The admin API listens on the server itself only (deploy.hardenPorts).
const ADMIN = "http://127.0.0.1:9200/admin/v1";
const COMPOSE = "docker compose -f docker-compose.yml -f docker-compose.mlnode.yml";
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const soft = (p) => p.then((v) => v, () => undefined);
// Ids go into a URL on the server's command line, so only plain ones are used.
const plainId = (id) => /^[A-Za-z0-9._:-]{1,128}$/.test(String(id));

/** The ML nodes behind this Network Node, and whether each may join the next Proof of Compute. null when the admin API does not answer. */
async function machines(driver) {
  const r = await driver.exec(`curl -s -m 8 ${ADMIN}/nodes`, { timeoutMs: 15000 });
  let list;
  try { list = JSON.parse(r.stdout); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;
  return list.map((x) => ({
    id: String((x.node || {}).id || ""),
    enabled: !!((x.state || {}).admin_state || {}).enabled,
    status: String((x.state || {}).current_status || "")
  })).filter((m) => m.id);
}

/** Switch every ML node off (or back on) for the next Proof of Compute. */
async function setMachines(driver, enabled) {
  const list = await machines(driver);
  if (!list) throw new Error("The node's admin API on the server did not answer. Is the node running?");
  const out = [];
  for (const m of list) {
    if (m.enabled === enabled) { out.push({ id: m.id, ok: true }); continue; }
    if (!plainId(m.id)) { out.push({ id: m.id, ok: false, said: "its name has unusual characters; change it by hand" }); continue; }
    const r = await driver.exec(`curl -s -m 15 -X POST ${ADMIN}/nodes/${m.id}/${enabled ? "enable" : "disable"}`, { timeoutMs: 25000 });
    out.push({ id: m.id, ok: /successfully/.test(r.stdout), said: String(r.stdout || r.stderr || "").trim().slice(0, 300) });
  }
  return { results: out, machines: await machines(driver) };
}

/**
 * Where the node stands on its way out. `driver` may be null: the chain's
 * half still answers, and the machines are then unknown.
 */
async function shutdownStatus(seeds, driver, address) {
  const [now, mem, list] = await Promise.all([
    monitor.epochNow(seeds),
    monitor.members(seeds),
    driver ? machines(driver).catch(() => null) : Promise.resolve(null)
  ]);
  const inEpoch = mem.hosts.some((h) => h.address === address);
  const toBlock = (b) => Math.max(0, b - now.height);
  const out = {
    address,
    epoch: { index: now.index, height: now.height, phase: now.phase, secPerBlock: now.secPerBlock },
    machines: list,
    stopped: list ? list.length > 0 && list.every((m) => !m.enabled) : null,
    inEpoch,
    // While it works in this epoch, its reward is claimed at the next epoch's claim block.
    finish: inEpoch ? { epoch: now.index, block: now.nextClaimMoney, seconds: toBlock(now.nextClaimMoney) * now.secPerBlock } : null,
    reward: null
  };
  if (!inEpoch) {
    // The epoch before this one is the last it could have worked; its reward
    // is claimed at this epoch's claim block.
    const last = now.index - 1;
    const sum = await soft(ask(seeds, `${INF}/inference/epoch_performance_summary/${last}/${address}`));
    const s = sum && sum.epochPerformanceSummary;
    if (!s || !num(s.rewarded_coins)) out.reward = { epoch: last, state: "none" };
    else if (now.height < now.claimMoney) out.reward = { epoch: last, state: "waiting", amount: num(s.rewarded_coins), block: now.claimMoney, seconds: toBlock(now.claimMoney) * now.secPerBlock };
    else out.reward = { epoch: last, state: s.claimed ? "claimed" : "unclaimed", amount: num(s.rewarded_coins) };
  }
  out.ready = !inEpoch && !!out.reward && (out.reward.state === "claimed" || out.reward.state === "none") && out.stopped !== false;
  return out;
}

/** Gonka's manual claim, for a reward the node did not claim by itself. */
async function claimReward(driver) {
  const r = await driver.exec(
    `curl -s -m 60 -X POST ${ADMIN}/claim-reward/recover -H "Content-Type: application/json" -d '{"force_claim": true}'`,
    { timeoutMs: 75000 });
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { throw new Error("The node did not answer the claim: " + String(r.stdout || r.stderr || "").trim().slice(0, 300)); }
  // Success is { success: true, claim_executed: true }; a refusal is { message } alone.
  if (j.success !== true) throw new Error(j.message || "The claim did not go through.");
  return { epoch: num(j.epoch_index), executed: !!j.claim_executed, message: j.message || "" };
}

/** The last step: stop every container, the way the node was started. */
async function switchOff(driver, onData) {
  const r = await driver.exec(`cd ${K.get().repo.joinDir} && source config.env && ${COMPOSE} down`, { onData, timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "docker compose down failed").trim().slice(-600));
  return { output: ((r.stdout || "") + (r.stderr || "")).trim().slice(-2000) };
}

module.exports = { machines, setMachines, shutdownStatus, claimReward, switchOff, _internal: { plainId } };
