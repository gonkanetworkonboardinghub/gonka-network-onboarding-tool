# The Gonka Network Onboarding Tool (GNOT)

A free app for Windows and macOS from [The Gonka Network Onboarding Hub](https://thegonkanetworkonboardinghub.com) that makes taking part in the Gonka network easy.

- **Gonka Host Setup** takes a GPU server from bare metal to a registered Gonka node, step by step.
- **Gonka Host Monitor** is coming soon: check on a node you already run, what it earns and where that goes.
- **Gonka Vote** is coming soon: vote with your node, read what each proposal says and see how past ones ended.

## Source code

The full source code of the app is public for review at [gonkanetworkonboardinghub/gonka-network-onboarding-tool](https://github.com/gonkanetworkonboardinghub/gonka-network-onboarding-tool), including the build and test workflow that produces these releases.

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
