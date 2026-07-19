#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

hermes_home=
env_file=
sandbox_root=
apply=0
remove_env=0
declare -A seen=()

while (($#)); do
  key=$1
  shift
  case "$key" in
    --apply)
      [[ -z ${seen[apply]+x} ]] || fail UNINSTALL_ARGS
      seen[apply]=1
      apply=1
      ;;
    --remove-env)
      [[ -z ${seen[remove_env]+x} ]] || fail UNINSTALL_ARGS
      seen[remove_env]=1
      remove_env=1
      ;;
    --hermes-home|--env-file|--sandbox-root)
      [[ -z ${seen[$key]+x} && $# -gt 0 && $1 != --* ]] || fail UNINSTALL_ARGS
      seen[$key]=1
      value=$1
      shift
      case "$key" in
        --hermes-home) hermes_home=$value ;;
        --env-file) env_file=$value ;;
        --sandbox-root) sandbox_root=$value ;;
      esac
      ;;
    *) fail UNINSTALL_ARGS ;;
  esac
done

[[ -n $hermes_home && -n $env_file ]] || fail UNINSTALL_ARGS

check_path_value() {
  local value=$1
  [[ $value == /* ]] || fail UNINSTALL_PATH
  [[ $value =~ ^[A-Za-z0-9._/+:-]+$ ]] || fail CONFIG_PATH_CHARSET
  [[ $value != / && $value != *//* && $value != */ && $value != */../* && $value != */.. && $value != */./* && $value != */. ]] || fail UNINSTALL_PATH
}

check_path_value "$hermes_home"
check_path_value "$env_file"
[[ -z $sandbox_root ]] || check_path_value "$sandbox_root"

python_bin=
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'pass' >/dev/null 2>&1; then
    python_bin=$(command -v "$candidate")
    break
  fi
done
[[ -n $python_bin ]] || fail UNINSTALL_PYTHON
system_name=$(uname -s)
if [[ -n $sandbox_root ]]; then
  runtime_root=$sandbox_root/opt/hermes-codex-bridge-v3
  state_root=$sandbox_root/var/lib/hermes-codex-bridge-v3
  unit_file=$sandbox_root/etc/systemd/system/hermes-codex-bridge.service
else
  runtime_root=/opt/hermes-codex-bridge-v3
  state_root=/var/lib/hermes-codex-bridge-v3
  unit_file=/etc/systemd/system/hermes-codex-bridge.service
fi
skill_dir=$hermes_home/skills/hermes-codex-telegram-reply-v3
skill_file=$skill_dir/SKILL.md
manifest_file=$runtime_root/install-manifest.json

validate_uninstall_paths() {
"$python_bin" - "$@" <<'PY'
import os
import stat
import sys

home, env_file, sandbox, runtime, state, skill, unit = sys.argv[1:]
reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

def fail():
    print("UNINSTALL_UNSAFE", file=sys.stderr)
    raise SystemExit(2)

def components(path):
    result = []
    current = os.path.abspath(path)
    while True:
        result.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            return list(reversed(result))
        current = parent

def validate(path, leaf_kind, required):
    chain = components(path)
    leaf_exists = False
    for index, component in enumerate(chain):
        try:
            info = os.lstat(component)
        except FileNotFoundError:
            continue
        except OSError:
            fail()
        is_leaf = index == len(chain) - 1
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse:
            fail()
        if not is_leaf and not stat.S_ISDIR(info.st_mode):
            fail()
        if is_leaf:
            leaf_exists = True
            expected = stat.S_ISDIR(info.st_mode) if leaf_kind == "directory" else stat.S_ISREG(info.st_mode)
            if not expected:
                fail()
    if required and not leaf_exists:
        fail()

def normalized(path):
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))

def overlaps(first, second):
    first, second = normalized(first), normalized(second)
    try:
        common = os.path.commonpath((first, second))
    except ValueError:
        return False
    return common == first or common == second

validate(home, "directory", True)
validate(env_file, "file", False)
if sandbox:
    validate(sandbox, "directory", False)
