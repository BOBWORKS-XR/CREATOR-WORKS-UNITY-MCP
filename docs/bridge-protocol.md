# Unity Bridge Protocol

Creator Works MCP uses a local, project-scoped hybrid bridge. On Windows, protocol-compatible versions prefer a named pipe for small commands and acknowledgements. Atomic project-local files remain the compatibility fallback and the transport for state snapshots and larger correlated results. The bridge does not open a TCP, HTTP, or WebSocket listener.

## Handshake and Transport

`state/project-instance.json` is the live bridge handshake. It contains the bridge release, protocol range, Editor process identity, heartbeat, capabilities, preferred transport, and current pipe name. Protocol 1 clients accept only a fresh descriptor that explicitly advertises `named_pipe_commands` and a validated project-local pipe name.

The pipe reader runs outside Unity's main thread but only receives bounded UTF-8 JSON and queues it. `EditorApplication.update` drains that queue before checking compatibility command files. Scene traversal, `AssetDatabase`, serialization, test execution, and every other Unity API call therefore remain on the main thread.

If a pipe endpoint is absent, stale, incompatible, unsupported, or cannot be connected before sending, the server atomically publishes the same command under `commands/`. Once a command may have reached the pipe, it is not submitted again through files; this prevents duplicate mutations when an acknowledgement is lost.

Pipe command payloads are limited to 4 MiB and acknowledgements to 64 KiB. Large hierarchy snapshots, screenshots, test runs, asset searches, and other correlated artifacts continue to use bounded project-local files.

## Locations

With a Unity project selected from `UNITY_PROJECT_PATH` or session routing, the bridge uses:

| Location | Direction | Purpose |
|----------|-----------|---------|
| `.bantworks-mcp/commands/*.json` | MCP to Unity | Scene, prefab, refresh, and state-export requests |
| `.bantworks-mcp/state/*.json` | Unity to MCP | Hierarchy, editor state, console, import status, compilation status, and prefab catalogue |
| `.bantworks-mcp/state/project-instance.json` | Unity to MCP | Live editor identity, heartbeat, protocol, capabilities, and preferred endpoint |
| `.bantworks-mcp/state/command-results/*.json` | Unity to MCP | Per-command acknowledgement or failure |
| `.bantworks-mcp/state/bounds-results/*.json` | Unity to MCP | Per-bounds-query result |
| `.bantworks-mcp/state/screenshot-results/*.png` | Unity to MCP | Correlated Game or Scene View captures |
| `.bantworks-mcp/state/screenshot-results/*.json` | Unity to MCP | Capture dimensions, actual camera identity, selection method, and ambiguity metadata |
| `.bantworks-mcp/state/asset-search-results/*.json` | Unity to MCP | Correlated AssetDatabase query results |
| `.bantworks-mcp/state/vs-validation-results/*.json` | Unity to MCP | Correlated Visual Scripting import and deserialization results |
| `.bantworks-mcp/state/banter-validation-results/*.json` | Unity to MCP | Correlated Banter SDK allow-list validation results |
| `.bantworks-mcp/state/test-discovery/*.json` | Unity to MCP | Correlated, bounded Test Runner discovery results |
| `.bantworks-mcp/state/test-runs/*.json` | Unity to MCP | Persisted Test Runner state and bounded case results |
| `.bantworks-mcp/state/scene-results/*.json` | Unity to MCP | Correlated open-scene and build-settings results |
| `.bantworks-mcp/state/editor-menu-results/*.json` | Unity to MCP | Correlated custom Editor menu execution, timing, state, and synchronous diagnostics |
| `.bantworks-mcp/state/hierarchy-query-results/*.json` | Unity to MCP | Correlated bounded live hierarchy or component query results |

The bridge directory is project-local and ignored by Git through its own `.gitignore` file.

## Publication and Correlation

The MCP server and Unity bridge publish JSON by writing a temporary file in the same directory and renaming it into place. Unity therefore sees a complete command, and the MCP server sees complete exported state.

Each mutating command receives a UUID. The command envelope also carries the selected route ID, canonical project path, and current Editor instance ID. Unity validates the expected project path and Editor instance before dispatching the command, then includes its actual project path and Editor instance ID in the acknowledgement. The route ID remains a server-side correlation value because Unity does not derive the server's path hash. The server rejects acknowledgements from another project or Editor process.

