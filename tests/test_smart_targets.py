"""Smart Mixin rule target merge regressions."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/override-manager.sh"

@unittest.skipUnless(shutil.which("yq"), "mikefarrell yq v4 is required")
class SmartRuleTargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name) / "nikki-rs"
        self.overrides = self.home / "overrides"
        self.overrides.mkdir(parents=True)
        self.base = self.home / "base.yaml"
        self.out = self.home / "effective.yaml"
        self.env = os.environ.copy()
        self.env["NIKKI_HOME_DIR"] = str(self.home)
        self.env["NIKKI_CONFIG_BASE"] = str(self.home)

    def run_merge(self, success=True):
        proc = subprocess.run(["sh", str(SCRIPT), "apply", str(self.base), str(self.out)],
                              env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        else:
            self.assertNotEqual(proc.returncode, 0)
        return proc

    def test_smart_rule_chooses_largest_final_select_group(self):
        self.base.write_text(
            'rules: ["MATCH,DIRECT"]\n'
            'proxies: [{name: p1}, {name: p2}]\n'
            'proxy-groups:\n  - {name: small, type: select, proxies: [p1]}\n'
            '  - {name: large, type: select, proxies: [p1, p2]}\n'
        )
        (self.overrides / "rules.yaml").write_text(
            'nikki-rules: ["DOMAIN,example.test,__NIKKI_SMART__"]\n')
        self.run_merge()
        output = subprocess.run(["yq", "-r", ".rules[0]", str(self.out)],
                                capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(output, "DOMAIN,example.test,large")
        self.assertNotIn("__NIKKI_SMART__", self.out.read_text())

    def test_provider_use_members_contribute_to_select_group_score(self):
        self.base.write_text(
            'rules: []\nproxies: [{name: p1}]\n'
            'proxy-groups: [{name: a, type: select, proxies: [p1]}, '
            '{name: b, type: select, proxies: [p1], use: [sub1, sub2]}]\n'
        )
        (self.overrides / "rules.yaml").write_text(
            'nikki-rules: ["MATCH,__NIKKI_SMART__"]\n')
        self.run_merge()
        rule = subprocess.run(["yq", "-r", ".rules[0]", str(self.out)],
                              capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(rule, "MATCH,b")

    def test_no_select_group_fails_with_clear_error(self):
        self.base.write_text('rules: []\nproxy-groups: [{name: url, type: url-test, proxies: [p]}]\n')
        (self.overrides / "rules.yaml").write_text(
            'nikki-rules: ["MATCH,__NIKKI_SMART__"]\n')
        proc = self.run_merge(success=False)
        self.assertIn("Smart rule target requires at least one select proxy group", proc.stderr)

    def test_smart_resolves_no_resolve_suffix_without_overlay_files(self):
        self.base.write_text('rules: ["IP-CIDR,10.0.0.0/8,__NIKKI_SMART__,no-resolve"]\nproxy-groups: [{name: main, type: select, proxies: [a,b]}]\n')
        self.run_merge()
        self.assertNotIn("__NIKKI_SMART__", self.out.read_text())
        self.assertIn("main,no-resolve", self.out.read_text())

    def test_explicit_custom_rule_target_is_preserved(self):
        self.base.write_text('rules: []\nproxy-groups: []\n')
        (self.overrides / "rules.yaml").write_text(
            'nikki-rules: ["DOMAIN,custom.test,My Custom Group"]\n')
        self.run_merge()
        rule = subprocess.run(["yq", "-r", ".rules[0]", str(self.out)],
                              capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(rule, "DOMAIN,custom.test,My Custom Group")

if __name__ == "__main__":
    unittest.main()
