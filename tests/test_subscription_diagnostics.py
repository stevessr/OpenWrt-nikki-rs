"""Regression tests for safe, useful subscription failure diagnostics."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / "nikki-rs/files/nikki-rs.init"


@unittest.skipUnless(shutil.which("sh"), "POSIX shell is required")
class SubscriptionDiagnosticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = INIT.read_text()
        start = source.index("subscription_fetch() {")
        end = source.index("update_subscription() {", start)
        cls.fetch_function = source[start:end]

    def run_fetch_stub(self, curl_rc, http_status, curl_error):
        script = self.fetch_function + f"""
curl() {{
    printf '%s' '{http_status}'
    printf '%s\n' '{curl_error}' >&2
    return {curl_rc}
}}
if subscription_fetch '' /tmp/header /tmp/output https://example.invalid/sub clash /tmp/curl.err 10 2 0; then
    echo SUCCESS
else
    echo "$subscription_curl_reason"
fi
"""
        result = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_http_403_is_explained_without_echoing_url(self):
        reason = self.run_fetch_stub(22, "403", "curl: (22) The requested URL returned error: 403")
        self.assertEqual(reason, "HTTP 403: access denied")
        self.assertNotIn("example.invalid", reason)

    def test_timeout_and_dns_errors_are_explained(self):
        timeout = self.run_fetch_stub(28, "000", "curl: (28) Operation timed out")
        dns = self.run_fetch_stub(6, "000", "curl: (6) Could not resolve host")
        self.assertEqual(timeout, "Connection timed out")
        self.assertEqual(dns, "Could not resolve the subscription host (DNS)")

    def test_invalid_yaml_records_failure_reason_and_keeps_last_update(self):
        source = INIT.read_text()
        start = source.index("update_subscription() {")
        end = source.index("prepare_rule_provider() {", start)
        body = source[start:end]
        self.assertIn("parser line $validation_line", body)
        self.assertIn('uci_set "nikki-rs" "$subscription_section" "error" "$subscription_error"', body)
        self.assertIn('uci_remove "nikki-rs" "$subscription_section" "error"', body)
        self.assertIn('uci_set "nikki-rs" "$subscription_section" "last_attempt"', body)
        # A failed attempt must not clear the last successful timestamp or file.
        self.assertNotIn('uci_remove "nikki-rs" "$subscription_section" "update"', body)
        self.assertNotIn('rm -f "$subscription_file"', body)

    def test_profile_rpc_returns_structured_failure(self):
        rpc = (ROOT / "luci-app-nikki-rs/root/usr/share/rpcd/ucode/luci.nikki-rs").read_text()
        start = rpc.index("update_subscription: {")
        end = rpc.index("update_rule_provider: {", start)
        block = rpc[start:end]
        self.assertIn("section_id + '.error'", block)
        self.assertIn("status == '1'", block)
        self.assertIn("error: error", block)


if __name__ == "__main__":
    unittest.main()
