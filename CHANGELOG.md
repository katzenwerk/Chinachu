# Chinachu 0.10.7-thorn.37

## Recording Files and Organization

- Add an optional `【録画中】` filename prefix, disabled by default, and remove it after recording completion with recovery support for interrupted finalization. Do not combine it with equivalent post-recording rename commands.
- Add optional automatic organization of completed recordings into existing subfolders directly beneath the recording destination, using filename, confirmed series title, and recording history in a configurable priority order.
- Keep automatic folder organization disabled by default. Do not create folders or move files between recording destinations.
- Correct recorded-results CSV path resolution after recording-file relocation.

## Recording Control

- Add global and per-rule recording-boundary priority settings to choose whether an incoming recording's start or an existing recording's end takes precedence during tuner handoff. Retain compatibility with legacy `allowEndLack` settings.
- Send CLI recording-stop requests directly to Operator over IPC instead of rewriting `recording.json`, preserving the reservation-skip update for rule-based recordings.

## Match Ledger and Cleaner

- Stop storing recording-file paths in `match.json` during matching, v2 conversion, maintenance, Cleaner, and deletion-history updates. Resolve file locations from `recorded.json` for recording details, CSV, maintenance, TS analysis registration, Cleaner, and file deletion.
- Keep recording IDs, canonical programme keys, rule associations, and missing/deleted history in match. Continue accepting legacy path-bearing entries, but do not use their paths to locate files or reconstruct match-only history. Retain separate TS analysis file fingerprints.
- Tighten recording-ID and canonical-key matching to prevent one recording from inheriting another recording's path, analysis, or missing-file state. Correct Cleaner removal and repair targeting so another ledger row sharing the programme key is not altered, while retaining explicit history cleanup and verified file restoration.

## Web UI and Post-processing

- Preserve program-detail scroll positions and unchanged content during background refreshes. Keep existing details visible if a refresh fails, showing the error without replacing the dialog.
- Reduce disruptive redraws and scroll resets during background updates in Next WUI programme and status views.
- Expand the Task monitor with running and waiting tasks, programme links and hover previews, and up to 20 recent completions. Avoid unnecessary redraws during periodic updates.
- Expand saved TS analysis details, including CC samples and PCR gap context, and refine automatic-analysis progress, results, and hover controls. Label CC anomalies in saved-TS hover warnings as `DROP疑い` (suspected drops) without changing the underlying analysis.
- Improve recorded-result warning presentation, distinguishing explicitly deleted recordings from missing-file conditions and showing early recording-end timing when available.
- Fix shared hover-popup closing and pointer-transition behavior so previews do not remain visible after leaving their targets.

## Series Management (BETA)

- Extend dictionary matching to consider both broadcast and full titles, including formal titles embedded within programme names, while checking ambiguity before automatic confirmation.
- Add bulk association of selected programmes requiring review, with target revalidation before applying changes.
- Load series lists in batches of 25, automatically fetching more near the end of the visible list and offering a manual "Load more" control.
- Preserve existing series-list entries and visible positions across updates to reduce disruptive redraws.
- Improve bulk-association control accessibility while scrolling, and correct lingering additional-item hover indicators in series lists.
- Simplify Series navigation to "一覧" (List) and "要確認" (Needs Review), combining recorded and reserved series in a single list.

Series matching and bulk correction remain experimental and require validation with actual programme data.

## Upgrade and Runtime

- Improve Upgrade reporting of the current and target versions, local and Chinachu-managed Node.js environments, and runtime dependencies.
- Allow runtime verification or repair independently of whether a Git source update is needed.
- Require explicit confirmation before discarding tracked local changes, preserve untracked files, and stop non-interactive updates when that confirmation is required.

## Verification

- Refresh existing regression tests for match path removal, recording identity, and Cleaner history handling; improve diagnostics for an intermittent Operator recording-start test timeout without changing its timing.
- The last reported full `npm test` run passed 165 tests across 30 suites with no failures; subsequent WUI edits were not covered by that run.

# Chinachu 0.10.7-thorn.36

## Automatic Saved TS Analysis

