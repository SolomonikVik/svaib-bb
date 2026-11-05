/** Keep BB's actual provider identity in bindings and continuations. */
export const connectionProviders = ['codex', 'claude-code', 'acp-claude-kimi'] as const;
export type ConnectionProvider = typeof connectionProviders[number];
export const supportsConnection = (id: string): id is ConnectionProvider =>
  (connectionProviders as readonly string[]).includes(id);
