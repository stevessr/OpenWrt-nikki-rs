#!/usr/bin/env python3
"""Validate a complete branch output before uploading or publishing it."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

from pack import TARGETS


def outer_control_data(path):
    with tarfile.open(path, "r:gz") as archive:
        return archive.extractfile("./control.tar.gz").read()


def inspect_ipk(path):
    with tarfile.open(path, "r:gz") as outer:
        control = outer.extractfile("./control.tar.gz").read()
        data = outer.extractfile("./data.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(control), mode="r:gz") as archive:
        text = archive.extractfile("./control").read().decode()
    info = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
    return info, data


def verify(output, branch, require_subboost=False, require_native_subboost=False):
    config = TARGETS["branches"][branch]
    common = {}
    count = 0
    for arch in TARGETS["architectures"]:
        if arch in config["exclude"]:
            continue
        feed = output / "public" / branch / arch / "nikki_rs"
        versions = json.loads((feed / "index.json").read_text())["packages"]
        assert {"nikki-rs", "clash-rs", "luci-app-nikki-rs"}.issubset(versions), feed
        if require_subboost:
            assert "luci-app-subboost" in versions, ("Missing SubBoost LuCI", feed)
        target = TARGETS["architectures"][arch]
        native_supported = (config["format"] == "apk" and target in {
            "x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"
        })
        if require_native_subboost:
            assert ("subboost-rs" in versions) == native_supported, (
                "Native SubBoost package missing or shipped to unsupported arch", feed)
        suffix = config["format"]
        paths = sorted(feed.glob("*." + suffix))
        assert len(paths) == len(versions), (feed, "Package count mismatch")
        for name, version in versions.items():
            universal = name.startswith("luci-")
            package_arch = ("all" if suffix == "ipk" else "noarch") if universal else arch
            filename = f"{name}_{version}_{package_arch}.ipk" if suffix == "ipk" else f"{name}-{version}.apk"
            path = feed / filename
            if suffix == "ipk":
                info, data = inspect_ipk(path)
                assert info["Package"] == name and info["Version"] == version, path
                assert info["Architecture"] == package_arch, path
                index = (feed / "Packages").read_text()
                checksum = hashlib.sha256(path.read_bytes()).hexdigest()
                assert f"Filename: {filename}\n" in index and f"SHA256sum: {checksum}\n" in index, path
                if name == "luci-app-subboost":
                    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                        paths = {member.name for member in archive}
                        assert "./www/luci-static/resources/view/subboost/settings.js" in paths, path
                        assert "./usr/share/rpcd/acl.d/luci-app-subboost.json" in paths, path
                        assert "./etc/config/subboost" in paths, path
                    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                        menu = json.loads(archive.extractfile(
                            "./usr/share/luci/menu.d/luci-app-subboost.json").read())
                        entry = menu["admin/services/subboost"]
                        assert entry["depends"]["acl"] == ["luci-app-subboost"], path
                        assert "uci" not in entry["depends"], ("Menu hidden by UCI", path)
                    with tarfile.open(fileobj=io.BytesIO(outer_control_data(path)), mode="r:gz") as archive:
                        conffiles = archive.extractfile("./conffiles").read().decode()
                        postinst = archive.extractfile("./postinst").read().decode()
                        assert "/etc/config/subboost" in conffiles, path
                        assert "luci-indexcache" in postinst, ("Missing LuCI refresh", path)
                        assert "/etc/init.d/rpcd reload" in postinst, path
                        assert "./postinst-pkg" not in archive.getnames(), path
                if name == "nikki-rs":
                    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                        assert archive.getmember("./etc/init.d/nikki-rs").mode == 0o755, path
                        assert archive.getmember("./etc/config/nikki-rs").mode == 0o600, path
                    digest = hashlib.sha256(data).hexdigest()
                    assert common.setdefault(name, digest) == digest, "Backend payload differs by architecture"
            else:
                result = subprocess.check_output(["apk", "adbdump", "--format", "json", str(path)])
                info = json.loads(result)["info"]
                assert info["name"] == name and info["version"] == version, path
                assert info["arch"] == package_arch, path
                if name == "subboost-rs":
                    assert "luci-app-subboost" in str(info.get("depends", [])), path
                    assert "procd" in str(info.get("depends", [])), path
            if universal:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                assert common.setdefault(name, digest) == digest, "Universal package differs by architecture"
        if suffix == "apk":
            index = json.loads(subprocess.check_output(
                ["apk", "adbdump", "--format", "json", str(feed / "packages.adb")]))
            names = {p["name"] for p in index["packages"]}
            assert names == set(versions), (feed, "APK index mismatch")
        release = output / "release" / f"nikki-rs_{arch}-{branch}.tar.gz"
        with tarfile.open(release, "r:gz") as archive:
            names = {Path(m.name).name for m in archive if m.isfile()}
            assert names == {p.name for p in feed.iterdir()}, release
        count += 1
    print(f"Verified {count} {branch} feeds: names, versions, architectures, indexes and common payloads")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".package-output"))
    parser.add_argument("--branch", required=True, choices=list(TARGETS["branches"]))
    parser.add_argument("--require-subboost", action="store_true")
    parser.add_argument("--require-native-subboost", action="store_true")
    args = parser.parse_args()
    verify(args.output, args.branch, require_subboost=args.require_subboost,
           require_native_subboost=args.require_native_subboost)
