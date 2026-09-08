/**
 * MCP Resources - Knowledge and state available to connected MCP clients
 */

import * as fs from "fs";
import * as path from "path";
import type { BanterMCPConfig } from "../lib/config.js";
import { BANTER_COMPONENTS, BANTER_COMPONENT_CATALOG_METADATA } from "./banter-components.js";
import { BANTER_VS_NODES } from "./banter-vs-nodes.js";
import { BANTER_CUSTOM_VS_NODES, BANTER_CUSTOM_VS_NODE_LOG } from "./banter-custom-vs-nodes.js";
import { BANTER_JS_API } from "./banter-js-api.js";
import { UNITY_TYPES } from "./unity-types.js";
import { VS_GRAPH_INSTRUCTIONS } from "./vs-graph-instructions.js";
import { UNITY_VS_JSON_MANUAL } from "./unity-vs-json-manual.js";
import { UNITY_VS_JSON_ERRATA } from "./unity-vs-json-errata.js";
import { BANTER_SDK_COMPATIBILITY } from "./banter-sdk-compatibility.js";
import { BANTER_WORKFLOW_CONTRACT, BANTER_WORKFLOWS } from "./banter-workflows.js";
import {
  ALWAYS_AVAILABLE_TOOLS,
  TOOL_GROUP_MEMBERSHIP,
  TOOL_GROUP_NAMES,
} from "../tools/tool-groups.js";

/**
 * System prompt that guides connected MCP clients during SideQuest SDK development
 */
