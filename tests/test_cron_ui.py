"""Exercise the exact LuCI Cron validator, not a Python reimplementation."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is required")
class CronUITest(unittest.TestCase):
    def test_crond_expression_validation(self):
        source = ROOT / "luci-app-nikki-rs/htdocs/luci-static/resources/tools/nikki-cron.js"
        subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cron = new Function('baseclass','_',fs.readFileSync(process.argv[1],'utf8'))(
    {extend: value => value}, value => value);
for (const value of [
    '0 3 * * *', '0 3 * * 0', '0 3 * * 1-5', '0 3 1 * *',
    '*/15 0-23/2 1,15 JAN,DEC MON-FRI', '59 23 31 12 6',
    '  0\t3  * * *  ', '* * * * *', '0 22-2 * * *'
]) assert.equal(cron.valid(value.replace('\\t','\t')), true, value);
for (const value of [
    '', '* * * *', '* * * * * *', '@reboot', '60 3 * * *', '0 24 * * *',
    '0 3 0 * *', '0 3 * 13 *', '0 3 * * 7', '0 3 * * FUNDAY',
    '*/0 * * * *', '*/-1 * * * *', '*/1.5 * * * *',
    '0,,1 * * * *', '0- * * * *', '0/2/3 * * * *',
    '0 3 * * *\n* * * * *', '0 3 * * *; reboot', '0 3 * * * # comment',
    '0 3 * * *\r', null, undefined
]) assert.equal(cron.valid(value), false, String(value));
assert.equal(cron.validate('config','0 3 * * *'), true);
assert.equal(typeof cron.validate('config','bad'), 'string');
""", str(source)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
