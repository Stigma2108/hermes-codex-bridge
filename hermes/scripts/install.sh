#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

queue_root=
hermes_home=
env_file=
service_user=
sandbox_root=
apply=0
declare -A seen=()

while (($#)); do
  key=$1
  shift
  case "$key" in
    --apply)
      [[ -z ${seen[apply]+x} ]] || fail INSTALL_ARGS
      seen[apply]=1
      apply=1
      ;;
    --queue-root|--hermes-home|--env-file|--service-user|--sandbox-root)
      [[ -z ${seen[$key]+x} && $# -gt 0 && $1 != --* ]] || fail INSTALL_ARGS
      seen[$key]=1
      value=$1
      shift
      case "$key" in
        --queue-root) queue_root=$value ;;
        --hermes-home) hermes_home=$value ;;
        --env-file) env_file=$value ;;
        --service-user) service_user=$value ;;
        --sandbox-root) sandbox_root=$value ;;
      esac
      ;;
    *) fail INSTALL_ARGS ;;
  esac
done

[[ -n $queue_root && -n $hermes_home && -n $env_file ]] || fail INSTALL_ARGS
if [[ -z $service_user ]]; then
  service_user=$([[ -n $sandbox_root ]] && printf '%s' hc3sandbox || printf '%s' hermes)
fi
[[ $service_user =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail CONFIG_PATH_CHARSET
[[ $service_user != root ]] || fail INSTALL_USER

check_path_value() {
  local value=$1
  [[ $value == /* ]] || fail INSTALL_PATH
  [[ $value =~ ^[A-Za-z0-9._/+:-]+$ ]] || fail CONFIG_PATH_CHARSET
  [[ $value != / && $value != *//* && $value != */ && $value != */../* && $value != */.. && $value != */./* && $value != */. ]] || fail INSTALL_PATH
}

check_path_value "$queue_root"
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
[[ -n $python_bin ]] || fail INSTALL_PYTHON

validate_install_paths() {
"$python_bin" - "$@" <<'PY'
import os
import stat
import sys

queue, home, env_file, sandbox, runtime, state, skill, unit = sys.argv[1:]
reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

def fail(code):
    print(code, file=sys.stderr)
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
    if not path:
        return
    chain = components(path)
    leaf_exists = False
    for index, component in enumerate(chain):
        try:
            info = os.lstat(component)
        except FileNotFoundError:
            continue
        except OSError:
            fail("INSTALL_UNSAFE")
        is_leaf = index == len(chain) - 1
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse:
            fail("INSTALL_UNSAFE")
        if not is_leaf and not stat.S_ISDIR(info.st_mode):
            fail("INSTALL_UNSAFE")
        if is_leaf:
            leaf_exists = True
            expected = stat.S_ISDIR(info.st_mode) if leaf_kind == "directory" else stat.S_ISREG(info.st_mode)
            if not expected:
                fail("INSTALL_UNSAFE")
    if required and not leaf_exists:
        fail("INSTALL_UNSAFE")

def normalized(path):
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))

def overlaps(first, second):
    if not first or not second:
        return False
    first, second = normalized(first), normalized(second)
    try:
        common = os.path.commonpath((first, second))
    except ValueError:
        return False
    return common == first or common == second

validate(queue, "directory", True)
validate(home, "directory", True)
validate(env_file, "file", True)
validate(sandbox, "directory", False)
validate(runtime, "directory", False)
validate(state, "directory", False)
validate(skill, "directory", False)
validate(unit, "file", False)

recursive = (runtime, state)
preserved = (queue, home)
removable_except_skill = (runtime, state, unit, env_file)
if any(overlaps(owned, keep) for owned in removable_except_skill for keep in preserved):
    fail("INSTALL_OVERLAP")
if overlaps(queue, skill):
    fail("INSTALL_OVERLAP")
env_is_unit = bool(unit) and normalized(env_file) == normalized(unit)
if any(overlaps(env_file, owned) for owned in recursive) or overlaps(env_file, skill) or env_is_unit:
    fail("INSTALL_OVERLAP")
PY
}

validate_install_paths "$queue_root" "$hermes_home" "$env_file" "$sandbox_root" '' '' '' '' || exit $?

