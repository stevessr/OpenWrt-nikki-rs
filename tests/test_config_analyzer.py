"""Regression tests for privacy-safe Clash configuration change reports."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
ANALYZER = ROOT / "nikki-rs/files/scripts/config-analyzer.sh"
COMPOSER = ROOT / "nikki-rs/files/scripts/override-manager.sh"

@unittest.skipUnless(shutil.which("yq"), "mikefarah yq v4 is required")
class ConfigAnalyzerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = pathlib.Path(self.temp.name) / "nikki-rs"
        (self.home / "overrides").mkdir(parents=True)
        self.base = self.home / "base.yaml"
        self.base.write_text(
            'mode: rule\n'
            'rules: ["MATCH,DIRECT"]\n'
            'proxies:\n'
            '  - name: hidden-user@server\n'
            '    type: ss\n'
            '    password: extremely-private-password\n'
            'proxy-groups: []\n'
            'dns:\n  enable: true\n'
            'secret: private-secret-value\n'
        )
        self.candidate = tempfile.NamedTemporaryFile(
            prefix="nikki-rs-edit.", mode="w", delete=False
        )
        self.addCleanup(lambda: pathlib.Path(self.candidate.name).unlink(missing_ok=True))
        self.env = os.environ.copy()
        self.env["NIKKI_HOME_DIR"] = str(self.home)
        self.env["NIKKI_COMPOSER"] = str(COMPOSER)
        self.env["NIKKI_EBPF_ENABLED"] = "0"

    def analyze(self, module, content, success=True):
        self.candidate.seek(0)
        self.candidate.truncate()
        self.candidate.write(content)
        self.candidate.flush()
        proc = subprocess.run(
            ["sh", str(ANALYZER), str(self.base), module, self.candidate.name],
            env=self.env, capture_output=True, text=True
        )
        if success:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout), proc.stdout
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        return None, proc.stderr

    def test_changed_sections_and_counts_do_not_expose_secrets(self):
        report, output = self.analyze("rules", (
            'nikki-rules:\n'
            '  - "DOMAIN,secret-domain.example,DIRECT"\n'
            '  - "DOMAIN,secret-domain.example,DIRECT"\n'
        ))
        self.assertEqual(report["changed_sections"], ["rules"])
        self.assertEqual(report["before"]["rules"], 1)
        self.assertEqual(report["after"]["rules"], 3)
        self.assertEqual(report["after"]["duplicate_rules"], 1)
        self.assertNotIn("hidden-user", output)
        self.assertNotIn("extremely-private-password", output)
        self.assertNotIn("private-secret-value", output)
        self.assertNotIn("secret-domain.example", output)

    def test_identical_draft_shows_no_changes(self):
        report, _ = self.analyze("general", "{}\n")
        self.assertEqual(report["changed_sections"], [])
        self.assertEqual(report["before"]["proxies"], report["after"]["proxies"])

    def test_duplicate_group_names_and_dns_state(self):
        report, _ = self.analyze("custom", (
            'dns:\n  enable: false\n'
            'proxy-groups:\n'
            '  - name: repeated\n    type: select\n    proxies: [DIRECT]\n'
            '  - name: repeated\n    type: select\n    proxies: [DIRECT]\n'
        ))
        self.assertEqual(report["after"]["duplicate_group_names"], 1)
        self.assertFalse(report["after"]["dns"])
        self.assertEqual(report["after"]["groups"], 2)
        self.assertIn("dns", report["changed_sections"])

    def test_ebpf_tun_exclusivity_is_visible_in_proposed_snapshot(self):
        self.env["NIKKI_EBPF_ENABLED"] = "1"
        self.base.write_text(
            'ebpf:\n  enable: true\n'
            'tun:\n  enable: true\n'
            'listeners:\n  - type: tun\n    name: legacy\n'
        )
        report, _ = self.analyze("tun", (
            'tun:\n  enable: true\n'
            'listeners:\n  - type: tun\n    name: injected\n'
        ))
        self.assertTrue(report["after"]["ebpf"])
        self.assertFalse(report["after"]["tun"])
        self.assertEqual(report["after"]["tun_listeners"], 0)

    def test_reject_bad_module_or_invalid_yaml(self):
        self.analyze("typo", "{}\n", success=False)
        self.analyze("custom", "dns: [bad\n", success=False)

    def test_posix_shell_syntax(self):
        subprocess.run(["sh", "-n", str(ANALYZER)], check=True)

if __name__ == "__main__":
    unittest.main()
