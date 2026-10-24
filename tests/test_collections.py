"""Structured collection storage, merge and eBPF safety regression tests."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MANAGER = ROOT / "nikki-rs/files/scripts/collections-manager.sh"
CONFIG = ROOT / "nikki-rs/files/scripts/config-manager.sh"
MERGE = ROOT / "nikki-rs/files/scripts/override-manager.sh"

@unittest.skipUnless(shutil.which("yq"), "mikefarah yq v4 is required")
class CollectionEditorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "nikki-rs"
        self.mods = self.home / "overrides"
        self.mods.mkdir(parents=True)
        self.base = self.home / "base.yaml"
        self.base.write_text(
            'proxy-groups:\n'
            '  - name: imported\n    type: select\n    proxies: [DIRECT]\n'
            'listeners:\n'
            '  - name: imported-http\n    type: http\n    port: 8080\n'
            'rule-providers:\n'
            '  legacy:\n    type: file\n    behavior: domain\n    path: ./legacy.yaml\n'
            'rules: ["MATCH,imported"]\n'
        )
        for name in ('proxy-groups','listeners','rule-providers','proxy-providers'):
            (self.mods / (name+'.yaml')).write_text("unrelated:\n  keep: true\n")
        self.env = dict(os.environ)
        self.env.update({
            "NIKKI_HOME_DIR":str(self.home),
            "NIKKI_CONFIG_BASE":str(self.home),
            "NIKKI_CONFIG_MANAGER":str(CONFIG),
            "NIKKI_EBPF_ENABLED":"0"
        })
        self.candidate = Path(tempfile.mktemp(prefix="nikki-rs-edit."))
        self.addCleanup(lambda: self.candidate.unlink(missing_ok=True))

    def target(self, module):
        return self.mods / (module + ".yaml")

    def revision(self, module):
        return hashlib.sha256(self.target(module).read_bytes()).hexdigest()

    def cli(self, operation, module, items=None, revision=None, success=True):
        args = ["sh",str(MANAGER),operation,module]
        if items is not None:
            self.candidate.write_text(json.dumps(items,ensure_ascii=False))
            args.extend([str(self.candidate), revision or self.revision(module)])
        r = subprocess.run(args,env=self.env,capture_output=True,text=True)
        if success:
            self.assertEqual(r.returncode,0,r.stderr)
        else:
            self.assertNotEqual(r.returncode,0,r.stdout)
        return r

    def merged(self):
        out = subprocess.run(["sh",str(MERGE),"preview",str(self.base)],
            env=self.env,capture_output=True,text=True)
        self.assertEqual(out.returncode,0,out.stderr)
        src = Path(self.temp.name) / "merged.yaml"
        src.write_text(out.stdout)
        return json.loads(subprocess.run(["yq","-o=json",".",str(src)],
            capture_output=True,text=True,check=True).stdout)

    def test_proxy_groups_preserve_subscription_and_order(self):
        groups=[
            {"name":"快速选择","type":"select","proxies":["DIRECT"]},
            {"name":"auto","type":"url-test","proxies":["DIRECT"],
                "url":"https://example.net/generate_204","interval":300,"tolerance":50}
        ]
        saved=json.loads(self.cli("save","proxy-groups",groups).stdout)
        self.assertTrue(saved["success"])
        snapshot=json.loads(self.cli("read","proxy-groups").stdout)
        self.assertEqual(snapshot["items"],groups)
        effective=self.merged()
        self.assertEqual([x["name"] for x in effective["proxy-groups"]],
            ["快速选择","auto","imported"])
        self.assertNotIn("nikki-proxy-groups",effective)
        self.assertIn("unrelated:",self.target("proxy-groups").read_text())
        self.assertEqual(len(list((self.home/"backups/overrides_proxy-groups.yaml").iterdir())),1)

    def test_listener_inheritance_and_ebpf_removal(self):
        listeners=[
            {"name":"local-socks","type":"socks","listen":"127.0.0.1","port":1080},
            {"name":"ephemeral-tun","type":"tun","device":"tun0"}
        ]
        self.cli("save","listeners",listeners)
        result=self.merged()
        self.assertEqual([x["name"] for x in result["listeners"]],
            ["local-socks","ephemeral-tun","imported-http"])
        self.assertNotIn("nikki-listeners",result)
        self.env["NIKKI_EBPF_ENABLED"]="1"
        effective=self.merged()
        self.assertTrue(effective["ebpf"]["enable"])
        self.assertFalse(effective["tun"]["enable"])
        self.assertEqual([x["name"] for x in effective["listeners"]],
            ["local-socks","imported-http"])

    def test_named_providers_merge_with_existing_subscription(self):
        self.cli("save","rule-providers",{
            "adblock":{"type":"file","behavior":"domain","path":"./adblock.yaml","format":"mrs"},
            "remote":{"type":"http","behavior":"classical","path":"./remote.yaml",
                "url":"https://example.org/rules","interval":3600}
        })
        result=self.merged()
        self.assertIn("legacy",result["rule-providers"])
        self.assertEqual(result["rule-providers"]["adblock"]["format"],"mrs")
        self.assertEqual(result["rule-providers"]["remote"]["interval"],3600)
        self.assertIn("unrelated:",self.target("rule-providers").read_text())

    def test_proxy_providers_map_and_unknown_properties_survive(self):
        items={"local":{"type":"file","path":"./p.yaml",
            "health-check":{"enable":True,"interval":300,"url":"https://example.org/"}}}
        self.cli("save","proxy-providers",items)
        self.assertEqual(json.loads(self.cli("read","proxy-providers").stdout)["items"],items)
        self.assertEqual(self.merged()["proxy-providers"]["local"]["health-check"]["interval"],300)

    def test_draft_never_writes_and_preserves_unrelated_fields(self):
        mod="listeners"
        old=self.target(mod).read_bytes()
        candidate=[{"name":"new","type":"mixed","port":7890}]
        draft=self.cli("draft",mod,candidate).stdout
        self.assertIn("nikki-listeners:",draft)
        self.assertIn("unrelated:",draft)
        self.assertEqual(self.target(mod).read_bytes(),old)
        self.assertFalse((self.home/"backups").exists())

    def test_empty_array_clears_only_user_entries(self):
        self.cli("save","proxy-groups",[])
        self.assertEqual([x["name"] for x in self.merged()["proxy-groups"]],["imported"])

    def test_invalid_groups_listeners_providers(self):
        cases=[
            ("proxy-groups",[{"name":"a","type":"invalid","proxies":["DIRECT"]}]),
            ("proxy-groups",[{"name":"a","type":"select"},{"name":"a","type":"select"}]),
            ("proxy-groups",[{"name":"auto","type":"url-test","proxies":["DIRECT"]}]),
            ("proxy-groups",[{"name":"a","type":"select","proxies":["DIRECT",5]}]),
            ("listeners",[{"name":"a","type":"http","port":70000}]),
            ("listeners",[{"name":"a","type":"http"}]),
            ("rule-providers",{"ad":{"type":"http","behavior":"domain","path":"./x.yaml"}}),
            ("rule-providers",{"ad":{"type":"file","behavior":"invalid","path":"./x.yaml"}}),
            ("proxy-providers",{"x":{"type":"file","path":""}}),
            ("proxy-groups",{"a":{"name":"a","type":"select"}}),
            ("rule-providers",[{"type":"file","path":"./p.yaml"}]),
        ]
        for module,items in cases:
            with self.subTest(module=module,items=items):
                old=self.revision(module)
                self.cli("save",module,items,success=False)
                self.assertEqual(self.revision(module),old)

    def test_stale_revision_cannot_replace_newer_changes(self):
        prior=self.revision("proxy-groups")
        self.target("proxy-groups").write_text("nikki-proxy-groups: []\n")
        self.cli("save","proxy-groups",[{"name":"new","type":"select","proxies":["DIRECT"]}],
            revision=prior,success=False)
        self.assertEqual(self.target("proxy-groups").read_text(),"nikki-proxy-groups: []\n")

    def test_json_shape_and_symlink_safety(self):
        mod="rule-providers"
        victim=Path(self.temp.name)/"sensitive.yaml"
        victim.write_text("important: yes\n")
        self.target(mod).unlink()
        self.target(mod).symlink_to(victim)
        self.cli("read",mod,success=False)
        self.assertEqual(victim.read_text(),"important: yes\n")

    def test_shell_syntax(self):
        subprocess.run(["sh","-n",str(MANAGER)],check=True)

if __name__ == "__main__":
    unittest.main()
