#!/bin/bash

# Sourced by ./chinachu after it has entered the repository root.

service_setup_error () {
  printf '%sERROR:%s %s\n' "$INSTALLER_RED" "$INSTALLER_RESET" "$1" >&2
  return 1
}

service_setup_is_tty () {
  [ "$SERVICE_SETUP_FORCE_TTY" = true ] || [ -t 0 ]
}

service_setup_user_home () {
  getent passwd "$1" | awk -F: 'NR == 1 { print $6 }'
}

service_setup_origin_user () {
  local user
  if [ "$(id -u)" -eq 0 ]; then
    user="$SUDO_USER"
    [ -n "$user" ] && [ "$user" != root ] && id "$user" > /dev/null 2>&1 || return 1
  else
    user=$(id -un) || return 1
  fi
  printf '%s\n' "$user"
}

service_setup_pm2_as_user () {
  local user="$1" home
  shift
  home=$(service_setup_user_home "$user") || return 1
  [ -n "$home" ] || return 1
  if [ "$user" = "$(id -un)" ]; then
    env PM2_HOME="$home/.pm2" "$SERVICE_SETUP_PM2_BIN" "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    command -v runuser > /dev/null 2>&1 || return 1
    runuser -u "$user" -- env PM2_HOME="$home/.pm2" "$SERVICE_SETUP_PM2_BIN" "$@"
  else
    return 1
  fi
}

service_setup_pm2 () {
  service_setup_pm2_as_user "$SERVICE_SETUP_PM2_USER" "$@"
}

service_setup_pm2_daemon_active () {
  local user="$1" home pid_file pid
  home=$(service_setup_user_home "$user") || return 1
  pid_file="$home/.pm2/pm2.pid"
  if [ -r "$pid_file" ]; then
    read -r pid < "$pid_file"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
    return $?
  fi
  ps -eo user=,args= | awk -v user="$user" '$1 == user && /PM2 .*God Daemon/ { found=1 } END { exit !found }'
}

service_setup_json_has_chinachu () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.exit(list.some(x => x && (x.name === "chinachu-operator" || x.name === "chinachu-wui")) ? 0 : 1);
  '
}

service_setup_json_is_array () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    try {
      const value = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
      process.exit(Array.isArray(value) ? 0 : 1);
    } catch (_) { process.exit(1); }
  '
}

service_setup_json_chinachu_names () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.stdout.write(["chinachu-operator", "chinachu-wui"].filter(name => list.some(x => x && x.name === name)).join(" "));
  '
}

service_setup_json_other_names () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    const names = [...new Set(list.filter(x => x && x.name && x.name !== "chinachu-operator" && x.name !== "chinachu-wui").map(x => x.name))];
    process.stdout.write(names.join(" "));
  '
}

service_setup_json_app_names () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    const names = [...new Set(list.filter(x => x && x.name && !(x.pm2_env && x.pm2_env.pmx_module)).map(x => x.name))].sort();
    process.stdout.write(names.join(", "));
  '
}

service_setup_json_persistence_fields () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const active = JSON.parse(process.argv[1]), saved = JSON.parse(process.argv[2]);
    const names = list => new Set(list.filter(x => x && x.name && !(x.pm2_env && x.pm2_env.pmx_module)).map(x => x.name));
    const a = names(active), s = names(saved), only = (left, right) => [...left].filter(x => !right.has(x)).sort().join(", ");
    process.stdout.write([...a].sort().join(", ") + "\n" + [...s].sort().join(", ") + "\n" + only(a, s) + "\n" + only(s, a));
  ' "$1" "$2"
}

service_setup_json_has_online_chinachu_pair () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.exit(["chinachu-operator", "chinachu-wui"].every(name => {
      const item = list.find(x => x && x.name === name);
      return item && item.pm2_env && item.pm2_env.status === "online" && Number(item.pid) > 0;
    }) ? 0 : 1);
  '
}

service_setup_json_has_chinachu_pair () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.exit(["chinachu-operator", "chinachu-wui"].every(name => list.some(x => x && x.name === name)) ? 0 : 1);
  '
}

service_setup_json_active_only_is_chinachu () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const active = JSON.parse(process.argv[1]), saved = JSON.parse(process.argv[2]);
    const names = list => new Set(list.filter(x => x && x.name && !(x.pm2_env && x.pm2_env.pmx_module)).map(x => x.name));
    const a = names(active), sv = names(saved), chinachu = new Set(["chinachu-operator", "chinachu-wui"]);
    const activeOnly = [...a].filter(name => !sv.has(name));
    process.exit(activeOnly.length > 0 && activeOnly.every(name => chinachu.has(name)) ? 0 : 1);
  ' "$1" "$2"
}

service_setup_module_configured () {
  local config="$1"
  [ -r "$config" ] || return 1
  "$BOOTSTRAP_NODE_COMMAND" -e '
    try {
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(value && value["module-db-v2"] && value["module-db-v2"]["pm2-logrotate"] ? 0 : 1);
    } catch (_) { process.exit(1); }
  ' "$config"
}

service_setup_json_has_pid () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.exit(list.some(x => x && Number(x.pid) === Number(process.argv[1]) &&
      (x.name === "chinachu-operator" || x.name === "chinachu-wui")) ? 0 : 1);
  ' "$1"
}

service_setup_json_preserves_other_names () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const fs = require("fs"), expected = JSON.parse(process.argv[1]);
    const actual = JSON.parse(fs.readFileSync(0, "utf8").trim() || "[]");
    const otherNames = list => new Set(list.filter(x => x && x.name && x.name !== "chinachu-operator" && x.name !== "chinachu-wui").map(x => x.name));
    const wanted = otherNames(expected), found = otherNames(actual);
    process.exit([...wanted].every(name => found.has(name)) ? 0 : 1);
  ' "$1"
}

service_setup_json_verify_online () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    for (const name of ["chinachu-operator", "chinachu-wui"]) {
      const item = list.find(x => x && x.name === name);
      if (!item || !item.pm2_env || item.pm2_env.status !== "online" || !Number.isInteger(item.pid) || item.pid <= 0) process.exit(1);
    }
    process.stdout.write(["chinachu-operator", "chinachu-wui"].map(name => {
      const item = list.find(x => x.name === name);
      return name + ":" + Number(item.pm2_env.restart_time || 0);
    }).join(","));
  '
}

service_setup_dump_has_chinachu () {
  [ -r "$1" ] || return 1
  "$BOOTSTRAP_NODE_COMMAND" -e '
    try {
      const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(list.some(x => x && (x.name === "chinachu-operator" || x.name === "chinachu-wui")) ? 0 : 1);
    } catch (_) { process.exit(2); }
  ' "$1"
}

service_setup_identity_for_user () {
  local user="$1" uid gid group
  uid=$(id -u "$user") || return 1
  gid=$(id -g "$user") || return 1
  group=$(id -gn "$user" 2>/dev/null) || group="$gid"
  printf '%s\n%s\n%s\n' "$uid" "$gid" "$group"
}

service_setup_resolve_config_identity () {
  local identity
  identity=$("$BOOTSTRAP_NODE_COMMAND" -e '
    const config = JSON.parse(require("fs").readFileSync("config.json", "utf8"));
    const gid = (typeof config.gid === "string" || typeof config.gid === "number") ? config.gid : "video";
    if (typeof config.uid !== "string" && typeof config.uid !== "number") process.exit(1);
    process.stdout.write(String(config.uid) + "\n" + String(gid));
  ') || return 1
  SERVICE_SETUP_CONFIG_UID=$(printf '%s\n' "$identity" | sed -n '1p')
  SERVICE_SETUP_CONFIG_GID=$(printf '%s\n' "$identity" | sed -n '2p')
  SERVICE_SETUP_RUNTIME_USER=$(id -un "$SERVICE_SETUP_CONFIG_UID" 2>/dev/null) || return 1
  [ "$SERVICE_SETUP_RUNTIME_USER" != root ] || return 1
  SERVICE_SETUP_EXPECTED_UID=$(id -u "$SERVICE_SETUP_RUNTIME_USER") || return 1
  SERVICE_SETUP_EXPECTED_GID=$(getent group "$SERVICE_SETUP_CONFIG_GID" | awk -F: 'NR == 1 { print $3 }')
  [ -n "$SERVICE_SETUP_EXPECTED_GID" ] || return 1
}

service_setup_chinachu_pids () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const fs = require("fs"), path = require("path"), root = path.resolve(process.argv[1]), found = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const argv = fs.readFileSync("/proc/" + entry + "/cmdline", "utf8").split("\0").filter(Boolean);
        const script = argv.find(arg => /(^|\/)app-(operator|wui)\.js$/.test(arg));
        if (!script) continue;
        const cwd = fs.realpathSync("/proc/" + entry + "/cwd");
        const resolved = path.isAbsolute(script) ? path.resolve(script) : path.resolve(cwd, script);
        if (resolved === path.join(root, "app-operator.js") || resolved === path.join(root, "app-wui.js")) found.push(entry);
      } catch (_) {}
    }
    if (found.length) process.stdout.write(found.join("\n") + "\n");
    process.exit(found.length ? 0 : 1);
  ' "$CHINACHU_DIR"
}

