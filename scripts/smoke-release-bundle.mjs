import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sourceBundle = path.resolve("release", "creator-works-mcp.mjs");
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
assert.ok(statSync(sourceBundle).size > 100_000, "Release bundle is unexpectedly small");

const source = readFileSync(sourceBundle, "utf8");
assert.match(source, /Creator Works MCP running on stdio/);

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "creator-works-bundle-smoke-"));
const isolatedBundle = path.join(temporaryDirectory, "creator-works-mcp.mjs");
let serverProcess;

try {
  copyFileSync(sourceBundle, isolatedBundle);
  const result = spawnSync(process.execPath, [isolatedBundle, "--http"], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /HTTP transport is not implemented/);

  serverProcess = spawn(process.execPath, [isolatedBundle], {
    cwd: temporaryDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdoutBuffer = "";
  const pending = new Map();

  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timeout);
        pending.delete(message.id);
        request.resolve(message);
      }
    }
  });
  serverProcess.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(`MCP bundle exited with code ${code}: ${stderr}`));
    }
    pending.clear();
  });

  const request = (message) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error(`Timed out waiting for MCP response ${message.id}: ${stderr}`));
    }, 10_000);
    pending.set(message.id, { resolve, reject, timeout });
    serverProcess.stdin.write(`${JSON.stringify(message)}\n`);
  });

  const initialize = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "creator-works-release-smoke", version: "1.0.0" },
    },
  });
  assert.equal(initialize.result?.serverInfo?.name, "creator-works-mcp");
  assert.equal(initialize.result?.serverInfo?.version, packageVersion);

  serverProcess.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })}\n`);
  const tools = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(tools.result?.tools?.length, 52);
  assert.ok(tools.result.tools.some((tool) => tool.name === "validate_vs_graph_in_unity"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "validate_banter_visual_scripting"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "search_sidequest_vs_nodes"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "get_unity_command_status"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "wait_for_unity_compile"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "execute_editor_menu_item"));
  const reference = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "get_mcp_reference", arguments: { source: "manual", query: "SetMember", limit: 1 },
  } });
  const referenceText = reference.result?.content?.[0]?.text;
  assert.ok(referenceText, JSON.stringify(reference));
  const excerpt = JSON.parse(referenceText);
  assert.equal(excerpt.success, true);
  assert.equal(excerpt.returned, 1);
  assert.ok(excerpt.guidance.length > 0);
  assert.ok(Buffer.byteLength(referenceText) <= 16384);
  const prompt = await request({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "create_vs_graph", arguments: {} } });
  assert.match(JSON.stringify(prompt.result), /get_mcp_reference/);

  console.log(`Standalone MCP bundle smoke test passed (${statSync(sourceBundle).size} bytes)`);
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = new Promise((resolve) => serverProcess.once("exit", resolve));
    serverProcess.kill();
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Timed out stopping isolated MCP bundle")),
        5_000
      )),
    ]);
  }
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
