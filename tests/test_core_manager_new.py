"""Shell-level tests for the core manager background interface."""
import os
import pathlib
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "nikki-rs/files/scripts/core-manager.sh"


class CoreManagerNewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.core = self.root / "core"
        self.core.mkdir()
        self.env = os.environ.copy()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        curl = self.bin / "curl"
        curl.write_text("#!/bin/sh\nexit 1\n")
        curl.chmod(0o755)
        self.env["PATH"] = str(self.bin) + os.pathsep + self.env.get("PATH", "")
        self.env.update({
            "NIKKI_CORE_DIR": str(self.core),
            "NIKKI_RUN_DIR": str(self.root / "run"),
            "NIKKI_SERVICE": str(self.root / "missing-service"),
            "NIKKI_PACKAGED_CORE": str(self.root / "packaged"),
        })
        packaged = pathlib.Path(self.env["NIKKI_PACKAGED_CORE"])
        packaged.write_text("#!/bin/sh\necho packaged\n")
        packaged.chmod(0o755)

    def run_manager(self, *args, check=True):
        proc = subprocess.run(["sh", str(SCRIPT), *args], env=self.env,
                              text=True, capture_output=True, timeout=5)
        if check:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc

    def wait_state(self, expected, timeout=4):
        deadline = time.monotonic() + timeout
        state = self.core / "operation.state"
        while time.monotonic() < deadline:
            if state.exists() and f"state={expected}" in state.read_text():
                return state.read_text()
            time.sleep(0.03)
        self.fail(f"operation did not reach {expected}: {state.read_text() if state.exists() else 'missing'}")

    def test_syntax_and_status_compatibility(self):
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)
        active = self.core / "clash-rs"
        active.write_text("#!/bin/sh\necho override\n")
        active.chmod(0o755)
        (self.core / "current").write_text("variant=minimal\ntag=v1.2\n")
        out = self.run_manager("status").stdout
        self.assertIn("origin=override", out)
        self.assertIn("path=" + str(active), out)
        self.assertIn("variant=minimal", out)
        self.assertIn("state=idle", out)

    def test_tag_validation_uses_full_string(self):
        for tag in ("v1.2", "v1.2-rc.1", "latest"):
            proc = self.run_manager("start-update", "minimal", tag)
            self.assertIn("state=running", proc.stdout)
            self.wait_state("failed")
            # Clear the completed operation lock/state for the next iteration.
            for path in (self.core / ".update.lock", self.core / "operation.state"):
                if path.is_dir():
                    path.rmdir()
                elif path.exists():
                    path.unlink()
        for tag in ("1.2", "1.2-rc.1", "v1.2/bad", "v1.2;touch", "v", "v1?2"):
            proc = self.run_manager("start-update", "minimal", tag, check=False)
            self.assertNotEqual(proc.returncode, 0, tag)

    def test_start_rollback_returns_promptly_and_records_failure(self):
        start = time.monotonic()
        proc = self.run_manager("start-rollback")
        self.assertLess(time.monotonic() - start, 1.5)
        self.assertIn("state=running", proc.stdout)
        state = self.wait_state("failed")
        self.assertIn("operation=rollback", state)
        self.assertIn("finished=", state)
        self.assertIn("No override installed", self.run_manager("log").stdout)

    def test_concurrent_start_is_rejected_atomically(self):
        # Hold the operation lock to model a concurrently executing operation.
        (self.core / ".update.lock").mkdir()
        proc = self.run_manager("start-rollback", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("Another core operation is running", proc.stderr)
        self.assertTrue((self.core / ".update.lock").is_dir())

    def test_successful_update_and_digest_failure_keep_packaged_core(self):
        import hashlib
        import tarfile
        executable = self.root / "clash-rs"
        executable.write_text("#!/bin/sh\necho fixture-core\n")
        executable.chmod(0o755)
        archive = self.root / "core.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(executable, arcname="clash-rs")
        self.env["CORE_FIXTURE_ARCHIVE"] = str(archive)
        self.env["CORE_FIXTURE_DIGEST"] = hashlib.sha256(archive.read_bytes()).hexdigest()
        library = self.root / "jshn.sh"
        library.write_text("""# jshn initialization deliberately reads an unset variable.
probe="$JSON_PREFIX"
json_load() { :; }
json_select() { :; }
json_get_keys() { eval "$1=1"; }
json_get_var() {
 if [ "$2" = name ]; then eval "$1=clash-rs-minimal-$(uname -m)-unknown-linux-musl.tar.gz";
 else eval "$1=sha256:$CORE_FIXTURE_DIGEST"; fi
}
""")
        self.env["NIKKI_JSHN_LIBRARY"] = str(library)
        (self.bin / "jsonfilter").write_text("#!/bin/sh\necho v1.2\n")
        (self.bin / "jsonfilter").chmod(0o755)
        (self.bin / "curl").write_text("""#!/bin/sh
while [ "$#" -gt 0 ]; do
 if [ "$1" = -o ]; then output="$2"; shift; fi
 shift
done
case "$output" in *release.json) echo '{}' > "$output";; *) cp "$CORE_FIXTURE_ARCHIVE" "$output";; esac
""")
        self.run_manager("start-update", "minimal", "v1.2")
        self.wait_state("success")
        self.assertTrue((self.core / "clash-rs").is_file())
        self.assertIn("fixture-core", (self.core / "clash-rs").read_text())
        self.assertIn("packaged", pathlib.Path(self.env["NIKKI_PACKAGED_CORE"]).read_text())
        installed = (self.core / "clash-rs").read_bytes()
        self.env["CORE_FIXTURE_DIGEST"] = "0" * 64
        self.run_manager("start-update", "minimal", "v1.2")
        self.wait_state("failed")
        self.assertEqual((self.core / "clash-rs").read_bytes(), installed)
        self.assertIn("SHA256 digest mismatch", self.run_manager("log").stdout)

    def test_log_command_caps_output_to_last_16kib(self):
        (self.core / "update.log").write_text("x" * 20000 + "TAIL")
        output = self.run_manager("log").stdout
        self.assertEqual(len(output.encode()), 16384)
        self.assertTrue(output.endswith("TAIL"))


if __name__ == "__main__":
    unittest.main()
