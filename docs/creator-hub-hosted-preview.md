# MCP Hosted Preview

Unreleased Windows x64 development slice on `feature/creator-hub-compatibility`,
version `2.7.0-alpha.1`. Not an installer or a production Hub capability.
Hub owns host verification, iframe isolation, app routing and adoption. MCP
preserves the read-only preview v1 contract and adds a separately authorized
revision-2 writable candidate below. Native writable acceptance is pending.
The independent Node MCP server protocol is unchanged.

## What Is Implemented

- `launcher/src/runtime.js` delegates standalone invoke, events, folder dialogs
  and external links to existing Tauri APIs. No fake Tauri globals or second UI.
- In a frame it waits for an explicit parent `creator-host-connect` message,
  protocol 1, with one transferred MessagePort. Frame presence alone does not
  hide chrome or authorize native operations. This is a transport handshake,
  not publisher authentication; the native host boundary remains essential.
- In read-only mode the real launcher UI appears with its configuration controls disabled.
  It reads saved settings, marks SDK/client/bridge state **Not checked**, and
  offers a refresh and native folder picker. Picking a folder does not add or
  change a project. Host navigation must preserve this frame rather than reload it.
- In read-only mode no normal startup, migration, project scan, update fetch, client configuration,
  Unity operation, bridge update, installation or shortcut change runs in preview.
- Requests serialize, with at most 16 pending plus one reserved workflow-finish
  slot and a 60,000-byte frontend limit. Project badge reads are bounded rather
  than enqueueing every project at once.
  Disconnect rejects pending requests and locks the preview. Commands are never
  retried automatically; a lost response does not mean successful cancellation.

## Native Contract

The exact `--creator-hub-host` flag is distinct from `--creator-hub-info`.
Malformed/combined flags fail before startup. Identity is still schema 1 with
only `launch.standalone`; do not probe older executables with guessed flags.

Native hosting requires inherited stdin/stdout pipes, makes stdio handles
non-inheritable and checks the actual parent executable path. Its filename must
be `creator-hub.exe`. **The name/path is only a routing check, not proof of a
trusted publisher.** A native confirmation names the host and describes the
read-only scope. Host consent is per session, not persisted enrollment.

MCP creates its own Tauri AppHandle with no WebView/window, using its own assets
and resource context. `Assets::get` decodes embedded release assets before base64
transfer; iterating packed bytes alone is incorrect. No TCP service is added.

Newline-delimited request fields: `protocol: 1`, 64-hex-character `session`,
increasing safe integer `id`, `command`, and object `args`. Initialization uses
ID 0, command `initialize`, empty args. Unknown fields, incomplete/oversized
frames, wrong sessions and replayed IDs fail closed. Native requests are bounded
to 64 KiB and responses to 2 MiB, including the newline.

Replies contain `session`, `id`, `ok` and `result` or `error`. Successful initialize
returns exactly `appId: creator-works-mcp`, `version`, `protocol: 1` and `files`.
Initialization does not load configuration. Empty-args preview v1 emits no
backend events and preserves that exact reply shape.

| Command | Arguments | Result / Side Effects |
| --- | --- | --- |
| `get_hosted_snapshot` | `{}` | `config` or null, `source`, `readOnly: true`, `resourceDir`. Existing current config wins; legacy is read only if current is absent. No migration/repair/default file. |
| `pick_project_folder` | `{}` | Native selected folder string or null. No persistent setting or filesystem write. |
| `open_official_url` | `{url}` | Opens fixed official links or exact official MCP stable release tag pages. No arbitrary URL/file/executable. |

Saved configuration reads are capped at 256 KiB and 256 projects. Invalid,
unreadable or oversized current data fails visibly, rather than falling back
to older data or overwriting it. The parsed config omits unknown fields from
the response while leaving the original file unchanged.

The native lifecycle guard covers dispatch through command completion. Hub must
hold its own operation lease for the entire response wait. The backend completes
accepted work before checking EOF; it never kills Unity or client-owned servers.
MCP's frontend workflow begin/finish commands are deliberately not available in
this read-only pipe allowlist.

## Revision-2 Lifecycle Preparation

Explicit initialization args `{hostingRevision: 2, requestedMode: "read-only"}`
add `hostingRevision: 2` and `effectiveMode: "read-only"` to the initialize reply.
Unknown revisions/modes and extra args are refused before consent or dispatch.
Writable mode requires the additional checks below. This is not an advertised production capability;
the immutable older preview artifact remains unchanged.

Only that negotiated mode emits native frames named `creator-mcp-lifecycle`:

```json
{"type":"event","name":"creator-mcp-lifecycle","session":"<64 hex characters>","payload":{"revision":1,"sequence":0,"state":"idle","workflowActive":false,"commandsInFlight":0}}
```

