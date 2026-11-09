"""Prepare and verify the npm distribution of an already exported BB plugin."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

NAME = "bb-plugin-svaib-workplace"
REPOSITORY = "https://github.com/SolomonikVik/svaib-bb"
LOCAL_DEPENDENCY = "bb-plugin-svaib-screen-pilot"
FILES = [
    "*.ts", "*.tsx", "*.css", "tsconfig.json", "assets/", "components/",
    "dist/", "experiments/account-prototype/", "methods/", "npm-release.json",
    "scripts/prepare_methods.py", "scripts/setup-kimi-cc.mjs",
    "scripts/setup-kimi-cc.d.mts", "PLUGIN_OVERVIEW.md", "README.md",
]


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def validate_identity(package, tag):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Use a stable release tag: vX.Y.Z")
    if package.get("name") != NAME or package.get("version") != tag[1:]:
        raise ValueError("Release tag must match the plugin package name and version")


def prepare(root, tag):
    package = read_json(root / "package.json")
    validate_identity(package, tag)
    dependencies = package.get("dependencies", {})
    if dependencies.get(LOCAL_DEPENDENCY) not in (
        "file:./components/screen", "file:components/screen"
    ):
        raise ValueError("Expected the exported local Screen dependency")
    for name, value in dependencies.items():
        if name != LOCAL_DEPENDENCY and not re.fullmatch(r"[0-9^~*<>=| .xX-]+", value):
            raise ValueError("Only registry version dependencies are allowed: " + name)
    package.pop("private", None)
    package["description"] = package["bb"]["description"]
    package["repository"] = {"type": "git", "url": "git+" + REPOSITORY + ".git"}
    package["homepage"] = REPOSITORY + "#readme"
    package["bugs"] = {"url": REPOSITORY + "/issues"}
    package["publishConfig"] = {"registry": "https://registry.npmjs.org/", "access": "public"}
    package["files"] = FILES
    # A file: dependency is unavailable on the user's computer. Ship it, including
    # its runtime dependency closure, inside the tarball instead of resolving it.
    package["bundleDependencies"] = [LOCAL_DEPENDENCY]
    package.pop("scripts", None)
    write_json(root / "package.json", package)
    revision = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    write_json(root / "npm-release.json", {
        "repository": REPOSITORY, "tag": tag, "commit": revision,
        "pluginVersion": package["version"],
        "methodVersion": read_json(root / "methods/manifest.json")["method"]["version"],
    })


def verify_portable(root):
    """The consumer must not need a compiler or OS-specific native add-on."""
    binary_headers = (b"\x7fELF", b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
                      b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
                      b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca")
    # npm may hoist registry dependencies beside the plugin. Check the entire
    # installed dependency tree, not only files nested inside the package.
    scan_root = root.parent if root.parent.name == "node_modules" else root
    for path in scan_root.rglob("*"):
        relative = path.relative_to(scan_root)
        if any(part in ("esbuild", "@esbuild") for part in relative.parts):
            raise ValueError("Build tool must not ship to the consumer: " + str(relative))
        if not path.is_file():
            continue
        if (path.suffix.lower() in (".node", ".dylib", ".dll", ".exe")
                or re.search(r"\.so(?:\.[0-9]+)*$", path.name)):
            raise ValueError("Native binary must not ship to the consumer: " + str(relative))
        with path.open("rb") as file:
            header = file.read(4)
        if header in binary_headers or header[:2] == b"MZ":
            raise ValueError("Platform executable must not ship to the consumer: " + str(relative))
    package = read_json(root / "package.json")
    if any(hook in package.get("scripts", {}) for hook in ("preinstall", "install", "postinstall", "prepare")):
        raise ValueError("The published plugin must not have installation/build hooks")


def verify(root, tag):
    package = read_json(root / "package.json")
    validate_identity(package, tag)
    if package.get("private") or LOCAL_DEPENDENCY not in package.get("bundleDependencies", []):
        raise ValueError("Package must be public and include the local Screen dependency")
    if read_json(root / "npm-release.json")["tag"] != tag:
        raise ValueError("Release receipt does not match the tag")
    for kind in ("server", "app", "host"):
        if kind not in package["bb"]:
            continue
        meta = read_json(root / f"dist/{kind}.meta.json")
        if meta.get("pluginId") != "svaib-workplace" or meta.get("pluginVersion") != tag[1:]:
            raise ValueError("Bundle identity mismatch: " + kind)
        if meta.get("artifactFormatVersion") != 1:
            raise ValueError("Unsupported bundle format: " + kind)
        if (root / f"dist/{kind}.js").stat().st_size == 0:
            raise ValueError("Empty bundle: " + kind)
        if not (root / package["bb"][kind]).is_file():
            raise ValueError("Missing declared source entry: " + kind)
    if not (root / "dist/app.css").is_file():
        raise ValueError("Missing frontend stylesheet")
    if not (root / "node_modules" / LOCAL_DEPENDENCY / "package.json").is_file():
        raise ValueError("Missing bundled Screen component")
    verify_portable(root)
    spec = importlib.util.spec_from_file_location("prepare_methods", root / "scripts/prepare_methods.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    with tempfile.TemporaryDirectory() as temp:
        data_dir = Path(temp).resolve()
        for provider in ("codex", "claude"):
            helper.prepare(provider, data_dir, source_root=root)
    manifest = read_json(root / "methods/manifest.json")
    return {"package": NAME, "version": package["version"],
            "methodVersion": manifest["method"]["version"], "providers": ["codex", "claude"]}


def receipt(tarball, output):
    raw = tarball.read_bytes()
    write_json(output, {"filename": tarball.name, "bytes": len(raw),
                        "sha256": hashlib.sha256(raw).hexdigest()})


def wait_registry(tag, tarball, timeout):
    validate_identity({"name": NAME, "version": tag.removeprefix("v")}, tag)
    expected = hashlib.sha1(tarball.read_bytes()).hexdigest()
    deadline = time.monotonic() + timeout
    url = f"https://registry.npmjs.org/{NAME}/{tag[1:]}"
    while True:
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                package = json.load(response)
            if package["dist"]["shasum"] != expected:
                raise ValueError("Registry tarball differs from the verified build artifact")
            print(json.dumps({"name": package["name"], "version": package["version"],
                              "integrity": package["dist"]["integrity"]}))
            return
        except urllib.error.HTTPError as error:
            if error.code not in (404, 429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError("npm accepted publication but the package is not publicly available yet; do not republish")
        time.sleep(min(10, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "verify", "receipt", "wait-registry"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--tag")
    parser.add_argument("--tarball", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    if args.action == "wait-registry":
        if not args.tag or not args.tarball:
            parser.error("wait-registry requires --tag and --tarball")
        wait_registry(args.tag, args.tarball, args.timeout)
    elif args.action == "receipt":
        if not args.tarball or not args.output:
            parser.error("receipt requires --tarball and --output")
        receipt(args.tarball, args.output)
    else:
        if not args.root or not args.tag:
            parser.error("prepare/verify require --root and --tag")
        root = args.root.resolve()
        result = prepare(root, args.tag) if args.action == "prepare" else verify(root, args.tag)
        print(json.dumps(result))


if __name__ == "__main__":
    main()