validate(runtime, "directory", False)
validate(state, "directory", False)
validate(skill, "directory", False)
validate(unit, "file", False)

if any(overlaps(owned, home) for owned in (runtime, state, unit, env_file)):
    print("UNINSTALL_OVERLAP", file=sys.stderr)
    raise SystemExit(2)
env_is_unit = normalized(env_file) == normalized(unit)
if any(overlaps(env_file, owned) for owned in (runtime, state)) or overlaps(env_file, skill) or env_is_unit:
    print("UNINSTALL_OVERLAP", file=sys.stderr)
    raise SystemExit(2)
PY
}

validate_uninstall_paths "$hermes_home" "$env_file" "$sandbox_root" \
  "$runtime_root" "$state_root" "$skill_dir" "$unit_file" || exit $?

if ((apply == 0)); then
  printf '%s\n' \
    'PLAN uninstall hermes-codex-bridge-v3' \
    'TARGET system-unit' \
    'TARGET runtime' \
    'TARGET state' \
    'TARGET hermes-skill' \
    'PRESERVE queue' \
    'PRESERVE hermes-home'
  if ((remove_env)); then
    printf '%s\n' 'TARGET env-file [redacted]'
  else
    printf '%s\n' 'PRESERVE env-file [redacted]'
  fi
  if [[ -n $sandbox_root ]]; then
    printf '%s\n' 'RUN systemd-disable [sandbox:no]'
  else
    printf '%s\n' 'RUN systemd-disable [production:yes]'
  fi
  exit 0
fi


if [[ -z $sandbox_root ]]; then
  [[ $system_name == Linux ]] || fail UNINSTALL_PLATFORM
  [[ ${EUID:-$(id -u)} -eq 0 ]] || fail UNINSTALL_PRIVILEGE
fi

test_fail_step=${HC3_TEST_FAIL_STEP:-}
if [[ -n $test_fail_step ]]; then
  [[ -n $sandbox_root ]] || fail UNINSTALL_TEST_HOOK
  case "$test_fail_step" in
    after_first_quarantine|after_quarantine|before_reload|during_first_finalize|during_state_finalize) ;;
    *) fail UNINSTALL_TEST_HOOK ;;
  esac
fi
test_rollback_failure=${HC3_TEST_ROLLBACK_FAILURE:-}
if [[ -n $test_rollback_failure ]]; then
  [[ -n $sandbox_root && $test_rollback_failure == 1 ]] || fail UNINSTALL_TEST_HOOK
fi

verify_manifest() {
"$python_bin" - "$manifest_file" "$env_file" "$hermes_home" "$runtime_root" "$state_root" \
  "$unit_file" "$skill_dir" "$sandbox_root" "$remove_env" <<'PY'
import json
import os
import re
import stat
import sys

manifest_path, env_file, home, runtime, state, unit, skill, sandbox, remove_env = sys.argv[1:]
reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

def refuse():
    print("UNINSTALL_OWNERSHIP_UNVERIFIED", file=sys.stderr)
    raise SystemExit(2)

def normalized(path):
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))

owned = (runtime, state, unit, skill) + ((env_file,) if remove_env == "1" else ())
try:
    info = os.lstat(manifest_path)
except FileNotFoundError:
    if any(os.path.lexists(path) for path in owned):
        refuse()
    raise SystemExit(3)
except OSError:
    refuse()
if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse:
    refuse()
if info.st_size > 16384:
    refuse()
if not sandbox:
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        refuse()
try:
    with open(manifest_path, encoding="utf-8") as stream:
        value = json.load(stream)
except (OSError, UnicodeError, json.JSONDecodeError):
    refuse()
expected_targets = {
    "runtime_root": normalized(runtime),
    "state_root": normalized(state),
    "unit_file": normalized(unit),
    "skill_dir": normalized(skill),
}
if not isinstance(value, dict) or set(value) != {"schema", "env_file", "hermes_home", "service_user", "targets"}:
    refuse()
if value.get("schema") != "hermes-codex-install-manifest/v3":
    refuse()
