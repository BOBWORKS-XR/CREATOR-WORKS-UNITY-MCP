# Changelog

## Unreleased

### Fixed

- Release asset labels now resolve draft assets through `gh release view` and their returned API URLs. The REST by-tag endpoint returned 404 during the 2.6.0-rc.1 draft-label step after all packages and consolidated checksums had uploaded. This automation-only follow-up does not change the tagged application binaries.

## 2.6.0-rc.1 - 2026-09-08

Prerelease. See [release notes](docs/releases/2.6.0-rc.1.md) for upgrade steps,
expected benefits, contributor credit, and acceptance limits.

### Added

- Focused local reference lookup with source revisions, continuations, and mandatory manual corrections; full reference resources remain available.
- A 24-tool core default for new configurations, with explicit specialist profiles and existing Full selections preserved.
- Identity-only component inventories, explicit missing-property reports, and fresh hidden/nested serialized property lookup.
- FireRat's Linux/macOS release packaging and optional unfiltered-test restriction, with project-scoped persistence and settings/error-handling safeguards.

### Changed

- Hierarchy, component, console, import, compiler, and prefab replies default to a compact 64 KiB text budget, with complete-item omission reporting, retained failure/freshness metadata, and an explicit maximum of 4 MiB.
- Graph prompts use focused documentation and node lookup instead of requesting entire manuals and catalogs.
- Field-only/filtered scene inspection avoids full snapshots; renderer enabled/material properties use bounded canonical representations.
- Compile waits require a fresh settled Editor after domain reload. Pending menu/query replies retain project-bound polling arguments and warn against duplicate submission.
- Cross-platform setup includes Codex, Claude Code, Antigravity, and OpenCode configuration. Release checksums cover all uploaded platform packages and reject incomplete inventories.

### Verified Locally

- 182 Node tests, 21 native launcher tests, version synchronization, isolated standalone protocol/reference and archive smokes, Windows NSIS packaging, and zero reported npm audit vulnerabilities.
- Disposable Unity 2022.3.39f1 and 6000.3.21f1 compile/command fixtures passed, including targeted reads without full-state rewrites and isolated test-policy checks.
- Core tool-schema text is 21,827 bytes versus 47,268 for Full (about 54% smaller). This is not an end-to-end token, cost, latency, or quota-saving claim.

Clean installation/upgrade, everyday real-project editing, and hosted/headset
acceptance of this exact candidate remain separate from source and packaging
checks. Shader Graph mutation remains experimental.

## 2.5.1 - 2026-09-03

### Fixed

- Added a pre-install runtime guard that matches only Creator Works MCP's bundled `server/runtime/node.exe`, preventing opaque locked-file failures during EXE upgrades.
- Interactive upgrades now explain which applications to close and offer **Retry** or **Cancel** without force-closing user processes; unattended upgrades fail immediately with exit code `10` while locked.

### Changed

- Stable releases now publish one guided NSIS setup executable plus the standalone ZIP and checksums. The unguarded MSI is no longer published.
- Removed the stale Shader Graph Preview suffix from the Windows application title while retaining the experimental feature label inside the launcher.

### Verified

- All 137 Node tests and all 13 native launcher tests pass, including static checks for exact-path matching, silent failure, and absence of process-killing commands.
- The unsigned 2.5.1 NSIS installer builds with the private Node.js 24.17.0 runtime.
- An isolated NSIS harness returns `10` with the exact bundled runtime locked and `0` after it closes; an independent process smoke also confirms unrelated Node paths do not match.

## 2.5.0 - 2026-09-03

### Added

- Added project-bound command envelopes and acknowledgement validation so stale project paths or Editor instance IDs fail before a Unity mutation.
- Added `get_unity_command_status` for project-scoped polling of commands that were accepted but did not finish within the initial wait.
- Added bounded `propertyNames` and `maxResponseBytes` hierarchy queries, including explicit Renderer material identity summaries.
- Added screenshot camera-selection metadata plus `includeImage` and `maxImageBytes` controls.
- Added the public structured feedback and contribution workflow from pull request 23.

### Changed

