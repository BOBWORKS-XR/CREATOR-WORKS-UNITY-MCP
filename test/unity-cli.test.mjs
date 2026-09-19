import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { UNITY_CLI_EXPERIMENT as pins, findUnityCliExecutable, runUnityCliProbe, runBoundedCliProcess } from "../dist/lib/unity-cli.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "creator-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  fs.mkdirSync(path.join(root, "Assets"));
  write("ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.3.21f1\n");
  write("Packages/manifest.json", { dependencies: { "com.unity.pipeline": pins.pipelineVersion } });
  const lock = { dependencies: { "com.unity.pipeline": { version: pins.pipelineVersion, source: "registry", url: "https://packages.unity.com" } } };
  write("Packages/packages-lock.json", lock);
  write("unity.exe", "mock runner only, never executed");
  const options = { enabled: true, projectPath: root, executablePath: path.join(root, "unity.exe"), action: "find", name: "Exact & Quoted" };
  const calls = [];
  const envelope = {
    success: true, command: "command find_gameobjects", errors: [], warnings: [],
    data: { command: "find_gameobjects", parameters: { name: options.name }, success: true, target: { projectPath: root, host: "127.0.0.1" },
      result: { count: 2, gameObjects: [1, 2].map((id) => ({ instanceId: -id, globalId: `global-${id}`, hierarchyPath: "/Root/Exact & Quoted", type: "GameObject" })) } },
  };
  const runner = async (request) => {
    calls.push(request);
    return { exitCode: 0, stderr: "", stdout: request.args[0] === "--version" ? `${pins.cliVersion}\n` : JSON.stringify(envelope) };
  };
  return { root, write, lock, options, calls, envelope, runner };
}

test("disabled by default, with no filesystem or process access", async () => {
  const r = await runUnityCliProbe({ projectPath: "missing", action: "status" }, () => assert.fail("must not spawn"));
  assert.equal(r.error.code, "EXPERIMENT_DISABLED");
});

for (const [name, change, code] of [
  ["Unity 2022", (f) => f.write("ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 2022.3.39f1\n"), "UNITY_VERSION_UNSUPPORTED"],
  ["unknown Unity version", (f) => f.write("ProjectSettings/ProjectVersion.txt", "not a version"), "UNITY_VERSION_UNKNOWN"],
  ["missing Pipeline", (f) => { delete f.lock.dependencies["com.unity.pipeline"]; }, "PIPELINE_MISSING"],
  ["different Pipeline version", (f) => { f.lock.dependencies["com.unity.pipeline"].version = "0.7.0"; }, "PIPELINE_UNSUPPORTED"],
  ["untrusted registry", (f) => { f.lock.dependencies["com.unity.pipeline"].url = "https://example.com"; }, "PIPELINE_UNSUPPORTED"],
  ["local Pipeline", (f) => { f.lock.dependencies["com.unity.pipeline"].source = "local"; }, "PIPELINE_UNSUPPORTED"],
  ["old Assistant", (f) => { f.lock.dependencies["com.unity.ai.assistant"] = { version: "2.12.0" }; }, "ASSISTANT_CONFLICT"],
  ["relative project", (f) => { f.options.projectPath = "relative"; }, "PROJECT_REQUIRED"],
  ["missing CLI", (f) => { f.options.executablePath += ".missing"; }, "CLI_NOT_FOUND"],
  ["eval blocked", (f) => { f.options.action = "eval"; }, "ACTION_NOT_ALLOWED"],
  ["empty search", (f) => { f.options.name = " "; }, "NAME_REQUIRED"],
  ["control characters", (f) => { f.options.name = "a\nb"; }, "NAME_REQUIRED"],
  ["unbounded result count", (f) => { f.options.limit = 101; }, "INVALID_LIMIT"],
  ["unbounded timeout", (f) => { f.options.timeoutMs = 999999; }, "INVALID_TIMEOUT"],
  ["irrelevant arguments", (f) => { f.options.query = "other"; }, "UNEXPECTED_ARGUMENT"],
]) {
  test(`preflight rejects ${name} without spawning`, async (t) => {
    const f = fixture(t);
    change(f);
    f.write("Packages/packages-lock.json", f.lock);
    const result = await runUnityCliProbe(f.options, f.runner);
    assert.equal(result.error?.code, code);
    assert.equal(f.calls.length, 0);
  });
}