const BANTER_SYSTEM_PROMPT = `# Creator Works MCP - Proactive Unity Development Assistant

You are connected to a Unity project through Creator Works MCP. You have DIRECT ACCESS to create, modify, and manage Unity GameObjects and Visual Scripting graphs, with first-class knowledge of both the legacy Banter SDK and the Creator SDK/BS contract.

## CRITICAL: Detect the SDK Contract Before Authoring

Run \`get_banter_sdk_info\` before adding SideQuest components, creating custom Visual Scripting nodes, or proposing a migration. The tool name is retained for client compatibility, but its \`sdkProfile\` result covers both package families:

- \`creator\`: author new content with concrete \`BS.*\` component types and \`BS.VisualScripting.*\` nodes.
- \`banter\`: author with \`Banter.SDK.*\` component types and \`Banter.VisualScripting.*\` nodes.
- \`hybrid\`: prefer the Creator SDK contract for new content, preserve existing legacy content, and validate both before changing it.
- \`none\` or \`unknown\`: do not guess a SideQuest namespace; restrict work to Unity built-ins or report the missing package state.

Legacy aliases inside the Creator SDK are migration inputs, not proof that a hosted target supports those legacy types. Never perform blanket text replacement in scenes, prefabs, or graph assets. Any migration must use an explicit source-to-target mapping, duplicated assets, Unity serialization APIs, and post-import validation.

## CRITICAL: Be Proactive, Not Advisory

**DO things, don't just explain how to do them.**

The server may expose a limited capability profile. Use only tools present in
\`tools/list\`; a missing tool is intentionally unavailable, not a reason to
invent an equivalent write path.

### Instead of:
- "You could add a BanterGrababble component..."
- "Here's how you would create a cube..."
- "You might want to add physics..."

### DO THIS:
- Use \`create_gameobject\` to CREATE the object directly
- Use \`generate_vs_graph\` + \`write_vs_graph\` to CREATE the behavior
- Use \`modify_gameobject\` to ADJUST transforms
- Then tell the user what you did

## Your Workflow

When the user asks for something in their scene:

1. **Detect the SDK contract** - Run \`get_banter_sdk_info\` and follow its \`sdkProfile\`, namespaces, and authoring policy
2. **Choose a workflow** - Use \`get_mcp_reference\` with source \`workflows\` for the relevant domain; retrieve only its relevant evidence entries
3. **Query first** - Use \`get_bridge_status\` and \`query_project_state\`
4. **Create/modify** - Use the smallest applicable implementation path
5. **Verify** - Apply the workflow's import, selected-SDK, console, and runtime gates
6. **Report** - Give the detected SDK profile, stable target IDs, exact changes, validation evidence, and remaining runtime tests

## Available Actions

### Scene Manipulation
- \`create_gameobject\` - Create cubes, spheres, empty objects, etc.
- \`delete_gameobject\` - Remove objects from the scene
- \`modify_gameobject\` - Change position, rotation, scale
- \`set_asset_reference\` - Assign graph, material, texture, audio, prefab, and other Unity assets to component reference fields

### Visual Scripting
- \`generate_vs_graph\` - Create interaction logic
- \`validate_vs_graph\` - Check for errors
- \`write_vs_graph\` - Save to the project
- Before creating SideQuest Visual Scripting graphs, run \`get_banter_sdk_info\`, then use \`search_sidequest_vs_nodes\` for only the relevant node definitions.
- Use \`get_mcp_reference\` with source \`manual\` for exact serialization rules and compatibility corrections. Reuse unchanged excerpts already in this task; continue partial entries when needed. Complete manual/catalog resources are for explicitly requested exhaustive audits.
- Use real random GUIDs and canonical \`graph.elements\`. Referenced nodes need string \`$id\` values; connection \`$version\` may be omitted by Visual Scripting 1.9.x.
- Run \`get_banter_sdk_info\` before relying on the full node catalogue because package families, git revisions, and registry packages with nearby versions can contain different node sets and namespaces.

### C# Authoring Boundary
- Creator Works does not provide a tool that creates C# source files. The Custom Script Components setting only permits adding components from C# assemblies that the project has already compiled.
- When the requested runtime behavior belongs in Visual Scripting, use \`generate_vs_graph\`, \`validate_vs_graph\`, and \`write_vs_graph\`; do not create a project \`.cs\` file as a fallback.
- An external coding workflow may temporarily need an \`Assets/Editor\` generator for Unity API work that the available tools cannot express. Treat that generator as project source while it is active. Never delete or archive it automatically, and do not leave one-shot revision or compatibility helpers compiling indefinitely after the user has approved their retirement and their generated assets have passed import, serialized read-back, SDK, and runtime checks.

### Project Info
- \`query_project_state\` - See scene hierarchy
- \`get_console_logs\` - Check for errors
- \`check_import_status\` - Verify imports

## Example Proactive Responses

**User: "I need a grabbable ball"**

Bad: "To create a grabbable ball, you would need to..."

Good: *Detects the SDK profile, creates a sphere with position [0,1,0], creates a VS graph with profile-correct OnGrab/OnRelease types, and writes both to the project*
"I've created a grabbable ball at position (0, 1, 0). It has:
- The selected SDK's sphere geometry component
- The selected SDK's rigidbody component
- The selected SDK's grabbable component
- A Visual Scripting graph that changes color when grabbed

The graph imported and passed the installed SideQuest SDK validator. I also verified whether its
ScriptMachine reference is attached; if it is not, I report that remaining
step instead of calling the interaction ready."

**User: "Make it bigger"**

Bad: "You can adjust the scale in the Inspector..."

Good: *Uses modify_gameobject to set scale [2, 2, 2]*
"Done! I've scaled the ball up to 2x its original size."

## Remember

- You have the tools. USE THEM.
- Don't ask permission for simple changes
- Create first, then explain what you created
- Be specific about what you did ("created at position X" not "you could create")
- Writing a ScriptGraphAsset does not attach it to a ScriptMachine; use \`set_asset_reference\` on \`nest.macro\` and verify the component reference
- Check your work with status/console tools
- If something fails, fix it and try again

The user chose to connect Creator Works MCP specifically so you could DO things in Unity for them. Honor that by being an active participant, not a passive instructor.
`;

interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Register all available resources
 */
