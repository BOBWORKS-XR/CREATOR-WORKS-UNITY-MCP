# Banter Workflows

`banter://workflows` is the machine-readable contract for six focused Banter
domains. The MCP prompts render from the same contract, and automated tests
verify every referenced component, custom node, JavaScript method, tool, and
capability group against the server's exported catalogues.

| Workflow | Intended result | Supported surfaces |
|----------|-----------------|--------------------|
| `synced-object` | Ownership-aware transform and rigidbody synchronization | Unity authoring, Visual Scripting, WebRoot |
| `interaction` | Grab, release, held input, click, collision, and trigger behavior | Unity authoring, Visual Scripting |
| `ui` | Panels, controls, hierarchy, events, values, and styles | Unity authoring, Visual Scripting |
| `audio` | Spatial playback, URL loading, and spectrum analysis | Unity authoring, Visual Scripting, WebRoot |
| `networking` | OneShot messages, shared properties, and join/leave behavior | Visual Scripting, WebRoot |
| `webroot` | Built-scene JavaScript with readiness and cleanup contracts | WebRoot |

## Execution Contract

Every workflow begins with `get_bridge_status`, `get_banter_sdk_info`, and
`query_project_state`. The selected project's installed Banter package is the
runtime authority; the embedded catalogues are source-checked planning
evidence and can still differ from another SDK revision.

The client must choose the smallest applicable implementation surface and use
only tools returned by `tools/list`. It must report a missing capability rather
than bypassing a restricted profile or inventing another write path.

Visual Scripting changes run this gate:

1. Generate the smallest graph.
2. Run `validate_vs_graph` before writing.
3. Run `validate_vs_graph_in_unity` after writing to force Unity import and deserialization.
4. Run `validate_banter_visual_scripting` for Banter custom nodes.
5. Use `set_asset_reference` with property `nest.macro` when ScriptMachine attachment is requested, require `Unity.VisualScripting.ScriptGraphAsset` as the expected type, then verify the reference.
6. Inspect import status and Unity console diagnostics.

WebRoot writes are structurally checked by `write_webroot_js`, but that is not
runtime proof. Scripts must wait for the documented Banter scene lifecycle,
clean up event subscriptions, and be tested in a built Banter scene.

## Prompts

Use `banter_workflow` with a `workflow` argument, or select one of the six
focused prompts such as `banter_ui_workflow`. The legacy interaction,
multiplayer, Visual Scripting, and best-practice prompts now route into the same
evidence-linked contracts.

The launcher preset **Banter workflow** enables `core,banter`. A narrower
custom profile remains valid when the selected path does not require scene
authoring.
