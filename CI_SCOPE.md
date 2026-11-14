# Pi platform acceptance scope

This check branch does not publish npm packages, tags, or releases. It uses only
standard hosted runners in this public repository. It does not upload or use
production credentials.

The matrix covers Linux x64, Windows x64/ARM64, and macOS Intel/ARM64 against
official BB 0.48.1 and 0.49.0. It checks:

- Native and managed Pi setup regressions, profile ownership, command handling,
  registration replacement, and real npm dependency resolution.
- The actual managed Pi 1.5.2 and portable Node, including an empty PATH.
- The shipped Harness with real pi-subagents from npm, a copied and reusable
  runtime, and successful initialization through Pi's actual extension loader.
- A real isolated BB server and daemon, initially absent Pi, the official Pi
  installer, protected synthetic-key setup, and automatic wizard completion.
- Real BB/Pi context over consecutive requests, plugin reload, and recreation of
  only the model profile followed by a BB restart.
- A destructive negative case: deleting native session journals starts empty Pi
  history while BB retains its transcript. This is an upstream limitation, not
  a successful history restoration, and is recorded explicitly in result.json.

The Pi model fixture examines the actual context received by native Pi and
returns deterministic text. No paid model API is used. These tests do not prove
real Kimi service availability or login, browser OAuth, interactive Desktop UI,
Windows UAC, or macOS 11 compatibility. Hosted Windows runners have UAC disabled.