- Add optional automatic analysis of completed TS files, selecting recent unanalyzed recordings from the recorded ledger without a separate persistent queue.
- Defer or interrupt automatic analysis for recording activity and upcoming recordings, with a configurable recording-count limit (default: 0) and pause/resume controls.
- Store completed and failed analysis results. Keep manual and automatic TS analysis jobs serialized, while allowing manual analysis during recording independently of automatic-analysis limits.

## Post-processing Monitor

- Add a Task tab to Services and Logs to show match, ffprobe, thumbnail, and TS analysis states, pending work, recent completions, and TS results.
- Display current TS analysis progress and remaining unanalyzed recordings.

## Web UI

- Add automatic TS analysis settings, compact analysis status on recording cards, and a recorded-results filter for DROP and TS anomalies.
- Reload the browser when a new WUI process is detected, refreshing the displayed version and client assets.

# Chinachu 0.10.7-thorn.35

## Thorn34 CHANGELOG entries

- Tame overly verbose CHANGELOG entries generated by Codex.

### Web UI

- Fixed program details incorrectly showing completed recordings as reserved when stale reservations remain.
- Prioritized existing recorded data and the latest file path without additional API requests.

# Chinachu 0.10.7-thorn.34

## Runtime and Installation

- Upgrade to Node.js 26.13.0 and Mirakurun Client 4.2.1. Node.js 26 requires the `libatomic` runtime library.
- Improve upgrade recovery and PM2 runtime migration, including startup configuration. Remove managed Node.js 24 after migration.

## Performance and TS Analysis

- Improve performance of Cleaner, Series dictionary searches, and TS analysis.
- Remove fixed SHA requirements from TS analysis while retaining compatibility with saved results.

## WUI and Recording Maintenance

- Restore Live viewing for currently broadcasting programmes and clear search text when switching pages.
- Improve recording maintenance status, error reporting, and saved TS analysis summaries.
- Reduce unnecessary access logs and repeated low-storage warnings.

# Chinachu 0.10.7-thorn.33

## Recording History and Cleaner

- Distinguish missing recording files, recording-ledger inconsistencies, and explicit deletions. Normal lists and details use saved match state without checking recording files.
- Let Cleaner retain history while recording confirmed file absence. Restore missing recordings through explicit searches and path repair; explicitly deleted recordings remain terminal.
- Keep mount and scan failures separate from confirmed absence, and preserve missing-file state across match and Series updates.

## Recording Maintenance and TS Analysis

- Add per-recording maintenance actions for duration probing, thumbnail generation, and saved-file TS analysis. Offer file search when an explicit operation discovers a missing file.
- Reuse Operator's serialized, low-priority post-processing controls, deferring or interrupting optional work to prioritize recording.
- Show completed saved TS analysis on recording cards, with expandable anomaly details and a compact, responsive maintenance dialog.
- Accept completed external TS Analyzer JSON through `POST /api/recorded/:id/analysis.json`, using existing API authentication and CSRF checks. Preserve existing completed results and avoid duplicate writes or reanalysis.
- Add thumbnail creation from the detail dialog when an image is missing. Deinterlace newly generated thumbnails without regenerating existing images automatically.

## Guide and WUI

- Use more of the available guide area, compact station headers, and add an experimental eight-day guide for a selected station while retaining saved display settings.
- Share program hover previews across guides, lists, timelines, and cards, with concise descriptions and placement that switches direction near screen edges.
- Make storage-card links filter rules, reservations, and recorded results by the selected destination, including empty results.
- Add calendar navigation to guides and reservation timelines, and show conflict notifications.
- Improve Series status and detail actions, remove duplicate manual-assignment controls, and add a single-image preview for currently broadcasting programs with recording-start guards.

## Reservation Updates

- Recalculate affected reservations after manual reservation, skip, cancellation, and new-rule operations using the same allocation logic as Scheduler.
- Detect concurrent rule and reservation changes before Scheduler publication, and preserve retryable history when reservation updates fail.

# Chinachu 0.10.7-thorn.32

This release reduces interference from recording post-processing and background updates, strengthens recording-history recovery, and adds a manual TS Analyzer. Improvements to DROP rates and resource usage still require observation under real recording loads.

## Recording Stability

