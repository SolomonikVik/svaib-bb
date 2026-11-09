# npm publication

The public package is `bb-plugin-svaib-workplace` on npmjs.com. Its identity and
version match the BB plugin in this repository; its source stays on GitHub.
Users paste `npm:bb-plugin-svaib-workplace` into BB's **Install from source**
dialog. They do not need Git or an npm account for this installation.

## Automated releases

`.github/workflows/publish-npm.yml` runs when a stable `vX.Y.Z` tag is pushed.
The tag must match `package.json`. It installs locked production dependencies
with lifecycle scripts disabled, builds with pinned `bb-app@0.49.0`, packs the
plugin, then installs the tarball with `git` disabled. Checks cover all three
BB bundles and their metadata, the bundled local Screen dependency, and native
Harness preparation for both Codex and Claude Code. Consumer checks use Node
22.23.4 (also pinned by the Kimi runtime helper), import the server bundle and
check host syntax. The installed package is rejected if it contains esbuild,
native add-ons, platform executables, or root installation/build hooks.

This avoids the Git installation's local esbuild step, including the reported
`_SecTrustCopyCertificateChain` error on an Intel Mac with macOS 11.7.11. For npm
sources BB uses the prebuilt app/server/host files; no local compiler is needed.
Node 24 is used on the CI build runner only. The npm package does not raise the
OS requirements of an already working BB installation. The BB application,
model adapter and external tools have their own compatibility limits. A real
macOS 11 device remains the acceptance check; a Linux/modern macOS run does not
prove that complete user flow.

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
