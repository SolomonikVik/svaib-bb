// Actual portable Node + pinned Pi installation, with no model/network auth.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareKimiPi, inspectKimiPi } from '../kimi-pi-host';
import { ensureKimiRuntime } from '../kimi-runtime';

const parent = await realpath(await mkdtemp(join(tmpdir(), 'Pi managed с пробелами ')));
try {
  const root = join(parent, 'profile');
  const options = { externalAgentDir: join(parent, 'unrelated'), externalEnvNames: [] };
  const registration = await prepareKimiPi(root, 'sk-kimi-ci-managed-synthetic', AbortSignal.timeout(15 * 60_000), undefined, options);
  const before = await readFile(join(registration.agentDir, 'auth.json'));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
  env.PATH = '';
  const version = execFileSync(registration.command, [...registration.args, '--version'], { env, encoding: 'utf8', timeout: 60000 }).trim();
  assert.equal(version, '1.5.2');
  assert.equal((await inspectKimiPi(root, AbortSignal.timeout(60000), options)).profile, 'ready');
  const reused = await prepareKimiPi(root, undefined, AbortSignal.timeout(60000), undefined, options);
  assert.deepEqual(reused, registration);
  assert.deepEqual(await readFile(join(registration.agentDir, 'auth.json')), before);
  if (process.platform !== 'win32') assert.equal((await stat(join(registration.agentDir, 'auth.json'))).mode & 0o777, 0o600);

  // Reproduce the original missing pi-subagents failure with the shipped
  // marketplace, actual registry package, and actual Pi extension loader.
  const runtime = await ensureKimiRuntime(root, AbortSignal.timeout(60000), { forceManaged: true });
  const python = execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const dataDir = join(parent, 'BB data');
  await mkdir(dataDir);
  const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'prepare_methods.py');
  const args = [helper, '--provider', 'pi', '--data-dir', dataDir,
    '--node', runtime.executable, '--npm-cli', runtime.npmCli];
  const helperEnv = { ...process.env, SVAIB_PYTHON: python };
  const prepare = () => JSON.parse(execFileSync(python, args, {
    env: helperEnv, encoding: 'utf8', timeout: 360000,
  }).trim().split(/\r?\n/).at(-1)!);
  const prepared = prepare();
  assert.equal((await lstat(prepared.packageRoot)).isSymbolicLink(), false);
  const repeated = prepare();
  assert.equal(repeated.packageRoot, prepared.packageRoot);
  assert.equal(repeated.runtimeChanged, false);
  const marker = join(parent, 'extension-loaded.txt');
  const wrapper = join(parent, 'check-extension.ts');
  const extension = join(prepared.packageRoot, 'plugins/svaib/pi/extension.ts').replaceAll('\\', '/');
  await writeFile(wrapper, `import { writeFileSync } from 'node:fs';\n` +
    `import svaib from ${JSON.stringify(extension)};\n` +
    `export default function(pi) { svaib(pi); writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`);
  execFileSync(registration.command, [...registration.args, '--offline', '--no-mcp', '--no-skills',
    '--no-context-files', '--no-approve', '-e', wrapper, '--help'], {
    cwd: parent, env: helperEnv, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(await readFile(marker, 'utf8'), 'loaded');
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, result: 'PASS', realPiVersion: version,
    emptyPathLauncher: true, credentialPreservedOnRepeat: true, realHarnessExtensionLoaded: true,
    runtimeCopyReused: true, externalModelCalls: 0 }));
} finally {
  await rm(parent, { recursive: true, force: true });
}
