# Creator Works MCP

Creator Works MCP connects Codex, Claude Code, Antigravity, OpenCode, and other compatible MCP clients directly to Unity Editor. It provides guarded project awareness and tools for scenes, prefabs, components, assets, tests, native Unity Visual Scripting, SideQuest SDK workflows, and experimental Shader Graph authoring.

[Download 2.6.0](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.6.0) | [Release notes](docs/releases/2.6.0.md) | [All releases](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases)

**2.6.0 brings the first token-efficiency release to stable**, with deep-hierarchy
and command-status fixes, measured transform receipts, optional local feedback,
and update notifications. It includes FireRat's Linux/macOS packaging and test-run
controls. Keep a backup and verify your own SDK/project workflow after upgrading.

![Creator Works MCP configured Windows launcher](docs/images/creator-works-mcp-guided-launcher.png)

*The launcher shows the private runtime, connected MCP clients, active Unity project, detected Creator SDK/Banter SDK/Unity-only profiles, and each project's bridge status. Amber **Update available** labels mean the project-local bridge should be refreshed; they are not SDK compile or runtime results.*

## Highlights

- **Guided setup:** packages a private Node.js 24 LTS runtime and configures Codex, Claude Code, Antigravity, and OpenCode without requiring a separate Node installation
- **Multi-project Unity workflow:** discovers Unity Hub projects, remembers the active project, routes MCP calls explicitly, and updates project-local bridges with backups
- **Creator and Banter SDK awareness:** identifies Creator SDK, legacy Banter SDK, hybrid, Unity-only, and unknown projects, then selects the appropriate `BS.*` or `Banter.*` contracts
- **Unity scene and asset tooling:** creates and modifies GameObjects, components, references, prefabs, scenes, build settings, and batches with preflight checks and Unity Undo support
- **Native Visual Scripting:** generates, validates, writes, imports, and checks Unity Visual Scripting graphs using a source-observed custom-node catalogue and SDK validator
- **Experimental Shader Graph tooling:** inspects real nodes, slots, and targets, uses content hashes for concurrency, protects occupied inputs, and verifies rollback after failed writes
- **Testing and diagnostics:** exposes compiler status, filtered Console logs, Unity Test Framework runs, screenshots, import status, package metadata, and bounded hierarchy queries
- **Token-aware setup:** new installations expose a compact 25-tool core profile, with specialist capabilities available as opt-in profiles
- **Optional feedback:** private project Markdown notes and consent-based usage check-ins; no automatic uploads or account access
- **Release notifications:** manual checks, plus opt-in automatic stable-release checks; installation stays manual
- **Low-overhead local bridge:** keeps command polling responsive without repeatedly serializing an unchanged scene hierarchy

## What to Expect in 2.6.0

- **Less context spent on setup:** new configurations default to 25 core tools instead of all 53. This reduces measured tool-schema bytes by about 52%, not your total token bill. Existing Full selections stay Full.
- **Smaller documentation and scene replies:** focused reference lookup includes corrections, and bounded inspection replies report omitted or missing data. Full references and larger explicit reads remain available.
- **Keep specialist capabilities:** select **Full Unity + Banter** for every tool, or a focused Banter, Unity authoring, Testing, or Shader Graph profile, then reconnect the client. Full also benefits from bounded replies and focused references.
- **More dependable Editor feedback:** identity-only component queries avoid serialized property dumps, missing properties are explicit, and compile waits account for domain reload. A pending command reports how to resume polling instead of encouraging duplicate edits.
- **Complete-depth snapshots and clearer receipts:** full active-scene snapshots no longer drop children below depth 10. Query limits appear before the data, and create/modify results distinguish requested transforms from observed values.
- **Long-command visibility:** dispatch records survive a blocked pipe reply or heartbeat. A dispatched status does not claim that an asynchronous build finished, or that a stalled process is still running.
- **More control over testing:** optionally disable unfiltered Unity test runs. The policy is project-scoped and survives domain reload; the compatible default still allows them.
- **More distribution options:** Windows x64 EXE, Linux x86_64 AppImage/DEB/RPM, macOS Apple Silicon DMG, and a standalone Node.js ZIP. Platform packaging checks are not the same as real installation and Unity-session acceptance.

The intended benefit is less unnecessary context and fewer avoidable retry
loops, without removing capabilities from Full. End-to-end token, latency,
provider-quota, and headset performance improvements have not been established.
This release does not include render-pipeline conversion, a Creator SDK
installer, Unity AI integration, or a player emulator.

## Experimental Unity CLI Support