if value.get("env_file") != normalized(env_file) or value.get("hermes_home") != normalized(home):
    refuse()
if value.get("targets") != expected_targets:
    refuse()
user = value.get("service_user")
if not isinstance(user, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", user) or user == "root":
    refuse()
if not sandbox:
    import pwd
    try:
        if pwd.getpwnam(user).pw_uid == 0:
            refuse()
    except KeyError:
        refuse()
PY
}

set +e
verify_manifest
manifest_status=$?
set -e
if ((manifest_status == 3)); then
  printf '%s\n' UNINSTALL_ALREADY_ABSENT
  exit 0
fi
((manifest_status == 0)) || exit "$manifest_status"

stage_base=$([[ -n $sandbox_root ]] && printf '%s' "${TMPDIR:-/tmp}" || printf '%s' /var/tmp)
stage_root=$(mktemp -d "$stage_base/hermes-codex-uninstall.XXXXXX" 2>/dev/null) || fail UNINSTALL_STAGE
trap 'rm -rf -- "$stage_root"' EXIT
chmod 0700 -- "$stage_root" || fail UNINSTALL_STAGE
mkdir -p -- "$stage_root/backup" || fail UNINSTALL_STAGE

q_runtime= q_state= q_unit= q_skill= q_env=
runtime_moved=0 state_moved=0 unit_moved=0 skill_moved=0 env_moved=0 service_changed=0
runtime_finalizing=0 state_finalizing=0 unit_finalizing=0 skill_finalizing=0 env_finalizing=0
was_active=0 was_enabled=0 rollback_required=0 transaction_active=0 preserve_recovery=0
reserve_and_move() {
  local target=$1 label=$2 container
  container=$(mktemp -d "$(dirname -- "$target")/.hc3-$label.XXXXXX" 2>/dev/null) || return 1
  if ! mv -- "$target" "$container/payload" >/dev/null 2>&1; then
    rmdir -- "$container" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s' "$container"
}
restore_one() {
  local moved=$1 quarantine=$2 backup=$3 target=$4 backup_only=$5
  ((moved)) || return 0
  rm -rf -- "$target" >/dev/null 2>&1 || return 1
  if ((backup_only)); then
    [[ -e $backup ]] || return 1
    cp -a -- "$backup" "$target" >/dev/null 2>&1 || return 1
  elif [[ -e $quarantine/payload ]]; then
    mv -- "$quarantine/payload" "$target" >/dev/null 2>&1 || return 1
  elif [[ -e $backup ]]; then
    cp -a -- "$backup" "$target" >/dev/null 2>&1 || return 1
  else
    return 1
  fi
  rm -rf -- "$quarantine" >/dev/null 2>&1 || true
}
restore_service_state() {
  local active_status enabled_status ok=0
  [[ -z $sandbox_root && $service_changed == 1 ]] || return 0
  systemctl daemon-reload >/dev/null 2>&1 || ok=1
  ((was_enabled == 0)) || systemctl enable hermes-codex-bridge.service >/dev/null 2>&1 || ok=1
  ((was_active == 0)) || systemctl start hermes-codex-bridge.service >/dev/null 2>&1 || ok=1
  set +e
  systemctl is-active --quiet hermes-codex-bridge.service >/dev/null 2>&1
  active_status=$?
  systemctl is-enabled --quiet hermes-codex-bridge.service >/dev/null 2>&1
  enabled_status=$?
  set -e
  if ((was_active)); then [[ $active_status == 0 ]] || ok=1; else [[ $active_status == 3 || $active_status == 4 ]] || ok=1; fi
  if ((was_enabled)); then [[ $enabled_status == 0 ]] || ok=1; else [[ $enabled_status == 1 || $enabled_status == 4 ]] || ok=1; fi
  return "$ok"
}
rollback_uninstall() {
  local ok=0
  [[ $test_rollback_failure != 1 ]] || return 1
  restore_one "$env_moved" "$q_env" "$stage_root/backup/env" "$env_file" "$env_finalizing" || ok=1
  restore_one "$skill_moved" "$q_skill" "$stage_root/backup/skill" "$skill_dir" "$skill_finalizing" || ok=1
  restore_one "$unit_moved" "$q_unit" "$stage_root/backup/unit" "$unit_file" "$unit_finalizing" || ok=1
  restore_one "$state_moved" "$q_state" "$stage_root/backup/state" "$state_root" "$state_finalizing" || ok=1
  restore_one "$runtime_moved" "$q_runtime" "$stage_root/backup/runtime" "$runtime_root" "$runtime_finalizing" || ok=1
  restore_service_state || ok=1
  return "$ok"
}
abort_uninstall() {
  local original_error=$1
  trap - EXIT
  if ((rollback_required)) && ! rollback_uninstall; then
    preserve_recovery=1
    printf '%s\n' UNINSTALL_ROLLBACK >&2
    exit 1
  fi
  rollback_required=0
  rm -rf -- "$stage_root" >/dev/null 2>&1 || true
  printf '%s\n' "$original_error" >&2
  exit 1
}
transaction_exit() {
  local status=$?
  trap - EXIT
  if ((status != 0 && rollback_required)) && ! rollback_uninstall >/dev/null 2>&1; then
    preserve_recovery=1
    printf '%s\n' UNINSTALL_ROLLBACK >&2
    status=1
  fi
  ((preserve_recovery)) || rm -rf -- "$stage_root" >/dev/null 2>&1 || true
  exit "$status"
}
trap transaction_exit EXIT