service_setup_known_log_files () {
  printf '%s\n' \
    "$CHINACHU_DIR/log/chinachu-wui.stdout.log" \
    "$CHINACHU_DIR/log/chinachu-wui.stderr.log" \
    "$CHINACHU_DIR/log/chinachu-operator.stdout.log" \
    "$CHINACHU_DIR/log/chinachu-operator.stderr.log"
}

service_setup_known_pid_files () {
  printf '%s\n' "$CHINACHU_DIR/data/chinachu-operator.pid" "$CHINACHU_DIR/data/chinachu-wui.pid"
}

service_setup_count_artifacts () {
  local file count=0
  if [ "$1" = log ]; then
    while IFS= read -r file; do [ ! -e "$file" ] || count=$((count + 1)); done < <(service_setup_known_log_files)
  else
    while IFS= read -r file; do [ ! -e "$file" ] || count=$((count + 1)); done < <(service_setup_known_pid_files)
  fi
  printf '%s\n' "$count"
}

# Capture active and saved state independently. Prefix is LOCAL or ROOT.
service_setup_capture_pm2_environment () {
  local prefix="$1" user="$2" home dump module_conf module_path active='[]' saved='[]'
  local active_known=true saved_known=true daemon_active=false logrotate_installed=false logrotate_partial=false
  home=$(service_setup_user_home "$user") || return 1
  dump="$home/.pm2/dump.pm2"
  module_conf="$home/.pm2/module_conf.json"
  module_path="$home/.pm2/modules/pm2-logrotate/node_modules/pm2-logrotate"
  if service_setup_pm2_daemon_active "$user"; then
    daemon_active=true
    if [ -n "$SERVICE_SETUP_PM2_BIN" ] && active=$(service_setup_pm2_as_user "$user" jlist 2>/dev/null) && printf '%s' "$active" | service_setup_json_is_array; then :; else active='[]'; active_known=false; fi
  fi
  if [ -e "$dump" ]; then
    if [ -r "$dump" ]; then
      saved=$(<"$dump")
      if ! printf '%s' "$saved" | service_setup_json_is_array; then saved='[]'; saved_known=false; fi
    else
      saved_known=false
    fi
  fi
  if service_setup_module_configured "$module_conf" && [ -r "$module_path/package.json" ]; then
    logrotate_installed=true
  elif service_setup_module_configured "$module_conf" || [ -e "$module_path/package.json" ]; then
    logrotate_partial=true
  fi
  printf -v "SERVICE_SETUP_${prefix}_USER" '%s' "$user"
  printf -v "SERVICE_SETUP_${prefix}_HOME" '%s' "$home"
  printf -v "SERVICE_SETUP_${prefix}_DUMP" '%s' "$dump"
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE" '%s' "$active"
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE_KNOWN" '%s' "$active_known"
  printf -v "SERVICE_SETUP_${prefix}_SAVED" '%s' "$saved"
  printf -v "SERVICE_SETUP_${prefix}_SAVED_KNOWN" '%s' "$saved_known"
  printf -v "SERVICE_SETUP_${prefix}_DAEMON_ACTIVE" '%s' "$daemon_active"
  printf -v "SERVICE_SETUP_${prefix}_MODULE_CONF" '%s' "$module_conf"
  printf -v "SERVICE_SETUP_${prefix}_MODULE_PATH" '%s' "$module_path"
  printf -v "SERVICE_SETUP_${prefix}_LOGROTATE_INSTALLED" '%s' "$logrotate_installed"
  printf -v "SERVICE_SETUP_${prefix}_LOGROTATE_PARTIAL" '%s' "$logrotate_partial"
}

service_setup_state_value_has_chinachu () {
  printf '%s' "${!1}" | service_setup_json_has_chinachu
}

service_setup_capture_state () {
  SERVICE_SETUP_LOG_COUNT=$(service_setup_count_artifacts log)
  SERVICE_SETUP_PID_COUNT=$(service_setup_count_artifacts pid)
  SERVICE_SETUP_PROCESS_PIDS=$(service_setup_chinachu_pids 2>/dev/null) || SERVICE_SETUP_PROCESS_PIDS=""
  service_setup_capture_pm2_environment LOCAL "$SERVICE_SETUP_LOCAL_USER" || return 1
  if [ "$1" = true ]; then service_setup_capture_pm2_environment ROOT root || return 1; fi
}

service_setup_state_has_trace () {
  [ "$SERVICE_SETUP_LOCAL_ACTIVE_KNOWN" = true ] || return 0
  [ "$SERVICE_SETUP_LOCAL_SAVED_KNOWN" = true ] || return 0
  service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_ACTIVE && return 0
  service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_SAVED && return 0
  if [ "$SERVICE_SETUP_INCLUDE_ROOT" = true ]; then
    [ "$SERVICE_SETUP_ROOT_ACTIVE_KNOWN" = true ] || return 0
    [ "$SERVICE_SETUP_ROOT_SAVED_KNOWN" = true ] || return 0
    service_setup_state_value_has_chinachu SERVICE_SETUP_ROOT_ACTIVE && return 0
    service_setup_state_value_has_chinachu SERVICE_SETUP_ROOT_SAVED && return 0
  fi
  [ -z "$SERVICE_SETUP_PROCESS_PIDS" ] || return 0
  [ "$SERVICE_SETUP_LOG_COUNT" -eq 0 ] || return 0
  [ "$SERVICE_SETUP_PID_COUNT" -eq 0 ] || return 0
  return 1
}

service_setup_all_pm2_state_known () {
  [ "$SERVICE_SETUP_LOCAL_ACTIVE_KNOWN" = true ] && [ "$SERVICE_SETUP_LOCAL_SAVED_KNOWN" = true ] || return 1
  if [ "$SERVICE_SETUP_INCLUDE_ROOT" = true ]; then
    [ "$SERVICE_SETUP_ROOT_ACTIVE_KNOWN" = true ] && [ "$SERVICE_SETUP_ROOT_SAVED_KNOWN" = true ] || return 1
  fi
}

service_setup_print_pm2_state () {
  local label="$1" prefix="$2"
  local active_var="SERVICE_SETUP_${prefix}_ACTIVE" active_known_var="SERVICE_SETUP_${prefix}_ACTIVE_KNOWN"
  local saved_var="SERVICE_SETUP_${prefix}_SAVED" saved_known_var="SERVICE_SETUP_${prefix}_SAVED_KNOWN" value others
  printf '%s PM2\n' "$label"
  if [ "${!active_known_var}" = true ]; then
    value=$(printf '%s' "${!active_var}" | service_setup_json_chinachu_names) || return 1
    printf '  Active : %s\n' "${value:-なし}"
    others=$(printf '%s' "${!active_var}" | service_setup_json_other_names) || return 1
    [ -z "$others" ] || printf '  Active（その他・保持）: %s\n' "$others"
  else
    printf '  Active : 確認不能\n'
  fi
  if [ "${!saved_known_var}" = true ]; then
    value=$(printf '%s' "${!saved_var}" | service_setup_json_chinachu_names) || return 1
    printf '  Saved  : %s\n' "${value:-なし}"
    others=$(printf '%s' "${!saved_var}" | service_setup_json_other_names) || return 1
    [ -z "$others" ] || printf '  Saved（その他・保持） : %s\n' "$others"
  else
    printf '  Saved  : 確認不能\n'
  fi
}

