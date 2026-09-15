# Windows Persistence Hotfix

Date: 2026-09-15. Isolated `feature/community-plugins` worktree. No publication,
installed-app changes, client shutdown or real Unity project modification.

## Evidence And Limits

The previous real Unity 6 C# import completed and reloaded, but its mutable
receipt remained `review` after File.Replace failed. The MCP's full concurrent
journal test separately failed with Windows error 1175. Both failures are
preserved in the 2026-09-14 acceptance report.

`launcher/tests/native/ReceiptContentionProbe.cs` reproduces 1175 outside Unity,
including without child processes. Repeated runs failed at iterations 10, 549,
675 and 760. File attributes were Archive on NTFS. Restart Manager found no
current users at capture time; this does not identify or exclude a transient
filter or lock. Do not blame antivirus, Unity or inherited handles without proof.

In the controlled final comparison, no-backup ReplaceFileW failed at iterations
675 and 0; the same writer with a unique backup completed 5,000 writes alone and
5,000 while spawning children. Old backup and new destination contents were
verified on every success, with no cleanup failures. A mapped-reader control
passed ReplaceFileW but failed MoveFileExW, so switching to MoveFileEx is not an
equivalent fix. Evidence folder:
`artifacts/creator-receipt-contention-b2bf8681cc6d414b90bf2c46f2f7c395`.

Microsoft documents 1175 as failure to delete the original and supports a backup
path to preserve it during replacement. The unsupported WRITE_THROUGH flag was
removed; tests reproduced failure with flags zero, so that flag was not proven
causal. [ReplaceFileW documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).
These checks establish a failing publication pattern and tested correction, not
the identity of an external blocker or universal power-loss durability.

## Unity Helper

- No mutable queued/review receipts. Queued derives from a valid request; review
  derives from the full matching durable active request.
- Matching completion, cancellation or failure writes one terminal receipt via
  the existing flushed, no-overwrite SaveNew path. No File.Replace remains.
- Final persistence precedes active-file cleanup. Terminal state wins after a
  restart if cleanup was interrupted. Polling and duplicate callbacks do not
  rewrite outcomes or reimport assets.
- Legacy intermediate receipts and changed identities are preserved and refused.
- Shared native status reader follows the same contract. JSON shape/path stays
  unchanged; no new capability, network endpoint or scene operation was added.

Helper SHA-256 tested and packaged in the local hotfix candidate (before the
subsequent source-only catalogue category additions):
`934a880bcbc9139cba2b75753edde47ededb82b88c5ce7f8b91f4238382d1af5`.

## MCP Journal And Settings Publication

The existing publisher still uses ReplaceFileW, now with a backup in a newly
created `.cw-publish-*` recovery directory. The journal format and record bound
are unchanged. There are no retries, fallback renames or automatic recovery-file
deletions on later operations. A failed write preserves any backup. A successful
write remains successful if backup cleanup fails, with its recovery location
reported to stderr. Eight retained recovery directories block further replacement
before modification, rather than allowing unbounded accumulation.

Only the newly owned backup and its empty directory can be cleaned by that
operation. The old temporary-file replacement fallback was removed. Journal
source data is flushed before publication as before; no stronger general
settings power-loss guarantee is claimed.

## Verification

This section records the first correction. See [alpha.2 validation](UNITY-PLUGINS-ALPHA2-VALIDATION.md)
for subsequent completed interactive tests and the newer installer candidate.

- Four Windows regression tests: open readers, blocked writes preserving both
  versions, recovery/cleanup-failure preservation, and bounded recovery refusal.
- Ten full concurrent Rust suite runs: each 79 passed, zero failed, three opt-in
  tests ignored. This includes unknown-outcome, restart and bounded journal tests.
- Unity 2022.3.39f1 and 6000.3.21f1: reference compilation and 35 pure checks each.
- Actual disposable Unity tests: 16 queue/identity/legacy checks and eight restart/
  terminal-precedence/no-rewrite checks per version. Fixtures:
  `plugins-editor-a286f577` (2022), `plugins-editor-627b4620` (6).
- Node suite: 232 passed. Standalone browser: 19 groups passed; hosted browser:
  10 groups passed. Browser native APIs are mocked, not actual upgrade proof.
- Dependency audit: zero reported vulnerabilities. Clippy passed with the
  pre-existing `one_click_setup` argument-count lint explicitly allowed; the
  fully strict invocation still reports that existing lint.
- Real interactive cancel/text/C#-reload acceptance on the corrected native
  writer/helper combination remains pending. The first import below succeeded;
  the planned cancellation and C# reload checks were not completed.

## Partial Interactive Run

Creator Works Helper opened the disposable Unity 6 fixture
`C:/Users/bobman/creator-hub-community/artifacts/plugins-native-i8Ws70` with the
matching `934a880b...` helper. Its UI automation reported overlapping user input
during the first review/cancel sequence. The user subsequently confirmed that
they chose Import. That package was imported and correctly recorded as imported;
this was not a demonstrated cancellation or UI failure. The attempt stopped
without continuing to the other two imports. The original test expectations and
evidence remain unchanged; user clarification does not substitute for the
missing cancellation and C# reload checks.

`interactive-events.log` records started and completed callbacks for the first
package. Its receipt (`4da171f814ce39b3b454c77d01ac23f4`) durably says `imported`,
matching the imported asset; no active marker remains. This is evidence of one
terminal receipt write, not cancellation or C# assembly-reload acceptance.

`Editor-interactive-parent.log` records normal shutdown cleanup and Package
Manager shutdown. Process 92048 was no longer present when checked. The fixture
is retained unchanged after that run: no replay, deletion, expectation changes,
or clear-unconfirmed action. A future clean test needs a new disposable fixture.
Normal Unity Editor shutdown also saved its shared layout preferences; no claim
is made that opening the Editor cannot touch ordinary Editor preferences.

## Local Installer Candidate

Version `2.7.0-alpha.2`, built from source with Tauri CLI 2.9.6 / locked Cargo
dependencies and the generated third-party-notices resource overlay. Candidate:
`artifacts/windows-candidate-alpha2-local-20260915/Creator Works MCP_2.7.0-alpha.2_x64-setup.exe`.

- Installer SHA-256:
  `efd441bc65606b0ce98b4734f73be5e40280fb43d22b2fa73620a5dae9ead3f9`.
- Actual extracted launcher SHA-256:
  `95475bac506980e8b0f7679df6f0570b37eefc628d0a3c29558ec0729603ccf5`.
  This is the installer payload, not the separately built portable EXE.
- All 13 bundled resource files and the embedded installer preflight match their
  build inputs by SHA-256. The private Node executable reports `v24.17.0`.
- Extracted launcher metadata smoke: two valid probes, 13 rejected arguments,
  two rejected unauthorized hosts. The fixture and watched existing configuration
  metadata remained unchanged. No normal GUI launch or installer execution.
- Candidate README and manifest retain the exact file identities and open gates.

A local build is not installed-upgrade acceptance. New matched installers and
actual upgrade testing remain coordinated with Creator Works Helper. No public
release is authorized by these local tests.