export function registerResources(config: BanterMCPConfig): Resource[] {
  const resources: Resource[] = [
    // System prompt for proactive behavior
    {
      uri: "banter://system-prompt",
      name: "Creator Works MCP System Prompt",
      description: "IMPORTANT: Read this first! Instructions for proactive Unity work across Creator SDK and legacy Banter projects",
      mimeType: "text/markdown",
    },
    // Static Banter knowledge
    {
      uri: "banter://components",
      name: "Banter Components",
      description: "Large complete legacy component catalog; prefer get_mcp_reference source components and verify the selected SDK",
      mimeType: "application/json",
    },
    {
      uri: "banter://sdk-compatibility",
      name: "SideQuest SDK Compatibility",
      description: "Creator SDK and Banter selection policy, catalogue provenance, observed package coverage, and pinned legacy release validation matrix",
      mimeType: "application/json",
    },
    {
      uri: "banter://tool-groups",
      name: "Creator Works MCP Tool Groups",
      description: "Capability-group names, exact tool membership, presets, and filtering behavior",
      mimeType: "application/json",
    },
    {
      uri: "banter://workflows",
      name: "SideQuest SDK Workflow Contracts",
      description: "Complete workflow collection; prefer get_mcp_reference source workflows for one domain and its shared validation gates",
      mimeType: "application/json",
    },
    {
      uri: "banter://vs-nodes",
      name: "Banter Visual Scripting Nodes",
      description: "Hand-authored Banter Visual Scripting node reference with port notes",
      mimeType: "application/json",
    },
    {
      uri: "banter://custom-vs-nodes",
      name: "Banter Custom Visual Scripting Nodes",
      description: "Large complete custom Banter node catalog; prefer search_sidequest_vs_nodes for bounded normal lookup",
      mimeType: "application/json",
    },
    {
      uri: "banter://custom-vs-node-log",
      name: "Banter Custom Visual Scripting Node Log",
      description: "Markdown log of every custom Banter Visual Scripting node, category, and serialized default value",
      mimeType: "text/markdown",
    },
    {
      uri: "banter://js-api",
      name: "Banter JavaScript API",
      description: "Complete BS.* JavaScript API reference for runtime scripting",
      mimeType: "application/json",
    },
    {
      uri: "banter://vs-instructions",
      name: "Visual Scripting Graph Instructions",
      description: "How to programmatically create Visual Scripting .asset files",
      mimeType: "text/markdown",
    },
    {
      uri: "banter://unity-vs-json-manual",
      name: "Unity Visual Scripting JSON Manual",
      description: "Large complete manual; prefer get_mcp_reference source manual for focused sections plus compatibility corrections",
      mimeType: "text/markdown",
    },
    {
      uri: "unity://types",
      name: "Unity Type Reference",
      description: "Unity fundamentals (Vector3, Quaternion, GameObject, etc.)",
      mimeType: "application/json",
    },
  ];

  // Dynamic project state (if Unity extension is installed)
  if (config.hasUnityExtension) {
    resources.push(
      {
        uri: "project://state",
        name: "Project State",
        description: "Large raw Unity scene snapshot; prefer bounded query_project_state for normal inspection",
        mimeType: "application/json",
      },
      {
        uri: "project://editor-state",
        name: "Editor State",
        description: "Unity editor play mode, compile state, active scene, and selected objects",
        mimeType: "application/json",
      },
      {
        uri: "project://console",
        name: "Console Logs",
        description: "Raw Unity console snapshot; prefer bounded get_console_logs for normal diagnostics",
        mimeType: "application/json",
      },
      {
        uri: "project://import-status",
        name: "Import Status",
        description: "Status of the last asset import operation",
        mimeType: "application/json",
      },
      {
        uri: "project://compilation-status",
        name: "Compilation Status",
        description: "Persistent Unity assembly compilation result and compiler diagnostics",
        mimeType: "application/json",
      },
      {
        uri: "project://prefab-catalog",
        name: "Prefab Catalog",
        description: "Raw prefab catalog; prefer bounded get_prefab_catalog for normal discovery",
        mimeType: "application/json",
      }
    );
  }

  return resources;
}

/**
 * Read resource content
 */
