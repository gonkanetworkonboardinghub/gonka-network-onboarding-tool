# Gonka Host Setup - one-line installer for Windows.
#
#   irm https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/install.ps1 | iex
#
# What it does, in order:
#   1. reads manifest.json from this repository to learn the newest version
#   2. downloads that version's installer from this repository's GitHub releases
#   3. checks the file's SHA-256 against the one published in manifest.json
#   4. runs the installer (installs for this user only, no admin rights) and
#      deletes the downloaded file
# Nothing else is downloaded, changed or collected.
#
# Kept ASCII-only on purpose: it is fetched as text and run with iex.

& {
  $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell's progress bar makes downloads crawl
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $manifestUrl = 'https://raw.githubusercontent.com/gonkanetworkonboardinghub/gonka-host-setup/main/manifest.json'

  function Say([string]$text, [string]$color = 'Gray') { Write-Host "  $text" -ForegroundColor $color }

  # curl.exe ships with Windows 10/11 and shows a progress bar; fall back to
  # Invoke-WebRequest where it's missing or blocked. Not in PowerShell ISE,
  # which paints a program's progress output as red error text.
  function Get-Installer([string]$url, [string]$dest) {
    if (-not $psISE -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
      & curl.exe -fL --progress-bar -o $dest $url
      if ($LASTEXITCODE -eq 0) { return }
      Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    }
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
  }

  Write-Host ''
  Say 'Gonka Host Setup installer' 'Cyan'

  try {
    $m = (Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -ErrorAction Stop).app
  } catch {
    Say "Couldn't reach GitHub to look up the latest version. Check your internet connection and run the command again." 'Red'
    return
  }
  if (-not $m -or -not $m.latest -or "$($m.sha256)" -notmatch '^[0-9a-fA-F]{64}$') {
    Say 'The release information is incomplete right now (probably mid-update). Try again in a few minutes.' 'Red'
    return
  }

  $dest = Join-Path $env:TEMP "Gonka-Host-Setup-$($m.latest).exe"
  $verified = $false
  Say "Downloading version $($m.latest)..."
  foreach ($url in @($m.installer, $m.url) | Where-Object { $_ }) {
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    try {
      Get-Installer $url $dest
    } catch {
      Say "That download address didn't work ($($_.Exception.Message)); trying the next one." 'Yellow'
      continue
    }
    # -eq on strings ignores case, so upper/lower-case hex both match.
    if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -eq $m.sha256) { $verified = $true; break }
    Say "That download didn't match the published checksum; trying the next address." 'Yellow'
  }
  if (-not $verified) {
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    Say "Couldn't get a verified copy of the installer, so nothing was installed. Try again in a few minutes." 'Red'
    return
  }
  Say 'Download verified (SHA-256 matches the published release).' 'Green'

  # Came straight from GitHub over HTTPS and matches the published checksum.
  # Clear any leftover "downloaded from the internet" flag on the file.
  Unblock-File -LiteralPath $dest

  Say 'Installing...'
  $p = Start-Process -FilePath $dest -PassThru
  $null = $p.Handle   # without this, Windows PowerShell can lose the exit code
  $p.WaitForExit()
  Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue

  if ($p.ExitCode -eq 0) {
    Say 'Done! Gonka Host Setup is opening now. You can close this window.' 'Green'
    Say 'Next time, open it from the Start menu. It keeps itself up to date.'
  } else {
    Say "The installer stopped with code $($p.ExitCode). Run the command again, or ask for help in Discord." 'Red'
  }
  Write-Host ''
}