test("malformed, oversized and escaped metadata are rejected", async (t) => {
  const f = fixture(t);
  f.write("Packages/manifest.json", "{");
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "INVALID_PROJECT_METADATA");
  f.write("Packages/manifest.json", " ".repeat(512 * 1024 + 1));
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "UNSAFE_PROJECT_METADATA");
  fs.rmSync(path.join(f.root, "Packages"), { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "creator-cli-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "manifest.json"), "{}");
  fs.symlinkSync(outside, path.join(f.root, "Packages"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "UNSAFE_PROJECT_METADATA");
  assert.equal(f.calls.length, 0);
});

test("transitive official Pipeline and new Assistant are accepted", async (t) => {
  const f = fixture(t);
  f.write("Packages/manifest.json", { dependencies: {} });
  f.lock.dependencies["com.unity.ai.assistant"] = { version: "2.19.0" };
  f.write("Packages/packages-lock.json", f.lock);
  assert.equal((await runUnityCliProbe(f.options, f.runner)).success, true);
});

test("Editor executable is never run as a CLI version probe", async (t) => {
  const f = fixture(t);
  f.write("Data/Resources/marker", "");
  assert.throws(() => findUnityCliExecutable(f.options.executablePath), { code: "CLI_NOT_FOUND" });
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "CLI_NOT_FOUND");
  assert.equal(f.calls.length, 0);
});

test("unknown CLI version prevents Editor commands", async (t) => {
  const f = fixture(t);
  const r = await runUnityCliProbe(f.options, async (request) => {
    f.calls.push(request);
    return { exitCode: 0, stdout: "2.0.0", stderr: "" };
  });
  assert.equal(r.error.code, "CLI_VERSION_UNSUPPORTED");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ["--version"]);
});

test("exact identity, explicit project, quoted and option-like names survive as one argument", async (t) => {
  const f = fixture(t);
  f.options.name = '--no-cloud & "quoted"';
  f.envelope.data.parameters.name = f.options.name;
  const r = await runUnityCliProbe(f.options, f.runner);
  assert.equal(r.success, true);
  assert.equal(r.query.sourceCount, 2);
  assert.notEqual(r.items[0].globalId, r.items[1].globalId);
  const request = f.calls[1];
  assert.ok(request.args.includes(`--name=${f.options.name}`));
  assert.equal(request.args[request.args.indexOf("--project-path") + 1], f.root);
  assert.equal(request.cwd, f.root);
  assert.equal(request.maxBytes, pins.processByteLimit);
  assert.equal(request.args.includes("eval"), false);
});

for (const [name, edit, code] of [
  ["different project", (f) => { f.envelope.data.target.projectPath = os.tmpdir(); }, "PROJECT_MISMATCH"],
  ["remote target", (f) => { f.envelope.data.target.host = "example.com"; }, "PROJECT_MISMATCH"],
  ["different command", (f) => { f.envelope.command = "command eval"; }, "COMMAND_MISMATCH"],
  ["different name parameter", (f) => { f.envelope.data.parameters.name = "Other object"; }, "PARAMETER_MISMATCH"],
  ["failed inner command", (f) => { f.envelope.data.success = false; }, "COMMAND_MISMATCH"],
  ["upstream errors", (f) => { f.envelope.errors = [{ code: "BUSY", message: "secret raw output" }]; }, "UPSTREAM_FAILED"],
  ["inconsistent count", (f) => { f.envelope.data.result.count = 1; }, "INVALID_RESPONSE"],
  ["missing identity", (f) => { delete f.envelope.data.result.gameObjects[0].instanceId; }, "INVALID_RESPONSE"],
  ["missing warnings", (f) => { delete f.envelope.warnings; }, "INVALID_RESPONSE"],
]) {
  test(`response rejects ${name} without retry`, async (t) => {
    const f = fixture(t); edit(f);
    const r = await runUnityCliProbe(f.options, f.runner);
    assert.equal(r.error?.code, code);
    assert.equal(r.fallbackSubmitted, false);
    assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(r).includes("secret raw output"), false);
  });
}

test("malformed JSON, failed exit and overflow never produce success", async (t) => {
  const f = fixture(t);
  for (const [result, code] of [
    [{ stdout: "{} broken" }, "INVALID_RESPONSE"],
    [{ stdout: JSON.stringify(f.envelope), exitCode: 1 }, "UPSTREAM_FAILED"],
    [{ stdout: "x".repeat(pins.processByteLimit + 1) }, "CLI_OUTPUT_LIMIT"],
  ]) {
    const r = await runUnityCliProbe(f.options, async (request) => request.args[0] === "--version"
      ? f.runner(request) : { stderr: "", exitCode: 0, ...result });
    assert.equal(r.error?.code, code);
  }
});

test("whole-item limits preserve counts and Unicode JSON byte budget", async (t) => {
  const f = fixture(t);
  f.options.limit = 1;
  let r = await runUnityCliProbe(f.options, f.runner);
  assert.equal(r.query.returned, 1); assert.equal(r.query.omitted, 1); assert.equal(r.query.truncated, true);
  f.options.limit = 100;
  f.envelope.data.result = { count: 30, gameObjects: Array.from({ length: 30 }, (_, i) => ({
    instanceId: i, globalId: `global-${i}`, hierarchyPath: "\u4e00".repeat(1300), type: "GameObject",
  })) };
  r = await runUnityCliProbe(f.options, f.runner);
  assert.equal(r.success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= pins.responseByteLimit);
  assert.ok(r.query.returned > 0 && r.query.returned < 30);
  assert.equal(r.query.returned + r.query.omitted, 30);
  assert.equal(r.items.at(-1).hierarchyPath.length, 1300);
});