system_name=$(uname -s)
if [[ $system_name == Linux ]]; then
  mode=$(stat -c '%a' -- "$env_file" 2>/dev/null) || fail INSTALL_ENV_FILE
  [[ $mode == 600 ]] || fail INSTALL_ENV_MODE
fi

"$python_bin" - "$env_file" <<'PY' || exit $?
import re
import sys

def fail():
    print("INSTALL_ENV_CONTENT", file=sys.stderr)
    raise SystemExit(2)

try:
    raw = open(sys.argv[1], "rb").read(16385)
    if len(raw) > 16384:
        fail()
    lines = raw.decode("utf-8").splitlines()
except (OSError, UnicodeError):
    fail()

values = {}
for line in lines:
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        fail()
    key, value = line.split("=", 1)
    if key in values:
        fail()
    values[key] = value
token = values.get("HERMES_TELEGRAM_TOKEN", "")
chat_id = values.get("HERMES_TELEGRAM_CHAT_ID", "")
if not token or not re.fullmatch(r"[1-9][0-9]{0,18}", chat_id):
    fail()
PY

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

validate_install_paths "$queue_root" "$hermes_home" "$env_file" "$sandbox_root" \
  "$runtime_root" "$state_root" "$skill_dir" "$unit_file" || exit $?

if ((apply == 0)); then
  printf '%s\n' \
    'PLAN install hermes-codex-bridge-v3' \
    'TARGET runtime' \
    'TARGET state' \
    'TARGET system-unit' \
    'TARGET hermes-skill' \
    'CONFIG queue-root [redacted]' \
    'CONFIG env-file [redacted]' \
    'RUN staged-tests' \
    'RUN installed-tests'
  if [[ -n $sandbox_root ]]; then
    printf '%s\n' 'RUN systemd-enable [sandbox:no]'
  else
    printf '%s\n' 'RUN systemd-enable [production:yes]'
  fi
  exit 0
fi

if [[ -z $sandbox_root ]]; then
  [[ $system_name == Linux ]] || fail INSTALL_PLATFORM
  [[ ${EUID:-$(id -u)} -eq 0 ]] || fail INSTALL_PRIVILEGE
fi

verify_install_provenance() {
"$python_bin" - "$runtime_root/install-manifest.json" "$env_file" "$hermes_home" "$service_user" \
  "$runtime_root" "$state_root" "$unit_file" "$skill_dir" "$sandbox_root" <<'PY'
import json, os, re, stat, sys
manifest, env_file, home, user, runtime, state, unit, skill, sandbox = sys.argv[1:]
reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
def conflict():
    print("INSTALL_OWNERSHIP_CONFLICT", file=sys.stderr); raise SystemExit(2)
def norm(path): return os.path.normcase(os.path.normpath(os.path.abspath(path)))
live = (runtime, state, unit, skill)
if not any(os.path.lexists(path) for path in live): raise SystemExit(0)
try: info = os.lstat(manifest)
except OSError: conflict()
if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse or info.st_size > 16384: conflict()
if not sandbox and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600): conflict()
try:
    with open(manifest, encoding="utf-8") as stream: value = json.load(stream)
except (OSError, UnicodeError, json.JSONDecodeError): conflict()
targets = {"runtime_root": norm(runtime), "state_root": norm(state), "unit_file": norm(unit), "skill_dir": norm(skill)}
if not isinstance(value, dict) or set(value) != {"schema", "env_file", "hermes_home", "service_user", "targets"}: conflict()
if value.get("schema") != "hermes-codex-install-manifest/v3" or value.get("env_file") != norm(env_file) or value.get("hermes_home") != norm(home) or value.get("service_user") != user or value.get("targets") != targets: conflict()
PY
}

verify_install_provenance || exit $?

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_root=$(cd -- "$script_dir/.." && pwd -P)
service_template=$source_root/templates/hermes-codex-bridge.service.in
skill_template=$source_root/templates/SKILL.md.in
[[ -f $service_template && ! -L $service_template && -f $skill_template && ! -L $skill_template ]] || fail INSTALL_SOURCE

[[ $python_bin =~ ^[A-Za-z0-9._/+:-]+$ ]] || fail CONFIG_PATH_CHARSET

