# svaib for BB

Connect the svaib account and work with the management-space structure in BB Desktop. Requires BB 0.48.1 or later with compatible Plugin SDK 0.6.104. A Codex or Claude Code model connection and a svaib account are configured separately.

## Version 0.5.0

Kimi setup continues automatically after you enter an API key. Open the [Kimi Code console](https://www.kimi.com/code/console), choose “Create API key” and paste the key into the setup card. The plugin prepares the components, configures access, sends a short verification request and removes its own test conversation after a successful reply.

The card shows the current stage and elapsed time, refreshes automatically and restores saved progress after navigation or restart. The configured computer is selected automatically. Failed checks have an explicit retry; key replacement rejects replies from the previous key.

If a suitable Node.js 22+ with npm is unavailable, the plugin downloads a private portable runtime from nodejs.org and verifies its SHA256. It does not require an administrator or a global Node installation. Manual installation remains a fallback when automatic preparation fails. A separate Kimi Code subscription and API key are required; access to models depends on the plan.

The model picker now follows the agent's native ACP catalog: K3.1 Pro, K3.1 Pro Highspeed, K3, K3 256K, K2.8 Preview and K2.7 Code Highspeed. Reasoning effort is selectable where supported. Highspeed models consume more quota. Existing generated profiles are upgraded without replacing keys or reinstalling the adapter; modified or unrelated profiles are preserved. Reopen the setup card from plugin settings to check the connection again.

Client scenario cards can also open a configured web link.

The shared Harness 0.10.0 payload is unchanged. One package serves Codex and Claude Code; updating its native installation remains a separate checked step.

This is an early access release. The local test build was manually checked in the existing Linux BB. Host installation and setup-card tests ran on Windows x64/ARM64 and macOS Intel/Apple Silicon. The complete fresh-user flow inside BB on each desktop platform remains a separate acceptance step.

## Installation

Install `https://github.com/SolomonikVik/svaib-bb` in BB Settings → Installed plugins → Install from source. The package is at the repository root. BB uses its bundled npm and toolchain; users do not install npm or unpack an archive. The ordinary Git URL tracks the default branch; immutable semantic-version tags are available for explicit range tracking.

For an agent-managed install with an explicit compatible release range:

```sh
bb plugin install git:https://github.com/SolomonikVik/svaib-bb.git@^0.5.0
```

The repository contains the BB plugin and one shared methodology package for Codex and Claude Code. Its hooks detect their native host. The connection assistant preserves the actual provider and profile, validates the bundled package and prepares that provider's stable local marketplace, then uses the CLI's normal plugin installation. Python 3 is required by the methodology handlers and managed sign-in. The managed Codex sign-in path currently requires Codex CLI 0.166.0. User credentials remain in the normal model and svaib sign-in flows.

BB plugin updates deliver new bundled files. Updating the native methodology installation is a separate checked operation in the same profile; it is not an atomic part of the BB update. The connection assistant preserves working sign-ins and asks before replacing a marketplace from a different source.
