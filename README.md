# Chinachu thorn

`thorn` is an unofficial maintenance branch of Chinachu `gamma`, updated for modern Linux environments with a focus on stability and long-term maintainability.

See [CHANGELOG.md](CHANGELOG.md) for features and release history. Some features are experimental.

## Requirements

- Linux
- Access to a Mirakurun server (4.1.3 or later recommended)
- FFmpeg / ffprobe
- `libatomic` runtime library (package name varies by Linux distribution)

Node.js and npm do not need to be installed separately. Chinachu internally uses Node.js 26.13.0, automatically managed through Nave without modifying the system-wide Node.js installation.

## Installation

Chinachu requires access to a Mirakurun server, which can run on a separate machine.

```sh
git clone -b thorn https://github.com/katzenwerk/Chinachu.git
cd Chinachu
./chinachu installer full
```

The installer prepares dependencies and configures PM2 services and startup.

## Updating

### From thorn.31 onward

**Note:** Starting with **thorn.34**, Chinachu uses Node.js 26 and requires the `libatomic` runtime library. Before upgrading, ensure the appropriate package is installed:

- Debian / Ubuntu / Linux Mint: `libatomic1`
- RHEL / CentOS Stream / Rocky Linux / AlmaLinux: `libatomic`

Then update Chinachu:

```sh
./chinachu upgrade
```

The command handles Git updates, dependencies, and service management.

If the upgrade fails, try:

```sh
./chinachu installer full
```

### From gamma or thorn.30 and earlier

Back up your configuration and data before updating.

```sh
git fetch origin &&
git switch thorn &&
git merge --ff-only origin/thorn &&
./chinachu installer full
```

Compatibility with older configurations is not guaranteed. Some settings and recording history may require migration.

For advanced runtime management, see [Node.js 26 migration and technical details](docs/node26-performance.md).

## Network access and authentication

Chinachu is intended for private or access-controlled networks. Direct Internet exposure is not recommended.

Optional administrator authentication and TOTP-based two-factor authentication (2FA) are available.

To configure authentication:

```sh
./chinachu auth setup
```

Then enable authentication under **設定 → ログイン認証**.

To disable authentication:

```sh
./chinachu auth disable-totp
./chinachu auth disable-auth
```
