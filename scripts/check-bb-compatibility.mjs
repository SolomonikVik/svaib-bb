// Release preflight: select official BB targets, then check declared engine ranges.
// This checks install eligibility, not runtime/API compatibility.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadSemver(npmPackage) {
  return createRequire(resolve(npmPackage))('semver');
}

export function validatePolicy(policy, semver) {
  if (policy.schemaVersion !== 1 || policy.minorLines !== 3
      || !semver.valid(policy.baseline) || semver.prerelease(policy.baseline)
      || !semver.valid(policy.appliesFromPlugin) || semver.prerelease(policy.appliesFromPlugin)) {
    throw new Error('Invalid BB compatibility policy');
  }
}

export function selectTargets(releases, policy, semver) {
  validatePolicy(policy, semver);
  const lines = new Map();
  for (const release of releases) {
    const match = /^desktop-v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
    if (!match || release.draft || release.prerelease || !release.published_at) continue;
    const bb = match[1];
    if (!semver.valid(bb) || semver.lt(bb, policy.baseline)) continue;
    const line = `${semver.major(bb)}.${semver.minor(bb)}`;
    if (!lines.has(line) || semver.gt(bb, lines.get(line).bb)) {
      lines.set(line, { bb, tag: release.tag_name, publishedAt: release.published_at });
    }
  }
  const targets = [...lines.values()].sort((a, b) => semver.rcompare(a.bb, b.bb));
  if (!targets.length) throw new Error('No stable BB releases at or above the baseline');
  // Before three post-baseline lines exist, use all existing lines; never invent older support.
  return targets.slice(0, policy.minorLines).reverse();
}

export function engineErrors(pkg, targets, semver) {
  const errors = [];
  for (const field of ['bb', 'bbPluginSdk']) {
    const range = pkg.engines?.[field];
    if (typeof range !== 'string' || !range.trim() || !semver.validRange(range)) {
      errors.push(`Missing or invalid engines.${field}`);
      continue;
    }
    for (const target of targets) {
      const version = field === 'bb' ? target.bb : target.sdk;
      if (!semver.valid(version)) throw new Error(`Invalid ${field} target`);
      if (!semver.satisfies(version, range)) {
        errors.push(`BB ${target.bb} / SDK ${target.sdk} excluded by engines.${field}=${range}`);
      }
    }
  }
  return errors;
}

export async function readOfficialMatrix(policy, semver, request = requestJson) {
  const releases = [];
  for (let page = 1; ; page++) {
    if (page > 50) throw new Error('Release listing exceeded pagination limit');
    const batch = await request(`https://api.github.com/repos/get-bb/bb/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub release listing');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const targets = selectTargets(releases, policy, semver);
  for (const target of targets) {
    const pkg = await request(`https://raw.githubusercontent.com/get-bb/bb/${target.tag}/packages/plugin-sdk/package.json`);
    if (pkg.name !== '@get-bb/plugin-sdk' || !semver.valid(pkg.version) || semver.prerelease(pkg.version)) {
      throw new Error(`Invalid SDK metadata for ${target.tag}`);
    }
    target.sdk = pkg.version;
  }
  return targets;
}

async function requestJson(url) {
  const headers = { Accept: 'application/json', 'User-Agent': 'svaib-bb-compatibility' };
  if (new URL(url).hostname === 'api.github.com' && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Compatibility metadata HTTP ${response.status}: ${url}`);
  return response.json();
}

export async function checkPackage(pkg, policy, semver, readMatrix = readOfficialMatrix) {
  validatePolicy(policy, semver);
  if (!semver.valid(pkg.version) || semver.prerelease(pkg.version)) throw new Error('Expected stable plugin version');
  if (semver.lt(pkg.version, policy.appliesFromPlugin)) {
    return { status: 'historical-not-evaluated', pluginVersion: pkg.version, policy, targets: [], errors: [] };
  }
  const targets = await readMatrix(policy, semver);
  const errors = engineErrors(pkg, targets, semver);
  return { status: errors.length ? 'fail' : 'pass', pluginVersion: pkg.version, policy, targets, errors };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 8) throw new Error('Usage: --package FILE --policy FILE --npm-package FILE --output FILE');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--package', '--policy', '--npm-package', '--output'].includes(args[i]) || options[args[i]]) {
      throw new Error('Invalid compatibility arguments');
    }
    options[args[i]] = args[i + 1];
  }
  const pkg = JSON.parse(await readFile(options['--package'], 'utf8'));
  const policy = JSON.parse(await readFile(options['--policy'], 'utf8'));
  const report = await checkPackage(pkg, policy, loadSemver(options['--npm-package']));
  report.checkedAt = new Date().toISOString();
  report.scope = 'engine eligibility only; runtime acceptance is separate';
  await writeFile(options['--output'], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