service_uid=
service_gid=
validate_production_identity() {
  [[ -z $sandbox_root ]] || return 0
  command -v runuser >/dev/null 2>&1 || return 1
  service_uid=$(id -u "$service_user" 2>/dev/null) || return 1
  service_gid=$(id -g "$service_user" 2>/dev/null) || return 1
  [[ $service_uid =~ ^[0-9]+$ && $service_uid -ne 0 ]] || return 1
  local owner mode
  owner=$(stat -c '%u' -- "$env_file" 2>/dev/null) || return 1
  mode=$(stat -c '%a' -- "$env_file" 2>/dev/null) || return 1
  [[ $owner == "$service_uid" && $mode == 600 ]] || return 1
  runuser -u "$service_user" -- test -r "$env_file" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -d "$queue_root" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -r "$queue_root" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -x "$queue_root" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -w "$queue_root" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -d "$queue_root/interactions" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -r "$queue_root/interactions" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -x "$queue_root/interactions" >/dev/null 2>&1 || return 1
  runuser -u "$service_user" -- test -w "$queue_root/interactions" >/dev/null 2>&1 || return 1
}

if [[ -z $sandbox_root ]]; then
  validate_production_identity || fail INSTALL_USER
else
  service_uid=$(id -u 2>/dev/null || printf '%s' 0)
  service_gid=$(id -g 2>/dev/null || printf '%s' 0)
fi

test_fail_step=${HC3_TEST_FAIL_STEP:-}
if [[ -n $test_fail_step ]]; then
  [[ -n $sandbox_root ]] || fail INSTALL_TEST_HOOK
  case "$test_fail_step" in
    preflight|installed_tests|after_runtime|after_unit|after_skill) ;;
    *) fail INSTALL_TEST_HOOK ;;
  esac
fi

stage_base=$([[ -n $sandbox_root ]] && printf '%s' "${TMPDIR:-/tmp}" || printf '%s' /var/tmp)
stage_root=$(mktemp -d "$stage_base/hermes-codex-bridge.XXXXXX" 2>/dev/null) || fail INSTALL_STAGE
trap 'rm -rf -- "$stage_root"' EXIT
chmod 0700 -- "$stage_root" || fail INSTALL_STAGE
if [[ -z $sandbox_root ]]; then
  [[ $(stat -c '%u' -- "$stage_root" 2>/dev/null) == 0 && $(stat -c '%a' -- "$stage_root" 2>/dev/null) == 700 ]] || fail INSTALL_STAGE
fi
mkdir -p -- "$stage_root/runtime" "$stage_root/backup" || fail INSTALL_STAGE

runtime_files=(contracts.py inbound.py telegram.py watcher.py test_contracts.py test_inbound.py test_watcher.py)
source_files=("$service_template" "$skill_template")
for name in "${runtime_files[@]}"; do source_files+=("$source_root/$name"); done
"$python_bin" - "$sandbox_root" "${source_files[@]}" <<'PY' || exit $?
import os, stat, sys
sandbox, *paths = sys.argv[1:]
reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
for path in paths:
    current = os.path.abspath(path); chain = []
    while True:
        chain.append(current); parent = os.path.dirname(current)
        if parent == current: break
        current = parent
    for component in reversed(chain):
        try: info = os.lstat(component)
        except OSError:
            print("SOURCE_TRUST", file=sys.stderr); raise SystemExit(2)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse or (not sandbox and stat.S_IMODE(info.st_mode) & 0o022):
            print("SOURCE_TRUST", file=sys.stderr); raise SystemExit(2)
PY
mkdir -p -- "$stage_root/source" || fail INSTALL_STAGE
copy_source_file() {
  local source=$1 destination=$2
  if [[ -n $sandbox_root ]]; then
    install -m 0644 -- "$source" "$destination" >/dev/null 2>&1
  else
    runuser -u "$service_user" -- cat -- "$source" > "$destination" 2>/dev/null && chmod 0644 -- "$destination"
  fi
}
copy_source_file "$service_template" "$stage_root/source/service.in" || fail INSTALL_STAGE
copy_source_file "$skill_template" "$stage_root/source/SKILL.in" || fail INSTALL_STAGE
for name in "${runtime_files[@]}"; do
  [[ -f $source_root/$name && ! -L $source_root/$name ]] || fail INSTALL_SOURCE
  copy_source_file "$source_root/$name" "$stage_root/runtime/$name" || fail INSTALL_STAGE
