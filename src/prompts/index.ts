/** MCP prompts for evidence-linked Unity and Banter workflows. */

import {
  BANTER_WORKFLOW_IDS,
  BANTER_WORKFLOWS,
  renderBanterWorkflowPrompt,
  type BanterWorkflowId,
} from "../resources/banter-workflows.js";

interface Prompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

const WORKFLOW_PROMPTS: Record<string, BanterWorkflowId> = {
  banter_synced_object_workflow: "synced-object",
  banter_interaction_workflow: "interaction",
  banter_ui_workflow: "ui",
  banter_audio_workflow: "audio",
  banter_networking_workflow: "networking",
  banter_webroot_workflow: "webroot",
};

export function registerPrompts(): Prompt[] {
  const focused = Object.entries(WORKFLOW_PROMPTS).map(([name, id]) => ({
    name,
    description: `Execute the source-checked ${BANTER_WORKFLOWS[id].title} workflow`,
    arguments: [
      { name: "goal", description: "Specific behavior or outcome to implement", required: false },
    ],
  }));

  return [
    ...focused,
    {
      name: "banter_workflow",
      description: "Execute a focused Banter workflow by domain",
      arguments: [
        { name: "workflow", description: `One of: ${BANTER_WORKFLOW_IDS.join(", ")}`, required: true },
        { name: "goal", description: "Specific behavior or outcome to implement", required: false },
      ],
    },
    {
      name: "create_interactive_object",
      description: "Create a VR object using the evidence-linked interaction workflow",
      arguments: [
        { name: "objectType", description: "Type of object", required: false },
        { name: "interactions", description: "Requested grab, input, collision, or trigger behavior", required: false },
      ],
    },
    {
      name: "create_vs_graph",
      description: "Create and fully validate a Unity Visual Scripting graph",
      arguments: [
        { name: "purpose", description: "What the graph should do", required: false },
      ],
    },
    {
      name: "debug_vs_graph",
      description: "Diagnose a Visual Scripting graph through server, Unity, and Banter SDK validation",
      arguments: [
        { name: "symptoms", description: "Observed errors or behavior", required: false },
      ],
    },
    {
      name: "multiplayer_sync",
      description: "Choose between synced objects, transient messages, and persistent space state",
      arguments: [
        { name: "whatToSync", description: "Object, event, or state to synchronize", required: false },
      ],
    },
    {
      name: "banter_best_practices",
      description: "Apply the MCP's source-checked Banter workflow and validation contract",
      arguments: [],
    },
  ];
}

export function handlePromptGet(
  name: string,
  args: Record<string, unknown>
): { messages: PromptMessage[] } {
  const focusedWorkflow = WORKFLOW_PROMPTS[name];
  if (focusedWorkflow) {
    return userPrompt(renderBanterWorkflowPrompt(focusedWorkflow, stringArg(args, "goal")));
  }

  switch (name) {
    case "banter_workflow": {
      const workflow = stringArg(args, "workflow");
      if (!workflow || !BANTER_WORKFLOW_IDS.includes(workflow as BanterWorkflowId)) {
        throw new Error(`workflow must be one of: ${BANTER_WORKFLOW_IDS.join(", ")}`);
      }
      return userPrompt(renderBanterWorkflowPrompt(workflow as BanterWorkflowId, stringArg(args, "goal")));
    }

    case "create_interactive_object": {
      const objectType = stringArg(args, "objectType") || "object";
      const interactions = stringArg(args, "interactions") || "grab and release";
      return userPrompt(renderBanterWorkflowPrompt(
        "interaction",
        `Create a ${objectType} with ${interactions}.`
      ));
    }

    case "create_vs_graph":
      return userPrompt(graphPrompt("create", stringArg(args, "purpose") || "the requested behavior"));

    case "debug_vs_graph":
      return userPrompt(graphPrompt("debug", stringArg(args, "symptoms") || "the reported failure"));

    case "multiplayer_sync": {
      const goal = stringArg(args, "whatToSync") || "the requested multiplayer behavior";
      return userPrompt(
        `First classify '${goal}' as a synchronized object's transform/physics, a transient message, or persistent space state. ` +
        `Then use get_mcp_reference with source workflows and entryId synced-object for the first case or networking for the other cases. ` +
        "Do not implement both paths unless the requested behavior needs both."
      );
    }

    case "banter_best_practices":
      return userPrompt(
        "Use get_mcp_reference with source workflows to retrieve the relevant domain and its authority, preflight, Visual Scripting, and WebRoot gates. " +
        "Use get_banter_sdk_info to separate source-checked catalogue evidence from the selected project's installed SDK. " +
        "Choose the smallest focused workflow and produce concrete validation evidence instead of advisory-only output."
      );

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

function graphPrompt(mode: "create" | "debug", detail: string): string {
  const action = mode === "create" ? "Create" : "Diagnose and repair";
  return `${action} a Unity Visual Scripting graph for ${detail}. Run
get_banter_sdk_info to identify the selected SDK. Use get_mcp_reference with
source manual for the exact serialization rule needed; its compatibility
corrections override conflicting older examples. For SideQuest custom nodes,
use search_sidequest_vs_nodes to retrieve only the relevant definitions.
Continue partial reference entries when needed and reuse unchanged excerpts
already available in this task. Complete catalogs are for explicitly requested
exhaustive audits. Use the smallest graph possible. Run validate_vs_graph
before any write, then validate_vs_graph_in_unity after import. Run
validate_banter_visual_scripting for Banter custom nodes, and inspect
check_import_status plus get_console_logs before reporting the graph ready to
test. Preserve the asset GUID when repairing an existing graph.`;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  return typeof args[name] === "string" ? args[name].trim() : undefined;
}

function userPrompt(text: string): { messages: PromptMessage[] } {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}
