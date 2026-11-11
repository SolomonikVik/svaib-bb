import { spawn } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import { experimental_killPortableProcess } from '@get-bb/plugin-sdk/provider-bridge';
import { kimiErrorFields, kimiVersion, type KimiDiagnosticLog } from './kimi-diagnostics';

/** Small header reads only; never log a filename or read the whole native binary. */
export function kimiBinaryHeader(bytes: Buffer): { binaryFormat: 'pe' | 'elf' | 'macho' | 'script' | 'unknown'; binaryArch?: 'x64' | 'arm64' | 'ia32' | 'unknown' } {
  const arch = (machine: number) => machine === 0x8664 || machine === 62 ? 'x64' as const
    : machine === 0xaa64 || machine === 183 ? 'arm64' as const : machine === 0x14c || machine === 3 ? 'ia32' as const : 'unknown' as const;
  if (bytes.length >= 64 && bytes.subarray(0, 2).toString() === 'MZ') {
    const offset = bytes.readUInt32LE(60);
    if (offset <= bytes.length - 6 && bytes.subarray(offset, offset + 4).equals(Buffer.from('PE\0\0'))) return { binaryFormat: 'pe', binaryArch: arch(bytes.readUInt16LE(offset + 4)) };
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) return { binaryFormat: 'elf', binaryArch: arch(bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)) };
  if (bytes.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(bytes.readUInt32BE(0))) return { binaryFormat: 'macho' };
  return { binaryFormat: bytes.subarray(0, 2).toString() === '#!' ? 'script' : 'unknown' };
}

/** Bounded, private probe output. Stop the whole owned process group on overflow/abort/timeout. */
export async function kimiProbe(executable: string, args: string[], signal: AbortSignal, maxBytes = 4096, timeoutMs = 3000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(?:NODE_OPTIONS|ANTHROPIC_.*|CLAUDE_.*)$/i.test(name)) delete env[name];
    const child = spawn(executable, args, { env, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let chunks: Buffer[] = []; let bytes = 0; let failure: unknown; let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(cleanupTimer); signal.removeEventListener('abort', onAbort);
      child.stdout.off('data', collect);
      if (error) { chunks = []; reject(error); } else { resolve(Buffer.concat(chunks).toString('utf8')); chunks = []; }
    };
    const stop = (error: unknown) => {
      if (failure || settled) return;
      failure = error; chunks = [];
      child.stdout.off('data', collect); child.stdout.resume();
      try {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else experimental_killPortableProcess(child, 'SIGKILL');
      } catch { /* The close event or bounded final cleanup still settles the probe. */ }
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy(); child.unref(); finish(error);
      }, 1000);
    };
    const onAbort = () => stop(new DOMException('Probe cancelled', 'AbortError'));
    const collect = (chunk: Buffer) => {
      if (failure || settled) return;
      if (chunk.length > maxBytes - bytes) { stop(Object.assign(new Error('Probe output too large'), { name: 'OutputLimitError' })); return; }
      bytes += chunk.length; chunks.push(chunk);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('Probe timeout'), { name: 'TimeoutError' })), timeoutMs);
    child.stdout.on('data', collect);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once('error', error => { if (child.pid) stop(error); else finish(error); });
    child.once('close', (exitCode, signal) => {
      finish(failure ?? (exitCode === 0 ? undefined : Object.assign(new Error('Probe failed'), { exitCode, signal })));
    });
  });
}

// Run inside the registered Node. Use the adapter's own resolver, including its
// architecture/libc selection and SDK dependency context. Paths stay in this
// bounded internal response; none are forwarded to the diagnostic sink.
export const KIMI_RUNTIME_INFO = String.raw`
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const adapterDir = join(root, 'runtime', 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
const adapterFile = join(adapterDir, 'dist', 'acp-agent.js');
const req = createRequire(adapterFile);
const info = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch };
function metadata(path) {
  if (statSync(path).size > 65536) throw new Error('Metadata too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}
try { info.adapterVersion = metadata(join(adapterDir, 'package.json')).version; } catch {}
for (const base of req.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? []) {
  try {
    const data = metadata(join(base, '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
    if (data.name === '@anthropic-ai/claude-agent-sdk') { info.sdkVersion = data.version; break; }
  } catch {}
}
try {
  const { claudeCliPath } = await import(pathToFileURL(adapterFile));
  info.nativePath = await claudeCliPath();
} catch (error) { info.nativeError = { code: error?.code, name: error?.name }; }
console.log(JSON.stringify(info));
`;