done

"$python_bin" - "$stage_root/source/service.in" "$stage_root/unit" "$stage_root/source/SKILL.in" "$stage_root/SKILL.md" \
  "$stage_root/runtime/install-manifest.json" "$service_user" "$runtime_root" "$queue_root" \
  "$state_root" "$env_file" "$python_bin" "$hermes_home" "$unit_file" "$skill_dir" <<'PY' || exit $?
import json
import os
import re
import sys

service_source, service_output, skill_source, skill_output, manifest_output, user, runtime, queue, state, env_file, python, home, unit, skill = sys.argv[1:]
values = {
    "@SERVICE_USER@": user,
    "@RUNTIME_ROOT@": runtime,
    "@QUEUE_ROOT@": queue,
    "@STATE_ROOT@": state,
    "@ENV_FILE@": env_file,
    "@PYTHON@": python,
}
for value in values.values():
    if "\r" in value or "\n" in value:
        print("INSTALL_PATH", file=sys.stderr)
        raise SystemExit(2)

def render(source, output):
    text = open(source, encoding="utf-8").read()
    for token, value in values.items():
        text = text.replace(token, value)
    if re.search(r"@[A-Z_]+@", text):
        print("INSTALL_TEMPLATE", file=sys.stderr)
        raise SystemExit(2)
    with open(output, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)

render(service_source, service_output)
render(skill_source, skill_output)
manifest = {
    "schema": "hermes-codex-install-manifest/v3",
    "env_file": os.path.normcase(os.path.normpath(os.path.abspath(env_file))),
    "hermes_home": os.path.normcase(os.path.normpath(os.path.abspath(home))),
    "service_user": user,
    "targets": {
        "runtime_root": os.path.normcase(os.path.normpath(os.path.abspath(runtime))),
        "state_root": os.path.normcase(os.path.normpath(os.path.abspath(state))),
        "unit_file": os.path.normcase(os.path.normpath(os.path.abspath(unit))),
        "skill_dir": os.path.normcase(os.path.normpath(os.path.abspath(skill))),
    },
}
with open(manifest_output, "x", encoding="utf-8", newline="\n") as stream:
    json.dump(manifest, stream, ensure_ascii=True, sort_keys=True, indent=2)
    stream.write("\n")
PY
chmod 0600 -- "$stage_root/runtime/install-manifest.json" || fail INSTALL_STAGE
chmod 0644 -- "$stage_root/unit" "$stage_root/SKILL.md" || fail INSTALL_STAGE
(cd -- "$stage_root/runtime" && PYTHONDONTWRITEBYTECODE=1 "$python_bin" -m unittest discover -s . -p 'test_*.py' -v >/dev/null 2>&1) || fail INSTALL_TESTS

validate_install_paths "$queue_root" "$hermes_home" "$env_file" "$sandbox_root" \
  "$runtime_root" "$state_root" "$skill_dir" "$unit_file" || exit $?
[[ -n $sandbox_root ]] || validate_production_identity || fail INSTALL_USER
verify_install_provenance || exit $?
[[ $test_fail_step != preflight ]] || fail INSTALL_PREFLIGHT

had_runtime=0
had_unit=0
had_skill_dir=0
had_state=0
state_mode=
state_uid=
state_gid=
was_active=0
was_enabled=0
runtime_changed=0
unit_changed=0
skill_changed=0
state_changed=0
service_changed=0
if [[ -d $runtime_root ]]; then
  cp -a -- "$runtime_root" "$stage_root/backup/runtime" >/dev/null 2>&1 || fail INSTALL_STAGE
  had_runtime=1
fi
if [[ -f $unit_file ]]; then
  cp -a -- "$unit_file" "$stage_root/backup/unit" >/dev/null 2>&1 || fail INSTALL_STAGE
  had_unit=1
fi
if [[ -d $skill_dir ]]; then
  cp -a -- "$skill_dir" "$stage_root/backup/skill" >/dev/null 2>&1 || fail INSTALL_STAGE
  had_skill_dir=1
fi
if [[ -d $state_root ]]; then
  had_state=1
  if [[ -z $sandbox_root ]]; then
    state_mode=$(stat -c '%a' -- "$state_root" 2>/dev/null) || fail INSTALL_STAGE
    state_uid=$(stat -c '%u' -- "$state_root" 2>/dev/null) || fail INSTALL_STAGE
    state_gid=$(stat -c '%g' -- "$state_root" 2>/dev/null) || fail INSTALL_STAGE
  fi
