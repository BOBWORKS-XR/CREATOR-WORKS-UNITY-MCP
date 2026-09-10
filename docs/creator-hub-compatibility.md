# Creator Hub Compatibility Foundation

Unreleased source: `2.7.0-alpha.1`, branch `feature/creator-hub-compatibility`.
This does not change the existing public 2.6.0 downloads or require Creator Hub.
The [shared Creator Hub plan](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md)
owns the wider product and distribution scope. First-launch SDK assistance
belongs in Hub, not another MCP companion prompt.

## Read-Only Identity

Invoke the trusted next-version launcher executable with exactly one argument:

```text
--creator-hub-info
```

It returns one compact JSON object plus newline and exits 0, before Tauri,
renderer setup, configuration migration, network checks or project discovery.
The module contains only argument classification, static build metadata and
bounded stdout/stderr handling. It adds no dependency or MCP tool.

Example Windows x64 response:

```json
{"schemaVersion":1,"appId":"creator-works-mcp","displayName":"Creator Works MCP","version":"2.7.0-alpha.1","platform":"windows","architecture":"x86_64","capabilities":["launch.standalone"]}
```

- `version` comes from Cargo package metadata and follows the repository's
  version-sync check. Platform/architecture describe the executable target.
- Schema 1 platform values: `windows`, `macos`, `linux`; initial architecture
  values: `x86_64`, `aarch64`. Unsupported targets fail without GUI startup.
- The exact flag with extra arguments, unknown `--creator-hub...` options,
  duplicate flags, equals values and incorrect casing fail with exit 2 and
  empty stdout. Errors are fixed bounded messages on stderr, never argument
  echoes. Output failure exits 1. No output path or operation is accepted.
- No arguments, or ordinary non-Hub arguments, keep the pre-existing standalone
  GUI path. Those arguments do not become project routes, repairs or commands.
- Capture both streams with a timeout and a 4 KiB combined limit. Reject
  malformed JSON, unsupported schema/target, multiple objects or failure exit.
  Identity describes the probed file, not an already-running GUI's version,
  active project, operation state, or permission to replace files.

**Do not probe legacy releases.** Current 2.6.0 has no argument dispatcher and
can start its GUI for an unknown flag. Hub must first verify an approved
artifact's provenance and a trusted release descriptor advertising
`identityProtocol: 1`. Do not infer support from an executable name or version
guess; failed probes must never fall back to ordinary launch.

## Lifecycle Boundary

Only `launch.standalone` is advertised. Repeated Open/focus, simultaneous cold
starts, blocked GUI behavior, different privileges/sessions and close-during-
operation semantics are not established by identity support.

The official Tauri single-instance plugin was evaluated, but no plugin or
custom IPC implementation is included. Its reviewed Windows mutex/message-window
initialization and synchronous forwarding require focused native lifecycle
testing. A short-lived startup guard alone does not prove blocked-GUI behavior.
Single-instance work was therefore deferred by agreement with the Setup task.

Closing the MCP launcher does not prove that its private Node server runtime
has stopped: AI clients can still own those processes. Preserve the existing
installer checks and manual consent. Hub must not replace a running app/server,
force-close clients/Unity, rewrite routes/configuration, or treat metadata
success as an idle/update-safe receipt. No idle or updater contract is added.

## Validation

```powershell
npm ci
npm test
npm run check:version
npm run release:launcher
cargo test --locked --manifest-path launcher/src-tauri/Cargo.toml
cargo build --release --locked --manifest-path launcher/src-tauri/Cargo.toml
$binary = (Resolve-Path './launcher/src-tauri/target/release/creator-works-mcp-launcher.exe').Path
$hash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
node ./scripts/smoke-creator-hub-info.mjs $binary $hash
```

The smoke requires an explicitly hash-identified build and verifies the Windows
PE GUI subsystem, not just a console/debug binary. It runs two successful
metadata probes and nine invalid-input probes with bounded piped output and
timeouts, checks exact JSON fields/values and unchanged temporary fixtures.
It does not open the normal GUI or test an old installed launcher.

Windows known-folder APIs can ignore environment-variable isolation. The
unchanged temporary fixture is not, by itself, proof about all user folders;
the early-return/source and pure module tests are also required. No claims of
native macOS/Linux process acceptance or normal GUI lifecycle follow from the
Windows metadata tests. Windows CI also builds and probes the real release EXE.

Observed locally on Windows x64, 2026-09-10:

- 198 Node tests and 27 Rust tests passed, including new metadata/source guards.
- Optimized GUI-subsystem EXE: 190-byte metadata line, two successful probes,
  nine rejected probes, unchanged temporary fixture and watched configuration
  file stat metadata. This is not a content-hash audit of all user files.
- Version sync, `cargo fmt --check` and existing bundled MCP smoke passed.
  Core/Full tool schemas remain 25 / 23,172 bytes and 53 / 48,613 bytes.
- Strict Clippy (`-D warnings`) reports the unchanged eight-argument
  `one_click_setup` API's `too_many_arguments` lint, also present in the base
  source. A rerun allowing only that lint passed. No source-level lint
  suppression or unrelated setup refactor was added.
- No Unity Editor or normal launcher GUI was started. The Unity bridge change
  is its synchronized version constant only; Unity runtime acceptance was not
  performed. No installer was built, installed or swapped.

## Standalone Launcher UI

The next-version UI follows the shared Creator Project Setup/Hub visual spec:
neutral `#090b0d` background, `#111518` / `#181d21` surfaces, `#293137` borders,
`#edf1f3` text, `#9ba7af` secondary text, cyan/red accents and Segoe UI/Arial.
The final shared alignment uses a 72px header, 19px title, 13px body and 15px
section headings. The original bitmap is unchanged (SHA-256
`f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7`).

