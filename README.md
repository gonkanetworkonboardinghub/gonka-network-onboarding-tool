# The Gonka Network Onboarding Tool (GNOT)

The source code of GNOT, the free Windows and Mac app from
[The Gonka Network Onboarding Hub](https://thegonkanetworkonboardinghub.com)
that makes taking part in the Gonka network easier.

> **Source available for review.** This code is public so anyone can read it
> and verify what the app does. It is not open source: all rights are
> reserved. See [LICENSE](LICENSE).

## Get the app

Install it from the [Download page](https://thegonkanetworkonboardinghub.com/download).
Official builds, their checksums and the install scripts live in
[gonkanetworkonboardinghub/gonka-host-setup](https://github.com/gonkanetworkonboardinghub/gonka-host-setup).

## What's inside

GNOT opens on a home screen of tools:

- **Gonka Host Setup** takes a GPU server to a registered Gonka node, step by
  step: connect over SSH, health check and fixes, wallet, network and SSL,
  model and GPU configuration, model weights, launch and registration,
  collateral, and verification.
- **Gonka Host Monitor** is coming soon.
- **Gonka Vote** is coming soon.

## Verifying what the app does

Good places to start reading:

| What | Where |
| --- | --- |
| Your wallet | `src/services/wallet.js`, `src/services/keys.js` |
| Commands run on your server | `src/services/scan.js`, `src/services/fixes.js`, `src/services/deploy.js` |
| Network facts and endpoints | `src/knowledge.js`, `src/services/netdata.js` |
| Updates | `src/update.js`, `src/updater.js` |
| Install commands | `scripts/install.ps1`, `scripts/install.sh` |

The short version:

- **The wallet is created and used only on your own computer**, never on your
  server. Keys are kept in the same encrypted file-keyring format as Gonka's
  official `inferenced` tool, protected by your passphrase. The 24-word
  recovery phrase is shown once and never written to disk. Transactions are
  signed locally and sent to Gonka network nodes.
- **Everything the app runs on your server** goes over your SSH connection and
  appears in the Activity log.
- **No accounts, analytics or tracking.** The app talks to Gonka network nodes,
  GitHub (the update manifest, releases, and Gonka's official repository for
  supported configurations), GitHub Container Registry (to check node images)
  and your own server.
- **Updates and installs are verified.** The app and both install scripts
  check each download's SHA-256 against `manifest.json` before running it.

## Build and run it yourself

Requires Node.js 20 or newer.

```bash
npm ci
npm start                   # run the app from source
npx electron-builder --win  # Windows installer into dist/ (use --mac on a Mac)
```

Builds you make yourself won't be byte-identical to the official ones
(installers contain timestamps), but running from source lets you see exactly
what the code does.

## How releases are made

- `scripts/release.js` sets the version, builds the Windows installer, and
  pushes a version tag. The tag triggers `.github/workflows/build.yml` in this
  repository, which builds the Mac app on GitHub's machines and tests both
  platforms: the wallet against the official tool, the install scripts, the
  in-app updater, and updating from an older version. Its logs are public in
  the Actions tab.
- `scripts/publish.js` uploads the builds to the releases repository and
  updates `manifest.json` with each file's SHA-256, last, so a release only
  goes live once every file is in place and verified.

## Project layout

```
main.js, preload.js      Electron main process and the bridge to the UI
renderer/                The interface (home screen, Gonka Host Setup, 11 languages)
src/knowledge.js         Gonka network facts, overridable from manifest.json
src/executor/            Local and SSH command runners
src/services/            Health check, fixes, deployment, wallet, network data
src/update.js            Is this copy up to date?
src/updater.js           Download, verify and install an update
scripts/                 Release, publish and install scripts
.github/workflows/       Build and test (build.yml), app screenshots
website/README.md        README of the public releases repository
```

## License

Copyright (c) 2026 The Gonka Network Onboarding Hub. All rights reserved.
See [LICENSE](LICENSE).
