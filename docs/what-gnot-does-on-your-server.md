# What GNOT does on your server

Everything GNOT does on your server goes over your own SSH connection, as the
user you log in with. GNOT installs no agent of its own and leaves nothing of
its own running: once setup is done, what runs on the server is Gonka's own
node, started the way Gonka's guide starts it.

You can see every step as it happens. Each command appears in the app's
Activity log while it runs, and before a Fix installs anything, the app shows
you its exact commands and waits for you.

This page describes the current code. The exact commands are in the files
named under each part.

## What never goes to your server

- **Your wallet.** Its key, its 24 words and its passphrase are made and kept
  on your own computer (`src/services/wallet.js`, `src/services/keys.js`). The
  server only ever gets your wallet's *public* key, written into `config.env`
  as `ACCOUNT_PUBKEY`, as Gonka's guide does.
- **Your server password and your SSH key's passphrase.** They are used to
  connect and never saved, on your computer or anywhere else.
- **Anything about you.** The only thing the app reports is that it was
  opened: a random number made for that computer, the app's version, and
  whether it is Windows or Mac (see the README).

## 1. Health check: reads only

GNOT reads, and changes nothing:

- the operating system and CPU type, CPU cores, memory, and free space on
  each disk (to put model weights on your largest one)
- where Docker keeps its images, and the free space there
- whether git, curl, jq, Docker, Docker Compose, the NVIDIA Container Toolkit
  and the Hugging Face command line tool are installed
- the GPUs, the NVIDIA driver and CUDA version, and whether every GPU answers
  the driver (a GPU that is listed but doesn't answer is a faulty one)
- whether any of Gonka's internal ports (26657, 9100, 9200, 5050, 8080) are
  open to the internet
- the server's public address, by asking `api.ipify.org` once, to suggest the
  node's address

Code: `src/services/scan.js`.

## 2. Fixes: only when you press Fix

Each Fix shows its commands first. Fixes that install software need root or
`sudo` without a password; if your `sudo` asks for one, GNOT doesn't try: it
gives you the command to run yourself.

| Fix | What it does |
| --- | --- |
| git, curl, jq | installs the package with `apt-get` |
| Docker | runs Docker's official install script from `get.docker.com` |
| Docker permission | adds your user to the `docker` group (GNOT reconnects so it takes effect) |
| Docker Compose | installs `docker-compose-plugin` with `apt-get` |
| NVIDIA Container Toolkit | adds NVIDIA's package source and signing key, installs `nvidia-container-toolkit`, connects it to Docker and restarts Docker |
| Hugging Face tool | installs it with `pipx`, or into its own Python environment in your home folder (`~/.local/hfcli`, adding `python3-venv` first if it is missing) |
| NVIDIA driver too old | removes the installed NVIDIA packages, installs driver 580 (CUDA 13; 575 or 570 if 580 won't install), and **restarts the server** |
| Model cache folder | creates the folder on your largest disk |

Code: `src/services/fixes.js`.

## 3. Setup and launch: Gonka's own steps, in Gonka's order

1. **Gonka's official code.** Downloads Gonka's repository,
   `github.com/gonka-ai/gonka`, into `~/gonka`. If a node is already running
   from it, GNOT leaves it exactly as it is.
2. **Internal ports locked to the server itself.** In Gonka's two compose
   files, ports 9100, 9200, 8080 and 5050 are bound to `127.0.0.1`, as Gonka's
   guide recommends for a node on one machine.
3. **Your node's settings.** Writes two files into `~/gonka/deploy/join`:
   - `config.env`: the node's name and public address, your wallet's public
     key, a password made just for the server's own key (see below),
     where model weights go, and which public Gonka node to sync from. If you
     chose HTTPS with automatic certificates, the DNS provider key you typed
     in goes here too, for Gonka's own certificate service.
   - `node-config.json`: the model and how it uses your GPUs.
4. **GPU settings for real hardware.** In the ML node's compose file: names
   your GPUs one by one (instead of "all", which has dropped a healthy GPU on
   real servers), limits the container to computing (no graphics), and, if
   your driver is older than 580, uses the image Gonka names for older drivers.
5. **Room for the node's data.** If your largest disk isn't `/`, moves the
   node's growing data folders (`.inference`, `.inference-eth`, `.dapi`) there
   and links them back. The folder with the node's consensus key (`.tmkms`) is
   never moved.
6. **Gonka's software.** Downloads Gonka's container images.
7. **Only if downloads from inside Docker fail on your network** while the
   server itself downloads fine: adds the standard fix, one `iptables` rule
   that fits Docker's packets to your network (`TCPMSS`), plus a small
   systemd service, `gnot-container-mss`, that puts the rule back after a
   restart. On a server where Docker downloads fine, nothing is changed.
8. **The chain node.** Starts Gonka's `tmkms` and chain node. If the public
   Gonka node in `config.env` doesn't answer your server, GNOT switches to one
   that does.
9. **The server's key.** Creates the node's operational key inside Gonka's
   `api` container, once. If it already exists, it is reused, never replaced.
10. **Registration.** Registers your node from inside the `api` container
    (`inferenced register-new-participant`). In one known case where that
    fails, GNOT registers it from your computer, signed with your wallet.
11. **Permission for the server's key.** Signed on your computer with your
    wallet and sent to the network. The server takes no part in it.
12. **Only if GPU containers can't start** because of a known NVIDIA problem
    (a broken `/dev/dri` link step): rewrites NVIDIA's GPU file for
    containers without that step, and keeps a backup beside it
    (`*.gonka-backup`).
13. **Launch.** Starts everything (`docker compose ... up -d`) and downloads
    the model's weights from Hugging Face into the model cache folder.
14. **Collateral, if you choose it.** Signed on your computer with your
    wallet.

Code: `src/services/deploy.js`, `src/services/configgen.js`, `src/services/keys.js`.

## 4. Watching the node: reads only

Until the node is ready, and whenever you check on it, GNOT reads: which
containers are running, how far the chain node has synced, what the ML node
reports (its state, GPUs and weights), and the node's fee budget, all from
the node's own local addresses on the server.

## 5. Monitor/Vote, for your own node

- **A command line on your server.** It runs only what you type.
- **Safe shutdown, in Gonka's own steps:** switches your ML nodes off for the
  next Proof of Compute through the node's own admin address, checks that the
  last reward was claimed (and claims it if not), and only then stops the
  containers (`docker compose ... down`).

Code: `src/services/mynode.js`.

## What stays on the server afterwards

- Gonka's folder `~/gonka`, with `config.env` and `node-config.json`, Gonka's
  containers and their data, and the model weights.
- Anything a Fix installed: Docker, the NVIDIA Container Toolkit, the Hugging
  Face tool, a newer NVIDIA driver.
- Only if it was needed: the `gnot-container-mss` service and its script,
  `/usr/local/sbin/gnot-container-mss.sh`.

## The password in config.env

Gonka's node keeps the server's own key (the one it uses for its work) in an
encrypted file, and reads the password for that file from `config.env`, so it
can start by itself. That's how Gonka's own guide sets up every node.

GNOT makes that password at random, just for the server's key. You never need
to know it or type it, and it has nothing to do with your wallet: your
wallet's passphrase never goes to your server.

If the server already has a password in `config.env` (from an earlier setup),
GNOT keeps it as it is, because the server's key opens only with the password
it was made with.
