// Actual portable Node + pinned Pi installation, with no model/network auth.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareKimiPi, inspectKimiPi } from '../kimi-pi-host';

const parent = await mkdtemp(join(tmpdir(), 'Pi managed с пробелами '));
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
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, result: 'PASS', realPiVersion: version,
    emptyPathLauncher: true, credentialPreservedOnRepeat: true, externalModelCalls: 0 }));
} finally {
  await rm(parent, { recursive: true, force: true });
}
