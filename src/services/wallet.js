/**
 * wallet.js — the Account Key (cold wallet), done natively inside the app.
 *
 * Gonka publishes its `inferenced` CLI for Linux and macOS only: the chain
 * links CosmWasm's wasmvm, which has no Windows build. On Windows the app
 * used to run that CLI through WSL, which most PCs don't have. This module
 * does the same few jobs on every platform, with nothing to install:
 *
 *   - create / import / unlock a key (BIP-39, 24 words, coin type 1200)
 *   - keep it in the CLI's own "file" keyring format (bcrypt keyhash + JWE
 *     files), so keys move freely between this app and
 *     `inferenced --keyring-backend file`
 *   - sign (SIGN_MODE_DIRECT) and broadcast the transactions the wizard sends
 *
 * Formats mirror inferenced v0.2.15 / cosmos-sdk v0.53. The private key only
 * exists in memory while signing and never leaves this computer.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { secp256k1 } = require("@noble/curves/secp256k1");
const { sha256 } = require("@noble/hashes/sha256");
const { ripemd160 } = require("@noble/hashes/ripemd160");
const bip39 = require("@scure/bip39");
const { wordlist } = require("@scure/bip39/wordlists/english");
const { HDKey } = require("@scure/bip32");
const { bech32 } = require("@scure/base");
const bcrypt = require("bcryptjs");

const PREFIX = "gonka";
// Gonka sets coin type 1200 (inference-chain/cmd/inferenced/cmd/config.go),
// not Cosmos' default 118 — the same words give a different address under 118.
const HD_PATH = "m/44'/1200'/0'/0/0";
const DENOM = "ngonka";

/* ------------------------------------------------------------------ */
/* Protobuf — just enough to write Cosmos txs and read keyring records */
/* ------------------------------------------------------------------ */
const EMPTY = Buffer.alloc(0);
function varint(n) {
  let v = BigInt(n);
  const out = [];
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const ld = (field, b) => Buffer.concat([tag(field, 2), varint(b.length), b]);
const cat = (...parts) => Buffer.concat(parts.flat());
// Scalars are omitted at their proto3 default, exactly as gogoproto does.
const str = (field, s) => (s ? ld(field, Buffer.from(String(s), "utf8")) : EMPTY);
const bytes = (field, b) => (b && b.length ? ld(field, Buffer.from(b)) : EMPTY);
const u64 = (field, n) => (n && BigInt(n) !== 0n ? cat(tag(field, 0), varint(n)) : EMPTY);
// Embedded messages: `opt` for pointers (omitted when absent), `req` for
// gogoproto nullable=false fields, which are always written, even when empty.
const opt = (field, b) => (b ? ld(field, b) : EMPTY);
const req = (field, b) => ld(field, b || EMPTY);

/** Decode one message level into { fieldNumber: [values] }. */
function fields(buf) {
  const out = {};
  let i = 0;
  const rd = () => {
    let r = 0n, s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated protobuf");
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const k = rd();
    const f = Number(k >> 3n), w = Number(k & 7n);
    let v;
    if (w === 0) v = rd();
    else if (w === 2) { const n = Number(rd()); v = buf.subarray(i, i + n); i += n; }
    else if (w === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (w === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error("unsupported protobuf wire type " + w);
    (out[f] = out[f] || []).push(v);
  }
  return out;
}

const any = (typeUrl, value) => cat(str(1, typeUrl), bytes(2, value));
const coin = (c) => cat(str(1, c.denom), str(2, c.amount));
const timestamp = (d) => {
  const ms = d.getTime();
  const s = Math.floor(ms / 1000);
  return cat(u64(1, s), u64(2, (ms - s * 1000) * 1e6));
};
const pubKeyAny = (pub) => any("/cosmos.crypto.secp256k1.PubKey", bytes(1, pub));

/** Tx messages, each returned as an encoded google.protobuf.Any. */
const Msg = {
  grant: (granter, grantee, typeUrl, expiration) => any("/cosmos.authz.v1beta1.MsgGrant", cat(
    str(1, granter), str(2, grantee),
    req(3, cat(
      opt(1, any("/cosmos.authz.v1beta1.GenericAuthorization", str(1, typeUrl))),
      opt(2, expiration && timestamp(expiration)))))),
  grantAllowance: (granter, grantee, spendLimit, expiration) => any("/cosmos.feegrant.v1beta1.MsgGrantAllowance", cat(
    str(1, granter), str(2, grantee),
    opt(3, any("/cosmos.feegrant.v1beta1.BasicAllowance", cat(
      spendLimit.map((c) => req(1, coin(c))),
      opt(2, expiration && timestamp(expiration))))))),
  submitNewParticipant: ({ creator, url, validatorKey, workerKey }) => any("/inference.inference.MsgSubmitNewParticipant", cat(
    str(1, creator), str(2, url), str(3, validatorKey), str(4, workerKey))),
  depositCollateral: (participant, amount) => any("/inference.collateral.MsgDepositCollateral", cat(
    str(1, participant), req(2, coin(amount)))),
  send: (from, to, amount) => any("/cosmos.bank.v1beta1.MsgSend", cat(
    str(1, from), str(2, to), amount.map((c) => req(3, coin(c)))))
};

const SIGN_MODE_DIRECT = 1;
const txBody = (messages, memo) => cat(messages.map((m) => ld(1, m)), str(2, memo));
const authInfo = (pub, sequence, fee) => cat(
  ld(1, cat(opt(1, pubKeyAny(pub)), req(2, req(1, u64(1, SIGN_MODE_DIRECT))), u64(3, sequence))),
  req(2, cat(fee.amount.map((c) => req(1, coin(c))), u64(2, fee.gas))));
const signDoc = (body, auth, chainId, accountNumber) =>
  cat(bytes(1, body), bytes(2, auth), str(3, chainId), u64(4, accountNumber));
const txRaw = (body, auth, sigs) => cat(bytes(1, body), bytes(2, auth), sigs.map((s) => ld(3, Buffer.from(s))));

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */
const normalizeMnemonic = (m) => String(m || "").trim().toLowerCase().split(/\s+/).join(" ");

function privFromMnemonic(mnemonic) {
  const phrase = normalizeMnemonic(mnemonic);
  if (!bip39.validateMnemonic(phrase, wordlist)) throw new Error("invalid mnemonic");
  const node = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(phrase)).derive(HD_PATH);
  return Buffer.from(node.privateKey);
}
const pubOf = (priv) => Buffer.from(secp256k1.getPublicKey(priv, true));
const addrBytesOf = (pub) => Buffer.from(ripemd160(sha256(pub)));
const addressOf = (pub) => bech32.encode(PREFIX, bech32.toWords(addrBytesOf(pub)));
/** The same pubkey string `inferenced keys show --output json` prints. */
const pubkeyJson = (pub) => JSON.stringify({ "@type": "/cosmos.crypto.secp256k1.PubKey", key: pub.toString("base64") });

/* ------------------------------------------------------------------ */
/* File keyring (cosmos/keyring "file" backend)                        */
/*  - keyhash: bcrypt of the keyring passphrase (one per keyring)      */
/*  - <name>.info / <hexaddr>.address: JWE, PBES2-HS256+A128KW/A256GCM */
/*    wrapping {"Key","Data",...}, Data = protobuf keyring Record      */
/* ------------------------------------------------------------------ */
const JWE_ALG = "PBES2-HS256+A128KW";
const JWE_ENC = "A256GCM";
const KW_IV = Buffer.from("a6a6a6a6a6a6a6a6", "hex");

function xorCounter(block, t) {
  const b = Buffer.from(block);
  b.writeBigUInt64BE(b.readBigUInt64BE(0) ^ BigInt(t));
  return b;
}
function aes128Block(kek, block, decrypt) {
  const c = decrypt ? crypto.createDecipheriv("aes-128-ecb", kek, null) : crypto.createCipheriv("aes-128-ecb", kek, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
/** RFC 3394 AES key wrap. */
function keyWrap(kek, key) {
  const n = key.length / 8;
  let a = KW_IV;
  const r = [];
  for (let i = 0; i < n; i++) r.push(key.subarray(i * 8, i * 8 + 8));
  for (let j = 0; j <= 5; j++) {
    for (let i = 0; i < n; i++) {
      const b = aes128Block(kek, Buffer.concat([a, r[i]]), false);
      a = xorCounter(b.subarray(0, 8), n * j + i + 1);
      r[i] = b.subarray(8, 16);
    }
  }
  return Buffer.concat([a, ...r]);
}
function keyUnwrap(kek, wrapped) {
  const n = wrapped.length / 8 - 1;
  let a = wrapped.subarray(0, 8);
  const r = [];
  for (let i = 0; i < n; i++) r.push(wrapped.subarray((i + 1) * 8, (i + 2) * 8));
  for (let j = 5; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const b = aes128Block(kek, Buffer.concat([xorCounter(a, n * j + i + 1), r[i]]), true);
      a = b.subarray(0, 8);
      r[i] = b.subarray(8, 16);
    }
  }
  // The integrity check is what a wrong passphrase trips.
  if (!a.equals(KW_IV)) throw Object.assign(new Error("incorrect passphrase"), { code: "BAD_PASSPHRASE" });
  return Buffer.concat(r);
}
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const kekFor = (passphrase, p2s, p2c) =>
  crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), Buffer.concat([Buffer.from(JWE_ALG), Buffer.from([0]), p2s]), p2c, 16, "sha256");

function jweEncrypt(plaintext, passphrase) {
  const p2s = crypto.randomBytes(12);
  const p2c = 8192;   // jose2go's default, which the CLI uses
  // Key order matches Go's sorted map marshalling; only cosmetic.
  const header = { alg: JWE_ALG, created: new Date().toString(), enc: JWE_ENC, p2c, p2s: b64u(p2s) };
  const protectedB64 = b64u(Buffer.from(JSON.stringify(header)));
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cek, iv);
  c.setAAD(Buffer.from(protectedB64, "ascii"));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return [protectedB64, b64u(keyWrap(kekFor(passphrase, p2s, p2c), cek)), b64u(iv), b64u(ct), b64u(c.getAuthTag())].join(".");
}

