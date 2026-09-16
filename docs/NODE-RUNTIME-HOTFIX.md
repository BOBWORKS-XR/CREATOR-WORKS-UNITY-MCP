# Node Runtime Update Hotfix

2026-09-16. Reviewed 2.7.1 release candidate; user installation unchanged. These bytes
must not replace the public 2.7.0 assets. Disposable installer acceptance covers
2.6.0, 2.7.0-alpha.1, 2.7.0-alpha.2 and 2.7.0 baselines.

- Reproduced: stdin EOF during a pending Unity compile wait leaves Node alive.
  Idle EOF was already correct. New shutdown handlers close MCP and exit without
  cancelling/resubmitting Unity work already dispatched.
- The interactive installer now offers an explicit private-runtime disconnect.
  Only exact `server/runtime/node.exe` or `node` paths under the selected install
  are eligible. Kernel handles are path-checked and retained through termination.
  Other Node installations and launchers are preserved. No repeated kills on
  auto-reconnect. Silent installs still refuse busy runtimes without closing them.
- Hub companion changes add the same explicit recovery from Apps and MCP details,
  using native confirmation and preserving all existing update guards.

Validation: 250 Node tests passed; standalone bundle smoke and all three shutdown
tests against the bundle passed; Windows cleanup fixtures stop multiple owned
runtimes, preserve unrelated processes/launchers and verify unchanged files.
Production installer hooks compile in the no-install NSIS fixture.

## Packaged Acceptance

Windows CI run [35037253293](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35037253293)
passed all four baselines above on disposable runners. Source commit:
`cd0e5c0344955323e34ee12cee452b871002c566`.

- Installer SHA256: `4782b6ab04e09a8d24c5fd67d8c75fde8b508d09c04cb1391d953cd51d3aaa66`.
- Installed launcher SHA256: `6e1ba9d8d4eee99b35b60c9093efd1b3c19183d2cc184266a0696b8a57b0376d`.
- Both silent upgrade modes refuse two running private runtimes without writing
  or closing them. The cleanup helper extracted from this exact installer stops
  both runtimes, leaves unrelated Node running and changes no baseline files.
- Upgrade then succeeds, preserves settings/unmanaged content, and installs the
  exact checked payload. Its private Node and bundled server pass idle/pending
  EOF shutdown and connected-idle usability checks. Busy uninstall still refuses.
- Reports are retained under `artifacts/node-runtime-hotfix/ci-35037253293`.

Replay [35040188482](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35040188482)
passed native Yes/No/Cancel checks and native app lifecycle with the same bytes.
`interactivePromptsTested` is true; `interactiveUpgradeTested` remains false
because installation itself uses the separately tested guarded silent route.
The prior replay failed in the test helper's startup process-path observation,
before clicking native prompts; the product installer was not changed.

Hub's first 0.1.3 candidate failed because `disconnect_mcp` was absent from the
command ACL. That binary is rejected. The corrected exact binary passed all four
Hub native routes in replay 35039611764, including Cancel and confirmed disconnect.
A final build now binds MCP 2.7.1 and must pass its own native matrix before Hub
publication. Its checklist is `docs/MCP-RUNTIME-HOTFIX.md` in the Hub repository.

The user authorized stable publication and sleep only after verification. The
2.7.1 tag workflow explicitly skips rebuilding/replacing reviewed Windows assets.
The release descriptor requires Hub 0.1.3 for the exact new hosting binding.

Post-publication default-branch CI 35040585031 caught a formatting-only failure
in a Rust test assertion. Local `cargo fmt --check` reproduced it; only line
wrapping was corrected. Candidate CI now performs that same early format check.
Accepted installers, executable hashes and release assets are unchanged. This is
a source/test hygiene correction, not evidence that the packaged upgrade failed.
