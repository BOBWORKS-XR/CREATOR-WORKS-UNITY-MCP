/**
 * Evidence-linked SideQuest SDK workflows for MCP clients.
 *
 * These recipes reference the source-checked component and custom-node
 * catalogues by name. Tests fail if a referenced capability disappears.
 */

export const BANTER_WORKFLOW_IDS = [
  "synced-object",
  "interaction",
  "ui",
  "audio",
  "networking",
  "webroot",
] as const;

export type BanterWorkflowId = typeof BANTER_WORKFLOW_IDS[number];

export interface BanterWorkflowPath {
  id: string;
  surface: "unity-authoring" | "visual-scripting" | "webroot";
  useWhen: string;
  requiredToolGroups: string[];
  requiredTools: string[];
  steps: string[];
}

export interface BanterWorkflow {
  id: BanterWorkflowId;
  title: string;
  purpose: string;
  evidence: {
    components: string[];
    customVisualScriptingNodes: string[];
    javascriptApi: string[];
  };
  paths: BanterWorkflowPath[];
  constraints: string[];
  completionEvidence: string[];
}

export const BANTER_WORKFLOW_CONTRACT = {
  authority: [
    "Treat the selected project's installed Creator SDK or Banter SDK package as authoring authority, and the target hosted client as runtime authority.",
    "The resource URIs and catalogue keys retain legacy Banter names for client compatibility. Resolve them through get_banter_sdk_info before authoring: Creator uses BS.* and BS.VisualScripting; legacy Banter uses Banter.SDK.* and Banter.VisualScripting.",
    "Treat banter://components, banter://custom-vs-nodes, and banter://js-api as source-checked planning evidence, not proof that every nearby SDK revision or compatibility alias is accepted by a hosted runtime.",
  ],
  preflight: [
    "Use get_bridge_status and stop on a stale, missing, or mismatched bridge.",
    "Use get_banter_sdk_info before relying on catalogue coverage or custom nodes, then record its sdkProfile and selected namespaces.",
    "Use query_project_state before selecting objects or changing components.",
    "Choose one implementation surface deliberately; do not duplicate behavior in Visual Scripting and WebRoot unless the design requires both.",
    "Use only tools returned by tools/list. If the selected path is unavailable, report the missing capability instead of inventing a write path.",
  ],
  visualScriptingGate: [
    "Generate the smallest graph that implements the requested behavior.",
    "Run validate_vs_graph before writing.",
    "After writing, run validate_vs_graph_in_unity to force import and deserialization.",
    "For SideQuest custom nodes, run validate_banter_visual_scripting against the imported graph; the legacy tool name invokes the selected Creator SDK or Banter SDK validator.",
    "Confirm the intended ScriptMachine references the graph asset. Use set_asset_reference with property nest.macro when attachment is requested, enforce Unity.VisualScripting.ScriptGraphAsset as the expected type, and re-query the component.",
    "Inspect check_import_status and get_console_logs before reporting the graph ready to test.",
  ],
  webRootGate: [
    "Wait for the documented lifecycle event for the selected target runtime before accessing runtime objects.",
    "Pair every event subscription with a cleanup path when the script can be reloaded or torn down.",
    "Treat write_webroot_js structural checks as preflight only; verify behavior in the built target scene.",
  ],
} as const;

