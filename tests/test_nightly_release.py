"""Nightly Release contract and build-only version bump regression tests."""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/packaging/stamp-nightly.py"
spec = importlib.util.spec_from_file_location("nightly_stamp", SCRIPT)
stamp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stamp)


class NightlyReleaseTests(unittest.TestCase):
    def test_revision_increases_and_preserves_upstream_version(self):
        now = datetime(2026, 11, 10, 0, 0, tzinfo=timezone.utc)
        older = stamp.nightly_revision(now, 21)
        newer = stamp.nightly_revision(now, 22)
        self.assertEqual(older, "2026111000021")
        self.assertGreater(int(newer), int(older))
        original = "PKG_VERSION:=1.0.7\nPKG_RELEASE:=10\n"
        updated = stamp.stamp_makefile(original, newer)
        self.assertIn("PKG_VERSION:=1.0.7", updated)
        self.assertIn("PKG_RELEASE:=2026111000022", updated)
        self.assertNotEqual(updated, original)

    def test_subboost_version_is_stamped_with_the_same_nightly_revision(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temporary:
            luci = Path(temporary) / "luci-app-subboost"
            luci.mkdir()
            make = luci / "Makefile"
            make.write_text("PKG_VERSION:=2.11.0\nPKG_RELEASE:=1\n")
            revision = stamp.nightly_revision(datetime(2026, 11, 10, tzinfo=timezone.utc), 9)
            make.write_text(stamp.stamp_makefile(make.read_text(), revision))
            self.assertIn(f"PKG_RELEASE:={revision}", make.read_text())
            self.assertIn("PKG_VERSION:=2.11.0", make.read_text())

    def test_stamp_rejects_ambiguous_makefiles(self):
        with self.assertRaises(ValueError):
            stamp.stamp_makefile("PKG_VERSION:=1.0.7\n", "20261110001")
        with self.assertRaises(ValueError):
            stamp.stamp_makefile("PKG_RELEASE:=1\nPKG_RELEASE:=2\n", "20261110001")
        with self.assertRaises(ValueError):
            stamp.stamp_makefile("PKG_RELEASE:=1\n", "../unsafe")

    def test_release_is_gated_and_distinct_from_stable_feed(self):
        workflow = (ROOT / ".github/workflows/nightly-release.yml").read_text()
        package = (ROOT / ".github/workflows/package.yml").read_text()
        self.assertIn("branches:\n      - main", workflow)
        self.assertIn("schedule:", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("nightly: true", workflow)
        self.assertIn("include_subboost: true", workflow)
        self.assertIn("subboost-source-revision", workflow)
        self.assertIn("luci-app-subboost", workflow)
        self.assertIn("SUBBOOST_SOURCE.txt", workflow)
        self.assertIn("repository: stevessr/subboost", package)
        self.assertIn("SUBBOOST_SOURCE_DIR", package)
        self.assertIn("--require-subboost", package)
        self.assertIn("sign: false", workflow)
        self.assertIn("upload_feed: false", workflow)
        self.assertIn("needs: packages", workflow)
        self.assertIn("test \"$actual\" -eq \"$expected\"", workflow)
        self.assertIn("tag_name: nightly", workflow)
        self.assertIn("prerelease: true", workflow)
        self.assertIn("overwrite_files: true", workflow)
        self.assertIn("sha256sum nikki-rs_*.tar.gz > SHA256SUMS", workflow)
        self.assertIn("github.token", workflow)
        self.assertIn("if: inputs.nightly", package)
        self.assertIn("scripts/packaging/stamp-nightly.py", package)
        self.assertIn("default: false", package)
        self.assertIn("core_update", (ROOT / "nikki-rs/files/nikki-rs.conf").read_text())


if __name__ == "__main__":
    unittest.main()