- Run Operator match updates asynchronously and coalesce additional requests, allowing recording streams and timers to continue while matching runs.
- Save recording history under a shared lock against the latest data. Retry temporary lock contention and retain unfinished recording information for recovery after an Operator restart.
- Remove completed manual reservations asynchronously after history is saved, preserving the order of reservation removal and recording hooks.
- Serialize duration probes and thumbnails, limit FFmpeg threads, and run post-processing at low CPU priority. Avoid starting optional post-processing around recording transitions and resume queued work afterwards.
- Move Scheduler preflight calculations to a Worker. Release Scheduler execution state after launch failures without applying a successful-update receipt or processing termination events twice.

## Background Series Updates (Beta)

- Defer dictionary work at safe batch boundaries near recording transitions, releasing its database and lock before resuming saved progress.
- Move ProgLookup parsing and cache updates, and ChID generation, to Workers. Keep existing data usable during updates and preserve verified channel bindings.
- Recover the ChID update and notification path when ProgLookup has committed its cache but its Worker exits before reporting success.
- Move complete series generation off the WUI main thread. Split overview, series and attention details, and event APIs so the Next WUI does not repeatedly fetch the complete snapshot.
- Generate from captured inputs, publish completed results, and coalesce updates received during generation into the next rebuild. Keep the previous usable result if generation fails.
- Revalidate correction targets immediately before saving rather than rejecting changes solely because the display generation changed. Use a shared file lock and merge into the latest manual-correction state to avoid overwriting unrelated changes.
- Keep the hidden-series dialog open across status notifications and polling, and retain correction inputs while rechecking conflicts.

Live behavior, performance, and concurrent Worker writes still require validation.

## Manual TS Analyzer

- Added a manual TS Analyzer to check CC errors (suspected DROP) and PCR time gaps.
- Run `./tools/ts-analyzer FILE.ts` from the Chinachu directory; use `--help` for options.
- These findings do not establish the cause or amount of missing video.

## WUI Stability

- Fixed repeated WUI reconnections when login authentication is disabled and no authentication data file exists.

## Updating and Recovery

- thorn.30 uses the existing one-time manual Git update and the updated `./chinachu installer full`; an intermediate thorn.31 installation is not required. Check recordings and upcoming reservations before stopping services.
- Before rolling back to an older Operator, complete any pending history recovery and confirm that `recording.json` is empty. Older Operators may clear that file at startup. Preserve current ledgers rather than restoring all data from an older backup.

# Chinachu 0.10.7-thorn.31

This release introduces experimental Series management, optional WUI authentication, broadcast clock observation and adjustment support, and improvements to recording diagnostics, maintenance, and usability.

## Series (Beta)

- Added an experimental Series view that associates recordings and reservations by series and episode.
- Uses information from **しょぼいカレンダー** to assist title and episode matching. Results may be incomplete or require manual correction.
- Uses a local SQLite dictionary for external reference data alongside the existing JSON-based data. This integration remains experimental and can be disabled in Settings.

## Cleaner

- Improved Cleaner performance when processing large recording histories.
- Removed persistent backups created during Cleaner execution. If cleanup is interrupted by a process or system failure, history data may require manual recovery.

## WUI Authentication

- Added optional administrator password authentication for the WUI and related API and media endpoints, disabled by default.
- Added optional TOTP-based two-factor authentication (2FA), with QR code setup for authenticator apps such as Google Authenticator.
- Authentication and 2FA do not guarantee security. Direct Internet exposure is not recommended.
- Legacy `config.json` authentication settings are not migrated and require reconfiguration.
- External media clients without the WUI session cookie may not work while authentication is enabled.

To configure administrator authentication, run as the Linux user running the WUI:

```sh
./chinachu auth setup
```

Then enable login authentication and optionally configure 2FA under **設定 → ログイン認証**.

To disable 2FA or login authentication locally:

```sh
./chinachu auth disable-totp
./chinachu auth disable-auth
```

## Installer / Upgrade / PM2

- Added `./chinachu upgrade` for thorn.31 and later. It updates the repository, installs required components, and restarts Chinachu PM2 services when necessary. Manual `git pull` is not required.
- Upgrade checks for active recordings and upcoming reservations before interrupting services. It requires a clean Git working tree and a configured upstream branch.
- Improved the installer to reuse existing Node.js and dependencies when possible, reducing unnecessary installation work.
- Upgrading from `gamma` or thorn.30 and earlier requires a one-time manual Git update and `./chinachu installer full`.
- Removed legacy SysV init-script support. PM2 service setup is available through `./chinachu service setup`. If an upgrade fails, manual recovery may be required.