export const BANTER_WORKFLOWS: Record<BanterWorkflowId, BanterWorkflow> = {
  "synced-object": {
    id: "synced-object",
    title: "Synced Object",
    purpose: "Add ownership-aware transform or rigidbody synchronization to an existing scene object.",
    evidence: {
      components: ["BanterSyncedObject", "BanterRigidbody"],
      customVisualScriptingNodes: ["OnGrab", "OnRelease"],
      javascriptApi: [
        "GameObject.GetComponent",
        "BanterSyncedObject.RequestOwnership",
        "BanterSyncedObject.ReleaseOwnership",
      ],
    },
    paths: [
      {
        id: "component-setup",
        surface: "unity-authoring",
        useWhen: "The object and its interaction logic already exist and only component configuration is missing.",
        requiredToolGroups: ["read", "author"],
        requiredTools: ["query_project_state", "add_component", "set_component_property", "get_console_logs"],
        steps: [
          "Resolve the object by stable global ID and inspect existing Rigidbody and Banter components.",
          "Add BanterSyncedObject only when it is absent.",
          "Set syncPosition, syncRotation, syncScale, and syncVelocity explicitly from the requested behavior.",
          "Re-query the object and inspect Unity errors.",
        ],
      },
      {
        id: "ownership-graph",
        surface: "visual-scripting",
        useWhen: "Ownership must be requested and released from graph-driven grab behavior.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: [
          "generate_vs_graph", "validate_vs_graph", "write_vs_graph",
          "validate_vs_graph_in_unity", "validate_banter_visual_scripting",
          "set_asset_reference", "check_import_status", "get_console_logs",
        ],
        steps: [
          "Use OnGrab and OnRelease events from the selected SDK catalogue.",
          "Resolve BanterSyncedObject through the documented InvokeMember/GetComponent pattern.",
          "Invoke RequestOwnership on grab and ReleaseOwnership on release only when release matches the requested ownership policy.",
          "Run the complete Visual Scripting gate.",
        ],
      },
      {
        id: "ownership-webroot",
        surface: "webroot",
        useWhen: "Existing WebRoot JavaScript owns the runtime behavior.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: ["write_webroot_js", "check_import_status", "get_console_logs"],
        steps: [
          "Resolve the object after the Banter scene reports it is ready.",
          "Get BanterSyncedObject, request ownership before mutation, and make release policy explicit.",
          "Write the smallest project-local script and test it in a built Banter scene.",
        ],
      },
    ],
    constraints: [
      "Only the owner should mutate synchronized properties.",
      "World and local transforms are different contracts for parented objects; preserve the requested space.",
      "When respawning a rigidbody, decide explicitly whether velocity and angularVelocity must be cleared.",
    ],
    completionEvidence: [
      "The exact sync flags and ownership policy are reported.",
      "The target object is re-read by stable ID after component changes.",
      "Unity import and console diagnostics are clean for any generated graph.",
    ],
  },

  interaction: {
    id: "interaction",
    title: "VR Interaction",
    purpose: "Build grab, release, held-input, click, collision, or trigger behavior.",
    evidence: {
      components: ["BanterGrababble", "BanterGrabHandle", "BanterRigidbody", "BanterColliderEvents"],
      customVisualScriptingNodes: ["OnGrab", "OnRelease", "OnGunTrigger", "OnClick", "OnBanterTriggerEnter"],
      javascriptApi: ["GameObject.On", "GameObject.GetComponent"],
    },
    paths: [
      {
        id: "interaction-components",
        surface: "unity-authoring",
        useWhen: "The scene object needs the physical and Banter component prerequisites for interaction.",
        requiredToolGroups: ["read", "author"],
        requiredTools: [
          "query_project_state", "get_object_bounds", "add_component", "set_component_property", "get_console_logs",
        ],
        steps: [
          "Inspect geometry, bounds, colliders, Rigidbody state, and existing Banter components.",
          "Choose BanterGrababble for full held input or BanterGrabHandle for a defined grab point.",
          "Add physics and collider-event components only when required by the requested events.",
          "Set held-input blocking flags only for inputs the behavior intentionally captures.",
        ],
      },
      {
        id: "interaction-graph",
        surface: "visual-scripting",
        useWhen: "The interaction behavior belongs in a Script Graph.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: [
          "generate_vs_graph", "validate_vs_graph", "write_vs_graph",
          "validate_vs_graph_in_unity", "validate_banter_visual_scripting",
          "set_asset_reference", "check_import_status", "get_console_logs",
        ],
        steps: [
          "Select event nodes from the installed SDK evidence and connect only required outputs.",
          "Keep the graph event-driven and avoid per-frame polling unless the behavior genuinely needs it.",
          "Run the complete Visual Scripting gate.",
        ],
      },
    ],
    constraints: [
      "Do not assume a grab event will fire without a compatible grab component.",
      "Do not enable trigger or button capture globally when only one held input is needed.",
      "Collider shape and Rigidbody configuration must match the object's actual geometry and motion.",
    ],
    completionEvidence: [
      "Required components and captured inputs are enumerated.",
      "The event source and target object are identified by stable ID.",
      "Graph import, SDK validation, and Unity console results are reported.",
    ],
  },

  ui: {
    id: "ui",
    title: "Banter UI",
    purpose: "Create or modify a Banter UI panel, controls, events, hierarchy, values, and styles.",
    evidence: {
      components: ["BanterUIPanel"],
      customVisualScriptingNodes: [
        "CreateUIPanel", "CreateUIButton", "CreateUILabel", "AttachUIChild",
        "RegisterUIClick", "OnUIClick", "SetUIText", "SetUIValue", "SetUIVisible",
      ],
      javascriptApi: [],
    },
    paths: [
      {
        id: "ui-panel-component",
        surface: "unity-authoring",
        useWhen: "A scene object needs a BanterUIPanel or panel dimensions/feedback settings changed.",
        requiredToolGroups: ["read", "author"],
        requiredTools: ["query_project_state", "add_component", "set_component_property", "get_console_logs"],
        steps: [
          "Inspect the target object and existing UI components.",
          "Add BanterUIPanel only if absent and set width, height, haptics, and sounds explicitly.",
          "Re-read the component and inspect Unity errors.",
        ],
      },
      {
        id: "ui-graph",
        surface: "visual-scripting",
        useWhen: "Controls, events, hierarchy, values, or styles are created through Banter custom nodes.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: [
          "generate_vs_graph", "validate_vs_graph", "write_vs_graph",
          "validate_vs_graph_in_unity", "validate_banter_visual_scripting",
          "set_asset_reference", "check_import_status", "get_console_logs",
        ],
        steps: [
          "Give every referenced element a stable, unique ID or name.",
          "Create the panel and elements before attaching children or registering events.",
          "Use Auto Register deliberately; do not duplicate explicit registration.",
          "Run the complete Visual Scripting gate.",
        ],
      },
    ],
    constraints: [
      "Element IDs and names are runtime contracts; avoid empty identifiers when later nodes reference them.",
      "Do not mix screen-space and world-space assumptions.",
      "Treat the custom-node catalogue defaults as serialized examples and verify the selected SDK revision.",
    ],
    completionEvidence: [
      "The panel space, resolution or dimensions, and element identifiers are reported.",
      "Every event registration has a matching target element.",
      "The imported graph passes both Unity deserialization and Banter SDK validation.",
    ],
  },

  audio: {
    id: "audio",
    title: "Banter Audio",
    purpose: "Configure spatial audio playback or graph-driven audio loading and analysis.",
    evidence: {
      components: ["BanterAudioSource"],
      customVisualScriptingNodes: ["LoadAudioUrl", "AudioListenerSpectrumData", "AudioSourceSpectrumData"],
      javascriptApi: ["BanterAudioSource.Play", "BanterAudioSource.Stop", "BanterAudioSource.Pause"],
    },
    paths: [
      {
        id: "audio-component",
        surface: "unity-authoring",
        useWhen: "Playback settings belong on a scene component.",
        requiredToolGroups: ["read", "author"],
        requiredTools: ["query_project_state", "add_component", "set_component_property", "get_console_logs"],
        steps: [
          "Inspect existing audio components and target position.",
          "Set URL, volume, pitch, loop, playOnAwake, spatialBlend, minDistance, and maxDistance explicitly as needed.",
          "Re-read the component and inspect Unity errors.",
        ],
      },
      {
        id: "audio-graph",
        surface: "visual-scripting",
        useWhen: "Runtime URL loading or spectrum data belongs in Visual Scripting.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: [
          "generate_vs_graph", "validate_vs_graph", "write_vs_graph",
          "validate_vs_graph_in_unity", "validate_banter_visual_scripting",
          "set_asset_reference", "check_import_status", "get_console_logs",
        ],
        steps: [
          "Choose LoadAudioUrl for runtime loading or a spectrum node for analysis.",
          "Provide an explicit AudioType, channel count, and FFT window when those nodes are used.",
          "Run the complete Visual Scripting gate.",
        ],
      },
      {
        id: "audio-webroot",
        surface: "webroot",
        useWhen: "Playback is controlled by existing WebRoot runtime logic.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: ["write_webroot_js", "check_import_status", "get_console_logs"],
        steps: [
          "Resolve or create the audio object after the Banter scene is ready.",
          "Configure BanterAudioSource and call only documented playback methods.",
          "Test loading, attenuation, and cleanup in a built Banter scene.",
        ],
      },
    ],
    constraints: [
      "spatialBlend 0 is 2D and 1 is fully 3D; choose it explicitly.",
      "A URL that imports or parses successfully is not proof that runtime loading or CORS will succeed.",
      "Spectrum analysis should not be polled more frequently than the behavior requires.",
    ],
    completionEvidence: [
      "Playback source, spatial mode, looping, and distance behavior are reported.",
      "Runtime URL loading is tested in the target Banter environment.",
      "Generated graphs pass import and SDK validation.",
    ],
  },

  networking: {
    id: "networking",
    title: "Banter Networking",
    purpose: "Implement transient messages, persistent space properties, or user join/leave behavior.",
    evidence: {
      components: ["BanterSyncedObject"],
      customVisualScriptingNodes: [
        "OnOneShot", "SendOneShot", "OnSpaceStatePropsChanged", "SetSpaceStateProp",
        "OnUserJoined", "OnUserLeft",
      ],
      javascriptApi: [
        "BanterScene.OneShot", "BanterScene.SetPublicSpaceProps", "BanterScene.SetProtectedSpaceProps",
        "BanterScene.On", "BanterScene.Off",
      ],
    },
    paths: [
      {
        id: "networking-graph",
        surface: "visual-scripting",
        useWhen: "Messaging or space state belongs in a Script Graph.",
        requiredToolGroups: ["read", "author", "banter"],
        requiredTools: [
          "generate_vs_graph", "validate_vs_graph", "write_vs_graph",
          "validate_vs_graph_in_unity", "validate_banter_visual_scripting",
          "set_asset_reference", "check_import_status", "get_console_logs",
        ],
        steps: [
          "Choose OneShot for transient messages or a space-state property for persistent shared state.",
          "Define the message or property schema before connecting sender and receiver nodes.",
          "Set All Instances and public/protected behavior explicitly from the requested scope.",
          "Run the complete Visual Scripting gate.",
        ],
      },
      {
        id: "networking-webroot",
        surface: "webroot",
        useWhen: "Networking is coordinated by WebRoot JavaScript.",
        requiredToolGroups: ["read", "banter"],
        requiredTools: ["write_webroot_js", "check_import_status", "get_console_logs"],
        steps: [
          "Define and validate a bounded payload schema before sending data.",
          "Use OneShot for transient events and public/protected space props for persistent state.",
          "Subscribe after scene readiness and unregister handlers on cleanup.",
          "Test with at least two clients before reporting synchronization complete.",
        ],
      },
    ],
    constraints: [
      "Do not use OneShot as persistent state.",
      "Treat incoming payloads as untrusted and validate their shape before use.",
      "Public and protected space properties have different authority expectations; select deliberately.",
    ],
    completionEvidence: [
      "The payload/property schema and authority model are documented.",
      "Sender and receiver paths are tested with multiple clients.",
      "Event handlers have an explicit cleanup path.",
    ],
  },

  webroot: {
    id: "webroot",
    title: "WebRoot Runtime",
    purpose: "Add project-local Banter JavaScript without duplicating scene or graph behavior.",
    evidence: {
      components: ["BanterObjectId"],
      customVisualScriptingNodes: [],
      javascriptApi: [
        "BanterScene.GetInstance", "BanterScene.Find", "BanterScene.FindByPath",
        "BanterScene.On", "BanterScene.Off", "GameObject.On",
      ],
    },
    paths: [
      {
        id: "webroot-runtime",
        surface: "webroot",
        useWhen: "The behavior belongs in built-scene JavaScript.",
        requiredToolGroups: ["read", "banter"],
        requiredTools: ["query_project_state", "write_webroot_js", "check_import_status", "get_console_logs"],
        steps: [
          "Inspect existing WebRoot files and object IDs before creating a new runtime entry point.",
          "Get the BanterScene singleton and wait for the documented readiness event.",
          "Resolve objects by stable BanterObjectId where possible and fail clearly when an object is absent.",
          "Write the smallest file, inspect import/console state, then test in a built Banter scene.",
        ],
      },
    ],
    constraints: [
      "Do not assume browser DOM or module-loader APIs exist unless the target runtime proves it.",
      "Do not duplicate behavior already owned by a Script Graph.",
      "Keep event callback references so subscriptions can be removed with Off.",
    ],
    completionEvidence: [
      "The entry point, readiness event, referenced object IDs, and cleanup policy are reported.",
      "The script remains inside Assets/WebRoot.",
      "Built-scene runtime behavior, not only static syntax, is tested.",
    ],
  },
};

