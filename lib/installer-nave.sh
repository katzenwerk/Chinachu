#!/bin/bash
# Nave's checksum/cache functions are reused without patching Nave.
nave_script="$1" version="$2" mode="$3" action="$4"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
_TESTING_NAVE_NO_MAIN=1 . "$nave_script" || exit 1
unset _TESTING_NAVE_NO_MAIN
mkdir -p -- "$NAVE_ROOT" "$NAVE_SRC" || exit 1
profile () {
  if [ "$CHINACHU_INSTALLER_PROFILE" != 0 ] && command -v python3 >/dev/null 2>&1; then
    python3 "$(dirname -- "$0")/installer-profile.py" "$@"
  else
    shift; "$@"
  fi
}
if [ "$action" = download ]; then
  platform=$(osarch) || { echo "No official Node binary for this platform." >&2; exit 1; }
  get "v$version/node-v$version-$platform.tar.gz" -#Lf
  exit $?
fi
if [ "$mode" = --allow-source-build ]; then
  echo 'Explicitly allowed Nave source fallback (one build job).' >&2
  profile node-install-source-allowed bash "$nave_script" install "$version"
  exit $?
fi
[ -z "$mode" ] || { echo 'Unknown Node installation option.' >&2; exit 1; }
archive=$(profile node-download bash "$0" "$nave_script" "$version" '' download) || {
  echo "Official Node $version binary retrieval/checksum failed; source build was NOT started. Retry the download, or explicitly use --allow-source-build." >&2
  exit 1
}
target="$NAVE_ROOT/$version"
mkdir -p -- "$target" || exit 1
profile node-extract tar xzf "$archive" -C "$target" --strip-components 1 || {
  echo 'Official Node archive extraction failed; source build was NOT started.' >&2
  exit 1
}
