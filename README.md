# Chinachu thorn

`thorn` is an unofficial maintenance branch based on Chinachu `gamma`, updated for modern Linux environments and Node.js 24, with a focus on long-term operation and maintainability.

See [CHANGELOG.md](CHANGELOG.md) for features and release history. Some features are experimental and may differ from upstream `gamma`.

## Requirements

- Linux
- Node.js 24.x and npm
- Mirakurun server (4.1.3 or later recommended)
- FFmpeg / ffprobe
- PM2 (optional, for service management)

## Installation

Set up Mirakurun first, then install the `thorn` branch:

```sh
git clone -b thorn https://github.com/katzenwerk/Chinachu.git
cd Chinachu
./chinachu installer full
```

Follow the installer prompts for dependencies and optional PM2 service setup.

## Updating

### From thorn.31 onward

```sh
./chinachu upgrade
```

Run with a clean working tree and a configured upstream branch. The upgrade command handles Git updates, recording checks, and service management. No manual `git pull` is required.

### From gamma or thorn.30 and earlier

Back up your configuration and data, then stop Chinachu services after checking for active or upcoming recordings.

```sh
git fetch origin &&
git switch thorn &&
git merge --ff-only origin/thorn &&
./chinachu installer full
```

For existing PM2 installations, choose **No** when prompted for service setup. Restart the services after installation and any required migration.

For gamma and older thorn releases, full compatibility is not guaranteed. Some settings may require reconfiguration, and preserving older recording history requires a separate initial `match.json` build.

thorn.30 can update directly to thorn.32 using this procedure; an intermediate thorn.31 installation is not required. Use the updated installer after the Git update rather than the old thorn.30 updater.

Review local changes and untracked files before updating. Resolve conflicting paths individually; do not delete local files to force the update through.

Before rolling back to an older Operator, finish pending history recovery and confirm that `data/recording.json` is empty after stopping Operator. Older Operators may clear that file at startup. Keep current ledgers; restoring all data from an older backup can discard newer recordings and reservation changes.

## Manual TS Analyzer

Run from the Chinachu directory with Node.js 24 available as `node` in your shell:

```sh
./tools/ts-analyzer --help
```

Pass one or more explicit TS file paths for a read-only analysis. The default output shows packet-error events, PCR time-gap candidates, and available TOT clock information; use `--summary`, `--events`, or `--json` to select another output format. This is a manually invoked tool. PCR gaps and CC errors alone do not establish missing video or its cause.

## Network access and authentication

Chinachu is intended for use on private or access-controlled networks. Direct exposure of the WUI to the Internet is not recommended.

Optional administrator authentication and TOTP-based two-factor authentication (2FA) are available, but they do not guarantee security or replace proper network protection.

Legacy `config.json` authentication settings are not compatible. To configure authentication, run the following as the Linux user running the WUI:

```sh
./chinachu auth setup
```

Then enable login authentication and optionally configure 2FA under **設定 → ログイン認証**.

To disable 2FA or authentication locally:

```sh
./chinachu auth disable-totp
./chinachu auth disable-auth
```