The `experiment/unity-cli-support` branch contains an opt-in, read-only Unity
CLI adapter for compatibility checks, filtered command discovery, exact-name
object lookup, and open-scene inspection. It is **not enabled in the launcher
or the released MCP**. The existing bridge remains the default, including for
Unity 2022 projects. The first small-scene comparison matched object identities,
but the CLI wrapper was slower and did not establish token savings.
See [scope, setup, measurements, and merge gates](docs/unity-cli-experiment.md).

## Quick Start

1. Download the Windows x64 setup EXE or the matching Linux/macOS package from [2.6.0](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.6.0).
2. Open **Creator Works MCP** and choose a Unity project.
3. Select the MCP clients you want to configure.
4. Press **Set Up Creator Works MCP**.
5. Use **Update Bridges** for projects marked **Update available**.
6. Restart any MCP client that was already open, then call `get_bridge_status`.

A ready bridge reports `ready: true` and `stateStatus: "fresh"`. The launcher can import existing project and client settings from an earlier installation; verify the imported projects and update their bridges before removing the previous Windows application.

When upgrading, save and close the Unity projects you intend to update and back
up project/client configuration first. Installing the app is not proof that an
existing project bridge is current: use **Update Bridges** deliberately, reopen
the selected project, and let Unity compile. After reconnecting the MCP client,
check the project path, bridge version, and selected tool profile before editing.
The installer alone does not establish compatibility with every SDK or project.

During an EXE upgrade, Setup checks whether its private runtime is still active. If prompted, save your work, fully close Codex, Claude Code, and Creator Works MCP, then select **Retry**. Setup never force-closes those applications; an unattended install exits with code `10` while the runtime is locked.

For the one-time move from the v2.5.0 MSI to the v2.5.1 EXE, close MCP clients before starting Setup. The old MSI must be removed before the new guarded EXE update path takes over.

The Windows installer is currently unsigned, so Microsoft Defender SmartScreen can display an Unknown publisher warning. macOS builds are not notarized. Verify downloads against the release's `SHA256SUMS.txt`; checksums verify integrity, not publisher identity. Windows releases use the guided EXE rather than a separate MSI.

## SDK Profiles

Creator Works MCP treats SDK detection as project metadata, not proof that the project compiles or runs:

| Profile | New authoring contract | Validator |
|---|---|---|
| Creator SDK | `BS.*` and `BS.VisualScripting.*` | `BS.SDKEditor.ValidateVisualScripting` |
| Banter SDK | `Banter.SDK.*` and `Banter.VisualScripting.*` | Banter SDK validator |
| Hybrid | Creator contract for new work, legacy content preserved | Profile-aware |
| Unity only | Unity built-ins only | No SideQuest SDK claim |
| Unknown | Inspection only until package identity is resolved | No inferred claim |

The MCP contains source-checked knowledge of Banter components and 163 represented custom Visual Scripting node types. It also understands the Creator SDK namespace transition and refuses SideQuest-only shorthand when no matching SDK is detected.

## Visual Scripting

The Visual Scripting workflow is closed-loop:

1. Detect the selected project's SDK profile.
2. Generate a graph with profile-correct units and types.
3. Validate graph structure and required value inputs.
4. Write the native `.asset` while preserving an existing GUID.
5. Force Unity to import and deserialize the graph.
6. Run the installed SideQuest SDK validator when available.
7. Exercise the behavior in the target Unity and hosted client.

The bundled reference includes the Unity Visual Scripting JSON manual v2.2, source-observed compatibility corrections, and an extracted custom-node catalogue with serialized defaults and provenance. Normal requests use the bounded `search_sidequest_vs_nodes` tool; the complete catalog resource remains available for explicitly requested exhaustive audits.

## Bridge Performance

Automatic full-scene state export is disabled by default in both Edit and Play mode. The bridge keeps lightweight status and command polling active, while explicit **Creator Works MCP > Refresh State** and `export-state` requests still produce a full snapshot when needed.

Targeted hierarchy queries serialize only the requested subtree or matching components. Unity object traversal remains on Unity's main thread; the bridge does not use background threads to access Unity objects.

## Token Use

This section describes 2.6.0. Source tests do not replace real-project and
installer acceptance.

New launcher and setup configurations default to the `core` profile. It exposes
25 general inspection, scene-authoring, and optional-feedback tools instead of all 53 schemas.
Current source measurement is 23,172 schema bytes for `core` versus 48,613 for
`all`, about 52% less before the user's prompt or any tool result is counted.
Actual tokens vary by MCP client and model; run `npm run measure:context` for the
current byte counts, on-demand resource sizes, and rough estimates.