function jweDecrypt(token, passphrase) {
  const parts = String(token).trim().split(".");
  if (parts.length !== 5) throw new Error("not a keyring file");
  const [h, ek, iv, ct, tagB64] = parts;
  const header = JSON.parse(unb64u(h).toString("utf8"));
  if (header.alg !== JWE_ALG || header.enc !== JWE_ENC) {
    throw new Error(`unsupported keyring encryption (${header.alg}/${header.enc})`);
  }
  const cek = keyUnwrap(kekFor(passphrase, unb64u(header.p2s), header.p2c), unb64u(ek));
  const d = crypto.createDecipheriv("aes-256-gcm", cek, unb64u(iv));
  d.setAAD(Buffer.from(h, "ascii"));
  d.setAuthTag(unb64u(tagB64));
  return Buffer.concat([d.update(unb64u(ct)), d.final()]);
}

// cosmos/keyring escapes only "/" (and "%") in file names; spaces stay.
const fileNameFor = (itemKey) => itemKey.replace(/%/g, "%25").replace(/\//g, "%2F");

function writeItem(dir, itemKey, data, passphrase) {
  const payload = JSON.stringify({
    Key: itemKey, Data: Buffer.from(data).toString("base64"), Label: "", Description: "",
    KeychainNotTrustApplication: false, KeychainNotSynchronizable: false
  });
  fs.writeFileSync(path.join(dir, fileNameFor(itemKey)), jweEncrypt(payload, passphrase), { mode: 0o600 });
}
function readItem(dir, itemKey, passphrase) {
  const file = path.join(dir, fileNameFor(itemKey));
  if (!fs.existsSync(file)) return null;
  const item = JSON.parse(jweDecrypt(fs.readFileSync(file, "utf8"), passphrase).toString("utf8"));
  return Buffer.from(item.Data || "", "base64");
}

/**
 * The CLI's keyring passphrase gate: a keyring that already has a keyhash
 * only opens with that passphrase; a new one records it. Returns false for
 * a mismatch instead of throwing, so callers can explain it their own way.
 */
function passphraseOk(dir, passphrase, { create } = {}) {
  const f = path.join(dir, "keyhash");
  if (fs.existsSync(f)) return bcrypt.compareSync(passphrase, fs.readFileSync(f, "utf8").trim());
  if (create) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, bcrypt.hashSync(passphrase, 10), { mode: 0o600 });
  }
  return true;
}