export function renderBanterWorkflowPrompt(id: BanterWorkflowId, goal?: string): string {
  const workflow = BANTER_WORKFLOWS[id];
  const goalLine = goal?.trim() ? `\nRequested outcome: ${goal.trim()}\n` : "";
  const pathSummary = workflow.paths.map((path) =>
    `- ${path.id} (${path.surface}; groups: ${path.requiredToolGroups.join(",")}): ${path.useWhen}`
  ).join("\n");

  return `Execute the Creator Works MCP ${workflow.title} workflow in the selected Unity project.
${goalLine}
Use get_mcp_reference with source workflows and entryId ${id} for the '${id}' contract.
Retrieve only its relevant component or JavaScript entries with get_mcp_reference,
and custom node definitions with search_sidequest_vs_nodes. Follow continuation
offsets when an entry is partial. Run get_bridge_status, get_banter_sdk_info,
and query_project_state before changing anything.

Use the sdkProfile and namespaces returned by get_banter_sdk_info. Catalogue
component names are legacy compatibility keys; emit concrete BS types for a
Creator profile and Banter types for a legacy profile. Do not migrate existing
assets merely because compatibility aliases compile.

Choose the smallest applicable implementation path:
${pathSummary}

Use only tools currently present in tools/list. Stop and report the exact
missing capability or SDK evidence if a required path is unavailable. Preserve
unrelated project changes. Apply the workflow's validation gates, then report
the stable target IDs, files/components changed, validation evidence, and any
remaining runtime test that cannot be automated.`;
}
