# Creator Plugins List/Grid Follow-Up

Local, unreleased work on `feature/plugins-list-grid`, 2026-09-15.
Based on MCP 2.7.0 (`55fe93e6a9545fc3b302c66fd105d2a755205117`).
No version bump, installer build, publication, installed-app update or real Unity
project change was performed. The released PNG is unchanged.

## Changes

- Shared desktop Grid/List buttons. Grid is the default; an explicit saved List
  choice survives reopening. Invalid or unavailable browser storage falls back to
  Grid without disabling either mode.
- Layout changes keep the existing cards, open details, search and pending
  download controls. The browser tests confirm no IPC is issued by switching.
- Unity uses the shared grid layout with equal-height rows and bottom-aligned
  Import/Details buttons. Selected details appear below the complete row.
- The exact four-file helper shipped in MCP 2.7.0 is now recognized as upgradable.
  Its full folder and metadata are backed up; custom/mixed files are refused.
  Existing project consent, closed-project requirements and busy guards remain.
- Frozen old-helper fixtures are protected from newline conversion. Tests cover
  index and checkout bytes with both Windows and Unix Git newline settings.
- Lucide List/Grid icons are included with attribution; no new runtime dependency.

Desktop preference: `creator-plugins.layout.v1`. Unity preference:
`CreatorWorks.Plugins.CatalogueLayout.v1`. Desktop storage is per app/origin, not
cross-app preference synchronization.

## Verification

- `npm test`: 246 passed. After the final shared default update, the focused
  helper, community integration and launcher chrome suites passed 28 tests.
- `node scripts/smoke-launcher-ui.mjs`: 26 mocked Edge/Playwright check groups
  passed, including keyboard switches, reload, blocked storage, no extra IPC,
  preserved pending controls, long names, equal grid row heights and no horizontal
  overflow at 1200/900/560/390/320px. Existing menu and operation-lock checks remain.
- `cargo test --release --locked`: 109 passed, 5 intentional diagnostic fixtures
  ignored. Includes exact stable-helper backup, metadata and scene preservation,
  modified/mixed-file refusal, existing upgrade rollback and queue guards.
- Strict all-target Clippy reports `too_many_arguments` on the unchanged
  `one_click_setup` function in `launcher/src-tauri/src/main.rs:2024`. That file
  has no diff from 2.7.0. No unrelated source suppression or command change was
  made. With only this lint explicitly allowed on the command line, all-target
  Clippy passed with all other warnings denied:
  `cargo clippy --release --locked --all-targets -- -D warnings -A clippy::too_many_arguments`.
- `scripts/smoke-unity-plugins-presentation.ps1`: 45 checks passed in each of
  Unity 2022.3.39f1 and 6000.3.21f1. Both exited normally with no C# compiler errors.
  Checks cover the default, explicit List persistence, selected detail/search,
  preview lifetime, revalidation/cancellation and immutable retry receipts.
  The tests restore the previous Unity layout preference.
- `scripts/check-unity-plugins.ps1 -CheckNativeLock`: 101 offline protocol/lock
  checks passed against each Editor's references, including Rust/C# lock exclusion.
- Staged whitespace check passed with `cr-at-eol` recognized. Plain Git's staged
  check flags the frozen release licence's intentional CRLF bytes; these cannot
  be normalized without invalidating the exact old-helper fixture. Command:
  `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --cached --check`.

## Artifacts

All paths below are relative to this worktree:

- `artifacts/launcher-ui-list-grid/results.json`
- `artifacts/launcher-ui-list-grid/community-downloads-only-900.png`
- `artifacts/launcher-ui-list-grid/plugins-grid-long-1200.png`
- `artifacts/launcher-ui-list-grid/plugins-grid-long-320.png`
- `artifacts/launcher-ui-list-grid/plugins-list-long-560.png`
- `artifacts/plugins-presentation-2022.3.39f1-3c4c088d/presentation-result.json`
- `artifacts/plugins-presentation-6000.3.21f1-cb65c788/presentation-result.json`
- `artifacts/unity-plugins-compile/`

The browser run used `LAUNCHER_UI_ARTIFACTS=artifacts/launcher-ui-list-grid` to keep
the earlier release screenshots intact. The default smoke output path is unchanged.

Screenshots were inspected for the desktop grid and narrow long-name layout.
Browser/Tauri checks are mocked; Unity checks use fresh marked disposable projects.
This pass did not repeat native import-dialog clicks, test an installed new
executable, or prove headset/multiplayer behavior. No token savings are claimed.

## Shared Source Identity

Ported from the coordinated Creator Hub worktree, preserving MCP-specific native
and hosted adapters. Rust recognition changes were scoped rather than replacing
the full module.

| File | SHA-256 |
| --- | --- |
| `launcher/src/community.js` | `23916c9409318cbba59edba756e4ae0c69c74899cecae96f9625a86cbd83f164` |
| `launcher/src/community.css` | `586871842b5a066487b03bc1dda7cd379cd21972618b421202611052e30f8f4a` |
| `launcher/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs` | `506799fb7c9a3868d212c635217ba853084e20fc6b22c772b7565fb54ac8ab07` |
| `launcher/src/icons/layout-grid.svg` | `b8903f61d09b1d75e55c71158277d26570962f69c2099446a251871e0a2d6678` |
| `launcher/src/icons/list.svg` | `ff97a7379eb962ddc3863bb59f0f45875ac8da91aac8a38a67361e7118d2d627` |
| `launcher/src/icons/creator-plugins.png` (unchanged) | `ff107f1c0bca0380f35f25754fd023d60311fa4457f6fd84255a8f41f78fee6d` |

The stable helper fixture's C# SHA-256 remains
`eb62f266835bf42814c3decc224197cb74842fc316428390645d314ca28243a7`.

## Coordination

Creator Works Helper owns Hub/Setup. Its existing stable-release Discord draft at
`C:\Users\bobman\creator-hub-community\docs\DISCORD-STABLE-2026-09-15.md` was checked
against MCP's `docs/releases/2.7.0.md`: the MCP claims match the released features,
retain manual Unity import review and do not advertise the unreleased Grid view.
No duplicate public post or release notes were created for this follow-up.
