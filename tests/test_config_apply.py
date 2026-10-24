"""Transaction-level regressions for config-apply.sh (no OpenWrt required)."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/config-apply.sh"
CONFIG = ROOT / "nikki-rs/files/scripts/config-manager.sh"
COMPOSER = ROOT / "nikki-rs/files/scripts/override-manager.sh"

@unittest.skipUnless(shutil.which("yq"), "mikefarah yq v4 required")
class ConfigApplyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "nikki-rs"
        self.overrides = self.home / "overrides"
        self.run = self.home / "run"
        self.overrides.mkdir(parents=True)
        self.run.mkdir()
        self.module = self.overrides / "dns.yaml"
        self.module.write_text("dns:\n  enable: true\n")
        (self.run / "base.yaml").write_text(
            "mode: rule\ndns:\n  enable: true\n"
            'rules:\n  - "MATCH,DIRECT"\n'
        )
        self.candidate = Path(tempfile.mktemp(prefix="nikki-rs-edit."))
        self.addCleanup(lambda: self.candidate.unlink(missing_ok=True))
        self.candidate.write_text("dns:\n  enhanced-mode: fake-ip\n")
        self.service_dir = self.root / "service"
        self.service_dir.mkdir()
        (self.service_dir / "running").write_text("yes")
        self.service = self.root / "service.sh"
        self.service.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            '  status) test -f "$TEST_SERVICE_DIR/running" ;;\n'
            '  restart)\n'
            '    if [ -f "$TEST_SERVICE_DIR/fail-first" ]; then\n'
            '      rm "$TEST_SERVICE_DIR/fail-first"\n'
            '      rm -f "$TEST_SERVICE_DIR/running"\n'
            '      exit 1\n'
            '    fi\n'
            '    if [ -f "$TEST_SERVICE_DIR/fail-always" ]; then\n'
            '      rm -f "$TEST_SERVICE_DIR/running"\n'
            '      exit 1\n'
            '    fi\n'
            '    touch "$TEST_SERVICE_DIR/running"; exit 0 ;;\n'
            'esac\nexit 1\n'
        )
        self.service.chmod(0o755)
        self.health = self.root / "health.sh"
        self.health.write_text("#!/bin/sh\ntest -f \"$TEST_SERVICE_DIR/running\"\n")
        self.health.chmod(0o755)
        self.core = self.root / "fake-core.sh"
        self.core.write_text(
            '#!/bin/sh\n'
            'test "$1" = "-d" && test "$3" = "-t" && '
            'test -f "$2/config.yaml"\n'
        )
        self.core.chmod(0o755)
        self.env = dict(os.environ)
        self.env.update({
            "NIKKI_HOME_DIR": str(self.home),
            "NIKKI_CONFIG_BASE": str(self.home),
            "NIKKI_CONFIG_MANAGER": str(CONFIG),
            "NIKKI_COMPOSER": str(COMPOSER),
            "NIKKI_APPLY_SERVICE": str(self.service),
            "NIKKI_APPLY_HEALTHCHECK": str(self.health),
            "NIKKI_APPLY_WAIT": "0",
            "NIKKI_TEST_CORE": str(self.core),
            "NIKKI_EBPF_ENABLED": "0",
            "TEST_SERVICE_DIR": str(self.service_dir)
        })

    def revision(self):
        return hashlib.sha256(self.module.read_bytes()).hexdigest()

    def apply(self, expected=None):
        return subprocess.run(
            ["sh", str(SCRIPT), "apply", "dns", str(self.candidate),
             expected if expected is not None else self.revision()],
            env=self.env, capture_output=True, text=True, timeout=30
        )

    def test_successful_apply_and_history(self):
        response = self.apply()
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(response.stdout.strip(), "APPLIED")
        self.assertEqual(self.module.read_text(), self.candidate.read_text())
        backup = self.home / "backups/overrides_dns.yaml"
        self.assertEqual(len(list(backup.iterdir())), 1)
        self.assertFalse((self.run / ".config-apply.lock").exists())

    def test_preflight_failure_does_not_write_or_restart(self):
        before = self.module.read_bytes()
        self.core.write_text("#!/bin/sh\nexit 1\n")
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("PREFLIGHT_FAILED", response.stdout)
        self.assertEqual(self.module.read_bytes(), before)
        self.assertTrue((self.service_dir / "running").exists())

    def test_failed_restart_rolls_back_file_and_recovers_service(self):
        before = self.module.read_bytes()
        (self.service_dir / "fail-first").touch()
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("RESTART_FAILED", response.stdout)
        self.assertIn("ROLLED_BACK", response.stdout)
        self.assertEqual(self.module.read_bytes(), before)
        self.assertTrue((self.service_dir / "running").exists())
        self.assertFalse((self.run / ".config-apply.lock").exists())

    def test_rollback_failure_is_reported_not_claimed_success(self):
        (self.service_dir / "fail-always").touch()
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("ROLLBACK_FAILED", response.stdout)
        self.assertFalse((self.service_dir / "running").exists())

    def test_stale_revision_is_rejected(self):
        old = self.revision()
        self.module.write_text("dns:\n  enable: false\n")
        response = self.apply(expected=old)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("CONFLICT", response.stdout)
        self.assertEqual(self.module.read_text(), "dns:\n  enable: false\n")

    def test_service_stopped_refuses_apply(self):
        (self.service_dir / "running").unlink()
        before = self.module.read_bytes()
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("SERVICE_NOT_RUNNING", response.stdout)
        self.assertEqual(self.module.read_bytes(), before)

    def test_apply_lock_prevents_concurrent_requests(self):
        lock = self.run / ".config-apply.lock"
        lock.mkdir()
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("APPLY_BUSY", response.stdout)
        self.assertTrue(lock.is_dir())
        lock.rmdir()

    def test_invalid_yaml_refused(self):
        before = self.module.read_bytes()
        self.candidate.write_text("dns: [broken\n")
        response = self.apply()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("PREFLIGHT_FAILED", response.stdout)
        self.assertEqual(self.module.read_bytes(), before)

    def test_script_syntax(self):
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)

if __name__ == "__main__":
    unittest.main()
