export const KIMI_ERROR_CODES: readonly ['EFTYPE', 'ENOEXEC', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_ABORTED', 'NOT_FOUND', 'UNSUPPORTED', 'UNKNOWN'];
export function kimiErrorFields(error: unknown): {
  errorCode?: typeof KIMI_ERROR_CODES[number];
  errorCodeSource?: 'code' | 'detail';
  errorKind?: 'cancelled' | 'timeout' | 'oversized' | 'invalid-json';
  exitCode?: number;
  signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGABRT' | 'SIGSEGV' | 'SIGILL';
};
export function kimiVersion(value: unknown): string | undefined;