## Recording / DROP Diagnostics

- Improved recording recovery so eligible manual reservations can resume after a graceful Operator restart.
- Added `dropDetectionMode` to select DROP detection using Mirakurun's DROP WATCH, direct TS stream analysis, both, or neither (`mirakurun`, `ts`, `both`, `off`). The default remains `mirakurun`.
- Direct TS stream analysis is experimental. Its continuity-counter results have not matched `tsDropChkx64.exe` in testing, so they should be treated as diagnostic information rather than definitive DROP counts.
- Added recording-result details for TS stream analysis and detected errors.

## Broadcast Clock

- Added an optional feature to compare broadcast TDT/TOT time with the Chinachu server clock and display the time difference.
- Supports clock checking and optional adjustment through chrony. Adjustment requires manual configuration and authorization, including root crontab setup for scheduled execution when needed.
- Clock observation prioritizes recording activity and does not modify the system clock. Actual clock adjustment requires separate configuration.
- Primarily intended for offline environments where Internet time synchronization is unavailable. When clock adjustment is configured, it can help reduce recording timing errors caused by clock drift.
- Broadcast time may vary slightly between channels and is not necessarily more accurate than Internet-based NTP services such as those provided by NICT.

## Next WUI / Access

- Improved responsive layouts and navigation for smartphones and tablets.
- Added `wuiBlockGlobalAccess`, enabled by default, to restrict WUI access from global IP addresses. This does not replace proper network protection, and reverse proxies may affect source IP detection.
- Improved programme details, title and episode display, search behavior, and Settings organization.
- Restored the "Record Now" action for programmes already on air.

# Chinachu 0.10.7-thorn.30

This planned release replaces the legacy WUI with the Next WUI, introduces the
compact match v2 history format, and expands recording, storage, and ledger
maintenance while preserving the existing recording and reservation workflows.

## Highlights

- Replaced the legacy `web/` application with the Next WUI as the default WUI.
- Added match v2 history, recorded-result reconciliation, and guarded ledger cleanup.
- Expanded filesystem-aware storage protection and Low Storage handling.
- Added recording thumbnails, result history, bitrate statistics, and optional
  monthly CSV output.

## Next WUI

- Added Home, programme guide, search, reservations, recording, recorded results,
  rules, Storage, logs, settings, and Cleaner views with responsive layouts.
- Added shared programme details, recording and history states, rule and
  reservation associations, and context-sensitive actions.
- Uses Socket.IO 4 notifications with connection monitoring and recovery status.
- Integrated the existing guarded service controls into the Next WUI. They remain
  limited to the Chinachu Operator and WUI and do not operate on Mirakurun or
  unrelated PM2 applications.

## Recording, Reservations, and Match History

- Added match v2 with the canonical `channel.id|start|seconds` key and compact
  programme, reservation, recording, and deletion summaries.
- Added `recorded-missing` reconciliation, including safe recovery when the same
  recording returns to `recorded.json` and Cleaner handling based on inspected
  recording locations.
- Added collision-resistant recorded IDs while retaining programme identity and
  recording-path compatibility.
- Preserved stable `ruleUid` associations and strengthened rule and reservation
  locking, atomic persistence, conflict handling, and action validation.
- Added queued recorded-thumbnail generation and best-effort bitrate statistics
  after completed recordings, and improved Next WUI use of existing
  recorded-duration metadata.
- Added optional immutable monthly recording-result CSV files for finalized
  recorded, missed, skipped, and interrupted outcomes.

## Storage and Cleaner

- Monitors configured recording destinations by filesystem and keeps ordinary
  WUI reads snapshot-based instead of scanning recording disks.
- Added opt-in protection against creating recordings on the system root
  filesystem, alongside existing expected-mount checks.
- Low Storage now supports `stop-new`, `stop`, and `remove`. Recursive removal is
  restricted to eligible TS files on the affected filesystem and revalidates
  symlinks, mount boundaries, active outputs, and file identity before deletion.
