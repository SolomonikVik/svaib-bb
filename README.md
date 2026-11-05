# svaib for BB

Connect the svaib account and work with the management-space structure in BB Desktop. Requires BB 0.48.1 or later with compatible Plugin SDK 0.6.104. A Codex or Claude Code model connection and a svaib account are configured separately.

## Version 0.4.0

Set up Kimi through Claude Code from the svaib page before connecting an agent: check Node.js, enter the API key, prepare a separate profile and open a test conversation. Existing provider settings are preserved. The setup card can be reopened from plugin settings. Node.js 22 or later with npm and a separate Kimi subscription/API key are required; if Node is missing, the card links to its installer.

One shared Harness 0.10.0 package now serves Codex and Claude Code. Preparation preserves their existing local marketplace paths when upgrading from methodology 0.9.2. Updating the native installation remains a separate step.

This is an early access release. The new installed setup flow, fresh Kimi sign-in and Windows/macOS still require live acceptance.

## Installation

Install `https://github.com/SolomonikVik/svaib-bb` in BB Settings → Installed plugins → Install from source. The package is at the repository root. BB uses its bundled npm and toolchain; users do not install npm or unpack an archive. The ordinary Git URL tracks the default branch; immutable semantic-version tags are available for explicit range tracking.

For an agent-managed install with an explicit compatible release range:

```sh
bb plugin install git:https://github.com/SolomonikVik/svaib-bb.git@^0.4.0
```

The repository contains the BB plugin and one shared methodology package for Codex and Claude Code. Its hooks detect their native host. The connection assistant preserves the actual provider and profile, validates the bundled package and prepares that provider's stable local marketplace, then uses the CLI's normal plugin installation. Python 3 is required by the methodology handlers and managed sign-in. The managed Codex sign-in path currently requires Codex CLI 0.166.0. User credentials remain in the normal model and svaib sign-in flows.

BB plugin updates deliver new bundled files. Updating the native methodology installation is a separate checked operation in the same profile; it is not an atomic part of the BB update. The connection assistant preserves working sign-ins and asks before replacing a marketplace from a different source.
