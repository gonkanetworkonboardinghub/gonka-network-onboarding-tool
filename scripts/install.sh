#!/bin/bash
# The Gonka Network Onboarding Tool - one-line installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/install.sh | bash
#
# What it does, in order:
#   1. reads manifest.json from this repository to learn the newest Mac version
#   2. downloads that version for this Mac's chip (Apple silicon or Intel)
#   3. checks the file's SHA-256 against the one published in manifest.json
#   4. puts The Gonka Network Onboarding Tool in Applications and opens it
# Nothing else is downloaded, changed or collected, and no password is asked.
#
# Everything lives inside main(), called on the last line: when this arrives
# through a pipe, a cut-off download can't run half a script.

set -u

MANIFEST_URL="https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/manifest.json"
APP_NAME="The Gonka Network Onboarding Tool"

say()  { printf '  %s\n' "$*"; }
good() { printf '  \033[32m%s\033[0m\n' "$*"; }
fail() { printf '  \033[31m%s\033[0m\n\n' "$*"; exit 1; }

# One value out of the manifest, via macOS's built-in JavaScript, so jq or
# Python never have to be installed first.
json_get() {
  /usr/bin/osascript -l JavaScript -e '
    function run(argv) {
      var v = JSON.parse(argv[0]);
      argv[1].split(".").forEach(function (k) { v = (v === null || v === undefined) ? undefined : v[k]; });
      return (v === null || v === undefined) ? "" : String(v);
    }' "$1" "$2" </dev/null 2>/dev/null
}

main() {
  printf '\n'
  say "$APP_NAME installer"

  [ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, use the PowerShell command from the download page."

  local arch
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64)
      # A Terminal running under Rosetta reports x86_64 on Apple silicon; ask the hardware.
      if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then arch=arm64; else arch=x64; fi ;;
    *) fail "This Mac's processor ($(uname -m)) isn't supported." ;;
  esac

  local manifest version url sha
  manifest="$(/usr/bin/curl -fsSL "$MANIFEST_URL" </dev/null)" \
    || fail "Couldn't reach GitHub to look up the latest version. Check your internet connection and run the command again."
  version="$(json_get "$manifest" app.mac.latest)"
  url="$(json_get "$manifest" "app.mac.$arch.url")"
  sha="$(json_get "$manifest" "app.mac.$arch.sha256" | tr 'A-F' 'a-f')"
  if [ -z "$version" ] || [ -z "$url" ] || ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
    fail "The Mac release information is incomplete right now (probably mid-update). Try again in a few minutes."
  fi

  # Global, not local: the EXIT trap runs after main has returned.
  work="$(/usr/bin/mktemp -d -t gonka-host-setup)" || fail "Couldn't create a temporary folder."
  trap 'rm -rf "$work"' EXIT

  if [ "$arch" = arm64 ]; then say "Downloading version $version for Apple silicon..."; else say "Downloading version $version for Intel..."; fi
  /usr/bin/curl -fL --progress-bar -o "$work/app.zip" "$url" </dev/null \
    || fail "The download didn't work. Nothing was installed. Try again in a few minutes."
  [ "$(/usr/bin/shasum -a 256 "$work/app.zip" | awk '{print $1}')" = "$sha" ] \
    || fail "The download didn't match the published checksum, so nothing was installed. Try again in a few minutes."
  good "Download verified (SHA-256 matches the published release)."

  /usr/bin/ditto -x -k "$work/app.zip" "$work/unpacked" || fail "Couldn't unpack the download."
  [ -d "$work/unpacked/$APP_NAME.app" ] || fail "The download doesn't contain the app."

  # /Applications for most people (admins can write there without a
  # password); a personal Applications folder otherwise.
  local dest=/Applications
  if [ ! -w "$dest" ]; then dest="$HOME/Applications"; mkdir -p "$dest" || fail "Couldn't create $dest."; fi

  # A running copy has to close before it can be replaced. Ask it first, in
  # the background: its "Close the setup wizard?" prompt can hold the quit
  # (and osascript would wait on it), so after a few seconds force it. The
  # server keeps running either way, and the app resumes where it was.
  if /usr/bin/pgrep -f "$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1; then
    say "Closing the running copy of $APP_NAME..."
    /usr/bin/osascript -e "tell application \"$APP_NAME\" to quit" </dev/null >/dev/null 2>&1 &
    local i
    for i in $(seq 1 10); do /usr/bin/pgrep -f "$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.5; done
    /usr/bin/pkill -9 -f "$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || true
    for i in $(seq 1 10); do /usr/bin/pgrep -f "$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.5; done
  fi

  say "Installing into $dest..."
  rm -rf "$dest/$APP_NAME.app" || fail "Couldn't remove the old copy in $dest."
  /usr/bin/ditto "$work/unpacked/$APP_NAME.app" "$dest/$APP_NAME.app" || fail "Couldn't copy the app into $dest."
  # Came straight from GitHub over HTTPS and matches the published checksum.
  /usr/bin/xattr -dr com.apple.quarantine "$dest/$APP_NAME.app" 2>/dev/null || true

  /usr/bin/open "$dest/$APP_NAME.app" </dev/null || fail "Installed, but couldn't open it. Open $APP_NAME from $dest."
  good "Done! $APP_NAME is opening now. You can close this window."
  say "Next time, open it from Applications or Launchpad. It keeps itself up to date."
  printf '\n'
}

main "$@"
