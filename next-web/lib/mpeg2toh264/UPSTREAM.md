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

The following files are copied from the build output. The player build includes
`chase-mode.patch` applied to the fixed upstream commit.

- `packages/player/dist/index.js`
  -> `next-web/lib/mpeg2toh264/index.js`

- `packages/player/dist/assets/worker-BUrAso_o.js`
  -> `next-web/lib/mpeg2toh264/assets/worker-BUrAso_o.js`

- `node_modules/aribb24.js/dist/aribb24.mjs`
  -> `next-web/lib/mpeg2toh264/aribb24.js`

The aribb24 ES module is renamed from `.mjs` to `.js` so it is served by the
existing Chinachu WUI with the expected JavaScript MIME type.

The worker bundle contains the WASM module as a data URL and the picture-worker
program as an inline Blob source. No separate `.wasm` or picture-worker JavaScript
file is required at runtime. Source maps and `.d.ts` files are not runtime assets.

Runtime SHA-256:

- `index.js`: `3e66661bc5b470fc295df7cc10370c13040d4f4d7d2b1e4cc249ff61d3af76f2`
- `assets/worker-BUrAso_o.js`: `4b5e7d4bf108baec1fb3bfab9f68ab38675bd28a74e38fc0161fe09ec51c3d48`

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

## Chinachu chase mode build

Apply `chase-mode.patch` to commit
`69f2a47aa5bbeb8ffce57ecf5408eaa85a59d7d1` in a separate source directory:

```sh
patch -p1 < /path/to/Chinachu/next-web/lib/mpeg2toh264/chase-mode.patch
npm ci --ignore-scripts
bash tools/build-wasm.sh
npm run build --workspace @mpeg2toh264/player
```

Build environment used: Node.js 24.22.2, npm 11.19.1, Rust 1.99.0,
wasm32-unknown-unknown, wasm-bindgen CLI 0.2.126. Use the upstream lockfiles;
no demo/yadif build or Chinachu dependency change is required.
Copy `packages/player/dist/index.js` and its referenced `dist/assets/worker-*.js`.
Do not edit the generated bundles. Hashes above identify the copied output;
they are not checked at runtime.

The patch changes source.ts, worker.ts, player.ts and protocol.ts only.
`chaseStatusUrl` enables the mode; omitting it keeps finite-file/live behavior.
Input is `/api/recording/:id/chase.m2ts`, with metadata at `chase.json`.
The API pins recording start and file identity without exposing file paths.
It serves finite ranges, including across same-filesystem renames. Replacing
an inode, including a copy to another filesystem, is rejected rather than joined.
No change is made to conversion, caption sources or Operator.
