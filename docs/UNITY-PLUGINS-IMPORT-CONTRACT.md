# Optional Unity Creator Plugins Helper

Development source only. No real project or installed app is modified by adding
this folder to the MCP repository. Shared desktop project selection, helper
installation and queue/status actions are integrated in the development branch.
The alpha.2 candidate enables these actions as experimental, with explicit
project consent and Unity import review. Hosted MCP transport does not expose
these commands. See [current validation](UNITY-PLUGINS-ALPHA2-VALIDATION.md)
for tested behavior and remaining acceptance limits.

## Installation

Copy the exact contents of `launcher/unity/com.creatorworks.plugins` into the
selected project's `Packages/com.creatorworks.plugins` as an atomic new directory.
Include `LICENSE.md`, the repository MIT notice, alongside the three package
source/metadata files when installing or redistributing this helper.
Never merge with or overwrite an existing package. Installing the helper needs
explicit consent: its Editor code will compile and run when Unity loads it.
The desktop installer should refuse installation while that project is open.

The package is Editor-only, requires Unity 2022.3 or newer, and has no Creator SDK,
Banter, MCP bridge, or third-party package dependencies. Its menu entry is
`Creator Plugins/Browse`. There are no runtime components or scene-save calls.

## Queue Contract

Verified `.unitypackage` bytes live outside Assets at:

```text
<project>/.creator-plugins/packages/<sha256>.unitypackage
<project>/.creator-plugins/inbox/<requestId>.json
<project>/.creator-plugins/receipts/<requestId>.json
```

The request JSON contains `schemaVersion: 1`, `requestId`, `projectPath`,
`packageId`, `version`, `name`, `byteLength`, `sha256`, and `packageFile`.
Request IDs are exactly 32 lowercase hex characters. Checksums are exactly 64
lowercase hex characters; `packageFile` must equal that checksum plus
`.unitypackage`. `projectPath` must identify the current Unity project, and the
package length must be positive and at most 32 MiB. Cache paths cannot escape the
project's `.creator-plugins` directory or use existing symbolic links/junctions.

Metadata polling happens only while the window is open, at most once per five
seconds when the Editor is not compiling, updating or entering/running Play mode.
It reads at most 100 requests (16 KiB per JSON document). It does not hash package
files or traverse scenes during polling. Polling never writes receipts. A valid
inbox request without active tracking or a final receipt is `queued`; that is not
package-integrity or import proof.

Status responses contain `schemaVersion`, `requestId`, `status`, and `message`.
Only terminal outcomes are persisted as receipts, exactly once:

- `queued`: request metadata accepted; waiting for the user.
- `review`: derived from a validated `active-review.json` with the full matching
  request identity. No completion is inferred from `ImportPackage` returning or
  its started callback.
- `imported`: a matching Unity completion callback arrived. This says nothing
  about compilation, correct references, gameplay, frame rate or headset behavior.
- `cancelled`: a matching Unity cancellation callback arrived.
- `failed`: an explicit failure, or the user cleared an unconfirmed outcome.
  The message distinguishes those cases; clearing never undoes files or retries.

Only the user's Review import action can call
`AssetDatabase.ImportPackage(packagePath, true)`. It displays a code-safety warning
first, then validates the request and hashes/locks the cached bytes before opening
Unity's file-selection dialog. No scenes are opened or saved. Unity's selected
assets can be replaced only through the user's interactive import decision.

An `active-review.json` journal preserves a pending review across domain reload
or restart. An unresolved review is not replayed. The helper correlates callback
names to the checksum-based package basename and ignores unrelated callbacks.
The final receipt is published with a no-overwrite save before active tracking
is removed. A durable terminal receipt wins over leftover active tracking. The
helper never replaces an existing receipt. Older development `queued`/`review`
receipt files, malformed state and changed identities fail closed and are
preserved, not migrated or retried automatically.

The 2026-09-14 interactive test caught a Windows receipt-replacement failure;
the write-once correction removes that replacement operation. Subsequent real
cancel/text/C#-reload tests passed on Unity 2022.3 and Unity 6; their exact helper
identity and the later candidate changes are recorded in the validation report.
Simulated callbacks alone are not native import acceptance.

## Catalogue

The window reads the fixed SideQuest Creator Community index and listing paths.
There are no embedded contribution entries or automatic imports. It supports
categories, search, contributor credit, bounded PNG/JPEG previews, details,
licence/source links, and explicit downloads to the same external queue.

Pending entries are not downloadable. Catalogue freshness expires after 180
seconds. Index/listing/package/image byte limits, HTTPS host restrictions,
image-dimension limits and checksum checks are enforced. The first Editor pass
refuses redirects rather than forwarding to an unvalidated location; ZIP imports
are not supported. Desktop downloading remains the route for approved packages
whose hosting requires redirects. A checksum is not a code-safety certification.

## Existing MCP Routes

`execute_editor_menu_item` can open `Creator Plugins/Browse` once installed.
Its existing dirty-scene, Play mode, compilation and update guards remain.
It returns a correlated menu-execution result and optional Editor settling check,
not an import-completion receipt. Built-in menu roots such as `Assets` are blocked.

The current bridge subscribes to `importPackageCompleted` and `importPackageFailed`
only to export global import status. It has no `AssetDatabase.ImportPackage`
command, request correlation, or cancellation handling suitable for this queue.
No bridge routes or existing Unity project files were changed for this helper.

## Verification

`scripts/check-unity-plugins.ps1` compiles against installed Unity 2022.3.39f1 and
6000.3.21f1 assemblies with warnings as errors (only expected JSON field CS0649
is suppressed), then runs pure file/identity checks for each version.

`scripts/smoke-unity-plugins-editor.ps1` creates a new disposable project, loads
the real embedded package, and runs native JsonUtility/queue checks. A second
Editor process validates persistent review recovery and simulated callback
routing. The fixture deliberately never calls `ImportPackage`. Native dialog,
visual layout, real callback and actual package-import acceptance remain separate.

API reference: [Unity ImportPackage](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/AssetDatabase.ImportPackage.html).
`interactive: true` opens Unity's review dialog; the method has no completion
return value. [DownloadHandlerScript](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Networking.DownloadHandlerScript.html)
provides the bounded byte receiver used by the helper.