service_setup_print_state () {
  printf '\nChinachu PM2サービス設定\n────────────────────────────────\n\n'
  service_setup_print_pm2_state Local LOCAL || return 1
  if [ "$SERVICE_SETUP_INCLUDE_ROOT" = true ]; then printf '\n'; service_setup_print_pm2_state Root ROOT || return 1; fi
}

service_setup_render_status_environment () {
  local label="$1" prefix="$2"
  local user_var="SERVICE_SETUP_${prefix}_USER" daemon_var="SERVICE_SETUP_${prefix}_DAEMON_ACTIVE"
  local user="${!user_var}"

  printf '[%s PM2: %s]\n' "$label" "$user"
  if [ "${!daemon_var}" != true ]; then
    printf 'PM2 daemonは起動していません。\n'
    return 0
  fi

  service_setup_pm2_as_user "$user" status
}

service_setup_display_status () {
  local title="$1"
  printf '\n%s\n────────────────────────────────\n\n' "$title"
  if service_setup_is_tty; then
    service_setup_render_status_environment Local LOCAL || return 1
    printf '\n────────────────────────────────\n\n'
    service_setup_render_status_environment Root ROOT || return 1
  else
    service_setup_print_pm2_state Local LOCAL || return 1
    printf '\n────────────────────────────────\n\n'
    service_setup_print_pm2_state Root ROOT || return 1
  fi
}

service_setup_load_persistence_fields () {
  local prefix="$1" active_var="SERVICE_SETUP_${1}_ACTIVE" saved_var="SERVICE_SETUP_${1}_SAVED" fields
  fields=$(service_setup_json_persistence_fields "${!active_var}" "${!saved_var}") || return 1
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE_NAMES" '%s' "$(printf '%s\n' "$fields" | sed -n '1p')"
  printf -v "SERVICE_SETUP_${prefix}_SAVED_NAMES" '%s' "$(printf '%s\n' "$fields" | sed -n '2p')"
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE_ONLY" '%s' "$(printf '%s\n' "$fields" | sed -n '3p')"
  printf -v "SERVICE_SETUP_${prefix}_SAVED_ONLY" '%s' "$(printf '%s\n' "$fields" | sed -n '4p')"
}

service_setup_print_persistence_environment () {
  local label="$1" prefix="$2" user_var="SERVICE_SETUP_${2}_USER"
  local active_names_var="SERVICE_SETUP_${2}_ACTIVE_NAMES" saved_names_var="SERVICE_SETUP_${2}_SAVED_NAMES"
  local active_only_var="SERVICE_SETUP_${2}_ACTIVE_ONLY" saved_only_var="SERVICE_SETUP_${2}_SAVED_ONLY"
  printf '%s PM2 (%s)\n' "$label" "${!user_var}"
  printf '  Active : %s\n  Saved  : %s\n' "${!active_names_var:-なし}" "${!saved_names_var:-なし}"
  if [ -z "${!active_only_var}" ] && [ -z "${!saved_only_var}" ]; then
    printf '  状態   : 一致（保存済み）\n'
  else
    printf '  状態   : 差異あり\n'
    [ -z "${!active_only_var}" ] || printf '  Activeのみ : %s\n' "${!active_only_var}"
    [ -z "${!saved_only_var}" ] || printf '  Savedのみ  : %s（保持対象）\n' "${!saved_only_var}"
  fi
}

service_setup_merge_persistence_dump () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const fs = require("fs"), current = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const original = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const names = new Set(current.filter(Boolean).map(x => x.name));
    for (const item of original) {
      if (!item || !item.name || item.name === "chinachu-operator" || item.name === "chinachu-wui" || names.has(item.name)) continue;
      current.push(item); names.add(item.name);
    }
    fs.writeFileSync(process.argv[3], JSON.stringify(current, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  ' "$1" "$2" "$3"
}

service_setup_persistence_save_environment () {
  local prefix="$1" user_var="SERVICE_SETUP_${1}_USER" dump_var="SERVICE_SETUP_${1}_DUMP"
  local active_var="SERVICE_SETUP_${1}_ACTIVE" dump="${!dump_var}" user="${!user_var}" stamp backup='' temporary had_dump=false
  stamp=$(date -u +%Y%m%dT%H%M%SZ).$$; temporary="$dump.persistence.$$"
  if [ -e "$dump" ]; then
    had_dump=true; backup="$dump.persistence-backup.$stamp"
    cp --preserve=mode,ownership,timestamps -- "$dump" "$backup" || return 1
  fi
  if ! service_setup_pm2_as_user "$user" save; then
    if [ "$had_dump" = true ]; then cp --preserve=mode,ownership,timestamps -- "$backup" "$dump"; else rm -f -- "$dump"; fi
    return 1
  fi
  if [ "$had_dump" = true ]; then
    if ! service_setup_merge_persistence_dump "$dump" "$backup" "$temporary"; then cp --preserve=mode,ownership,timestamps -- "$backup" "$dump"; return 1; fi
    chown --reference="$dump" "$temporary" 2>/dev/null || true
    chmod --reference="$dump" "$temporary" 2>/dev/null || true
    if ! mv -- "$temporary" "$dump"; then cp --preserve=mode,ownership,timestamps -- "$backup" "$dump"; return 1; fi
  fi
  if ! service_setup_capture_pm2_environment "$prefix" "$user" || ! service_setup_load_persistence_fields "$prefix"; then
    if [ "$had_dump" = true ]; then cp --preserve=mode,ownership,timestamps -- "$backup" "$dump"; else rm -f -- "$dump"; fi
    return 1
  fi
  local active_only_var="SERVICE_SETUP_${prefix}_ACTIVE_ONLY" saved_only_var="SERVICE_SETUP_${prefix}_SAVED_ONLY"
  local saved_var="SERVICE_SETUP_${prefix}_SAVED"
  if [ -n "${!active_only_var}" ] || { [ "$had_dump" = true ] && ! printf '%s' "${!saved_var}" | service_setup_json_preserves_other_names "$(<"$backup")"; }; then
    if [ "$had_dump" = true ]; then cp --preserve=mode,ownership,timestamps -- "$backup" "$dump"; else rm -f -- "$dump"; fi
    return 1
  fi
  printf -v "SERVICE_SETUP_${prefix}_PERSISTENCE_SAVED" '%s' true
}

service_setup_persistence_review () {
  local prefix label answer_var answer active_only_var saved_only_var
  printf '\nPM2の保存状態\n────────────────────────────────\n\n'
  for prefix in LOCAL ROOT; do
    service_setup_load_persistence_fields "$prefix" || return 1
    [ "$prefix" = LOCAL ] && label=Local || label=Root
    service_setup_print_persistence_environment "$label" "$prefix"
    printf '\n'
  done
  for prefix in LOCAL ROOT; do
    active_only_var="SERVICE_SETUP_${prefix}_ACTIVE_ONLY"; saved_only_var="SERVICE_SETUP_${prefix}_SAVED_ONLY"
    [ -n "${!active_only_var}" ] || continue
    printf '現在Activeですが、%s PM2のsaved stateに存在しないprocessがあります。\n  + %s\n' "$prefix" "${!active_only_var}"
    [ -z "${!saved_only_var}" ] || printf '次のsaved-only processは保持します。\n  = %s\n' "${!saved_only_var}"
    answer_var="SERVICE_SETUP_${prefix}_SAVE_ANSWER"; answer="${!answer_var}"
    if service_setup_is_tty && [ -z "$answer" ]; then read -r -p '現在のPM2状態を保存しますか？ [Y/n] ' answer; fi
    if service_setup_is_tty || [ -n "$answer" ]; then
      case "$answer" in n | N | no | NO ) ;; * ) service_setup_persistence_save_environment "$prefix" || return 1 ;; esac
    else
      printf '保存する場合はsudo ./chinachu service setupをTTYで実行してください。\n'
    fi
  done
}