- Promoted Creator/Banter dual-SDK awareness, topology-aware Visual Scripting node placement, and clean-room experimental Shader Graph authoring from the preview branch to the stable release line.
- Pending Unity mutations now report accepted/pending state instead of user-facing success, and named-pipe completions remain available for correlated status polling.
- Import checks distinguish stale Editor heartbeat, stale compiler status, and C# assets newer than the last completed compilation.
- Corrected the Banter `GetLocalUserState` contract to its real Position and Rotation value outputs without invented flow ports.
- Clarified that custom-script mode exposes existing compiled components and does not generate arbitrary C# source.
- The Unity status window uses the packaged Creator Works application logo in its header and supported Editor window title content; the launcher propagates both bridge and logo payloads.
- The asset-reference Unity smoke now waits for the launched Editor process rather than an unrelated descendant process tree.

### Verified

- All 135 Node tests and all 13 native launcher tests pass; version synchronization, the 50-tool standalone bundle smoke, standalone ZIP install smoke, PowerShell setup smoke, and a low-severity npm audit also pass.
- Local unsigned NSIS and MSI installers build successfully with the private Node.js 24.17.0 runtime and source-of-truth Unity bridge/logo payload.
- The exact bridge compiles in disposable Unity 2022.3.39f1 and Unity 6000.3.21f1 projects; the Unity 6000.3.21f1 asset-reference command smoke passes.
- Unity 2022.3.39f1/Visual Scripting 1.9.4 and Unity 6000.3.10f1/Visual Scripting 1.9.9 both import the layout fixture with persisted, topology-ordered, non-overlapping nodes.
- Unity 2022.3.39f1/Shader Graph 14.0.11, Unity 6000.1.14f1/Shader Graph 17.1.0, and Unity 6000.3.10f1/Shader Graph 17.3.0 pass create, inspect, mutate, connect, compile-validation, stale-hash, occupied-input, and rollback checks.
- The pinned Banter SDK matrix reports 3 matched and 0 mismatched outcomes, including a successful Banter 3.2.2 Visual Scripting smoke on Unity 6000.3.2f1.

### Runtime Acceptance

- Shader Graph mutation remains experimental. Hosted Creator/Greenfield behavior, headset behavior, multiplayer behavior, and project-specific gameplay were not exercised by these automated release checks.


## 2.4.0-3 - 2026-08-26

### Changed

- Replaced the legacy Unity status-window header with the same Creator Works cube logo, cyan/red `CREATOR WORKS MCP` lockup, and Shader Graph Preview label used by the Windows launcher.
- The Unity bridge logo is now a required, versioned extension payload. The launcher and PowerShell setup install it atomically beside the bridge, and bridge status reports an update when either file is stale or missing.

### Verified

- All 119 Node tests and all 13 native launcher tests pass, including bridge branding, stale-logo detection, and installer payload coverage.
- The exact updated bridge compiled with zero C# errors in isolated Unity 2022.3.39f1 and Unity 6000.3.21f1 projects.

## 2.4.0-2 - 2026-08-26

### Added

- Added Creator SDK, legacy Banter, hybrid, Unity-only, and unknown SDK profile detection to the MCP and Windows launcher.
- Added profile badges for configured Unity projects and a Quick Setup SDK status row.
- Added Creator SDK source coverage, namespace selection, and `BS.SDKEditor.ValidateVisualScripting` discovery while retaining compatibility tool names.

### Changed

- `generate_vs_graph` now emits `BS.VisualScripting` nodes, `BS.SDK` type handles, and Creator enum namespaces for Creator/hybrid projects while preserving legacy Banter output for legacy projects.
- AI-facing resources now require SDK detection before SideQuest authoring and distinguish package aliases from hosted-runtime support.
- The portable graph validator accepts both flat custom-node namespaces and reports SideQuest SDK diagnostics without assuming Banter.

### Safety

- SideQuest shorthand generation fails closed when no supported SDK is detected.
- Graph validation and writing reject legacy custom-node namespaces in Creator-only projects, Creator namespaces in legacy-only projects, and SideQuest component type handles when no SDK is detected. Hybrid projects preserve both families with an explicit warning.
- Existing scenes and prefabs are never rewritten merely because Creator compatibility stubs exist. The documented converter design requires an audit, explicit mappings, duplicated assets, Unity serialization APIs, validation, and separately proven reverse mappings.

### Verified

