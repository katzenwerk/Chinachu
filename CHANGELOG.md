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