service_setup_print_logrotate_environment () {
  local label="$1" prefix="$2" user_var="SERVICE_SETUP_${2}_USER" installed_var="SERVICE_SETUP_${2}_LOGROTATE_INSTALLED"
  local partial_var="SERVICE_SETUP_${2}_LOGROTATE_PARTIAL" active_var="SERVICE_SETUP_${2}_ACTIVE" names
  names=$(printf '%s' "${!active_var}" | service_setup_json_app_names) || return 1
  printf '%s PM2 (%s)\n' "$label" "${!user_var}"
  printf '  対象process    : %s\n' "${names:-なし}"
  if [ "${!installed_var}" = true ]; then
    printf '  pm2-logrotate : 設定済み\n'
  elif [ "${!partial_var}" = true ]; then
    printf '  pm2-logrotate : 不整合（自動変更しません）\n'
  else
    printf '  pm2-logrotate : 未設定\n'
  fi
}

service_setup_install_logrotate () {
  local prefix="$1" user_var="SERVICE_SETUP_${1}_USER" daemon_var="SERVICE_SETUP_${1}_DAEMON_ACTIVE"
  local installed_var="SERVICE_SETUP_${1}_LOGROTATE_INSTALLED" partial_var="SERVICE_SETUP_${1}_LOGROTATE_PARTIAL"
  local user="${!user_var}"
  [ "${!installed_var}" != true ] || return 0
  [ "${!partial_var}" != true ] || return 1
  [ "${!daemon_var}" = true ] || return 1
  service_setup_pm2_as_user "$user" install pm2-logrotate@3.0.0 || return 1
  service_setup_capture_pm2_environment "$prefix" "$user" || return 1
  [ "${!installed_var}" = true ] || return 1
  printf -v "SERVICE_SETUP_${prefix}_LOGROTATE_CHANGED" '%s' true
}

service_setup_log_rotation_review () {
  local local_has_chinachu=false local_answer root_answer root_names mirakurun=false
  service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_ACTIVE && local_has_chinachu=true
  root_names=$(printf '%s' "$SERVICE_SETUP_ROOT_ACTIVE" | service_setup_json_app_names) || return 1
  printf '%s' "$SERVICE_SETUP_ROOT_ACTIVE" | "$BOOTSTRAP_NODE_COMMAND" -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "[]");
    process.exit(list.some(x => x && x.name === "mirakurun-server") ? 0 : 1);
  ' && mirakurun=true
  printf '\nPM2ログローテーション\n────────────────────────────────\n\n'
  service_setup_print_logrotate_environment Local LOCAL || return 1
  printf '\n'
  service_setup_print_logrotate_environment Root ROOT || return 1
  [ "$mirakurun" != true ] || printf '  外部process     : mirakurun-server（PM2 Legacy・保持対象）\n'
  SERVICE_SETUP_LOCAL_LOGROTATE_CHANGED=false; SERVICE_SETUP_ROOT_LOGROTATE_CHANGED=false
  if [ "$local_has_chinachu" = true ] && [ "$SERVICE_SETUP_LOCAL_LOGROTATE_INSTALLED" != true ]; then
    if [ "$SERVICE_SETUP_LOCAL_LOGROTATE_PARTIAL" = true ]; then
      service_setup_error 'Local PM2のpm2-logrotate状態が不整合なため自動導入しません。'
      return 1
    fi
    local_answer="$SERVICE_SETUP_LOCAL_LOGROTATE_ANSWER"
    if service_setup_is_tty && [ -z "$local_answer" ]; then read -r -p 'Local PM2のChinachuログにlog rotationを設定しますか？ [Y/n] ' local_answer; fi
    if service_setup_is_tty || [ -n "$local_answer" ]; then
      case "$local_answer" in n | N | no | NO ) ;; * ) service_setup_install_logrotate LOCAL || { service_setup_error 'Local PM2へのpm2-logrotate導入に失敗しました。Chinachu registrationは変更しません。'; return 1; } ;; esac
    fi
  fi
  if [ -n "$root_names" ] && [ "$SERVICE_SETUP_ROOT_LOGROTATE_INSTALLED" != true ]; then
    if [ "$SERVICE_SETUP_ROOT_LOGROTATE_PARTIAL" = true ]; then
      service_setup_error 'Root PM2のpm2-logrotate状態が不整合なため自動導入しません。'
      return 1
    fi
    printf '\nRoot PM2全体にlog rotationを適用する場合の対象:\n'
    printf '  - %s\n' "$(printf '%s' "$root_names" | sed 's/, /\n  - /g')"
    [ "$mirakurun" != true ] || printf '  ※ mirakurun-serverはPM2 Legacy外部processです。Mirakurun本体の設定は変更しません。\n'
    printf '  ※ pm2-logrotateはRoot PM2配下のその他processにも作用します。\n'
    root_answer="$SERVICE_SETUP_ROOT_LOGROTATE_ANSWER"
    if service_setup_is_tty && [ -z "$root_answer" ]; then read -r -p 'Root PM2全体へ適用しますか？ [y/N] ' root_answer; fi
    if service_setup_is_tty || [ -n "$root_answer" ]; then
      case "$root_answer" in y | Y | yes | YES ) service_setup_install_logrotate ROOT || { service_setup_error 'Root PM2へのpm2-logrotate導入に失敗しました。既存registrationは変更しません。'; return 1; } ;; esac
    fi
  fi
  printf '\npm2-logrotateはPM2 module databaseへ登録されるため、この処理では通常app向けpm2 saveを実行しません。\n'
}

service_setup_installer_offer () {
  local source="$1" answer
  printf '\n────────────────────────────────\nChinachuのPM2サービス設定・確認\n────────────────────────────────\n\n'
  if [ "$(id -u)" -eq 0 ]; then chinachu_service_setup; return $?; fi
  if ! service_setup_is_tty; then
    installer_warning "非対話実行ではPM2 Service Setupを自動実行しません。"
    printf '必要な場合は次を実行してください。\n\n  sudo ./chinachu service setup\n'
    return 0
  fi
  if [ "$source" != menu ]; then
    answer="$SERVICE_SETUP_INSTALLER_ANSWER"
    if [ -z "$answer" ]; then read -r -p 'ChinachuのPM2サービス設定を行いますか？ [Y/n] ' answer; fi
    case "$answer" in
      n | N | no | NO ) printf 'ChinachuのPM2 Service Setupをスキップしました。\n'; return 0 ;;
    esac
  fi
  if ! command -v sudo > /dev/null 2>&1; then
    installer_warning "sudoを利用できないためPM2 Service Setupを起動しません。"
    printf '利用可能になった後、次を実行してください。\n\n  sudo ./chinachu service setup\n'
    return 0
  fi
  sudo -- "$CHINACHU_DIR/chinachu" service setup
}

service_setup_validate_processes () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const path = require("path"), apps = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).apps;
    if (!Array.isArray(apps) || apps.length !== 2) process.exit(1);
    for (const name of ["chinachu-operator", "chinachu-wui"]) {
      const app = apps.find(x => x.name === name);
      if (!app || app.cwd !== "." || app.exec_interpreter !== ".nave/node" || app.autorestart !== true || app.treekill !== true || app.kill_timeout !== 12000) process.exit(1);
      for (const key of ["out_file", "error_file", "pid_file"]) if (path.isAbsolute(app[key])) process.exit(1);
    }
  ' "$CHINACHU_DIR/processes.json"
}

service_setup_wait_online () {
  local attempts=20 output
  while [ "$attempts" -gt 0 ]; do
    output=$(service_setup_pm2 jlist) || return 1
    if printf '%s' "$output" | service_setup_json_verify_online > /dev/null; then printf '%s' "$output"; return 0; fi
    attempts=$((attempts - 1)); sleep 0.5
  done
  return 1
}

