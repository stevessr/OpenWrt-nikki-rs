#!/usr/bin/env python3
"""Stamp Nightly-only Nikki RS and LuCI release revisions in the build workspace.

Do not edit the repository Makefiles in source control. Package versions must
change every Nightly build so opkg/apk can detect an upgrade with unchanged
upstream PKG_VERSION. Native clash-rs retains its actual upstream version.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ("nikki-rs/Makefile", "luci-app-nikki-rs/Makefile")


def nightly_revision(now: datetime, run_number: int) -> str:
    if now.tzinfo is None or run_number < 1:
        raise ValueError("Nightly revision needs UTC-aware time and positive run number")
    return f"{now.astimezone(timezone.utc):%Y%m%d}{run_number:05d}"


def stamp_makefile(content: str, revision: str) -> str:
    if not revision.isdecimal():
        raise ValueError("Nightly revision must be numeric")
    updated, count = re.subn(r"(?m)^PKG_RELEASE:=\S+$", f"PKG_RELEASE:={revision}", content)
    if count != 1:
        raise ValueError("Expected exactly one PKG_RELEASE in Makefile")
    return updated


def main() -> None:
    run_number = int(os.environ["NIGHTLY_BUILD_NUMBER"])
    revision = nightly_revision(datetime.now(timezone.utc), run_number)
    for filename in PACKAGES:
        path = ROOT / filename
        path.write_text(stamp_makefile(path.read_text(), revision))
        print(f"{filename}: Nightly revision {revision}", flush=True)


if __name__ == "__main__":
    main()
