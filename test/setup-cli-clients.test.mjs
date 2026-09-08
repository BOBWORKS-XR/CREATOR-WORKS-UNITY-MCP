import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyToAntigravity,
  applyToClaudeCode,
  applyToCodex,
  applyToOpenCode,
  configPathFor,
  loadConfig,
  normalizeToolGroups,
} from "../scripts/cli/setup-lib.mjs";
import { parseJsonc } from "../scripts/cli/jsonc-edit.mjs";

test("cross-platform setup defaults new configurations to the core tool profile", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "creator-works-cli-default-"));
  try {
    const configRoot = path.join(root, "config");
    const mcpRoot = path.join(root, "mcp");
    mkdirSync(mcpRoot, { recursive: true });
    writeFileSync(path.join(mcpRoot, "creator-works-mcp.mjs"), "// server\n", "utf8");

    const config = loadConfig({ configRoot, mcpRoot });
    assert.equal(config.tool_groups, "core");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool profile normalization accepts compact profiles and whitespace defaults", () => {
  assert.equal(normalizeToolGroups(undefined), "core");
  assert.equal(normalizeToolGroups("   "), "core");
  assert.equal(normalizeToolGroups("shadergraph, core,shadergraph"), "core,shadergraph");
  assert.throws(() => normalizeToolGroups("all,core"), /cannot combine/i);
});

test("cross-platform CLI writes canonical client entries and preserves unrelated config", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "creator-works-cli-clients-"));
  try {
    const configRoot = path.join(root, "config");
    const mcpRoot = path.join(root, "mcp");
    const serverPath = path.join(mcpRoot, "creator-works-mcp.mjs");
    const projectPath = path.join(root, "Unity Project");
    mkdirSync(mcpRoot, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(serverPath, "// server\n", "utf8");

    const launcherPath = configPathFor(configRoot);
    mkdirSync(path.dirname(launcherPath), { recursive: true });
    writeFileSync(
      launcherPath,
      JSON.stringify({
        channels: [{
          id: "project-1",
          name: "Project",
          unity_project_path: projectPath,
          scene_path: null,
          enabled: true,
        }],
        active_channel_id: "project-1",
        mcp_server_path: serverPath,
        tool_groups: "read,author",
        auto_start: false,
        enable_custom_scripts: false,
      }),
      "utf8",
    );

    const claudePath = path.join(root, "claude.json");
    const codexPath = path.join(root, "codex.toml");
    const antigravityPath = path.join(root, "antigravity.json");
    const opencodePath = path.join(root, "opencode.jsonc");

    writeFileSync(
      claudePath,
      JSON.stringify({
        keep: true,
        mcpServers: { banter: { command: "stale" } },
      }),
      "utf8",
    );
    writeFileSync(
      codexPath,
      [
        'model = "gpt"',
        "",
        "[mcp_servers.banter]",
        'command = "stale"',
        "",
        "[mcp_servers.banter.env]",
        'BANTWORKS_TOOL_GROUPS = "all"',
        "",
        "[other]",
        "keep = true",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      antigravityPath,
      JSON.stringify({
        keep: true,
        mcpServers: { banter: { command: "stale" } },
      }),
      "utf8",
    );
    writeFileSync(
      opencodePath,
      [
        "{",
        "  // Keep this OpenCode comment.",
        '  "theme": "dark",',
        '  "mcp": {',
        '    "banter": { "enabled": false },',
        "  },",
        "}",
      ].join("\n"),
      "utf8",
    );

    const context = { configRoot, mcpRoot };
    applyToClaudeCode({ ...context, claudeConfigPath: claudePath });
    applyToCodex({ ...context, codexConfigPath: codexPath });
    applyToAntigravity({ ...context, antigravityConfigPath: antigravityPath });
    applyToOpenCode({ ...context, opencodeConfigPath: opencodePath });

    const claude = JSON.parse(readFileSync(claudePath, "utf8"));
    assert.equal(claude.keep, true);
    assert.equal(claude.mcpServers.banter, undefined);
    assert.equal(
      claude.mcpServers["creator-works"].env.CREATOR_WORKS_TOOL_GROUPS,
      "read,author",
    );

    const codex = readFileSync(codexPath, "utf8");
    assert.match(codex, /\[mcp_servers\.creator-works\]/);
    assert.match(codex, /CREATOR_WORKS_TOOL_GROUPS = "read,author"/);
    assert.doesNotMatch(codex, /\[mcp_servers\.banter/);
    assert.match(codex, /\[other\]\nkeep = true/);

    const antigravity = JSON.parse(readFileSync(antigravityPath, "utf8"));
    assert.equal(antigravity.keep, true);
    assert.equal(antigravity.mcpServers.banter, undefined);
    assert.equal(
      antigravity.mcpServers["creator-works"].env.CREATOR_WORKS_TOOL_GROUPS,
      "read,author",
    );

    const opencodeText = readFileSync(opencodePath, "utf8");
    const opencode = parseJsonc(opencodeText);
    assert.match(opencodeText, /Keep this OpenCode comment/);
    assert.equal(opencode.theme, "dark");
    assert.equal(opencode.mcp.banter, undefined);
    assert.equal(
      opencode.mcp["creator-works"].environment.CREATOR_WORKS_TOOL_GROUPS,
      "read,author",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-platform CLI migrates legacy launcher config to the Creator Works path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "creator-works-cli-migration-"));
  try {
    const configRoot = path.join(root, "config");
    const mcpRoot = path.join(root, "mcp");
    const serverPath = path.join(mcpRoot, "creator-works-mcp.mjs");
    const legacyPath = path.join(configRoot, "banter-mcp", "launcher-config.json");
    mkdirSync(mcpRoot, { recursive: true });
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(serverPath, "// server\n", "utf8");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        channels: [{ id: "legacy-project", name: "Legacy", unity_project_path: root }],
        active_channel_id: "legacy-project",
        mcp_server_path: serverPath,
        tool_groups: "all",
      }),
      "utf8",
    );

    const config = loadConfig({ configRoot, mcpRoot });
    const canonicalPath = configPathFor(configRoot);
    assert.equal(
      canonicalPath,
      path.join(configRoot, "creator-works-mcp", "launcher-config.json"),
    );
    assert.equal(config.active_channel_id, "legacy-project");
    assert.equal(JSON.parse(readFileSync(canonicalPath, "utf8")).active_channel_id, "legacy-project");
    assert.equal(JSON.parse(readFileSync(legacyPath, "utf8")).active_channel_id, "legacy-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
