import type { BbPluginApi } from '@get-bb/plugin-sdk';

// Upgrade compatibility: BB workplace 0.12.x–0.14.x. Remove in 0.15.0 once
// an upgrade from 0.11.0 with interrupted OAuth/queued delivery has passed acceptance.
const keys = new Set(['connection-flow-v1', 'connection-flow-proof-v1', 'native-account-observation-v1', 'connection-native-login-v1']);
const prefixes = ['native-auth-attempt:', 'native-auth-runtime:', 'native-login:'];
export async function migrateSimplifiedWorkplace(bb: Pick<BbPluginApi, 'pluginId' | 'storage' | 'sdk'>) {
  for (const key of await bb.storage.kv.list()) {
    if (!keys.has(key) && !prefixes.some(prefix => key.startsWith(prefix))) continue;
    const record = await bb.storage.kv.get<any>(key);
    if ((key === 'connection-native-login-v1' || key.startsWith('native-auth-runtime:')) &&
      typeof record?.runId === 'string' && typeof record.threadId === 'string' && typeof record.terminalId === 'string' && record.binding) {
      let terminal;
      try { terminal = await bb.sdk.terminals.get({ terminalId: record.terminalId }); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      if (terminal && terminal.status !== 'exited') {
        if (terminal.threadId !== record.threadId || terminal.environmentId !== record.binding.environmentId ||
          terminal.hostId !== record.binding.hostId || typeof record.input?.configRoot !== 'string') continue;
        // The old owned helper's cancel protocol releases its lock without revoking a completed login.
        // Never read terminal output or kill an arbitrary user's native login process.
        await bb.sdk.terminals.input({ terminalId: terminal.id, dataBase64: Buffer.from('cancel\n').toString('base64') });
        if ((await bb.sdk.terminals.get({ terminalId: terminal.id })).status !== 'exited') continue;
      }
    }
    if (key.startsWith('native-auth-attempt:') && record?.threadId && key === 'native-auth-attempt:' + record.threadId && record.delivery) {
      const { queuedId, text } = record.delivery;
      if (typeof text === 'string') {
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId: record.threadId });
        for (const row of rows) if (row.originPluginId === bb.pluginId && (!queuedId || row.id === queuedId) &&
          row.content.length === 1 && row.content[0].type === 'text' && row.content[0].text === text)
          await bb.sdk.threads.queuedMessages.delete({ threadId: record.threadId, queuedMessageId: row.id });
      }
    }
    // No OAuth revoke, token removal, history deletion or user-terminal termination.
    // Old timers are process-local and disappear when the old plugin generation disposes.
    await bb.storage.kv.delete(key);
  }
}
