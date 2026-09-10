# Future Roadmap

Reviewed: 2026-09-08

This file records intended investigation, not shipped capability. Each item
still needs source contracts, a narrow design, tests, and the release gates in
`unity-mcp-benchmark.md`.

Priority: finish token-efficiency acceptance and Windows packaging first;
then a bounded Unity interoperability experiment, Creator SDK setup, and manual
editing conflict protection. Player emulation is last, after those foundations.
See [next-phase workstreams](token-optimization-next-phase.md).

## Unity AI and Official MCP Interoperability

Confirmed from Unity's public documentation:

- Unity provides an in-editor Assistant, AI Gateway, and official MCP tooling
  for Unity 6 and newer. Its current FAQ says the MCP server is free and consumes
  no Unity credits. This does not make the AI client/model free.
  [Unity AI FAQ](https://unity.com/features/ai)
- The official `unity mcp` command exposes commands from a connected Editor.
- A project can register documented `[CliCommand]` methods through
  `com.unity.pipeline`; those commands are discoverable by the Unity CLI and
  its MCP server.
  [Unity CLI integration reference](https://github.com/Unity-Technologies/skills/blob/main/skills/unity-cli/references/integration-advanced.md)
- Assistant 2.19.0-pre.2 documents external local stdio and remote HTTP servers
  under Assistant MCP Extensions. The same documentation marks Unity MCP tooling
  deprecated and directs developers to the CLI. A documented connection route
  exists; this corrects the earlier note that none had been confirmed.
  [Assistant MCP configuration](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.19/manual/integration/mcp-configure.html)

Unknown:

- Creator Works has not been connected to Assistant in a live test. Its exact
  package-version behavior, permissions, reloads, and project targeting remain
  unverified; public configuration docs alone do not establish compatibility.

Preferred experiment:

1. First try Creator Works' existing stdio server in Assistant MCP Extensions
   in a disposable project. Do not add a second bridge or adapter just to test
   this documented connection route.
2. Separately, if it adds measurable value, prototype an optional package using
   `com.unity.pipeline`. Expose only a reviewed subset of status, inspection,
   and validation operations as `[CliCommand]` methods.
3. Discover the resulting commands through `unity list` and `unity mcp`.
4. Measure duplicate schemas, latency, authorization, error propagation, and
   behavior with more than one open Editor.
5. Keep Creator Works' existing local bridge available for older Unity versions
   and specialist Creator/Banter Visual Scripting work.

Do not use reflected or internal Unity Assistant APIs. Recheck package terms
and supported interfaces before distribution. Keep duplicate generic editor
tools out of any specialist Creator/Banter layer.

Unity CLI 1.0.0-beta.8 was announced on September 2, 2026. Its release notes
describe dependency-version gating and MCP parameter-type fixes, so adapter
tests must pin both CLI and Pipeline versions rather than reuse old assumptions.
[Official release notes](https://discussions.unity.com/t/unity-cli-1-0-0-beta-8-is-rolling-out/1735542)

## One-Click Creator SDK Setup

Goal: a double-click or launcher action that prepares an existing Unity project
without hiding changes or claiming runtime proof.

Required design:

- detect the exact Unity version and current manifest/lock state;
- identify Creator SDK, legacy Banter SDK, hybrid, or Unity-only state;
- show a dry-run plan and the exact package source/version;
- back up only files that will be changed;
- install or migrate through supported Unity Package Manager contracts;
- wait for import and compilation, then run the installed SDK validator;
- produce a reversible report with changed files and remaining errors; and
- keep Quest, hosted-space, and multiplayer testing as separate acceptance.

Package IDs, supported versions, and migration mappings must be verified from
the current SDK source before implementation.
The supplied [Greenfield registry](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk)
is a useful source for this work. See the [dated metadata check](creator-sdk-registry.md).

## Manual and MCP Editing Without Rollback

Goal: let a person edit the Unity scene while an MCP client is working without
one side overwriting changes captured from an earlier snapshot.

Required design:

- issue a monotonic scene revision with every fresh read;
- attach the expected revision and object fingerprint to each mutation;
- resolve objects by stable global ID and verify their current path/component
  state immediately before mutation;
- reject stale preconditions with a structured conflict response;
- let the client re-read, explain the difference, and retry intentionally;
- scope Unity Undo to only the current command or atomic batch; and
- never restore a complete scene or hierarchy from an MCP snapshot.

This is intentionally future work, not part of the current token-optimization
implementation.

## Community Tools and Reusable MCP Helpers

Added 2026-09-10. Future scope only, after installer, migration and Hub adoption
blockers. Creator Hub owns the reviewed community directory alongside packages
and plugins; MCP may help prepare local contribution drafts, not a second index.

Goal: preserve useful AI/MCP-created C# utilities instead of discarding them.
At a natural task boundary, offer Keep local, Prepare contribution, or Skip at
most once per artifact. Declining must not affect normal MCP functionality.

- Keep feedback private by default. Sharing requires explicit author consent.
- A small, bounded source sample may accompany a feedback draft. Larger source
  stays in a separate local file with its hash and a link, not repeated in every
  tool response. Alternatively, list the author's public repository at an exact
  reviewed version or commit, only after permission to share it.
- Require ownership, an explicit license, dependencies, Unity/SDK versions,
  test notes, limitations, Editor-only/runtime scope and declared side effects.
- Review for credentials, private paths, client configuration, proprietary
  assets and unrelated code. AI-generated origin is not a safety guarantee or
  proof that purchased assets can be redistributed.
- Initial listings expose reviewed metadata and source links only. Do not
  auto-upload feedback, publish drafts, execute or compile submissions, or copy
  helpers into Unity Assets. Any later installation needs separate target,
  consent, dependency, conflict, backup and removal checks.
- Bonto is an unverified possible future adapter, not a selected integration.
  Verify its supported contract before making implementation commitments.

Compilation checks remain distinct from headset and multiplayer acceptance.
No submission endpoint or community installation capability is enabled here.

## Player Interaction Emulator (Last)

Goal: deterministic Editor-side testing of common interactions that are
awkward to exercise without a hosted Banter/Creator client. Start only after
the preceding installation, compatibility, and conflict-protection work.

Initial scope:

- spawn and reset points;
- keyboard/gamepad locomotion and basic view control;
- grab, release, held-button, trigger, and collision events;
- local player identity and ownership-state fixtures;
- repeatable recordings/assertions for Visual Scripting graph behavior; and
- a small obstacle/interaction harness suitable for automated checks.

The emulator must label approximations. It cannot prove headset tracking,
platform networking, hosted loading, frame rate, or multiplayer behavior.
