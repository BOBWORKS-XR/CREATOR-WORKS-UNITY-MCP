import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkImportStatus, waitForUnityCompile } from "../dist/tools/check-import-status.js";

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

async function createFixture() {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "bantworks-compile-test-"));
  const config = createConfig(projectPath);
  await mkdir(config.assetsPath, { recursive: true });
  await mkdir(config.mcpStatePath, { recursive: true });
  return { projectPath, config };
}

test("wait_for_unity_compile waits for both compilation and asset updates", async () => {
  const fixture = await createFixture();
  try {
    const editorStatePath = path.join(fixture.config.mcpStatePath, "editor-state.json");
    const compilationPath = path.join(fixture.config.mcpStatePath, "compilation-status.json");
    await writeFile(editorStatePath, JSON.stringify({ timestamp: Date.now(), isCompiling: true, isUpdating: true }));
    await writeFile(compilationPath, JSON.stringify({ completed: false, hasErrors: false, timestamp: Date.now() }));

    const settle = setTimeout(async () => {
      await writeFile(editorStatePath, JSON.stringify({ timestamp: Date.now(), isCompiling: false, isUpdating: false }));
      await writeFile(compilationPath, JSON.stringify({ completed: true, hasErrors: false, timestamp: Date.now(), errors: [] }));
    }, 100);

    const result = await waitForUnityCompile(2000, fixture.config);
    clearTimeout(settle);
    assert.equal(result.success, true);
    assert.equal(result.settled, true);
    assert.equal(result.compilationHasErrors, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});
test("wait_for_unity_compile returns persistent compiler diagnostics", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    await writeFile(path.join(fixture.config.mcpStatePath, "editor-state.json"), JSON.stringify({
      timestamp: now,
      isCompiling: false,
      isUpdating: false,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "compilation-status.json"), JSON.stringify({
      completed: true,
      hasErrors: true,
      timestamp: now,
      errors: [{ message: "CS1002 ; expected", file: "Assets/Broken.cs", line: 4, column: 12 }],
      warnings: [],
    }));

    const result = await waitForUnityCompile(1000, fixture.config);
    assert.equal(result.success, false);
    assert.equal(result.settled, true);
    assert.equal(result.compilerErrors?.[0].file, "Assets/Broken.cs");
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("wait_for_unity_compile can wait for a heartbeat blocked by a long Editor command", async () => {
  const fixture = await createFixture();
  try {
    const editorStatePath = path.join(fixture.config.mcpStatePath, "editor-state.json");
    const compilationPath = path.join(fixture.config.mcpStatePath, "compilation-status.json");
    await writeFile(editorStatePath, JSON.stringify({
      timestamp: Date.now() - 10000,
      isCompiling: false,
      isUpdating: false,
    }));
    await writeFile(compilationPath, JSON.stringify({ completed: true, hasErrors: false, timestamp: Date.now() }));

    const refresh = setTimeout(async () => {
      await writeFile(editorStatePath, JSON.stringify({
        timestamp: Date.now(),
        isCompiling: false,
        isUpdating: false,
      }));
    }, 100);

    const result = await waitForUnityCompile(2000, fixture.config, { waitForFreshHeartbeat: true });
    clearTimeout(refresh);
    assert.equal(result.success, true);
    assert.equal(result.settled, true);
    assert.equal(result.stale, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("check_import_status cannot report success over a failed current compilation", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    const assetPath = path.join(fixture.config.assetsPath, "Broken.cs");
    await writeFile(assetPath, "class Broken {}");
    await writeFile(`${assetPath}.meta`, "guid: 0123456789abcdef0123456789abcdef");
    await writeFile(path.join(fixture.config.mcpStatePath, "editor-state.json"), JSON.stringify({
      timestamp: now,
      isCompiling: false,
      isUpdating: false,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "import-status.json"), JSON.stringify({
      completed: true,
      hasErrors: false,
      timestamp: now,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "compilation-status.json"), JSON.stringify({
      completed: true,
      hasErrors: true,
      timestamp: now,
      errors: [{ message: "CS1002 ; expected", file: "Assets/Broken.cs", line: 4 }],
      warnings: [],
    }));

    const result = await checkImportStatus("Assets/Broken.cs", true, 1000, fixture.config);
    assert.equal(result.imported, true);
    assert.equal(result.success, false);
    assert.equal(result.compilationHasErrors, true);
    assert.match(result.errors?.[0] ?? "", /Assets\/Broken\.cs:4/);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("fresh compiler status does not prove a blocked Editor has settled", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    await writeFile(path.join(fixture.config.mcpStatePath, "editor-state.json"), JSON.stringify({
      timestamp: now - 10000,
      isCompiling: false,
      isUpdating: false,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "compilation-status.json"), JSON.stringify({
      completed: true,
      hasErrors: false,
      timestamp: now,
      errors: [],
      warnings: [],
    }));

    const result = await waitForUnityCompile(1000, fixture.config);
    assert.equal(result.success, false);
    assert.equal(result.settled, false);
    assert.equal(result.heartbeatStale, true);
    assert.equal(result.compilationStale, false);
    assert.match(result.message, /heartbeat.*stale/i);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("default compile wait survives stale state and domain reload within its deadline", async () => {
  const fixture = await createFixture();
  try {
    const editorPath = path.join(fixture.config.mcpStatePath, "editor-state.json");
    const compilerPath = path.join(fixture.config.mcpStatePath, "compilation-status.json");
    await writeFile(editorPath, JSON.stringify({timestamp: Date.now() - 10000, isCompiling: true}));
    await writeFile(compilerPath, JSON.stringify({timestamp: Date.now() - 10000, completed: false}));
    const refreshed = new Promise(resolve => setTimeout(async () => {
      await writeFile(compilerPath, JSON.stringify({timestamp: Date.now(), completed: true, hasErrors: false}));
      await writeFile(editorPath, JSON.stringify({timestamp: Date.now(), isCompiling: false, isUpdating: false}));
      resolve();
    }, 100));
    const result = await waitForUnityCompile(2000, fixture.config);
    await refreshed;
    assert.equal(result.success, true);
    assert.equal(result.settled, true);
    assert.equal(result.heartbeatStale, false);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});

test("check_import_status rejects a C# asset newer than the last completed compilation", async () => {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    const assetPath = path.join(fixture.config.assetsPath, "Newer.cs");
    await writeFile(assetPath, "class Newer {}");
    await writeFile(`${assetPath}.meta`, "guid: fedcba9876543210fedcba9876543210");
    await writeFile(path.join(fixture.config.mcpStatePath, "editor-state.json"), JSON.stringify({
      timestamp: now,
      isCompiling: false,
      isUpdating: false,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "import-status.json"), JSON.stringify({
      completed: true,
      hasErrors: false,
      timestamp: now,
    }));
    await writeFile(path.join(fixture.config.mcpStatePath, "compilation-status.json"), JSON.stringify({
      completed: true,
      hasErrors: false,
      timestamp: now - 10000,
      errors: [],
      warnings: [],
    }));

    const result = await checkImportStatus("Assets/Newer.cs", true, 1000, fixture.config);
    assert.equal(result.imported, true);
    assert.equal(result.success, false);
    assert.equal(result.staleAssembly, true);
    assert.match(result.message ?? "", /assembly state is stale/i);
  } finally {
    await rm(fixture.projectPath, { recursive: true, force: true });
  }
});