- Added Cleaner preview and apply workflows for recording-path repair and
  approved history cleanup, with source revalidation, ledger locking, atomic
  writes, a transaction manifest, and rollback for catchable partial failures.
- Cleaner ledger cleanup does not delete or move recording files. It treats
  ledger history, stored thumbnails, and recording files as separate resources.

## Maintenance

- Added Next WUI configuration persistence, historical log viewing, and runtime
  connection diagnostics.
- Rejects unsupported rule and reservation actions before invoking their CLI paths.
- Moved transient PID and IPC files into a private runtime directory and removed
  obsolete startup and compatibility code.
- Extended `npm run check` to syntax-check first-party Next WUI ES modules while
  excluding vendored and sample code.
- Consolidated duplicate and obsolete permanent tests. The current suite passes
  155 tests with no failures or skips.

## Upgrade Notes

### WUI paths

- The legacy `web/` WUI has been removed. `/` now serves the Next WUI.
- `/next/` remains available and serves the same Next WUI, not a parallel legacy
  or preview application.

### Match v2 conversion

- Operator startup validates `data/match.json` and converts legacy match entries
  to v2 before normal recording operation begins.
- When conversion is required, the original file is preserved as
  `data/match.json.v1-backup`. An existing backup is reused only when it matches
  the current legacy source.
- Conversion, validation, backup, or write failure is fatal and stops Operator
  startup instead of continuing with an uncertain match ledger.
- V2 removes legacy duplicate metadata and snapshots while retaining canonical
  identity, status, dates, recording IDs and paths, and deletion history needed
  by current consumers.

### Runtime directory

- Scheduler PID and local IPC sockets now use `.runtime/` below the Chinachu root
  by default. The directory is created for the runtime user with mode `0700`.
- `CHINACHU_RUNTIME_DIR` can select another location. Its value must be an
  absolute path owned by the runtime user and must permit creation of the required
  PID and Unix-socket paths.

### Configuration defaults

- `recordedStorage.protectRootFilesystem` and each additional destination's
  `storage.protectRootFilesystem` default to `false` for upgrade compatibility.
  Enabling the option makes unverifiable or root-filesystem destinations fail closed.
- `recordingResultCsvEnabled` defaults to `false`; existing history is not exported
  retroactively merely by upgrading.
- Valid `storageLowSpaceAction` values are `stop-new`, `stop`, and `remove`.
  Missing values, the legacy `none` value, and unknown values use the safe `stop`
  behavior without rewriting `config.json`. Existing valid `stop` and `remove`
  settings remain valid after the upgrade.

### Data cleanup and file deletion

- Cleaner removes or repairs approved ledger history and may remove associated
  generated thumbnails, but it does not delete, move, or rename TS recording files.
- Low Storage `remove` and an explicit recorded-file deletion can delete the
  physical recording file and then reconcile the related ledgers.
- `recorded-missing` means that recorded history currently lacks a matching
  `recorded.json` entry. It is not, by itself, proof that no physical file exists.
  With location checking enabled, Cleaner retains the history when the exact file
  is found; disabling location checking skips that rescue and follows the selected
  history-cleanup policy.

### Verification limits

- Automated syntax checks and the 155-test suite have completed successfully.
- Real Multi-HDD and Docker mount-failure scenarios, read-only filesystems, real
  PM2 service-control acceptance, Android / Fire TV / TV-class browsers, and
  long-duration or concurrent playback still require environment-specific testing.

# Chinachu 0.10.7-thorn.29

This release improves reservation reliability, filesystem-aware storage management, and WUI usability while updating runtime dependencies.

## Highlights

- Added atomic reservation persistence and ownership-aware locking to prevent concurrent update conflicts.
- Improved scheduler conflict detection and retry handling for reservation updates.
- Added filesystem-aware storage monitoring with per-filesystem Warning and Low protection.
- Reduced unnecessary HDD access during idle operation and WUI browsing.
- Added persistent storage snapshots, last-checked timestamps, and manual capacity refresh controls.
- Improved Storage WUI layout, status indicators, and mobile responsiveness.
- Updated Mirakurun client to 4.1.5 and Socket.IO to 4.8.4.
- Consolidated permanent regression tests and removed redundant test cases.

# Chinachu 0.10.7-thorn.28

