"""Release-boundary checks; the workflow also installs and checks the real tarball."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("npm_release", Path(__file__).with_name("npm_release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.package = {
            "name": release.NAME, "version": "0.5.5", "private": True,
            "bb": {"description": "Fixture"},
            "dependencies": {release.LOCAL_DEPENDENCY: "file:./components/screen", "zod": "^4.6.5"},
            "scripts": {"prepare": "must not execute"},
        }
        release.write_json(self.root / "package.json", self.package)
        (self.root / "methods").mkdir()
        release.write_json(self.root / "methods/manifest.json", {"method": {"version": "0.11.0"}})
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture"], check=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_manifest_ships_builds_and_local_dependency_without_publish_hooks(self):
        release.prepare(self.root, "v0.5.5")
        package = release.read_json(self.root / "package.json")
        self.assertNotIn("private", package)
        self.assertNotIn("scripts", package)
        self.assertIn("dist/", package["files"])
        self.assertIn("methods/", package["files"])
        self.assertEqual(package["bundleDependencies"], [release.LOCAL_DEPENDENCY])
        self.assertEqual(package["publishConfig"]["registry"], "https://registry.npmjs.org/")
        self.assertEqual(release.read_json(self.root / "npm-release.json")["tag"], "v0.5.5")

    def test_wrong_version_or_non_release_ref_refuses_prepare(self):
        for tag in ("main", "v0.5.6", "v0.5.5-beta.1", "v0.5.5;echo bad"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.prepare(self.root, tag)
        self.assertFalse((self.root / "npm-release.json").exists())

    def test_other_local_url_or_git_dependencies_are_refused(self):
        for dependency in ("git+https://example.invalid/repo", "file:../outside", "https://example.invalid/pkg.tgz"):
            self.package["dependencies"]["zod"] = dependency
            release.write_json(self.root / "package.json", self.package)
            with self.subTest(dependency=dependency), self.assertRaises(ValueError):
                release.prepare(self.root, "v0.5.5")

    def test_unexported_screen_path_is_refused(self):
        self.package["dependencies"][release.LOCAL_DEPENDENCY] = "file:../screen/pilot"
        release.write_json(self.root / "package.json", self.package)
        with self.assertRaises(ValueError):
            release.prepare(self.root, "v0.5.5")

    def test_tarball_receipt_detects_changed_bytes(self):
        tarball = self.root / "fixture.tgz"
        tarball.write_bytes(b"verified artifact")
        output = self.root / "receipt.json"
        release.receipt(tarball, output)
        receipt = release.read_json(output)
        self.assertEqual(receipt["sha256"], release.hashlib.sha256(tarball.read_bytes()).hexdigest())
        tarball.write_bytes(b"replaced artifact")
        self.assertNotEqual(receipt["sha256"], release.hashlib.sha256(tarball.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
