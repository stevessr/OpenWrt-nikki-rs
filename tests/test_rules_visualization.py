"""Exercise the same semantic rule visualizer LuCI loads in the browser."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
DIFF = ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources/tools/nikki-diff.js"


@unittest.skipUnless(shutil.which("node"), "Node.js is required")
class RulesVisualizationTest(unittest.TestCase):
    def test_rule_parser_and_semantic_diff(self):
        subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const diff = new Function('baseclass','_', 'E', fs.readFileSync(process.argv[1], 'utf8'))(
  { extend: value => value }, value => value, (...args) => args);
assert.deepEqual(diff.parseRule('DOMAIN-SUFFIX,example.org,Proxy'), {
  type:'DOMAIN-SUFFIX', value:'example.org', policy:'Proxy', options:'',
  raw:'DOMAIN-SUFFIX,example.org,Proxy'
});
assert.deepEqual(diff.parseRule('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'), {
  type:'IP-CIDR', value:'10.0.0.0/8', policy:'DIRECT', options:'no-resolve',
  raw:'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'
});
assert.deepEqual(diff.parseRule('MATCH,Proxy').policy, 'Proxy');
assert.deepEqual(diff.parseRule('DOMAIN,example.org,src').policy, 'src');
assert.deepEqual(diff.parseRule('DOMAIN,example.org,no-resolve').policy, 'no-resolve');
assert.deepEqual(diff.parseRule('SUB-RULE,route-set,Proxy').value, 'route-set');
const entries = diff.ruleDiff(
  ['DOMAIN,a,DIRECT', 'DOMAIN,b,Proxy', 'MATCH,Proxy'],
  ['DOMAIN,b,Proxy', 'DOMAIN,c,REJECT', 'DOMAIN,a,DIRECT', 'MATCH,Proxy']);
assert.deepEqual(diff.ruleStats(entries), { added:1, removed:0, moved:1, unchanged:2 });
assert.deepEqual(diff.duplicateRules(['A,x,DIRECT','B,y,DIRECT','A,x,DIRECT']), 1);
assert.deepEqual(diff.duplicateRules(['__proto__','constructor','__proto__']), 1);
assert.deepEqual(diff.ruleStats(diff.ruleDiff(['__proto__'], ['constructor'])),
  { added:1, removed:1, moved:0, unchanged:0 });
assert.deepEqual(diff.providerDiff(['__proto__','constructor'], ['constructor','toString']),
  { added:['toString'], removed:['__proto__'] });
""", str(DIFF)], check=True, capture_output=True, text=True)

    def test_rpc_includes_structured_rules(self):
        source = (ROOT / "luci-app-nikki-rs/root/usr/share/rpcd/ucode/luci.nikki-rs").read_text()
        self.assertIn("function editor_extract_rules", source)
        self.assertIn("rules_before: rulesBefore", source)
        self.assertIn("rules_after: rulesAfter", source)

    def test_ui_exposes_rules_view_and_ordered_rule_preview(self):
        editor = (ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources/view/nikki-rs/editor.js").read_text()
        overrides = (ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources/view/nikki-rs/overrides.js").read_text()
        self.assertIn("Rules view", editor)
        self.assertIn("diff.rulesReport", editor)
        self.assertIn("Preview routing rules", overrides)
        self.assertIn("diff.rulesReport", overrides)


if __name__ == "__main__":
    unittest.main()