- 118 Node tests and 13 native launcher tests pass.
- Read-only local fixtures detect legacy Banter SDK 3.1.2 and Creator SDK 3.2.17 profiles without modifying either project.
- Creator SDK 3.2.17 source contains all 162 captured custom-node class names plus 16 additional classes; one legacy catalogue component has no concrete Creator counterpart, so universal name replacement remains unsupported.
- The exact updated bridge compiled with zero C# errors in isolated Unity 2022.3.39f1 and Unity 6000.3.21f1 projects. Installation in a Creator SDK project, invocation of the real Creator validator, and hosted-runtime acceptance remain explicit follow-up gates.
- The unsigned NSIS installer was extracted after build; its MCP server, Node 24 runtime, and Unity bridge hashes exactly match the staged source payloads.

## 2.4.0-1 - 2026-08-26

### Changed

- Renamed the public product, launcher, installer, standalone bundle, and MCP handshake to Creator Works MCP.
- Codex and Claude Code setup now use the AI-facing `creator-works` entry and `CREATOR_WORKS_TOOL_GROUPS`; setup removes the former `banter` entry to prevent duplicate servers.
- Existing launcher configuration is migrated from `banter-mcp` to `creator-works-mcp`. Legacy environment variables and the project-local `.bantworks-mcp` bridge protocol remain supported for upgrade compatibility.
- Added a visible Shader Graph Preview label and a dedicated `read,author,shadergraph` launcher capability profile.

### Preview Status

- This build is for Aline's Shader Graph evaluation branch. Use disposable or version-controlled Unity projects; Shader Graph authoring is not yet promoted as stable release behavior.

### Added

- Added deterministic topology-aware layout for generated Visual Scripting nodes whose positions are omitted. The layout preserves authored positions, handles cycles, follows connected explicit anchors, snaps to a configurable grid, and uses node-size estimates or hints to avoid overlap.
- Added a disposable Unity import smoke that verifies generated positions survive Visual Scripting deserialization in Unity 2022.3.39f1/Visual Scripting 1.9.4 and Unity 6000.3.10f1/Visual Scripting 1.9.9.
- Added an experimental clean-room Shader Graph tool group for capability probing, structural inspection, functional Built-in/URP Lit/Unlit creation, topology-aware node placement, guarded connections, and compiler validation.

### Safety

- Shader Graph assets are read and written through Unity's installed GraphData/FileUtilities/MultiJson APIs rather than regex or JSON text surgery.
- Existing-asset mutations require an inspection SHA-256 precondition, reject assets open in Shader Graph, and refuse to replace occupied inputs without explicit opt-in.
- Failed Shader Graph writes restore original bytes atomically, verify the restored SHA-256, preserve existing metadata, and report rollback failure separately from the original mutation failure.

### Verified

- 104 Node tests pass, including chains, fan-in, cycles, explicit anchors, invalid hints, Shader Graph safety contracts, schema bounds, and generated graph serialization.
- The spatial-layout fixture imported with zero new compiler errors in both tested Unity generations; all three positions persisted, the explicit anchor remained unchanged, the consumer followed its producers, and no units shared a position.
- Unity 2022.3.39f1/Shader Graph 14.0.11, Unity 6000.1.14f1/Shader Graph 17.1.0, and Unity 6000.3.10f1/Shader Graph 17.3.0 each created, imported, re-deserialized, mutated, connected, and compiler-validated a functional graph; stale, invalid, occupied-input, and destructive mutations were rejected with byte-preserving rollback.
- The same bridge compiled and executed its asset-reference smoke in a fresh Unity 6000.3.10f1 project without Shader Graph installed.

## 2.3.0 - 2026-08-04

### Added

- Added correlated live hierarchy and component queries for `rootPath`, `componentType`, and exact-filter reads. These commands traverse only the requested subtree or scan lightweight identities before serializing matches, and do not rewrite `scene-hierarchy.json`.
- Added explicit hierarchy `localPosition`, `localRotation`, and `localScale` projections. Unsupported requested fields now fail with the complete supported-field list instead of being silently omitted.
- Added `executionSucceeded`, `settled`, and `settleVerified` result states for custom Editor menu commands.

### Fixed

- Long synchronous Editor menu commands no longer become failed commands solely because their work temporarily blocked the Editor heartbeat. The settle check waits for heartbeat recovery, preserves proven execution success when settling cannot be verified, and still fails on verified compilation errors.
- Fresh targeted queries fail explicitly on stale bridge state or timeout instead of substituting an old full-scene snapshot that can produce a false zero-match result.
- Updated the `fast-uri`, `hono`, and `ip-address` transitive dependency overrides to patched releases after the release audit exposed new upstream advisories.

