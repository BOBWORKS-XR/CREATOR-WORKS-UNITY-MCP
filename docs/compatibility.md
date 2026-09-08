# Compatibility Matrix

Reviewed: 2026-08-26

This matrix records exercised combinations, not assumptions based only on
package metadata. A row marked "manual" was run in a disposable local project,
an "automated local" row has a committed repeatable fixture, and CI rows are
enforced by the repository workflow.

## MCP Server and Clients

| Surface | Status | Verification |
|---------|--------|--------------|
| Bundled Node.js 24 LTS | Windows launcher runtime | The installer packages a checksum-verified official Windows x64 executable and writes its absolute path to managed clients |
| Node.js 20, 22, 24 | Standalone/source CI target | TypeScript build, server test suite, standalone esbuild bundle, and isolated no-`node_modules` smoke |
| Codex desktop/CLI | Supported configuration | Launcher and `setup.ps1` write stdio configuration, project environment, 20-second startup timeout, and 600-second tool timeout |
| Claude Code/Desktop | Supported configuration | Launcher and `setup.ps1` write the same stdio server and selected project environment |
| Other MCP clients | Protocol-compatible | Requires stdio MCP support and a way to set `UNITY_PROJECT_PATH`; no client-specific integration is assumed |

The server intentionally rejects `--http`. It does not open a network listener.
Tool-surface restriction is client-independent through `CREATOR_WORKS_TOOL_GROUPS`;
the default remains `all` for backward compatibility.

## Unity and SideQuest SDKs

| Unity | Visual Scripting | SideQuest SDK | Result |
|-------|------------------|------------|--------|
| 2022.3.39f1 | 1.9.4 | None | Manual: bridge compiled; canonical Start graph imported and deserialized with no missing elements |
| 2022.3.39f1 | None | None | Automated local disposable fixture: 2.3.0 bridge compiled; a live correlated root/subtree query returned local transforms without rewriting the full hierarchy snapshot |
| 6000.3.2f1 | 1.9.9 | 3.2.2, source fingerprint `c893607975bb44f319445b533b421d184f6a5285` | Manual: bridge and SDK compiled; generated `Banter.VisualScripting.OnGrab` graph imported with one node and no missing elements; SDK validator passed |
| 6000.3.2f1 | 1.9.9 | Same as above | Manual negative fixture: a forbidden custom unit imported, and the SDK validator returned the expected failure and exact forbidden type |
| 6000.3.2f1 | 1.9.9 | Observed Git snapshot reporting 3.2.1 at `44e873c3dea26a2d4e12bd2f837d614da926c54f` | Automated local disposable fixture: Creator Works generated `OnGrab`; bridge import validation passed; `ScriptMachine` assignment survived scene reload; SDK allow-list positive, forbidden-unit negative, and recovery checks passed |
| 6000.3.2f1 | 1.9.9 | Public release 3.0.2 at `a25b261db11d7ced12704a3a9ffc83778da3afd6` | Automated expected incompatibility: package compilation failed with `CS0619`, `CS0029`, and `CS0266` for legacy `PhysicMaterial` APIs |
| 6000.3.2f1 | 1.9.9 | Public release 3.1.2 at `c75593e029cfcb7aecca6a880082f6d5d6853883` | Automated expected incompatibility: package compilation failed with `CS0619`, `CS0029`, and `CS0266` for legacy `PhysicMaterial` APIs |
| 6000.3.2f1 | 1.9.9 | Public release 3.2.2 at `8cff56ed80a7f694d0de204a4fa7bfc660f6d503` | Automated local matrix: generated `OnGrab` imported; `ScriptMachine` assignment survived scene reload; SDK allow-list positive, forbidden-unit negative, and recovery checks passed |
| 6000.3.10f1 | 1.9.9 | None | Automated local disposable fixture: bridge compiled; path/GUID assignment, clear, type mismatch, incompatible type, traversal, and non-reference rejection passed; a real `ScriptGraphAsset` attached to and cleared from `ScriptMachine.nest.macro` |
| 6000.3.10f1 | None | None | Automated local disposable fixture: 2.3.0 bridge compiled with zero errors |
| 6000.3.10f1 | 1.9.9 | None | Persistent obstacle fixture: generic course compiled; MCP-generated `Start` graph imported and persisted through the bridge; 4/4 Play Mode tests passed |
| 6000.3.2f1 | 1.9.9 | Public release 3.2.2 at `8cff56ed80a7f694d0de204a4fa7bfc660f6d503` | Persistent obstacle fixture: two synced balls persisted; generated `OnGrab` graph survived bridge attachment and scene reload; SDK allow-list passed; 4/4 Play Mode tests passed |
| 2022.3.39f1 | 1.9.4 | Public release 3.1.2 at `c75593e029cfcb7aecca6a880082f6d5d6853883` | Persistent obstacle fixture: two synced balls persisted; generated `OnGrab` graph survived bridge attachment and scene reload; SDK allow-list passed; 4/4 Play Mode tests passed |
| 2022.3.39f1 | None | None | Isolated local compile smoke: the exact 2.4.0-3 dual-SDK bridge compiled with zero C# errors |
| 2022.3.39f1 authoring to 6000.3.2f1 Banter client | 1.9.4 asset bundle loaded by 1.9.9 client | Authoring SDK 3.1.2; client source reports 3.2.1 | Manual real-client negative: authoring SDK validation passed, but the client rejected `UnityEngine.Rigidbody.velocity` and disabled all four gun-recovery graphs. The two installed allowlists had drifted to `velocity` versus `linearVelocity`. |
| 6000.3.21f1 | 1.9.9 | Creator SDK 3.2.17 (`com.sidequest.creator-sdk`) | Read-only local package/source audit: detected the Creator profile, selected `BS` and `BS.VisualScripting`, matched all 162 captured custom-node class names, and found 16 additional package classes. Source-level bridge and generator fixtures passed; installation of the new bridge and hosted runtime behavior remain separate acceptance gates. |
| 6000.3.21f1 | None | None | Isolated local compile smoke: the exact 2.4.0-3 dual-SDK bridge compiled with zero C# errors |

