# mpeg2toh264 vendored runtime

This directory contains the browser runtime used by Chinachu for recorded
MPEG-2 TS playback and live MPEG-2 TS playback.

## Upstream

Repository:

https://github.com/tsukumijima/mpeg2toh264

Vendored from commit:

69f2a47aa5bbeb8ffce57ecf5408eaa85a59d7d1

Packages confirmed at this checkout:

- @mpeg2toh264/player: 0.0.1
- aribb24.js: 2.0.25

Only `packages/player` is vendored from this fork. `packages/yadif` is not
vendored or imported; it is LGPL-2.1-or-later and intentionally excluded.

## Vendored files

The following files are copied without content modification.

- `packages/player/dist/index.js`
  -> `web/lib/mpeg2toh264/index.js`

- `packages/player/dist/assets/worker-CdUcgpWr.js`
  -> `web/lib/mpeg2toh264/assets/worker-CdUcgpWr.js`

- `node_modules/aribb24.js/dist/aribb24.mjs`
  -> `web/lib/mpeg2toh264/aribb24.js`

The aribb24 ES module is renamed from `.mjs` to `.js` so it is served by the
existing Chinachu WUI with the expected JavaScript MIME type.

The worker bundle contains the WASM module as a data URL and the picture-worker
program as an inline Blob source. No separate `.wasm` or picture-worker JavaScript
file is required at runtime. Source maps and `.d.ts` files are not runtime assets.

Runtime SHA-256:

- `index.js`: `caccf468a71e8b90de594653478c9cc2dcdad5d35e3c1543535425af31055009`
- `assets/worker-CdUcgpWr.js`: `5dc589fc9dff0e5ff5132a17004f40c578822ed4251778e5d539335c4672ccb8`

## Licenses

- `LICENSE`
  - copied from the mpeg2toh264 repository
  - identical to `packages/player/LICENSE`

- `LICENSE.aribb24`
  - copied from `node_modules/aribb24.js/LICENSE`

See `NOTICE.txt` for the vendored asset hashes and integration notes.

## Chinachu integration

Recorded playback:

- adapter: `../recorded-player.js`
- input: `/api/recorded/:id/file.m2ts`
- recorded file API supports HTTP byte ranges for seeking

Live playback:

- adapter: `../live-player.js`
- input: `/api/channel/:chid/watch.m2ts`
- the existing Chinachu/Mirakurun live stream is used directly

Both players use the vendored runtime in this directory.

No Vite development server, Python Range server, CDN, Rust toolchain, Cargo,
or external mpeg2toh264 checkout is required at Chinachu runtime.

## Updating the vendored runtime

1. Update or clone the upstream repository separately from Chinachu.

2. Record the exact upstream commit:

   `git rev-parse HEAD`

3. Confirm the upstream working tree is clean:

   `git status --short`

4. Build the upstream player according to its current build instructions.

5. Replace only the required runtime files in this directory.

6. Preserve the upstream license files and update them if upstream licensing
   or dependencies have changed.

7. Update this file and `NOTICE.txt` with:
   - upstream commit
   - package versions
   - generated worker filename
   - SHA-256 hashes

8. Verify the copied files against the build output with `cmp` or SHA-256.

9. Test at minimum:
   - recorded playback
   - recorded byte-range seeking
   - ARIB captions
   - live playback
   - live overlay open / close / reopen
   - live programme metadata rollover
   - fullscreen behavior
   - Chrome desktop
   - iPhone Safari where available

10. Run the relevant Chinachu tests, `npm run check`, JavaScript syntax checks,
    and `git diff --check` before committing.

Do not assume generated asset filenames remain unchanged between upstream
versions.
