# Unity CLI Compatibility Experiment

Status: read-only prototype on `experiment/unity-cli-support`, 2026-09-10.
Not installed, automatically selected, or exposed as an additional MCP tool.
There are no new runtime dependencies or stable bridge/launcher changes.

## What Is Implemented

| Action | Accepted operation | Bounds |
| --- | --- | --- |
| `status` | `editor_status` | Project, Editor version, compile/reload and heartbeat checks |
| `commands` | Filtered compact command discovery | Required query, 1-100 results |
| `find` | `find_gameobjects`, exact name only | Required name; retains IDs for duplicate names |
| `scenes` | `list_open_scenes` | Loaded/active/dirty status, no hierarchy dump |

Every invocation requires `--enable` and an absolute project path. The adapter
checks local metadata and the executable version, then validates the returned
project and command identity. Results are compact JSON. Unknown versions,
malformed responses, wrong-project responses and upstream errors fail closed.
No automatic retry or backend fallback is sent.

Per-process stdout plus stderr is limited to 256 KiB, with a default 15-second
timeout (maximum 60 seconds). A successful invocation starts two CLI processes:
one version check and one operation. The timeout applies separately to each.
Timeout/overflow stops the owned CLI child, not Unity; it does not cancel or
prove termination of an Editor operation already dispatched. Read-only scope
limits this ambiguity. Successful list results are capped at 32 KiB and report
returned, omitted, total and truncation metadata. Whole items are omitted,
never cut into invalid JSON. `find` bounds downstream output, not Unity's
underlying search work; many identical names may exceed the process cap.

Raw stderr and arbitrary upstream messages are withheld from the result.
Warning codes/counts, stderr byte counts and `diagnosticsWithheld` identify
missing diagnostic detail; they do not certify a warning-free operation.
Review official CLI diagnostics locally when required, before sharing logs.
`processBytes` counts the two CLI processes' stdout/stderr, not all IPC traffic.

The adapter does not install packages, configure accounts/clients, open or close
Editors, perform writes, run tests/builds, expose arbitrary C# evaluation, or
translate our existing tool calls. Command discovery describes capabilities;
it does not grant permission to execute them. No background polling is added.

## Prerequisites

This prototype deliberately pins the combination actually tested:

- Standalone Unity CLI `1.0.0-beta.8`.
- `com.unity.pipeline` `0.6.0-exp.1`, resolved from `https://packages.unity.com`.
- A running Unity 6 project. Tested on Windows with `6000.3.21f1` only.
- If Unity Assistant is present, version 2.13 or newer. Only metadata checking
  of this condition has been tested; coexistence with Assistant is unverified.
- Node.js 20 or newer for building/running this checkout.

