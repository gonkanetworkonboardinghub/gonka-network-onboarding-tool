# The Gonka Network Onboarding Tool (GNOT)

An app for Windows and macOS from [The Gonka Network Onboarding Hub](https://thegonkanetworkonboardinghub.com) that makes taking part in the Gonka network easy. It costs nothing to use, and it never asks for your money or holds any.

- **Gonka Host Setup** takes a GPU server from bare metal to a registered Gonka node, step by step.
- **Gonka Host Monitor** is coming soon: check on a node you already run, what it earns and where that goes.
- **Gonka Vote** is coming soon: vote with your node, read what each proposal says and see how past ones ended.

## Source code

The full source code of the app is public for review at [gonkanetworkonboardinghub/gonka-network-onboarding-tool](https://github.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool), including the build and test workflow that produces these releases.

## Checking a build came from that source

Every file in these releases is built by GitHub's own runners from that public source, and GitHub signs each one with the repository, workflow and commit it came from. You don't have to take our word for any of it: with the [GitHub CLI](https://cli.github.com) installed, run

```bash
gh attestation verify Gonka-Network-Onboarding-Tool.exe --repo gonkanetworkonboardinghub/gonka-network-onboarding-tool
```

on any file you downloaded, putting in the name of the file you have (on a Mac that's the `.zip`). It prints the commit the file was built from, and fails if the file was changed by anyone, anywhere, after the build. The same check runs before anything is published here, so an installer built on somebody's laptop cannot end up in a release.

Two other things anyone can check: [`manifest.json`](manifest.json) publishes the SHA-256 of every build, and each release's files are built and tested by [the workflow in the open](https://github.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool/actions).

## Install

**Windows:** press the Windows key, type **PowerShell**, press Enter, then paste this and press Enter:

```powershell
irm https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/install.ps1 | iex
```

**Mac:** press Cmd + Space, type **Terminal**, press Enter, then paste this and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/install.sh | bash
```

The app installs and opens by itself in about a minute. After that it keeps itself up to date.

### What the command does

[`install.ps1`](install.ps1) (Windows) and [`install.sh`](install.sh) (Mac) do the same four things:

1. Read [`manifest.json`](manifest.json) to find the newest version.
2. Download that build from this repository's [Releases](../../releases/latest).
3. Check the file's SHA-256 against the value published in the manifest.
4. Install it.

On Windows the app installs for your user only, so no admin rights are needed. On a Mac it goes into Applications. Nothing else is downloaded or collected.

Prefer a regular download on Windows? Grab the installer from [Releases](../../releases/latest). Windows shows a "protected your PC" notice for downloaded installers it hasn't seen many times before; click **More info → Run anyway**.
