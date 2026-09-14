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
- PM2 (optional, for service management)

The bundled installer can prepare the Chinachu runtime, Node.js dependencies,
FFmpeg / ffprobe, and required runtime files as needed.

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