if [[ -z $sandbox_root ]]; then
  set +e
  systemctl is-active --quiet hermes-codex-bridge.service >/dev/null 2>&1
  active_status=$?
  systemctl is-enabled --quiet hermes-codex-bridge.service >/dev/null 2>&1
  enabled_status=$?
  set -e
  case "$active_status" in
    0) was_active=1 ;;
    3|4) ;;
    *) fail UNINSTALL_SYSTEMD ;;
  esac
  case "$enabled_status" in
    0) was_enabled=1 ;;
    1|4) ;;
    *) fail UNINSTALL_SYSTEMD ;;
  esac
fi

rollback_required=1
if [[ -z $sandbox_root ]]; then
  if ((was_active)); then
    service_changed=1
    systemctl stop hermes-codex-bridge.service >/dev/null 2>&1 || abort_uninstall UNINSTALL_SYSTEMD
  fi
  set +e
  systemctl is-active --quiet hermes-codex-bridge.service >/dev/null 2>&1
  active_status=$?
  set -e
  [[ $active_status == 3 || $active_status == 4 ]] || abort_uninstall UNINSTALL_SYSTEMD
fi

model_sandbox_service_stop() {
  [[ -n $sandbox_root ]] || return 0
  if [[ $test_fail_step == during_state_finalize ]]; then
    printf 'state-after-stop\0' > "$state_root/nested/state.bin" || return 1
  fi
}
model_sandbox_service_stop || abort_uninstall UNINSTALL_STAGE

validate_uninstall_paths "$hermes_home" "$env_file" "$sandbox_root" \
  "$runtime_root" "$state_root" "$skill_dir" "$unit_file" >/dev/null 2>&1 || abort_uninstall UNINSTALL_PREFLIGHT
verify_manifest >/dev/null 2>&1 || abort_uninstall UNINSTALL_PREFLIGHT
[[ ! -d $runtime_root ]] || cp -a -- "$runtime_root" "$stage_root/backup/runtime" >/dev/null 2>&1 || abort_uninstall UNINSTALL_STAGE
[[ ! -d $state_root ]] || cp -a -- "$state_root" "$stage_root/backup/state" >/dev/null 2>&1 || abort_uninstall UNINSTALL_STAGE
[[ ! -f $unit_file ]] || cp -a -- "$unit_file" "$stage_root/backup/unit" >/dev/null 2>&1 || abort_uninstall UNINSTALL_STAGE
[[ ! -d $skill_dir ]] || cp -a -- "$skill_dir" "$stage_root/backup/skill" >/dev/null 2>&1 || abort_uninstall UNINSTALL_STAGE
if ((remove_env)); then
  [[ ! -f $env_file ]] || cp -a -- "$env_file" "$stage_root/backup/env" >/dev/null 2>&1 || abort_uninstall UNINSTALL_STAGE