- One fixed left-attached drawer frame at x=-1/y=12: 55x48 collapsed,
  224x294 expanded, limited to viewport height minus 24px. The 54x46 logo
  button slides to the right as the frame expands and toggles it closed.
  There is no separate floating menu, close X or "Creator apps" heading.
- Width/height morph over 220ms; content reveals inside the frame below its
  48px header. The two-line 12px branded title stays within 144px to the left
  of the logo. The main page title/subtitle fade while open, without resizing
  the page. A subtle scrim dims the rest of the app; click-away consumes the
  complete gesture before closing, never invoking a button underneath.
- Cube marks use lower-right H/M/P identifiers, not notifications. Hub uses a
  shared three-face gray isometric cube backplate, with the original cyan/red
  bitmap centered at 22px and H badge outside. The CSS backplate is original
  geometry, not the Unity logo. There are no hamburger lines or first-run hero.
- Creator Hub opens only the [public plan](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md)
  and is labeled in development. Setup opens its [public releases](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases).
  MCP is current; URP Converter is non-actionable and labeled coming soon.
- No executable discovery/launch, hosted-mode inference, URL-parameter mode,
  installation prompt, automatic installation or new configuration key exists.
  Standalone chrome remains; any future hosted suppression needs explicit host
  context. The native identity flag and capability list are unchanged.
- Keyboard menu navigation includes arrows, Home/End, Enter/Space, Escape and
  Tab; logo/outside/focus dismissal and focus return are tested. Closed menu
  content becomes inert and aria-hidden immediately, before the closing fade
  finishes. Focus never scrolls the outer frame/page during animation; only
  the menu scrolls for short viewports. Reduced motion disables transitions.
  Project selection is a native button, not a mouse-only row.
- A disabled ancestor fieldset prevents conflicting project/client/preference
  changes during an operation, including controls rendered while busy. Each
  control's own unavailable/consent state survives unlocking. Editing the
  selected path invalidates old readiness until a fresh check returns; stale
  and out-of-order readiness responses cannot enable setup for another target.
- Existing capabilities, client choices, privacy/consent and manual-install
  text remain. SDK/bridge badges wrap instead of disappearing on narrow screens.

Browser smoke (requires an existing Playwright installation and browser):

```powershell
# Optional: absolute path to an existing Playwright package; otherwise resolves locally.
$env:PLAYWRIGHT_MODULE = 'C:\Tools\node_modules\playwright'
# Optional: use installed Chrome with a temporary, isolated browser profile.
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node scripts/smoke-launcher-ui.mjs
```

The script starts a temporary loopback-only fixture server and mocks every Tauri
command. Other network requests are blocked. Server/browser close on success or
failure; it never runs the launcher or invokes actual project/client setup.
Screenshots and `results.json` are written under `artifacts/launcher-ui/`.
Viewport coverage: 900x700, 640x600, minimum desktop 560x600, 390x844 and 320x700,
including long unbroken project names, long SDK labels and expanded Advanced.

The initial smoke hit a test-only missing bundled Chromium executable; using
an existing Chrome installation resolved it without adding dependencies. One
outside-click assertion targeted content under the open menu and was corrected.
The narrow-label test caught real badge overflow; wrapping now passes. These
browser checks do not prove native WebView2 integration or real installation.

Initial UI-pass verification on Windows, 2026-09-10: 203 Node tests and 27 Rust
tests passed. Browser smoke passed all listed viewports, keyboard project
selection, public-link failures, picker cancellation, duplicate suppression,
operation success/failure recovery and delayed/invalid readiness. Version sync
and Rust formatting passed. Native metadata acceptance remains a separate
test from the mocked browser UI, not proof of safe installation or updating.

The subsequent morphing-drawer pass has 204 Node tests. Browser checks also
capture natural intermediate animation frames, rapid transition reversal,
stable page/frame geometry, immediate inert focus protection, a 560x240 short
window and reduced-motion styles. Clicking over Set Up or Update Bridges while
the drawer is open dismisses it without invoking either operation. Screenshots
wait for final width and height, not just visibility. `motion-results.json`
records intermediate measurements; `drawer-midmotion.png` pauses real CSS
transitions for an inspectable intermediate frame.

The subsequent Hub-mark-only visual revision has 205 Node tests. The browser
fixture verifies the square border/background is absent, the three flat gray
cube faces render behind the unchanged 22px bitmap, and the outside H badge
remains above both. All drawer motion, dismissal and operation-lock checks
still pass; MCP and Project Setup marks are unchanged.

## Before Release Or Hub Adoption

1. Review the next-version diff and platform CI. Recheck packaged executables,
   Windows release-subsystem stdout, macOS app entrypoint and Linux packaging.
   Keep current public tags/assets immutable; alpha is not a stable release.
2. Publish an explicitly approved compatible release descriptor: app ID,
   `identityProtocol: 1`, SemVer/channel, platform/architecture, exact artifact
   bytes/SHA-256, HTTPS release/download URLs, package kind and relative
   executable entrypoint. Do not advertise nonexistent downloads.
3. Establish authenticated catalog publication/verification and key rotation,
   bounded archive extraction and explicit installation consent. The Hub owns
   discovery/comparison/download orchestration; this patch adds none of them.
4. Prove native re-open, running-server detection, cancellation and update
   safety before Hub adopts those operations. A successful metadata probe
   does not fulfill these separate acceptance gates.

No Hub UI, URP Converter, automatic updater, installation swap, Unity project
mutation, client-config migration change or extra first-run prompt is included.
