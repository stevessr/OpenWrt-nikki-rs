"""Integration regressions for Nikki's modular Clash YAML overrides."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/override-manager.sh"
TEMPLATES = ROOT / "nikki-rs/files/overrides"
CONFIG_MANAGER = ROOT / "nikki-rs/files/scripts/config-manager.sh"


@unittest.skipUnless(shutil.which("yq"), "mikefarah yq v4 is required")
class OverrideManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name) / "nikki-rs"
        self.overrides = self.home / "overrides"
        self.overrides.mkdir(parents=True)
        self.base = self.home / "base.yaml"
        self.output = self.home / "combined.yaml"
        self.base.write_text(
            'mode: rule\n'
            'rules:\n  - "MATCH,DIRECT"\n'
            'proxy-groups:\n  - name: DEFAULT\n    type: select\n    proxies: [DIRECT]\n'
            'proxies: []\n'
            'dns:\n  enable: true\n  nameserver: ["1.1.1.1"]\n'
        )
        self.env = os.environ.copy()
        self.env['NIKKI_HOME_DIR'] = str(self.home)
        self.env['NIKKI_CONFIG_BASE'] = str(self.home)
        self.env['PATH'] = os.environ['PATH']

    def cli(self, script, *args, success=True):
        proc = subprocess.run(['sh', str(script), *map(str, args)],
                              env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        else:
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
        return proc

    def parsed(self, path):
        proc = subprocess.run(['yq', '-o=json', '.', str(path)],
                              capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

    def test_templates_are_valid_and_no_op(self):
        for src in TEMPLATES.glob('*.yaml'):
            shutil.copyfile(src, self.overrides / src.name)
        self.cli(SCRIPT, 'apply', self.base, self.output)
        self.assertEqual(self.parsed(self.base), self.parsed(self.output))

    def test_rules_prepend_and_subscription_is_unchanged(self):
        (self.overrides / 'rules.yaml').write_text(
            'nikki-rules:\n'
            '  - "DOMAIN,example.org,PROXY"\n'
            '  - "DOMAIN-SUFFIX,example.net,DIRECT"\n'
        )
        (self.overrides / 'custom.yaml').write_text(
            'nikki-rules:\n  - "DOMAIN,example.com,DIRECT"\n'
            'dns:\n  enhanced-mode: fake-ip\n'
        )
        (self.overrides / 'proxy-groups.yaml').write_text(
            'nikki-proxy-groups:\n'
            '  - name: PROXY\n    type: select\n    proxies: [DIRECT]\n'
        )
        original = self.base.read_bytes()
        self.cli(SCRIPT, 'check', self.base)
        self.cli(SCRIPT, 'apply', self.base, self.output)
        result = self.parsed(self.output)
        self.assertEqual(result['rules'], [
            'DOMAIN,example.org,PROXY',
            'DOMAIN-SUFFIX,example.net,DIRECT',
            'DOMAIN,example.com,DIRECT',
            'MATCH,DIRECT'
        ])
        self.assertEqual(result['proxy-groups'][0]['name'], 'PROXY')
        self.assertEqual(result['proxy-groups'][1]['name'], 'DEFAULT')
        self.assertEqual(result['dns']['nameserver'], ['1.1.1.1'])
        self.assertEqual(result['dns']['enhanced-mode'], 'fake-ip')
        self.assertEqual(original, self.base.read_bytes())
        self.assertNotIn('nikki-rules', result)

    def test_dry_run_preview_module_replacement(self):
        (self.overrides / 'rules.yaml').write_text('nikki-rules: []\n')
        with tempfile.NamedTemporaryFile(prefix="nikki-rs-edit.",
                                         suffix="", mode="w", delete=False) as tmp:
            tmp.write('nikki-rules:\n  - "DOMAIN,override.example,DIRECT"\n')
            candidate = pathlib.Path(tmp.name)
        self.addCleanup(candidate.unlink)
        p = self.cli(SCRIPT, 'preview', self.base, 'rules', candidate)
        self.assertIn('DOMAIN,override.example,DIRECT', p.stdout)
        self.assertEqual((self.overrides / 'rules.yaml').read_text(), 'nikki-rules: []\n')

    def test_invalid_modules_and_yaml_rejected(self):
        (self.overrides / 'general.yaml').write_text('[]\n')
        self.cli(SCRIPT, 'check', self.base, success=False)
        (self.overrides / 'general.yaml').write_text('{}\n')
        with tempfile.NamedTemporaryFile(prefix="nikki-rs-edit.", mode="w", delete=False) as tmp:
            tmp.write('dns: [bad\n')
            candidate = pathlib.Path(tmp.name)
        self.addCleanup(candidate.unlink)
        self.cli(SCRIPT, 'preview', self.base, 'dns', candidate, success=False)
        self.cli(SCRIPT, 'preview', self.base, 'badmodule', candidate, success=False)

    def test_override_save_backup_and_rejection(self):
        source = self.overrides / 'dns.yaml'
        source.write_text('{}\n')
        candidate = self.home / 'candidate'
        candidate.write_text('dns:\n  enable: true\n')
        self.cli(CONFIG_MANAGER, 'save', source, candidate)
        self.assertEqual(source.read_text(), candidate.read_text())
        revisions = self.cli(CONFIG_MANAGER, 'backups', source).stdout.splitlines()
        self.assertEqual(len(revisions), 1)
        self.cli(CONFIG_MANAGER, 'restore', source, revisions[0])
        self.assertEqual(source.read_text(), '{}\n')
        self.cli(CONFIG_MANAGER, 'save', self.overrides / 'hidden.yaml',
                 candidate, success=False)


if __name__ == '__main__':
    unittest.main()
