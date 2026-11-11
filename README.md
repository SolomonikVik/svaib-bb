# svaib for BB

Connect the svaib account and work with the management-space structure in BB Desktop. Requires BB 0.48.1 or later with compatible Plugin SDK 0.6.104 or later in the 0.6 line. A Codex, Claude Code or Pi model connection and a svaib account are configured separately.

## Version 0.6.2

Kimi setup now allows up to 15 minutes for npm installation, reports download and installation progress, and verifies Node, the adapter and Claude Code before activating a new runtime. Interrupted or damaged owned runtimes can be reinstalled without replacing the API key. Installation is staged with rollback and serialized across workers. Each Node download has a five-minute limit.

Managed Kimi through Claude Code keeps the default main agent and hides the Agent picker. Internal helpers remain available for delegation; model, reasoning and permission choices are preserved. Existing generated profiles migrate without replacing keys or reinstalling the model runtime. The bundled Harness remains 0.12.0.

## Version 0.6.1

Fixes Kimi through Claude Code setup after installing Claude plugins. Generated profiles now retain `enabledPlugins` and `extraKnownMarketplaces` during migration and model-catalog updates, including when Claude has reordered the JSON. Changes to managed Kimi settings still block an update. Keys and plugin settings are preserved; generic setup errors no longer assume a network problem. The bundled Harness remains 0.12.0, and the pinned model runtime is unchanged.

## Version 0.6.0

The metrics page now shows the shared server Screen dashboard, with a saved binding, first fill and a native discussion composer that preserves the selected metric and period. BB and the browser use the same renderer and server document; old local snapshots are not uploaded automatically.

The bundled Harness is **0.12.0**. The common payload includes the Pi adapter; BB preserves an existing Pi provider, model and permissions. The complete Pi account/company/folder/Screen flow remains a separate live acceptance check. One verified npm package supports BB 0.48.1 and 0.49.0: BB 0.48.1 uses the SDK104 bundles directly, while a newer SDK may trigger BB's own backend rebuild. Existing settings and the working model and account connections are preserved. The full flow on a real macOS 11 device and with production OAuth and company metrics remains a separate acceptance check.

## Version 0.5.7

Restores installation on BB 0.48.1, including account-specific Kimi context limits, automatic model catalog updates and setup diagnostics. After an owned Kimi profile changes, a harmless generation marker in its ACP registration invalidates both model caches; newer BB keeps its explicit fresh-read request. Existing registration fields, keys, conversation models and the bundled Harness 0.11.0 are preserved.

## Version 0.5.6

Kimi setup reads the models, context limits and supported reasoning effort available to your API key. It refreshes the catalog during setup, after a key change and daily. New models appear automatically; existing conversations and the profile default are preserved. Confirmed 1M models use the larger window; a failed catalog request keeps the last model list with conservative limits.

Setup and updates now write structured diagnostics to `bb plugin logs svaib-workplace`. The log records stages, durations and failure categories without keys, filesystem paths or response contents. Interrupted key changes cannot reuse an old verification reply or leave the new key with the previous 1M limit.

The bundled Harness remains 0.11.0. The pinned Claude Code runtime is unchanged; runtime upgrades are separate from model-catalog refreshes. Updating generated settings affects new conversations. The full flow on an actual Plus/Moderato subscription and every desktop platform remains a separate acceptance check.

## Version 0.5.5

The Kimi setup card now opens the international Kimi Code console at https://www.kimi.ai/code/console. The bundled Harness remains 0.11.0.

## Version 0.5.4

The bundled Harness is 0.11.0. It fills a missing company from the current workspace while preserving an explicit choice, and no longer keeps company selection in conversation history. The shared guide to Claude and ChatGPT access has been updated. BB and native Harness installations continue to update independently.

## Version 0.5.2

Onboarding instructions are shorter and use the current Kimi setup card. The bundled Harness is 0.10.1. BB and Harness update independently: the current and two previous minor lines of each are supported. A version difference does not interrupt work or require reinstalling or signing in again. Existing official native installations and newer prepared method packages are preserved; missing features are handled for the specific action.

## Version 0.5.1

Fixes installation from Git: the SDK process module used by the Kimi host is included in production dependencies. Setup behavior and the shared Harness payload are unchanged.

## Version 0.5.0

Kimi setup continues automatically after you enter an API key. Open the [Kimi Code console](https://www.kimi.ai/code/console), choose “Create API key” and paste the key into the setup card. The plugin prepares the components, configures access, sends a short verification request and removes its own test conversation after a successful reply.

The card shows the current stage and elapsed time, refreshes automatically and restores saved progress after navigation or restart. The configured computer is selected automatically. Failed checks have an explicit retry; key replacement rejects replies from the previous key.

If a suitable Node.js 22+ with npm is unavailable, the plugin downloads a private portable runtime from nodejs.org and verifies its SHA256. It does not require an administrator or a global Node installation. Manual installation remains a fallback when automatic preparation fails. A separate Kimi Code subscription and API key are required; access to models depends on the plan.

The model picker now follows the agent's native ACP catalog: K3.1 Pro, K3.1 Pro Highspeed, K3, K3 256K, K2.8 Preview and K2.7 Code Highspeed. Reasoning effort is selectable where supported. Highspeed models consume more quota. Existing generated profiles are upgraded without replacing keys or reinstalling the adapter; modified or unrelated profiles are preserved. Reopen the setup card from plugin settings to check the connection again.

Client scenario cards can also open a configured web link.

The shared Harness 0.10.0 payload is unchanged. One package serves Codex and Claude Code; updating its native installation remains a separate checked step.

This is an early access release. The local test build was manually checked in the existing Linux BB. Host installation and setup-card tests ran on Windows x64/ARM64 and macOS Intel/Apple Silicon. The complete fresh-user flow inside BB on each desktop platform remains a separate acceptance step.

## Installation

Paste `npm:bb-plugin-svaib-workplace` into BB's **Install from source** dialog.
You do not install Git or build tools manually. The package includes a prebuilt
frontend and backend. It targets BB0.48.1 / SDK0.6.104 so that runtime can use
the backend directly. A BB release with a different SDK may automatically
rebuild the backend using BB's own toolchain.
The complete flow on an Intel Mac with macOS11.7.11 remains unverified; npm alone
does not guarantee a fix for the reported `_SecTrustCopyCertificateChain` error.

Install `https://github.com/SolomonikVik/svaib-bb` in BB Settings → Installed plugins → Install from source. The package is at the repository root. BB uses its bundled npm and toolchain; users do not install npm or unpack an archive. The ordinary Git URL tracks the default branch; immutable semantic-version tags are available for explicit range tracking.

For an agent-managed install with an explicit compatible release range:

```sh
bb plugin install git:https://github.com/SolomonikVik/svaib-bb.git@^0.5.5
```

The repository contains the BB plugin and one shared methodology package for Codex and Claude Code. Its hooks detect their native host. The connection assistant preserves the actual provider and profile, validates the bundled package and prepares that provider's stable local marketplace, then uses the CLI's normal plugin installation. Python 3 is required by the methodology handlers and managed sign-in. The managed Codex sign-in path currently requires Codex CLI 0.166.0. User credentials remain in the normal model and svaib sign-in flows.

BB plugin updates deliver new bundled files. Updating the native methodology installation is a separate checked operation in the same profile; it is not an atomic part of the BB update. The connection assistant preserves working sign-ins and asks before replacing a marketplace from a different source.