fi

remove_live_skill() {
  if [[ -n $sandbox_root ]]; then
    rm -rf -- "$skill_dir" >/dev/null 2>&1
  else
    runuser -u "$service_user" -- rm -rf -- "$skill_dir" >/dev/null 2>&1
  fi
}

install_live_skill() {
  local payload=$1
  if [[ -n $sandbox_root ]]; then
    mkdir -p -- "$skill_dir" >/dev/null 2>&1 || return 1
    install -m 0644 -- "$payload" "$skill_file" >/dev/null 2>&1
  else
    runuser -u "$service_user" -- mkdir -p -- "$skill_dir" >/dev/null 2>&1 || return 1
    runuser -u "$service_user" -- install -m 0644 /dev/stdin "$skill_file" < "$payload" >/dev/null 2>&1
  fi
}

restore_live_skill_tree() {
  local backup=$1
  if [[ -n $sandbox_root ]]; then
    mkdir -p -- "$(dirname -- "$skill_dir")" >/dev/null 2>&1 || return 1
    cp -a -- "$backup" "$skill_dir" >/dev/null 2>&1
  else
    runuser -u "$service_user" -- mkdir -p -- "$skill_dir" >/dev/null 2>&1 || return 1
    tar -C "$backup" -cf - . 2>/dev/null | \
      runuser -u "$service_user" -- tar -C "$skill_dir" -xf - >/dev/null 2>&1
  fi
}

rollback_install() {
  local rollback_ok=0
  if [[ -z $sandbox_root && $service_changed == 1 ]]; then
    systemctl stop hermes-codex-bridge.service >/dev/null 2>&1 || true
  fi
  if ((runtime_changed)); then
    rm -rf -- "$runtime_root" >/dev/null 2>&1 || rollback_ok=1
    if ((had_runtime)); then
      cp -a -- "$stage_root/backup/runtime" "$runtime_root" >/dev/null 2>&1 || rollback_ok=1
    fi
  fi
  if ((unit_changed)); then
    rm -f -- "$unit_file" >/dev/null 2>&1 || rollback_ok=1
    if ((had_unit)); then
      install -m 0644 -- "$stage_root/backup/unit" "$unit_file" >/dev/null 2>&1 || rollback_ok=1
    fi
  fi
  if ((skill_changed)); then
    remove_live_skill || rollback_ok=1
    if ((had_skill_dir)); then
      restore_live_skill_tree "$stage_root/backup/skill" || rollback_ok=1
    fi
  fi
  if ((state_changed)); then
    if ((had_state == 0)); then
      rm -rf -- "$state_root" >/dev/null 2>&1 || rollback_ok=1
    elif [[ -z $sandbox_root ]]; then
      chown "$state_uid:$state_gid" -- "$state_root" >/dev/null 2>&1 || rollback_ok=1
      chmod "$state_mode" -- "$state_root" >/dev/null 2>&1 || rollback_ok=1
    fi
  fi
  if [[ -z $sandbox_root && $service_changed == 1 ]]; then
    systemctl daemon-reload >/dev/null 2>&1 || rollback_ok=1
    if ((was_enabled)); then
      systemctl enable hermes-codex-bridge.service >/dev/null 2>&1 || rollback_ok=1
    else
      systemctl disable hermes-codex-bridge.service >/dev/null 2>&1 || true
    fi
    if ((was_active)); then
      systemctl start hermes-codex-bridge.service >/dev/null 2>&1 || rollback_ok=1
    fi
  fi
  return "$rollback_ok"
}

maybe_test_fail() {
  [[ $test_fail_step != "$1" ]]
}

