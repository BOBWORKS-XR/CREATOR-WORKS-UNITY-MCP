import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleToolCall } from "../dist/tools/index.js";
import { registerTools } from "../dist/tools/index.js";
import { boundedReadText, readResponseBudget } from "../dist/tools/read-response-budget.js";

test("large diagnostic and catalog replies obey the wire budget without hiding failure state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-read-budget-"));
  const config = { unityProjectPath: root, assetsPath: path.join(root, "Assets"),
    mcpStatePath: path.join(root, ".bantworks-mcp/state"), mcpCommandsPath: path.join(root, ".bantworks-mcp/commands"),
    webRootPath: path.join(root, "Assets/WebRoot"), hasUnityExtension: true };
  try {
    await mkdir(config.mcpStatePath, { recursive: true });
    const timestamp = Date.now();
    const write = (name, data) => writeFile(path.join(config.mcpStatePath, name), JSON.stringify(data));
    const message = "long diagnostic \"quoted\"\n".repeat(800);
    const logs = Array.from({ length: 60 }, (_, i) => ({ level: "Error", message, timestamp: timestamp + i, index: i }));
    await write("editor-state.json", { timestamp, isCompiling: false, isUpdating: false });
    await write("console-log.json", { timestamp, logs });
    await write("compilation-status.json", { timestamp, completed: true, hasErrors: true,
      errors: logs.slice(0, 10), warnings: logs.slice(0, 10) });
    await write("import-status.json", { timestamp, completed: true, errors: [], warnings: [] });
    await write("prefab-catalog.json", { timestamp, totalCount: 100,
      categories: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["category" + i + "x".repeat(1000), {
        count: 1, prefabs: [{ name: "Prefab" + i, path: "Assets/" + "x".repeat(1000) + i + ".prefab", category: "Props" }],
      }])) });

    for (const [name, args] of [["get_console_logs", {}], ["check_import_status", { waitForImport: false }],
      ["wait_for_unity_compile", { timeoutMs: 1000 }], ["get_prefab_catalog", {}]]) {
      const response = await handleToolCall(name, args, config);
      const text = response.content[0].text;
      assert.ok(Buffer.byteLength(text) <= 65536, `${name} returned ${Buffer.byteLength(text)} bytes`);
      const data = JSON.parse(text);
      assert.equal(data.responseBudget.truncated, true, name);
      if (name.includes("compile") || name === "check_import_status") {
        assert.equal(data.success, false);
        assert.equal(data.compilationHasErrors, true);
        assert.equal(data.stale, false);
        assert.equal(data.responseBudget.collections.compilerErrors.available, 10);
        assert.ok(data.compilerErrors.length > 0);
      } else if (name === "get_console_logs") {
        assert.equal(data.logs.at(-1).index, 59);
        assert.equal(data.count, data.logs.length);
        assert.equal(data.matchingResults, 60);
      } else {
        assert.equal(data.matchingResults, 100);
        assert.equal(data.returnedResults, data.prefabs.length);
        assert.equal(data.responseBudget.collections.categories.available, 100);
      }
    }
    const full = JSON.parse((await handleToolCall("get_console_logs", { maxResponseBytes: 4 * 1024 * 1024 }, config)).content[0].text);
    assert.equal(full.count, 50);
    assert.equal(full.responseBudget.truncated, false);
    assert.deepEqual(full.logs, logs.slice(-50));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read budgets validate inputs and never present omitted errors as a clean compile", async () => {
  for (const value of [null, "65536", NaN, Infinity, 16383, 4194305, 20000.5]) {
    assert.throws(() => readResponseBudget(value), /maxResponseBytes/);
  }
  for (const name of ["get_console_logs", "check_import_status", "wait_for_unity_compile", "get_prefab_catalog"]) {
    const schema = registerTools().find((tool) => tool.name === name).inputSchema.properties.maxResponseBytes;
    assert.equal(schema.default, 65536);
    await assert.rejects(handleToolCall(name, { maxResponseBytes: "bad" }, {}), /maxResponseBytes/);
  }
  const error = { message: "\u{1f642}\"\n".repeat(20000), file: "Assets/Fail.cs", line: 12 };
  const original = { success: false, settled: true, compilationHasErrors: true, stale: true,
    message: "Compilation failed.", compilerErrors: [error], compilerWarnings: [] };
  for (const budget of [16384, 65536, 4194304]) {
    const text = boundedReadText("wait_for_unity_compile", original, budget, "state");
    const result = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= budget);
    assert.equal(result.success, false);
    assert.equal(result.compilationHasErrors, true);
    assert.equal(result.stale, true);
    assert.equal(result.responseBudget.collections.compilerErrors.available, 1);
    assert.deepEqual(result.compilerErrors, budget === 4194304 ? [error] : []);
    assert.equal(result.responseBudget.truncated, budget !== 4194304);
  }
  assert.deepEqual(original.compilerErrors, [error]);
  assert.throws(() => boundedReadText("get_console_logs", { success: false, error: "x".repeat(100000) }, 16384, "state"), /metadata exceeds/);
});