This release adds browser playback for live and recorded MPEG-2 transport
streams, Safari-compatible FFmpeg HLS delivery, operational diagnostics, and
stable reservation-rule navigation.

## Highlights

- Added read-only Health diagnostics and a Status dashboard for Chinachu,
  runtime, PM2, Mirakurun, scheduler, recording, and data-file state.
- Added guarded PM2 service controls for the Chinachu Operator and WUI.
- Added `mpeg2toh264` browser playback for live and recorded MPEG-2 TS content.
- Added FFmpeg fMP4 HLS compatibility playback for Safari while retaining
  `mpeg2toh264` as the standard path on desktop non-Safari browsers.
- Added HTTP byte Range support for recorded files.
- Linked programmes and reservations to their source rules through stable
  `ruleUid` values and improved rule labels in programme views.

## Health / Service Control

- Added a read-only diagnostics API with a short process-local cache and manual
  refresh support in the Status dashboard.
- Reports observable runtime, PM2, Mirakurun, scheduler, recording, ffprobe,
  configuration, rule, and scheduler-state information without treating
  unavailable observations as healthy.
- Added guarded restart controls limited to `chinachu-operator` and
  `chinachu-wui`, with process-identity and active-recording safeguards.
- Service controls do not operate on Mirakurun or unrelated PM2 applications.

## Browser Playback

- Added vendored `mpeg2toh264` playback adapters for live and recorded MPEG-2
  TS streams, including ARIB caption rendering and recorded-file seeking.
- Added recorded-file HEAD and single byte Range handling with 206 and 416
  responses for browser playback.
- Added isolated FFmpeg fMP4 HLS sessions for live and recorded compatibility
  playback, including playlist, initialization segment, media segment, process,
  and cleanup lifecycle management.
- Safari can use FFmpeg HLS compatibility playback. Desktop non-Safari browsers
  keep `mpeg2toh264` as the standard path and do not normally offer FFmpeg HLS.
- Android, Fire TV, and TV-class browsers are not excluded solely because their
  platform is Linux-based.
- The completed MP4, faststart, and Range delivery path remains available as a
  compatibility and verification fallback rather than the primary initial
  playback path.

## Reservation Rules / WUI

- Programme and reservation views now resolve source rules by stable `ruleUid`
  instead of using a mutable rule-array index as identity.
- Added source-rule navigation and editing from programme views.
- Rule labels now show a one-based display number and a concise primary
  condition, while continuing to use `ruleUid` for identity after reordering.

## Maintenance

- Added a maintenance background document describing the thorn branch and its
  modernization context.

## Known Limitations

- Recorded FFmpeg HLS playback currently starts from the beginning and does not
  yet support seeking or restart from an arbitrary position.
- Android, Fire TV, and TV-class browser playback still requires device testing.
- Long recordings and multiple concurrent playback sessions still require
  performance and resource-usage evaluation.

# Chinachu 0.10.7-thorn.27

This release adds stable rule identity and preserves reservation-time rule and
recording destination metadata.

## Highlights

- Added stable `ruleUid` values that remain associated with rules across edits,
  deletion of other rules, and rule index changes, while retaining compatibility
  with legacy `ruleId` and index references.
- Reservations now carry rule identity and recording destination metadata through
  `reserves`, `reserves2`, and match history. Historical values are preserved
  instead of being inferred from current rules or recording destination mappings.
- Updated WUI rule and reservation associations to use stable rule identity,
  preventing legacy index-based reservations from being counted for an unrelated
  current rule. Index fallback remains available for legacy rules without a UID.
- Consolidated permanent tests by behavior and moved temporary rule UID migration
  tests out of the regular suite. The regular suite passed 137 tests across 30
  suites; the temporary migration tests passed 3/3.

# Chinachu 0.10.7-thorn.26

This release improves episode and subtitle parsing in the scheduler.

## Highlights

- Improved episode detection for single, multi-episode, and range notation.
- Improved subtitle extraction from program titles and descriptions.
- Reduced false episode detection from season numbers and similar title text.
- Preserved the original `fullTitle` for compatibility.
- Improved low-storage handling and related notification/history processing.

# Chinachu 0.10.7-thorn.25

This release improves scheduler synchronization with Mirakurun EPG updates
and reduces unnecessary periodic scheduler runs.

