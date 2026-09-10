# Third-Party Notices and Research Attribution

## Code and Dependencies

No Unity-owned MCP code or relay binaries are copied, vendored, or linked into this repository. The hybrid bridge changes were independently authored against Creator Works MCP's existing command contracts and public platform APIs.

The Node dependency graph is tracked in `package-lock.json`; its direct runtime MCP dependency is `@modelcontextprotocol/sdk`. The release bundle is produced with [esbuild](https://github.com/evanw/esbuild), which is MIT-licensed. Review locked package metadata and licenses when redistributing a bundled build.

The Windows launcher bundles the unmodified official Node.js 24.17.0 Windows x64 executable so MCP clients do not require a separate Node.js installation. Node.js is distributed under the MIT license and includes third-party software under the terms recorded in the `LICENSE` file packaged beside the runtime. The release build verifies both the official archive and extracted executable with pinned SHA-256 checksums before packaging.

The Windows launcher uses [Tauri](https://github.com/tauri-apps/tauri), distributed under Apache-2.0 and MIT terms. GitHub release packaging uses the official [Tauri Action](https://github.com/tauri-apps/tauri-action); the action is CI infrastructure and is not shipped in the application.

## Launcher Icons

The app switcher's `external-link` SVG is an unmodified asset from
[Lucide](https://github.com/lucide-icons/lucide), `lucide-static` 1.44.0. Lucide
uses ISC terms; this Feather-derived icon also carries the upstream MIT notice.
The complete notice is included at `launcher/src/icons/LICENSE-lucide` alongside
the assets. No icon runtime dependency is added. The cube bitmap remains the
existing Creator Works logo.

## Unity MCP Research

The following MIT-licensed projects were reviewed for public documentation, installation verification, focused-tool design, testing, and client-configuration ideas:

- [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) - client configuration, focused tool catalogue, security policy, and CI/release documentation patterns.
- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) - multi-client configuration examples and MCP Inspector verification workflow.
- [ozankasikci/unity-editor-mcp](https://github.com/ozankasikci/unity-editor-mcp) - connection-verification and editor automation documentation patterns.

The research informed this repository's `get_bridge_status` tool, connection-verification documentation, CI, security policy, contribution guidance, and static core-by-default capability profile. The CoplayDev tool-group documentation was reviewed again on 2026-09-08 for prompt-economy comparison. Creator Works uses its own existing TypeScript profile implementation and does not include third-party source, assets, schemas, or generated data.

On 2026-09-08, Unity's public CLI/Pipeline documentation was reviewed for the
official `unity mcp` integration and documented project-side `[CliCommand]`
extension surface. It is cited as an interoperability target only. No Unity CLI,
Pipeline, Assistant, or MCP source is copied or redistributed.

The September 8 follow-up also cites Unity's
[Assistant MCP Extensions contract](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.19/manual/integration/mcp-configure.html)
and the user-supplied [Creator SDK registry](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk).
They inform optional integration and setup plans only. No SDK archive was
downloaded or redistributed. Registry metadata did not establish license terms;
redistribution requires a separate license review.

The public [Meta XR Unity MCP Extension](https://github.com/meta-quest/Unity-MCP-Extensions)
was reviewed as evidence that Unity's AI MCP package can be extended by a Unity
package. It is governed by the Oculus/Meta Platform Technologies SDK license,
not a general permissive open-source license. No code, schemas, assets, or
package metadata from it are included.

On 2026-07-29, Unity's official `com.unity.ai.assistant` MCP documentation and package metadata were reviewed for protocol versioning, local relay architecture, explicit Editor targeting, capability discovery, and main-thread Unity API boundaries. The Unity package is distributed under Unity's Terms of Service rather than an open-source licence. Creator Works MCP does not redistribute or derive code from that package.

[yecats/unity-mcp-toolkit](https://github.com/yecats/unity-mcp-toolkit), released under CC0 1.0 Universal, was also evaluated for optional settings, Scene View, Input System, Recorder, and domain-refresh tools. No toolkit code is included in version 2.2.0; those tools will be added only where they justify their maintenance and runtime surface.

On 2026-08-24, [AnkleBreaker-Studio/unity-mcp-plugin](https://github.com/AnkleBreaker-Studio/unity-mcp-plugin) was reviewed as a behavioral research reference for Shader Graph workflows and published failure modes. Its custom AnkleBreaker Open License v1.0 requires visible attribution and restricts commercial distribution of the software and derivatives. No source, assets, schemas, or serialized data from that repository were copied into Creator Works MCP. The implementation here was independently authored against the installed Unity package APIs and official Unity documentation.

[AlexeyPerov/Unity-Open-MCP](https://github.com/AlexeyPerov/Unity-Open-MCP), released under the MIT license, was also reviewed at commit `961fae1c4f1cb51046397a3fb6c06b522f094689` for extension discovery and fail-closed optional-package ideas. No source was imported. Its public Shader Graph behavior helped define independent negative tests around reflection availability, asset detection, and validation.

Unity's public Shader Graph documentation and locally installed package source were consulted to identify the GraphData, FileUtilities, MultiJson, target, block, node, slot, and importer contracts. Unity package source is governed by the Unity Companion License. No Unity source is redistributed; Creator Works calls the user's installed package through a version-checked reflection adapter.

## Deliberate Non-Adoptions

Remote WebSocket/HTTP listeners and arbitrary C# execution appear in parts of the broader Unity MCP ecosystem. They are not adopted here because Creator Works MCP is intentionally local and project-scoped, and those capabilities need a separate authentication and authorization design.
