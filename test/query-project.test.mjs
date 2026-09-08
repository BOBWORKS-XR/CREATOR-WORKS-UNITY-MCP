import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { queryProjectState } from "../dist/tools/query-project.js";
import { handleToolCall } from "../dist/tools/index.js";

function createConfig(projectPath) {
  const assetsPath = path.join(projectPath, "Assets");
  const mcpRoot = path.join(projectPath, ".bantworks-mcp");
  return {
    unityProjectPath: projectPath,
    assetsPath,
    mcpStatePath: path.join(mcpRoot, "state"),
    mcpCommandsPath: path.join(mcpRoot, "commands"),
    webRootPath: path.join(assetsPath, "WebRoot"),
    hasUnityExtension: true,
  };
}

async function createHierarchyFixture() {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "bantworks-query-test-"));
  const config = createConfig(projectPath);
  await mkdir(config.assetsPath, { recursive: true });
  await mkdir(config.mcpStatePath, { recursive: true });
  await mkdir(config.mcpCommandsPath, { recursive: true });

  const timestamp = Date.now() - 2000;
  await writeFile(path.join(config.mcpStatePath, "editor-state.json"), JSON.stringify({
    timestamp: Date.now(),
    activeSceneDirty: true,
    isPlaying: false,
    isCompiling: false,
    isUpdating: false,
  }));
  await writeFile(path.join(config.mcpStatePath, "scene-hierarchy.json"), JSON.stringify({
    sceneName: "Fixture",
    timestamp,
    objects: [
      {
        name: "Root",
        path: "Root",
        active: true,
        depth: 0,
        localPosition: [1, 2, 3],
        localRotation: [0, 90, 0],
        localScale: [1, 1, 1],
        components: [{ type: "Transform", fullType: "UnityEngine.Transform", properties: [] }],
      },
      {
        name: "Child",
        path: "Root/Child",
        active: true,
        depth: 1,
        components: [
          { type: "Transform", fullType: "UnityEngine.Transform", properties: [] },
          {
            type: "Rigidbody",
            fullType: "UnityEngine.Rigidbody",
            properties: [
              { name: "m_Mass", value: "1" },
              { name: "m_InternalLabel", value: "Space" },
            ],
          },
        ],
      },
      {
        name: "Grandchild",
        path: "Root/Child/Grandchild",
        active: false,
        depth: 2,
        components: [{ type: "Transform", fullType: "UnityEngine.Transform", properties: [] }],
      },
      {
        name: "Other",
        path: "Other",
        active: true,
        depth: 0,
        components: [{ type: "Rigidbody", fullType: "UnityEngine.Rigidbody", properties: [] }],
      },
    ],
  }));

  return { projectPath, config, timestamp };
}

test("hierarchy root queries exclude descendants by default and report snapshot state", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root",
      refresh: false,
      fields: ["name", "path", "active"],
    });

    assert.equal(result.success, true);
    assert.equal(result.query?.totalMatches, 1);
    assert.deepEqual(result.data.objects, [{ name: "Root", path: "Root", active: true }]);
    assert.equal(result.snapshot?.timestamp, fixture.timestamp);
    assert.equal(result.snapshot?.sceneDirty, true);
    assert.equal(result.snapshot?.refreshRequested, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});