commit_install() {
  validate_install_paths "$queue_root" "$hermes_home" "$env_file" "$sandbox_root" \
    "$runtime_root" "$state_root" "$skill_dir" "$unit_file" || return 1
  [[ -n $sandbox_root ]] || validate_production_identity || return 1
  runtime_changed=1
  rm -rf -- "$runtime_root" >/dev/null 2>&1 || return 1
  mkdir -p -- "$(dirname -- "$runtime_root")" >/dev/null 2>&1 || return 1
  cp -a -- "$stage_root/runtime" "$runtime_root" >/dev/null 2>&1 || return 1
  chmod 0755 -- "$runtime_root" >/dev/null 2>&1 || return 1
  chmod 0600 -- "$runtime_root/install-manifest.json" >/dev/null 2>&1 || return 1
  if [[ -z $sandbox_root ]]; then
    chown -R root:root -- "$runtime_root" >/dev/null 2>&1 || return 1
  fi
  if [[ $test_fail_step == installed_tests ]]; then
    "$python_bin" - "$runtime_root/test_hc3_injected_failure.py" <<'PY' >/dev/null 2>&1 || return 1
import sys
with open(sys.argv[1], "x", encoding="ascii", newline="\n") as stream:
    stream.write("import unittest\nclass InjectedFailure(unittest.TestCase):\n    def test_failure(self): self.fail('injected')\n")
PY
  fi
  if [[ -n $sandbox_root ]]; then
    (cd -- "$runtime_root" && PYTHONDONTWRITEBYTECODE=1 "$python_bin" -m unittest discover -s . -p 'test_*.py' -v >/dev/null 2>&1) || return 1
  else
    runuser -u "$service_user" -- env PYTHONDONTWRITEBYTECODE=1 "$python_bin" -m unittest discover -s "$runtime_root" -p 'test_*.py' -v >/dev/null 2>&1 || return 1
  fi
  maybe_test_fail after_runtime || return 1

  unit_changed=1
  mkdir -p -- "$(dirname -- "$unit_file")" >/dev/null 2>&1 || return 1
  install -m 0644 -- "$stage_root/unit" "$unit_file" >/dev/null 2>&1 || return 1
  if [[ -z $sandbox_root ]]; then
    chown root:root -- "$unit_file" >/dev/null 2>&1 || return 1
  fi
  maybe_test_fail after_unit || return 1

  skill_changed=1
  remove_live_skill || return 1
  install_live_skill "$stage_root/SKILL.md" || return 1
  maybe_test_fail after_skill || return 1

  state_changed=1
  if [[ ! -d $state_root ]]; then
    mkdir -p -- "$state_root" >/dev/null 2>&1 || return 1
  fi
  if [[ -n $sandbox_root ]]; then
    chmod 0700 -- "$state_root" >/dev/null 2>&1 || return 1
  else
    chown root:"$service_gid" -- "$state_root" >/dev/null 2>&1 || return 1
    chmod 0770 -- "$state_root" >/dev/null 2>&1 || return 1
    validate_install_paths "$queue_root" "$hermes_home" "$env_file" "$sandbox_root" \
      "$runtime_root" "$state_root" "$skill_dir" "$unit_file" || return 1
    validate_production_identity || return 1
    service_changed=1
    systemctl daemon-reload >/dev/null 2>&1 || return 1
    systemctl enable --now hermes-codex-bridge.service >/dev/null 2>&1 || return 1
    systemctl is-active --quiet hermes-codex-bridge.service || return 1
  fi
}

transaction_active=0
transaction_exit() {
  local status=$?
  trap - EXIT
  if ((transaction_active)); then
    rollback_install >/dev/null 2>&1 || true
  fi
  rm -rf -- "$stage_root" >/dev/null 2>&1 || true
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
    *) fail INSTALL_SYSTEMD ;;
  esac
  case "$enabled_status" in
    0) was_enabled=1 ;;
    1|4) ;;
    *) fail INSTALL_SYSTEMD ;;
  esac
fi

verify_install_provenance || exit $?
transaction_active=1
if [[ -z $sandbox_root && $was_active == 1 ]]; then
  service_changed=1
  systemctl stop hermes-codex-bridge.service >/dev/null 2>&1 || fail INSTALL_SYSTEMD
  set +e
  systemctl is-active --quiet hermes-codex-bridge.service >/dev/null 2>&1
  active_status=$?
  set -e
  [[ $active_status == 3 || $active_status == 4 ]] || fail INSTALL_SYSTEMD
fi

if ! commit_install; then
  transaction_active=0
  if ! rollback_install; then
    fail INSTALL_ROLLBACK
  fi
  fail INSTALL_TRANSACTION
fi
transaction_active=0
printf '%s\n' INSTALL_OK
