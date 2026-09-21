# Chinachu thorn

`thorn` is an unofficial maintenance branch based on Chinachu `gamma`,
updated for current Linux environments, Node.js 24, and continued usability.

This unofficial fork includes compatibility, installer, Web UI, recording, and
operational updates for current Node.js and Mirakurun environments. Some changes
are experimental and should be verified before production use.

Some internal behavior and operational details differ from upstream `gamma`.

For release history and notable changes, see
[CHANGELOG.md](CHANGELOG.md).

## Requirements

- Linux
- Node.js 24.x
- npm
- Mirakurun 4.1.3
- System FFmpeg / ffprobe
- PM2 (optional, for service management)

On Ubuntu and Linux Mint, FFmpeg and ffprobe are provided by the `ffmpeg` package.
If they are missing, the interactive installer offers to install the package.

## Installation

Make sure Mirakurun is installed, configured, and reachable from the Chinachu host.

Clone the `thorn` branch and run the installer:

```sh
git clone -b thorn https://github.com/katzenwerk/Chinachu.git
cd Chinachu
./chinachu installer
```

For a normal installation, use the recommended automatic installation option.

PM2 service setup is optional and can be configured from the installer.
To configure or review the PM2 service setup later, run:

```sh
sudo ./chinachu service setup
```

## Updating

### From thorn.20 or later

Update to the latest `thorn` release and run the installer again:

```sh
git pull --ff-only
./chinachu installer
```

Use the recommended automatic installation option and follow any migration prompts.

### From gamma or older releases

A fresh installation is recommended.
