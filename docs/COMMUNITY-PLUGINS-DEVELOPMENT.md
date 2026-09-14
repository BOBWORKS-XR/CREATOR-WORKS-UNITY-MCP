# Community Plugins: MCP Integration

This is an isolated development candidate on `feature/community-plugins`, based
on `478e241`. It is not a public release, installer, or change to installed apps.
Its inherited `2.7.0-alpha.1` metadata is deliberately unchanged and must not be
used to identify it as the previously published build.

## Scope

- Standalone MCP gains a Plugins page in its existing app menu. It uses the same
  catalogue renderer, styles and native catalogue code as Hub and Project Setup.
- The catalogue loads only when opened. Search and type filtering are local.
  No new AI tools or documentation payloads are added; no token savings claimed.
- Leaving MCP settings preserves their current in-memory values. Saving a
  package uses the existing operation lock, including while switching views.
- Hosted MCP retains its existing explicit handshake and command allowlists.
  Its standalone Plugins page/menu stay hidden; Hub owns the shared page.
- Catalogue content is data, never installation authority. Native workers hold
  lifecycle guards until the actual work finishes, not just until dispatch.

## Download Boundaries

The fixed community feed is validated and bounded. Package downloads need a
listed entry, fresh catalogue, approved HTTPS location, exact byte length and
SHA-256 match. They use a user-chosen destination and never overwrite an existing
file or import anything into Unity. A checksum does not establish C# safety.

The Start Location fixture credits Mr. E / egon.gb. It remains pending, with no
download action: exact licence terms and Unity compatibility are not established.
The fixture is test data, not automatically added to the production feed.

## Shared Source Ownership

Keep `launcher/src/community.js`, `launcher/src/community.css` and
`launcher/src-tauri/src/community.rs` identical to the corresponding Hub modules.
Coordinate shared fixes before syncing Project Setup and MCP; do not maintain
independent UI or security-policy forks. MCP owns `community-adapter.js` and
`community_api.rs` only. The existing reqwest 0.12 dependency line is reused.

Expected SHA-256 for this matched candidate:

| File | SHA-256 |
| --- | --- |
| community.js | `060308b60d692be1c206d42b5697bc01a5e658ae256a862c6fdc7ebfa6591240` |
| community.css | `947687448c2bf91e1063d09bf68a450ba0c4f99f21439e08738c1ea927f5b07a` |
| community.rs | `7d321afe8f4cf6637ef2e5e5f8dce5804a09de132cc72c7c89c9a3510f3ca93a` |
| Start Location fixture | `8926b66cb5e29996636c7fe94dc87e30678901b05010d6be1bb4dbb9391f945b` |

## Verification

- `npm test`: 226 passed.
- `npm run release:server`: server bundle built and isolated bundle smoke passed.
- `cargo test --release --locked --manifest-path launcher/src-tauri/Cargo.toml`:
  65 passed, 2 explicitly ignored (subprocess fixture and opt-in network test).
- The opt-in read-only network test was then run separately: 1 passed. It read
  the public catalogue and verified supplied package bytes without saving or
  importing them; this does not approve the pending listing.
- `node scripts/smoke-launcher-ui.mjs`: 18 check groups passed, including Plugins
  at 900/560/390px, retained drafts, review gating, filters, operation exclusion,
  stale/offline refusal, and existing keyboard/menu behavior.
- `node scripts/smoke-hosted-mcp-ui.mjs`: 10 check groups passed with this
  worktree's assets, including refusal of all community commands before transport.
- Strict Clippy reports the unchanged eight-argument `one_click_setup` handler;
  no unrelated signature refactor or warning suppression is included.
  Standard Clippy, the release build and metadata-only native invocation passed.

Browser tests mock native APIs and catalogue entries. Their screenshots do not
prove a real package import, native save dialog, installed upgrade, or headset
acceptance. Screenshot files are under `artifacts/launcher-ui/community-*.png`.
Matched Hub/Setup tests and executable hashes belong in the private candidate
handoff. Do not publish or update Hub executable pins from these source checks.

The separate Hub hosted-pipe hotfix is not included in this MCP branch.
