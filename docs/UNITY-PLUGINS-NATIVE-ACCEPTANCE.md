# Unity Plugins Native Acceptance

For the later alpha.2 candidate, see [current validation](UNITY-PLUGINS-ALPHA2-VALIDATION.md).
This page preserves the original failures and test sequence, not current release status.

Historical evidence for the earlier helper. The subsequent correction and its
current validation status are recorded in [Windows Persistence Hotfix](HOTFIX-PERSISTENCE.md).
The failures below are retained; later batch tests do not turn them into passes.

Date: 2026-09-14. Local development only; no release, installed-app replacement,
AI configuration change, or real Unity project edit.

## First Actual Unity 6 Test

Disposable fixture: `artifacts/plugins-ui-a8753bec`, Unity 6000.3.21f1, Windows.
Run `scripts/prepare-unity-plugins-interactive.ps1` to create a fresh equivalent
fixture, not to reuse this completed queue. It exports three locally generated
packages, removes only their staging assets, and exits. No third-party code is
downloaded or imported. Open that marked project and use
`Creator Plugins/Fixture/Open test window`, then `Queued packages`:

1. Review `01 Cancel check` and cancel Unity's import dialog.
2. Review and import `02 Text import check`.
3. Review and import `03 C# import check`, then allow compilation to settle.
4. Use `Creator Plugins/Fixture/Verify and close`.

The fixture command docks the same production EditorWindow next to Scene view
because the desktop automation could not capture its floating window on another
monitor. It does not change production window positioning. Test scripts refuse
projects without their dedicated marker. Preparation creates a new directory;
do not copy these test scripts into real projects.

Result: `interactive-result.json` reports `passed:true` with statuses
`cancelled`, `imported`, `imported`. The verifier checked exact imported file
contents, absence of the cancelled file, no active review, and an idle Editor.
The test Editor exited normally. `interactive-events.log` shows actual started,
cancelled and completed callbacks; C# assembly reload occurred before the final
completion callback. These were real interactive imports, not simulated events.

Actual callback shapes in this Unity version:

- Started: full cache path without `.unitypackage`, before user approval.
- Cancelled: checksum basename without extension.
- Completed: full cache path without `.unitypackage`.

The existing basename matcher handled all three. Started cannot establish that
the user approved any files. One status sentence was corrected after this test
to say the import process opened and is waiting for selection/final outcome.

Tested helper SHA-256 before that wording-only change:
`bfaa5f600107b6770006226602cd44173a47290623bb7806529e0b77edc5a7b4`.
Current helper SHA-256 after the wording and omitted-review-state corrections:
`47f0dd36af987b3b8b79fb62751815b4a988e5d262bbfbe859709ad181611ae6`.
An omitted catalogue review state now defaults to pending, as the shared native
schema requires; unknown values still fail validation. The original source failed
that actual Unity test in `artifacts/plugins-editor-3637032f`.
Current source passes Unity 2022.3.39f1 and 6000.3.21f1 reference compilation and
35 pure protocol checks per version. The second interactive run below found a
real intermittent failure; the first passing run is not overall acceptance.

## Native Desktop Writer To Unity: Failed Gate

Fixture: `C:/Users/bobman/creator-hub-community/artifacts/plugins-native-zyUziW`.
The real Rust helper-install and queue functions created this marked project and
its three requests. Only the fixture test assembly was added afterward. Neither
the helper nor inbox was rewritten by test preparation. The verifier resolves
requests by package identity, not hardcoded request IDs.

With the current helper in Unity 6000.3.21f1:

- Cancellation was recorded correctly; the cancelled asset was absent.
- The text import completed and its contents matched.
- C# imported and recompiled. Unity emitted its actual completed callback after
  assembly reload, but saving the final receipt failed. The receipt remains
  `review`, and the UI reports: `Could not record the final import outcome:
  Unable to remove the file to be replaced`.
