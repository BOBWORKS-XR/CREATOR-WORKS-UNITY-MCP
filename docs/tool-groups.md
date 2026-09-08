# Tool Groups

New Creator Works launcher and setup configurations use `core` by default.
Set `CREATOR_WORKS_TOOL_GROUPS` in the MCP server environment to choose another
tool surface. A server started manually without either tool-group environment
variable retains the legacy `all` default. Existing saved `all` selections are
not silently changed. The legacy `BANTWORKS_TOOL_GROUPS` name remains accepted
while existing installations migrate.

Accepted values are `all`, `none`, or a comma-separated combination of:

| Group | Purpose |
|-------|---------|
| `core` | Compact general workflow: routing, health, bounded scene inspection, logs, compile/import checks, common GameObject/component edits, references, prefab placement, and scene save. Specialist Visual Scripting, tests, Play Mode, screenshots, and Shader Graph tools stay hidden. |
| `read` | Project inspection, logs, compiler settling/diagnostics, package/asset discovery, screenshots, and validation. It exposes no authoring tools, but Unity validation can force import/refresh and related Editor side effects. |
| `author` | Visual Scripting generation/validation/writes with SDK provenance and bounded node lookup, Shader Graph inspection/authoring/validation, WebRoot writes, asset refresh, guarded custom Editor menu execution, scene lifecycle, GameObject/component changes, and prefab placement/scanning. |
| `test` | Test discovery/execution/cancellation/status, compile settling, Play Mode control, logs, and screenshots. |
| `banter` | SideQuest SDK provenance, bounded custom-node lookup, Visual Scripting generation/validation/writes, SDK allow-list validation, and WebRoot authoring. |
| `shadergraph` | Shader Graph capability checks, structural inspection, transactional creation/mutation, and compiler validation. |

`list_unity_projects`, `select_unity_project`, `get_bridge_status`, and
`get_unity_command_status` remain
available for every selection, including `none`. Groups are unions, so
`read,test` exposes both sets. Direct calls to hidden tools are rejected.

Unknown groups and combinations such as `all,read` or `none,test` stop server
startup with an explicit error. This prevents a misspelled restriction from
silently starting with broader access.

## Launcher Profiles

| Profile | Value |
|---------|-------|
| Token Saver (recommended) | `core` |
| Full Unity + Banter (high context) | `all` |
| Inspection | `read` |
| Banter workflow | `core,banter` |
| Shader Graph preview | `core,shadergraph` |
| Unity authoring | `core,author` |
| Testing | `core,test` |
| Minimal routing | `none` |

The Windows launcher and `setup.ps1` write the selected value to both Codex and
Claude configuration. Other MCP clients can set the environment variable
directly. `banter://tool-groups` returns the exact machine-readable membership
from the running server build.

Profiles intentionally hide tools. They do not preserve the entire active
surface in a smaller schema. Choose Full when every operation must be available
without a profile change/reconnect. Focused reference retrieval and bounded
read results work in Full too. `get_mcp_reference` belongs to `read`, `author`,
and `banter`; it is not part of the general 24-tool `core` surface.

Run `npm run measure:context` after changing tools or schemas. It reports exact
serialized schema bytes and a clearly labelled rough token estimate. Automated
tests cap the `core` profile at 24,000 bytes and require it to remain at least
40% smaller than `all`.

The specialist presets extend `core` with only the relevant tool family. Custom
group combinations remain available when a workflow needs a different surface.
Authoring also includes the inspection and validation tools its graph operations
require; it does not rely on callers having separately enabled `read`.

Dynamic per-request tool activation was reviewed but not adopted in this pass.
Static startup profiles are deterministic, work across existing clients, and
support prompt-cache reuse. They also avoid relying on client-specific handling
of tool-list change notifications.