## Highlights

- Added scheduler synchronization with settled Mirakurun EPG gathering cycles.
- Added recovery for missed EPG cycle notifications.
- Added scheduler state and lightweight periodic preflight checks.
- Reduced unnecessary full scheduler runs while retaining the periodic path as a fallback.

# Chinachu 0.10.7-thorn.24

This release removes the bundled FFmpeg 4.1.4 dependency and improves preview
stream selection for current system FFmpeg environments.

## Highlights

- Removed the bundled FFmpeg 4.1.4 download and installation path.
- Updated the installer to use system-provided `ffmpeg` and `ffprobe`.
- Fixed preview generation when input stream index 0 is not a video stream.
- Added safer handling for legacy and unknown repository-local FFmpeg binaries.
- Expanded installer verification and regression coverage for FFmpeg handling.

## Preview

- Recording and recorded-program previews now select the first video stream
  with `0:v:0` instead of assuming that input stream index `0:0` is video.
- Fixed preview generation for transport streams where data, audio, or other
  non-video streams appear before the video stream.
- The change is compatible with both the previous bundled FFmpeg 4.1.4 and
  current system FFmpeg versions.
- This fixes a latent stream-selection assumption that became visible while
  validating migration away from the bundled FFmpeg 4.1.4.

## Installer / FFmpeg

- Removed the legacy FFmpeg 4.1.4 static archive download, architecture-specific
  archive selection, extraction, and repository-local installation path.
- Removed creation of the legacy `avconv` and `avprobe` compatibility aliases.
- Existing working system `ffmpeg` and `ffprobe` commands are used without
  modifying system packages.
- On Ubuntu and Linux Mint systems, the installer can offer to install the
  `ffmpeg` package when the required commands are missing.
- System package installation requires explicit user confirmation.
- The installer does not run `apt update`, upgrade, or autoremove operations as
  part of FFmpeg setup.
- Recognized legacy repository-local FFmpeg 4.1.4 binaries are removed only
  after system FFmpeg has been verified and the user explicitly confirms the
  migration.
- Unknown repository-local FFmpeg binaries are left unchanged and cause the
  installer stage to stop safely.
- Legacy cleanup is limited to `ffmpeg`, `ffprobe`, `avconv`, and `avprobe`;
  other files from the old static archive are not modified.

## Verification

- Installer verification now checks the resolved `ffmpeg` and `ffprobe`
  commands.
- Both commands must be executable and successfully return version information.
- Verification reports the resolved command paths and version information.
- Repository-local overrides are detected so they cannot silently shadow the
  intended system FFmpeg environment.

## Testing

- Added regression coverage for preview video-stream selection.
- Added installer coverage for existing system FFmpeg detection.
- Added coverage for package-installation decisions without invoking real APT,
  sudo, or network operations.
- Added coverage for legacy FFmpeg migration and unknown local binary protection.
- Added verification coverage for resolved `ffmpeg` and `ffprobe` commands.

# Chinachu 0.10.7-thorn.23

This release improves WUI performance when handling large match histories.

## Highlights

- Optimized match history loading for large `match.json` files.
- Added lightweight summary, list, and item access for match history.
- Added an in-memory WUI cache for parsed match history data.
- Reduced unnecessary transfer and parsing of the full match history.
- Stabilized asynchronous runtime tests.

## Match History / WUI

- Added summary mode for retrieving match status counts and recent completed entries without transferring the full history.
- Added list mode for loading a reduced representation of completed match history.
- Added item mode for retrieving a single full match record when opening program details.
- Updated the dashboard, recorded history list, and program detail views to use the lighter match APIs where appropriate.
- Added a process-local parsed `match.json` cache in the WUI.
- The cache is automatically reloaded when the source `match.json` changes.
- A previously valid cache is retained if a reload encounters invalid JSON.
- The original full `/api/match.json` response remains available for compatibility.

## Performance / Maintenance

- Large match histories no longer need to be fully transferred and parsed by the browser for routine dashboard, list, and detail operations.
- Approximately 4,000 match-history entries have been verified in the current production environment without issue.
- Around 6,000 entries may be used as a provisional maintenance guideline, but this is not a tested upper limit.
- WUI memory usage still increases as the match history grows because the parsed history is cached in memory.