Hierarchy and component results default to a 64 KiB compact response-text budget,
including metadata. `query.responseBytes` reports the actual UTF-8 text size.
The previous default was 512 KiB for item data alone. A caller can explicitly request up to 4 MiB when a large result is
actually required. Asset and prefab discovery use their dedicated bounded tools.
Filtering and field projection happen before limiting the returned items. An
oversized individual item reports truncation and suggests a narrower projection.
Use `componentDetails: "identity"` to inventory components without serialized
properties. Requested properties that are not returned appear in
`missingProperties`; they must not be interpreted as false values. Fresh targeted
reads support hidden/nested serialized paths and renderer enabled/material state.
Query budgets accept 16,384 through 4,194,304 bytes; this is a ceiling, not padding.
Hierarchy text filters search only object and component identity fields; hidden
serialized property values cannot create unexplained matches. Filtered live
reads use the correlated targeted-query path rather than a full-state export.
SideQuest node lookup returns 10 matches by default and has a hard cap of 25,
so graph work does not need to ingest the complete custom-node catalog.

`get_mcp_reference` searches the bundled manual, component, JavaScript, and
workflow references without sending entire documents. Results include explicit
continuations and source revisions; manual replies always include the correction
guide. This is available in Full, Inspection, Unity authoring, and Banter profiles.
The original complete references remain available on explicit request.

Console, import, compiler, and prefab replies also default to 64 KiB of compact
result text. Complete entries are retained, omissions and original counts are
reported, and compilation failure/freshness metadata is preserved. Callers can
filter, raise the budget up to 4 MiB, or inspect the named local snapshot files.

Profiles reduce the exposed tool set; they are not lossless schema compression.
Choose Full when every operation must remain immediately available, while still
benefiting from focused references and bounded reads. See the
[options and next phase](docs/token-optimization-next-phase.md) and
[review evidence](docs/token-optimization-review-2026-09-08.md).

Existing saved `all` selections are preserved. Changing the profile updates
client configuration, so restart an already-running MCP client afterward. A
server started manually without `CREATOR_WORKS_TOOL_GROUPS` still exposes `all`
for backward compatibility.

Compile waits tolerate domain reload until their deadline and require a fresh,
settled Editor before confirming readiness. A command timeout is not cancellation:
follow its project-bound polling instructions instead of submitting it again.

## Local Feedback and Updates

Both features are optional. In **Feedback & Updates**, enable local feedback for
the selected project. Notes live at `.bantworks-mcp/feedback/MCP_FEEDBACK.md`,
outside `Assets`, with a local Git ignore file. Nothing is uploaded automatically;
existing tracked files remain tracked. Review private content before sharing.

The `project_feedback` tool can record a bounded attempted action, actual result,
impact, and client/model. A separate opt-in enables usage check-ins at completed
task boundaries: at least five unique tasks and 24 hours between questions.
The AI client must call `task_complete`; this is not a timer-driven Unity popup.
Skipping is fine. Usage is only what a user volunteers and explicitly permits
recording, not account scraping, exact token metering, or proof of savings.
Preferences and reminder state survive server restarts. Disable either option
without deleting existing notes. See [feedback guidance](FEEDBACK.md).

**Check for Updates** reads public GitHub stable-release metadata. Automatic
checking is off by default; when enabled, checks run at launcher startup and
every six hours while it is open. GitHub receives the normal network request,
not project data or usage logs. No installer downloads, installation, application
shutdown, or project bridge updates happen automatically. Save work, install when
ready, then deliberately update project bridges and reconnect MCP clients.

## MCP Clients

The launcher and cross-platform setup CLI configure Codex, Claude Code,
Antigravity, and OpenCode. Configuration support does not prove every client's
tool-schema presentation or runtime behavior; check the selected profile after
reconnecting. Any stdio-compatible MCP client can launch the standalone bundle:

```toml
[mcp_servers.creator-works]
command = "node"
args = ["C:/path/to/Creator-Works-MCP/creator-works-mcp.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 600

[mcp_servers.creator-works.env]
UNITY_PROJECT_PATH = "E:/unity/MyProject"
CREATOR_WORKS_TOOL_GROUPS = "core"
```

The standalone ZIP requires Node.js 20 or newer; it does not include Unity, a
SideQuest SDK, or a private Node runtime. Launcher packages include their
platform's private runtime. See [setup commands](BUILD_TAURI.md#alternative-setup-scripts)
for the standalone route.

