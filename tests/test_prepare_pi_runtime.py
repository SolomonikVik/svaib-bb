"""Pi package installation: copies, dependency resolution and failed updates.

All profiles/runtimes are temporary. Node really resolves the dependencies;
the npm boundary is controlled, with a separate real-npm local-registry test.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import threading
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

import test_prepare_methods as fixtures

helper = fixtures.helper
NODE = shutil.which('node')


@unittest.skipUnless(NODE, 'requires Node on the test host')
class PiRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.SharedMarketplaceTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.fixture.add_pi()
        self.data = self.fixture.data
        self.prepared = self.fixture.prepare('pi')
        self.node = Path(NODE).resolve()
        self.npm = self.fixture.base / 'npm cli.js'
        self.npm.touch()
        self.installs = []
        self.real_run = helper._run_runtime

    def dependency(self, root, version='0.87.0'):
        package = root / 'node_modules/pi-subagents'
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({
            'name': 'pi-subagents', 'version': version,
            'exports': {'.': './index.js', './required-child-extensions': './index.js', './delegation': './index.js'}}))
        (package / 'index.js').write_text('module.exports = function() {};')

    def npm_run(self, command, cwd, timeout, **kwargs):
        if command[1] != str(self.npm):
            return self.real_run(command, cwd, timeout, **kwargs)
        self.installs.append(command)
        self.assertIn('--install-links', command)
        self.assertIn('--ignore-scripts', command)
        source = Path(command[-1])
        package = cwd / 'node_modules/svaib-plugin'
        package.parent.mkdir()
        shutil.copytree(source, package)
        self.dependency(cwd)
        return b''

    def install(self):
        return helper.prepare_pi_runtime(self.prepared, self.data, self.node, self.npm)

    def ready_path(self):
        return self.data / 'plugins/svaib-workplace/pi-runtimes/.0.10.0.ready.json'

    def bump(self, version):
        for name in ['package.json', 'plugins/svaib/package.json',
                     'plugins/svaib/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']:
            path = self.fixture.bundle / name
            value = json.loads(path.read_text())
            if 'plugins' in value:
                value['plugins'][0]['version'] = version
            else:
                value['version'] = version
            path.write_text(json.dumps(value))
            self.fixture.rehash(name)
        path = self.fixture.source / 'methods/manifest.json'
        value = json.loads(path.read_text())
        value['method']['version'] = version
        path.write_text(json.dumps(value))

    def test_copy_resolves_dependency_and_repeated_install_reuses_verified_copy(self):
        with patch.object(helper, '_run_runtime', side_effect=self.npm_run):
            first = self.install()
            second = self.install()
        self.assertEqual(first['packageRoot'], second['packageRoot'])
        self.assertTrue(first['runtimeChanged'])
        self.assertFalse(second['runtimeChanged'])
        self.assertEqual(len(self.installs), 1)
        self.assertFalse(Path(first['packageRoot']).is_symlink())
        self.assertFalse((Path(self.prepared['marketplaceRoot']) / 'node_modules').exists())

    def test_new_source_version_and_revision_do_not_replace_prepared_bytes(self):
        root = Path(self.prepared['marketplaceRoot'])
        original = (root / 'package.json').read_bytes()
        inode = root.stat().st_ino
        manifest = self.fixture.source / 'methods/manifest.json'
        value = json.loads(manifest.read_text()); value['sourceRevision'] = 'new-build-same-content'
        manifest.write_text(json.dumps(value))
        self.assertFalse(self.fixture.prepare('pi')['changed'])
        self.assertEqual(root.stat().st_ino, inode)
        self.bump('0.10.1')
        next_source = self.fixture.prepare('pi')
        self.assertNotEqual(next_source['marketplaceRoot'], str(root))
        self.assertEqual((root / 'package.json').read_bytes(), original)

    @unittest.skipIf(os.name == 'nt', 'directory symlink requires Windows privileges')
    def test_ready_runtime_symlink_is_refused_before_npm(self):
        with patch.object(helper, '_run_runtime', side_effect=self.npm_run):
            first = self.install()
            root = Path(first['runtimeRoot'])
            saved = root.with_name(root.name + '-saved')
            root.rename(saved)
            root.symlink_to(saved, target_is_directory=True)
            self.installs.clear()
            with self.assertRaises(ValueError):
                self.install()
            self.assertFalse(self.installs)
            self.assertTrue(root.is_symlink())

    @unittest.skipIf(os.name == 'nt', 'directory symlink requires Windows privileges')
    def test_upgrade_leaves_legacy_link_and_previous_version_bytes_unchanged(self):
        methods = Path(self.prepared['marketplaceRoot']).parent
        legacy = methods / 'pi'
        if Path(self.prepared['marketplaceRoot']) != legacy:
            shutil.copytree(Path(self.prepared['marketplaceRoot']), legacy)
        link = self.data / 'plugins/svaib-workplace/runtime-pi-0.13.0/node_modules/svaib-plugin'
        link.parent.mkdir(parents=True)
        link.symlink_to(legacy, target_is_directory=True)
        legacy_bytes = (legacy / 'plugins/svaib/package.json').read_bytes()
        old_source = Path(self.prepared['marketplaceRoot'])
        self.bump('0.10.1')
        self.prepared = self.fixture.prepare('pi')
        self.assertNotEqual(old_source, Path(self.prepared['marketplaceRoot']))
        self.assertEqual((legacy / 'plugins/svaib/package.json').read_bytes(), legacy_bytes)
        self.assertEqual((old_source / 'plugins/svaib/package.json').read_bytes(), legacy_bytes)
        self.assertEqual((link / 'plugins/svaib/package.json').read_bytes(), legacy_bytes)
        with patch.object(helper, '_run_runtime', side_effect=self.npm_run):
            installed = self.install()
        self.assertEqual(json.loads((Path(installed['packageRoot']) / 'package.json').read_text())['version'], '0.10.1')

    def test_failed_repair_preserves_ready_pointer_and_broken_active_copy(self):
        with patch.object(helper, '_run_runtime', side_effect=self.npm_run):
            first = self.install()
            old = Path(first['runtimeRoot'])
            dependency = old / 'node_modules/pi-subagents/index.js'
            dependency.rename(dependency.with_suffix('.saved'))
            pointer = self.ready_path().read_bytes()

            def failing(command, cwd, timeout, **kwargs):
                if command[1] == str(self.npm):
                    raise helper.PreparationError('installer failed')
                return self.real_run(command, cwd, timeout, **kwargs)

            with patch.object(helper, '_run_runtime', side_effect=failing), self.assertRaises(ValueError):
                self.install()
            self.assertEqual(self.ready_path().read_bytes(), pointer)
            self.assertTrue(dependency.with_suffix('.saved').exists())
            repaired = self.install()
        self.assertNotEqual(repaired['runtimeRoot'], first['runtimeRoot'])
        self.assertTrue(dependency.with_suffix('.saved').exists())

    def test_npm_success_does_not_publish_missing_wrong_or_modified_package(self):
        for defect in ('missing', 'wrong-version', 'modified'):
            with self.subTest(defect=defect):
                def broken(command, cwd, timeout, **kwargs):
                    result = self.npm_run(command, cwd, timeout, **kwargs)
                    if command[1] == str(self.npm):
                        if defect == 'missing':
                            (cwd / 'node_modules/pi-subagents/index.js').unlink()
                        elif defect == 'wrong-version':
                            path = cwd / 'node_modules/pi-subagents/package.json'
                            value = json.loads(path.read_text()); value['version'] = '0.86.0'
                            path.write_text(json.dumps(value))
                        else:
                            (cwd / 'node_modules/svaib-plugin/plugins/svaib/pi/delegation.ts').write_text('changed')
                    return result
                with patch.object(helper, '_run_runtime', side_effect=broken), self.assertRaises(ValueError):
                    self.install()
                self.assertFalse(self.ready_path().exists())

    @unittest.skipIf(os.name == 'nt', 'directory symlink requires Windows privileges')
    def test_npm_link_is_rejected_even_if_dependencies_resolve_elsewhere(self):
        def linked(command, cwd, timeout, **kwargs):
            if command[1] != str(self.npm):
                return self.real_run(command, cwd, timeout, **kwargs)
            package = cwd / 'node_modules/svaib-plugin'
            package.parent.mkdir()
            package.symlink_to(command[-1], target_is_directory=True)
            self.dependency(cwd)
            return b''
        with patch.object(helper, '_run_runtime', side_effect=linked), self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.ready_path().exists())

    def test_unknown_owner_and_busy_lock_refuse_before_npm(self):
        with patch.object(helper, '_run_runtime', side_effect=self.npm_run):
            self.install()
            self.installs.clear()
            pointer = self.ready_path()
            original = pointer.read_bytes()
            pointer.write_text('{"schema":999}')
            with self.assertRaises(ValueError):
                self.install()
            self.assertEqual(pointer.read_text(), '{"schema":999}')
            pointer.write_bytes(original)
            (pointer.parent / '.prepare.lock').write_text('busy')
            with self.assertRaises(ValueError):
                self.install()
            self.assertFalse(self.installs)

    def test_cli_requires_complete_pi_runtime_arguments_before_copy(self):
        with patch.object(sys, 'argv', ['prepare_methods.py', '--provider', 'pi', '--data-dir', str(self.data)]), \
                patch.object(helper, 'check_hook_runtime'), patch.object(helper, 'prepare') as prepare, \
                redirect_stderr(io.StringIO()) as error:
            with self.assertRaises(SystemExit):
                helper.main()
        prepare.assert_not_called()
        self.assertIn('--npm-cli', error.getvalue())

    def test_real_npm_packs_local_source_and_installs_dependency_from_local_registry(self):
        # Do not use registry credentials or the user's global npm cache.
        npm = next((path for path in [self.node.parent / 'node_modules/npm/bin/npm-cli.js',
                    self.node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'] if path.is_file()), None)
        if npm is None:
            self.skipTest('npm-cli.js is not adjacent to the selected Node installation')
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            for name, raw in {'package.json': json.dumps({'name': 'pi-subagents', 'version': '0.87.0',
                    'exports': {'.': './index.js', './required-child-extensions': './index.js', './delegation': './index.js'}}).encode(),
                    'index.js': b'module.exports = function() {};'} .items():
                info = tarfile.TarInfo('package/' + name); info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        tarball = content.getvalue()

        class Registry(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == '/pi-subagents':
                    body = json.dumps({'name': 'pi-subagents', 'dist-tags': {'latest': '0.87.0'}, 'versions': {'0.87.0': {
                        'name': 'pi-subagents', 'version': '0.87.0', 'dist': {
                            'tarball': f'http://127.0.0.1:{self.server.server_port}/fixture.tgz',
                            'shasum': hashlib.sha1(tarball).hexdigest()}}}}).encode()
                elif self.path == '/fixture.tgz':
                    body = tarball
                else:
                    self.send_error(404); return
                self.send_response(200); self.end_headers(); self.wfile.write(body)

        registry = ThreadingHTTPServer(('127.0.0.1', 0), Registry)
        thread = threading.Thread(target=registry.serve_forever, daemon=True); thread.start()
        try:
            with patch.dict(os.environ, {'npm_config_registry': f'http://127.0.0.1:{registry.server_port}',
                                         'npm_config_userconfig': str(self.fixture.base / 'empty-npmrc')}):
                installed = helper.prepare_pi_runtime(self.prepared, self.data, self.node, npm)
            self.assertFalse(Path(installed['packageRoot']).is_symlink())
            self.assertTrue((Path(installed['runtimeRoot']) / 'node_modules/pi-subagents/index.js').is_file())
            self.assertFalse((Path(self.prepared['marketplaceRoot']) / 'node_modules').exists())
        finally:
            registry.shutdown(); registry.server_close(); thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
