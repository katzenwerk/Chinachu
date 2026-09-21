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

The installer uses FFmpeg / ffprobe provided by the operating system. On Ubuntu
and Linux Mint, these commands are provided by the `ffmpeg` package. Existing
working system commands are used as-is; when either command is missing, the
interactive installer asks before running `apt-get install -- ffmpeg`.

Repository-local `usr/bin/ffmpeg` and `usr/bin/ffprobe` override the system
commands at runtime. After verifying the system commands, the installer can
remove the recognized legacy bundled FFmpeg 4.1.4 after explicit confirmation,
but it does not modify unknown local binaries.

## Installation

Make sure Mirakurun is installed, configured, and reachable from the Chinachu host.

Clone the `thorn` branch and run the installer:

```sh
git clone -b thorn https://github.com/katzenwerk/Chinachu.git
cd Chinachu
./chinachu installer
```

For a normal installation, use the recommended automatic installation option.

If needed, install PM2 separately and run:

```sh
sudo ./chinachu service setup
```
