/**
 * keys.js — everything involving the Account Key (cold wallet).
 *
 * HARD RULE: these operations run ONLY on the user's own computer, never on
 * the server — even in SSH mode. The mnemonic is returned to the renderer
 * for one-time display and is never written to disk by this app.
 *
 * The work is done natively by wallet.js — no Gonka CLI and no WSL, so it
 * runs on any Windows PC or Mac. Keys are stored in the CLI's own file
 * keyring format under <userData>/keyring, so a keyring made by earlier
 * versions (which ran the CLI) keeps working, and vice versa.
 */
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const K = require("../knowledge");
const wallet = require("./wallet");

/** The --keyring-dir the CLI used; the CLI adds "keyring-file" itself. */
function keyringDir() {
  const d = path.join(app.getPath("userData"), "keyring");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const keyringFileDir = () => path.join(keyringDir(), "keyring-file");

/**
 * Kept for the renderer's existing "Preparing…" call. The wallet is built in
 * now, so there's nothing to download, unpack or run.
 */
async function ensureCli() {
  return { builtin: true };
}

/**
 * Does a key with this name already exist? Checks the keyring's <name>.info
 * file on disk directly — passphrase-independent, so it works even when the
 * caller is trying to set a DIFFERENT passphrase than the existing keyring.
 */
function keyExists(name) {
  try {
    return fs.existsSync(path.join(keyringFileDir(), wallet.fileNameFor(`${name}.info`)));
  } catch (_) { return false; }
}

/** Names of every key already saved in the local keyring (no passphrase needed). */
function keyringKeyNames() {
  try {
    // File names escape "/" and "%" (see wallet.fileNameFor); undo that.
    const unescape = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
    return fs.readdirSync(keyringFileDir()).filter((f) => f.endsWith(".info"))
      .map((f) => unescape(f.replace(/\.info$/, "")));
  } catch (_) { return []; }
}

async function listKeys(passphrase) {
  const out = [];
  for (const name of keyringKeyNames()) {
    try {
      const k = wallet.loadKey(keyringFileDir(), name, passphrase);
      out.push({ name, type: "local", address: k.address, pubkey: wallet.pubkeyJson(k.pub) });
    } catch (_) { /* wrong passphrase or unreadable — leave it out, as the CLI does */ }
  }
  return out;
}

/**
 * Delete the local keyring entirely. The "file" backend protects the WHOLE
 * keyring with a single passphrase, so a forgotten passphrase locks the user
 * out of creating or importing anything. This gives them an escape hatch.
 * Only ever called after an explicit confirmation that warns the keys are
 * unrecoverable without their recovery phrases.
 */
function resetKeyring() {
  const removed = keyringKeyNames();
  fs.rmSync(keyringFileDir(), { recursive: true, force: true });
  return { removed };
}

// The file keyring protects ALL keys with one shared passphrase. Once any key
// exists, adding another requires that original passphrase — which reads as
// if the user mistyped the new one they just chose. Explain what's happening.
function sharedPassphraseError() {
  const names = keyringKeyNames();
  return new Error(
    "This computer already has a Gonka keyring, and it's protected by a different passphrase" +
    (names.length ? ` (it holds: ${names.join(", ")})` : "") + ".\n\n" +
    "All wallets on one computer share a single keyring passphrase, so to add a new wallet you must " +
    "enter that same existing passphrase.\n\n" +
    "If you don't remember it, use \"Reset the keyring\" to start fresh — that permanently deletes the " +
    "keys saved here, so only do it if you have their 24-word recovery phrases (or don't need them).");
}

function alreadySavedError(e) {
  return new Error(
    `This wallet is already saved on this computer as "${e.existingName}". Go back and choose ` +
    `"Unlock a key already saved on this computer", using the name "${e.existingName}".`);
}

/**
 * Create a new Account Key. Returns { address, pubkey, mnemonic }.
 * The mnemonic is shown ONCE in the UI and never stored by the app.
 */
async function createKey(name, passphrase) {
  if (keyExists(name)) {
    throw new Error(`A key named "${name}" already exists on this computer. Pick a different name, or go back and choose "I already have a wallet" to unlock it.`);
  }
  try {
    return wallet.createKey(keyringFileDir(), name, passphrase);
  } catch (e) {
    if (e.code === "BAD_PASSPHRASE") throw sharedPassphraseError();
    if (e.code === "ADDRESS_EXISTS") throw alreadySavedError(e);
    throw new Error("Key creation failed: " + e.message);
  }
}

/** Import an existing Account Key from its mnemonic. */
async function importKey(name, passphrase, mnemonic) {
  if (keyExists(name)) {
    throw new Error(
      `A key named "${name}" is already saved on this computer. If it's yours, go back and choose ` +
      `"Unlock a key already saved on this computer" instead — or pick a different key name to import into.`);
  }
  try {
    return wallet.importKey(keyringFileDir(), name, passphrase, mnemonic);
  } catch (e) {
    if (e.code === "BAD_PASSPHRASE") throw sharedPassphraseError();
    if (e.code === "ADDRESS_EXISTS") throw alreadySavedError(e);
    throw new Error("Import failed: " + e.message +
      "\nCheck that the words are in the right order and spelled exactly as written down.");
  }
}

/** Unlock a saved key. The private key stays in this process; only the address and pubkey go back. */
function unlock(name, passphrase) {
  try {
    return wallet.loadKey(keyringFileDir(), name, passphrase);
  } catch (e) {
    if (e.code === "NOT_FOUND") throw new Error(`There's no key named "${name}" on this computer.`);
    if (e.code === "BAD_PASSPHRASE") throw new Error("Couldn't read the key — is the passphrase correct?");
    throw new Error(`Couldn't read the key "${name}": ${e.message}`);
  }
}

async function showKey(name, passphrase) {
  const k = unlock(name, passphrase);
  return { address: k.address, pubkey: wallet.pubkeyJson(k.pub) };
}

const seedBase = (seedApiUrl) => String(seedApiUrl).replace(/\/+$/, "");

/**
 * The public note every transaction GNOT signs carries. It lets anyone count the
 * nodes set up with GNOT straight from the chain, epoch by epoch, with the
 * transaction as proof, and without the app reporting anything anywhere. It says
 * nothing about the person; the Welcome step tells them before anything is signed.
 * scripts/onboarded-snapshot.js looks for the word GNOT, so keep it in.
 */
const GNOT_MEMO = `Set up with GNOT v${app.getVersion()}`;

/**
 * Grant the node's ML-operational (warm) key its permissions plus a fee
 * allowance — what `inferenced tx inference grant-ml-ops-permissions` sends,
 * signed LOCALLY with the cold key.
 */
async function grantMlOps({ keyName, passphrase, warmAddress, seedApiUrl, granterAddress }, onData) {
  const k = K.get();
  const seed = seedBase(seedApiUrl);
  const perms = k.mlOpsPermissions || [];
  // Re-runs must not pay twice. The grant bundle costs ~0.0065 GNK in gas —
  // more than half a faucet claim — and blindly re-granting drained a wallet
  // to "insufficient funds" on its second launch. Skip when every permission
  // this version needs is already on-chain for this granter→grantee pair.
  if (granterAddress) {
    try {
      const url = `${seed}/chain-api/cosmos/authz/v1beta1/grants/granter/${granterAddress}?pagination.limit=200`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const j = await res.json();
        const existing = (j.grants || []).filter((g) => g.grantee === warmAddress);
        const have = new Set(existing.map((g) => g.authorization && g.authorization.msg));
        const missing = perms.filter((p) => !have.has(p));
        if (existing.length && !missing.length) {
          onData && onData(`Permissions already granted on-chain (${existing.length} grants to this node) — skipped, no gas spent.\n`);
          return { ok: true, skipped: true, output: "already granted" };
        }
        if (existing.length) onData && onData(`${missing.length} permission(s) this version needs are missing — granting again.\n`);
      }
    } catch (_) { /* can't check — fall through and send the tx */ }
  }

  const key = unlock(keyName, passphrase);
  const cold = key.address;
  const expiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);   // the CLI's default: one year
  const messages = perms.map((typeUrl) => wallet.Msg.grant(cold, warmAddress, typeUrl, expiration));

  // The chain rejects a duplicate fee allowance ("fee allowance already
  // exists"), so only include it when there isn't one — as the CLI does.
  let hasAllowance = false;
  try {
    const res = await fetch(`${seed}/chain-api/cosmos/feegrant/v1beta1/allowance/${cold}/${warmAddress}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) { const j = await res.json(); hasAllowance = !!(j && j.allowance); }
  } catch (e) {
    onData && onData(`Warning: could not check existing feegrant allowance: ${e.message}\n`);
  }
  if (!hasAllowance) {
    messages.push(wallet.Msg.grantAllowance(cold, warmAddress, [{ denom: wallet.DENOM, amount: String(k.mlOpsFeeAllowanceNgonka) }], expiration));
    onData && onData("Including new feegrant allowance from cold to warm in this transaction.\n");
  } else {
    onData && onData("Existing feegrant allowance from cold to warm detected; skipping it.\n");
  }

  // This tx bundles ~15 authz grants plus a feegrant allowance, so it's sized
  // by simulation. Adjustment is 1.2, not the docs' 1.5: at 1.5 a real run
  // needed 11,488,450 ngonka, which overshoots the 10,000,000 (0.01 GNK) a
  // faucet claim gives, leaving new hosts stuck. 1.2 still clears with ~20%
  // headroom and fits inside one claim.
  const r = await wallet.signAndBroadcast({
    seed, priv: key.priv, messages, gasAdjustment: 1.2, gasPrice: k.gasPriceNgonka, memo: GNOT_MEMO, onData
  });
  return { ok: true, output: `txhash: ${r.txhash}\nTransaction confirmed successfully! Block height: ${r.height}` };
}

/**
 * Register the host with the user's own wallet (the automatic fallback when
 * the seed's registration doesn't land). Signed LOCALLY with the cold key.
 */
async function manualRegister({ keyName, passphrase, publicUrl, consensusKey, seedApiUrl, chainId }, onData) {
  const key = unlock(keyName, passphrase);
  const msg = wallet.Msg.submitNewParticipant({ creator: key.address, url: publicUrl, validatorKey: consensusKey, workerKey: "" });
  // Adjustment 2.0, not 1.3: a real run at 1.3 was included on-chain but
  // failed with "out of gas" (wanted 72,592, needed 82,934) — simulation
  // underestimates this message type, and every failed attempt still burns
  // the full fee. The caller confirms the participant record on-chain.
  const r = await wallet.signAndBroadcast({
    seed: seedBase(seedApiUrl), chainId, priv: key.priv, messages: [msg],
    gasAdjustment: 2.0, gasPrice: K.get().gasPriceNgonka, memo: GNOT_MEMO, onData, requireInclusion: false
  });
  return { ok: true, txhash: r.txhash, output: `txhash: ${r.txhash}` + (r.pending ? "\n(broadcast; not in a block yet)" : `\nconfirmed in block ${r.height}`) };
}

/** Deposit collateral, signed LOCALLY with the cold key. */
async function depositCollateral({ keyName, passphrase, amountNgonka, seedApiUrl, chainId }, onData) {
  const amount = String(amountNgonka).replace(/[^\d]/g, "");
  if (!amount || amount === "0") throw new Error("Enter an amount to deposit.");
  const key = unlock(keyName, passphrase);
  const msg = wallet.Msg.depositCollateral(key.address, { denom: wallet.DENOM, amount });
  // Adjustment 2.0, matching registration: a real run at 1.3 was included
  // on-chain and then failed "out of gas". A failed tx still burns the whole
  // fee, so headroom is cheaper than a retry. The caller confirms the
  // collateral record on-chain.
  const r = await wallet.signAndBroadcast({
    seed: seedBase(seedApiUrl), chainId, priv: key.priv, messages: [msg],
    gasAdjustment: 2.0, gasPrice: K.get().gasPriceNgonka, memo: GNOT_MEMO, onData, requireInclusion: false
  });
  return { ok: true, txhash: r.txhash, output: `txhash: ${r.txhash}\ncode: 0` };
}

/** Account sequence (null when the account can't be read or doesn't exist yet). */
async function accountSequence(address, seedApiUrl) {
  try {
    const a = await wallet.getAccount(seedBase(seedApiUrl), address);
    return a ? Number(a.sequence) : null;
  } catch (_) { return null; }
}

/**
 * Create (or reuse) a local SSH keypair for connecting to rented servers.
 * The public half is what providers ask for at order time; the private half
 * never leaves this computer. Reuses an existing pair so the key shown
 * always matches what the user already uploaded to their provider.
 */
/** The existing SSH keypair, or null. Never creates one — used to show a key
 *  the user already generated without making them press "Create" again. */
function sshKeyInfo() {
  try {
    const dir = path.join(app.getPath("userData"), "ssh");
    const priv = path.join(dir, "gonka_ed25519");
    const pub = priv + ".pub";
    if (fs.existsSync(priv) && fs.existsSync(pub)) {
      return { privatePath: priv, publicKey: fs.readFileSync(pub, "utf8").trim(), existed: true };
    }
  } catch (_) {}
  return null;
}

function sshKeygen() {
  return new Promise((resolve, reject) => {
    const dir = path.join(app.getPath("userData"), "ssh");
    fs.mkdirSync(dir, { recursive: true });
    const priv = path.join(dir, "gonka_ed25519");
    const pub = priv + ".pub";
    if (fs.existsSync(priv) && fs.existsSync(pub)) {
      return resolve({ privatePath: priv, publicKey: fs.readFileSync(pub, "utf8").trim(), existed: true });
    }
    const { utils } = require("ssh2");
    if (!utils || typeof utils.generateKeyPair !== "function") {
      return reject(new Error("SSH key generation isn't available in this build — use password login instead."));
    }
    utils.generateKeyPair("ed25519", { comment: "gonka-host-setup" }, (err, keys) => {
      if (err) return reject(err);
      fs.writeFileSync(priv, keys.private, { mode: 0o600 });
      fs.writeFileSync(pub, keys.public + "\n");
      resolve({ privatePath: priv, publicKey: keys.public.trim(), existed: false });
    });
  });
}

module.exports = {
  ensureCli, listKeys, createKey, importKey, showKey,
  grantMlOps, manualRegister, depositCollateral, accountSequence,
  keyringDir, sshKeygen, sshKeyInfo, keyringKeyNames, resetKeyring
};
