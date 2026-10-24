"""Regression tests for core override and safe configuration history.

Run with: python3 -m unittest discover -s tests -p 'test_managers.py'
"""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = ROOT / "nikki-rs/files/scripts/config-manager.sh"
CORE = ROOT / "nikki-rs/files/scripts/core-manager.sh"


class ManagersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = pathlib.Path(self.tmp.name) / "nikki-rs"
        self.base.mkdir()
        (self.base / "dns").mkdir()
        (self.base / "profiles").mkdir()
        (self.base / "core").mkdir()
        self.env = os.environ.copy()
        self.env["NIKKI_CONFIG_BASE"] = str(self.base)
        self.env["NIKKI_CORE_DIR"] = str(self.base / "core")
        self.env["NIKKI_RUN_DIR"] = str(self.base / "run")
        self.env["NIKKI_SERVICE"] = str(self.base / "nonexistent-service")
        self.env["NIKKI_PACKAGED_CORE"] = str(self.base / "system-core")
        (self.base / "system-core").write_text("#!/bin/sh\necho packaged\n")
        (self.base / "system-core").chmod(0o755)

    def run_script(self, script, *args, successful=True):
        proc = subprocess.run(["sh", str(script), *map(str, args)],
                              env=self.env, capture_output=True, text=True)
        if successful:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        else:
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
        return proc

    def test_script_syntax(self):
        for script in (CONFIG, CORE, ROOT / "nikki-rs/files/nikki-rs.init"):
            subprocess.run(["sh", "-n", str(script)], check=True)

    def test_versioned_save_restore_and_traversal_rejection(self):
        target = self.base / "dns/black_filter"
        target.write_text("old\n")
        incoming = self.base / "candidate"
        incoming.write_text("new\n")
        self.run_script(CONFIG, "validate", target, incoming)
        self.run_script(CONFIG, "save", target, incoming)
        self.assertEqual(target.read_text(), "new\n")
        backups = self.run_script(CONFIG, "backups", target).stdout.splitlines()
        self.assertEqual(len(backups), 1)
        self.run_script(CONFIG, "restore", target, backups[0])
        self.assertEqual(target.read_text(), "old\n")
        self.run_script(CONFIG, "save", self.base / "dns/../config", incoming,
                        successful=False)
        self.run_script(CONFIG, "restore", target, "../bad", successful=False)

    def test_revision_checked_save_rejects_stale_editor(self):
        target = self.base / "dns/black_filter"
        target.write_text("original\n")
        candidate = self.base / "candidate"
        candidate.write_text("replacement\n")
        digest = self.run_script(CONFIG, "revision", target).stdout.strip()
        self.assertEqual(len(digest), 64)
        self.run_script(CONFIG, "save-revision", target, candidate, digest)
        self.assertEqual(target.read_text(), "replacement\n")
        self.run_script(CONFIG, "save-revision", target, candidate, digest,
                        successful=False)
        self.assertEqual(target.read_text(), "replacement\n")

    def test_configuration_edit_lock_blocks_concurrent_writers(self):
        target = self.base / "dns/black_filter"
        target.write_text("safe\\n")
        incoming = self.base / "candidate"
        incoming.write_text("unsaved\\n")
        locked = self.base / "backups/.locks/dns_black_filter"
        locked.mkdir(parents=True)
        self.run_script(CONFIG, "save", target, incoming, successful=False)
        self.assertEqual(target.read_text(), "safe\\n")
        locked.rmdir()
        self.run_script(CONFIG, "save", target, incoming)
        self.assertEqual(target.read_text(), "unsaved\\n")
        self.assertFalse(locked.exists())

    def test_symlink_config_target_is_rejected(self):
        important = self.base / "important.txt"
        important.write_text("do not alter\\n")
        target = self.base / "dns/black_filter"
        target.symlink_to(important)
        incoming = self.base / "candidate"
        incoming.write_text("replacement\\n")
        self.run_script(CONFIG, "save", target, incoming, successful=False)
        self.assertTrue(target.is_symlink())
        self.assertEqual(important.read_text(), "do not alter\\n")

    def test_reject_oversized_content_without_touching_destination(self):
        target = self.base / "dns/black_filter"
        target.write_text("keep")
        incoming = self.base / "candidate"
        incoming.write_bytes(b"x" * (2097152 + 1))
        self.run_script(CONFIG, "save", target, incoming, successful=False)
        self.assertEqual(target.read_text(), "keep")

    def test_core_status_uses_override_and_rollback_falls_back(self):
        active = self.base / "core/clash-rs"
        active.write_text("#!/bin/sh\necho override\n")
        active.chmod(0o755)
        status = self.run_script(CORE, "status").stdout
        self.assertIn("origin=override", status)
        self.run_script(CORE, "rollback")
        self.assertFalse(active.exists())
        status = self.run_script(CORE, "status").stdout
        self.assertIn("origin=package", status)


if __name__ == "__main__":
    unittest.main()
