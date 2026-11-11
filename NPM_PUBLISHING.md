# npm publication

The public package is `bb-plugin-svaib-workplace` on npmjs.com. Its identity and
version match the BB plugin in this repository; its source stays on GitHub.
Users paste `npm:bb-plugin-svaib-workplace` into BB's **Install from source**
dialog. They do not need Git or an npm account for this installation.

## Automated releases

New plugin releases from `0.5.8` must admit the latest stable patch of the current
BB Desktop minor line and two previous lines, starting at the adopted baseline
`0.48.1`. `bb-compatibility.json` defines this transition. Historical plugin tags
are not retroactively evaluated or changed. The rule concerns the BB application,
not the independent versions of this plugin and its bundled Harness.

Before building, `scripts/check-bb-compatibility.mjs` resolves official GitHub
release tags and their Plugin SDK versions, and rejects `engines.bb` or
`engines.bbPluginSdk` ranges that exclude a target. Metadata failures block the
check; the matrix is never silently reduced. CI saves the dated report in the
`bb-compatibility` artifact. Test selection and engine-range checks use the semver
implementation shipped with the pinned build tool's npm. This gate does not
prove runtime compatibility: loading, install/update, preserved settings and the
changed user flow must also be accepted on each selected BB version before release.
After publication, check that an unversioned npm install on the oldest supported
target resolves the new plugin version. Raising SDK build dependencies does not
authorize raising client minimums.

For a local preflight against an exported candidate (the parent output directory
must exist):

```sh
node scripts/check-bb-compatibility.mjs \
  --package package.json --policy bb-compatibility.json \
  --npm-package /path/to/bb-tool/node_modules/npm/package.json \
  --output bb-compatibility-report.json
```

`.github/workflows/publish-npm.yml` runs when a stable `vX.Y.Z` tag is pushed.
The tag must match `package.json`. It installs locked production dependencies
with lifecycle scripts disabled, builds with pinned `bb-app@0.48.1`, packs the
plugin, then installs the tarball with `git` disabled. Checks cover all three
BB bundles and their metadata, the bundled local Screen dependency, and native
Harness preparation for both Codex and Claude Code. Consumer checks use Node
22.23.4 (also pinned by the Kimi runtime helper), import the server bundle and
check host syntax. The installed package is rejected if it contains esbuild,
native add-ons, platform executables, or root installation/build hooks.

The build targets BB 0.48.1 / SDK 0.6.104, the oldest admitted runtime.
Verification rejects artifacts built by another BB/SDK; pinning the plugin's
SDK dependency alone does not select the builder's metadata version. Source
compatibility with SDK 0.6.132 is checked separately from artifact creation.

npm installation does not run this package's build/install hooks and preserves
its prebuilt frontend. For SDK major zero, BB accepts a prebuilt server only
when its exact SDK matches the runtime. A different SDK may cause BB to rebuild
the server with its own cached toolchain, downloading that toolchain on first
use. Thus npm is not an unconditional promise of no local compilation. Aligning
the artifact with SDK104 prevents that fallback on BB0.48.1. Newer BB/SDK
combinations require their own runtime acceptance.

The rejected SDK132 artifact triggered esbuild0.28.1 download on a clean
BB0.48.1 Linux runtime. Its official Darwin x64 binary declares Mach-O minimum
macOS12, so this fallback must not be presented as a macOS11 remedy. Node24 is
used on the CI runner; consumer checks remain Node22.23.4. A real macOS11.7.11
Intel device remains an open acceptance check, including the reported
`_SecTrustCopyCertificateChain` case, model adapter and external tools.

The publish job receives only the verified tarball, checks its SHA256, and
publishes that exact artifact. Build artifacts and source/hash receipts remain
available in the Actions run for 30 days. A failed check prevents publication;
an existing npm version is never overwritten. Registry confirmation waits up to
fifteen minutes for npm's first-publication processing and compares the registry
tarball hash to the verified artifact. Fix a failed run and rerun it; if npm
accepted publication, do not rerun the publish job for that version merely
because registry processing exceeded this wait.

For an existing tag (including the first npm release `v0.5.5`), use **Actions →
Publish npm package → Run workflow** on `main`. Enter the tag. Leave `publish`
off for a build-only check; turn it on to publish. A manual run checks out the
specified tag for plugin source and uses release tooling from the selected
workflow ref. No version bump or replacement Git tag is needed merely to add
an npm distribution of an already released plugin.

## One-time npm setup

1. Create and verify an npmjs.com account and enable 2FA. Registration, password,
   and accepting npm's terms belong to the account owner.
2. The first publication, `0.5.5`, used a one-time bootstrap token. It created
   the package under the npm account `svaib`. That secret has been removed from
   GitHub, and the workflow no longer has a token fallback. Revoke the original
   `bb-plugin-bootstrap` token in npm's account settings as well.
3. npm may show a temporary
   `0.0.0-stage` placeholder while processing a direct publication; that alone
   does not mean owner approval is required. Ask for approval only if the actual
   staged-publish response or authenticated staged-package list confirms it.
   An accepted upload is not yet a publicly downloadable release.
4. In the package's npm **Settings → Trusted publishing**, select GitHub
   Actions: owner `SolomonikVik`, repository `svaib-bb`, workflow filename
   `publish-npm.yml`, no environment. Allow direct `npm publish`.
5. Run **Publish npm package** on `main` with `check_oidc` on (and `publish`
   off). This checks GitHub-to-npm OIDC token exchange for this exact workflow
   without building or publishing. Credential values are kept only in process
   memory and never logged or persisted. This verifies authentication; it is
   not a completed package publication. Later tag releases use OIDC. Complete
   the first actual OIDC publication within npm's configuration expiry window
   (currently two days); a credential-only probe must not be assumed to meet
   that requirement.

GitHub Actions builds the package for every release. No local agent build is
part of the publishing procedure. GitHub Packages is not the download registry:
it would require users to configure registry authentication even for public
npm packages.

The source of these workflow/tooling files is the private workspace's
`dev/bb-workplace/distribution/`. Its canonical Git exporter includes them in
each public plugin export so a subsequent release does not remove CI.
