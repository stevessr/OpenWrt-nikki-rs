"""Regression tests for the schema-backed OpenClash-style settings workbench."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/settings-manager.sh"
SCHEMA = ROOT / "nikki-rs/files/schema/settings.json"
MANAGER = ROOT / "nikki-rs/files/scripts/config-manager.sh"


@unittest.skipUnless(shutil.which("yq"), "mikefarah yq v4 is required")
class StructuredSettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "nikki-rs"
        self.overrides = self.home / "overrides"
        self.overrides.mkdir(parents=True)
        self.file = self.overrides / "dns.yaml"
        self.file.write_text(
            "dns:\n  enable: false\n  nameserver: [1.1.1.1]\n"
            "secret: sensitive-value\n"
        )
        self.env = dict(os.environ)
        self.env.update({
            "NIKKI_HOME_DIR": str(self.home),
            "NIKKI_CONFIG_BASE": str(self.home),
            "NIKKI_SETTINGS_SCHEMA": str(SCHEMA),
            "NIKKI_CONFIG_MANAGER": str(MANAGER),
        })
        self.candidate = Path(tempfile.mktemp(prefix="nikki-rs-edit."))
        self.addCleanup(lambda: self.candidate.unlink(missing_ok=True))

    def cli(self, action, module="dns", patch=None, revision=None, success=True):
        args = ["sh", str(SCRIPT), action, module]
        if patch is not None:
            self.candidate.write_text(json.dumps(patch))
            args.extend([str(self.candidate), revision or self.revision()])
        cp = subprocess.run(args, env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(cp.returncode, 0, cp.stderr)
        else:
            self.assertNotEqual(cp.returncode, 0, cp.stdout)
        return cp

    def revision(self):
        return hashlib.sha256(self.file.read_bytes()).hexdigest()

    def yaml(self):
        cp = subprocess.run(
            ["yq", "-o=json", ".", str(self.file)], capture_output=True, text=True, check=True
        )
        return json.loads(cp.stdout)

    def test_snapshot_only_returns_schematized_fields(self):
        result = json.loads(self.cli("read").stdout)
        self.assertEqual(result["revision"], self.revision())
        self.assertFalse(result["values"]["dns.enable"])
        self.assertEqual(result["values"]["dns.nameserver"], ["1.1.1.1"])
        self.assertNotIn("dns2.enable", result["values"])
        self.assertNotIn("dns2.cache-capacity", [field["id"] for field in result["fields"]])
        self.assertNotIn("sensitive-value", json.dumps(result))

    def test_typed_update_preserves_unrelated_fields(self):
        old = self.file.read_bytes()
        result = json.loads(self.cli("patch", patch={
            "dns.enable": True,
            "dns.nameserver": ["1.1.1.1", "https://dns.example/dns-query"],
            "dns.fake-ip-filter-mode": "blacklist"
        }).stdout)
        self.assertTrue(result["success"])
        doc = self.yaml()
        self.assertTrue(doc["dns"]["enable"])
        self.assertEqual(len(doc["dns"]["nameserver"]), 2)
        self.assertEqual(doc["dns"]["fake-ip-filter-mode"], "blacklist")
        self.assertEqual(doc["secret"], "sensitive-value")
        self.assertNotEqual(old, self.file.read_bytes())
        self.assertEqual(len(list((self.home / "backups/overrides_dns.yaml").iterdir())), 1)

    def test_null_removes_only_selected_override(self):
        self.cli("patch", patch={"dns.enable": None})
        doc = self.yaml()
        self.assertNotIn("enable", doc["dns"])
        self.assertEqual(doc["dns"]["nameserver"], ["1.1.1.1"])

    def test_draft_does_not_write_or_backup(self):
        old = self.file.read_bytes()
        out = self.cli("draft", patch={"dns.enable": True, "dns2.ipv6": False}).stdout
        self.assertIn("enable: true", out)
        self.assertIn("ipv6: false", out)
        self.assertEqual(self.file.read_bytes(), old)
        self.assertFalse((self.home / "backups").exists())

    def test_wrong_module_and_field_rejected(self):
        self.cli("read", "airports", success=False)
        for patch in [
            {"secret": "overwrite"},
            {"dns.nonexistent": True},
            {"dns..enable": False},
            {"tun.enable": True},
        ]:
            with self.subTest(patch=patch):
                self.cli("patch", patch=patch, success=False)
        self.assertIn("sensitive-value", self.file.read_text())

    def test_invalid_types_and_ranges_rejected(self):
        for patch in [
            {"dns.enable": "true"},
            {"dns2.cache-capacity": 0},
            {"dns2.cache-capacity": 2000000},
            {"dns2.cache-capacity": 1.5},
            {"dns.nameserver": ["1.1.1.1", 5]},
            {"dns.enhanced-mode": "mihomo-only"},
            {"dns.listen": "bad\nlisten: 1"},
            {"dns2.ipv6": [True]},
        ]:
            with self.subTest(patch=patch):
                self.cli("patch", patch=patch, success=False)

    def test_revision_conflict_refuses_write(self):
        old = self.revision()
        self.file.write_text("dns:\n  enable: true\n")
        self.cli("patch", patch={"dns.enable": False}, revision=old, success=False)
        self.assertTrue(self.yaml()["dns"]["enable"])

    def test_general_top_level_and_nested_fields(self):
        other = self.overrides / "general.yaml"
        other.write_text("mode: rule\n")
        self.file = other
        self.cli("patch", "general", patch={
            "mode": "direct", "allow-lan": False,
            "port": 7890, "profile.store-selected": True
        })
        doc = self.yaml()
        self.assertEqual(doc["mode"], "direct")
        self.assertFalse(doc["allow-lan"])
        self.assertEqual(doc["port"], 7890)
        self.assertTrue(doc["profile"]["store-selected"])
        self.cli("patch", "general", patch={"mode": "invalid"}, success=False)

    def test_syntax_and_schema_field_types(self):
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)
        fields = json.loads(SCHEMA.read_text())
        self.assertGreaterEqual(sum(len(v) for v in fields.values()), 55)
        for module, items in fields.items():
            self.assertEqual(len([v["id"] for v in items]), len(set(v["id"] for v in items)))
            for field in items:
                self.assertIn(field["kind"], ("bool", "port", "int", "string", "enum", "list"))
                self.assertEqual(field["path"], field["id"])


if __name__ == "__main__":
    unittest.main()
