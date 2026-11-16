"""Static regressions for the rpcd/init contracts used by the editor diff."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
RPCD = ROOT / "luci-app-nikki-rs/root/usr/share/rpcd/ucode/luci.nikki-rs"
INIT = ROOT / "nikki-rs/files/nikki-rs.init"


class EditorDiffContractTests(unittest.TestCase):
    def test_override_helper_precedes_editor_path_valid(self):
        # ucode resolves function references lexically: a helper declared after
        # editor_path_valid is still unset when that function is called.
        source = RPCD.read_text()
        helper = source.index("function allowed_override_module")
        caller = source.index("function editor_path_valid")
        self.assertLess(helper, caller)

    def test_editor_diff_is_registered(self):
        source = RPCD.read_text()
        self.assertIn("editor_diff:", source)
        self.assertIn("editor_preview_profile", source)

    def test_preview_profile_does_not_download_rule_providers(self):
        source = INIT.read_text()
        self.assertIn("extra_command 'preview_profile'", source)
        self.assertIn('${preview_mode:-0}', source)
        self.assertIn("preview_profile()", source)

    def test_preview_profile_cleans_its_workspace(self):
        # mixin_profile replaces the EXIT trap of the calling shell, so the
        # preview workspace must be removed explicitly and the trap restored.
        source = INIT.read_text()
        start = source.index("preview_profile() {")
        end = source.index("start_service() {")
        block = source[start:end]
        self.assertIn("cleanup_preview() {", block)
        self.assertIn("trap 'cleanup_preview' EXIT INT TERM", block)
        self.assertIn('rm -rf "$tmpdir"', block)
        self.assertIn("cleanup_preview\n\ttrap - EXIT INT TERM", block)


if __name__ == "__main__":
    unittest.main()
