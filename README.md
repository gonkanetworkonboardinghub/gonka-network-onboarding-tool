# Gonka Host Setup Wizard

A downloadable desktop app that walks a non-technical person from a bare GPU
server to a registered, earning Gonka host. It connects to their server (or
runs on it), scans for problems, fixes missing dependencies with one click,
creates keys the safe way, writes `config.env` / `node-config.json`, runs the
official launch sequence in the right order, registers the host, and guides
the collateral deposit.

## Highlights

- **Two modes**: drive a remote server over SSH (Spheron rentals etc.), or run
  directly on the GPU machine (Linux, or Windows via WSL2).
- **Cold key safety**: the Account Key is created and used **only on the
  user's own computer** — never on the server, even in SSH mode. The 24-word
  phrase is shown once with a write-it-down verification quiz and never stored.
- **Stays current automatically**: the approved model list and collateral
  parameters are fetched live from the network; reference `node-config-*.json`
  files come from the freshly cloned repo, so new models/GPU classes appear
  without an app update.
- **Encodes the gotchas**: refuses to regenerate the warm key, warns about the
  `.tmkms` folder, auto-detects the "balance but sequence 0" registration bug
  and runs the documented local fallback, and binds internal ports
  (26657/9100/9200/5050/8080) to 127.0.0.1.

## Build

Requires Node.js 18+.

```bash
npm install
npm start            # run in development
npm run dist         # build the installer for THIS OS into dist/
npm run dist:all     # mac + windows + linux (best run on macOS, or per-OS in CI)
```

Outputs in `dist/`: `.dmg` (macOS x64+arm64), `.exe` NSIS installer (Windows),
`.AppImage` + `.deb` (Linux). Upload those to your website and link them from
your guide page.

### Code signing (recommended before public release)

Unsigned apps trigger OS warnings (macOS Gatekeeper, Windows SmartScreen).
For a smooth non-technical-user experience, sign the builds:
- macOS: an Apple Developer ID + notarization (electron-builder does this with
  `CSC_LINK`/`APPLE_ID` env vars).
- Windows: an OV/EV code-signing certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`).
Until then, add a short "how to open an unsigned app" note next to your
download links.

## Keeping it current when Gonka changes

All Gonka-specific facts live in **`src/knowledge.js`** (seed nodes, ports,
API paths, DNS providers, requirements, docs links, chain ID, minimum CLI
version). Edit it and re-release — nothing else needs to change.

Better: host a JSON file on your own website with any subset of those fields
and set `REMOTE_MANIFEST_URL` at the top of `src/knowledge.js`. The app
fetches and merges it at every launch, so most doc changes need **no app
re-release at all**.

## Things to verify before you publish

1. **DNS provider variable names.** Cloudflare (`CF_DNS_API_TOKEN`) is
   confirmed from the docs. Route 53 / Google Cloud / Azure / DigitalOcean /
   Hetzner entries in `src/knowledge.js` use the certificate issuer's
   conventional names — click through the live gonka.ai questionnaire once for
   each and correct any mismatches (2-minute edit per provider).
2. **Manual SSL certificates** (user supplies their own cert) is not automated
   in v1 — the wizard offers HTTP and auto-issued HTTPS. Add the manual branch
   later if your users ask for it.
3. This v1 targets the **single-machine quickstart** (network node + ML node
   on one server). Multi-machine setups (docs "Case 2") are out of scope.
4. Do one end-to-end test on a throwaway rented GPU box before publishing —
   the wizard was written against the docs but the network moves fast.

## Project layout

```
main.js                  Electron main process — IPC wiring
preload.js               Safe bridge to the renderer
src/knowledge.js         ★ All Gonka facts (edit this when docs change)
src/executor/index.js    Local + SSH command drivers (WSL support on Windows)
src/services/scan.js     Server health check
src/services/fixes.js    One-click repairs (Docker, NVIDIA toolkit, tools…)
src/services/keys.js     Cold-key ops — LOCAL machine only; CLI auto-download
src/services/configgen.js config.env generation, node-config ranking
src/services/deploy.js   Server orchestration: clone→harden→launch→register
src/services/netdata.js  Live network reads: models, params, collateral math
renderer/                The wizard UI (vanilla JS, no build step)
```

## Security notes

- Passphrases and SSH credentials are held in memory only, passed to
  processes via stdin with shell escaping, and masked in previews.
- No command runs on the user's server without either being part of the
  documented launch sequence or being shown verbatim in a confirmation dialog
  (all "Fix" actions).
- The renderer runs with `contextIsolation` and no `nodeIntegration`; all
  privileged work happens in the main process behind a typed IPC bridge.
