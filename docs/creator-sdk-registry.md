# Creator SDK Registry Reference

Checked on 2026-09-08 using the registry's public JSON metadata endpoint. This
is a source for future SDK setup and compatibility work, not an installation
instruction or a claim that this version has passed Creator Works acceptance.

- [Package page supplied by the user](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk)
- [Machine-readable package metadata](https://greenfield-registry.sdq.st/com.sidequest.creator-sdk)

## Observed Metadata

| Field | Value at review time |
| --- | --- |
| Package | `com.sidequest.creator-sdk` |
| Display name | SideQuest Creator SDK |
| `latest` tag | `4.0.14` |
| Publication date | 2026-09-03 |
| Declared `unity` field | `6000.3` |
| Visual Scripting dependency | `com.unity.visualscripting: 1.9.1` |
| URP dependency | `com.unity.render-pipelines.universal: 17.4.0` |

The metadata also declares Basis bundle-management/common/SDK packages,
`com.sidequest.ora`, and Unity XR/Input packages. Its package description names
Altspace and other targets. These declarations do not prove that every target
or dependency combination compiles or behaves correctly.

## Use in the Broader Project

1. Future setup should retrieve metadata on explicit request and pin a chosen
   version. Never silently upgrade a project to a moving `latest` tag.
2. Resolve the full dependency graph and registry scopes before editing the
   manifest; preserve unrelated registries, package pins, and lock data.
3. Verify the published distribution integrity before using a downloaded package.
4. Inspect the exact package's component/node types and validator contract. Do
   not infer new BS mappings or compatibility from its name/version alone.
5. Import and compile in a disposable project, then run graph and SDK checks.
   Hosted/Quest/multiplayer acceptance remains separate.

The returned metadata has no `license`, `repository`, or `homepage` value.
That is missing licensing evidence, not proof of unrestricted reuse. Inspect
the package's license and obtain appropriate permission before redistribution.
No package archive or SDK source was downloaded, copied, or installed in this
review. No registry request has been added to MCP startup or normal tool calls.
