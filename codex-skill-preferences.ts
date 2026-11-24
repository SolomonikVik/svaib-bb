import { join, relative, sep, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { withCodexHooks } from './account/hook-native';
import { SVAIB_PLUGIN_ID } from './account/hook-bundle';

type Rule = { enabled: boolean; path?: string; name?: string };
type Skill = { name: string; path: string; enabled: boolean; pluginId?: string };
type Rpc = (method: string, params: Record<string, unknown>) => Promise<any>;

// Path rules refer to Codex's installed copy, whereas a namespaced rule follows the skill on update.
function cachePath(cache: string, path: unknown) {
  if (typeof path !== 'string' || !isAbsolute(path)) return;
  const name = relative(cache, path);
  const [version, kind, ...parts] = name.split(sep);
  if (!version || version === '..' || isAbsolute(name) || kind !== 'skills' || parts.length < 2 || parts.at(-1) !== 'SKILL.md') return;
  return { version, skillPath: parts.join(sep) };
}

export async function keepCodexSkillChoices(rpc: Rpc, configRoot: string, cwd: string, installedVersion: string | undefined) {
  const cache = join(configRoot, 'plugins', 'cache', 'svaib', 'svaib');
  const config = await rpc('config/read', { cwd, includeLayers: true });
  const effective: Rule[] = config.config?.skills?.config ?? [];
  const layers = config.layers?.filter((layer: any) => layer.name?.type === 'user') ?? [];
  const user = layers[0];
  const rules: Rule[] = user?.config?.skills?.config ?? [];
  const paths = new Set([...effective, ...rules].filter(rule => rule.enabled === false && cachePath(cache, rule.path)).map(rule => rule.path!));
  if (!paths.size) return true;
  if (layers.length !== 1 || typeof user.version !== 'string' || !installedVersion) return false;

  const response = await rpc('skills/list', { cwds: [cwd], forceReload: true });
  const rows = response.data?.filter((row: any) => row.cwd === cwd);
  if (rows?.length !== 1 || !Array.isArray(rows[0].skills)) return false;
  const skills: Skill[] = rows[0].skills;
  const names = new Map<string, string>();
  for (const path of paths) {
    const former = cachePath(cache, path)!;
    const matches = skills.filter(skill => {
      const current = cachePath(cache, skill.path);
      return skill.pluginId === SVAIB_PLUGIN_ID && current?.version === installedVersion && current.skillPath === former.skillPath;
    });
    if (matches.length !== 1) return false;
    const skill = matches[0];
    if (!skill.name.startsWith('svaib:') || skills.filter(row => row.name === skill.name).length !== 1) return false;
    const named = (items: Rule[]) => items.filter(rule => rule.name === skill.name);
    const stable = named(rules), active = named(effective);
    if (stable.length === 1 && active.length === 1 && stable[0].enabled === skill.enabled && active[0].enabled === skill.enabled &&
      (skill.enabled === false || former.version !== installedVersion)) continue;
    if (skill.enabled !== false) return false;
    // A stale path or a project-only rule is not permission to change the user's global choice.
    if (former.version !== installedVersion || stable.length || active.length) return false;
    for (const list of [rules, effective]) {
      const exact = list.filter(rule => rule.path === path);
      if (exact.length !== 1 || exact[0].enabled !== false || exact[0].name !== undefined) return false;
    }
    if ([...names.values()].includes(skill.name)) return false;
    names.set(path, skill.name);
  }
  if (!names.size) return true;
  const saved = rules.map(rule => {
    const name = rule.path && names.get(rule.path);
    if (!name) return rule;
    const { path, ...rest } = rule;
    return { ...rest, name };
  });
  try {
    await rpc('config/batchWrite', { edits: [{ keyPath: 'skills.config', value: saved, mergeStrategy: 'replace' }],
      expectedVersion: user.version, reloadUserConfig: true });
  } catch { return false; } // A concurrent edit or an older API leaves the update pending.

  const after = await rpc('config/read', { cwd, includeLayers: true });
  const written: Rule[] = after.layers?.find((layer: any) => layer.name?.type === 'user')?.config?.skills?.config ?? [];
  return [...names.values()].every(name => written.some(rule => rule.name === name && rule.enabled === false));
}

export async function preserveCodexSkillChoices(executable: string, cwd: string, configRoot: string, version: string | undefined, signal: AbortSignal) {
  const root = await realpath(configRoot);
  return withCodexHooks({ executable, cwd }, signal, rpc => keepCodexSkillChoices(rpc, root, cwd, version), configRoot);
}
