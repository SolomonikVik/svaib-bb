"""Real isolated BB/Pi wizard: absent CLI -> official install -> key -> complete.

The Pi model provider is deterministic. This exercises native processes and BB
events, not real Kimi credentials, browser OAuth, Desktop UI, or Windows UAC.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bb-package', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    artifact = args.artifacts.resolve()
    artifact.mkdir(parents=True, exist_ok=True)
    node = Path(shutil.which('node')).resolve()
    npm = Path(shutil.which('npm')).resolve()
    npm_cli = npm if npm.name == 'npm-cli.js' else node.parent / 'node_modules/npm/bin/npm-cli.js'
    assert npm_cli.is_file(), 'Cannot resolve native npm-cli.js'
    package = args.bb_package.resolve()
    bb_app, bb_script = package / 'dist/bb-app.js', package / 'dist/bb.js'
    assert bb_app.is_file() and bb_script.is_file()
    shim, prefix, agent, workspace, isolated_home = [artifact / name for name in ('bin', 'npm-prefix', 'agent', 'workspace', 'home')]
    for directory in (shim, prefix, agent, workspace, isolated_home):
        directory.mkdir()
    (agent / 'extensions').mkdir()
    shutil.copy2(ROOT / 'tests/fixtures/pi-check-provider.ts', agent / 'extensions/check-provider.ts')
    sentinel = {'other-provider': {'type': 'api_key', 'key': 'synthetic-preserve-me'}}
    (agent / 'auth.json').write_text(json.dumps(sentinel), encoding='utf-8')
    if os.name == 'nt':
        shutil.copy2(node, shim / 'node.exe')
        (shim / 'npm.cmd').write_text(f'@"{node}" "{npm_cli}" %*\r\n', encoding='utf-8')
        (shim / 'bb.cmd').write_text(f'@"{node}" "{bb_script}" %*\r\n', encoding='utf-8')
        (shim / 'python3.cmd').write_text(f'@"{sys.executable}" %*\r\n', encoding='utf-8')
        system = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'
        paths = [prefix, shim, system, system / 'WindowsPowerShell/v1.0']
    else:
        shutil.copy2(node, shim / 'node')
        for name, command in [('npm', f'"{node}" "{npm_cli}"'), ('bb', f'"{node}" "{bb_script}"'), ('python3', f'"{sys.executable}"')]:
            script = shim / name
            script.write_text(f'#!/bin/sh\nexec {command} "$@"\n', encoding='utf-8')
            script.chmod(0o700)
        paths = [prefix / 'bin', shim, Path('/usr/bin'), Path('/bin')]
    env = {key: value for key, value in os.environ.items() if not key.startswith(('BB_', 'KIMI_', 'OPENAI_', 'ANTHROPIC_', 'PI_', 'CLAUDE_', 'CODEX_'))}
    for name in list(env):
        if name.lower() == 'path':
            del env[name]
    server_port, daemon_port = port(), port()
    # Only child test processes receive these homes; the operator's profile is untouched.
    env.update({'HOME': str(isolated_home), 'USERPROFILE': str(isolated_home)})
    for name in ('APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'):
        directory = isolated_home / name.lower()
        directory.mkdir()
        env[name] = str(directory)
    node = shim / ('node.exe' if os.name == 'nt' else 'node')
    env.update({'PATH': os.pathsep.join(map(str, paths)), 'BB_DATA_DIR': str(artifact / 'bb-data'),
                'BB_SERVER_URL': f'http://127.0.0.1:{server_port}', 'PI_CODING_AGENT_DIR': str(agent),
                'SVAIB_PYTHON': sys.executable, 'SVAIB_PI_CHECK_LOG': str(artifact / 'model-requests.jsonl'),
                'NPM_CONFIG_PREFIX': str(prefix), 'NPM_CONFIG_CACHE': str(artifact / 'npm-cache'),
                'PYTHONUTF8': '1', 'PI_TELEMETRY': '0'})

    def cli(*argv, timeout=45):
        result = subprocess.run([str(node), str(bb_script), *argv], env=env, cwd=workspace,
                                capture_output=True, text=True, encoding='utf-8', timeout=timeout)
        assert result.returncode == 0, (argv[:3], result.stderr[-2000:], result.stdout[-1000:])
        return json.loads(result.stdout)

    def rpc(method, value=None):
        argv = ['plugin', 'rpc', 'call', 'svaib-workplace', method, '--json']
        if value is not None:
            path = artifact / 'rpc-input.json'
            path.write_text(json.dumps(value), encoding='utf-8')
            argv += ['--input-file', str(path)]
        return cli(*argv)

    def until(predicate, seconds=180):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = rpc('kimiStatus')
            if predicate(state):
                return state
            if state.get('phase') is None and state.get('message') and state.get('stage') in ('blocked', 'verify', 'registration'):
                raise AssertionError(state)
            time.sleep(1)
        raise AssertionError({'timeout': state})

    output = (artifact / 'bb-server.log').open('w', encoding='utf-8')

    def start_server():
        return subprocess.Popen([str(node), str(bb_app), '--bundled', '--no-in-app-updates',
                                '--data-dir', env['BB_DATA_DIR'], '--server-port', str(server_port),
                                '--host-daemon-port', str(daemon_port)], cwd=workspace, env=env,
                               stdout=output, stderr=subprocess.STDOUT)

    def stop_server():
        try:
            subprocess.run([str(node), str(bb_app), 'stop'], env=env, cwd=workspace,
                           capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)

    def connected():
        deadline = time.monotonic() + 90
        while True:
            try:
                machines = cli('machine', 'list', '--json', timeout=8)
                if any(item.get('status') == 'connected' for item in machines):
                    return next(item for item in machines if item.get('status') == 'connected')
            except (AssertionError, subprocess.TimeoutExpired):
                pass
            assert process.poll() is None and time.monotonic() < deadline, 'Isolated BB did not start'
            time.sleep(1)

    def completed_seq(thread_id):
        events = cli('thread', 'log', thread_id, '--json', '--limit', '200')
        return max((item['seq'] for item in events if item['type'] == 'turn/completed'), default=0)

    def answer(thread_id, expected, after=0):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            state = cli('thread', 'show', thread_id, '--json')['thread']['status']
            if state == 'idle' and completed_seq(thread_id) > after:
                actual = cli('thread', 'output', thread_id, '--json')['output'].strip()
                assert actual == expected, (expected, actual)
                return
            assert state != 'error', cli('thread', 'log', thread_id, '--json', '--limit', '200')
            time.sleep(1)
        raise AssertionError('Context probe did not finish')

    def recall(thread_id, expected='MEMORY_OK'):
        previous = completed_seq(thread_id)
        text = artifact / 'recall.txt'
        text.write_text('RECALL_CONTEXT_NONCE', encoding='utf-8')
        cli('thread', 'tell', thread_id, '--message-file', str(text), '--json')
        answer(thread_id, expected, previous)

    process = start_server()
    report = {'platform': sys.platform, 'bbVersion': json.loads((package / 'package.json').read_text())['version'],
              'deterministicModel': True, 'productionKeys': False, 'oauth': False, 'desktop': False, 'uac': False}
    try:
        machine = connected()
        cli('plugin', 'install', str(ROOT), '--yes', '--json', timeout=180)
        assert rpc('kimiSelectHarness', {'harness': 'pi'})['stage'] == 'registration', 'The initial Pi CLI must be absent'
        before = rpc('kimiPiRuntime')
        assert before['installed'] is False
        rpc('kimiStart', {})
        until(lambda state: state['stage'] == 'key', seconds=300)
        installed = rpc('kimiPiRuntime')
        assert installed['installed'] is True and installed['hasCredential'] is False
        rpc('kimiStart', {'apiKey': 'sk-kimi-ci-synthetic'})
        final = until(lambda state: state['stage'] == 'complete')
        assert final['phase'] is None and final['stopUnconfirmed'] is False
        auth = json.loads((agent / 'auth.json').read_text(encoding='utf-8'))
        assert auth['other-provider'] == sentinel['other-provider']
        assert auth['kimi-coding']['key'] == 'sk-kimi-ci-synthetic'
        requests = [json.loads(line) for line in (artifact / 'model-requests.jsonl').read_text().splitlines()]
        assert requests and all(item['provider'] == 'kimi-coding' and item['model'] == 'k3.1-pro' for item in requests)
        project = cli('project', 'create', '--name', 'Pi context regression', '--root', str(workspace), '--machine', machine['id'], '--json')
        thread = cli('thread', 'spawn', '--project', project['id'], '--provider', 'pi', '--model', 'kimi-coding/k3.1-pro',
                     '--permission-mode', 'full', '--title', 'Pi context fixture', '--prompt', 'STORE_CONTEXT_NONCE:synthetic-alpha', '--json')
        answer(thread['id'], 'MEMORY_STORED')
        recall(thread['id'])
        cli('plugin', 'reload', 'svaib-workplace', '--json')
        recall(thread['id'])
        saved_profile = {name: (agent / name).read_bytes() for name in ('auth.json', 'models.json')}
        stop_server()
        shutil.rmtree(agent)
        (agent / 'extensions').mkdir(parents=True)
        shutil.copy2(ROOT / 'tests/fixtures/pi-check-provider.ts', agent / 'extensions/check-provider.ts')
        for name, data in saved_profile.items():
            (agent / name).write_bytes(data)
        process = start_server()
        connected()
        recall(thread['id'])
        # Explicit history deletion is a separate, destructive negative case.
        stop_server()
        shutil.rmtree(isolated_home / '.bb/pi-bridge-sessions')
        process = start_server()
        connected()
        recall(thread['id'], 'MEMORY_MISSING')
        report.update({'result': 'PASS', 'initiallyAbsent': True, 'officialInstaller': True,
                       'existingCredentialPreserved': True, 'modelRequests': len(requests),
                       'finalStage': final['stage'], 'selectedModel': final['verifyModel'],
                       'contextNextTurn': True, 'contextAfterPluginReload': True, 'contextAfterProfileRecreationAndBbRestart': True,
                       'knownLimitation': 'Deleting native Pi journals starts empty history; BB does not replay its transcript'})
    except Exception as error:
        report.update({'result': 'FAIL', 'error': str(error)[-4000:]})
        diagnostics = {}
        try:
            diagnostics['providerCliStatus'] = cli('machine', 'provider-cli', 'status', machine['id'], '--json')
            diagnostics['nativeRuntimeRechecks'] = []
            for _ in range(3):
                diagnostics['nativeRuntimeRechecks'].append(rpc('kimiPiRuntime'))
                time.sleep(2)
            diagnostics['pluginLog'] = subprocess.run([str(node), str(bb_script), 'plugin', 'logs', 'svaib-workplace', '--lines', '60'],
                env=env, cwd=workspace, capture_output=True, text=True, encoding='utf-8', timeout=20).stdout[-16000:]
            if not diagnostics['providerCliStatus'].get('pi', {}).get('installed'):
                retry = subprocess.run([str(node), str(bb_script), 'machine', 'provider-cli', 'install', machine['id'], 'pi', '--json'],
                    env=env, cwd=workspace, capture_output=True, text=True, encoding='utf-8', timeout=120)
                diagnostics['officialInstallerRetry'] = {'exitCode': retry.returncode, 'stdout': retry.stdout[-16000:], 'stderr': retry.stderr[-4000:]}
            direct = prefix / ('node_modules' if os.name == 'nt' else 'lib/node_modules') / '@earendil-works/pi-coding-agent/dist/bundle/cli.js'
            diagnostics['nativeCliFileExists'] = direct.is_file()
            if direct.is_file():
                probe = subprocess.run([str(node), str(direct), '--version'], env=env, cwd=workspace,
                    capture_output=True, text=True, encoding='utf-8', timeout=30)
                diagnostics['directNodeProbe'] = {'exitCode': probe.returncode, 'stdout': probe.stdout[-2000:], 'stderr': probe.stderr[-4000:]}
            if os.name == 'nt':
                diagnostics['windowsDiscovery'] = {
                    'PATHEXT': env.get('PATHEXT'), 'PATH': env['PATH'],
                    'launchers': {name: (prefix / name).is_file() for name in ('pi', 'pi.cmd', 'pi.ps1')},
                }
                commands = {'wherePi': [str(system / 'where.exe'), 'pi']}
                if (prefix / 'pi.cmd').is_file():
                    cmd = env.get('COMSPEC', str(system / 'cmd.exe'))
                    # cmd.exe requires its own quote rules, not list2cmdline's
                    # backslash escapes inside the /c payload.
                    commands['absoluteCmdProbe'] = subprocess.list2cmdline([cmd]) + f' /d /s /c ""{prefix / "pi.cmd"}" --version"'
                    diagnostics['windowsDiscovery']['cmdLauncher'] = (prefix / 'pi.cmd').read_text(encoding='utf-8')[:4000]
                for name, command in commands.items():
                    probe = subprocess.run(command, env=env, cwd=workspace, capture_output=True,
                        text=True, encoding='utf-8', errors='replace', timeout=30)
                    diagnostics['windowsDiscovery'][name] = {'exitCode': probe.returncode,
                        'stdout': probe.stdout[-4000:], 'stderr': probe.stderr[-4000:]}
        except Exception as diagnostic_error:
            diagnostics['collectionError'] = str(diagnostic_error)[-2000:]
        (artifact / 'diagnostics.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding='utf-8')
        raise
    finally:
        (artifact / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=True), flush=True)
        stop_server()
        output.close()


if __name__ == '__main__':
    main()
