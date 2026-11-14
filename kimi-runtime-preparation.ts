import { existingKimiRuntime, ensureKimiRuntime, type KimiRuntime } from './kimi-runtime';
import { prepareRuntime, type RuntimePreparationOptions } from './runtime-preparation';

/** Keep global Windows installers under the same host lock as Settings/CLI repair.
 * An existing working launch runtime needs no global npm or installation. */
export async function prepareKimiRuntime(preparationRoot: string, profileRoot: string, signal: AbortSignal,
  options: { platform?: string; inspect?: typeof existingKimiRuntime; repair?: typeof prepareRuntime; progress?: RuntimePreparationOptions['progress'] } = {}): Promise<KimiRuntime> {
  const current = await (options.inspect ?? existingKimiRuntime)(signal);
  if (current) return current;
  if ((options.platform ?? process.platform) !== 'win32') return ensureKimiRuntime(profileRoot, signal, { forceManaged: true });
  const result = await (options.repair ?? prepareRuntime)(preparationRoot, signal, {
    context: { provider: 'acp-claude-kimi', action: 'install', hooks: true }, ...(options.progress ? { progress: options.progress } : {}),
  });
  if (result.status !== 'ready' || !result.node || !result.npmCli || !result.versions?.node) throw new Error(result.message);
  return { executable: result.node, npmCli: result.npmCli, version: result.versions.node };
}
