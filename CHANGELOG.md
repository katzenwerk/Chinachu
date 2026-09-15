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
