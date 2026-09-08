#!/usr/bin/env node
// Cross-platform CLI entry point for the Creator Works MCP setup.
// Mirrors setup.ps1 on Windows and is invoked from setup.sh on Linux/macOS.
//
// Subcommands:
//   install             Validate / build the MCP server bundle
//   add-project         Add a Unity project to the launcher config
//   list-projects       Print configured projects
//   set-active          Set the active Unity project
//   remove-project      Remove a Unity project from the launcher config
//   set-profile <name>  Set the capability profile (all|none|core,read,author,test,banter,shadergraph)
//   apply-claude        Apply the active project to Claude Code (~/.claude.json)
//   apply-codex         Apply the active project to Codex (~/.codex/config.toml)
//   install-bridge      Install the Unity editor extension into the active project
//   config-path         Print the resolved launcher config path

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync as existsSyncLocal } from "node:fs";
import {
  addProject,
  applyToAntigravity,
  applyToClaudeCode,
  applyToCodex,
  applyToOpenCode,
  buildContext,
  configPathFor,
  installUnityExtension,
  listProjects,
  loadConfig,
  removeProject,
  setActiveProject,
  setCapabilityProfile,
} from "./setup-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(__dirname, "..", "..");

function usage() {
  console.log(`Usage: node scripts/cli/setup.mjs <subcommand> [args]

Subcommands:
  install                              Validate / build the MCP server bundle
  add-project <name> <projectPath>     Add a Unity project to the launcher config
  list-projects                        Print configured projects
  set-active <index>                   Set the active Unity project (1-based index)
  remove-project <index>               Remove a Unity project (1-based index)
  set-profile <name>                   Set the capability profile (all|none|core,read,author,test,banter,shadergraph)
  apply-claude                         Apply to Claude Code
  apply-codex                          Apply to Codex
  apply-antigravity                    Apply to Antigravity
  apply-opencode                       Apply to OpenCode
  install-bridge                       Install the Unity editor extension
  config-path                          Print the resolved launcher config path
  help                                 Show this message
`);
}

function parseArgs(argv) {
  return argv.slice(2);
}

async function run() {
  const args = parseArgs(process.argv);
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const context = buildContext({ mcpRoot });

  switch (command) {
    case "install":
      await runInstall(context);
      return;
    case "add-project": {
      const [name, projectPath] = args.slice(1);
      const channel = addProject(context, { name, projectPath });
      console.log(`Added project ${channel.name} (${channel.id}).`);
      return;
    }
    case "list-projects": {
      const channels = listProjects(context);
      if (channels.length === 0) {
        console.log("No projects configured.");
        return;
      }
      const config = loadConfig(context);
      for (let i = 0; i < channels.length; i++) {
        const marker = channels[i].id === config.active_channel_id ? "*" : " ";
        console.log(`${marker} ${i + 1}. ${channels[i].name} [${channels[i].id}]`);
        console.log(`     ${channels[i].unity_project_path}`);
      }
      return;
    }
    case "set-active": {
      const index = Number(args[1]);
      if (!Number.isFinite(index)) throw new Error("set-active requires a numeric index.");
      const channel = setActiveProject(context, { index: index - 1 });
      console.log(`Active project set to ${channel.name}.`);
      return;
    }
    case "remove-project": {
      const index = Number(args[1]);
      if (!Number.isFinite(index)) throw new Error("remove-project requires a numeric index.");
      const removed = removeProject(context, { index: index - 1 });
      console.log(`Removed ${removed.name}.`);
      return;
    }
    case "set-profile": {
      const profile = args[1];
      if (!profile) throw new Error("set-profile requires a profile name.");
      const applied = setCapabilityProfile(context, profile);
      console.log(`Tool groups set to: ${applied}`);
      return;
    }
    case "apply-claude": {
      const result = applyToClaudeCode(context);
      console.log(`Applied to Claude Code: ${result.path}`);
      console.log(`  Project: ${result.channel.name}`);
      return;
    }
    case "apply-codex": {
      const result = applyToCodex(context);
      console.log(`Applied to Codex: ${result.path}`);
      console.log(`  Project: ${result.channel.name}`);
      return;
    }
    case "apply-antigravity": {
      const result = applyToAntigravity(context);
      console.log(`Applied to Antigravity: ${result.path}`);
      console.log(`  Project: ${result.channel.name}`);
      return;
    }
    case "apply-opencode": {
      const result = applyToOpenCode(context);
      console.log(`Applied to OpenCode: ${result.path}`);
      console.log(`  Project: ${result.channel.name}`);
      return;
    }
    case "install-bridge": {
      const result = installUnityExtension(context);
      console.log(`Installed bridge at ${result.destination}`);
      return;
    }
    case "config-path":
      console.log(configPathFor(context.configRoot));
      return;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

async function runInstall(context) {
  const { spawnSync } = await import("node:child_process");
  const standaloneBundle = [
    path.join(mcpRoot, "creator-works-mcp.mjs"),
    path.join(mcpRoot, "release", "creator-works-mcp.mjs"),
    path.join(mcpRoot, "banter-mcp.mjs"),
    path.join(mcpRoot, "release", "banter-mcp.mjs"),
  ].find((candidate) => existsSyncLocal(candidate));
  const packageManifest = path.join(mcpRoot, "package.json");
  const nodeCheck = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  if (nodeCheck.status !== 0) {
    throw new Error(`Node.js is required but '${process.execPath} --version' failed.`);
  }
  const nodeVersion = nodeCheck.stdout.trim().replace(/^v/, "");
  const major = Number(nodeVersion.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required; found ${nodeVersion}.`);
  }
  if (standaloneBundle) {
    const validate = spawnSync(process.execPath, ["--check", standaloneBundle], { encoding: "utf8" });
    if (validate.status !== 0) {
      throw new Error(`Standalone MCP server validation failed: ${validate.stderr || validate.stdout}`);
    }
    console.log(`Standalone MCP server is installed and valid:\n  ${standaloneBundle}\n  Node.js ${nodeVersion}`);
    return;
  }
  if (!existsSyncLocal(packageManifest)) {
    throw new Error(`Neither a standalone MCP bundle nor package.json was found under ${mcpRoot}.`);
  }
  const ci = spawnSync("npm", ["ci"], { cwd: mcpRoot, stdio: "inherit" });
  if (ci.status !== 0) throw new Error("npm ci failed.");
  const build = spawnSync("npm", ["run", "release:server"], { cwd: mcpRoot, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Server bundle build failed.");
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
