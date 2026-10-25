"""Browser regressions with REAL LuCI runtime/forms and Bootstrap CSS.

Run: python tests/browser/verify_luci.py --luci /path/to/openwrt/luci
Requires Playwright and Chromium. Only RPC data is mocked; no router is changed.
Artifacts default to /tmp/nikki-luci-ui. Not part of backend unittest discovery.
"""
import argparse
import json
import mimetypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--luci", type=Path, required=True)
parser.add_argument("--output", type=Path, default=Path("/tmp/nikki-luci-ui"))
parser.add_argument("--chromium", default="/usr/bin/chromium")
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[2]
RESOURCE = args.luci / "modules/luci-base/htdocs/luci-static/resources"
APP = ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources"
THEME = args.luci / "themes/luci-theme-bootstrap/htdocs/luci-static/bootstrap"
args.output.mkdir(parents=True, exist_ok=True)
assert (RESOURCE / "luci.js").is_file()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *unused): pass
    def respond(self, body, mime="text/javascript"):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.end_headers()
        self.wfile.write(body.encode() if isinstance(body, str) else body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/luci-static/resources/"):
            name = path.removeprefix("/luci-static/resources/")
            if name == "tools/nikki-rs.js":
                return self.respond("'require baseclass'; return baseclass.extend(window.mock);")
            file = (APP if (APP / name).is_file() else RESOURCE) / name
        elif path.startswith("/luci-static/bootstrap/"):
            file = THEME / path.removeprefix("/luci-static/bootstrap/")
        elif path == "/mock.js":
            file = Path(__file__).with_name("mock.js")
        else:
            name = path.rsplit("/", 1)[-1]
            if name not in ("settings", "collections", "overrides", "rules-builder", "app"):
                name = "settings"
            return self.respond("""<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/luci-static/bootstrap/cascade.css">
<link rel="stylesheet" href="/luci-static/bootstrap/mobile.css" media="(max-width: 767px)">
<script>window.cbi_init=function(){};window._=s=>s;</script>
<script src="/luci-static/resources/cbi.js"></script><script src="/mock.js"></script><script src="/luci-static/resources/luci.js"></script>
<script>
window.L=new LuCI({scriptname:'/cgi-bin/luci',pathinfo:'/admin/services/nikki-rs/NAME',
requestpath:['admin','services','nikki-rs','NAME'],resource:'/luci-static/resources',
ubuspath:'/ubus/',sessionid:'mock',token:'mock',pollinterval:0});
L.require('view.nikki-rs.NAME').then(v=>window.currentView=v);
</script></head><body><div class="main"><div id="maincontent" class="container"><div id="view"></div></div></div></body></html>""".replace("NAME", name), "text/html")
        if file.is_file():
            return self.respond(file.read_bytes(), mimetypes.guess_type(str(file))[0] or "application/octet-stream")
        self.send_error(404)

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        def result(req):
            params = req.get("params") or []
            method = params[2] if len(params) > 2 else ""
            if method == "get" and params[3].get("config") == "nikki-rs":
                return {"jsonrpc":"2.0","id":req["id"],"result":[0,{"values":{
                    "config":{".name":"config",".type":"config","enabled":"1","scheduled_restart":"1","scheduled_restart_cron":"15 4 * * 2"},
                    "procd":{".name":"procd",".type":"procd"},
                    "status":{".name":"status",".type":"status"}
                }}]}
            data = {"access": True} if method == "access" else {"values": {}} if method == "get" else {}
            return {"jsonrpc":"2.0","id":req["id"],"result":[0,data]}
        self.respond(json.dumps([result(r) for r in message] if isinstance(message, list) else result(message)), "application/json")

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}/cgi-bin/luci/admin/services/nikki-rs"
results = []
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium, headless=True, args=["--no-sandbox", "--no-proxy-server"])
        page = browser.new_page(viewport={"width":1440,"height":1000}, screen={"width":390,"height":844})
        errors = []
        page.on("pageerror", lambda error: (errors.append(str(error)), print("PAGE ERROR", error, flush=True)))
        page.on("dialog", lambda dialog: dialog.accept())
        def visit(name):
            page.goto(base + "/" + name, wait_until="networkidle")
            try:
                page.locator("#view h2").first.wait_for(timeout=10000)
            except Exception:
                (args.output / "failure.html").write_text(page.content())
                page.screenshot(path=str(args.output / "failure.png"), full_page=True)
                print(page.locator("body").inner_text(), flush=True)
                raise
            assert not errors, errors
        def click(text):
            page.get_by_role("button", name=text, exact=True).click()
            page.wait_for_timeout(150)
        def screenshot(name):
            page.screenshot(path=str(args.output / (name + ".png")), full_page=True)
        def mobile(name):
            page.mouse.move(0, 0)
            page.wait_for_timeout(600)
            page.set_viewport_size({"width":390,"height":844})
            page.wait_for_timeout(100)
            if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                screenshot(name + "-overflow")
                print(page.evaluate("[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width]).slice(-15)"), flush=True)
                raise AssertionError(name)
            screenshot(name + "-mobile")
            page.set_viewport_size({"width":1440,"height":1000})
        visit("app")
        page.locator('[data-name="scheduled_restart_cron"]').wait_for()
        (args.output / "cron.html").write_text(page.content())
        state = page.evaluate("""async () => {
            const dom = await L.require('dom'), uci = await L.require('uci');
            const map = dom.findClassInstance(document.querySelector('.cbi-map'));
            const option = map.lookupOption('scheduled_restart_cron', 'config')[0];
            const widget = option.getUIElement('config');
            const original = widget.getValue();
            widget.setValue('0 3 * * 0');
            await map.parse();
            const preset = uci.get('nikki-rs','config','scheduled_restart_cron');
            widget.setValue('*/15  1-5 * * 1,3');
            await map.parse();
            const custom = uci.get('nikki-rs','config','scheduled_restart_cron');
            widget.setValue('60 3 * * *');
            let rejected = false;
            try { await map.parse(); } catch { rejected = true; }
            widget.setValue('0 3 * * 0');
            await map.parse();
            return {original,preset,custom,rejected};
        }""")
        assert state == {"original":"15 4 * * 2","preset":"0 3 * * 0","custom":"*/15 1-5 * * 1,3","rejected":True}, state
        screenshot("cron")
        mobile("cron")
        results.append("restart Cron: native preset/custom combobox, preserve stored schedule, validation, normalized UCI write")
        visit("settings")
        assert page.locator(".cbi-tabmenu").count() == 1
        assert page.locator(".cbi-tabmenu li").count() == 3
        assert page.get_by_text("Duplicate mode", exact=True).count() == 0
        page.get_by_label("Change behavior for Routing mark").select_option("set")
        page.get_by_label("Routing mark", exact=True).fill("42")
        click("Save settings")
        assert page.evaluate("calls.find(c=>c.op==='settingsPatch').delta['routing-mark']") == 42
        assert page.locator(".cbi-tabmenu").count() == 1
        assert page.get_by_label("Bind address", exact=True).is_disabled()
        page.locator(".cbi-tabmenu a").filter(has_text="Cache").click()
        page.get_by_label("Store selected", exact=True).select_option("false")
        click("Review merged configuration")
        assert page.locator(".modal textarea").input_value() == "mode: rule\n"
        click("Close")
        click("Test and apply safely")
        assert page.evaluate("calls.some(c=>c.op==='configApply')")
        screenshot("settings")
        mobile("settings")
        results.append("settings: native tabs, reload, typed save, inheritance, preview, safe apply")
        visit("collections")
        assert page.locator(".cbi-section-table").count() > 0
        page.get_by_role("button", name="Edit", exact=True).first.click()
        page.locator(".modal").wait_for(state="visible")
        (args.output / "collection-modal.html").write_text(page.content())
        page.locator('.modal input[id$=".name"]').fill("Renamed")
        click("Save")
        click("Save collection")
        payload = page.evaluate("calls.filter(c=>c.op==='collectionWrite'&&!c.draft).at(-1).data")
        assert payload[0]["name"] == "Renamed", payload
        assert payload[0]["custom"] == {"retained": True}, payload
        assert payload[0]["proxies"] == ["DIRECT"], payload
        assert not any(k.startswith(".") for k in payload[0]), payload
        page.get_by_role("button", name="Clone", exact=True).first.click()
        page.wait_for_timeout(200)
        click("Save collection")
        cloned = page.evaluate("calls.filter(c=>c.op==='collectionWrite'&&!c.draft).at(-1).data")
        assert len(cloned) == 3 and cloned[-1]["name"] == "Renamed-copy", cloned
        page.get_by_role("button", name="Delete", exact=True).last.click()
        page.wait_for_timeout(200)
        click("Save collection")
        assert len(page.evaluate("calls.filter(c=>c.op==='collectionWrite'&&!c.draft).at(-1).data")) == 2
        page.get_by_label("Collection", exact=True).select_option("listeners")
        page.wait_for_timeout(200)
        page.get_by_role("button", name="Edit", exact=True).first.click()
        page.locator('.modal input[id$=".port"]').fill("70000")
        click("Save")
        assert page.locator(".modal").is_visible()
        page.locator('.modal input[id$=".port"]').fill("9090")
        click("Save")
        click("Save collection")
        assert page.evaluate("calls.filter(c=>c.op==='collectionWrite'&&!c.draft).at(-1).data[0].port") == 9090
        screenshot("collections")
        mobile("collections")
        page.get_by_label("Collection", exact=True).select_option("proxy-providers")
        page.wait_for_timeout(200)
        assert page.get_by_label("Collection", exact=True).locator("option").count() == 3
        page.get_by_role("button", name="Edit", exact=True).first.click()
        click("Save")
        click("Preview effective YAML")
        assert page.evaluate("calls.filter(c=>c.op==='collectionWrite').at(-1).data.provider['health-check'].enable")
        click("Close")
        results.append("collections: real GridSection/modal, edit, range validation, typed payload, unknown fields, provider maps")
        visit("overrides?module=rules")
        assert page.get_by_label("Module", exact=True).input_value() == "rules"
        assert "nikki-rules" in page.locator("#view textarea").input_value()
        click("Preview merged configuration")
        click("Close")
        click("Review configuration changes")
        click("Close")
        screenshot("overrides")
        mobile("overrides")
        visit("rules-builder")
        assert page.url.endswith("/overrides?module=rules"), page.url
        results.append("advanced: module deep link, existing rule YAML, preview/review, legacy bookmark")
        assert not errors, errors
        browser.close()
finally:
    server.shutdown()
(args.output / "result.json").write_text(json.dumps({"passed":results,"page_errors":errors,"backend":"mock RPC, real LuCI modules and Bootstrap CSS"}, indent=2))
print(json.dumps(results, indent=2))