test("hierarchy queries bound descendants, depth, and component projection", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root",
      includeDescendants: true,
      maxDepth: 1,
      componentType: "UnityEngine.Rigidbody",
      maxResults: 1,
      refresh: false,
    });

    assert.equal(result.success, true);
    assert.equal(result.query?.totalMatches, 1);
    assert.equal(result.query?.truncated, false);
    assert.equal(result.data.objects[0].path, "Root/Child");
    assert.deepEqual(result.data.objects[0].components.map((component) => component.type), ["Rigidbody"]);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("exact filters do not expand matching descendant paths", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const exact = await queryProjectState("hierarchy", "Root", fixture.config, {
      match: "exact",
      refresh: false,
    });
    const contains = await queryProjectState("hierarchy", "Root", fixture.config, {
      match: "contains",
      refresh: false,
    });

    assert.equal(exact.query?.totalMatches, 1);
    assert.equal(contains.query?.totalMatches, 3);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("hierarchy field projections include local transforms and reject unknown fields", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const projected = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root",
      refresh: false,
      fields: ["path", "localPosition", "localRotation", "localScale"],
    });
    const invalid = await queryProjectState("hierarchy", undefined, fixture.config, {
      refresh: false,
      fields: ["path", "worldMatrix"],
    });

    assert.deepEqual(projected.data.objects, [{
      path: "Root",
      localPosition: [1, 2, 3],
      localRotation: [0, 90, 0],
      localScale: [1, 1, 1],
    }]);
    assert.equal(invalid.success, false);
    assert.match(invalid.error ?? "", /Unsupported hierarchy fields: worldMatrix/);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("fresh targeted hierarchy queries use a correlated live result without rewriting the full snapshot", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const resultsPath = path.join(fixture.config.mcpStatePath, "hierarchy-query-results");
    const commandResultsPath = path.join(fixture.config.mcpStatePath, "command-results");
    await mkdir(resultsPath, { recursive: true });
    await mkdir(commandResultsPath, { recursive: true });
    const snapshotPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    const snapshotBefore = await readFile(snapshotPath, "utf8");

    const bridge = (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const commands = (await readdir(fixture.config.mcpCommandsPath)).filter((name) => name.endsWith(".json"));
        if (commands.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }

        const commandPath = path.join(fixture.config.mcpCommandsPath, commands[0]);
        const command = JSON.parse(await readFile(commandPath, "utf8"));
        assert.equal(command.type, "query_hierarchy");
        assert.equal(command.rootPath, "Root");
        assert.equal(command.maxResults, 5);
        assert.deepEqual(command.propertyNames, ["m_Mass"]);
        await writeFile(path.join(resultsPath, `${command.id}.json`), JSON.stringify({
          commandId: command.id,
          success: true,
          sceneName: "Fixture",
          scenePath: "Assets/Fixture.unity",
          objects: [{ name: "Root", path: "Root", depth: 0, localPosition: [4, 5, 6] }],
          components: [],
          totalMatches: 1,
          returned: 1,
          truncated: false,
          timestamp: Date.now(),
        }));
        await writeFile(path.join(commandResultsPath, `${command.id}.json`), JSON.stringify({
          commandId: command.id,
          success: true,
        }));
        await unlink(commandPath);
        return;
      }
      throw new Error("Timed out waiting for targeted hierarchy command");
    })();

    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root",
      maxResults: 5,
      fields: ["path", "localPosition"],
      propertyNames: ["m_Mass"],
      timeoutMs: 2000,
    });
    await bridge;

    assert.equal(result.success, true);
    assert.equal(result.source, "unity-live-targeted-query");
    assert.equal(result.snapshot?.refreshed, true);
    assert.deepEqual(result.data.objects, [{ path: "Root", localPosition: [4, 5, 6] }]);
    assert.equal(await readFile(snapshotPath, "utf8"), snapshotBefore);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("contains filters use a correlated identity query instead of a full-state export", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const resultsPath = path.join(fixture.config.mcpStatePath, "hierarchy-query-results");
    const commandResultsPath = path.join(fixture.config.mcpStatePath, "command-results");
    await mkdir(resultsPath, { recursive: true });
    await mkdir(commandResultsPath, { recursive: true });

    const bridge = (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const commands = (await readdir(fixture.config.mcpCommandsPath)).filter((name) => name.endsWith(".json"));
        if (commands.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        const commandPath = path.join(fixture.config.mcpCommandsPath, commands[0]);
        const command = JSON.parse(await readFile(commandPath, "utf8"));
        assert.equal(command.type, "query_hierarchy");
        assert.equal(command.filter, "Space");
        assert.equal(command.match, "contains");
        assert.equal(command.rootPath, "");
        await writeFile(path.join(resultsPath, `${command.id}.json`), JSON.stringify({
          commandId: command.id,
          success: true,
          sceneName: "Fixture",
          scenePath: "Assets/Fixture.unity",
          objects: [],
          components: [],
          totalMatches: 0,
          returned: 0,
          truncated: false,
          timestamp: Date.now(),
        }));
        await writeFile(path.join(commandResultsPath, `${command.id}.json`), JSON.stringify({
          commandId: command.id,
          success: true,
        }));
        await unlink(commandPath);
        return;
      }
      throw new Error("Timed out waiting for identity-filter hierarchy command");
    })();

    const result = await queryProjectState("hierarchy", "Space", fixture.config, {
      match: "contains",
      maxResults: 5,
      fields: ["name", "path"],
      timeoutMs: 2000,
    });
    await bridge;

    assert.equal(result.success, true);
    assert.equal(result.source, "unity-live-targeted-query");
    assert.equal(result.query?.totalMatches, 0);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("saved hierarchy queries project only requested serialized properties", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root",
      includeDescendants: true,
      componentType: "Rigidbody",
      propertyNames: ["m_Mass"],
      refresh: false,
    });

    assert.equal(result.success, true);
    const properties = result.data.objects[0].components[0].properties;
    assert.deepEqual(properties, [{ name: "m_Mass", value: "1" }]);
    assert.deepEqual(result.query?.propertyNames, ["m_Mass"]);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("hierarchy response byte budgets truncate oversized snapshot results", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const hierarchyPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    const hierarchy = JSON.parse(await readFile(hierarchyPath, "utf8"));
    hierarchy.objects = [
      { name: "LargeA", path: "LargeA", depth: 0, payload: "a".repeat(12000), components: [] },
      { name: "LargeB", path: "LargeB", depth: 0, payload: "b".repeat(12000), components: [] },
    ];
    await writeFile(hierarchyPath, JSON.stringify(hierarchy));

    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      refresh: false,
      maxResults: 10,
      maxResponseBytes: 16384,
    });

    assert.equal(result.success, true);
    assert.equal(result.data.objects.length, 1);
    assert.equal(result.query?.truncated, true);
    assert.ok((result.query?.responseBytes ?? Infinity) <= 16384);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("contains filters match identity fields without searching serialized property values", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const propertyOnly = await queryProjectState("hierarchy", "Space", fixture.config, {
      match: "contains",
      refresh: false,
      fields: ["name", "path"],
    });
    const componentIdentity = await queryProjectState("hierarchy", "Rigid", fixture.config, {
      match: "contains",
      refresh: false,
      fields: ["name", "path"],
    });

    assert.equal(propertyOnly.query?.totalMatches, 0);
    assert.deepEqual(propertyOnly.data.objects, []);
    assert.equal(componentIdentity.query?.totalMatches, 2);
    assert.deepEqual(
      componentIdentity.data.objects.map((object) => object.path),
      ["Root/Child", "Other"],
    );
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("hierarchy queries default to a 64 KiB response budget", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const hierarchyPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    const hierarchy = JSON.parse(await readFile(hierarchyPath, "utf8"));
    hierarchy.objects = [
      { name: "LargeA", path: "LargeA", depth: 0, payload: "a".repeat(40000), components: [] },
      { name: "LargeB", path: "LargeB", depth: 0, payload: "b".repeat(40000), components: [] },
    ];
    await writeFile(hierarchyPath, JSON.stringify(hierarchy));

    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      refresh: false,
      maxResults: 10,
    });

    assert.equal(result.success, true);
    assert.equal(result.data.objects.length, 1);
    assert.equal(result.query?.maxResponseBytes, 65536);
    assert.equal(result.query?.truncated, true);
    assert.ok((result.query?.responseBytes ?? Infinity) <= 65536);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("saved component queries filter and project before applying the response budget", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const hierarchyPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    const hierarchy = JSON.parse(await readFile(hierarchyPath, "utf8"));
    hierarchy.objects.unshift({
      name: "LargeUnrelated", path: "LargeUnrelated", depth: 0,
      components: [{ type: "Unrelated", properties: [{ name: "large", value: "x".repeat(100000) }] }],
    });
    await writeFile(hierarchyPath, JSON.stringify(hierarchy));

    const result = await queryProjectState("components", "Rigid", fixture.config, {
      refresh: false,
      componentType: "UnityEngine.Rigidbody",
      fields: ["objectPath", "type"],
      maxResults: 1,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, [{ objectPath: "Root/Child", type: "Rigidbody" }]);
    assert.equal(result.query.totalMatches, 2);
    assert.equal(result.query.maxResults, 1);
    assert.equal(result.query.match, "contains");
    assert.equal(result.query.truncated, true);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("the actual MCP query text respects the byte budget including metadata and Unicode", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const hierarchyPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    const objects = Array.from({ length: 200 }, (_, index) => ({
      name: `Object${index}`, path: `Object${index}`, depth: 0,
      components: [{ type: "Fixture", properties: Array.from({ length: 20 }, () => ({
        name: "message", value: "\u4e16\u754c\ud83d\ude80".repeat(4),
      })) }],
    }));
    await writeFile(hierarchyPath, JSON.stringify({ sceneName: "Fixture", timestamp: Date.now(), objects }));

    for (const query of ["hierarchy", "components"]) {
      for (const maxResponseBytes of [undefined, 16384]) {
        const response = await handleToolCall("query_project_state", {
          query, refresh: false, maxResponseBytes,
        }, fixture.config);
        const text = response.content[0].text;
        const result = JSON.parse(text);
        const actualBytes = Buffer.byteLength(text, "utf8");
        assert.equal(result.success, true);
        assert.ok(actualBytes <= (maxResponseBytes ?? 65536), `${query} returned ${actualBytes} bytes`);
        assert.equal(result.query.responseBytes, actualBytes);
        assert.equal(result.query.totalMatches, 200);
        assert.equal(result.query.truncated, true);
        assert.ok(result.query.returned > 0);
      }
    }
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("an individually oversized query result reports truncation and an actionable retry", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const hierarchyPath = path.join(fixture.config.mcpStatePath, "scene-hierarchy.json");
    await writeFile(hierarchyPath, JSON.stringify({ sceneName: "Large", timestamp: Date.now(), objects: [{
      name: "Oversized", path: "Oversized", components: [{ type: "Fixture", properties: [
        { name: "payload", value: "x".repeat(100000) },
      ] }],
    }] }));
    const result = await queryProjectState("hierarchy", undefined, fixture.config, { refresh: false });
    assert.equal(result.success, true);
    assert.equal(result.query.totalMatches, 1);
    assert.equal(result.query.returned, 0);
    assert.equal(result.query.truncated, true);
    assert.match(result.warning, /Narrow fields\/propertyNames/);
    assert.equal(result.query.responseBytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
    const projected = await queryProjectState("hierarchy", undefined, fixture.config, {
      refresh: false, fields: ["name", "path"],
    });
    assert.deepEqual(projected.data.objects, [{ name: "Oversized", path: "Oversized" }]);
    assert.equal(projected.query.truncated, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("legacy combined, asset, and prefab state dumps fail closed", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const all = await queryProjectState("all", undefined, fixture.config, { refresh: false });
    const assets = await queryProjectState("assets", undefined, fixture.config, { refresh: false });
    const prefabs = await queryProjectState("prefabs", undefined, fixture.config, { refresh: false });

    assert.equal(all.success, false);
    assert.match(all.error ?? "", /dedicated asset, prefab, console, import, and bridge-status tools/);
    assert.equal(assets.success, false);
    assert.match(assets.error ?? "", /search_unity_assets/);
    assert.equal(prefabs.success, false);
    assert.match(prefabs.error ?? "", /get_prefab_catalog/);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("requested properties absent from a snapshot are explicit, not false values", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const result = await queryProjectState("components", undefined, fixture.config, {
      rootPath: "Root/Child", componentType: "Rigidbody", refresh: false,
      propertyNames: ["m_Mass", "notAProperty"], fields: ["objectPath", "properties"],
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.data[0].properties, [{ name: "m_Mass", value: "1" }]);
    assert.deepEqual(result.data[0].missingProperties, ["notAProperty"]);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("component identity mode strips properties in hierarchy and component results", async () => {
  const fixture = await createHierarchyFixture();
  try {
    for (const query of ["hierarchy", "components"]) {
      const result = await queryProjectState(query, undefined, fixture.config, {
        rootPath: "Root/Child", componentType: "Rigidbody", refresh: false,
        componentDetails: "identity",
      });
      assert.equal(result.success, true);
      const component = query === "hierarchy" ? result.data.objects[0].components[0] : result.data[0];
      assert.equal(component.type, "Rigidbody");
      assert.equal(component.properties, undefined);
      assert.equal(component.missingProperties, undefined);
    }
    const contradictory = await queryProjectState("components", undefined, fixture.config, {
      componentDetails: "identity", propertyNames: ["m_Mass"], refresh: false,
    });
    assert.equal(contradictory.success, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("timed-out queries preserve one pending command and project-bound polling instructions", async () => {
  const fixture = await createHierarchyFixture();
  try {
    const result = await queryProjectState("hierarchy", undefined, fixture.config, {
      rootPath: "Root", fields: ["name", "path"], timeoutMs: 1000,
    });
    assert.equal(result.success, false);
    assert.equal(result.pending, true);
    assert.equal(result.status, "result_timeout");
    assert.match(result.projectId, /^unity-[a-f0-9]{20}$/);
    assert.deepEqual(result.nextAction, {
      tool: "get_unity_command_status", arguments: { commandId: result.commandId, projectId: result.projectId },
    });
    assert.match(result.message, /Do not resubmit/);
    const queued = (await readdir(fixture.config.mcpCommandsPath)).filter(name => name.endsWith(".json"));
    assert.deepEqual(queued, [`${result.commandId}.json`]);
    const command = JSON.parse(await readFile(path.join(fixture.config.mcpCommandsPath, queued[0]), "utf8"));
    assert.equal(command.includeComponents, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});
