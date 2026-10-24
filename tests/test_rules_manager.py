"""Exercise ordered rule CRUD without a real router or network."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/rules-manager.sh"
CONFIG = ROOT / "nikki-rs/files/scripts/config-manager.sh"


@unittest.skipUnless(shutil.which("yq"), "mikefarah yq is required")
class RulesBuilderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "nikki-rs"
        self.rules = self.home / "overrides/rules.yaml"
        self.rules.parent.mkdir(parents=True)
        self.rules.write_text(
            'dns:\n  enable: true\n'
            'nikki-rules:\n'
            '  - "DOMAIN,old.example,DIRECT"\n'
        )
        self.env = os.environ.copy()
        self.env["NIKKI_HOME_DIR"] = str(self.home)
        self.env["NIKKI_CONFIG_BASE"] = str(self.home)
        self.env["NIKKI_CONFIG_MANAGER"] = str(CONFIG)

    def cli(self, *args, success=True):
        result = subprocess.run(["sh", str(SCRIPT), *map(str, args)],
                                env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def candidate(self, data):
        f = tempfile.NamedTemporaryFile(prefix="nikki-rs-edit.", delete=False, mode="w")
        json.dump(data, f)
        f.close()
        self.addCleanup(lambda: Path(f.name).unlink(missing_ok=True))
        return f.name

    def test_list_write_move_and_keep_other_keys(self):
        original = json.loads(self.cli("list").stdout)
        self.assertEqual(original["rules"], ["DOMAIN,old.example,DIRECT"])
        new = ["DOMAIN,new.example,DIRECT", "IP-CIDR,1.0.0.0/8,REJECT,no-resolve"]
        result = json.loads(self.cli("save", self.candidate(new), original["revision"]).stdout)
        self.assertTrue(result["success"])
        listed = json.loads(self.cli("list").stdout)
        self.assertEqual(listed["rules"], new)
        self.assertNotEqual(listed["revision"], original["revision"])
        self.assertIn("enable: true", self.rules.read_text())
        self.assertEqual(len(list((self.home / "backups/overrides_rules.yaml").iterdir())), 1)

    def test_reject_stale_revision_without_changes(self):
        revision = json.loads(self.cli("list").stdout)["revision"]
        new = self.candidate(["MATCH,DIRECT"])
        self.rules.write_text('nikki-rules: []\n')
        self.cli("save", new, revision, success=False)
        self.assertEqual(self.rules.read_text(), 'nikki-rules: []\n')

    def test_reject_invalid_payloads(self):
        revision = json.loads(self.cli("list").stdout)["revision"]
        cases = [
            {"rules": ["MATCH,DIRECT"]}, "text", [1],
            ["DOMAIN,example.com"], ["MATCH"], ["MATCH,DIRECT,EXTRA"],
            ["DOMAIN,example.com,PROXY,invalid"], ["DOMAIN,x,PROXY\nDOMAIN,y,PROXY"]
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                self.cli("save", self.candidate(payload), revision, success=False)
                self.assertEqual(json.loads(self.cli("list").stdout)["revision"], revision)

    def test_empty_rule_list_keeps_other_fields(self):
        old = json.loads(self.cli("list").stdout)
        self.cli("save", self.candidate([]), old["revision"])
        new = json.loads(self.cli("list").stdout)
        self.assertEqual(new["rules"], [])
        self.assertIn("dns:", self.rules.read_text())

    def test_reject_existing_symlink(self):
        other = self.home / "important.yaml"
        other.write_text("important: data\n")
        self.rules.unlink()
        self.rules.symlink_to(other)
        self.cli("list", success=False)
        self.assertEqual(other.read_text(), "important: data\n")

    def test_script_syntax(self):
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)


if __name__ == "__main__":
    unittest.main()
