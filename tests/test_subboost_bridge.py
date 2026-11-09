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


if __name__ == '__main__':
    unittest.main()
