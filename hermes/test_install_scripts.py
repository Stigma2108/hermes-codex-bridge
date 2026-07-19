import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BASH = shutil.which("bash")
HERE = Path(__file__).resolve().parent
INSTALL = HERE / "scripts" / "install.sh"
UNINSTALL = HERE / "scripts" / "uninstall.sh"


@unittest.skipUnless(os.name == "posix" and BASH, "POSIX bash is required for lifecycle script tests")
class LifecycleScriptsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.queue = self.root / "Queue" / "bridge" / "v3"
        (self.queue / "interactions").mkdir(parents=True)
        self.hermes_home = self.root / "hermes-home"
        self.hermes_home.mkdir()
        self.unrelated_skill = self.hermes_home / "skills" / "unrelated" / "SKILL.md"
        self.unrelated_skill.parent.mkdir(parents=True)
        self.unrelated_skill.write_text("keep\n", encoding="utf-8")
        self.env_file = self.root / "bridge.env"
        self.secret_token = "synthetic_placeholder_token_never_log_7f31"
        self.env_file.write_text(
            f"HERMES_TELEGRAM_TOKEN={self.secret_token}\n"
            "HERMES_TELEGRAM_CHAT_ID=123456789\n",
            encoding="ascii",
        )
        os.chmod(self.env_file, 0o600)
        self.sandbox = self.root / "sandbox"

    def tearDown(self):
        self.temporary.cleanup()

    def bash_path(self, path):
        path = os.path.abspath(os.fspath(path))
        if os.name != "nt":
            return path
        result = subprocess.run(
            [BASH, "-lc", 'cygpath -u "$1"', "bash", path],
            text=True,
            capture_output=True,
            check=True,
            timeout=15,
        )
        return result.stdout.strip()

    def rendered_path(self, path):
        value = str(Path(path).resolve())
        return value.replace("\\", "/") if os.name == "nt" else value

    def manifest_path(self, path):
        return os.path.normcase(os.path.normpath(os.path.abspath(os.fspath(path))))

    def install_args(self, *extra, apply=False, env_file=None, queue=None):
        args = [
            self.bash_path(INSTALL),
            "--queue-root", self.bash_path(queue or self.queue),
            "--hermes-home", self.bash_path(self.hermes_home),
            "--env-file", self.bash_path(env_file or self.env_file),
            "--sandbox-root", self.bash_path(self.sandbox),
        ]
        if apply:
            args.append("--apply")
        args.extend(extra)
        return args

    def uninstall_args(self, *extra, apply=False, hermes_home=None, env_file=None, sandbox=None):
        args = [
            self.bash_path(UNINSTALL),
            "--hermes-home", self.bash_path(hermes_home or self.hermes_home),
            "--env-file", self.bash_path(env_file or self.env_file),
            "--sandbox-root", self.bash_path(sandbox or self.sandbox),
        ]
        if apply:
            args.append("--apply")
        args.extend(extra)
        return args

    def run_bash(self, args, extra_env=None):
        result = subprocess.run(
            [BASH, *args],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **(extra_env or {})},
            timeout=45,
        )
        self.assertNotIn(self.secret_token, result.stdout + result.stderr)
        self.assertNotIn("123456789", result.stdout + result.stderr)
        return result

    @property
    def runtime(self):
        return self.sandbox / "opt" / "hermes-codex-bridge-v3"

    @property
    def state(self):
        return self.sandbox / "var" / "lib" / "hermes-codex-bridge-v3"

    @property
    def unit(self):
        return self.sandbox / "etc" / "systemd" / "system" / "hermes-codex-bridge.service"

    @property
    def skill(self):
        return self.hermes_home / "skills" / "hermes-codex-telegram-reply-v3" / "SKILL.md"

    @property
    def manifest(self):
        return self.runtime / "install-manifest.json"

    def test_plan_is_redacted_and_does_not_mutate_targets(self):
        result = self.run_bash(self.install_args())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "PLAN install hermes-codex-bridge-v3",
                "TARGET runtime",
                "TARGET state",
                "TARGET system-unit",
                "TARGET hermes-skill",
                "CONFIG queue-root [redacted]",
                "CONFIG env-file [redacted]",
                "RUN staged-tests",
                "RUN installed-tests",
                "RUN systemd-enable [sandbox:no]",
            ],
        )
        self.assertFalse(self.sandbox.exists())
        self.assertFalse(self.skill.exists())

    def test_non_sandbox_plan_is_read_only_and_does_not_require_mutation_privileges(self):
        install = self.run_bash([
            self.bash_path(INSTALL),
            "--queue-root", self.bash_path(self.queue),
            "--hermes-home", self.bash_path(self.hermes_home),
            "--env-file", self.bash_path(self.env_file),
        ])
        uninstall = self.run_bash([
            self.bash_path(UNINSTALL),
            "--hermes-home", self.bash_path(self.hermes_home),
            "--env-file", self.bash_path(self.env_file),
        ])
        self.assertEqual(install.returncode, 0, install.stderr)
        self.assertEqual(uninstall.returncode, 0, uninstall.stderr)
        self.assertIn("RUN systemd-enable [production:yes]", install.stdout)
        self.assertIn("RUN systemd-disable [production:yes]", uninstall.stdout)
        self.assertTrue(self.env_file.exists())

    def test_apply_twice_renders_exact_configuration_and_installed_tests_pass(self):
        for _ in range(2):
            result = self.run_bash(self.install_args(apply=True))
            self.assertEqual(result.returncode, 0, result.stderr)

        unit = self.unit.read_text(encoding="utf-8")
        skill = self.skill.read_text(encoding="utf-8")
        queue = self.rendered_path(self.queue)
        runtime = self.rendered_path(self.runtime)
        env_file = self.rendered_path(self.env_file)
        interactions = f"{queue}/interactions"
        self.assertIn(f"ReadWritePaths={queue} {self.rendered_path(self.state)}", unit)
        self.assertIn("WantedBy=multi-user.target", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn("User=hc3sandbox", unit)
        self.assertNotIn("Group=", unit)
        self.assertNotIn("@", unit)
        self.assertNotIn(self.secret_token, unit + skill)
        self.assertIn(interactions, skill)
        self.assertIn(f"{runtime}/inbound.py", skill)
        self.assertIn(env_file, skill)
        self.assertNotIn("@", skill)
        self.assertEqual([path.name for path in self.skill.parent.iterdir()], ["SKILL.md"])

        tests = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", str(self.runtime), "-p", "test_*.py", "-v"],
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            timeout=30,
        )
        self.assertEqual(tests.returncode, 0, tests.stdout + tests.stderr)

        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "hermes-codex-install-manifest/v3")
        self.assertEqual(manifest["env_file"], self.manifest_path(self.env_file))
        self.assertEqual(manifest["hermes_home"], self.manifest_path(self.hermes_home))
        self.assertEqual(manifest["service_user"], "hc3sandbox")
        self.assertEqual(manifest["targets"]["runtime_root"], self.manifest_path(self.runtime))
        self.assertEqual(manifest["targets"]["unit_file"], self.manifest_path(self.unit))
        if os.name != "nt":
            self.assertEqual(self.manifest.stat().st_mode & 0o777, 0o600)

    def test_uninstall_requires_matching_valid_ownership_manifest(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        unrelated_env = self.root / "unrelated.env"
        unrelated_env.write_text(
            "HERMES_TELEGRAM_TOKEN=unrelated_placeholder\n"
            "HERMES_TELEGRAM_CHAT_ID=111222333\n",
            encoding="ascii",
        )
        os.chmod(unrelated_env, 0o600)

        mismatch = self.run_bash(self.uninstall_args(apply=True, env_file=unrelated_env))
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertEqual(mismatch.stderr, "UNINSTALL_OWNERSHIP_UNVERIFIED\n")
        self.assertTrue(unrelated_env.exists())
        self.assertTrue(self.env_file.exists())
        self.assertTrue(self.runtime.exists())
        self.assertNotIn("unrelated_placeholder", mismatch.stdout + mismatch.stderr)

        original = self.manifest.read_bytes()
        self.manifest.write_text('{"schema":"tampered"}\n', encoding="ascii")
        tampered = self.run_bash(self.uninstall_args(apply=True))
        self.assertNotEqual(tampered.returncode, 0)
        self.assertEqual(tampered.stderr, "UNINSTALL_OWNERSHIP_UNVERIFIED\n")
        self.assertTrue(self.env_file.exists())
        self.assertTrue(self.unit.exists())

        self.manifest.write_bytes(original)
        self.manifest.unlink()
        missing = self.run_bash(self.uninstall_args(apply=True))
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stderr, "UNINSTALL_OWNERSHIP_UNVERIFIED\n")
        self.assertTrue(self.env_file.exists())
        self.assertTrue(self.runtime.exists())

    def test_uninstall_never_claims_an_unmanifested_env_file(self):
        result = self.run_bash(self.uninstall_args("--remove-env", apply=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "UNINSTALL_OWNERSHIP_UNVERIFIED\n")
        self.assertTrue(self.env_file.exists())
        self.assertFalse(self.runtime.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")

    def test_injected_failure_rolls_back_prior_owned_install(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        marker = self.runtime / "prior-owned-marker"
        marker.write_text("prior\n", encoding="ascii")
        self.skill.write_text("prior skill bytes\n", encoding="ascii")
        extra = self.skill.parent / "nested" / "extra.bin"
        extra.parent.mkdir()
        extra.write_bytes(b"\x00prior-extra\xff")
        before = {
            "unit": self.unit.read_bytes(),
            "skill": self.skill.read_bytes(),
            "extra": extra.read_bytes(),
            "manifest": self.manifest.read_bytes(),
        }

        failed = self.run_bash(
            self.install_args(apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "after_skill"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr.splitlines()[-1], "INSTALL_TRANSACTION")
        self.assertEqual(marker.read_text(encoding="ascii"), "prior\n")
        self.assertEqual(self.unit.read_bytes(), before["unit"])
        self.assertEqual(self.skill.read_bytes(), before["skill"])
        self.assertEqual(extra.read_bytes(), before["extra"])
        self.assertEqual(self.manifest.read_bytes(), before["manifest"])
        self.assertTrue(self.env_file.exists())

    def test_installed_runtime_test_failure_rolls_back_live_copy(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        marker = self.runtime / "prior-runtime-marker"
        marker.write_text("restore me\n", encoding="ascii")
        before_manifest = self.manifest.read_bytes()

        failed = self.run_bash(
            self.install_args(apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "installed_tests"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr.splitlines()[-1], "INSTALL_TRANSACTION")
        self.assertEqual(marker.read_text(encoding="ascii"), "restore me\n")
        self.assertEqual(self.manifest.read_bytes(), before_manifest)
        self.assertFalse((self.runtime / "test_hc3_injected_failure.py").exists())

    def test_injected_failure_leaves_no_partial_fresh_install(self):
        failed = self.run_bash(
            self.install_args(apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "after_skill"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr.splitlines()[-1], "INSTALL_TRANSACTION")
        for target in (self.runtime, self.state, self.unit, self.skill.parent, self.manifest):
            self.assertFalse(target.exists(), target)
        self.assertTrue(self.env_file.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")

    def test_unmanifested_live_targets_are_never_adopted(self):
        runtime_marker = self.runtime / "nested" / "marker.bin"
        state_marker = self.state / "marker.bin"
        skill_marker = self.skill.parent / "nested" / "marker.bin"
        for marker, payload in (
            (runtime_marker, b"runtime\x00marker"),
            (state_marker, b"state\x00marker"),
            (skill_marker, b"skill\x00marker"),
        ):
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_bytes(payload)
        self.unit.parent.mkdir(parents=True, exist_ok=True)
        self.unit.write_bytes(b"unowned unit\n")
        before = {
            runtime_marker: runtime_marker.read_bytes(),
            state_marker: state_marker.read_bytes(),
            skill_marker: skill_marker.read_bytes(),
            self.unit: self.unit.read_bytes(),
        }

        result = self.run_bash(self.install_args(apply=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "INSTALL_OWNERSHIP_CONFLICT\n")
        for path, payload in before.items():
            self.assertEqual(path.read_bytes(), payload)
        self.assertFalse(self.manifest.exists())
        self.assertTrue(self.env_file.exists())

    def test_preflight_failure_is_unarmed_and_preserves_prior_install(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        marker = self.runtime / "preflight-marker"
        marker.write_text("unchanged\n", encoding="ascii")
        before = (self.unit.read_bytes(), self.skill.read_bytes(), self.manifest.read_bytes())
        failed = self.run_bash(
            self.install_args(apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "preflight"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr, "INSTALL_PREFLIGHT\n")
        self.assertEqual(marker.read_text(encoding="ascii"), "unchanged\n")
        self.assertEqual((self.unit.read_bytes(), self.skill.read_bytes(), self.manifest.read_bytes()), before)

    def test_uninstall_quarantine_failure_restores_every_owned_target_and_retries(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        state_marker = self.state / "state-marker.bin"
        skill_extra = self.skill.parent / "extra.bin"
        state_marker.write_bytes(b"state-before")
        skill_extra.write_bytes(b"skill-before")
        before = {
            self.runtime / "install-manifest.json": self.manifest.read_bytes(),
            self.unit: self.unit.read_bytes(),
            self.skill: self.skill.read_bytes(),
            skill_extra: skill_extra.read_bytes(),
            state_marker: state_marker.read_bytes(),
            self.env_file: self.env_file.read_bytes(),
        }

        failed = self.run_bash(
            self.uninstall_args("--remove-env", apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "after_first_quarantine"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr, "UNINSTALL_TRANSACTION\n")
        for path, payload in before.items():
            self.assertEqual(path.read_bytes(), payload)

        retry = self.run_bash(self.uninstall_args("--remove-env", apply=True))
        self.assertEqual(retry.returncode, 0, retry.stderr)
        for target in (self.runtime, self.state, self.unit, self.skill.parent, self.env_file):
            self.assertFalse(target.exists(), target)

    def test_partial_state_finalization_restores_post_stop_snapshot_and_retries(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        (self.runtime / "nested").mkdir()
        (self.runtime / "nested" / "runtime.bin").write_bytes(b"runtime-before\x00")
        (self.state / "nested").mkdir(parents=True)
        (self.state / "nested" / "state.bin").write_bytes(b"state-before-stop\x00")
        (self.skill.parent / "nested").mkdir()
        (self.skill.parent / "nested" / "skill.bin").write_bytes(b"skill-before\x00")

        def snapshot(root):
            return {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in root.rglob("*")
                if path.is_file()
            }

        before = {
            "runtime": snapshot(self.runtime),
            "skill": snapshot(self.skill.parent),
            "unit": self.unit.read_bytes(),
            "env": self.env_file.read_bytes(),
        }
        post_stop_state = snapshot(self.state)
        post_stop_state["nested/state.bin"] = b"state-after-stop\x00"
        failed = self.run_bash(
            self.uninstall_args("--remove-env", apply=True),
            extra_env={"HC3_TEST_FAIL_STEP": "during_state_finalize"},
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr, "UNINSTALL_TRANSACTION\n")
        self.assertEqual(snapshot(self.runtime), before["runtime"])
        self.assertEqual(snapshot(self.state), post_stop_state)
        self.assertEqual(snapshot(self.skill.parent), before["skill"])
        self.assertEqual(self.unit.read_bytes(), before["unit"])
        self.assertEqual(self.env_file.read_bytes(), before["env"])

        retry = self.run_bash(self.uninstall_args("--remove-env", apply=True))
        self.assertEqual(retry.returncode, 0, retry.stderr)
        for target in (self.runtime, self.state, self.unit, self.skill.parent, self.env_file):
            self.assertFalse(target.exists(), target)

    def test_rollback_failure_reports_stable_error_and_preserves_recovery_evidence(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        recovery_root = self.root / "recovery"
        recovery_root.mkdir()

        failed = self.run_bash(
            self.uninstall_args("--remove-env", apply=True),
            extra_env={
                "HC3_TEST_FAIL_STEP": "after_first_quarantine",
                "HC3_TEST_ROLLBACK_FAILURE": "1",
                "TMPDIR": self.bash_path(recovery_root),
            },
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stderr, "UNINSTALL_ROLLBACK\n")
        stages = list(recovery_root.glob("hermes-codex-uninstall.*"))
        self.assertEqual(len(stages), 1)
        for backup in ("runtime", "state", "unit", "skill", "env"):
            self.assertTrue((stages[0] / "backup" / backup).exists(), backup)
        quarantines = list(self.runtime.parent.glob(".hc3-runtime.*"))
        self.assertEqual(len(quarantines), 1)
        self.assertTrue((quarantines[0] / "payload" / "install-manifest.json").exists())

    def test_service_identity_charset_and_private_staging_contract(self):
        root_user = self.run_bash(self.install_args("--service-user", "root"))
        self.assertNotEqual(root_user.returncode, 0)
        self.assertEqual(root_user.stderr, "INSTALL_USER\n")
        invalid_user = self.run_bash(self.install_args("--service-user", "bad$user"))
        self.assertNotEqual(invalid_user.returncode, 0)
        self.assertEqual(invalid_user.stderr, "CONFIG_PATH_CHARSET\n")

        invalid_values = [
            self.bash_path(self.root) + "/bad path",
            self.bash_path(self.root) + "/bad%path",
            self.bash_path(self.root) + "/bad\\path",
        ]
        if os.name != "nt":
            invalid_values.append(self.bash_path(self.root) + '/bad"path')
        for value in invalid_values:
            with self.subTest(value=value[-8:]):
                result = self.run_bash([
                    self.bash_path(INSTALL),
                    "--queue-root", value,
                    "--hermes-home", self.bash_path(self.hermes_home),
                    "--env-file", self.bash_path(self.env_file),
                    "--sandbox-root", self.bash_path(self.sandbox),
                ])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "CONFIG_PATH_CHARSET\n")

        source = INSTALL.read_text(encoding="utf-8")
        uninstall_source = UNINSTALL.read_text(encoding="utf-8")
        unit_template = (HERE / "templates" / "hermes-codex-bridge.service.in").read_text(encoding="utf-8")
        self.assertIn("mktemp -d", source)
        self.assertIn("runuser -u", source)
        self.assertIn("stat -c '%u'", source)
        self.assertIn("id -u", source)
        self.assertIn("printf '%s' hermes", source)
        self.assertIn("install-manifest.json", source)
        self.assertNotIn("tmp.$", source)
        self.assertNotIn("skill_tmp", source)
        self.assertLess(source.index("unittest discover"), source.index('rm -rf -- "$runtime_root"'))
        self.assertIn("systemctl stop hermes-codex-bridge.service", uninstall_source)
        self.assertIn("active_status", uninstall_source)
        self.assertIn("enabled_status", uninstall_source)
        self.assertNotIn("disable --now", uninstall_source)
        self.assertNotIn('[[ -z $sandbox_root && -f $unit_file ]]', uninstall_source)
        stop_index = uninstall_source.index("systemctl stop hermes-codex-bridge.service")
        backup_index = uninstall_source.index('cp -a -- "$runtime_root" "$stage_root/backup/runtime"')
        arm_index = uninstall_source.index("transaction_active=1")
        self.assertLess(stop_index, backup_index)
        self.assertLess(backup_index, arm_index)
        self.assertLess(uninstall_source.index("model_sandbox_service_stop"), backup_index)
        self.assertIn("UNINSTALL_ROLLBACK", uninstall_source)
        self.assertGreaterEqual(source.count("unittest discover"), 2)
        self.assertLess(source.index("systemctl is-active --quiet"), source.index("transaction_active=1"))
        self.assertIn('runuser -u "$service_user" -- test -w "$queue_root"', source)
        self.assertIn('runuser -u "$service_user" -- test -w "$queue_root/interactions"', source)
        self.assertIn('runuser -u "$service_user" -- cat --', source)
        self.assertIn("SOURCE_TRUST", source)
        self.assertNotIn("Group=", unit_template)

    def test_uninstall_twice_removes_only_owned_targets(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        queue_marker = self.queue / "interactions" / "keep.json"
        queue_marker.write_text("{}\n", encoding="ascii")

        for _ in range(2):
            result = self.run_bash(self.uninstall_args(apply=True))
            self.assertEqual(result.returncode, 0, result.stderr)

        self.assertTrue(queue_marker.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")
        self.assertTrue(self.hermes_home.exists())
        for target in (self.unit, self.runtime, self.state, self.skill):
            self.assertFalse(target.exists(), target)
        self.assertTrue(self.env_file.exists())

    def test_uninstall_removes_env_only_with_explicit_flag(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)

        plan = self.run_bash(self.uninstall_args())
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertIn("PRESERVE env-file [redacted]", plan.stdout)
        self.assertNotIn("TARGET env-file", plan.stdout)

        removed = self.run_bash(self.uninstall_args("--remove-env", apply=True))
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(self.env_file.exists())

    def test_remove_env_plan_is_explicit_and_redacted(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        result = self.run_bash(self.uninstall_args("--remove-env"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("TARGET env-file [redacted]", result.stdout)
        self.assertNotIn(self.rendered_path(self.env_file), result.stdout + result.stderr)

    def test_uninstall_plan_does_not_remove_env_or_installed_files(self):
        installed = self.run_bash(self.install_args(apply=True))
        self.assertEqual(installed.returncode, 0, installed.stderr)
        result = self.run_bash(self.uninstall_args())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.env_file.exists())
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.skill.exists())

    def test_rejects_relative_unknown_duplicate_and_missing_arguments(self):
        cases = [
            ([self.bash_path(INSTALL), "--queue-root", "relative", "--hermes-home", self.bash_path(self.hermes_home), "--env-file", self.bash_path(self.env_file), "--sandbox-root", self.bash_path(self.sandbox)], "INSTALL_PATH"),
            (self.install_args("--unknown"), "INSTALL_ARGS"),
            (self.install_args("--queue-root", self.bash_path(self.queue)), "INSTALL_ARGS"),
            ([self.bash_path(INSTALL), "--queue-root", self.bash_path(self.queue)], "INSTALL_ARGS"),
        ]
        for args, code in cases:
            with self.subTest(code=code, args=args[-2:]):
                result = self.run_bash(args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, code + "\n")

    @unittest.skipIf(os.name == "nt", "Windows filesystems do not expose reliable Unix mode bits")
    def test_rejects_env_mode_other_than_0600(self):
        os.chmod(self.env_file, 0o640)
        result = self.run_bash(self.install_args())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "INSTALL_ENV_MODE\n")

    def test_rejects_missing_env_values_without_leaking_content(self):
        for content in (
            "HERMES_TELEGRAM_CHAT_ID=123456789\n",
            "HERMES_TELEGRAM_TOKEN=present_but_no_chat\n",
            "HERMES_TELEGRAM_TOKEN=present\nHERMES_TELEGRAM_CHAT_ID=0\n",
        ):
            with self.subTest(content=content.splitlines()[0].split("=", 1)[0]):
                self.env_file.write_text(content, encoding="ascii")
                os.chmod(self.env_file, 0o600)
                result = self.run_bash(self.install_args())
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "INSTALL_ENV_CONTENT\n")
                self.assertNotIn(content.strip(), result.stdout + result.stderr)

    def test_rejects_symlink_roots_when_supported(self):
        real = self.root / "real-queue"
        (real / "interactions").mkdir(parents=True)
        link = self.root / "linked-queue"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            self.skipTest("directory symlinks are unavailable")
        result = self.run_bash(self.install_args(queue=link))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "INSTALL_UNSAFE\n")

    def test_rejects_symlink_ancestors_for_inputs_and_missing_sandbox(self):
        real = self.root / "real-parent"
        linked = self.root / "linked-parent"
        queue = real / "Queue" / "bridge" / "v3"
        queue.mkdir(parents=True)
        linked_home = real / "hermes-home"
        linked_home.mkdir()
        linked_env = real / "bridge.env"
        linked_env.write_text(
            "HERMES_TELEGRAM_TOKEN=ancestor_placeholder\nHERMES_TELEGRAM_CHAT_ID=246813579\n",
            encoding="ascii",
        )
        os.chmod(linked_env, 0o600)
        try:
            linked.symlink_to(real, target_is_directory=True)
        except OSError:
            self.skipTest("directory symlinks are unavailable")

        lexical_queue = self.bash_path(linked / "Queue" / "bridge" / "v3")
        target_queue = self.bash_path(real / "Queue" / "bridge" / "v3")
        self.assertNotEqual(lexical_queue, target_queue)
        self.assertIn("linked-parent", lexical_queue)

        cases = [
            self.install_args(apply=True, queue=linked / "Queue" / "bridge" / "v3"),
            [
                self.bash_path(INSTALL),
                "--queue-root", self.bash_path(self.queue),
                "--hermes-home", self.bash_path(linked / "hermes-home"),
                "--env-file", self.bash_path(self.env_file),
                "--sandbox-root", self.bash_path(self.sandbox),
            ],
            [
                self.bash_path(INSTALL),
                "--queue-root", self.bash_path(self.queue),
                "--hermes-home", self.bash_path(self.hermes_home),
                "--env-file", self.bash_path(linked / "bridge.env"),
                "--sandbox-root", self.bash_path(self.sandbox),
            ],
            [
                self.bash_path(INSTALL),
                "--queue-root", self.bash_path(self.queue),
                "--hermes-home", self.bash_path(self.hermes_home),
                "--env-file", self.bash_path(self.env_file),
                "--sandbox-root", self.bash_path(linked / "not-created" / "sandbox"),
            ],
            self.uninstall_args(hermes_home=linked / "hermes-home"),
            self.uninstall_args(env_file=linked / "bridge.env"),
            self.uninstall_args(apply=True, sandbox=linked / "not-created" / "sandbox"),
        ]
        self.assertEqual(cases[0][2], lexical_queue)
        for args in cases:
            with self.subTest(script=Path(args[0]).name):
                result = self.run_bash(args)
                self.assertNotEqual(result.returncode, 0)
                expected = "UNINSTALL_UNSAFE\n" if "uninstall" in args[0] else "INSTALL_UNSAFE\n"
                self.assertEqual(result.stderr, expected)
        self.assertTrue((real / "Queue" / "bridge" / "v3").is_dir())
        self.assertTrue(linked_env.exists())
        self.assertFalse((real / "not-created").exists())
        self.assertFalse(self.runtime.exists())

    def test_install_rejects_unit_or_env_overlapping_preserved_roots(self):
        queue_around_unit = self.sandbox / "etc" / "systemd" / "system"
        (queue_around_unit / "interactions").mkdir(parents=True)
        queue_marker = queue_around_unit / "preserve.json"
        queue_marker.write_text("{}\n", encoding="ascii")
        unit_result = self.run_bash(self.install_args(apply=True, queue=queue_around_unit))
        self.assertNotEqual(unit_result.returncode, 0)
        self.assertEqual(unit_result.stderr, "INSTALL_OVERLAP\n")
        self.assertTrue(queue_marker.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.runtime.exists())

        risky_cases = [
            self.queue / "bridge-owned.env",
            self.hermes_home / "bridge-owned.env",
        ]
        for risky_env in risky_cases:
            with self.subTest(risky_env=risky_env.parent.name):
                risky_env.write_text(
                    "HERMES_TELEGRAM_TOKEN=isolation_placeholder\n"
                    "HERMES_TELEGRAM_CHAT_ID=135792468\n",
                    encoding="ascii",
                )
                os.chmod(risky_env, 0o600)
                result = self.run_bash(self.install_args(apply=True, env_file=risky_env))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "INSTALL_OVERLAP\n")
                self.assertTrue(risky_env.exists())
                self.assertNotIn("isolation_placeholder", result.stdout + result.stderr)
                self.assertFalse(self.runtime.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")

    def test_uninstall_rejects_env_or_unit_inside_preserved_hermes_home(self):
        env_in_home = self.hermes_home / "bridge-owned.env"
        env_in_home.write_text(
            "HERMES_TELEGRAM_TOKEN=uninstall_isolation_placeholder\n"
            "HERMES_TELEGRAM_CHAT_ID=975318642\n",
            encoding="ascii",
        )
        os.chmod(env_in_home, 0o600)
        env_result = self.run_bash(self.uninstall_args(apply=True, env_file=env_in_home))
        self.assertNotEqual(env_result.returncode, 0)
        self.assertEqual(env_result.stderr, "UNINSTALL_OVERLAP\n")
        self.assertTrue(env_in_home.exists())

        home_around_unit = self.sandbox / "etc" / "systemd"
        unrelated = home_around_unit / "skills" / "unrelated" / "SKILL.md"
        unrelated.parent.mkdir(parents=True, exist_ok=True)
        unrelated.write_text("preserve\n", encoding="ascii")
        self.unit.parent.mkdir(parents=True, exist_ok=True)
        self.unit.write_text("preserve unit\n", encoding="ascii")
        unit_result = self.run_bash(self.uninstall_args(
            apply=True,
            hermes_home=home_around_unit,
        ))
        self.assertNotEqual(unit_result.returncode, 0)
        self.assertEqual(unit_result.stderr, "UNINSTALL_OVERLAP\n")
        self.assertTrue(self.unit.exists())
        self.assertEqual(unrelated.read_text(encoding="ascii"), "preserve\n")

    def test_install_rejects_owned_target_overlaps_without_mutation(self):
        queue_marker = self.queue / "interactions" / "preserve.json"
        queue_marker.write_text("{}\n", encoding="ascii")
        cases = [
            self.install_args(queue=self.sandbox, apply=True),
            [
                self.bash_path(INSTALL),
                "--queue-root", self.bash_path(self.queue),
                "--hermes-home", self.bash_path(self.hermes_home),
                "--env-file", self.bash_path(self.env_file),
                "--sandbox-root", self.bash_path(self.hermes_home),
                "--apply",
            ],
        ]
        self.sandbox.mkdir()
        for args in cases:
            with self.subTest(args=args[1:3]):
                result = self.run_bash(args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "INSTALL_OVERLAP\n")
        self.assertTrue(queue_marker.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")
        self.assertFalse((self.sandbox / "opt").exists())

    def test_install_rejects_queue_skill_and_env_recursive_delete_overlaps(self):
        bridge_skill = self.hermes_home / "skills" / "hermes-codex-telegram-reply-v3"
        bridge_skill.mkdir(parents=True)
        queue_result = self.run_bash(self.install_args(queue=bridge_skill))
        self.assertNotEqual(queue_result.returncode, 0)
        self.assertEqual(queue_result.stderr, "INSTALL_OVERLAP\n")

        risky_env = self.sandbox / "opt" / "hermes-codex-bridge-v3" / "bridge.env"
        risky_env.parent.mkdir(parents=True)
        risky_env.write_text(
            "HERMES_TELEGRAM_TOKEN=risk_placeholder\nHERMES_TELEGRAM_CHAT_ID=987654321\n",
            encoding="ascii",
        )
        os.chmod(risky_env, 0o600)
        env_result = self.run_bash(self.install_args(env_file=risky_env))
        self.assertNotEqual(env_result.returncode, 0)
        self.assertEqual(env_result.stderr, "INSTALL_OVERLAP\n")
        self.assertTrue(risky_env.exists())

    def test_uninstall_rejects_recursive_target_inside_hermes_home(self):
        risky_sandbox = self.hermes_home
        owned = risky_sandbox / "opt" / "hermes-codex-bridge-v3"
        owned.mkdir(parents=True)
        marker = owned / "must-survive.txt"
        marker.write_text("preserve\n", encoding="ascii")
        result = self.run_bash(self.uninstall_args(apply=True, sandbox=risky_sandbox))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "UNINSTALL_OVERLAP\n")
        self.assertTrue(marker.exists())
        self.assertTrue(self.env_file.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")

    def test_uninstall_rejects_invalid_arguments_without_mutation(self):
        absolute_control = self.bash_path(self.root) + "/bad\tpath"
        cases = [
            (self.uninstall_args("--unknown"), "UNINSTALL_ARGS"),
            (self.uninstall_args("--env-file", self.bash_path(self.env_file)), "UNINSTALL_ARGS"),
            ([self.bash_path(UNINSTALL), "--hermes-home", self.bash_path(self.hermes_home), "--env-file"], "UNINSTALL_ARGS"),
            ([self.bash_path(UNINSTALL), "--hermes-home", self.bash_path(self.hermes_home)], "UNINSTALL_ARGS"),
            ([self.bash_path(UNINSTALL), "--hermes-home", "relative", "--env-file", self.bash_path(self.env_file)], "UNINSTALL_PATH"),
            ([self.bash_path(UNINSTALL), "--hermes-home", absolute_control, "--env-file", self.bash_path(self.env_file)], "CONFIG_PATH_CHARSET"),
        ]
        for args, code in cases:
            with self.subTest(code=code, args=args[-2:]):
                result = self.run_bash(args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, code + "\n")
        self.assertTrue(self.env_file.exists())
        self.assertEqual(self.unrelated_skill.read_text(encoding="utf-8"), "keep\n")


if __name__ == "__main__":
    unittest.main()
