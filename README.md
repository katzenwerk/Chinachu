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

## Series dictionaries

Use **Settings → Series** to choose [しょぼいカレンダー](https://cal.syoboi.jp/) (`seriesUseSyobocal`, on by default), Bangumi (`bangumiEnabled`, off), and Wikipedia (`wikipediaEnabled`, off). Changes to these switches take effect after restarting the WUI. The Wikipedia collection start year (`wikipediaStartYear`, default 2000) takes effect in the acquisition worker after saving.

Turning off a dictionary stops its acquisition, automatic matching, supplementation, and searches for new manual links. Turning it back on resumes from the saved dictionary and progress, and the saved dictionary is also available offline. Bangumi and Wikipedia supplement each other when both are enabled. Existing manual corrections and original series remain available independently of these switches. Recording, reservations, and recording rules are unaffected.

- **Bangumi**. Work and episode data come from [Bangumi Archive](https://github.com/bangumi/Archive) and are used under Bangumi's [copyright statement and developer platform terms](https://bgm.tv/about/copyright). Entry data are covered by [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/deed.ja).
- **Japanese Wikipedia**. The dictionary uses the official Action and REST APIs of [Japanese Wikipedia](https://ja.wikipedia.org/). Its text is generally available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja), subject to the [Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/ja). The work dictionary links to the source article revision. When reusing, adapting, or redistributing copyrighted content, follow the applicable attribution, change-notice, and share-alike requirements.

Chinachu fetches and builds the dictionary locally. Chinachu Releases exclude the generated database, downloaded Archive, and HTML cache. External data licenses are separate from [Chinachu's MIT software license](LICENSE).

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
