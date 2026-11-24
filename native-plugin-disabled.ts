import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SVAIB_PLUGIN_ID } from './account/hook-bundle';
import { withCodexHooks } from './account/hook-native';
import type { HarnessTarget } from './harness-maintenance';
import { nativeCommand } from './native-command';

type Scope = 'user' | 'project' | 'local';
type Preference = { disabled: boolean; scope: Scope };
type ClaudeSettings = { enabledPlugins?: Record<string, boolean> };
type ClaudeSource = { source: string; settings: ClaudeSettings };
const scopes = [['local', 'localSettings'], ['project', 'projectSettings'], ['user', 'userSettings']] as const;

function claudePreference(effective: ClaudeSettings, sources: ClaudeSource[]): Preference {
  const flags = new Map(sources.map(entry => [entry.source, entry.settings.enabledPlugins?.[SVAIB_PLUGIN_ID]]));
  const enabled = effective.enabledPlugins?.[SVAIB_PLUGIN_ID];
  const activeScope = enabled === undefined ? undefined : scopes.find(([, name]) => flags.get(name) === enabled)?.[0];
  // A new user-scope install would overwrite a global opt-out even if the
  // project (or managed policy) explicitly enables this plugin here.
  return { disabled: enabled === false, scope: activeScope ?? (flags.get('userSettings') === false ? 'local' : 'user') };
}

async function claudeFiles(configRoot: string, cwd: string) {
  // Older Claude versions lack the settings control request. Limit the
  // fallback to the settings the installer can write in this project/profile.
  const sources: ClaudeSource[] = [];
  for (const [source, path] of [['userSettings', join(configRoot, 'settings.json')],
    ['projectSettings', join(cwd, '.claude', 'settings.json')], ['localSettings', join(cwd, '.claude', 'settings.local.json')]]) {
    try { sources.push({ source, settings: JSON.parse(await readFile(path, 'utf8')) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось проверить настройку включения svaib в профиле Claude Code.'); }
  }
  const effective = Object.assign({}, ...sources.map(s => s.settings.enabledPlugins));
  return claudePreference({ enabledPlugins: effective }, sources);
}

export async function harnessInstallPreference(provider: 'codex' | 'claude', configRoot: string, cwd: string,
  target: HarnessTarget, signal: AbortSignal): Promise<Preference> {
  signal.throwIfAborted();
  if (provider === 'codex') {
    return withCodexHooks({ executable: target.executable, cwd }, signal, async rpc => {
      const record = await rpc('config/read', { cwd, includeLayers: true });
      if (!record?.config || !Array.isArray(record.layers)) throw new Error('Не удалось проверить настройку включения svaib в Codex.');
      // The CLI only installs at user scope, including when a project is selected.
      const user = record.layers.find((layer: { name?: { type?: string } }) => layer.name?.type === 'user');
      return { scope: 'user', disabled: record.config.plugins?.[SVAIB_PLUGIN_ID]?.enabled === false ||
        user?.config?.plugins?.[SVAIB_PLUGIN_ID]?.enabled === false };
    }, configRoot);
  }

  const env = { ...process.env, CLAUDE_CONFIG_DIR: configRoot };
  const args = [...(target.args ?? []), ...(target.provider === 'acp-claude-kimi' ? ['--claude'] : []), '--bare', '-p', '--verbose',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--strict-mcp-config'];
  const command = nativeCommand(target.executable, args, process.platform, env);
  // Read the selected CLI's effective settings without a model turn, history,
  // hooks or MCP servers. Keep only the one plugin's switch.
  const response = await new Promise<Preference | undefined>(resolve => {
    const child = execFile(command.executable, command.args, { cwd, env, signal, windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments, timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (!error) for (const line of stdout.split(/\r?\n/)) {
        try {
          const reply = JSON.parse(line);
          if (reply.type !== 'control_response' || reply.response?.request_id !== 'svaib-install') continue;
          const data = reply.response.response;
          if (data?.effective && Array.isArray(data.sources)) { resolve(claudePreference(data.effective, data.sources)); return; }
        } catch { /* An older CLI may also emit ordinary diagnostics. */ }
      }
      resolve(undefined);
    });
    child.stdin?.on('error', () => {}); // Older CLIs may exit before reading stdin.
    child.stdin?.end(JSON.stringify({ type: 'control_request', request_id: 'svaib-install', request: { subtype: 'get_settings' } }) + '\n');
  });
  signal.throwIfAborted();
  return response ?? claudeFiles(configRoot, cwd);
}
