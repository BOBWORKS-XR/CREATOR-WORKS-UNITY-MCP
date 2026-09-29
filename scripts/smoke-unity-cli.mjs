import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runUnityCliProbe, runBoundedCliProcess, UNITY_CLI_EXPERIMENT } from "../dist/lib/unity-cli.js";
import { createConfigForProject } from "../dist/lib/config.js";
import { queryProjectState } from "../dist/tools/query-project.js";

const [executablePath, projectPath] = process.argv.slice(2);
assert.ok(executablePath && projectPath, "Pass the standalone CLI and disposable project paths.");
assert.equal(JSON.parse(fs.readFileSync(path.join(projectPath, "cli-smoke-owner.json"))).disposable, true);
const expected = JSON.parse(fs.readFileSync(path.join(projectPath, "cli-smoke-ready.json")));
assert.equal(expected.expectedObjects, 35);
const options = { enabled: true, projectPath, executablePath, timeoutMs: 15000 };
const config = createConfigForProject(projectPath);
const measurements = [];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(projectPath, file))).digest("hex");
const protectedFiles = ["Assets/CliProbe.unity", "Packages/manifest.json", "Packages/packages-lock.json", "ProjectSettings/ProjectVersion.txt"];
const before = protectedFiles.map(hash);

async function measure(label, operation) {
  const start = performance.now();
  const result = await operation();
  measurements.push({ label, ms: Math.round((performance.now() - start) * 10) / 10,
    responseBytes: Buffer.byteLength(JSON.stringify(result)), processBytes: result.processBytes ?? null });
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
}
const status = await measure("cli-status", () => runUnityCliProbe({ ...options, action: "status" }));
assert.equal(status.ready, true, JSON.stringify(status));
const catalog = await measure("cli-commands", () => runUnityCliProbe({ ...options, action: "commands", query: "find_gameobjects", limit: 3 }));
assert.ok(catalog.items.some((item) => item.name === "find_gameobjects"));
const scenes = await measure("cli-scenes", () => runUnityCliProbe({ ...options, action: "scenes" }));
assert.equal(scenes.items.length, 1);
assert.equal(scenes.items[0].path, "Assets/CliProbe.unity");
assert.equal(scenes.items[0].isDirty, false);
const literal = await measure("cli-option-like-name", () => runUnityCliProbe({ ...options, action: "find", name: '--no-cloud & "quoted"' }));
assert.equal(literal.items.length, 1);

async function compare(name, expectedCount, round) {
  const cli = () => measure(`cli-find-${round}`, () => runUnityCliProbe({ ...options, action: "find", name, limit: 20 }));
  const bridge = () => measure(`bridge-find-${round}`, () => queryProjectState("hierarchy", name, config, {
    match: "exact", fields: ["name", "path", "globalObjectId"], maxDepth: 64, maxResults: 20, refresh: true, timeoutMs: 15000,
  }));
  let a, b;
  if (round % 2) { b = await bridge(); a = await cli(); }
  else { a = await cli(); b = await bridge(); }
  assert.equal(a.query.sourceCount, expectedCount);
  assert.equal(b.query.totalMatches, expectedCount, JSON.stringify(b));
  assert.equal(b.source, "unity-live-targeted-query");
  assert.deepEqual(a.items.map((item) => item.globalId).sort(), b.data.objects.map((item) => item.globalObjectId).sort());
  assert.equal(a.query.truncated, false); assert.equal(b.query.truncated, false);
}
for (let round = 0; round < 6; round++) await compare("CLI Probe & Quoted", 2, round);
await compare("Depth30", 1, 6);
const entry = fileURLToPath(new URL("../dist/unity-cli.js", import.meta.url));
const entryResult = await runBoundedCliProcess({ executable: process.execPath,
  args: [entry, "find", "--enable", "--project", projectPath, "--executable", executablePath, "--name=CLI Probe & Quoted", "--limit", "1"],
  cwd: projectPath, timeoutMs: 30000, maxBytes: UNITY_CLI_EXPERIMENT.responseByteLimit });
assert.equal(entryResult.exitCode, 0, entryResult.stdout);
const entryJson = JSON.parse(entryResult.stdout);
assert.equal(entryJson.query.returned, 1); assert.equal(entryJson.query.omitted, 1);
assert.deepEqual(protectedFiles.map(hash), before, "Read-only inspection changed scene or project metadata.");
const report = { success: true, unityVersion: status.unityVersion, cliVersion: status.cliVersion,
  pipelineVersion: status.pipelineVersion, fixtureObjects: expected.expectedObjects, measurements,
  assertions: ["project identity", "ready status", "filtered discovery", "scene state", "literal option-like name",
    "duplicate-name identity parity", "depth-32 identity parity", "entry-point truncation", "unchanged scene/package/version hashes"],
  limitations: "Small read-only fixture; UTF-8 response bytes are not model tokens or account savings. CLI measurements include version preflight. Bridge transport bytes are not measured. No headset or production-project acceptance." };
fs.writeFileSync(path.join(projectPath, "cli-acceptance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
