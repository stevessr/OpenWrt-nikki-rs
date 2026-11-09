"""Prevent accidental re-enablement of non-upstream forced DNS/GEO defaults.

These values are user-configurable, but must be opt-in. The native
clash-rs configuration can read DNS/GEO fields from the subscription.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "nikki-rs/files/nikki-rs.conf"
MIXIN = ROOT / "nikki-rs/files/ucode/mixin.uc"
INIT = ROOT / "nikki-rs/files/nikki-rs.init"
CORE = ROOT / "nikki-rs/files/scripts/core-manager.sh"


class UpstreamConfigDefaultsTests(unittest.TestCase):
    def test_no_forced_dns_geodata_defaults(self):
        content = CONF.read_text()
        mixin = content.split("config mixin 'mixin'", 1)[1].split(
            "\nconfig authentication", 1)[0]
        for option in (
            "dns_nameserver_policy",
            "dns_proxy_server_nameserver",
            "overwrite_mmdb",
            "overwrite_geosite",
        ):
            with self.subTest(option=option):
                self.assertRegex(mixin, rf"(?m)^\s*option {option} '0'$")
                self.assertNotRegex(mixin, rf"(?m)^\s*option {option} '1'$")

    def test_dns_policy_examples_match_upstream_defaults(self):
        content = CONF.read_text()
        policies = re.findall(
            r"(?m)^config nameserver_policy\n((?:\t(?:option|list) .*\n)+)",
            content,
        )
        self.assertEqual(len(policies), 2)
        self.assertIn("option matcher 'geosite:private,cn'", policies[0])
        self.assertIn("list nameserver 'https://223.5.5.5/dns-query'", policies[0])
        self.assertIn("list nameserver 'https://223.6.6.6/dns-query'", policies[0])
        self.assertIn("option matcher 'geosite:geolocation-!cn'", policies[1])
        self.assertNotIn("geosite:proxy", "\n".join(policies))

    def test_valid_extensions_still_have_consumers(self):
        content = CONF.read_text()
        self.assertIn("config core_update 'core_update'", content)
        self.assertIn("config_get_bool core_auto_update", INIT.read_text())
        self.assertIn("core_update.variant", CORE.read_text())
        self.assertIn("const ebpf_enabled", MIXIN.read_text())
        self.assertIn("!ebpf_enabled", MIXIN.read_text())

    def test_overwrite_toggles_still_supported_when_user_enables_them(self):
        mixin = MIXIN.read_text()
        init = INIT.read_text()
        for key in (
            "dns_nameserver_policy", "dns_proxy_server_nameserver",
            "overwrite_mmdb", "overwrite_geosite",
        ):
            with self.subTest(option=key):
                self.assertIn(key, mixin + init)


if __name__ == "__main__":
    unittest.main()