const recordBytes = (name, pub, priv) => cat(
  str(1, name),
  opt(2, pubKeyAny(pub)),
  opt(3, opt(1, any("/cosmos.crypto.secp256k1.PrivKey", bytes(1, priv)))));

function parseRecord(buf) {
  const r = fields(buf);
  const local = r[3] && fields(r[3][0]);
  if (!local || !local[1]) {
    throw new Error("this key has no private key on this computer (it's a Ledger or watch-only key)");
  }
  const privAny = fields(local[1][0]);
  const type = privAny[1] ? privAny[1][0].toString("utf8") : "";
  if (type !== "/cosmos.crypto.secp256k1.PrivKey") throw new Error(`unsupported key type ${type || "(unknown)"}`);
  const priv = Buffer.from(fields(privAny[2][0])[1][0]);
  const pub = pubOf(priv);
  return { name: r[1] ? r[1][0].toString("utf8") : "", priv, pub, address: addressOf(pub) };
}

/**
 * Save a key exactly as `inferenced keys add` would. Throws with a `code`
 * the caller can turn into a friendly message.
 */
function saveKey(dir, name, priv, passphrase) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, fileNameFor(`${name}.info`)))) {
    throw Object.assign(new Error(`${name}.info: key already exists`), { code: "NAME_EXISTS" });
  }
  if (!passphraseOk(dir, passphrase, { create: true })) {
    throw Object.assign(new Error("incorrect passphrase"), { code: "BAD_PASSPHRASE" });
  }
  const pub = pubOf(priv);
  const addrKey = `${addrBytesOf(pub).toString("hex")}.address`;
  const existing = readItem(dir, addrKey, passphrase);
  if (existing) {
    const other = existing.toString("utf8").replace(/\.info$/, "");
    throw Object.assign(new Error(`this wallet is already saved as "${other}"`), { code: "ADDRESS_EXISTS", existingName: other });
  }
  writeItem(dir, `${name}.info`, recordBytes(name, pub, priv), passphrase);
  writeItem(dir, addrKey, Buffer.from(`${name}.info`, "utf8"), passphrase);
  return { address: addressOf(pub), pubkey: pubkeyJson(pub) };
}

