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
five minutes for npm's first-publication processing and compares the registry
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
2. For the first publication, create a short-lived granular npm token with
   permission to create/publish this package and bypass 2FA for CI. Add it to
   the `SolomonikVik/svaib-bb` Actions secret `NPM_BOOTSTRAP_TOKEN` through a
   secure form. Never commit the token or send it in chat.
3. Run the workflow for `v0.5.5` with publishing enabled. The first successful
   upload creates the package under that npm account. If npm creates a
   `0.0.0-stage` placeholder, the owner must approve `0.5.5` in npm's **Staged
   Packages** tab with 2FA. An accepted upload is not yet a public release.
4. In the package's npm **Settings → Trusted publishing**, select GitHub
   Actions: owner `SolomonikVik`, repository `svaib-bb`, workflow filename
   `publish-npm.yml`, no environment. Allow direct `npm publish`.
5. Remove the GitHub bootstrap secret and revoke its token in npm. Later tag
   releases authenticate with GitHub OIDC. Complete the first OIDC publication
   within npm's configuration expiry window (currently two days).

GitHub Actions builds the package for every release. No local agent build is
part of the publishing procedure. GitHub Packages is not the download registry:
it would require users to configure registry authentication even for public
npm packages.

The source of these workflow/tooling files is the private workspace's
`dev/bb-workplace/distribution/`. Its canonical Git exporter includes them in
each public plugin export so a subsequent release does not remove CI.
