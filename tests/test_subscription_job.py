"""Exercise detached subscription startup and completion without network."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'nikki-rs/files/scripts/subscription-job.sh'

class SubscriptionJobTest(unittest.TestCase):
    def test_detached_update_finishes_and_rejects_unsaved_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / 'bin'
            bindir.mkdir()
            uci = bindir / 'uci'
            uci.write_text('#!/bin/sh\ncase "$*" in *good.success*) echo 1;; *good*) echo subscription;; *) exit 1;; esac\n')
            service = root / 'service'
            service.write_text('#!/bin/sh\nsleep 0.2\nexit 0\n')
            for file in (uci, service): file.chmod(0o755)
            env = dict(os.environ, PATH=str(bindir)+os.pathsep+os.environ['PATH'],
                       NIKKI_JOB_DIR=str(root/'jobs'), NIKKI_SERVICE=str(service))
            subprocess.run(['sh', str(SCRIPT), 'start', 'bad'], env=env, check=False)
            self.assertFalse((root/'jobs/bad.state').exists())
            subprocess.run(['sh', str(SCRIPT), 'start', 'good'], env=env, check=True, capture_output=True, timeout=2)
            repeated = subprocess.run(['sh', str(SCRIPT), 'start', 'good'], env=env, capture_output=True)
            self.assertNotEqual(repeated.returncode, 0)
            deadline = time.monotonic()+3
            while (root/'jobs/good.state').read_text().strip() == 'running' and time.monotonic()<deadline:
                time.sleep(0.03)
            self.assertEqual((root/'jobs/good.state').read_text().strip(), 'success')
            self.assertFalse((root/'jobs/good.lock').exists())