Creator Works detects `com.sidequest.creator-sdk`, `com.sidequest.banter`, both
packages together, neither package, and malformed or unreadable manifests. New
graph shorthand resolves to `BS.VisualScripting` for Creator/hybrid projects and
to `Banter.VisualScripting` for legacy projects. The compatibility-named
`validate_banter_visual_scripting` command probes the Creator validator first
and the legacy validator second. See
[sidequest-sdk-transition.md](sidequest-sdk-transition.md) for the exact
authoring and conversion boundary.

The observed Banter 3.2.2 package declares Unity 2022.3.39f1 metadata, but its
source references Unity 6 `PhysicsMaterial` and `PhysicsMaterialCombine` types.
A clean Unity 2022.3.39f1 compile therefore failed. The package compiled in
Unity 6000.3.2f1 after its declared test dependency was present. Treat the
package source and a clean compile as authoritative; do not infer compatibility
from the semantic version or package metadata alone.

The exercised Banter package source imports NUnit from runtime code but does not
declare `com.unity.test-framework`. The repeatable Unity 6 fixtures request Test
Framework 1.6.0 explicitly and verify the resolved lock entry, so this upstream
package requirement is visible rather than supplied accidentally by an existing
project. An earlier 1.1.33 request was upgraded by Unity to 1.6.0 and is not
reported as the resolved version.

`get_banter_sdk_info` reports the selected package source identity, compares its
classes with the embedded catalogues, and returns `matched`, `different-source`,
`source-metadata-mismatch`, `unity-version-unverified`, or `unverified`
public-release evidence. It only returns `matched` for an exact revision,
package version, and editor combination.
`validate_vs_graph_in_unity` checks actual import/deserialization, and
`validate_banter_visual_scripting` invokes the installed SDK's public allow-list
validator. These checks should be run in the target project before treating a
generated graph as ready. When an asset bundle is authored with an older Unity
and SDK combination than the shipped Banter client, also compare the concrete
member allowlists or load the bundle in the real client and inspect its AOT
diagnostics. Passing the authoring SDK validator alone does not prove that the
client still allows renamed Unity members such as `Rigidbody.velocity`.

The repeatable obstacle fixture and its safety boundary are documented in
[obstacle-course-compatibility.md](obstacle-course-compatibility.md).

## Unity Test Framework

| Package capability | Behavior |
|--------------------|----------|
| Test Framework 1.1-era API | Discovery and execution are supported; cancellation returns an explicit capability error |
| Test Framework 1.6+ public API | Discovery, execution, persisted results, polling, and cancellation are supported |

Play Mode domain reloads are expected. Run IDs and result files are persisted
under the project's `.bantworks-mcp` state so a client can resume polling.

## Windows Distribution

- The standalone server is one versioned ESM file and was smoke-tested from an
  isolated directory without `node_modules`.
- The Tauri NSIS build completed locally and included the server bundle, Unity
  bridge, license, and third-party notices as application resources.
- MSI and NSIS are release workflow targets. They are unsigned unless release
  signing secrets and certificate settings are supplied.
- Tagged draft releases include SHA-256 checksums for the standalone archive
  and generated Windows installers.

## Remaining Coverage

- The Unity fixtures are repeatable locally but are not yet automated on
  GitHub-hosted runners with a licensed Unity Editor.
- The public release matrix covers one Unity editor and the latest patch of
  three Banter SDK 3.x minor lines; it is observed compatibility, not an SDK
  support-policy declaration.
- The launcher configuration writers have unit coverage, but client startup is
  not exercised end to end in CI.
- Banter runtime behavior still requires testing inside the target scene; graph
  import and allow-list validation do not prove multiplayer or runtime behavior.