Unity writes an acknowledgement under the command UUID, and bounds queries use the same UUID for their result file. A command that was delivered but did not finish within the initial wait is returned as accepted and pending, not successful. Call `get_unity_command_status` with both the UUID and the original `projectId`; the status read fails closed if another project is selected, validates the persisted result against the current project and Editor, and consumes only that correlated result.

State-export requests also receive unique filenames, so simultaneous `query_project_state` calls do not overwrite each other before Unity reads them.

Hierarchy and component queries with a `rootPath`, `componentType`, requested
`propertyNames`, or any nonempty identity filter use a correlated live query when the selected
Editor heartbeat is live. Unity traverses only the requested subtree or scans
lightweight object/component identities before serializing matches. Results are
bounded and do not rewrite `scene-hierarchy.json`. Broad reads retain the
explicit full-snapshot export path. The response reports refresh state,
snapshot/editor ages, dirty-scene state, returned byte count, and bounded query
metadata. `maxResponseBytes` limits the complete compact JSON response text,
including metadata, to 16 KiB through 4 MiB (default 64 KiB).
`query.responseBytes` measures that exact UTF-8 text, excluding the MCP transport
envelope. Both live and saved queries filter and project before limiting items;
the server reports truncation rather than implying that omitted matches do not
exist. If no complete item fits, the response suggests narrower fields or a
larger explicit budget. Exact `propertyNames` reduce component serialization further; requesting
`materials`, `sharedMaterials`, or `m_Materials` on a Renderer returns a
JSON-encoded summary of at most 64 shared materials with name, asset path, asset
GUID, and shader. Unsupported field names fail explicitly; world and local
transform projections are available. `refresh: false` explicitly accepts the
latest saved snapshot.

`compilation-status.json` is independent of asset import status. The bridge
records compilation start/completion plus bounded compiler errors and warnings,
and preserves late errors even when the warning limit is reached. Import checks
report Editor heartbeat staleness and compiler-status staleness separately; the
overall status is stale only when both are stale. A C# asset newer than the last
completed compilation is reported separately as `staleAssembly` and cannot be
treated as successfully imported until Unity compiles it.

## Project Routing

`list_unity_projects` combines the initial `UNITY_PROJECT_PATH` with enabled or
disabled launcher channels, deduplicates canonical project paths, and assigns a
stable `unity-<hash>` route ID derived from each canonical path. It reports
project validity, bridge installation, state freshness, launcher metadata, and
the live editor identity when available.

`select_unity_project` changes only the current MCP server session. It does not
rewrite launcher, Codex, or Claude configuration. Every request receives an
immutable snapshot of the selected project paths, so a concurrent route change
cannot redirect an in-flight command or result poll.

The Unity bridge updates `project-instance.json` with process ID, process start,
Unity version, and a process-stable editor instance ID. That ID survives script
and Play Mode domain reloads but changes when the Unity editor process restarts.

## Stable Object Identity

Every GameObject and component in `scene-hierarchy.json` includes a Unity
`globalObjectId`. Scene and component tools prefer these identifiers while
retaining hierarchy paths for readability and compatibility with older clients.

| Target | Preferred field | Compatibility field |
|--------|-----------------|---------------------|
| GameObject | `objectId` | `objectPath` |
| Parent GameObject | `parentId` | `parentPath` |
| Component | `componentId` | `componentType` |
| Referenced GameObject | `targetId` | `targetPath` |

When both an ID and path are present, the bridge resolves the ID. It verifies
that GameObjects belong to the active scene and that component IDs belong to the
selected GameObject. A stale ID, mismatched component ID, ambiguous component
type, or duplicate hierarchy path fails without mutating the scene.

Global object IDs remain stable across hierarchy renames and reparenting, but an
ID can become stale when its object is deleted and recreated. Read fresh
`project://state` or call `query_project_state` before a sequence of mutations.

## Typed Inspector Values

`set_component_property` accepts a JSON value rather than requiring callers to
encode everything as a string. Supported shapes are:

| Unity property | JSON value |
|----------------|------------|
| Boolean | `true` |
| Integer, LayerMask | `3` |
| Float | `2.5` |
| String | `"hello"` |
| Vector2, Vector3, Vector4 | `[1, 2]`, `[1, 2, 3]`, `[1, 2, 3, 4]` |
| Vector2Int, Vector3Int | integer arrays of length 2 or 3 |
| Quaternion, Color | four-number arrays in `x,y,z,w` or `r,g,b,a` order |
| Enum | enum name, display name, or zero-based index |
| Rect | `[x, y, width, height]` or `{ "x": 0, "y": 0, "width": 1, "height": 1 }` |
| Bounds | `{ "center": [0, 0, 0], "size": [1, 1, 1] }` |

Scene-object and component references use `set_object_reference`. Project asset
references use `set_asset_reference`, selected by normalized `Assets/...` or
`Packages/...` path, or by the 32-character GUID returned from asset search.
The asset tool accepts an optional expected type and verifies that Unity retains
the assignment after applying it. It prefers native `SerializedProperty`
references and supports guarded nested CLR paths for components that use custom
serialization. Unity Visual Scripting graph attachment uses `nest.macro` on a
`Unity.VisualScripting.ScriptMachine`. Neither reference type is accepted
through `set_component_property`. Unsupported property types return an explicit
command failure.

The MCP server sends both `valueJson` for current bridges and a legacy `value`
string. Bridges also continue to accept commands that contain only the legacy
field.

## Batch Transactions

Batch commands are fully parsed and preflighted before the first scene change.
Preflight validates command types, object selectors, prefab assets, primitive
types, transform array lengths and finite values, parent dependencies, and
duplicate output paths.

The bridge applies a batch inside one Unity Undo group. The default
`continueOnError: false` behavior reverts that group when any operation fails,
then returns a failed command acknowledgement. Successful batches remain one
normal Undo action in the Unity Editor.

`continueOnError: true` is an explicit opt-in for partial progress. In that
mode, successful operations remain applied and the acknowledgement still reports
the failed operations. Use it only when operations are independent.

## Editor Workflows

`control_play_mode` supports `play`, `pause`, `resume`, and `stop`. The MCP
server does not treat the command acknowledgement as the final state. It polls
`editor-state.json` until Unity reaches the requested state and compilation has
finished, including after a Play Mode domain reload.

`capture_unity_screenshot` renders either an active game Camera or the current
Scene View camera into a bounded RenderTexture. The PNG is published under the
command UUID. Its adjacent JSON result records the actual camera ID, hierarchy
path and name for Game capture, the camera selection method, candidate count,
selection ambiguity, and Scene View name where applicable. `includeImage=false`
returns metadata and the local path without an inline image; `maxImageBytes`
prevents unexpectedly large PNGs from being embedded while retaining the file
and metadata. Callers cannot choose an arbitrary filesystem destination. The
bridge retains only the 20 most recent PNG and JSON results.

`search_unity_assets` uses `AssetDatabase.FindAssets` and publishes a correlated
JSON result containing GUIDs, paths, names, and main asset types. Searches are
bounded to 500 results and default to the `Assets` tree; package search requires
an explicit option. `get_unity_packages` is read-only and parses the project's
package manifest, lock file, revision hash, and Unity version without requiring
a running Editor. `get_banter_sdk_info` adds Banter-specific provenance: it
locates the selected package source, reports git revision or package-cache
identity, and compares Visual Scripting and scene-component C# classes with the
embedded source-hashed catalogues. It also matches the exact revision and Unity
version against the pinned public release matrix, explicitly distinguishing a
verified match, different source content with the same version, and an untested
editor version. A revision/package-metadata mismatch fails closed instead of
inheriting release evidence. Class counts prove source presence only; Unity
import and Banter build validation remain authoritative.

`validate_vs_graph_in_unity` accepts only an `Assets/.../*.asset` path. The
bridge forces a synchronous AssetDatabase import, loads the main asset, verifies
that it is a `Unity.VisualScripting.ScriptGraphAsset`, and reflects its graph
elements without introducing a compile-time Visual Scripting dependency. The
correlated result includes the Unity asset GUID, concrete asset and graph types,
  dependency hash, element counts and types, missing-element diagnostics,
  failed unit definitions, and every value input that has neither a valid
  connection nor a persisted default. Unbound inputs fail by default because
  Unity Visual Scripting throws `MissingValuePortInputException` if they are
  evaluated; `allowUnboundValueInputs` is an explicit report-only override.
Projects without Visual Scripting return an explicit validation failure while
the bridge itself continues to compile.