Tool profiles can expose `core`, `read`, `author`, `test`, `banter`, `shadergraph`, a comma-separated combination, `all`, or `none` for routing and health only.

## Manual Bridge Installation

The launcher installs the bridge automatically. For a manual setup, copy both files:

```text
unity-extension/Editor/BanterMCPBridge.cs
  -> YourProject/Assets/Editor/BanterMCPBridge.cs
unity-extension/Editor/CreatorWorksMCPLogo.png
  -> YourProject/Assets/Editor/CreatorWorksMCPLogo.png
```

After Unity compiles, call `get_bridge_status`. Scene-changing tools require an explicit acknowledgement from the selected Unity Editor and fail closed on stale or ambiguous object selectors.

## Release Status

Local candidate verification: **182 Node tests**, **21 native launcher tests**,
version synchronization, standalone protocol/reference smoke tests, Windows
installer packaging, and an npm audit with zero reported vulnerabilities.
The candidate bridge passed disposable Unity **2022.3.39f1** and
**6000.3.21f1** compile/command fixtures, including targeted property reads,
unchanged full-state snapshots, and isolated test-policy checks.

The [CI and release runs](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions)
record tagged packaging and platform results. Checksums cover all downloadable
packages. Candidate clean-install/upgrade acceptance, everyday large-project
editing, and end-to-end client token measurements remain testing gates before
stable release. The policy fixture is not a full Unity Test Runner session.

Shader Graph mutation remains experimental. Hosted Creator/Greenfield behavior,
headset behavior, multiplayer behavior, and project-specific gameplay require
separate runtime tests. Passing an Editor validator does not prove those results.

## AI-Generated Unity Examples

These project screenshots show scene hierarchy construction, configured Banter components, object references, and native Unity Visual Scripting graphs created through an AI client using Creator Works MCP.

![AI-generated portal scene and Visual Scripting graph](docs/images/ai-generated-banter-portal-graph.png)

*Generated portal scene, component setup, graph variables, and portal-state logic.*

![AI-generated portal-placement interaction](docs/images/ai-generated-banter-portal-placement.png)

*Generated portal-placement interaction with held events, object references, and native Visual Scripting logic.*

## Documentation

- [Feedback and feasibility process](FEEDBACK.md)
- [Bridge protocol](docs/bridge-protocol.md)
- [Compatibility matrix](docs/compatibility.md)
- [Tool groups](docs/tool-groups.md)
- [2.6.0 changes and upgrade guidance](docs/releases/2.6.0.md)
- [Token optimization evidence and next phase](docs/token-optimization-next-phase.md)
- [Banter custom Visual Scripting nodes](docs/banter-custom-visual-scripting-nodes.md)
- [SideQuest workflows](docs/banter-workflows.md)
- [Unity MCP benchmark](docs/unity-mcp-benchmark.md)
- [Future roadmap](docs/future-roadmap.md)
- [Creator/Banter SDK transition](docs/sidequest-sdk-transition.md)
- [Shader Graph experiment](docs/shader-graph-experiment.md)

## Legacy Release

Looking for the former **BANTWORKS MCP** name or old launcher layout? [Open the preserved v2.3.0 README](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/tree/v2.3.0#readme), from before the project became Creator Works MCP.

## Development

```powershell
git clone https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP.git
Set-Location CREATOR-WORKS-UNITY-MCP
npm ci
npm test
npm run measure:context
Set-Location launcher/src-tauri
cargo test
```

```bash
# Linux / macOS
git clone https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP.git
cd CREATOR-WORKS-UNITY-MCP
npm ci
npm test
(cd launcher/src-tauri && cargo test)
```

The Tauri launcher can be built locally on Windows (NSIS/MSI), Linux (`.deb`/`.rpm`/`.AppImage`), and macOS (DMG). Starting with 2.6.0-rc.1, the tagged workflow packages Windows NSIS, Linux, macOS, and the standalone ZIP, then consolidates checksums before publication. See [BUILD_TAURI.md](BUILD_TAURI.md) for host-specific toolchain setup. The cross-platform Node setup CLI configures Codex, Claude Code, Antigravity, and OpenCode; `./setup.sh` wraps it on Linux/macOS.

Thanks to [FireRat666](https://github.com/FireRat666) for the multiplatform and
unfiltered-test policy contributions in [PR #27](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/pull/27)
and [PR #28](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/pull/28).

See [FEEDBACK.md](FEEDBACK.md) to report problems or improvements, [CONTRIBUTING.md](CONTRIBUTING.md) for change requirements, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT. See [LICENSE](LICENSE). External research attribution and licensing notes are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
