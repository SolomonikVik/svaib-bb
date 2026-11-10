import { z } from 'zod';

// No free text: even a provider error containing credentials cannot enter the log.
export const kimiDiagnosticSchema = z.object({
  diagnosticId: z.uuid(), source: z.enum(['backend', 'host']),
  step: z.enum(['prepare', 'key-replace', 'key-commit', 'runtime', 'adapter-install', 'profile-inspect',
    'profile-validate', 'profile-write', 'catalog-fetch', 'catalog-normalize', 'bb-discovery',
    'registration', 'verification', 'refresh', 'migration', 'state', 'cleanup']),
  outcome: z.enum(['start', 'success', 'failure', 'fallback', 'skipped']),
  reason: z.enum(['setup', 'recheck', 'key-change', 'scheduled', 'startup', 'migration',
    'cancelled', 'timeout', 'failed', 'http-error', 'network-error', 'invalid-json', 'oversized',
    'invalid-catalog', 'cached', 'conservative', 'unavailable', 'foreign-profile', 'wrong-response']).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  byteCount: z.number().int().nonnegative().max(262144).optional(),
  modelCount: z.number().int().nonnegative().max(129).optional(),
  longModelCount: z.number().int().nonnegative().max(129).optional(),
  profile: z.enum(['absent', 'partial', 'ready', 'blocked']).optional(),
  stage: z.enum(['intro', 'node', 'key', 'installing', 'registration', 'verify', 'complete', 'blocked']).optional(),
  phase: z.enum(['components', 'access', 'check']).nullable().optional(),
}).strict();
export type KimiDiagnostic = z.infer<typeof kimiDiagnosticSchema>;
export type KimiDiagnosticLog = (step: string, outcome: string, fields?: Record<string, unknown>) => void;
export const kimiDiagnosticSignals = { kimiDiagnostic: { payload: kimiDiagnosticSchema } };

export function kimiDiagnostics(diagnosticId: string, source: KimiDiagnostic['source'], sink: (event: KimiDiagnostic) => unknown): KimiDiagnosticLog {
  return (step, outcome, fields = {}) => {
    const parsed = kimiDiagnosticSchema.safeParse({ diagnosticId, source, step, outcome, ...fields });
    if (!parsed.success) return;
    try { void Promise.resolve(sink(parsed.data)).catch(() => {}); }
    catch { /* Diagnostics must never fail the user's setup. */ }
  };
}

export async function kimiStep<T>(log: KimiDiagnosticLog, step: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now(); log(step, 'start');
  try { const result = await work(); log(step, 'success', { elapsedMs: Date.now() - started }); return result; }
  catch (error) {
    log(step, 'failure', { elapsedMs: Date.now() - started, reason: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed' });
    throw error;
  }
}