service_setup_verify_effective_identity () {
  local output="$1" pid name uid gid groups
  for name in chinachu-operator chinachu-wui; do
    pid=$(printf '%s' "$output" | "$BOOTSTRAP_NODE_COMMAND" -e '
      const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const item = list.find(x => x && x.name === process.argv[1]);
      if (!item || !item.pid) process.exit(1); process.stdout.write(String(item.pid));
    ' "$name") || return 1
    [ -r "/proc/$pid/status" ] || return 1
    uid=$(awk '/^Uid:/ { print $2 }' "/proc/$pid/status") || return 1
    gid=$(awk '/^Gid:/ { print $2 }' "/proc/$pid/status") || return 1
    groups=$(awk '/^Groups:/ { print NF - 1 }' "/proc/$pid/status") || return 1
    [ "$uid" = "$SERVICE_SETUP_EXPECTED_UID" ] && [ "$gid" = "$SERVICE_SETUP_EXPECTED_GID" ] && [ "$groups" -gt 0 ] || return 1
  done
}

service_setup_verify_wui_listen () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const config = JSON.parse(require("fs").readFileSync("config.json", "utf8"));
    if (config.wuiOpenServer !== true) process.exit(0);
    const net = require("net"), selection = require("./lib/wui-open-host").resolveOpenServerHost(config.wuiOpenHost);
    if (!selection || !selection.host) process.exit(1);
    const deadline = Date.now() + 10000;
    const connect = () => {
      const socket = net.connect({ host: selection.host, port: config.wuiOpenPort || 20772 });
      const timer = setTimeout(() => socket.destroy(new Error("timeout")), 1000);
      socket.once("connect", () => { clearTimeout(timer); socket.end(); });
      socket.once("close", failed => { if (!failed) process.exit(0); if (Date.now() >= deadline) process.exit(1); setTimeout(connect, 250); });
      socket.once("error", () => {});
    }; connect();
  '
}

service_setup_scheduler_log_size () {
  if [ -f "$CHINACHU_DIR/log/scheduler" ]; then wc -c < "$CHINACHU_DIR/log/scheduler"; else printf '0\n'; fi
}

service_setup_verify_scheduler_log () {
  local offset="$1" file="$CHINACHU_DIR/log/scheduler" size start
  [ -f "$file" ] || return 0
  size=$(wc -c < "$file") || return 1
  if [ "$size" -ge "$offset" ]; then start=$((offset + 1)); else start=1; fi
  ! tail -c "+$start" "$file" | grep -E 'Mirakurun -> Error:|ERROR: Scheduler is already running|uncaughtException|FATAL:' > /dev/null
}

service_setup_verify_pm2_logs () {
  local file attempts=20 missing
  while [ "$attempts" -gt 0 ]; do
    missing=false
    while IFS= read -r file; do [ -e "$file" ] || missing=true; done < <(service_setup_known_log_files)
    [ "$missing" = false ] && break
    attempts=$((attempts - 1)); sleep 0.1
  done
  while IFS= read -r file; do [ -e "$file" ] || return 1; done < <(service_setup_known_log_files)
}

service_setup_verify_process_ownership () {
  local output="$1" pid
  while read -r pid; do
    [ -z "$pid" ] || printf '%s' "$output" | service_setup_json_has_pid "$pid" || return 1
  done < <(service_setup_chinachu_pids 2>/dev/null)
}

service_setup_rollback_registration () {
  local output
  [ "$SERVICE_SETUP_CREATED" = true ] || return 0
  output=$(service_setup_pm2 jlist 2>/dev/null) || output='[]'
  if printf '%s' "$output" | service_setup_json_has_chinachu; then
    service_setup_pm2 delete chinachu-operator chinachu-wui > /dev/null 2>&1 || return 1
    SERVICE_SETUP_ROLLED_BACK=true
  else
    SERVICE_SETUP_ROLLED_BACK=false
  fi
  if [ "$SERVICE_SETUP_SAVE_ATTEMPTED" = true ]; then service_setup_pm2 save > /dev/null 2>&1 || return 1; fi
}

service_setup_print_setup_result () {
  printf '\n処理結果\n────────────────────────────────\n'
  printf 'PM2 registration : %s\nPM2 saved state  : %s\nRollback         : %s\n次の操作         : %s\n' "$1" "$2" "$3" "$4"
}

service_setup_fail_before_start () {
  service_setup_error "$1"
  service_setup_print_setup_result '未実施' '変更なし' '不要' '原因を解消してService Setupを再実行'
  return 1
}

service_setup_fail_after_start () {
  local rollback='不要' saved='変更なし'
  if service_setup_rollback_registration; then [ "$SERVICE_SETUP_ROLLED_BACK" != true ] || rollback='実施済み'; else rollback='失敗（手動確認が必要）'; fi
  [ "$SERVICE_SETUP_SAVE_ATTEMPTED" != true ] || saved='save試行後（rollback結果を確認）'
  service_setup_error "$1"
  service_setup_print_setup_result 'rollback後は未登録' "$saved" "$rollback" 'PM2状態を確認してService Setupを再実行'
  return 1
}

service_setup_register () {
  local mode="$1" output before after scheduler_size
  resolve_bootstrap_node || return 1
  SERVICE_SETUP_PM2_BIN=$(command -v pm2) || { service_setup_fail_before_start "PM2が見つかりません。"; return 1; }
  SERVICE_SETUP_CREATED=false; SERVICE_SETUP_ROLLED_BACK=false; SERVICE_SETUP_SAVE_ATTEMPTED=false
  if [ "$mode" = local ]; then
    SERVICE_SETUP_PM2_USER=$(service_setup_origin_user) || { service_setup_fail_before_start "local方式の一般ユーザーを特定できません。"; return 1; }
    SERVICE_SETUP_RUNTIME_USER="$SERVICE_SETUP_PM2_USER"
    SERVICE_SETUP_EXPECTED_UID=$(id -u "$SERVICE_SETUP_RUNTIME_USER") || return 1
    SERVICE_SETUP_EXPECTED_GID=$(id -g "$SERVICE_SETUP_RUNTIME_USER") || return 1
    BOOTSTRAP_RUNTIME_USER_OVERRIDE="$SERVICE_SETUP_RUNTIME_USER"
  elif [ "$mode" = root ]; then
    [ "$(id -u)" -eq 0 ] || { service_setup_fail_before_start "root管理方式はsudoで実行してください。"; return 1; }
    SERVICE_SETUP_PM2_USER=root; BOOTSTRAP_RUNTIME_USER_OVERRIDE=""
  else
    service_setup_fail_before_start "実行方式はlocalまたはrootを指定してください."; return 1
  fi
  chinachu_runtime_bootstrap || { service_setup_fail_before_start "Runtime Bootstrapに失敗しました。"; return 1; }
  chinachu_installer_verify || { service_setup_fail_before_start "Verifyに失敗しました。"; return 1; }
  service_setup_validate_processes || { service_setup_fail_before_start "processes.jsonがService Setup要件を満たしません。"; return 1; }
  if [ "$mode" = root ]; then service_setup_resolve_config_identity || { service_setup_fail_before_start "config.jsonのuid/gidを一般ユーザーへ解決できません。"; return 1; }; fi
  if [ "$(id -u)" -eq 0 ]; then SERVICE_SETUP_INCLUDE_ROOT=true; else SERVICE_SETUP_INCLUDE_ROOT=false; fi
  SERVICE_SETUP_LOCAL_USER=$(service_setup_origin_user 2>/dev/null) || SERVICE_SETUP_LOCAL_USER="$SERVICE_SETUP_PM2_USER"
  service_setup_capture_state "$SERVICE_SETUP_INCLUDE_ROOT" || { service_setup_fail_before_start "PM2状態を確認できません。"; return 1; }
  if service_setup_state_has_trace; then service_setup_fail_before_start "既存構成または関連artifactがあります。先にsudo ./chinachu service setupで解除・整理してください。"; return 1; fi
  scheduler_size=$(service_setup_scheduler_log_size) || return 1
  SERVICE_SETUP_CREATED=true
  service_setup_pm2 start "$CHINACHU_DIR/processes.json" || { service_setup_fail_after_start "PM2 registration/startに失敗しました。"; return 1; }
  output=$(service_setup_wait_online) || { service_setup_fail_after_start "operator/WUIがONLINEになりませんでした。"; return 1; }
  before=$(printf '%s' "$output" | service_setup_json_verify_online) || { service_setup_fail_after_start "active registrationを確認できません。"; return 1; }
  service_setup_verify_effective_identity "$output" || { service_setup_fail_after_start "effective UID/GIDまたはsupplementary groupsが一致しません。"; return 1; }
  service_setup_verify_wui_listen || { service_setup_fail_after_start "WUI LISTENを確認できません。"; return 1; }
  service_setup_verify_pm2_logs || { service_setup_fail_after_start "PM2 log生成を確認できません。"; return 1; }
  service_setup_verify_process_ownership "$output" || { service_setup_fail_after_start "PM2外のChinachu child processを検出しました。"; return 1; }
  sleep "${SERVICE_SETUP_STABILITY_SECONDS:-10}"
  output=$(service_setup_pm2 jlist) || { service_setup_fail_after_start "安定性確認に失敗しました。"; return 1; }
  after=$(printf '%s' "$output" | service_setup_json_verify_online) || { service_setup_fail_after_start "operator/WUIが停止しました。"; return 1; }
  [ "$before" = "$after" ] || { service_setup_fail_after_start "restart countが増加しました。"; return 1; }
  service_setup_verify_scheduler_log "$scheduler_size" || { service_setup_fail_after_start "scheduler初回実行で致命的errorを検出しました。"; return 1; }
  SERVICE_SETUP_CREATED=false
  return 0
}

