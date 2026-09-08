# Token Optimization Options and Next Phase

Updated 2026-09-08. This is a proposed work split, not dispatched tasks or a
promise of savings against any provider's account quota. The 2.6.0-rc.1
prerelease packages the implemented work; it does not complete runtime acceptance.

## Options Without Confusing the Tradeoffs

| Option | Benefit | Tradeoff / status |
| --- | --- | --- |
| Full tools + focused references and bounded reads | Every tool stays available; only requested documentation and scene detail enters context | Recommended when unrestricted functionality is the priority. Implemented in source; excerpt continuations may add round trips. |
| Optional static tool profiles | Lower initial schema overhead | Implemented in source. Specialist tools are hidden until profile change and server reconnect; this is not lossless compression. Existing saved Full selections remain Full. |
| Searchable tool discovery / activation | Potentially keep every operation reachable with fewer initial schemas | Future experiment. Requires real-client discovery tests, stable validation and permissions, and readable errors. Do not replace typed tools with an opaque unrestricted execute endpoint. |
| Server-side graph artifacts | Avoid sending the same large generated graph back through the AI for validate/write | Next substantive optimization candidate. Requires project-scoped immutable IDs, content hashes, explicit export, expiry, and validation against the current SDK. Not implemented. |

The model needs access to the whole reference library, not a copy of every book
on every task. Search exact names first, read complete relevant entries, retain
correction guidance, and re-read after source/SDK changes. Keep full references
available for exhaustive work. Never silently summarize away ports, defaults,
failure diagnostics, or compiler results.

No embedding database, paid retrieval API, new model call, or extra dependency
is needed for the current small bundled library. Consider such additions only
after measured search failures justify them. Prompt caching and conversation
reuse are client-controlled, not an MCP account-budget guarantee.

## Next Phase Workstreams

| Workstream | Scope | Completion evidence |
| --- | --- | --- |
| A: Package and upgrade acceptance | Windows build and staged source/server/bridge checks passed for 2.6.0-rc.1; platform packaging runs in tagged CI. Next: clean install and upgrade while preserving client profiles | Installed payload hashes; 52 tools in Full, 24 in core; reference and bounded-query calls from the installed payload; Linux/macOS install and client reconnect acceptance |
| B: Task-level efficiency and behavior | Same tasks in disposable Unity-only and Creator/Banter projects: large hierarchies, error storms, complex/embedded graphs, and queued commands during project switching | Total tool input/output bytes, calls, retries, time and validation; no false completion or wrong-project verification; client tokens where available; no new Editor hitches |
| C: Graph artifact design | Design a small opt-in handle-based generate/validate/write path, leaving existing JSON tools compatible | Same graphs and validators, no stale or cross-project artifact reuse; measured round-trip byte reduction before adoption |
| D: Unity interoperability probe | Existing stdio server in documented Assistant extensions first; optional Pipeline commands only if beneficial | Exact package versions, correct project selection, bounded replies, errors/reloads tested; no duplicate generic tools or internal Unity APIs |

A and B can proceed independently once the source revision is frozen. C starts
with a design review and failing workload measurement, not a broad rewrite.
D is time-boxed research and must not block token fixes. Integration review
checks each workstream's evidence before stable promotion or a broad rollout.
Coordinate with concurrent Built-in-to-URP conversion work before merging or
packaging shared source. This branch does not own render-pipeline conversion.

## Later Order

1. Preview-first Creator SDK setup using verified registry/package metadata.
2. Fresh-state preconditions and conflict responses for mixed manual/MCP edits.
3. Player interaction emulator, last. Keep it separate from real hosted-client,
   headset, networking, and multiplayer acceptance.

See [future roadmap](future-roadmap.md), [registry reference](creator-sdk-registry.md),
and [review evidence](token-optimization-review-2026-09-08.md).