export function handleResourceRead(
  uri: string,
  config: BanterMCPConfig
): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  let content: string;
  let mimeType = "application/json";

  switch (uri) {
    // System prompt for proactive behavior
    case "banter://system-prompt":
      content = BANTER_SYSTEM_PROMPT;
      mimeType = "text/markdown";
      break;

    // Static Banter knowledge
    case "banter://components":
      content = JSON.stringify({ metadata: BANTER_COMPONENT_CATALOG_METADATA, components: BANTER_COMPONENTS }, null, 2);
      break;

    case "banter://sdk-compatibility":
      content = JSON.stringify(BANTER_SDK_COMPATIBILITY, null, 2);
      break;

    case "banter://tool-groups":
      content = JSON.stringify({
        environmentVariable: "CREATOR_WORKS_TOOL_GROUPS",
        legacyEnvironmentVariable: "BANTWORKS_TOOL_GROUPS",
        default: "all",
        serverDefaultWhenUnset: "all",
        launcherDefault: "core",
        specialValues: {
          all: "Expose all tools",
          none: "Expose only project routing and bridge health tools",
        },
        alwaysAvailable: [...ALWAYS_AVAILABLE_TOOLS],
        groups: Object.fromEntries(
          TOOL_GROUP_NAMES.map((group) => [group, [...TOOL_GROUP_MEMBERSHIP[group]]])
        ),
        launcherProfiles: {
          tokenSaver: "core",
          full: "all",
          inspection: "read",
          banterWorkflow: "core,banter",
          shaderGraphPreview: "core,shadergraph",
          unityAuthoring: "core,author",
          testing: "core,test",
          minimalRouting: "none",
        },
      }, null, 2);
      break;

    case "banter://workflows":
      content = JSON.stringify({
        contract: BANTER_WORKFLOW_CONTRACT,
        workflows: BANTER_WORKFLOWS,
      }, null, 2);
      break;

    case "banter://vs-nodes":
      content = JSON.stringify(BANTER_VS_NODES, null, 2);
      break;

    case "banter://custom-vs-nodes":
      content = JSON.stringify(BANTER_CUSTOM_VS_NODES, null, 2);
      break;

    case "banter://custom-vs-node-log":
      content = BANTER_CUSTOM_VS_NODE_LOG;
      mimeType = "text/markdown";
      break;

    case "banter://js-api":
      content = JSON.stringify(BANTER_JS_API, null, 2);
      break;

    case "banter://vs-instructions":
      content = VS_GRAPH_INSTRUCTIONS;
      mimeType = "text/markdown";
      break;

    case "banter://unity-vs-json-manual":
      content = `${UNITY_VS_JSON_ERRATA}\n\n---\n\n${UNITY_VS_JSON_MANUAL}`;
      mimeType = "text/markdown";
      break;

    case "unity://types":
      content = JSON.stringify(UNITY_TYPES, null, 2);
      break;

    // Dynamic project state
    case "project://state":
      content = readProjectFile(config.mcpStatePath, "scene-hierarchy.json");
      break;

    case "project://editor-state":
      content = readProjectFile(config.mcpStatePath, "editor-state.json");
      break;

    case "project://console":
      content = readProjectFile(config.mcpStatePath, "console-log.json");
      break;

    case "project://import-status":
      content = readProjectFile(config.mcpStatePath, "import-status.json");
      break;

    case "project://compilation-status":
      content = readProjectFile(config.mcpStatePath, "compilation-status.json");
      break;

    case "project://prefab-catalog":
      content = readProjectFile(config.mcpStatePath, "prefab-catalog.json");
      break;

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }

  return {
    contents: [{ uri, mimeType, text: content }],
  };
}

/**
 * Read a file from the project state directory
 */
function readProjectFile(stateDir: string, filename: string): string {
  const filePath = path.join(stateDir, filename);

  if (!fs.existsSync(filePath)) {
    return JSON.stringify({
      error: "File not found",
      message: `${filename} does not exist. Is Unity Editor running with the BanterMCPBridge extension?`,
      path: filePath,
    });
  }

  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    return JSON.stringify({
      error: "Read error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
