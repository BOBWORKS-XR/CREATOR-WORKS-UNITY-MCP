#!/usr/bin/env node
/**
 * Creator Works MCP Server
 *
 * Full-featured MCP server for Unity, Creator SDK, and Banter development.
 * Provides closed-loop integration with Unity Editor.
 *
 * Usage:
 *   stdio mode (default): node dist/index.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  registerTools,
  handleToolCall,
  parseToolGroupSelection,
  describeToolGroupSelection,
  type ToolGroupSelection,
} from "./tools/index.js";
import { registerResources, handleResourceRead } from "./resources/index.js";
import { registerPrompts, handlePromptGet } from "./prompts/index.js";
import { getConfig } from "./lib/config.js";
import { UnityProjectRouter } from "./lib/project-router.js";
import { MCP_VERSION } from "./lib/version.js";

const projectRouter = new UnityProjectRouter(getConfig());
let toolGroupSelection: ToolGroupSelection = "all";

// Create MCP server
const server = new Server(
  {
    name: "creator-works-mcp",
    version: MCP_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registerTools(toolGroupSelection) };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const requestConfig = projectRouter.getActiveConfig();
  return handleToolCall(
    request.params.name,
    request.params.arguments ?? {},
    requestConfig,
    projectRouter,
    toolGroupSelection
  );
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: registerResources(projectRouter.getActiveConfig()) };
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return handleResourceRead(request.params.uri, projectRouter.getActiveConfig());
});

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: registerPrompts() };
});

// Get prompt content
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return handlePromptGet(request.params.name, request.params.arguments ?? {});
});

// Start server
async function main() {
  toolGroupSelection = parseToolGroupSelection(
    process.env.CREATOR_WORKS_TOOL_GROUPS ?? process.env.BANTWORKS_TOOL_GROUPS
  );
  const args = process.argv.slice(2);
  const useHttp = args.includes("--http");

  if (useHttp) {
    console.error("Creator Works MCP HTTP transport is not implemented. Use stdio mode: node dist/index.js");
    process.exit(1);
  } else {
    // Stdio transport for Codex, Claude Code, and other MCP clients.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `Creator Works MCP running on stdio (tool groups: ${describeToolGroupSelection(toolGroupSelection)})`
    );
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