Unity documents that the CLI is standalone and does not require the Hub desktop
app. Live Pipeline access requires Unity 6.0 LTS or later; managing installed
Editor versions is a separate capability. Use the current Creator Works bridge
for Unity 2022. This prototype does not upgrade projects. See Unity's
[CLI setup](https://docs.unity.com/en-us/unity-cli/use-unity-cli) and
[migration/compatibility guidance](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli).

Supply a trusted official CLI executable, not `Unity.exe` from an Editor install.
The adapter rejects recognizable Editor installations before version probing.
It does not authenticate arbitrary executables or verify their signatures; the
caller is responsible for provenance. For the Windows test, the official
`1.0.0-beta.8` CDN manifest's SHA-256 matched the downloaded executable:
`f2b2571cd5e9d9975be3cab0b7e3931a9f6193c42c2a491f7c30d72861349993`.
The CLI binary is not redistributed by Creator Works.

The CLI owns its local authentication to Pipeline. The adapter does not read
tokens or edit authentication settings. Its child environment suppresses CLI
update/consent/crash/cloud automation for these probes; this is not a guarantee
of zero network activity or zero telemetry from the installed Unity packages.
Review Unity's [Pipeline analytics documentation](https://docs.unity3d.com/Packages/com.unity.pipeline@0.6/manual/analytics.html)
and applicable terms before enabling those packages.

## Use The Prototype

Run from this branch's checkout. First resolve the pinned Pipeline package and
open a disposable project yourself, or use the fixture below. The adapter
never repairs missing prerequisites automatically.

```powershell
npm ci
npm run build
$project = 'C:\UnityTests\CliProbe'
$cli = 'C:\Tools\UnityCLI\unity.exe'
node dist/unity-cli.js status --enable --project $project --executable $cli
node dist/unity-cli.js commands --enable --project $project --executable $cli --query find_gameobjects --limit 3
node dist/unity-cli.js find --enable --project $project --executable $cli --name 'Exact Object Name' --limit 20
node dist/unity-cli.js scenes --enable --project $project --executable $cli
```

`--help` lists arguments. Exit 0 means the read succeeded (and status was ready
when requested); exit 1 means a failed probe or non-ready Editor; exit 2 means
invalid command-line syntax. Use `--name=--literal-name` for flag-like names.
The adapter passes values as individual arguments with no shell interpolation.
Do not treat earlier `status` output as a lock on later scene changes.

## Verification

```powershell
npm test
npm run check:version
npm run release:server
npm run measure:context
./scripts/smoke-unity-cli.ps1 `
  -UnityEditor 'C:\Program Files\Unity\Hub\Editor\6000.3.21f1\Editor\Unity.exe' `
  -UnityCli 'C:\Tools\UnityCLI\unity.exe' `
  -ProjectPath 'C:\UnityTests\NewDisposableCliProbe' `
  -ProbeScript "$PWD\scripts\smoke-unity-cli.mjs"
```

The Windows harness refuses an existing destination, creates a blank project,
adds pinned Pipeline and our current bridge, and runs a 35-object fixture.
It downloads package dependencies and starts a hidden, batch-mode Editor.
Only its own Editor process is shut down. Projects/logs remain for inspection;
no production projects or installed launchers are modified. This fixture still
requires a working, licensed Unity installation and registry access/cache.

Observed on 2026-09-10:

- All 233 Node tests passed, including 38 new CLI cases: disabled/unsupported
  configurations, process limits, failure propagation, identity validation,
  literal arguments, byte-bounded Unicode results and readiness.
- Version metadata check and existing bundled MCP smoke passed. Core remained
  25 tools / 23,172 schema bytes; Full remained 53 / 48,613.
- `cargo check --locked` passed after the normal `stage:runtime` build step;
  no launcher source changes. `npm audit --audit-level=low` found zero issues.
- Live status, filtered discovery, scene inspection, flag-like quoted names,
  duplicate-name IDs and deep-hierarchy IDs passed in Unity `6000.3.21f1`.
  The final run included exact requested-name acknowledgement validation;
  compile-error pattern checks found no C# compiler errors in its logs.
- Seven paired lookups matched the existing bridge's GlobalObjectIds. Scene,
  manifest, package-lock and Editor-version hashes were unchanged.
- An initial harness run failed on my incorrect expected bridge source label;
  corrected against the bridge's source contract before the passing run. This
  was a test mistake, not a bridge/CLI defect.

### Small-Scene Comparison

Six alternating-order exact-name lookups returned the same two objects. These
are complete adapter-call timings, not complete AI-task measurements. The CLI
timings include its version preflight; both paths use the same already-running
Editor. Returned payload fields differ, so this is not an identical-schema test.

| Route | Elapsed time range | Returned JSON UTF-8 bytes |
| --- | --- | --- |
| Existing live targeted bridge | 12.9-29.7 ms | 932 |
| Experimental CLI adapter | 124.3-139.8 ms | 899 |

The CLI's captured process output was 1,147 bytes per duplicate-name lookup;
bridge transport bytes were not measured. No model was involved. This small
result does **not** establish token, provider-allowance, large-project or headset
savings. It does not justify replacing the current bridge. Unity's general
efficiency claims are not measurements of this adapter against Creator Works.

## Gates Before Adoption

1. Compare equivalent complete inspection, validation and authoring workflows:
   tool discovery, instructions, inputs, output, retries and client token usage.
   Keep diagnostics and task success equivalent. Include large scenes and
   repeated calls before considering process/version caching.
2. Test missing/busy/reloaded Editors, simultaneous projects, supported version
   combinations and actual Creator SDK/Banter projects in disposable copies.
   Linux/macOS runtime and installed-Assistant coexistence remain untested.
3. Add selected routing only where measurements show a benefit. Retain the
   current bridge for SDK/Visual Scripting behavior and unsupported Editors.
   Keep one explicit backend per command; never retry uncertain writes through
   another backend.
4. Separately design write semantics before adding them: identity, stale-edit
   guards, Undo/rollback behavior, world/local transforms, compilation failures,
   timeouts and readback. Unity documents `set_transform` as local-space; our
   existing world-space operations cannot be forwarded blindly. See the
   [official transform contract](https://docs.unity3d.com/Packages/com.unity.pipeline@0.6/manual/commands/gameobjects-and-components.html).
5. Only then consider a launcher opt-in, version updates, provenance checks and
   a release. No executable/package redistribution without a terms review.

## Unity AI Relationship

Unity explicitly positions the CLI as the replacement for the old MCP server
inside its Assistant package; third-party MCP packages are unaffected. The
documentation does not establish that Assistant internally invokes the CLI
for every action. No Unity AI subscription is needed for the CLI itself.
These are separate from this prototype's unimplemented Unity AI integration.
See [Unity's explanation](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli).

The branch is intentionally limited to evaluating a useful additional route.
It does not bring forward SDK installation, conversion work, manual-edit
conflict handling, or the deferred player emulator.
