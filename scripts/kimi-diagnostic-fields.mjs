// Only closed codes leave an exception. Never return message, stack, argv or paths.
export const KIMI_ERROR_CODES = ['EFTYPE', 'ENOEXEC', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_ABORTED', 'NOT_FOUND', 'UNSUPPORTED', 'UNKNOWN'];
export function kimiErrorFields(error) {
  const fields = {};
  const seen = new Set();
  for (let value = error, depth = 0; value && typeof value === 'object' && depth < 4 && !seen.has(value); value = value.cause, depth++) {
    seen.add(value);
    if (!fields.errorCode && KIMI_ERROR_CODES.includes(value.code)) {
      fields.errorCode = value.code; fields.errorCodeSource = 'code';
    }
    if (!fields.errorCode) {
      // Provider RPC errors often retain only "Internal error: spawn EFTYPE".
      for (const text of [value.message, value.detail]) {
        if (typeof text !== 'string') continue;
        const match = text.slice(0, 4096).match(/\bspawn(?:\s+[^\r\n]{0,256}?)?\s+(E[A-Z0-9_]+)(?=$|[\s,:'")])/);
        if (match && KIMI_ERROR_CODES.includes(match[1])) {
          fields.errorCode = match[1]; fields.errorCodeSource = 'detail'; break;
        }
      }
    }
    if (value.name === 'AbortError') fields.errorKind = 'cancelled';
    else if (value.name === 'TimeoutError') fields.errorKind = 'timeout';
    else if (value.name === 'OutputLimitError') fields.errorKind = 'oversized';
    else if (value.name === 'SyntaxError' && !fields.errorKind) fields.errorKind = 'invalid-json';
    if (Number.isInteger(value.exitCode) && Math.abs(value.exitCode) <= 2147483648) fields.exitCode = value.exitCode;
    if (['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL'].includes(value.signal)) fields.signal = value.signal;
  }
  return fields;
}

// Versions are numeric facts, not an arbitrary string from package metadata.
export function kimiVersion(value) {
  return typeof value === 'string' ? value.match(/^v?(\d{1,5}\.\d{1,5}\.\d{1,5})(?:$|[-+\s])/u)?.[1] : undefined;
}