test("compact discovery requires a query and propagates upstream total", async (t) => {
  const f = fixture(t);
  f.options = { ...f.options, action: "commands", name: undefined, query: "--find", limit: 1 };
  f.envelope.command = "command";
  Object.assign(f.envelope.data, { commands: [{ name: "find_gameobjects", description: "Find by name", package: "Unity.Pipeline.Editor" }], count: 1, total: 12, offset: 0 });
  const r = await runUnityCliProbe(f.options, f.runner);
  assert.equal(r.success, true); assert.equal(r.query.omitted, 11);
  assert.ok(f.calls[1].args.includes("--query=--find"));
  assert.ok(f.calls[1].args.includes("compact"));
  f.options.query = "";
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "QUERY_REQUIRED");
});

test("status requires the expected Editor, fresh heartbeat and no compile/reload", async (t) => {
  const f = fixture(t);
  f.options = { ...f.options, action: "status", name: undefined };
  f.envelope.command = "command editor_status"; f.envelope.data.command = "editor_status";
  const status = { projectPath: f.root, unityVersion: "6000.3.21f1", status: "ready", compiling: false,
    domainReloadInProgress: false, playMode: "stopped", lastHeartbeat: new Date().toISOString() };
  f.envelope.data.result = status;
  assert.equal((await runUnityCliProbe(f.options, f.runner)).ready, true);
  for (const change of [{ compiling: true }, { domainReloadInProgress: true }, { lastHeartbeat: "2000-01-01T00:00:00Z" }, { lastHeartbeat: "invalid" }]) {
    f.envelope.data.result = { ...status, ...change };
    assert.equal((await runUnityCliProbe(f.options, f.runner)).ready, false);
  }
  f.envelope.data.result = { ...status, unityVersion: "6000.3.22f1" };
  assert.equal((await runUnityCliProbe(f.options, f.runner)).error.code, "EDITOR_IDENTITY_MISMATCH");
});

test("scene metadata and diagnostic presence are retained without raw logs", async (t) => {
  const f = fixture(t);
  f.options = { ...f.options, action: "scenes", name: undefined };
  f.envelope.command = "command list_open_scenes"; f.envelope.data.command = "list_open_scenes";
  f.envelope.data.result = { count: 1, scenes: [{ name: "Test", path: "Assets/Test.unity", isLoaded: true, isDirty: true, isActive: true, rootCount: 1 }] };
  f.envelope.warnings = [{ code: "TEST_WARNING", message: "secret" }];
  const r = await runUnityCliProbe(f.options, async (request) => ({ ...await f.runner(request), stderr: "secret" }));
  assert.equal(r.success, true); assert.equal(r.items[0].isDirty, true);
  assert.equal(r.stderrBytes, 12); assert.equal(r.diagnosticsWithheld, true);
  assert.deepEqual(r.warnings, ["TEST_WARNING"]);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});

const processRequest = (source, override = {}) => ({ executable: process.execPath, args: ["-e", source], cwd: os.tmpdir(), timeoutMs: 3000, maxBytes: 4096, ...override });
test("process runner bounds stdout and stderr and waits for process termination", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(runBoundedCliProcess(processRequest(`process.${stream}.write('x'.repeat(10000)); setInterval(()=>{},1000)`)), { code: "CLI_OUTPUT_LIMIT" });
  }
  await assert.rejects(runBoundedCliProcess(processRequest("setInterval(()=>{},1000)", { timeoutMs: 100 })), { code: "CLI_TIMEOUT" });
  await assert.rejects(runBoundedCliProcess(processRequest("", { executable: path.join(os.tmpdir(), "does-not-exist-cli.exe") })), { code: "CLI_START_FAILED" });
});

test("process arguments remain literal and ambient Unity variables are removed", async () => {
  const key = "UNITY_CLI_TEST_TARGET";
  const previous = process.env[key]; process.env[key] = "not-the-selected-project";
  try {
    const r = await runBoundedCliProcess({ ...processRequest("console.log(JSON.stringify([process.argv[1],process.env.UNITY_CLI_TEST_TARGET,process.env.UNITY_NO_CLOUD]))"),
      args: ["-e", "console.log(JSON.stringify([process.argv[1],process.env.UNITY_CLI_TEST_TARGET,process.env.UNITY_NO_CLOUD]))", "--", '& "literal"'] });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), ['& "literal"', null, "1"]);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test("entry point provides help and rejects unknown/multiple actions without touching Unity", () => {
  const entry = fileURLToPath(new URL("../dist/unity-cli.js", import.meta.url));
  for (const args of [["eval", "--enable"], ["status"], ["status", "find"], ["status", "--unknown"]]) {
    const r = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.notEqual(r.status, 0); assert.equal(JSON.parse(r.stdout).success, false);
  }
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stdout, /Not part of the installed launcher/);
});