function createKey(dir, name, passphrase) {
  const mnemonic = bip39.generateMnemonic(wordlist, 256);   // 24 words, like the CLI
  return { ...saveKey(dir, name, privFromMnemonic(mnemonic), passphrase), mnemonic };
}

function importKey(dir, name, passphrase, mnemonic) {
  return saveKey(dir, name, privFromMnemonic(mnemonic), passphrase);
}

/** Decrypt a saved key. Never returns the private key to the renderer. */
function loadKey(dir, name, passphrase) {
  if (!passphraseOk(dir, passphrase)) throw Object.assign(new Error("incorrect passphrase"), { code: "BAD_PASSPHRASE" });
  const data = readItem(dir, `${name}.info`, passphrase);
  if (!data) throw Object.assign(new Error(`${name}.info: key not found`), { code: "NOT_FOUND" });
  return parseRecord(data);
}

/* ------------------------------------------------------------------ */
/* Chain access — through a node's /chain-api (REST) and /chain-rpc    */
/* ------------------------------------------------------------------ */
const trimBase = (seed) => String(seed).replace(/\/+$/, "");

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

async function postJson(url, payload, timeoutMs = 30000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

/** account_number/sequence, or null when the account doesn't exist yet (never funded). */
async function getAccount(seed, address) {
  const { status, body } = await getJson(`${trimBase(seed)}/chain-api/cosmos/auth/v1beta1/accounts/${address}`);
  if (status === 404 || (body && body.code === 5)) return null;
  if (status !== 200 || !body || !body.account) {
    throw new Error(`couldn't read account ${address} from the network (HTTP ${status})`);
  }
  // BaseAccount, or a wrapper (vesting/module) that nests one.
  const find = (o) => {
    if (!o || typeof o !== "object") return null;
    if (o.account_number !== undefined) return o;
    for (const v of Object.values(o)) { const f = find(v); if (f) return f; }
    return null;
  };
  const a = find(body.account);
  if (!a) throw new Error("unexpected account format from the network");
  return { accountNumber: BigInt(a.account_number || 0), sequence: BigInt(a.sequence || 0) };
}

async function getChainId(seed) {
  const { body } = await getJson(`${trimBase(seed)}/chain-api/cosmos/base/tendermint/v1beta1/node_info`);
  const id = body && body.default_node_info && body.default_node_info.network;
  if (!id) throw new Error("couldn't read the chain ID from the network");
  return id;
}

/** Gas the chain says this tx uses, via the same ABCI query the CLI makes. */
async function simulate(seed, txBytes) {
  const { body } = await postJson(`${trimBase(seed)}/chain-rpc/`, {
    jsonrpc: "2.0", id: Date.now(), method: "abci_query",
    params: { path: "/cosmos.tx.v1beta1.Service/Simulate", data: bytes(2, txBytes).toString("hex"), prove: false }
  });
  const resp = body && body.result && body.result.response;
  if (!resp) throw new Error("failed to simulate gas: " + JSON.stringify((body && body.error) || body).slice(0, 300));
  if (resp.code) throw new Error("failed to simulate gas: " + (resp.log || `code ${resp.code}`));
  const gasInfo = fields(Buffer.from(resp.value || "", "base64"))[1];
  const used = gasInfo && fields(gasInfo[0])[2];
  if (!used) throw new Error("failed to simulate gas: no gas estimate returned");
  return Number(used[0]);
}

async function broadcast(seed, txBytes) {
  const { status, body } = await postJson(`${trimBase(seed)}/chain-api/cosmos/tx/v1beta1/txs`,
    { tx_bytes: txBytes.toString("base64"), mode: "BROADCAST_MODE_SYNC" });
  const r = body && body.tx_response;
  if (!r || !r.txhash) throw new Error(`broadcast failed (HTTP ${status}): ${JSON.stringify(body).slice(0, 300)}`);
  return { txhash: r.txhash, code: Number(r.code || 0), rawLog: r.raw_log || "" };
}

/** Poll until the tx is in a block (the CLI waits 20 × 3 s). null = not seen yet. */
async function waitForTx(seed, txhash, onData, tries = 20, delayMs = 3000) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const { status, body } = await getJson(`${trimBase(seed)}/chain-api/cosmos/tx/v1beta1/txs/${txhash}`);
      const r = body && body.tx_response;
      if (status === 200 && r && Number(r.height) > 0) {
        return { height: Number(r.height), code: Number(r.code || 0), rawLog: r.raw_log || "", gasUsed: r.gas_used, gasWanted: r.gas_wanted };
      }
    } catch (_) { /* transient — keep polling */ }
    onData && onData(".");
  }
  return null;
}