## Testing

- Reduced timing dependencies in external notification process tests.
- Improved readiness handling for notification worker tests.
- Made temporary operator test cleanup more tolerant of short-lived filesystem races.
- Made recording-state polling tolerant of transient partial JSON reads during test execution.

# Chinachu 0.10.7-thorn.22

This release improves recorded-duration handling and PM2 service persistence.

## Highlights

- Added ffprobe-based recorded duration detection.
- Improved recorded duration display in the WUI.
- Fixed Local PM2 startup configuration so Chinachu can be restored automatically after an OS reboot.

## Installer / PM2

- Added verification and configuration of the Local PM2 systemd startup service.
- Fixed a case where `pm2 save` succeeded but Chinachu was not automatically restored after an OS reboot.
- Preserved the existing PM2 startup service during Chinachu cleanup so unrelated PM2 applications remain unaffected.

## Recording

- Added asynchronous ffprobe duration detection after recording completion.
- Stores measured duration as `recordedDurationSeconds`.
- ffprobe failures and timeouts do not prevent recording finalization.
- Recording completion commands are not delayed by duration probing.
- Improved handling of measured duration for uninterrupted and resumed recordings.

## WUI

- Recorded program details now prefer the measured file duration when available.
- Recorded lists now prefer the measured file duration over the scheduled recording duration.
- Head-cut estimation uses measured duration only for uninterrupted recordings.
- Existing recordings without measured duration retain the previous fallback behavior.
- Waits for private IPv4 availability during startup before starting the Open Server.
- Exits with an error if automatic host detection still fails after the startup wait, allowing PM2 to recover the service.

# Chinachu 0.10.7-thorn.21

This release focuses on compatibility with current Node.js and Mirakurun environments,
service management, WUI modernization, and recording reliability.

## Highlights

- Updated the runtime baseline for Node.js 24.
- Updated Mirakurun compatibility to 4.1.3.
- Improved installer and PM2 service setup for both current-user and legacy root-managed environments.
- Modernized the WUI server and Socket.IO integration.
- Improved recording recovery and shutdown behavior.
- Added a generic external notification command interface.
- Migrated CI from Travis CI to GitHub Actions.

## Installer / PM2

- Added a guided PM2 Service Setup flow.
- Added current-user PM2 operation as the recommended mode.
- Kept the legacy root-managed mode for existing environments.
- Added safer PM2 persistence handling and cleanup.
- Preserved unrelated PM2 applications, including existing Mirakurun processes.
- Added PM2 log rotation setup support.
- Improved runtime privilege handling and supplementary group initialization.

## WUI

- Consolidated WUI access around `wuiOpenServer`, `wuiOpenHost`, and `wuiOpenPort`.
- Updated Socket.IO support for the current 4.x release.
- Added safer automatic private IPv4 selection for the Open Server.
- Removed the built-in Basic authentication, TLS/mTLS, GeoIP/XFF access control,
  and mDNS advertisement paths.
- For remote exposure, authentication and transport security should be provided externally,
  such as through a VPN or reverse proxy.

## Mirakurun

- Updated Mirakurun to 4.1.3.
- Centralized Mirakurun endpoint handling for TCP and Unix socket configurations.
- Fixed DROP WATCH transport selection when using TCP endpoints.
- Preserved support for standard and legacy Unix socket endpoint formats.

## Recording

- Fixed a thorn.20 regression that prevented in-progress rule-based recordings
  from resuming after an operator restart.
- Preserved the recording path across graceful restart recovery.
- Improved handling of aborted preparations, interrupted streams, and recording retries.
- Improved recorded ID collision handling.
- Improved low-storage handling for active recordings and restart-pending recordings.

## Notifications

- Added `notificationCommand` as the preferred external notification interface.
- Notification events are passed as structured UTF-8 JSON through standard input.
- Added timeout and single-flight protection for notification processes.
- `storageLowSpaceCommand` remains available as a compatibility fallback.

## Compatibility / Maintenance

- Updated `dateformat` while preserving legacy recorded filename behavior.
- Consolidated dependency management around the root lockfile.
- Migrated tests to the built-in Node.js test runner.
- Replaced Travis CI with GitHub Actions.
