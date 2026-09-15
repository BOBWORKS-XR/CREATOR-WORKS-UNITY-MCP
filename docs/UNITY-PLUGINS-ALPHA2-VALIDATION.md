# Creator Plugins Alpha.2 Validation

Date: 2026-09-15. Version: `2.7.0-alpha.2`.
This is candidate evidence, not a declaration that every installation or package works.

## Included Changes

- Optional project selection, helper installation and queued Unity package review
  are enabled as experimental. Downloading or queuing is never reported as import
  completion. The user still approves installation and Unity's import dialog.
- Import outcomes are write-once. Cancellation, completion and C# reload no longer
  depend on replacing an intermediate receipt. Unknown outcomes are not replayed.
- Windows helper-directory publication handles short-lived sharing conflicts
  within a one-second retry budget, rechecking project identity, closed-Editor
  state, staged contents and the absent destination before each attempt.
- An optional selected-asset organizer previews graph or prefab moves and
  preserves GUIDs. It does not save scenes or select dependencies automatically.
- Hosted MCP community commands remain unavailable. Existing standalone MCP
  behavior, settings and project configuration are retained.

## Verified Locally

- Node suite: 235 passed. Native Rust debug and release suites: 98 passed,
  zero failed, five explicitly opt-in tests ignored in each configuration.
- Standalone browser UI: 21 groups passed, including narrow windows, long names,
  project consent, busy states and the experimental notice. Hosted UI: 10 groups
  passed. Browser tests mock native APIs; they do not prove installed behavior.
- Real Unity 2022.3.39f1 and 6000.3.21f1 import fixtures both recorded
  `cancelled/imported/imported`. Each verified imported C# type/value and assembly
  reload after import started. The cancelled asset was absent.
  Reports: `launcher/artifacts/plugins-native-YneS7F/interactive-result.json`
  and `launcher/artifacts/plugins-native-TEKXhF/interactive-result.json`.
- Those interactive tests used helper SHA-256
  `bd2790ca3ef332924d918111925cf07277ef26fee63c51e736b5ecbed7fa52db`.
  The candidate's later organizer/window-position changes use helper SHA-256
  `d7ebb4482f1194a51ad85789f11b60e9525a310b3d3b3893d9624bd22b4aa85a`.
  Earlier interactive results are not claimed as an exact-byte packaged test
  of this later candidate.
- Full NSIS installer built with Tauri CLI 2.9.6 and locked dependencies. All 13
  extracted resources and the installer preflight match their build inputs.
  The extracted launcher contains the exact candidate helper bytes.
- Private Node reports `v24.17.0`. Metadata checks passed two valid probes,
  13 invalid-argument probes and two unauthorized-host probes without launching
  the GUI. Windows executables are not Authenticode signed.

## Candidate Identity

Local folder: `artifacts/windows-candidate-alpha2-plugin-review-20260915`.

- Installer: `Creator Works MCP_2.7.0-alpha.2_x64-setup.exe`, 27,091,248 bytes.
- Installer SHA-256:
  `b8cab77e5a69ff44a07746765e4881dbf0fef528c1e5cab0866ee2500fc1e677`.
- Extracted launcher SHA-256:
  `5dfdd82f829dd9969f30484d1981ba312ad1ba03508ae38abd340c196785824a`.

The manifest records the source-file hashes and dirty base commit at build time.
The older same-version candidate in `windows-candidate-alpha2-local-20260915`
is historical and must not be substituted. CI builds have their own artifact
identity; acceptance applies only to the exact installer tested.

## Remaining Gates

- Run the existing Windows installed-upgrade workflow on this feature branch.
  Its fixture covers stable `2.6.0` to `2.7.0-alpha.2`, active-runtime refusal,
  subsequent upgrade and settings preservation. It does not cover alpha.1 to
  alpha.2 or an interactive Retry click.
- Coordinate final packaged app-to-Unity review and companion Hub/Setup acceptance
  with Creator Works Helper. Do not use simulated callbacks or a portable build
  as substitutes for those results.
- Publish only separately approved, exact accepted artifacts. Descriptor signing
  is distinct from Windows Authenticode signing.

No installer was run on this PC for the local candidate verification. No active
MCP server was stopped, and no user Unity project was modified by these checks.
