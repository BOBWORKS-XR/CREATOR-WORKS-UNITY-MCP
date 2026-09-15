# Node Runtime Update Hotfix

2026-09-16. Unpublished 2.7.1 candidate; user installation unchanged. These bytes
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

Validation: 249 Node tests passed; standalone bundle smoke and all three shutdown
tests against the bundle passed; Windows cleanup fixtures stop multiple owned
runtimes, preserve unrelated processes/launchers and verify unchanged files.
Production installer hooks compile in the no-install NSIS fixture.

Full newly packaged installer upgrade, native dialog click-through and complete
Hub-to-client reconnect acceptance remain required before publishing. The Hub
worktree's `docs/MCP-RUNTIME-HOTFIX.md` contains the coordinated release checklist.