fi
validate_uninstall_paths "$hermes_home" "$env_file" "$sandbox_root" \
  "$runtime_root" "$state_root" "$skill_dir" "$unit_file" >/dev/null 2>&1 || abort_uninstall UNINSTALL_PREFLIGHT
verify_manifest >/dev/null 2>&1 || abort_uninstall UNINSTALL_PREFLIGHT

transaction_active=1
if [[ -z $sandbox_root && $was_enabled == 1 ]]; then
  service_changed=1
  systemctl disable hermes-codex-bridge.service >/dev/null 2>&1 || abort_uninstall UNINSTALL_SYSTEMD
  set +e
  systemctl is-enabled --quiet hermes-codex-bridge.service >/dev/null 2>&1
  enabled_status=$?
  set -e
  [[ $enabled_status == 1 || $enabled_status == 4 ]] || abort_uninstall UNINSTALL_SYSTEMD
fi

if [[ -d $runtime_root ]]; then q_runtime=$(reserve_and_move "$runtime_root" runtime) || abort_uninstall UNINSTALL_TRANSACTION; runtime_moved=1; fi
[[ $test_fail_step != after_first_quarantine ]] || abort_uninstall UNINSTALL_TRANSACTION
if [[ -d $state_root ]]; then q_state=$(reserve_and_move "$state_root" state) || abort_uninstall UNINSTALL_TRANSACTION; state_moved=1; fi
if [[ -f $unit_file ]]; then q_unit=$(reserve_and_move "$unit_file" unit) || abort_uninstall UNINSTALL_TRANSACTION; unit_moved=1; fi
if [[ -d $skill_dir ]]; then q_skill=$(reserve_and_move "$skill_dir" skill) || abort_uninstall UNINSTALL_TRANSACTION; skill_moved=1; fi
if ((remove_env)) && [[ -f $env_file ]]; then q_env=$(reserve_and_move "$env_file" env) || abort_uninstall UNINSTALL_TRANSACTION; env_moved=1; fi
if [[ $test_fail_step == after_quarantine || $test_fail_step == before_reload ]]; then abort_uninstall UNINSTALL_TRANSACTION; fi

if [[ -z $sandbox_root ]]; then
  systemctl daemon-reload >/dev/null 2>&1 || abort_uninstall UNINSTALL_SYSTEMD
fi
finalize_quarantine() {
  local quarantine=$1 finalizing_name=$2 label=$3 partial_file
  [[ -n $quarantine ]] || return 0
  printf -v "$finalizing_name" '%s' 1
  if [[ $test_fail_step == during_first_finalize || ( $test_fail_step == during_state_finalize && $label == state ) ]]; then
    partial_file=$(find "$quarantine/payload" -mindepth 2 -type f -print -quit 2>/dev/null) || true
    [[ -z $partial_file ]] || rm -f -- "$partial_file" >/dev/null 2>&1 || true
    return 1
  fi
  rm -rf -- "$quarantine" >/dev/null 2>&1
}
finalize_quarantine "$q_runtime" runtime_finalizing runtime || abort_uninstall UNINSTALL_TRANSACTION
finalize_quarantine "$q_state" state_finalizing state || abort_uninstall UNINSTALL_TRANSACTION
finalize_quarantine "$q_unit" unit_finalizing unit || abort_uninstall UNINSTALL_TRANSACTION
finalize_quarantine "$q_skill" skill_finalizing skill || abort_uninstall UNINSTALL_TRANSACTION
finalize_quarantine "$q_env" env_finalizing env || abort_uninstall UNINSTALL_TRANSACTION
transaction_active=0
rollback_required=0
printf '%s\n' UNINSTALL_OK
