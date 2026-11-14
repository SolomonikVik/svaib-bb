"""Filesystem policy acceptance for the shipped stable-marketplace preparation helper."""
import hashlib
import importlib.util
import json
import io
import os
import subprocess
import sys
from contextlib import redirect_stderr
from pathlib import Path
import tempfile
import unittest
import venv
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prepare_methods.py'
spec = importlib.util.spec_from_file_location('prepare_methods', SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HookRuntimeTests(unittest.TestCase):
    def test_missing_python3_stops_cli_before_copying_methods(self):
        with patch.dict(os.environ), \
                patch.object(sys, 'argv', ['prepare_methods.py', '--provider', 'claude', '--data-dir', '/unused']), \
                patch.object(helper.shutil, 'which', return_value=None), \
                patch.object(helper, 'prepare') as prepare, redirect_stderr(io.StringIO()) as error:
            os.environ.pop('SVAIB_PYTHON', None)
            with self.assertRaises(SystemExit) as stopped:
                helper.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn('python3 3.10+', error.getvalue())
        self.assertIn('Git Bash', error.getvalue())
        prepare.assert_not_called()

    def test_alias_old_python_failed_start_and_timeout_do_not_pass_as_a_runtime(self):
        failures = [
            subprocess.CompletedProcess([], 0, stdout=b''),
            subprocess.CompletedProcess([], 1, stdout=b''),
            OSError('not executable'),
            subprocess.TimeoutExpired('python3', 5),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(helper.shutil, 'which', return_value='/path with spaces/python3'), \
                    patch.object(helper.subprocess, 'run') as run:
                if isinstance(failure, Exception):
                    run.side_effect = failure
                else:
                    run.return_value = failure
                with self.assertRaises(helper.HookRuntimeError):
                    helper.check_hook_runtime('claude')
                self.assertEqual(run.call_args.args[0][0], '/path with spaces/python3')
                self.assertFalse(run.call_args.kwargs.get('shell', False))

    def test_actual_python3_can_run_without_a_shell(self):
        if not helper.shutil.which('python3'):
            self.skipTest('python3 is not installed on this test host')
        helper.check_hook_runtime('claude')

    def test_all_providers_use_the_same_verified_override(self):
        override = '/Python with spaces/python'
        for provider, selected in [('pi', override), ('claude', override), ('codex', override)]:
            with self.subTest(provider=provider), patch.dict(os.environ, {'SVAIB_PYTHON': override}), \
                    patch.object(helper.shutil, 'which', return_value=selected) as which, \
                    patch.object(helper.subprocess, 'run', return_value=
                                 subprocess.CompletedProcess([], 0, stdout=b'svaib-hook-python-ok\n')) as run:
                helper.check_hook_runtime(provider)
                which.assert_called_once_with(selected)
                self.assertEqual(run.call_args.args[0][0], selected)
                self.assertFalse(run.call_args.kwargs.get('shell', False))

    def test_pi_missing_or_empty_override_uses_python3(self):
        for override in [None, '']:
            with self.subTest(override=override), patch.dict(os.environ), \
                    patch.object(helper.shutil, 'which', return_value=None) as which:
                if override is None:
                    os.environ.pop('SVAIB_PYTHON', None)
                else:
                    os.environ['SVAIB_PYTHON'] = override
                with self.assertRaisesRegex(helper.HookRuntimeError, 'python3 3.10+'):
                    helper.check_hook_runtime('pi')
                which.assert_called_once_with('python3')

    def test_pi_invalid_override_stops_cli_without_fallback_or_copy(self):
        with patch.object(sys, 'argv', ['prepare_methods.py', '--provider', 'pi', '--data-dir', '/unused']), \
                patch.dict(os.environ, {'SVAIB_PYTHON': '/missing/python'}), \
                patch.object(helper.shutil, 'which', return_value=None) as which, \
                patch.object(helper, 'prepare') as prepare, redirect_stderr(io.StringIO()) as error:
            with self.assertRaises(SystemExit) as stopped:
                helper.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn('SVAIB_PYTHON', error.getvalue())
        self.assertNotIn('/missing/python', error.getvalue())
        which.assert_called_once_with('/missing/python')
        prepare.assert_not_called()

    def test_pi_override_really_runs_with_spaces_and_no_shell_on_path(self):
        with tempfile.TemporaryDirectory(prefix='svaib python ') as folder:
            # A bare Windows python.exe symlink is not a Python installation:
            # its relocated DLL/stdlib search can fail before our helper runs.
            # A standard venv supplies the redirector and pyvenv.cfg together.
            runtime = Path(folder) / 'Python runtime с пробелами'
            venv.EnvBuilder(with_pip=False).create(runtime)
            executable = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            with patch.dict(os.environ, {'SVAIB_PYTHON': str(executable), 'PATH': '',
                                        'SVAIB_STATE_DIR': str(Path(folder) / 'state')}):
                independent = subprocess.run([str(executable), '-c', 'print("fixture-python-ok")'],
                                             capture_output=True, timeout=10, check=False)
                self.assertEqual(independent.returncode, 0, independent.stderr)
                self.assertEqual(independent.stdout.strip(), b'fixture-python-ok')
                helper.check_hook_runtime('pi')
                bridge = SCRIPT.parents[3] / 'product/plugin/hooks/bridge_pi.py'
                if not bridge.is_file():
                    bridge = SCRIPT.parents[1] / 'methods/common/plugins/svaib/hooks/bridge_pi.py'
                self.assertTrue(bridge.is_file(), 'Expected the source or bundled Pi bridge')
                # Same direct argv boundary as Pi's extension, with no shell in PATH.
                result = subprocess.run([str(executable), str(bridge), 'pre'],
                                        input=json.dumps({'session_id': 'pi-runtime-check', 'cwd': folder,
                                                          'tool_name': 'read', 'tool_input': {'path': 'README.md'}}),
                                        text=True, capture_output=True, timeout=10, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsInstance(json.loads(result.stdout), dict)


def write_bundle(source, version='0.9.0', host='codex', content='original', *,
                 provider='codex', shared=False):
    source.mkdir(exist_ok=True)
    (source / 'package.json').write_text(json.dumps({'name': 'bb-plugin-svaib-workplace'}))
    root = source / ('methods/common' if shared else 'methods/' + provider)
    files = {
        '.claude-plugin/marketplace.json': json.dumps({'name': 'svaib', 'plugins': [{
            'name': 'svaib', 'source': './plugins/svaib', 'version': version,
        }]}),
        'plugins/svaib/.claude-plugin/plugin.json': json.dumps({'name': 'svaib', 'version': version}),
        'plugins/svaib/hooks/hooks.json': json.dumps({'hooks': {'SessionStart': [{'hooks': [
            {'command': 'python3 inject_company.py ' + host},
            {'command': 'python3 inject_space_map.py event ' + host},
        ]}]}}),
        'plugins/svaib/skills/example/SKILL.md': content,
        'plugins/svaib/skills/onboarding/references/stages.json': '{"schema":1,"catalog":2}',
    }
    for name, raw in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(raw)
    entry = {
        'root': root.relative_to(source).as_posix(), 'version': version,
        'host': 'auto' if shared else provider,
        'files': {name: hashlib.sha256(raw.encode()).hexdigest() for name, raw in files.items()},
    }
    manifest = {'schema': 2 if shared else 1, 'sourceRevision': 'synthetic'}
    if shared:
        manifest['method'] = entry
        manifest['onboardingCatalogSha256'] = hashlib.sha256(
            files['plugins/svaib/skills/onboarding/references/stages.json'].encode()).hexdigest()
    else:
        manifest['providers'] = {provider: entry}
    (source / 'methods/manifest.json').write_text(json.dumps(manifest))
    return root


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.bundle = write_bundle(self.source)
        self.data = self.base / 'bb-data'
        self.data.mkdir()
        self.target = self.data / 'plugins/svaib-workplace/methods/codex'

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        return helper.prepare('codex', self.data, source_root=self.source)

    def test_install_is_idempotent_and_stable_across_release_update(self):
        first = self.prepare()
        self.assertTrue(first['changed'])
        self.assertFalse(self.prepare()['changed'])
        write_bundle(self.source, '0.9.1', content='updated')
        second = self.prepare()
        self.assertEqual(first['marketplaceRoot'], second['marketplaceRoot'])
        self.assertEqual(second['version'], '0.9.1')
        self.assertEqual((self.target / 'plugins/svaib/skills/example/SKILL.md').read_text(), 'updated')
        previous = list(self.target.parent.glob('.previous-codex-*'))
        self.assertEqual(len(previous), 1)
        self.assertEqual((previous[0] / 'plugins/svaib/skills/example/SKILL.md').read_text(), 'original')

    def test_unowned_existing_target_is_untouched(self):
        self.target.mkdir(parents=True)
        (self.target / 'personal.txt').write_text('keep')
        with self.assertRaises((ValueError, OSError)):
            self.prepare()
        self.assertEqual((self.target / 'personal.txt').read_text(), 'keep')

    def test_owned_target_with_foreign_file_is_untouched(self):
        self.prepare()
        (self.target / 'personal.txt').write_text('keep')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual((self.target / 'personal.txt').read_text(), 'keep')

    def test_owned_target_with_foreign_empty_directory_is_refused(self):
        self.prepare()
        (self.target / 'foreign').mkdir()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertTrue((self.target / 'foreign').is_dir())

    def test_tampered_owned_file_is_untouched(self):
        self.prepare()
        path = self.target / 'plugins/svaib/skills/example/SKILL.md'
        path.write_text('local edits')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(path.read_text(), 'local edits')

    def test_tampered_source_cannot_be_copied(self):
        (self.bundle / 'plugins/svaib/skills/example/SKILL.md').write_text('bad')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_wrong_native_host_cannot_be_copied(self):
        write_bundle(self.source, host='claude')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_legacy_manifest_cannot_silently_accept_auto_hooks(self):
        write_bundle(self.source, host='auto')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_source_symlink_cannot_escape(self):
        path = self.bundle / 'plugins/svaib/skills/example/SKILL.md'
        path.unlink()
        outside = self.base / 'outside'
        outside.write_text('original')
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.target.exists())
        self.assertEqual(outside.read_text(), 'original')

    def test_destination_symlink_cannot_escape(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.data / 'plugins').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(list(outside.iterdir()), [])

    def test_legacy_marketplace_keeps_newer_version(self):
        write_bundle(self.source, '0.9.1')
        first = self.prepare()
        marker = self.target.parent / '.codex.owner.json'
        before = marker.read_bytes()
        write_bundle(self.source, '0.9.0')
        self.assertEqual(self.prepare(), {**first, 'changed': False})
        self.assertEqual(marker.read_bytes(), before)
        self.assertEqual(json.loads((self.target / 'plugins/svaib/.claude-plugin/plugin.json').read_text())['version'], '0.9.1')

    def test_existing_preparation_lock_is_not_removed(self):
        self.prepare()
        lock = self.target.parent / '.prepare-codex.lock'
        lock.write_text('another process')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(lock.read_text(), 'another process')

    def test_marker_write_failure_restores_previous_owned_tree(self):
        self.prepare()
        write_bundle(self.source, '0.9.1', content='updated')
        with patch.object(helper.os, 'replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                self.prepare()
        self.assertEqual((self.target / 'plugins/svaib/skills/example/SKILL.md').read_text(), 'original')
        self.assertFalse((self.target.parent / '.prepare-codex.lock').exists())


class SharedMarketplaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.bundle = write_bundle(self.source, '0.10.0', 'auto', shared=True)
        self.data = self.base / 'bb-data'
        self.data.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, provider='codex'):
        return helper.prepare(provider, self.data, source_root=self.source)

    def add_pi(self):
        for name, prefix in [('package.json', './plugins/svaib/'),
                             ('plugins/svaib/package.json', './')]:
            path = self.bundle / name
            path.write_text(json.dumps({'name': 'svaib-plugin', 'version': '0.10.0',
                'dependencies': {'pi-subagents': '0.87.0'},
                'pi': {'extensions': [prefix + 'pi/extension.ts'], 'skills': [prefix + 'skills']}}))
            self.rehash(name)
        for name in ('pi/extension.ts', 'pi/child-extension.ts', 'pi/delegation.ts', 'pi/kimi-schema.ts', 'pi/usage-snapshot.ts', 'hooks/bridge_pi.py',
                     'hooks/usage_pi.py', 'hooks/usage_log.py', 'hooks/usage_claude.py',
                     'hooks/hook_space.py', 'hooks/company_context.py', 'hooks/company_operations.json',
                     'hooks/inject_company.py', 'hooks/inject_space_map.py', 'hooks/space_map.py',
                     'hooks/inject_file_spec.py', 'hooks/check_deferred_actions.py',
                     'skills/space-scaffold/file-specs/00_general.md', '.mcp.json', 'agents/svaib-scout.md'):
            relative = 'plugins/svaib/' + name
            path = self.bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"mcpServers":{"svaib":{"url":"https://api.svaib.com/mcp"}}}' if name == '.mcp.json' else 'fixture')
            self.rehash(relative)

    def test_pi_uses_common_bytes_and_its_own_stable_installation(self):
        self.add_pi()
        pi, codex, claude = [self.prepare(p) for p in ('pi', 'codex', 'claude')]
        self.assertEqual(len({r['marketplaceRoot'] for r in (pi, codex, claude)}), 3)
        expected = helper._object(self.source / 'methods/manifest.json')['method']['files']
        for result in (pi, codex, claude):
            self.assertEqual(helper._snapshot(Path(result['marketplaceRoot']), expected),
                             helper._snapshot(self.bundle, expected))
        self.assertFalse(self.prepare('pi')['changed'])

    def test_pi_refuses_legacy_payload_without_affecting_claude_codex(self):
        with self.assertRaises((ValueError, KeyError)):
            self.prepare('pi')
        self.assertTrue(self.prepare('codex')['changed'])
        self.assertTrue(self.prepare('claude')['changed'])

    def test_pi_refuses_wrong_entrypoint_and_missing_child_policy(self):
        self.add_pi()
        (self.bundle / 'plugins/svaib/pi/child-extension.ts').write_text('')
        self.rehash('plugins/svaib/pi/child-extension.ts')
        with self.assertRaises(ValueError):
            self.prepare('pi')
        self.add_pi()
        package = self.bundle / 'package.json'
        value = json.loads(package.read_text())
        value['pi']['extensions'] = ['./other.ts']
        package.write_text(json.dumps(value))
        self.rehash('package.json')
        with self.assertRaises(ValueError):
            self.prepare('pi')

    def test_pi_refuses_missing_shared_gate_and_wrong_mcp(self):
        self.add_pi()
        path = self.bundle / 'plugins/svaib/hooks/inject_file_spec.py'
        path.write_text('')
        self.rehash(path.relative_to(self.bundle).as_posix())
        with self.assertRaises(ValueError):
            self.prepare('pi')
        self.add_pi()
        path = self.bundle / 'plugins/svaib/.mcp.json'
        path.write_text('{"mcpServers":{"svaib":{"url":"https://other.example/mcp"}}}')
        self.rehash(path.relative_to(self.bundle).as_posix())
        with self.assertRaises(ValueError):
            self.prepare('pi')
    def test_one_bundle_prepares_identical_bytes_for_both_providers(self):
        results = [self.prepare(provider) for provider in ('codex', 'claude')]
        self.assertNotEqual(results[0]['marketplaceRoot'], results[1]['marketplaceRoot'])
        expected = helper._object(self.source / 'methods/manifest.json')['method']['files']
        for provider, result in zip(('codex', 'claude'), results):
            with self.subTest(provider=provider):
                self.assertEqual(result['version'], '0.10.0')
                self.assertEqual(result['provider'], provider)
                self.assertEqual(helper._snapshot(Path(result['marketplaceRoot']), expected),
                                 helper._snapshot(self.bundle, expected))
                self.assertFalse(self.prepare(provider)['changed'])

    def test_legacy_upgrade_preserves_each_provider_marketplace_path(self):
        previous = {}
        for provider in ('codex', 'claude'):
            write_bundle(self.source, '0.9.2', provider, provider=provider)
            previous[provider] = self.prepare(provider)['marketplaceRoot']
        write_bundle(self.source, '0.10.0', 'auto', shared=True)
        for provider in ('codex', 'claude'):
            result = self.prepare(provider)
            self.assertEqual(result['marketplaceRoot'], previous[provider])
            self.assertTrue(result['changed'])
            self.assertEqual(result['version'], '0.10.0')

    def test_common_bundle_refuses_explicit_or_mixed_hosts(self):
        for host in ('codex', 'claude'):
            with self.subTest(host=host):
                write_bundle(self.source, '0.10.0', host, shared=True)
                with self.assertRaises(ValueError):
                    self.prepare()
        write_bundle(self.source, '0.10.0', 'auto', shared=True)
        hooks = self.bundle / 'plugins/svaib/hooks/hooks.json'
        hooks.write_text(hooks.read_text().replace('event auto', 'event claude'))
        self.rehash('plugins/svaib/hooks/hooks.json')
        with self.assertRaises(ValueError):
            self.prepare()

    def rehash(self, name):
        path = self.source / 'methods/manifest.json'
        manifest = helper._object(path)
        manifest['method']['files'][name] = hashlib.sha256((self.bundle / name).read_bytes()).hexdigest()
        path.write_text(json.dumps(manifest))

    def test_common_manifest_rejects_escaping_root_and_host_override(self):
        path = self.source / 'methods/manifest.json'
        original = path.read_text()
        for key, value in (('root', '../outside'), ('host', 'codex')):
            with self.subTest(key=key):
                manifest = json.loads(original)
                manifest['method'][key] = value
                path.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    self.prepare()

    def test_common_identity_and_catalog_mismatch_are_refused(self):
        path = self.bundle / 'plugins/svaib/.claude-plugin/plugin.json'
        path.write_text(json.dumps({'name': 'different', 'version': '0.10.0'}))
        self.rehash(path.relative_to(self.bundle).as_posix())
        with self.assertRaises(ValueError):
            self.prepare()
        write_bundle(self.source, '0.10.0', 'auto', shared=True)
        path = self.bundle / 'plugins/svaib/skills/onboarding/references/stages.json'
        path.write_text('{"schema":1,"catalog":999}')
        self.rehash(path.relative_to(self.bundle).as_posix())
        with self.assertRaises(ValueError):
            self.prepare()

    def test_common_source_tampering_and_symlinks_are_refused(self):
        path = self.bundle / 'plugins/svaib/skills/example/SKILL.md'
        path.write_text('tampered')
        with self.assertRaises(ValueError):
            self.prepare()
        path.unlink()
        outside = self.base / 'outside'
        outside.write_text('original')
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.prepare()

    def test_common_update_preserves_local_edits_and_other_provider(self):
        codex, claude = self.prepare(), self.prepare('claude')
        path = Path(codex['marketplaceRoot']) / 'plugins/svaib/skills/example/SKILL.md'
        path.write_text('local edits')
        write_bundle(self.source, '0.10.1', 'auto', shared=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(path.read_text(), 'local edits')
        plugin = Path(claude['marketplaceRoot']) / 'plugins/svaib/.claude-plugin/plugin.json'
        self.assertEqual(json.loads(plugin.read_text())['version'], '0.10.0')

    def test_common_same_version_content_change_is_refused(self):
        result = self.prepare()
        write_bundle(self.source, '0.10.0', 'auto', content='changed', shared=True)
        with self.assertRaises(ValueError):
            self.prepare()
        path = Path(result['marketplaceRoot']) / 'plugins/svaib/skills/example/SKILL.md'
        self.assertEqual(path.read_text(), 'original')

    def test_older_bb_bundle_keeps_newer_marketplace_for_both_providers(self):
        for provider in ('codex', 'claude'):
            for newer in ('0.10.1', '0.11.0', '0.12.3', '1.0.0'):
                with self.subTest(provider=provider, version=newer):
                    data = self.base / (provider + '-' + newer)
                    data.mkdir()
                    write_bundle(self.source, newer, 'auto', content='newer', shared=True)
                    first = helper.prepare(provider, data, source_root=self.source)
                    target = Path(first['marketplaceRoot'])
                    marker = target.parent / ('.' + provider + '.owner.json')
                    before = marker.read_bytes()
                    write_bundle(self.source, '0.10.0', 'auto', shared=True)
                    result = helper.prepare(provider, data, source_root=self.source)
                    self.assertEqual(result, {**first, 'changed': False})
                    self.assertEqual(marker.read_bytes(), before)
                    self.assertEqual((target / 'plugins/svaib/skills/example/SKILL.md').read_text(), 'newer')
                    self.assertFalse(list(target.parent.glob('.previous-*')))

    def test_newer_marketplace_still_checks_local_integrity(self):
        write_bundle(self.source, '0.11.0', 'auto', shared=True)
        result = self.prepare()
        path = Path(result['marketplaceRoot']) / 'plugins/svaib/skills/example/SKILL.md'
        path.write_text('local edits')
        write_bundle(self.source, '0.10.0', 'auto', shared=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(path.read_text(), 'local edits')


if __name__ == '__main__':
    unittest.main()
