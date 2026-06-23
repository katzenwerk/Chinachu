Chinachu [![Build Status](https://secure.travis-ci.org/Chinachu/Chinachu.svg)](http://travis-ci.org/Chinachu/Chinachu) [![tip for next commit](http://tip4commit.com/projects/689.svg)](http://tip4commit.com/projects/689)
========

- This software is no longer under development.
- Node.js v14 is the last supported version.
- Node.js v14 will become [END-OF-LIFE on 2023-04-30](https://nodejs.org/en/about/releases/).
- Please stop using this software by the above date and consider using a different software.

Stay in touch on Discord Community: <https://discord.gg/X7KU5W9>

<https://chinachu.moe/>



## Fork maintenance notes

This branch contains personal, unofficial maintenance changes for running Chinachu with Node.js 24.17.0.

Chinachu itself is no longer under active development, and the original project states that Node.js v14 is the last supported version. These changes are specific to this fork/branch, include experimental modifications, and do not imply official support by the upstream project.

### Changes in this branch

- Update bundled Node.js to 24.17.0
- Update backend, API, application scripts, package metadata, and sample configuration for Node.js 24
- Improve the web UI and usability
- Add or improve GUI-based configuration handling
- Improve channel selection by reducing direct use of hard-to-read channel IDs
- Expand recorded-program views toward recording history information
- Change the theme color and replace `gamma` branding with `thorn` to distinguish this heavily modified and experimental branch from the original gamma branch

### Notes

These changes are intended as a personal compatibility and usability update for this fork/branch. Some changes are experimental, and additional verification is recommended for recording, reservation, rule matching, and Web UI behavior before production use.