service_setup_guard_activity () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const fs = require("fs"), now = Date.now(), guard = Number(process.argv[1]) * 1000;
    const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
    if (read("data/recording.json").length) { console.error("録画中のため解除・整理を中止します。"); process.exit(1); }
    if (read("data/reserves.json").some(x => x && Number(x.end || x.start) >= now && Number(x.start) <= now + guard)) {
      console.error("直近予約があるため解除・整理を中止します。"); process.exit(1);
    }
  ' "${SERVICE_SETUP_RESERVATION_GUARD_SECONDS:-300}"
}

service_setup_write_exclusive_as_user () {
  local user="$1" target="$2"
  if [ "$user" = "$(id -un)" ]; then
    "$BOOTSTRAP_NODE_COMMAND" -e 'require("fs").writeFileSync(process.argv[1], require("fs").readFileSync(0), { flag: "wx", mode: 0o600 })' "$target"
  else
    runuser -u "$user" -- "$BOOTSTRAP_NODE_COMMAND" -e 'require("fs").writeFileSync(process.argv[1], require("fs").readFileSync(0), { flag: "wx", mode: 0o600 })' "$target"
  fi
}

service_setup_backup_environment () {
  local prefix="$1" user_var="SERVICE_SETUP_${1}_USER" home_var="SERVICE_SETUP_${1}_HOME"
  local dump_var="SERVICE_SETUP_${1}_DUMP" active_var="SERVICE_SETUP_${1}_ACTIVE"
  local user="${!user_var}" home="${!home_var}" dump="${!dump_var}" stamp backup active_backup
  stamp=$(date -u +%Y%m%dT%H%M%SZ).$$
  printf -v "SERVICE_SETUP_${prefix}_DUMP_BACKUP" '%s' ''
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE_BACKUP" '%s' ''
  if { service_setup_state_value_has_chinachu "$active_var" || service_setup_state_value_has_chinachu "SERVICE_SETUP_${prefix}_SAVED"; } && [ -e "$dump" ]; then
    backup="$dump.chinachu-backup.$stamp"
    [ ! -e "$backup" ] && cp --preserve=mode,ownership,timestamps -- "$dump" "$backup" || return 1
    printf -v "SERVICE_SETUP_${prefix}_DUMP_BACKUP" '%s' "$backup"
  fi
  if service_setup_state_value_has_chinachu "$active_var"; then
    active_backup="$home/.pm2/chinachu-active-backup.$stamp.json"
    printf '%s' "${!active_var}" | service_setup_write_exclusive_as_user "$user" "$active_backup" || return 1
    printf -v "SERVICE_SETUP_${prefix}_ACTIVE_BACKUP" '%s' "$active_backup"
  fi
}

