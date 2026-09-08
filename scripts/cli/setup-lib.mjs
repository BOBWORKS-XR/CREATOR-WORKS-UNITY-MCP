// Cross-platform implementation of the Creator Works MCP setup logic that used
// to live in setup.ps1. The PowerShell script remains the canonical entry
// point on Windows; setup.sh and scripts/cli/setup.mjs call into this
// module so the JSON / TOML file formats and behaviour stay in one place.
//
// All paths are derived from the user's OS-appropriate config home, so the
// same code works on Linux (XDG_CONFIG_HOME / ~/.config) and macOS
// (~Library/Application Support) as on Windows (%APPDATA%).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { updateJsoncManagedEntry } from "./jsonc-edit.mjs";

export const LEGACY_SERVER_PATH = "C:/tools/banter-mcp/dist/index.js";

export const KNOWN_TOOL_GROUPS = ["core", "read", "author", "test", "banter", "shadergraph"];
const MCP_CLIENT_ID = "creator-works";
const LEGACY_MCP_CLIENT_ID = "banter";
const TOOL_GROUPS_ENV = "CREATOR_WORKS_TOOL_GROUPS";

export function detectPlatformPaths(env = process.env) {
  if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming");
    const userProfile = env.USERPROFILE || os.homedir();
    return {
      configRoot: appData,
      claudeConfigPath: path.join(userProfile, ".claude.json"),
      codexConfigPath: path.join(userProfile, ".codex", "config.toml"),
      antigravityConfigPath: path.join(userProfile, ".gemini", "config", "mcp_config.json"),
      opencodeConfigPath: path.join(appData, "opencode", "opencode.jsonc"),
    };
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const home = os.homedir();
  return {
    configRoot: xdgConfig,
    claudeConfigPath: path.join(home, ".claude.json"),
    codexConfigPath: path.join(xdgConfig, "codex", "config.toml"),
    antigravityConfigPath: path.join(home, ".gemini", "config", "mcp_config.json"),
    opencodeConfigPath: path.join(xdgConfig, "opencode", "opencode.jsonc"),
  };
}

export function defaultServerPath(mcpRoot) {
  const candidates = [
    path.join(mcpRoot, "creator-works-mcp.mjs"),
    path.join(mcpRoot, "release", "creator-works-mcp.mjs"),
    path.join(mcpRoot, "banter-mcp.mjs"),
    path.join(mcpRoot, "release", "banter-mcp.mjs"),
    path.join(mcpRoot, "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `MCP server was not found under ${mcpRoot}. Run 'npm run release:server' first.`,
  );
}

export function isLegacyServerPath(value) {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return value.replace(/\\/g, "/").toLowerCase() === LEGACY_SERVER_PATH.toLowerCase();
}

export function normalizeToolGroups(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "core";
  }
  const entries = String(value)
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unique = [...new Set(entries)];
  if (unique.length === 0) {
    throw new Error("Tool groups must contain all, none, core, read, author, test, banter, or shadergraph.");
  }
  if (unique.includes("all") || unique.includes("none")) {
    if (unique.length !== 1) {
      throw new Error("Tool groups cannot combine 'all' or 'none' with other groups.");
    }
    return unique[0];
  }
  const unknown = unique.filter((entry) => !KNOWN_TOOL_GROUPS.includes(entry));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool groups: ${unknown.join(", ")}. Use all, none, core, read, author, test, banter, or shadergraph.`,
    );
  }
  return KNOWN_TOOL_GROUPS.filter((group) => unique.includes(group)).join(",");
}

function atomicWriteText(filePath, content) {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8" });
    if (existsSync(filePath)) {
      try {
        renameSync(temporaryPath, filePath);
      } catch (error) {
        // rename across filesystems can fail with EXDEV; fall back to copy + unlink.
        copyFileSync(temporaryPath, filePath);
        unlinkSync(temporaryPath);
      }
    } else {
      renameSync(temporaryPath, filePath);
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

function atomicCopyFile(source, destination) {
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporaryPath = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporaryPath);
    if (existsSync(destination)) {
      try {
        renameSync(temporaryPath, destination);
      } catch (error) {
        copyFileSync(temporaryPath, destination);
        unlinkSync(temporaryPath);
      }
    } else {
      renameSync(temporaryPath, destination);
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

export function configPathFor(configRoot) {
  return path.join(configRoot, "creator-works-mcp", "launcher-config.json");
}

function legacyConfigPathFor(configRoot) {
  return path.join(configRoot, "banter-mcp", "launcher-config.json");
}

export function loadConfig({ configRoot, mcpRoot }) {
  const configPath = configPathFor(configRoot);
  const legacyConfigPath = legacyConfigPathFor(configRoot);
  const sourcePath = existsSync(configPath)
    ? configPath
    : existsSync(legacyConfigPath)
      ? legacyConfigPath
      : null;
  mkdirSync(path.dirname(configPath), { recursive: true });
  if (sourcePath) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(sourcePath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to parse ${sourcePath}: ${error.message}`);
    }
    let configuredServer = raw.mcp_server_path;
    if (
      !configuredServer ||
      isLegacyServerPath(configuredServer) ||
      !existsSync(configuredServer) ||
      configuredServer.includes("/.mount_") ||
      configuredServer.includes("/tmp/")
    ) {
      configuredServer = defaultServerPath(mcpRoot);
    }
    const normalized = {
      channels: Array.isArray(raw.channels) ? raw.channels : [],
      active_channel_id: raw.active_channel_id ?? null,
      mcp_server_path: configuredServer,
      tool_groups: normalizeToolGroups(raw.tool_groups),
      auto_start: Boolean(raw.auto_start),
      enable_custom_scripts: Boolean(raw.enable_custom_scripts),
    };
    if (sourcePath === legacyConfigPath) {
      atomicWriteText(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
    }
    return normalized;
  }
  return {
    channels: [],
    active_channel_id: null,
    mcp_server_path: defaultServerPath(mcpRoot),
    tool_groups: "core",
    auto_start: false,
    enable_custom_scripts: false,
  };
}