### Verified

- 89 Node tests pass, including correlated targeted-query, full-snapshot non-rewrite, local-transform projection, heartbeat-recovery, and menu-result regression coverage.
- The bridge compiled with zero errors in disposable Unity 2022.3.39f1 and Unity 6000.3.10f1 projects.
- A live Unity 2022.3.39f1 command smoke returned a requested root and child with local transforms while leaving `scene-hierarchy.json` unchanged.

## 2.2.0 - 2026-07-29

### Added

- Added a versioned bridge handshake with bridge release, protocol range, Editor process identity, preferred transport, and advertised capabilities.
- Added a project-local Windows named-pipe command and acknowledgement channel. Pipe threads handle bytes only; every Unity API operation remains queued to `EditorApplication.update` on Unity's main thread.
- Added automatic atomic-file fallback for legacy, stale, unavailable, non-Windows, or protocol-incompatible bridges.
- Extended `get_bridge_status` and project routing with protocol and transport diagnostics.

### Safety

- Commands are bounded to 4 MiB and acknowledgements to 64 KiB.
- A command that may have reached Unity is never resent through the file fallback, preventing duplicate scene mutations after an acknowledgement timeout.
- Editor reload and shutdown explicitly wake and dispose the pipe listener before joining its worker.
- Full hierarchy snapshots and large correlated outputs remain project-local files rather than being pushed through the command pipe.

### Verified

- 82 Node tests pass, including real Windows named-pipe round trips, legacy fallback, main-thread source guards, and duplicate-command prevention.
- Unity 2022.3.39f1 and Unity 6000.3.10f1 compiled the bridge in disposable projects, advertised protocol 1, executed correlated `get_scenes` commands over named pipes, and exited cleanly through a second pipe command.

## 2.1.0 - 2026-07-22

### Added

- Added bounded, explicitly fresh hierarchy/component queries with exact/root/depth/component/field controls and snapshot age plus dirty-scene metadata.
- Added `wait_for_unity_compile` and persistent `compilation-status.json` diagnostics from Unity's compilation pipeline.
- Added guarded `execute_editor_menu_item` support for project-defined custom menu commands with dirty-scene, Play Mode, built-in-menu, compilation, and update preconditions.
- Extended Unity Visual Scripting validation to fail on unresolved units and value inputs that have neither a valid connection nor a persisted default.
- Added Console filters for time, message text, regular expressions, and stack source.

### Fixed

- `get_console_logs({"level":"error"})` now includes Unity `Error`, `Exception`, and `Assert` entries while preserving the original Unity level.
- `check_import_status` no longer reports success over active, stale, or failed script compilation.
- Exact hierarchy queries no longer expand every descendant whose path contains the selected root name.
- Background full-state export is now disabled by default in Edit mode as well as Play mode. A persistent `BANTWORKS MCP/Background State Export In Edit Mode` menu toggle allows explicit opt-in without affecting command polling or manual refreshes.
- Pinned patched `@hono/node-server` and `fast-uri` transitive dependencies after the release audit exposed upstream advisories. Source and standalone installs now require Node 20 or newer; the Windows launcher continues to ship its private Node 24 runtime.

### Verified

- The updated bridge compiled with zero errors in Unity 2022.3.39f1 and Unity 6000.3.2f1.
- Strict Unity deserialization inspected 1,237 value inputs across 11 generated Banter kart graphs with zero missing elements or unbound inputs.
- A live custom menu execution returned correlated timing, clean synchronous diagnostics, unchanged scene state, and a settled Editor result.

## 2.0.1 - 2026-07-17

### Fixed

- Replaced unchanged-scene full hierarchy exports in Edit mode with a lightweight editor-state heartbeat and debounced exports after actual Unity changes.
- Kept automatic full hierarchy export disabled during Play mode by default while preserving command polling and manual refresh/export commands.

### Verified

- Unity 2022.3.39f1 with a 13 MB exported hierarchy: no automatic full hierarchy rewrite during 22-second settled Edit-mode and Play-mode checks.
- Manual full exports and Play-mode control remained operational.
- The installed launcher updated every configured Unity project to the bundled bridge.
