# Unity MCP Benchmark and Roadmap

Reviewed: 2026-09-08

This benchmark is used to choose engineering work, not to make an unsupported
"best Unity MCP" claim. Creator Works MCP should lead on deterministic local Unity
automation and Banter knowledge while matching the strongest general Unity MCP
workflows where they fit its security model.

## Scope

Creator Works MCP is:

- a generic Unity Editor MCP with Banter as a deeper specialization;
- local-first and project-scoped;
- compatible with Codex, Claude Code, and other stdio MCP clients; and
- designed around explicit command correlation, atomic file publication, and
  inspectable project-local state.

It is not a repository for project-specific gameplay logic, an unauthenticated
remote-control server, or an arbitrary C# execution endpoint.

## External Benchmarks

| Project | Useful strengths | Decision for Creator Works |
|---------|------------------|------------------------|
| [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) | Mature releases, a core-by-default tool surface, optional tool groups, tests, screenshots, package/script workflows, and documented multi-instance routing | Use as the maturity and workflow benchmark. Creator Works independently uses static startup profiles; do not copy source or add HTTP by default. |
| [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) | Project-local client configuration, detailed resources, Unity Test Runner access, package operations, and batch rollback options | Adopt portable project configuration, test discovery/execution, and preflight/rollback concepts after the core identity contract is stable. |
| [ozankasikci/unity-editor-mcp](https://github.com/ozankasikci/unity-editor-mcp) | Broad scene/prefab analysis, Play Mode control, screenshots, references, and editor diagnostics | Use as a coverage checklist. Avoid copying a large tool count without focused schemas and verification. |
| [Unity CLI and Pipeline](https://github.com/Unity-Technologies/skills/blob/main/skills/unity-cli/references/integration-advanced.md) | Official Unity MCP server, project targeting, compact command discovery, and documented project-side custom commands | Treat an optional, allow-listed Pipeline adapter as the preferred interoperability path. Do not use undocumented Assistant internals. |

The three community repositories identify as MIT-licensed. Unity's official
documentation is cited as a platform contract, not as permissively licensed
source. No code, assets, schemas, or generated data from these projects is
included here. See `THIRD_PARTY_NOTICES.md`.

## Current Creator Works Position

Strong today:

- deterministic project-local transport with no listening network socket;
- atomic command/state publication and per-command acknowledgement;
- stable Unity global IDs for GameObjects and components with path fallback;
- typed, validated inspector writes with legacy command compatibility;
- domain-reload-aware Play Mode control and correlated PNG capture;
- bounded Test Runner discovery plus filtered Edit Mode and Play Mode execution,
  persisted results, and version-aware cancellation;
- fail-closed scene save/load workflows and preflighted build settings;
- session-local multi-project routing with live editor instance identity;
- read-only package inventory and bounded AssetDatabase search;
- Codex and Claude Code launcher configuration;
- focused scene, component, prefab, bounds, console, and import tools;
- read-only bridge health diagnostics;
- a 24-tool token-saver profile selected by default for new setup configurations,
  with schema-size regression tests and an exact measurement command;
- a 64 KiB default final hierarchy/component response budget with explicit opt-up;
- bounded SideQuest custom-node lookup that avoids loading the complete catalog
  for normal Visual Scripting work;
- Banter component, JavaScript, and Visual Scripting resources;
- evidence-linked Banter workflows for synced objects, interaction, UI, audio,
  networking, and WebRoot behavior, with catalogue/tool drift tests; and
- captured Banter custom-node defaults, source hashes, selected-package
  provenance/coverage, fail-closed graph generation/validation/writes, and
  correlated Unity import/deserialization diagnostics; and
- an expectation-based public Banter release matrix that distinguishes full
  integration passes from exact, known package-compilation incompatibilities.

Gaps that block a leadership claim:

- Unity-side smoke testing is not yet automated in hosted CI; and
- the public release matrix currently covers one Unity editor and the latest
  patch of three Banter SDK 3.x minor lines rather than a Unity-version matrix.

Compatibility limit: Test Framework 1.1 supports discovery and execution but
does not expose public cancellation. Creator Works fails with a capability error
instead of modifying internal runner state. Test Framework 1.6 and newer uses
its public cancellation API.

## Ordered Delivery

### P0 - Reliability Contract

1. **Complete:** export Unity `GlobalObjectId` values for GameObjects and components.
2. **Complete:** accept stable IDs on scene/component mutations while retaining
   paths for readability and backward compatibility.
3. **Complete:** replace string-only property writes with typed JSON values and
   explicit per-`SerializedPropertyType` validation.
4. **Complete:** preflight batches and roll back their Unity Undo group on
   failure unless partial progress is explicitly requested.
5. **Complete:** assign AssetDatabase references by normalized path or GUID with
   type checks, mutation-free preflight where Unity exposes `SerializedProperty`,
   verified rollback, and guarded custom-serializer paths such as
   `ScriptMachine.nest.macro`.

### P1 - General Unity Workflows

1. **Complete:** Play, pause, resume, stop, compilation, and domain-reload-aware readiness.
2. **Complete:** bounded Test Runner discovery, filtered execution, reload
   recovery, persisted progress/results, status polling, and public-API
   cancellation when supported by the installed package.
3. **Complete:** Game camera and Scene View screenshots with correlated result files and MCP image output.
4. **Complete:** AssetDatabase search, package inventory, scene save/load, and
   ordered build settings with full preflight.
5. **Complete:** stable path-derived project IDs, process-stable editor instance
   heartbeats, and explicit per-session routing with per-request config snapshots.

### P1 - Banter Advantage

1. **Complete:** record catalogue source hashes and observed SDK source profiles,
   then dynamically compare the selected package version/revision and source
   classes through `get_banter_sdk_info`.
2. **Complete (server-side):** maintain known-good Visual Scripting graph
   fixtures for canonical generation, Unity 1.9 serialization compatibility,
   referential integrity, native metadata, and old-MCP metadata migration.
3. **Complete (repeatable local fixtures):** `validate_vs_graph_in_unity` forces
   import and deserialization and reports graph-element diagnostics. A generic
   fixture passed in Unity 2022.3.39f1 with Visual Scripting 1.9.4. The committed
   Banter fixture generates `Banter.VisualScripting.OnGrab`, imports it in Unity
   6000.3.2f1 with Visual Scripting 1.9.9 and a pinned public Banter SDK, persists
   its `ScriptMachine` reference, and exercises allow, reject, and recovery
   validation paths. The release matrix also pins public 3.0.2, 3.1.2, and 3.2.2
   tags: the first two reproduce exact Unity 6 material-API compiler diagnostics,
   while 3.2.2 passes the full fixture. Hosted Unity CI remains.
4. **Complete:** `validate_banter_visual_scripting` invokes the SDK's public
   validator reflectively and returns bounded structured diagnostics. Positive
   and deliberately forbidden custom-unit fixtures verified both paths.
5. **Complete:** add focused Banter workflows for synced objects, interaction,
   UI, audio, networking, and WebRoot behavior, with implementation-surface
   selection, validation gates, and catalogue/tool drift tests.

### P2 - Distribution and Scale

1. **Complete:** versioned standalone server and launcher resources without
   machine-specific source paths, isolated bundle smoke, NSIS/MSI release
   targets, and draft GitHub release automation.
2. Project-local client configuration option and migration tooling.
3. **Complete:** composable `core`, `read`, `author`, `test`, and `banter` capability
   groups, routing-only mode, tools/list filtering, direct-call enforcement,
   fail-closed parsing, schema budget tests, and client launcher profiles.
4. **Complete (initial matrix):** document exercised Unity, Banter SDK, Visual
   Scripting, Test Framework, Node, client, and Windows distribution surfaces.
   Generic asset-reference and public Banter release rows now have repeatable
   local fixtures; hosted Unity CI and a multi-editor matrix remain.

### P3 - Planned Interoperability and Creator Workflow

1. Test the existing stdio server through documented Assistant MCP Extensions
   before building an adapter. Assistant 2.19 docs describe this route but mark
   older Unity MCP tooling deprecated in favor of CLI. Separately evaluate an
   optional Pipeline `[CliCommand]` adapter only if it adds measurable value.
   Live Creator Works interoperability is not yet verified; see the dated
   primary sources in `future-roadmap.md`. Do not use internal Assistant APIs.
2. Build a preview-first Creator SDK bootstrapper that detects the project and
   Unity version, pins an explicit package version, backs up manifest/lock data,
   waits for compilation, and runs the installed SDK validator.
3. Add optimistic concurrency for mixed manual and MCP editing: fresh scene
   revisions and object fingerprints on mutation commands, conflict responses
   on stale preconditions, and Undo groups scoped only to the command's own
   changes. Never restore a whole scene from an earlier MCP snapshot.
4. Last: build a deterministic local player-interaction harness for spawn,
   movement, grabbing, held events, triggers, and ownership approximations.
   Keep it separate from hosted-client, Quest, and multiplayer acceptance.

## Release Gate

A feature is complete only when it has:

- a narrow schema and documented failure behavior;
- automated server-side tests;
- a Unity compile/import test where Unity behavior is involved;
- no project-specific assumptions;
- path, identity, and concurrency review;
- security and license review; and
- updated user-facing documentation.