Events are at most 512 UTF-8 bytes including newline. Sequence is monotonic and
bounded to JavaScript's safe integer range. State is `idle`, `busy` or `draining`;
the in-flight count refers to accepted serialized hosted requests. Initial idle,
pre-dispatch busy, post-reply idle and final drained-on-EOF frames are emitted
(when the output pipe remains writable). A failed busy-frame
write prevents invocation; lost output after a handler returns never replays it.

The native session controller owns any workflow receipt across commands and
rejects foreign/stale finish receipts. Disconnection refuses new work, drains
the already-accepted synchronous request, then releases only its owned workflow.
Its last 16 in-memory records distinguish a returned Rust `Result::Ok` from an
error or unwound handler. They do not establish success of nested/asynchronous
operations and are **not durable crash recovery or a full result handoff**.
The writable candidate adds a separate bounded persistent journal for operations
that can change settings. These records still describe handler return, not the
success of nested operations or Unity runtime acceptance.

Compatible standalone Windows GUIs reserve an exclusive `launcher-gui.lock`
handle in the current user's settings directory before building the writable
UI. File identity handles case/path aliases; Windows denies replacement while
owned, and normal handle release permits reopening. The marker is not deleted
or truncated. Metadata and read-only hosting bypass acquisition entirely.
Older launchers lacking this lock are explicitly outside that guarantee.

Hub must reserve its own workflow guard **before** forwarding begin, hold it
across native replies and command gaps, and never unlock solely from a child
idle event. Signed descriptor revision/modes, verified host identity, explicit
consent and acknowledged form/result transfer remain required before full
installed-app adoption can be enabled. Legacy GUIs that do not cooperate with
ownership locks remain outside the exclusive-ownership guarantee.

## Writable Candidate

Only an explicitly paired Hub build requests `{hostingRevision: 2,
requestedMode: "writable"}`. Native MCP consent identifies the actual parent
image by path and SHA-256 and describes settings/client/bridge authority. Its
image handle remains locked throughout the session. A fingerprint is not a
publisher signature or persistent adoption. Declining retains standalone access.

The backend then verifies and locks its own compiled-in server, private Node,
bridge and logo hashes and acquires the current-user GUI ownership lock. Hosted
resource resolution cannot fall back to a development checkout or old bundle.
The same app handlers implement setup, project selection, client configuration,
bridge updates and optional feedback. Mutating/migrating calls require a native
workflow; only its session can finish it. Normal startup can migrate launcher
settings, as it does in standalone mode. Read-only initialization never does.

Hub reserves its operation guard before begin and retains it through replies,
workflow gaps and transport failure until the real backend exits. Child idle
events cannot release it. The frontend locks on disconnect and never replays a
command. The local `hosted-operation-outcomes.json` retains at most 32 command
identities/outcomes, without arguments, results or credentials. Accepted writes
are recorded before dispatch and returned outcomes before replies. An incomplete
record requires an explicit warning acknowledgement at the next writable start;
acknowledgement does not label the prior action successful or roll it back.

Update metadata comes from Hub's fixed, bounded official stable-release request.
The sandbox retains `connect-src 'none'`, no Tauri globals, and no installer
authority. Read-only mode cannot use the added commands. Ordinary standalone
updates and public links remain available without Hub.

## Verification And Remaining Gates

- Node adapter tests: standalone argument/result fidelity; handshake source and
  version; queue/UTF-8 bounds; unsupported operations; event unsubscribe;
  connection failure; stale replies; disconnect and no automatic replay.
- Rust tests: static identity, protocol/consent boundaries, command ordering,
  rejected mutations/replays, output limits, lost output, decoded bundled assets,
  and unchanged/missing/legacy/malformed configuration fixtures.
- `scripts/smoke-launcher-ui.mjs`: existing standalone browser regression suite.
- `scripts/smoke-hosted-mcp-ui.mjs`: actual UI assets in a sandboxed opaque-origin
  iframe, mocked native results, 900/560/390/320 widths, long names, disabled
  mutations, hidden-frame picker completion and disconnect recovery behavior.
- `scripts/smoke-creator-hub-info.mjs`: hash-identified Windows release metadata,
  malformed flags and unauthorized host rejection before GUI/config startup.

Local screenshots/reports are under `artifacts/hosted-mcp-ui` and
`artifacts/launcher-ui`. Browser mocks and in-memory protocol tests do **not**
prove the actual Hub/MCP process pair. Hub must add the exact tested MCP hash and
native command/session routing, then verify native consent, snapshot/resource
ownership, picker, busy close refusal and clean idle shutdown.

Still outside verified acceptance: real writable native workflow tests, broad
adversarial native iframe tests, full crash recovery, single-instance routing,
live standalone state transfer, adoption/shortcut changes, server quiescence,
silent update guarantees and macOS/Linux hosting. Do not label this ready for
general Hub use or publish a production hosting descriptor yet.
