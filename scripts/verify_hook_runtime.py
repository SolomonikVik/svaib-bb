"""Execute installed map/usage registrations in a disposable local space; no model or OAuth."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


def verify(plugin: Path, *, bash: str | None = None, powershell: bool = False, pi: bool = False) -> dict:
    plugin = plugin.resolve(strict=True)
    hooks = json.loads((plugin / 'hooks/hooks.json').read_text(encoding='utf-8'))['hooks']
    commands = [item['command'] for group in hooks['UserPromptSubmit'] for item in group['hooks'] if item.get('type') == 'command']
    map_command = next(command for command in commands if 'hooks/inject_space_map.py first-prompt' in command)
    usage_command = next(command for command in commands if 'hooks/usage_log.py prompt' in command)
    end_commands = [item['command'] for group in hooks.get('SessionEnd', []) for item in group['hooks'] if item.get('type') == 'command']
    end_command = next(command for command in end_commands if 'hooks/usage_log.py end' in command)
    if not (plugin / 'skills/onboarding/SKILL.md').is_file():
        raise ValueError('installed onboarding is missing')
    with tempfile.TemporaryDirectory(prefix='svaib hook проверка ') as directory:
        base = Path(directory)
        space = base / 'space'
        (space / '.svaib/usage').mkdir(parents=True)
        (space / 'README.md').write_text('# Runtime verification\n', encoding='utf-8')
        (space / 'AGENTS.md').write_text('# Runtime verification\n', encoding='utf-8')
        (space / '.svaib/usage/README.md').write_text('# Usage\n', encoding='utf-8')
        transcript = base / 'fixture.jsonl'
        transcript.write_text(json.dumps({'type': 'user', 'promptId': 'probe', 'timestamp': '2026-11-18T01:00:00Z',
            'message': {'content': '/svaib:onboarding'}}) + '\n' + json.dumps({'type': 'assistant', 'timestamp': '2026-11-18T01:00:01Z',
            'message': {'id': 'probe', 'model': 'fixture', 'usage': {'input_tokens': 1, 'output_tokens': 1},
                        'content': [{'type': 'text', 'text': 'fixture'}]}}) + '\n', encoding='utf-8')
        env = {key: value for key, value in os.environ.items() if not key.startswith(('CLAUDE_', 'CODEX_', 'COWORK_', 'SVAIB_MAP_'))}
        env.update({'CLAUDE_PLUGIN_ROOT': str(plugin), 'PLUGIN_ROOT': str(plugin), 'CLAUDE_PROJECT_DIR': str(space),
                    'SVAIB_STATE_DIR': str(base / 'state'), 'HOME': str(base / 'home'), 'USERPROFILE': str(base / 'home'),
                    'PYTHONUTF8': '1'})
        event = {'session_id': str(uuid.uuid4()), 'cwd': str(space), 'transcript_path': str(transcript),
                 'prompt': '/svaib:onboarding', 'prompt_id': 'probe'}
        if pi:
            for key in ('CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR'):
                env.pop(key, None)
            event['session_id'] = 'pi-' + event['session_id']
            event['native_entries'] = [
                {'id': 'probe', 'type': 'message', 'timestamp': '2026-11-18T01:00:00Z', 'message': {'role': 'user', 'content': '/svaib:onboarding'}},
                {'id': 'answer', 'parentId': 'probe', 'type': 'message', 'timestamp': '2026-11-18T01:00:01Z',
                 'message': {'role': 'assistant', 'model': 'fixture', 'content': [{'type': 'text', 'text': 'fixture'}],
                             'usage': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0}}},
            ]
        def execute(command: str) -> str:
            if pi:
                mode = 'first-prompt' if command == map_command else 'usage-prompt' if command == usage_command else 'usage-end'
                argv = [env.get('SVAIB_PYTHON') or 'python3', str(plugin / 'hooks/bridge_pi.py'), mode]
            elif powershell:
                system = Path(next((value for key, value in env.items() if key.lower() == 'systemroot'), r'C:\Windows'))
                argv = [str(system / 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', command]
            else:
                argv = [bash or '/bin/bash', '--noprofile', '--norc', '-c', command]
            result = subprocess.run(argv, cwd=space, env=env, input=json.dumps(event), text=True, encoding='utf-8',
                                    capture_output=True, timeout=25)
            if result.returncode or result.stderr.strip():
                raise ValueError('installed hook registration failed')
            return result.stdout
        output = execute(map_command)
        if 'Runtime verification' not in output or not ('Карта пространства' in output or 'Space Map' in output):
            raise ValueError('map handler did not return the test space')
        execute(usage_command)
        execute(end_command)
        tables = [path for path in (space / '.svaib/usage').glob('*.md') if path.name != 'README.md']
        if not any('onboarding' in path.read_text(encoding='utf-8') for path in tables):
            raise ValueError('usage handler did not write a test row')
        return {'map': True, 'usage': True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin-root', type=Path, required=True)
    parser.add_argument('--bash')
    parser.add_argument('--powershell', action='store_true')
    parser.add_argument('--pi', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.plugin_root, bash=args.bash, powershell=args.powershell, pi=args.pi)))
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        raise SystemExit('svaib: installed map/usage hook execution failed; check Python launcher, PATH and the installed Harness')

if __name__ == '__main__':
    main()
