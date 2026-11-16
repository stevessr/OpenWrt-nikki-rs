"""Regression tests for the Nikki RS SubBoost LuCI bridge."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
VIEW = ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources/view/nikki-rs/subboost.js"


class SubBoostBridgeTests(unittest.TestCase):
    def test_menu_route_points_to_new_view(self):
        menu = json.loads((ROOT / "luci-app-nikki-rs/root/usr/share/luci/menu.d/luci-app-nikki-rs.json").read_text())
        self.assertEqual(menu["admin/services/nikki-rs/subboost"]["action"]["path"], "nikki-rs/subboost")

    def test_subscription_is_imported_without_activation(self):
        source = VIEW.read_text()
        self.assertIn("uci.add('nikki-rs', 'subscription')", source)
        self.assertIn("user_agent', 'clash-rs'", source)
        self.assertIn("prefer', 'remote'", source)
        self.assertIn("update_subscription", source)
        self.assertNotIn("uci.set('nikki-rs', 'config', 'profile'", source)

    def test_url_validation_and_optional_subboost_package(self):
        source = VIEW.read_text()
        self.assertIn("validHttpUrl", source)
        self.assertIn("L.resolveDefault(uci.load('subboost'), null)", source)
        self.assertIn("subboost_source", source)
        self.assertIn("clashRsTargetUrl", source)
        self.assertIn("searchParams.set('target', 'clash-rs')", source)
        self.assertIn("entry.url === targetUrl", source)

    def test_url_helpers_handle_reverse_proxy_and_aliases(self):
        import subprocess
        import shutil
        if not shutil.which("node"):
            self.skipTest("node unavailable")
        source = VIEW.read_text()
        start = source.index("function clashRsTargetUrl(url)")
        end = source.index("function notification(message, level)", start)
        helpers = source[start:end]
        script = helpers + r"""
const assert = require('node:assert/strict');
const base = 'https://sub.example.org/app/api/subscriptions/TOKEN/config.yaml';
assert.equal(clashRsTargetUrl(base),
  base + '?target=clash-rs');
assert.equal(clashRsTargetUrl(base + '?a=1&target=nikki-rs'),
  base + '?a=1&target=clash-rs');
assert.equal(clashRsTargetUrl('https://else.example.org/sub/config.yaml'),
  'https://else.example.org/sub/config.yaml');
assert(sameSubBoostUrl(base + '?x=1&target=nikki-rs',
  base + '?target=clash-rs&x=1'));
assert(!sameSubBoostUrl(base, base.replace('TOKEN', 'DIFFERENT')));
assert(!sameSubBoostUrl(base, 'https://else.example.org/api/subscriptions/TOKEN/config.yaml'));
"""
        script = "function validHttpUrl(v) { try { const u=new URL(v); return !!u.hostname && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash && v.trim()===v; } catch { return false; } }\n" + script
        completed = subprocess.run(["node", "-e", script], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)



if __name__ == '__main__':
    unittest.main()