/**
 * Sign `messages` with `priv` and broadcast, sizing gas like the CLI's
 * `--gas auto --gas-adjustment X --gas-prices Nngonka`.
 * Resolves once the tx is in a block with code 0; throws on any failure.
 * With `requireInclusion: false`, a tx that's broadcast but not yet seen in a
 * block resolves with `pending: true` (the caller verifies on-chain itself).
 */
async function signAndBroadcast({ seed, chainId, priv, messages, gasAdjustment, gasPrice = 10, memo = "", onData, requireInclusion = true }) {
  const pub = pubOf(priv);
  const address = addressOf(pub);
  const acct = await getAccount(seed, address);
  if (!acct) {
    throw new Error(`account ${address} not found on the network — it has never received any GNK. ` +
      "Fund it first (e.g. the faucet), then try again.");
  }
  const chain = chainId || await getChainId(seed);
  const body = txBody(messages, memo);

  let res, fee, gas;
  for (let attempt = 1; ; attempt++) {
    const { sequence } = attempt === 1 ? acct : (await getAccount(seed, address)) || acct;
    // Simulation runs the messages without committing them. The signature is
    // left empty; the chain skips verifying it when simulating.
    const gasUsed = await simulate(seed, txRaw(body, authInfo(pub, sequence, { amount: [], gas: 0 }), [EMPTY]));
    gas = Math.floor(gasUsed * gasAdjustment);
    onData && onData(`gas estimate: ${gas}\n`);

    fee = { amount: [{ denom: DENOM, amount: String(BigInt(gas) * BigInt(gasPrice)) }], gas };
    const auth = authInfo(pub, sequence, fee);
    const digest = sha256(signDoc(body, auth, chain, acct.accountNumber));
    const sig = secp256k1.sign(digest, priv, { lowS: true }).toCompactRawBytes();
    res = await broadcast(seed, txRaw(body, auth, [sig]));
    // 32 = account sequence mismatch: this wallet's previous tx (e.g. the
    // registration just before the grant) is still waiting for a block. Give
    // it one and re-read the sequence rather than failing the step.
    if (res.code === 32 && attempt < 4) {
      onData && onData("Previous transaction from this wallet hasn't landed yet — waiting for the next block...\n");
      await new Promise((r) => setTimeout(r, 6000));
      continue;
    }
    break;
  }
  if (res.code !== 0) {
    throw new Error(`transaction failed on broadcast with code ${res.code}: ${res.rawLog}`);
  }
  onData && onData(`Transaction sent with hash: ${res.txhash}\nWaiting for transaction to be included in a block...\n`);

  const done = await waitForTx(seed, res.txhash, onData);
  if (!done) {
    if (!requireInclusion) return { txhash: res.txhash, pending: true, fee: fee.amount[0].amount, gas };
    throw new Error(`Timed out waiting for transaction ${res.txhash} to be confirmed in a block`);
  }
  if (done.code !== 0) {
    throw new Error(`Transaction ${res.txhash} included in block ${done.height} but failed with code ${done.code}: ${done.rawLog}`);
  }
  onData && onData(`\nTransaction confirmed successfully!\nBlock height: ${done.height}\n`);
  return { txhash: res.txhash, height: done.height, code: 0, fee: fee.amount[0].amount, gas };
}

module.exports = {
  PREFIX, HD_PATH, DENOM, Msg,
  privFromMnemonic, pubOf, addressOf, pubkeyJson,
  createKey, importKey, loadKey, saveKey, passphraseOk, fileNameFor,
  getAccount, getChainId, simulate, broadcast, waitForTx, signAndBroadcast,
  // exposed for the format tests
  _internal: { fields, txBody, authInfo, signDoc, txRaw, jweEncrypt, jweDecrypt, recordBytes, parseRecord, keyWrap, keyUnwrap }
};
