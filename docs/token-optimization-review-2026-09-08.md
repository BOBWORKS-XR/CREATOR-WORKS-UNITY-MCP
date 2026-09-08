# Token Optimization Review

Reviewed the uncommitted token-optimization implementation on
`feature/token-optimization-2026-09-08`, based on `006b08a`.

## Confirmed Broken and Corrected

- **P1: response budget did not cover the tool text.** A 64 KiB hierarchy
  request returned 127,295 UTF-8 bytes after pretty printing. Queries now emit
  compact JSON and budget the complete response text, including metadata and
  the `responseBytes` field. Tests check the actual MCP text for hierarchy and
  component queries at default and explicit limits, including multibyte text.
- **P1: saved component queries could lose valid matches silently.** An
  unrelated 100 KB component exhausted an intermediate hierarchy budget before
  component filtering. A later Rigidbody was omitted with a false zero match
  count. Object scoping, component matching and projection now precede the
  result budget. Counts and truncation reflect the matching components.
- **P2: the slimmer authoring profile omitted its prerequisites.** Graph
  generation remained available while validation, SDK lookup and Shader Graph
  inspection were hidden. `author` now includes those dependencies; `core`
  remains the 24-tool general profile.
- **P2: property-only live queries disagreed across the bridge boundary.** The
  server dispatched them but Unity's selector guard rejected them. The guard
  now accepts the documented property projection, covered by a real Unity run.
- **P2: malformed catalog categories threw a TypeError.** Non-string categories
  now return an explicit validation failure.

If an individual item cannot fit, queries retain the total match count and
truncation flag and suggest narrowing the projection or raising the budget.

## First-Pass Verification

- `npm test`: 161 passed, including regressions that first failed against the
  earlier implementation.
- `cargo test` in `launcher/src-tauri`: 20 passed.
- `npm run release:server`: bundled and smoke-tested, 1,191,200 bytes.
- `scripts/smoke-setup.ps1`: temporary configuration and migration smoke passed.
- `scripts/smoke-unity-asset-reference.ps1`: passed in a disposable Unity
  6000.3.10f1 project. The exact bridge compiled and processed real commands for
  nested/inactive objects, exact/contains identities, component/property
  projection, property-only queries and result limits. Queries left the full
  hierarchy snapshot unchanged. Existing asset/Visual Scripting reference
  persistence checks also passed. The temporary project was cleaned up.
- `npm run measure:context`: `core` 20,441 bytes / 24 tools; `all` 44,821 bytes /
  51 tools, a 54% schema-byte reduction. This is not an account-usage guarantee.

## Second-Pass Findings and Verification

- **Confirmed broken: specialist prompts still requested full documents.**
  Graph and workflow prompts bypassed the earlier system-prompt improvement.
  They now use `get_mcp_reference` and focused node lookup. Complete resources
  remain explicitly readable; no graph generation or validation tool was removed.
- **Reference completeness:** the new local index pages manual sections and
  component/JavaScript/workflow entries by source revision and offset. Tests
  reconstruct every entry. Manual results always include the complete errata;
  workflow results include the common workflow contract. Code fences do not
  split sections. Non-finite defaults use a descriptive `$number` marker rather
  than silently becoming JSON null. No retrieval service or dependency was added.
- **Confirmed broken: diagnostic entry limits did not bound reply size.** A
  default console fixture returned 1,125,822 bytes. Console, import, compiler,
  and prefab replies now enforce a 64 KiB compact text default, configurable
  from 16 KiB to 4 MiB. Tests preserve failures, stale flags, complete entries,
  newest logs, matching counts, source paths, and explicit omissions. A single
  oversized error is reported as omitted, not as a successful compile.
- **Correct as-is:** full graph JSON and mutation receipts are not clipped by
  these read guards. Static profiles are optional tool restrictions, not
  lossless compression. Full exposes every operation and still gets bounded
  reads and focused references.
- `npm test`: **168 passed**, zero failures.
- `npm run release:server`: **passed**, including a real stdio focused-reference
  call and graph prompt from the isolated bundle; **1,203,460 bytes**. This builds
  a local server payload, not a Windows installer or published release.
- `node scripts/measure-mcp-context.mjs`: core **21,425 bytes / 24 tools** versus
  Full **46,866 bytes / 52 tools**, approximately **54% fewer schema bytes**.
  The Full schema grew slightly to expose retrieval and budget controls.
- Example lookup result text: manual `SetMember` **3,394 bytes** versus the
  **45,117-byte** full manual; component `BanterSyncedObject` **2,157 bytes**;
  custom node `InjectJS` **748 bytes**. These are examples, not an end-to-end
  task saving: partial entries can require continuation calls.
- 100 warm local iterations of each example gave p95 **0.181 ms**, **0.054 ms**,
  and **0.146 ms**, respectively. These timings exclude startup, transport,
  model time and Unity. They do not prove headset or large-project performance.

No Rust or Unity bridge code changed in the second pass; their earlier
verification above still applies to those same source changes. Neither the
installed app nor existing project bridges were replaced.

## Feedback and Remaining Acceptance

Windows installer acceptance and large-project interaction/profiling remain
unverified for this branch. General unfiltered fresh queries still use the
explicit full-scene export path; targeted queries avoid it. SDK installation,
player emulation, concurrent manual/MCP edits and Unity AI interoperability
remain separate roadmap items.

Recent local feedback was checked after the implementation. The reported
identity-filter mismatch is covered by this branch's focused regression and
Unity fixture. Older reports of queued writes and project-target drift still
need current-version reproduction; they are explicit next-phase acceptance
cases, not declared fixed here. Bounded image/render-data inspection and
embedded-graph summaries remain candidates, not additions in this pass. Private
project details and the feedback file itself are not included in the release.

The SDK registry and official Unity research are recorded in
[the future roadmap](future-roadmap.md) and [registry reference](creator-sdk-registry.md).
Workstream ownership and gates are in [the next-phase plan](token-optimization-next-phase.md).