- `interactive-result.json` is `passed:false`, statuses
  `cancelled/imported/review`. `interactive-events.log` preserves the callbacks.
  No retry or clear-unconfirmed action was taken. The test Editor closed normally.

This is a confirmed status-persistence failure, not proof of a failed asset import
or its underlying lock owner. No guessed delays, retries, forced process closure,
or weaker persistence were introduced. Installed/public apps and real projects
remain untouched.

The companion actual Unity queue/restart tests on current source:

- Unity 2022.3.39f1, `artifacts/plugins-editor-49e2410e`: 13 queue/listing checks
  and 6 recovery checks passed.
- Unity 6000.3.21f1, `artifacts/plugins-editor-7e95efa4`: 13 queue/listing checks
  passed; recovery failed after 4 checks while recording simulated cancellation.
  Failure assertions now include the helper's detailed recovery error.

## Desktop Checks And Open Issue

- Full Node suite: 232 passed. Latest standalone browser fixture: 19 groups
  passed, including native-ID-only queue calls, project choice/cancel, operation
  locks, no-clobber refusal, and 900/560/390px long project names.
- Launcher browser fixture uses bundled Playwright and the
  installed Edge channel. Screenshots are in `artifacts/launcher-ui`. Native
  catalogue/project/download APIs are mocked in these browser checks.
- Hosted browser fixture: 10 groups passed. All eight community commands were
  refused through both adapters before transport; no hosted capability added.
- Native Rust full concurrent suite: two runs each gave 64 passed, one failure,
  two ignored. Failure is `hosted_journal.rs:173`, Windows error 1175 while rapidly
  replacing an outcome record. The journal and file-replacement implementation
  are unchanged from the pre-community baseline.
- That exact journal test passed 10 isolated repeats. Full serial suite passed
  65 tests with two ignored. Concurrency correlation is observed; the cause is
  not proven. Latest full run with project integration: 74 passed, one failure,
  three ignored, again the same journal test and error 1175. Do not label the
  overall native suite green or fix it with guessed delays, weakened persistence,
  or replay. Journal/file-publication behavior was not changed.
- A separate native Windows probe performed 1,000 writes each with ReplaceFileW
  flags 0, flags 1, MoveFileExW replace, and .NET File.Replace: all passed. This
  simple probe did not reproduce the failure and does not invalidate the failed
  Unity or journal tests. Microsoft documents error 1175 as failure to remove the
  original, with both names retained:
  https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew
- Unity's Android module logged ADB-instance management messages during startup.
  No ADB settings or processes were directly manipulated by these test scripts.

## Still Missing

Shared project selection, optional helper installation and queue UI are integrated
in the MCP branch. Native wrappers retain lifecycle guards inside blocking work.
Final shared JS/CSS/Rust files match the coordinator's copies. Existing helper
files are never silently overwritten; queue limits and Windows empty-directory
no-clobber publication have regression coverage.

The companion local Hub candidate includes the reviewed hosted pipe-drain fix;
that is not acceptance of the original installer/Codex-process lock symptom.
Any newly built EXEs are diagnostic candidates, not distribution-ready updates.
The old `artifacts/community-candidate` remains obsolete. No installer, public
release, version promotion or installed upgrade is authorized by these tests.
Native Unity 2022 dialogs, preview images, arbitrary third-party packages,
installed upgrades and headset behavior remain separate acceptance work. The
public catalogue returned no listed entries during the native test; pending
contributions were not published just to populate the UI.

## Diagnostic Build Identity

`artifacts/plugins-diagnostic-20260914/creator-works-mcp-launcher.exe`
SHA-256: `ee66f1f12336dcd4e6d62369141fe2f67bfc52bbc5968be1e56f9e9c74739799`.
Release compilation passed. Metadata-only probing passed (two valid probes,
13 invalid arguments rejected, two unauthorized hosts rejected), with existing
configuration metadata unchanged. This folder intentionally contains no complete
normal-launch payload or installer. Do not distribute it or replace an installed
app. The inherited 2.7.0-alpha.1 version is not a public binary identity.