/** Required installation gate. Each probe has its own deadline and closed diagnostic fields. */
export async function verifyKimiRuntime(root: string, nodeExecutable: string, signal: AbortSignal, log: KimiDiagnosticLog) {
  async function binary(component: 'node' | 'claude-code', executable: string) {
    try {
      const file = await open(executable, 'r');
      try {
        const bytes = Buffer.alloc(4096);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        log('binary', 'success', { component, ...kimiBinaryHeader(bytes.subarray(0, bytesRead)), fileBytes: (await file.stat()).size });
      } finally { await file.close(); }
    } catch (error) { log('binary', 'failure', { component, reason: 'failed', ...kimiErrorFields(error) }); throw error; }
  }
  async function probe(component: 'node' | 'adapter' | 'claude-code', executable: string, args: string[], maxBytes = 4096) {
    const started = Date.now(); log('runtime-probe', 'start', { component });
    try {
      const output = await kimiProbe(executable, args, signal, maxBytes, 30_000);
      log('runtime-probe', 'success', { component, elapsedMs: Date.now() - started });
      return output;
    } catch (error) { log('runtime-probe', 'failure', { component, elapsedMs: Date.now() - started, reason: 'failed', ...kimiErrorFields(error) }); throw error; }
  }
  const hostVersion = kimiVersion(process.version);
  const osRelease = release().match(/^\d{1,5}(?:\.\d{1,5}){1,3}$/u)?.[0];
  log('environment', 'success', { component: 'host-worker', ...(hostVersion ? { version: hostVersion } : {}), ...(osRelease ? { osRelease } : {}),
    platform: ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'other',
    arch: ['x64', 'arm64', 'ia32'].includes(process.arch) ? process.arch : 'other' });
  await binary('node', nodeExecutable);
  const nodeVersion = kimiVersion((await probe('node', nodeExecutable, ['--version'])).trim());
  if (!nodeVersion) throw new Error('Не удалось проверить версию Node.js.');
  log('environment', 'success', { component: 'node', version: nodeVersion });
  const info = JSON.parse(await probe('adapter', nodeExecutable, ['--input-type=module', '-e', KIMI_RUNTIME_INFO, root], 16384));
  log('environment', 'success', { component: 'node', version: nodeVersion, arch: ['x64', 'arm64', 'ia32'].includes(info.arch) ? info.arch : 'other' });
  for (const [value, component] of [[info.adapterVersion, 'adapter'], [info.sdkVersion, 'claude-sdk']] as const) {
    const version = kimiVersion(value);
    if (!version) throw new Error('Не удалось проверить компоненты Kimi. Повтори установку.');
    log('environment', 'success', { component, version });
  }
  if (typeof info.nativePath !== 'string' || info.nativePath.length > 8192 || !isAbsolute(info.nativePath)) {
    log('environment', 'failure', { component: 'claude-code', reason: 'unavailable', ...kimiErrorFields(info.nativeError) });
    throw new Error('Не найден исполняемый файл Claude Code. Повтори установку.');
  }
  await binary('claude-code', info.nativePath);
  const claudeVersion = kimiVersion((await probe('claude-code', info.nativePath, ['--version'])).trim());
  if (!claudeVersion) throw new Error('Не удалось проверить запуск Claude Code. Повтори установку.');
  log('environment', 'success', { component: 'claude-code', version: claudeVersion });
}

export async function logKimiRuntime(root: string, signal: AbortSignal, log: KimiDiagnosticLog) {
  try {
    if ((await stat(join(root, 'setup-owner.json'))).size > 65536) throw new Error('Metadata too large');
    const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    const { validateProvision } = await import('./scripts/setup-kimi-cc.mjs');
    await validateProvision(root);
    await verifyKimiRuntime(root, owner.nodeExecutable, signal, log);
  } catch (error) { log('environment', 'skipped', { reason: 'unavailable', ...kimiErrorFields(error) }); }
}