export function saveConfig({ configRoot, mcpRoot }, config) {
  const configPath = configPathFor(configRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  if (!existsSync(config.mcp_server_path) || !statSync(config.mcp_server_path).isFile()) {
    throw new Error(`MCP server file does not exist: ${config.mcp_server_path}`);
  }
  const sanitized = {
    channels: config.channels,
    active_channel_id: config.active_channel_id,
    mcp_server_path: config.mcp_server_path,
    tool_groups: normalizeToolGroups(config.tool_groups),
    auto_start: Boolean(config.auto_start),
    enable_custom_scripts: Boolean(config.enable_custom_scripts),
  };
  atomicWriteText(configPath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

export function addProject({ configRoot, mcpRoot }, { name, projectPath }) {
  if (!name || !name.trim()) throw new Error("Project name is required.");
  if (!projectPath || !projectPath.trim()) throw new Error("Project path is required.");
  const resolvedPath = path.resolve(projectPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  if (!existsSync(path.join(resolvedPath, "Assets"))) {
    throw new Error(`Not a valid Unity project (no Assets folder): ${resolvedPath}`);
  }
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = {
    id: randomUUID(),
    name: name.trim(),
    unity_project_path: resolvedPath,
    scene_path: null,
    enabled: true,
  };
  config.channels.push(channel);
  if (config.channels.length === 1) {
    config.active_channel_id = channel.id;
  }
  saveConfig({ configRoot, mcpRoot }, config);
  return channel;
}

export function listProjects({ configRoot, mcpRoot }) {
  return loadConfig({ configRoot, mcpRoot }).channels;
}

export function setActiveProject({ configRoot, mcpRoot }, { id, index }) {
  const config = loadConfig({ configRoot, mcpRoot });
  if (config.channels.length === 0) {
    throw new Error("No projects configured.");
  }
  let targetId = id;
  if (!targetId && typeof index === "number") {
    if (index < 0 || index >= config.channels.length) {
      throw new Error(`Invalid project index: ${index + 1}`);
    }
    targetId = config.channels[index].id;
  }
  if (!targetId) {
    throw new Error("Either id or index must be provided.");
  }
  if (!config.channels.some((channel) => channel.id === targetId)) {
    throw new Error(`Unknown project id: ${targetId}`);
  }
  config.active_channel_id = targetId;
  saveConfig({ configRoot, mcpRoot }, config);
  return config.channels.find((channel) => channel.id === targetId);
}

export function removeProject({ configRoot, mcpRoot }, { id, index }) {
  const config = loadConfig({ configRoot, mcpRoot });
  if (config.channels.length === 0) {
    throw new Error("No projects configured.");
  }
  let targetId = id;
  if (!targetId && typeof index === "number") {
    if (index < 0 || index >= config.channels.length) {
      throw new Error(`Invalid project index: ${index + 1}`);
    }
    targetId = config.channels[index].id;
  }
  if (!targetId) {
    throw new Error("Either id or index must be provided.");
  }
  const removed = config.channels.find((channel) => channel.id === targetId);
  if (!removed) {
    throw new Error(`Unknown project id: ${targetId}`);
  }
  config.channels = config.channels.filter((channel) => channel.id !== targetId);
  if (config.active_channel_id === targetId) {
    config.active_channel_id = config.channels[0]?.id ?? null;
  }
  saveConfig({ configRoot, mcpRoot }, config);
  return removed;
}

export function setCapabilityProfile({ configRoot, mcpRoot }, profile) {
  const config = loadConfig({ configRoot, mcpRoot });
  config.tool_groups = normalizeToolGroups(profile);
  saveConfig({ configRoot, mcpRoot }, config);
  return config.tool_groups;
}

function activeChannel(config) {
  if (!config.active_channel_id) {
    throw new Error("No active project selected. Add and select a project first.");
  }
  const channel = config.channels.find((candidate) => candidate.id === config.active_channel_id);
  if (!channel) {
    throw new Error("Active channel not found in config.");
  }
  return channel;
}

export function applyToClaudeCode({ configRoot, mcpRoot, codexConfigPath, claudeConfigPath }) {
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = activeChannel(config);
  const claudePath = claudeConfigPath || detectPlatformPaths().claudeConfigPath;
  let existing = {};
  if (existsSync(claudePath)) {
    try {
      existing = JSON.parse(readFileSync(claudePath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to parse ${claudePath}: ${error.message}`);
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
    existing.mcpServers = {};
  }
  const envVars = {
    UNITY_PROJECT_PATH: channel.unity_project_path,
    [TOOL_GROUPS_ENV]: normalizeToolGroups(config.tool_groups),
  };
  if (channel.scene_path) {
    envVars.UNITY_SCENE_PATH = channel.scene_path;
  }
  delete existing.mcpServers[LEGACY_MCP_CLIENT_ID];
  existing.mcpServers[MCP_CLIENT_ID] = {
    command: "node",
    args: [config.mcp_server_path],
    env: envVars,
  };
  atomicWriteText(claudePath, `${JSON.stringify(existing, null, 2)}\n`);
  return { channel, path: claudePath };
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function removeTomlTableBlock(content, tableName) {
  const target = `[${tableName}]`;
  const lines = content.split(/\r?\n/);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === target) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }
  return output.join("\n").replace(/\s+$/, "");
}

export function applyToCodex({ configRoot, mcpRoot, codexConfigPath, claudeConfigPath }) {
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = activeChannel(config);
  const codexPath = codexConfigPath || detectPlatformPaths().codexConfigPath;
  let content = "";
  if (existsSync(codexPath)) {
    content = readFileSync(codexPath, "utf8");
  }
  content = removeTomlTableBlock(content, "mcp_servers." + MCP_CLIENT_ID);
  content = removeTomlTableBlock(content, "mcp_servers." + MCP_CLIENT_ID + ".env");
  content = removeTomlTableBlock(content, "mcp_servers." + LEGACY_MCP_CLIENT_ID);
  content = removeTomlTableBlock(content, "mcp_servers." + LEGACY_MCP_CLIENT_ID + ".env");

  if (content.trim().length > 0) {
    content = `${content.trimEnd()}\n\n`;
  }

  const serverPath = escapeTomlString(config.mcp_server_path.replace(/\\/g, "/"));
  const projectPath = escapeTomlString(channel.unity_project_path.replace(/\\/g, "/"));
  const toolGroups = escapeTomlString(normalizeToolGroups(config.tool_groups));

  let block = `[mcp_servers.${MCP_CLIENT_ID}]\n`;
  block += `command = "node"\n`;
  block += `args = ["${serverPath}"]\n`;
  block += `startup_timeout_sec = 20\n`;
  block += `tool_timeout_sec = 600\n\n`;
  block += `[mcp_servers.${MCP_CLIENT_ID}.env]\n`;
  block += `UNITY_PROJECT_PATH = "${projectPath}"\n`;
  block += `${TOOL_GROUPS_ENV} = "${toolGroups}"\n`;
  if (channel.scene_path) {
    const scenePath = escapeTomlString(channel.scene_path.replace(/\\/g, "/"));
    block += `UNITY_SCENE_PATH = "${scenePath}"\n`;
  }
  content = `${content}${block}`;
  atomicWriteText(codexPath, content);
  return { channel, path: codexPath };
}

export function applyToAntigravity({ configRoot, mcpRoot, antigravityConfigPath }) {
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = activeChannel(config);
  const targetPath = antigravityConfigPath || detectPlatformPaths().antigravityConfigPath;
  let existing = {};
  if (existsSync(targetPath)) {
    const raw = readFileSync(targetPath, "utf8");
    if (raw.trim().length > 0) {
      existing = JSON.parse(raw);
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
    existing.mcpServers = {};
  }
  const envVars = {
    UNITY_PROJECT_PATH: channel.unity_project_path,
    [TOOL_GROUPS_ENV]: normalizeToolGroups(config.tool_groups),
  };
  if (channel.scene_path) {
    envVars.UNITY_SCENE_PATH = channel.scene_path;
  }
  delete existing.mcpServers[LEGACY_MCP_CLIENT_ID];
  existing.mcpServers[MCP_CLIENT_ID] = {
    command: "node",
    args: [config.mcp_server_path],
    env: envVars,
  };
  atomicWriteText(targetPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { channel, path: targetPath };
}

export function applyToOpenCode({ configRoot, mcpRoot, opencodeConfigPath }) {
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = activeChannel(config);
  const targetPath = opencodeConfigPath || detectPlatformPaths().opencodeConfigPath;
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "{}";
  const environment = {
    UNITY_PROJECT_PATH: channel.unity_project_path,
    [TOOL_GROUPS_ENV]: normalizeToolGroups(config.tool_groups),
  };
  if (channel.scene_path) {
    environment.UNITY_SCENE_PATH = channel.scene_path;
  }
  const entry = {
    type: "local",
    command: ["node", config.mcp_server_path],
    enabled: true,
    environment,
  };
  const updated = updateJsoncManagedEntry(
    existing,
    "mcp",
    MCP_CLIENT_ID,
    LEGACY_MCP_CLIENT_ID,
    entry,
  );
  atomicWriteText(targetPath, updated);
  return { channel, path: targetPath };
}
export function installUnityExtension({ configRoot, mcpRoot }) {
  const config = loadConfig({ configRoot, mcpRoot });
  const channel = activeChannel(config);
  const sourcePath = path.join(mcpRoot, "unity-extension", "Editor", "BanterMCPBridge.cs");
  const editorDir = path.join(channel.unity_project_path, "Assets", "Editor");
  const destination = path.join(editorDir, "BanterMCPBridge.cs");
  if (!existsSync(sourcePath)) {
    throw new Error(`Source extension not found at: ${sourcePath}`);
  }
  mkdirSync(editorDir, { recursive: true });
  if (existsSync(destination)) {
    const backupDir = path.join(channel.unity_project_path, ".bantworks-mcp", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `BanterMCPBridge-${randomUUID()}.cs`);
    copyFileSync(destination, backupPath);
  }
  atomicCopyFile(sourcePath, destination);
  const stateDir = path.join(channel.unity_project_path, ".bantworks-mcp", "state");
  mkdirSync(stateDir, { recursive: true });
  atomicWriteText(
    path.join(stateDir, "launcher-settings.json"),
    `${JSON.stringify({
      enableCustomScripts: Boolean(config.enable_custom_scripts),
      allowAllTests: config.allow_all_tests !== false,
    }, null, 2)}\n`,
  );
  return { destination };
}

export function buildContext({ mcpRoot, env = process.env } = {}) {
  if (!mcpRoot) throw new Error("mcpRoot is required.");
  const platform = detectPlatformPaths(env);
  return {
    mcpRoot,
    configRoot: platform.configRoot,
    codexConfigPath: platform.codexConfigPath,
    claudeConfigPath: platform.claudeConfigPath,
    antigravityConfigPath: platform.antigravityConfigPath,
    opencodeConfigPath: platform.opencodeConfigPath,
  };
}
