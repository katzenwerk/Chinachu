# Chinachu thorn

`thorn` is an unofficial maintenance branch based on Chinachu `gamma`, updated for modern Linux environments and Node.js 26.13.0, with a focus on long-term operation and maintainability.

See [CHANGELOG.md](CHANGELOG.md) for features and release history. Some features are experimental and may differ from upstream `gamma`.

## Requirements

- Linux
- Node.js 26.13.0 (26.x), npm 11.19+ within 11.x, and libatomic1 on Ubuntu/Mint
- Mirakurun server (4.1.3 or later recommended)
- FFmpeg / ffprobe
- PM2 (installed for Full service setup)

## Installation

Set up Mirakurun first, then install the `thorn` branch:

```sh
git clone -b thorn https://github.com/katzenwerk/Chinachu.git
cd Chinachu
./chinachu installer full
```

Full installation builds dependencies and configures Local PM2/startup, requesting sudo for systemd changes. Existing Local/Root management is repaired in place. Individual installer commands remain available for custom service management.

Node installation uses official binaries by default. Failed downloads or extraction never start a source build automatically. Explicitly opt in with `./chinachu installer node --allow-source-build` (also supported by full and upgrade). The `node-prepare 26.13.0` installer command prepares Node without switching links. Set `CHINACHU_INSTALLER_PROFILE=0` to disable stage resource metrics.

For a planned cutover, `./chinachu installer dependencies-prepare` builds locked dependencies in isolation using the target Node/npm without replacing live modules. Its stdout is the prepared directory; progress goes to stderr. After verifying recordings and stopping the selected Chinachu services, use `./chinachu installer dependencies-publish <prepared-dir>` to replace the old modules with the prepared tree. Old runtime/dependency backups are not generated. Changed manifests or an unknown/running service state block publication. Prepare Node first; publication errors stop the update. Preparation and publication do not start services.

Use `./chinachu runtime-check` for read-only runtime/PM2 diagnosis; explicitly use sudo to include Root PM2. Exit 2 means issues found; 1 means diagnosis failed. No registration, save or startup change is performed. Review active, dump.pm2, dump.pm2.bak and startup before reboot; preserve saved-only and non-Chinachu entries.

See [Node 26 migration, benchmarks and acceptance](docs/node26-performance.md) for measured results and the current migration procedure. Runtime repair switches runtime links, PM2 configuration, systemd and saved state to Node 26, removes Chinachu-managed Node 24, then starts and verifies services on Node 26. Service startup success is not a prerequisite for removing Node 24. No Node 24 backup or rollback is provided.

The [historical cutover record](docs/node26-cutover.md) records an intermediate migration stage, not the current operating procedure. Ordinary source updates restart only existing Chinachu registrations and pin their interpreter to the repository's `.nave/node`, and put `.nave` first in their PATH. Runtime repair rebuilds an outdated daemon/startup; this temporarily stops other applications and modules in the selected PM2 manager too. Their unrelated settings and saved-only entries are preserved without an unconditional `pm2 save`. Explicit Node 24 references in Chinachu/PM2 settings are migrated; references in other services are reported for resolution without changing those services. Run `sudo ./chinachu service runtime-repair local` (or `root` for the existing Root manager) to apply the same repair without a Git update. Already consistent environments are not rebuilt. System Node and unrelated PM2 managers are unchanged. With no Chinachu PM2 registration, Upgrade still prepares/verifies Node 26, npm and dependencies and removes the old managed Node 24, without registering PM2. Runtime work precedes skipping source updates for a dirty tree or an unchanged upstream. `upgrade --allow-source-build` also passes the explicit build permission through runtime repair and sudo.

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

Full repairs the existing PM2 manager and startup runtime after installation. It preserves the selected Local/Root manager and unrelated process settings.

For gamma and older thorn releases, full compatibility is not guaranteed. Some settings may require reconfiguration, and preserving older recording history requires a separate initial `match.json` build.

thorn.30 can update directly to the current thorn release using this procedure; intermediate thorn releases are not required. Use the updated installer after the Git update rather than the old thorn.30 updater.

Review local changes and untracked files before updating. Resolve conflicting paths individually; do not delete local files to force the update through.

Before rolling back to an older Operator, finish pending history recovery and confirm that `data/recording.json` is empty after stopping Operator. Older Operators may clear that file at startup. Keep current ledgers; restoring all data from an older backup can discard newer recordings and reservation changes.

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
