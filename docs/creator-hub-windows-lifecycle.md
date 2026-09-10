# Windows Hub Lifecycle And Packaging

Unreleased MCP branch: `feature/creator-hub-compatibility`, version
`2.7.0-alpha.1`. This follow-up does not update installed MCPs, client configs
or Unity projects. Hub and Project Setup remain independent applications.

## Hosting Correction

The approved Hub product is **one window hosting the real installed apps**.
Tools retain independent files/settings and standalone fallback, but no separate
visible app window when hosted. This document describes package identity and
close protection, not an embedding mechanism or hosting compatibility proof.
See the [Setup-first hosting plan](creator-hub-compatibility.md#required-product-direction).

Hub setup asks **Update and add to Hub** for detected apps. Only approved apps
receive necessary compatibility updates/adoption. Compatible apps need no
reinstall but still require adoption consent. No apps found or Not now means
Hub-only installation, with existing files/settings/shortcuts/processes unchanged
and no missing companion installed automatically. Later adoption stays available.
Failed/cancelled updates never complete adoption, hide a standalone interface
or reroute its shortcut.

WM_CLOSE alone does not retain selection, forms or results. Do not use it as a
substitute for idle state-preserving handoff, or hide/close an app before the
hosted view is ready. Shortcut routing follows verified compatible adoption;
unsupported/failed Hub handoff must leave standalone access intact. The shared
native hosting contract is now applied in MCP's
[read-only preview](creator-hub-hosted-preview.md), without duplicating its UI
or disturbing client-owned stdio servers. Actual Hub/MCP acceptance and adoption
remain separate gates; the window-property protocol below does not cover the
no-window hosted backend. Hub owns the full native response-wait operation lease.

## Verified Public Package

Read-only inspection on 2026-09-10 downloaded the existing public
[v2.6.0 Windows installer](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.6.0),
matched its release digest, and extracted only the named launcher using 7-Zip.
Neither the downloaded installer nor its launcher was executed.

| Item | Bytes | SHA-256 |
| --- | ---: | --- |
| `Creator.Works.MCP_2.6.0_x64-setup.exe` | 26247422 | `11d6fc0fb95e33023a90a8722cf9234f82de6e175689bd915401bac3d49bc8c2` |
| Embedded `creator-works-mcp-launcher.exe` | 13279232 | `b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676` |

These are exact public artifact pins, not guesses from a local build or file
version. The standalone ZIP is the MCP server distribution, not the Windows
launcher installer. Download metadata is not general permission to execute
arbitrary URLs; Hub separately owns trusted descriptors and user consent.

## Installed Ownership

- Default current-user directory: `%LOCALAPPDATA%\Creator Works MCP`.
- Launcher: `creator-works-mcp-launcher.exe`; uninstaller: `uninstall.exe`.
- Runtime: `server\runtime\node.exe`; server: `server\creator-works-mcp.mjs`.
- Uninstall key: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Works MCP`.
  `InstallLocation` and `UninstallString` are quoted in the observed install.
- Tauri's location key: `HKCU\Software\Creator Works\Creator Works MCP`, default
  value. The generated current-user installer restores this previous location.
- Check both registry views and machine/user ownership before adoption. A
  custom path, competing registration, symlink/reparse redirection or unknown
  executable hash needs explicit review, not a second automatic installation.
- Legacy `%LOCALAPPDATA%\BANTWORKS MCP` and its separate `BANTWORKS MCP` uninstall
  registration may coexist. Never delete, migrate or adopt it by name alone.

The inspected current installation's launcher hash matched the public payload,
but its registry `DisplayVersion` was **2.5.1** while the PE version was **2.6.0**.
Registry version is therefore not sufficient execution identity. Its launcher
and three client-owned private Node processes were running during inspection;
no process was stopped or changed. Match a trusted artifact hash and owning
process/window, not just basename, title, PID or a version string. Hashes of a
launcher alone do not prove the rest of an installed server/runtime payload.

## Installer Arguments And Limits

[NSIS documents](https://nsis.sourceforge.io/Docs/Chapter3.html) case-sensitive
`/S` for silent mode and `/D=...` as the final, unquoted directory override.
Do not use `/D` to bypass an existing registered location.

The [Tauri CLI 2.9.6 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.9.6/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
also implements `/P` (passive), `/UPDATE` (update mode), `/R` (run after a
silent/passive install), `/ARGS` and `/NS`. These are source findings for that
template, not permission to pass arbitrary arguments. The public v2.6.0 CI
installed the floating npm `@tauri-apps/cli@v2`; its log did not establish the
exact resolved CLI version. This branch's observed local bundler is 2.9.6.

**Keep `installerProtocol: 0` and use an interactive, explicitly approved
installer flow. No silent-update safety claim is made.** In the reviewed
[upstream running-app macro](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.9.6/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh),
silent/passive mode can kill the running GUI. MCP's old preinstall hook only
checks the exact private Node executable path; it does not protect a busy GUI,
system-Node servers, pending Unity jobs, or a server that starts after checking.

The new source replaces that macro with fail-closed process refusal for both
its installer and generated uninstaller, with no process-kill call. The package
build validates the override against the expected macro name. Detection errors
also refuse. The Node-specific guard retains exit 10 for running and 11 for
detection failure; the new GUI refusal exits 10. Silent detection failures
have a default MessageBox response instead of waiting invisibly for input.

This **cannot alter an already-installed legacy uninstaller**. Tauri's upgrade
path can invoke it before the new preinstall hook, depending on installation
mode and choices. Do not treat the new macro, `/UPDATE`, or a process snapshot
as a transactional or race-free upgrade guarantee. No automatic rollback or
downgrade is provided. Legacy users close their tools themselves; Hub must
refuse busy/unknown states and report installation failures honestly.

## Native Close Protocol 1

The metadata flag is unchanged: seven JSON fields, `launch.standalone` only,
and the same early return before configuration or Tauri initialization.
`lifecycleProtocol: 1` is a separate trusted-descriptor capability for the
**guarded launcher close** behavior below, not an added metadata JSON field.
Old executables must not be probed with unknown command-line flags.

On Windows, the verified live `main` window exposes:

| Property | Value |
| --- | --- |
| `CreatorSuite.LifecycleProtocol` | `1` when the property set is available |
| `CreatorSuite.LauncherBusy` | `1` while app commands or a UI workflow are active, else `0` |
| `CreatorSuite.Closing` | `1` once an idle close has been accepted, else `0` |

These [Win32 properties](https://learn.microsoft.com/en-us/windows/win32/winmsg/about-window-properties)
are advisory snapshots, not authentication or an update reservation. Missing
protocol, failed reads, unresponsive window, unknown provenance, mismatched
HWND owner, multiple candidate windows or privilege/session mismatch means
unsupported/unknown. Hub must verify executable identity independently and
never send close messages merely because another window uses these names.

Every currently synchronous Tauri app command holds a native RAII guard through
completion and response generation. The frontend additionally acquires an
opaque native workflow receipt before startup/setup/settings/picker actions
and releases it only after the whole operation. This protects gaps between
commands and asynchronous file pickers. Wrong/duplicate receipts cannot release
an active workflow. No expiry timer silently declares an unfinished action idle.

`CloseRequested` and `ExitRequested` consult the same mutex-protected state.
Busy requests are refused; an idle close atomically prevents new operations
before accepting exit. A refused close reports a frontend status message when
the renderer is available. New async native commands require completion-lifetime
tracking, enforced by a source regression test; the current wrapper must not be
reused unchanged for deferred native work. A failed workflow release leaves the
UI and native guard locked instead of falsely reporting idle.

Hub may send bounded `WM_CLOSE` only after explicit user approval, then wait for
the verified process to exit. Refusal/timeout must not escalate to termination.
Window messages are still subject to Windows privilege and session rules.

## Separate Gates

- Client-owned MCP stdio servers are not launcher children. GUI close must
  never stop them or the AI clients. The new guard does not inspect their calls.
- Unity commands may outlive the launcher or server. Launcher busy=0 is not
  Unity/project quiescence, and missing process data is not proof of idle.
- Server/project status is **unknown to this protocol**. Hub must independently
  establish its update prerequisites; unknown blocks update.
- Single-instance, concurrent cold starts, existing-window focus and reopening
  after an update remain separate work. `lifecycleProtocol: 1` promises none of
  these, and `launch.singleInstance` is not advertised.
- Hosting readiness, shortcut adoption, one visible Hub window and retention
  of selection/forms/results are required acceptance gates, not optional later
  features. Close protocol 1 advertises none of them. Test busy switching,
  backend failure, offline use, Hub removal and standalone fallback without
  resetting setup or reconnecting healthy clients.
- Never force-close Unity, AI clients, or a busy MCP launcher; never auto-install
  or rewrite project/client configuration just to make Hub adoption succeed.

## Validation

```powershell
npm test
cargo test --locked --manifest-path launcher/src-tauri/Cargo.toml
cargo run --locked --manifest-path launcher/src-tauri/Cargo.toml --example lifecycle-smoke
```

Observed locally: 210 Node and 32 Rust tests passed, including wrong receipts,
command/workflow overlap, poisoned-state refusal, 64 close/start races and real
hidden Win32 property publish/cleanup. Browser tests cover five menu items,
keyboard/dismissal/reduced motion, 320-900px widths, long names and operation
acquire/refusal/release behavior.

The isolated native Tauri fixture loads **about:blank**, no plugins/configuration
handlers and a unique temporary WebView data directory. It uses the production
close/exit hooks and verifies busy workflow WM_CLOSE refusal, busy AppHandle.exit
refusal, busy command WM_CLOSE refusal, then successful idle WM_CLOSE exit.
Its first launch failed before main because Cargo examples lacked Tauri's
bin-only Common Controls v6 manifest; PE resources/imports identified the cause,
and example-only resource linking corrected it. No production runtime workaround
was added. No normal installed MCP GUI, installer, Unity or AI client is launched
by this fixture. This is not full install/update/restart acceptance.

The new NSIS package was built, not installed. The main release executable's
metadata-only smoke passed after packaging: 190 bytes, two success/nine invalid
requests, unchanged temporary fixture and watched config stat metadata. It is
distinct from native close testing and does not probe a legacy executable.

## Descriptor Publication Still Required

Hub owns download/install orchestration and its pinned Minisign verification
key. A future approved MCP release pipeline must publish a signed descriptor
for the **exact** installer and its extracted launcher: version/channel,
platform/architecture, bytes, SHA-256, relative entrypoint, identity protocol
and scoped lifecycle protocol. Sign only after packaging; do not use a portable
build's hash for an installer payload. Secrets/private signing keys stay outside
repositories and artifacts. Public release metadata alone is not authority to
execute an arbitrary downloaded file.

This branch does not publish that descriptor or change the release pipeline,
merge main, tag a release, install the app or update client configurations.
Native installer install/update/restart acceptance still needs an isolated
Windows VM or an explicitly approved test installation. No transactional
rollback, full server/project quiescence or single-instance proof is implied.
Do not advertise hosting readiness in descriptors until the agreed shared
contract and one-window acceptance are verified in that exact artifact. The
current standalone-launch preview does not meet this product requirement.