`validate_banter_visual_scripting` reflectively locates
`Banter.SDKEditor.ValidateVisualScripting.CheckVsNodes()` so the bridge has no
compile-time Banter dependency. The SDK performs its own AssetDatabase refresh
and scans Script Graph assets, State Graph assets, embedded prefab graphs, and
embedded graphs in the active scene. Results distinguish validator availability,
completion, and pass/fail state. Up to 200 `[VisualScripting]` diagnostics are
returned with bounded stack traces; `diagnosticCount` and
`diagnosticsTruncated` preserve the total and truncation state. Projects without
a compatible Banter validator fail explicitly without breaking the generic
Unity bridge.

## Editor Commands

`execute_editor_menu_item` invokes an exact project-defined Unity `MenuItem`
path and returns correlated before/after Editor state, duration, the Boolean
result from `EditorApplication.ExecuteMenuItem`, and bounded synchronous Error,
Exception, and Assert diagnostics. It blocks Unity's built-in File, Edit,
Assets, GameObject, Component, Window, Help, and CONTEXT roots. Compilation,
asset updates, Play Mode, and dirty scenes fail closed unless the applicable
explicit override is supplied. By default the server also waits for a stable
post-command compile/import state. `executionSucceeded` reports the menu call
independently of `settled` and `settleVerified`. A stale heartbeat after a long
synchronous command produces an explicit warning without erasing proven
execution success; a settled compilation with errors still fails the operation.

## Unity Test Runner

The test tools use the optional `com.unity.test-framework` package through
reflection, so projects without that package still compile the bridge.
`discover_unity_tests` returns bounded leaf test cases with exact full and unique
names, assemblies, categories, modes, and run states. `run_unity_tests` supports
Edit Mode, Play Mode, exact test names, regex group names, categories, and
assembly filters. The Editor must be out of Play Mode and finished
compiling/importing before discovery or execution starts.

The bridge writes each run to `state/test-runs/<runId>.json`, updates the file as
individual cases finish, and re-registers its callback after a Play Mode domain
reload. A call may stop waiting while the Unity job continues; use
`get_unity_test_run` with the returned run ID. Per-case retention is bounded, old
runs are pruned, and a zero-test run reports `noTests: true` and
`testsPassed: false` rather than silently passing.

`cancel_unity_test_run` is exposed only through the Test Framework's public
`CancelTestRun` contract, available in package 1.6 and newer. Older packages
return an explicit unsupported-capability error. A cancellation may trigger a
Play Mode domain reload after the terminal callback. In that case the bridge
marks cleanup complete only after the accepted cancellation is at least two
seconds old, the Editor has left Play Mode, and the framework reports no active
test job. The persisted result remains `testsPassed: false` and identifies
`completionSource` as either `run_finished` or
`cancellation_cleanup_observed`.

## Scene Lifecycle and Build Settings

`get_unity_scenes` returns every open scene plus the complete ordered
`EditorBuildSettings.scenes` list. Results include active and dirty state, scene
handles, asset GUIDs, build indices, and enabled flags.

`save_unity_scene` saves the active scene or an identified open scene without an
Editor dialog. Save As paths must remain under an existing `Assets/` folder, and
an existing different scene is protected unless `overwrite=true`.

`open_unity_scene` accepts Single or Additive mode. A Single-mode load fails if
it would discard dirty scenes. `saveModifiedScenes=true` saves scenes that already
have asset paths first; untitled scenes still require an explicit Save As.

`set_unity_build_scenes` replaces the ordered build list. The bridge validates
the entire bounded list, rejects duplicates and missing scene assets, and leaves
the previous build settings untouched when preflight fails.

## Health Check

`get_bridge_status` is read-only. It reports:

- whether the currently selected route points to a Unity project;
- whether `Assets/Editor/BanterMCPBridge.cs` is installed;
- whether the bridge state and command directories exist;
- which exported state files exist and their age; and
- the next setup step when the bridge is not ready.

`stateStatus: "fresh"` means at least one known state file was updated in the preceding 10 seconds. It is an observation of export freshness, not a guarantee that the Unity Editor will remain available for future commands.

## Security Boundary

The MCP client can invoke actions that write inside the configured Unity project and mutate the active Unity scene. Treat MCP client access as equivalent to trusted local developer access.

The server intentionally has no remote transport and no arbitrary C# execution feature. Adding either would require an explicit authentication, authorization, and threat-model design before it is appropriate for this repository.