service_setup_merge_dump_without_chinachu () {
  "$BOOTSTRAP_NODE_COMMAND" -e '
    const fs = require("fs"), isChinachu = x => x && (x.name === "chinachu-operator" || x.name === "chinachu-wui");
    const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const current = read(process.argv[1]).filter(x => !isChinachu(x));
    const original = read(process.argv[2]).filter(x => !isChinachu(x));
    const names = new Set(current.filter(Boolean).map(x => x.name));
    for (const item of original) if (!item || !item.name || !names.has(item.name)) current.push(item);
    fs.writeFileSync(process.argv[3], JSON.stringify(current, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  ' "$1" "$2" "$3"
}

service_setup_remove_saved_chinachu () {
  local prefix="$1" dump_var="SERVICE_SETUP_${1}_DUMP" backup_var="SERVICE_SETUP_${1}_DUMP_BACKUP"
  local dump="${!dump_var}" backup="${!backup_var}" temporary="$dump.clean.$$"
  [ -n "$backup" ] || return 0
  service_setup_merge_dump_without_chinachu "$dump" "$backup" "$temporary" || return 1
  chown --reference="$dump" "$temporary" 2>/dev/null || true
  chmod --reference="$dump" "$temporary" 2>/dev/null || true
  mv -- "$temporary" "$dump"
}

service_setup_cleanup_environment () {
  local prefix="$1" user_var="SERVICE_SETUP_${1}_USER" active_var="SERVICE_SETUP_${1}_ACTIVE"
  local user="${!user_var}" names saved_var="SERVICE_SETUP_${1}_SAVED" saved_has_chinachu=false
  names=$(printf '%s' "${!active_var}" | service_setup_json_chinachu_names) || return 1
  service_setup_state_value_has_chinachu "$saved_var" && saved_has_chinachu=true
  printf -v "SERVICE_SETUP_${prefix}_ACTIVE_CHANGED" '%s' false
  printf -v "SERVICE_SETUP_${prefix}_SAVED_CHANGED" '%s' false
  printf -v "SERVICE_SETUP_${prefix}_SAVE_EXECUTED" '%s' false
  if [ -n "$names" ]; then
    service_setup_pm2_as_user "$user" stop $names || return 1
    service_setup_pm2_as_user "$user" delete $names || return 1
    service_setup_pm2_as_user "$user" save || return 1
    printf -v "SERVICE_SETUP_${prefix}_ACTIVE_CHANGED" '%s' true
    printf -v "SERVICE_SETUP_${prefix}_SAVE_EXECUTED" '%s' true
  fi
  if [ -n "$names" ] || [ "$saved_has_chinachu" = true ]; then
    service_setup_remove_saved_chinachu "$prefix" || return 1
  fi
  [ "$saved_has_chinachu" != true ] || printf -v "SERVICE_SETUP_${prefix}_SAVED_CHANGED" '%s' true
}

service_setup_processes_are_attributed () {
  local pid
  while read -r pid; do
    [ -z "$pid" ] && continue
    printf '%s' "$SERVICE_SETUP_LOCAL_ACTIVE" | service_setup_json_has_pid "$pid" && continue
    printf '%s' "$SERVICE_SETUP_ROOT_ACTIVE" | service_setup_json_has_pid "$pid" && continue
    return 1
  done <<< "$SERVICE_SETUP_PROCESS_PIDS"
}

service_setup_backup_logs () {
  local file target stamp index=0
  SERVICE_SETUP_LOG_BACKUPS=()
  stamp=$(date -u +%Y%m%dT%H%M%SZ).$$
  while IFS= read -r file; do
    [ -e "$file" ] || continue
    index=$((index + 1)); target="$file.pm2-backup-$stamp.$index"
    [ ! -e "$target" ] || return 1
    mv -- "$file" "$target" || return 1
    SERVICE_SETUP_LOG_BACKUPS+=("$file|$target")
  done < <(service_setup_known_log_files)
}

service_setup_restore_logs () {
  local pair original backup status=0
  for pair in "${SERVICE_SETUP_LOG_BACKUPS[@]}"; do
    original=${pair%%|*}; backup=${pair#*|}
    if [ -e "$backup" ] && [ ! -e "$original" ]; then mv -- "$backup" "$original" || status=1; else status=1; fi
  done
  return "$status"
}

service_setup_pid_is_stale () {
  local file="$1" name pid
  name=$(basename "$file"); name=${name#chinachu-}; name=${name%.pid}
  read -r pid < "$file" || return 1
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    [ -r "/proc/$pid/cmdline" ] || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -F -- "app-$name.js" > /dev/null && return 1
  fi
  return 0
}

service_setup_remove_stale_pids () {
  local file count=0
  while IFS= read -r file; do
    [ -e "$file" ] || continue
    service_setup_pid_is_stale "$file" || return 1
  done < <(service_setup_known_pid_files)
  while IFS= read -r file; do
    [ -e "$file" ] || continue
    rm -- "$file" || return 1
    count=$((count + 1))
  done < <(service_setup_known_pid_files)
  SERVICE_SETUP_PID_REMOVED_COUNT="$count"
}

service_setup_restore_environment () {
  local prefix="$1" user_var="SERVICE_SETUP_${1}_USER" dump_var="SERVICE_SETUP_${1}_DUMP"
  local dump_backup_var="SERVICE_SETUP_${1}_DUMP_BACKUP" active_backup_var="SERVICE_SETUP_${1}_ACTIVE_BACKUP"
  local user="${!user_var}" dump="${!dump_var}" dump_backup="${!dump_backup_var}" active_backup="${!active_backup_var}"
  if [ -n "$active_backup" ]; then service_setup_pm2_as_user "$user" start "$active_backup" --only chinachu-operator,chinachu-wui > /dev/null 2>&1 || return 1; fi
  if [ -n "$dump_backup" ]; then cp --preserve=mode,ownership,timestamps -- "$dump_backup" "$dump" || return 1; fi
}

service_setup_cleanup_rollback () {
  local status=0
  service_setup_restore_environment LOCAL || status=1
  service_setup_restore_environment ROOT || status=1
  [ "${#SERVICE_SETUP_LOG_BACKUPS[@]}" -eq 0 ] || service_setup_restore_logs || status=1
  return "$status"
}

service_setup_print_cleanup_result () {
  local registration='変更なし（元からChinachu登録なし）' saved='変更なし（元からChinachu entryなし）'
  local persistence='未実施' logs='変更なし' pids='変更なし' rollback="${1:-不要}"
  if [ "$SERVICE_SETUP_LOCAL_ACTIVE_CHANGED" = true ] || [ "$SERVICE_SETUP_ROOT_ACTIVE_CHANGED" = true ]; then registration='Chinachu registrationを解除'; fi
  if [ "$SERVICE_SETUP_LOCAL_SAVED_CHANGED" = true ] || [ "$SERVICE_SETUP_ROOT_SAVED_CHANGED" = true ]; then saved='Chinachu entryを除去'; fi
  if [ "$SERVICE_SETUP_LOCAL_SAVE_EXECUTED" = true ] || [ "$SERVICE_SETUP_ROOT_SAVE_EXECUTED" = true ] ||
     [ "$SERVICE_SETUP_LOCAL_PERSISTENCE_SAVED" = true ] || [ "$SERVICE_SETUP_ROOT_PERSISTENCE_SAVED" = true ]; then
    persistence='pm2 save実行'
  fi
  [ "${#SERVICE_SETUP_LOG_BACKUPS[@]}" -eq 0 ] || logs="${#SERVICE_SETUP_LOG_BACKUPS[@]}件をbackupへ退避"
  [ "${SERVICE_SETUP_PID_REMOVED_COUNT:-0}" -eq 0 ] || pids="${SERVICE_SETUP_PID_REMOVED_COUNT}件を削除"
  printf '\n処理結果\n────────────────────────────────\n\n'
  printf 'PM2 registration : %s\nPM2 saved state  : %s\nPM2 persistence  : %s\nPM2 log          : %s\nPM2 PID          : %s\n最終状態         : CLEAN\nRollback         : %s\n' \
    "$registration" "$saved" "$persistence" "$logs" "$pids" "$rollback"
}

service_setup_cleanup () {
  local answer needs_guard=false rollback local_active_before local_saved_before root_active_before root_saved_before
  [ "$(id -u)" -eq 0 ] || return 1
  service_setup_all_pm2_state_known || { service_setup_error "PM2 active/saved stateに確認不能な項目があるため、安全に解除・整理できません。"; return 1; }
  service_setup_processes_are_attributed || { service_setup_error "PM2 registrationへ対応付けできない実processがあります。自動kill・整理は行いません。"; return 1; }
  [ -z "$SERVICE_SETUP_PROCESS_PIDS" ] || needs_guard=true
  if [ "$needs_guard" = true ]; then service_setup_guard_activity || return 1; fi
  if [ -t 0 ]; then read -r -p 'Chinachu operator / WUIのPM2構成と既知artifactを解除・整理しますか？ [y/N] ' answer; else answer="${SERVICE_SETUP_CLEANUP_ANSWER:-n}"; fi
  case "$answer" in y | Y | yes | YES ) ;; * ) printf '解除・整理を実施しません。\n'; return 0 ;; esac
  local_active_before="$SERVICE_SETUP_LOCAL_ACTIVE"; local_saved_before="$SERVICE_SETUP_LOCAL_SAVED"
  root_active_before="$SERVICE_SETUP_ROOT_ACTIVE"; root_saved_before="$SERVICE_SETUP_ROOT_SAVED"
  SERVICE_SETUP_LOG_BACKUPS=(); SERVICE_SETUP_PID_REMOVED_COUNT=0
  SERVICE_SETUP_LOCAL_ACTIVE_CHANGED=false; SERVICE_SETUP_LOCAL_SAVED_CHANGED=false; SERVICE_SETUP_LOCAL_SAVE_EXECUTED=false
  SERVICE_SETUP_ROOT_ACTIVE_CHANGED=false; SERVICE_SETUP_ROOT_SAVED_CHANGED=false; SERVICE_SETUP_ROOT_SAVE_EXECUTED=false
  SERVICE_SETUP_LOCAL_PERSISTENCE_SAVED=false; SERVICE_SETUP_ROOT_PERSISTENCE_SAVED=false
  service_setup_backup_environment LOCAL || return 1
  service_setup_backup_environment ROOT || return 1
  if ! service_setup_cleanup_environment LOCAL || ! service_setup_cleanup_environment ROOT || ! service_setup_backup_logs; then
    if service_setup_cleanup_rollback; then rollback='実施済み'; else rollback='失敗（手動確認が必要）'; fi
    service_setup_print_setup_result '解除失敗' 'rollback結果を確認' "$rollback" 'PM2状態を確認'
    return 1
  fi
  service_setup_capture_state true || { service_setup_cleanup_rollback; return 1; }
  if service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_ACTIVE || service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_SAVED ||
     service_setup_state_value_has_chinachu SERVICE_SETUP_ROOT_ACTIVE || service_setup_state_value_has_chinachu SERVICE_SETUP_ROOT_SAVED; then
    service_setup_cleanup_rollback
    service_setup_error "Chinachu registrationがactiveまたはsaved stateに残っています。"
    return 1
  fi
  if ! printf '%s' "$SERVICE_SETUP_LOCAL_ACTIVE" | service_setup_json_preserves_other_names "$local_active_before" ||
     ! printf '%s' "$SERVICE_SETUP_LOCAL_SAVED" | service_setup_json_preserves_other_names "$local_saved_before" ||
     ! printf '%s' "$SERVICE_SETUP_ROOT_ACTIVE" | service_setup_json_preserves_other_names "$root_active_before" ||
     ! printf '%s' "$SERVICE_SETUP_ROOT_SAVED" | service_setup_json_preserves_other_names "$root_saved_before"; then
    service_setup_cleanup_rollback
    service_setup_error "Chinachu以外のPM2 registrationが維持されていることを確認できません。"
    return 1
  fi
  service_setup_remove_stale_pids || { service_setup_cleanup_rollback; return 1; }
  service_setup_capture_state true || { service_setup_cleanup_rollback; return 1; }
  printf '\nChinachu PM2構成の解除・整理が完了しました。\n────────────────────────────────\n\n'
  printf '変更していないもの: 録画file、config/rules、runtime data、Mirakurun、その他PM2 process\n'
  if ! service_setup_persistence_review; then
    service_setup_print_cleanup_result '不要（cleanup完了、persistence失敗）'
    return 1
  fi
  service_setup_display_status '適用後のPM2状態' || return 1
  service_setup_print_cleanup_result '不要'
}

service_setup_has_healthy_existing () {
  local local_pair=false root_pair=false
  printf '%s' "$SERVICE_SETUP_LOCAL_ACTIVE" | service_setup_json_has_online_chinachu_pair && local_pair=true
  printf '%s' "$SERVICE_SETUP_ROOT_ACTIVE" | service_setup_json_has_online_chinachu_pair && root_pair=true
  [ "$local_pair" != "$root_pair" ] || return 1
  service_setup_processes_are_attributed || return 1
  if [ "$local_pair" = true ]; then
    service_setup_state_value_has_chinachu SERVICE_SETUP_ROOT_SAVED && return 1
    SERVICE_SETUP_EXISTING_MODE=local
  else
    service_setup_state_value_has_chinachu SERVICE_SETUP_LOCAL_SAVED && return 1
    SERVICE_SETUP_EXISTING_MODE=root
  fi
}

service_setup_maintenance () {
  service_setup_persistence_review || return 1
  service_setup_log_rotation_review || return 1
  service_setup_capture_state true || return 1
  service_setup_display_status '適用後のPM2状態'
}

service_setup_run_setup () {
  local mode="$1" prefix other_prefix active_var saved_var other_active_var other_saved_var before after

  service_setup_register "$mode" || return 1
  service_setup_capture_state true || return 1

  if [ "$mode" = local ]; then
    prefix=LOCAL; other_prefix=ROOT
  else
    prefix=ROOT; other_prefix=LOCAL
  fi

  active_var="SERVICE_SETUP_${prefix}_ACTIVE"
  saved_var="SERVICE_SETUP_${prefix}_SAVED"

  # Automatically save the newly registered Chinachu apps, but do not
  # silently persist unrelated active-only PM2 applications.
  if ! service_setup_json_active_only_is_chinachu "${!active_var}" "${!saved_var}"; then
    service_setup_error 'Chinachu以外の未保存PM2 processがあるため、自動でpm2 saveを実行しません。'
    printf 'Chinachuは現在ONLINEですが、PM2の保存状態を手動で確認してください。\n'
    return 1
  fi

  service_setup_persistence_save_environment "$prefix" || {
    service_setup_error 'PM2の設定保存に失敗しました。Chinachu active registrationは維持します。'
    return 1
  }

  service_setup_capture_state true || return 1
  saved_var="SERVICE_SETUP_${prefix}_SAVED"
  if ! printf '%s' "${!saved_var}" | service_setup_json_has_chinachu_pair; then
    service_setup_error 'pm2 save後の保存状態にChinachu operator / WUIを確認できません。'
    return 1
  fi

  service_setup_log_rotation_review || return 1
  service_setup_capture_state true || return 1

  active_var="SERVICE_SETUP_${prefix}_ACTIVE"
  before=$(printf '%s' "${!active_var}" | service_setup_json_verify_online) || {
    service_setup_error '登録完了後のChinachu ONLINE状態を確認できません。'
    return 1
  }

  printf '\nChinachu PM2サービスの登録が完了しました。\n'
  if service_setup_is_tty; then
    printf '数秒後に最終状態を確認します...\n'
    sleep "${SERVICE_SETUP_FINAL_VERIFY_SECONDS:-3}"
  fi

  service_setup_capture_state true || return 1
  active_var="SERVICE_SETUP_${prefix}_ACTIVE"
  saved_var="SERVICE_SETUP_${prefix}_SAVED"
  other_active_var="SERVICE_SETUP_${other_prefix}_ACTIVE"
  other_saved_var="SERVICE_SETUP_${other_prefix}_SAVED"

  after=$(printf '%s' "${!active_var}" | service_setup_json_verify_online) || {
    service_setup_error '最終確認でChinachu operator / WUIがONLINEではありません。'
    return 1
  }
  [ "$before" = "$after" ] || {
    service_setup_error '最終確認までの間にChinachuのrestart countが増加しました。'
    return 1
  }
  printf '%s' "${!saved_var}" | service_setup_json_has_chinachu_pair || {
    service_setup_error '最終確認でPM2の保存状態にChinachu operator / WUIを確認できません。'
    return 1
  }
  if printf '%s' "${!other_active_var}" | service_setup_json_has_chinachu ||
     printf '%s' "${!other_saved_var}" | service_setup_json_has_chinachu; then
    service_setup_error '最終確認でChinachu構成がLocal/Root双方に存在します。'
    return 1
  fi
  service_setup_processes_are_attributed || {
    service_setup_error '最終確認でPM2 registrationへ対応付けできないChinachu processを検出しました。'
    return 1
  }

  printf '✓ 最終確認: ONLINE / PM2保存済み\n'
  service_setup_display_status '最終確認後のPM2状態'
}

service_setup_run_menu () {
  local choice loop_menu=false show_state=true result mode_label
  resolve_bootstrap_node || return 1
  SERVICE_SETUP_PM2_BIN=$(command -v pm2 2>/dev/null) || SERVICE_SETUP_PM2_BIN=""
  SERVICE_SETUP_LOCAL_USER=$(service_setup_origin_user) || { service_setup_error "有効な非root SUDO_USERを特定できません。"; return 1; }
  SERVICE_SETUP_INCLUDE_ROOT=true

  # Real TTY use behaves like a menu: after one operation, return here.
  # Scripted/non-interactive test paths remain one-shot so injected choices
  # cannot accidentally repeat forever.
  if service_setup_is_tty && [ -z "$SERVICE_SETUP_MENU_CHOICE" ]; then loop_menu=true; fi

  while true; do
    service_setup_capture_state true || return 1
    if [ "$show_state" = true ]; then
      service_setup_display_status '現在のPM2状態' || return 1
    fi
    choice="$SERVICE_SETUP_MENU_CHOICE"

    if service_setup_has_healthy_existing; then
      [ "$SERVICE_SETUP_EXISTING_MODE" = local ] && mode_label='現在のユーザー方式' || mode_label='従来方式'
      printf '\nChinachu PM2サービスは設定済みです（%s）。\n\n' "$mode_label"
      printf '1) Chinachu PM2構成を解除・整理\n0) Exit\n'
      if service_setup_is_tty && [ -z "$choice" ]; then read -r -p '> ' choice; fi
      case "$choice" in
        1 ) service_setup_cleanup; result=$? ;;
        0 | '' ) return 0 ;;
        * ) return 1 ;;
      esac
    elif service_setup_state_has_trace; then
      printf '\n既存のChinachu PM2構成または関連fileを検出しました。\n'
      printf '\n1) 既存Chinachu PM2構成を解除・整理\n0) Exit\n'
      if service_setup_is_tty && [ -z "$choice" ]; then read -r -p '> ' choice; fi
      case "$choice" in
        1 ) service_setup_cleanup; result=$? ;;
        0 | '' ) return 0 ;;
        * ) return 1 ;;
      esac
    else
      printf '\n既存のChinachu PM2構成はありません。\n\n'
      printf '実行方式を選択してください。\n\n'
      printf '1) 現在のユーザーで実行 [推奨]\n'
      printf '   PM2とChinachuを現在のユーザーで実行します。\n'
      printf '   PM2 / Chinachu: %s\n\n' "$SERVICE_SETUP_LOCAL_USER"
      printf '2) config.jsonで指定したユーザー／グループで実行（従来方式）\n'
      printf '   PM2はrootで管理し、Chinachuはconfig.jsonのuid/gidで実行します。\n'
      printf '   例: uid=chinachu / gid=video\n\n'
      printf '0) Exit\n'
      if service_setup_is_tty && [ -z "$choice" ]; then read -r -p '> ' choice; fi
      case "$choice" in
        1 ) service_setup_run_setup local; result=$? ;;
        2 ) service_setup_run_setup root; result=$? ;;
        0 | '' ) return 0 ;;
        * ) return 1 ;;
      esac
    fi

    [ "$result" -eq 0 ] || return "$result"
    [ "$loop_menu" = true ] || return 0

    # Each operation prints its result/current state. Re-enter the menu using
    # freshly captured state without duplicating the PM2 tables.
    show_state=false
  done
}

chinachu_service_setup () {
  if [ "$(id -u)" -ne 0 ]; then
    printf 'PM2 Service Setupではroot/local双方の状態確認が必要です。\n\n次を実行してください。\n\n  sudo ./chinachu service setup\n'
    return 0
  fi
  case "$1" in
    '' ) service_setup_run_menu ;;
    local | root )
      service_setup_origin_user > /dev/null || { service_setup_error "有効な非root SUDO_USERが必要です。"; return 1; }
      SERVICE_SETUP_LOCAL_USER=$(service_setup_origin_user) || return 1
      SERVICE_SETUP_INCLUDE_ROOT=true
      service_setup_run_setup "$1" "$2"
      ;;
    * ) service_setup_error "不明なService Setup modeです: $1"; return 1 ;;
  esac
}
