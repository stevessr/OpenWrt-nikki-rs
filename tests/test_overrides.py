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

    def test_diagnostics_only_return_non_secret_counts(self):
        (self.overrides / 'rules.yaml').write_text(
            'nikki-rules:\n  - "DOMAIN,example.org,DIRECT"\n  - "DOMAIN,example.org,DIRECT"\n'
        )
        diagnostics = self.cli(SCRIPT, 'inspect', self.base).stdout
        summary = json.loads(diagnostics)
        self.assertEqual(summary['rules'], 3)
        self.assertEqual(summary['groups'], 1)
        self.assertEqual(summary['duplicate_rules'], 1)
        self.assertNotIn('example.org', diagnostics)

    def test_core_preflight_does_not_change_active_profile(self):
        core = self.home / 'mock-core'
        core.write_text('#!/bin/sh\n'
                        'test "$1" = "-d" && test "$3" = "-t" && '
                        'grep -q "MATCH,DIRECT" "$2/config.yaml"\n')
        core.chmod(0o755)
        self.env['NIKKI_TEST_CORE'] = str(core)
        old = self.base.read_bytes()
        self.cli(SCRIPT, 'test', self.base)
        self.assertEqual(self.base.read_bytes(), old)
        core.write_text('#!/bin/sh\nexit 5\n')
        self.cli(SCRIPT, 'test', self.base, success=False)

    def test_ebpf_disables_subscription_tun_and_tun_listeners_without_overlays(self):
        """eBPF/TUN exclusion applies even when no override modules exist."""
        self.env['NIKKI_EBPF_ENABLED'] = '1'
        self.base.write_text(
            'ebpf:\n  enable: false\n  lan-interface: [br-lan]\n'
            'tun:\n  enable: true\n  enable-tcp: true\n  device: utun\n'
            'listeners:\n'
            '  - name: tun-in\n    type: tun\n    device: tun0\n'
            '  - name: tproxy-in\n    type: tproxy\n    port: 7893\n'
        )
        source = self.base.read_bytes()
        self.cli(SCRIPT, 'apply', self.base, self.output)
        result = self.parsed(self.output)
        self.assertTrue(result['ebpf']['enable'])
        self.assertFalse(result['tun']['enable'])
        self.assertFalse(result['tun']['enable-tcp'])
        self.assertEqual(result['tun']['device'], 'utun')
        self.assertEqual([x['name'] for x in result['listeners']], ['tproxy-in'])
        self.assertEqual(self.base.read_bytes(), source)

    def test_ebpf_override_cannot_reenable_tun(self):
        """Advanced tun.yaml/custom.yaml overrides must not bypass eBPF mode."""
        self.env['NIKKI_EBPF_ENABLED'] = '1'
        self.base.write_text('ebpf:\n  enable: true\ntun:\n  enable: false\n')
        (self.overrides / 'tun.yaml').write_text(
            'tun:\n  enable: true\n  enable-tcp: true\n'
            'listeners:\n  - type: tun\n    name: advanced-tun\n'
            '  - type: mixed\n    name: normal-in\n    port: 7890\n'
        )
        (self.overrides / 'custom.yaml').write_text('ebpf:\n  enable: false\n')
        self.cli(SCRIPT, 'apply', self.base, self.output)
        result = self.parsed(self.output)
        self.assertTrue(result['ebpf']['enable'])
        self.assertFalse(result['tun']['enable'])
        self.assertFalse(result['tun']['enable-tcp'])
        self.assertEqual([x['name'] for x in result['listeners']], ['normal-in'])
        preview = self.cli(SCRIPT, 'preview', self.base).stdout
        self.assertIn('enable: false', preview)
        self.assertNotIn('advanced-tun', preview)
        # Preview, check and startup use the same normalized merger.
        self.cli(SCRIPT, 'check', self.base)

    def test_profile_ebpf_disables_tun_without_uci(self):
        self.env['NIKKI_EBPF_ENABLED'] = '0'
        self.base.write_text(
            'ebpf:\n  enable: true\ntun:\n  enable: true\n'
            'listeners:\n  - type: tun\n    name: legacy\n'
        )
        self.cli(SCRIPT, 'apply', self.base, self.output)
        result = self.parsed(self.output)
        self.assertFalse(result['tun']['enable'])
        self.assertEqual(result['listeners'], [])

    def test_disabling_ebpf_restores_saved_tun_behavior(self):
        """Generated output changes; saved subscription and UCI preferences do not."""
        self.env['NIKKI_EBPF_ENABLED'] = '0'
        self.base.write_text(
            'ebpf:\n  enable: false\ntun:\n  enable: true\n'
            '  enable-tcp: true\nlisteners:\n  - type: tun\n    name: tun-in\n'
        )
        original = self.base.read_bytes()
        self.cli(SCRIPT, 'apply', self.base, self.output)
        result = self.parsed(self.output)
        self.assertTrue(result['tun']['enable'])
        self.assertTrue(result['tun']['enable-tcp'])
        self.assertEqual(result['listeners'][0]['type'], 'tun')
        self.assertEqual(self.base.read_bytes(), original)

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
