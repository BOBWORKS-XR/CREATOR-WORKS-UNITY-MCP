import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function startServer(toolGroups, environmentVariable = "CREATOR_WORKS_TOOL_GROUPS") {
  const env = { ...process.env };
  delete env.CREATOR_WORKS_TOOL_GROUPS;
  delete env.BANTWORKS_TOOL_GROUPS;
  env[environmentVariable] = toolGroups;
  const child = spawn(process.execPath, ["dist/index.js"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdoutBuffer = "";
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
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

  const request = (message) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error(`Timed out waiting for response ${message.id}: ${stderr}`));
    }, 10_000);
    pending.set(message.id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };

  return { child, request, stop, stderr: () => stderr };
}

test("stdio tools/list honors CREATOR_WORKS_TOOL_GROUPS", async () => {
  const server = await startServer("read");
  try {
    const initialized = await server.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tool-group-test", version: "1.0.0" },
      },
    });
    assert.equal(initialized.result?.serverInfo?.name, "creator-works-mcp");
    server.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const response = await server.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = new Set(response.result.tools.map((tool) => tool.name));

    assert.ok(names.has("list_unity_projects"));
    assert.ok(names.has("query_project_state"));
    assert.ok(!names.has("create_gameobject"));
    assert.ok(!names.has("run_unity_tests"));
    assert.match(server.stderr(), /tool groups: read/);
  } finally {
    await server.stop();
  }
});

test("stdio token-saver profile exposes only the compact general surface", async () => {
  const server = await startServer("core");
  try {
    await server.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "token-saver-test", version: "1.0.0" },
      },
    });
    server.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const response = await server.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = new Set(response.result.tools.map((tool) => tool.name));

    assert.equal(names.size, 25);
    assert.ok(names.has("query_project_state"));
    assert.ok(names.has("create_gameobject"));
    assert.ok(!names.has("search_sidequest_vs_nodes"));
    assert.ok(!names.has("generate_vs_graph"));
    assert.match(server.stderr(), /tool groups: core/);
  } finally {
    await server.stop();
  }
});

test("legacy BANTWORKS_TOOL_GROUPS remains an upgrade fallback", async () => {
  const server = await startServer("none", "BANTWORKS_TOOL_GROUPS");
  try {
    const initialized = await server.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-tool-group-test", version: "1.0.0" },
      },
    });
    assert.equal(initialized.result?.serverInfo?.name, "creator-works-mcp");
    server.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const response = await server.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(
      response.result.tools.map((tool) => tool.name).sort(),
      ["get_bridge_status", "get_unity_command_status", "list_unity_projects", "select_unity_project"].sort()
    );
  } finally {
    await server.stop();
  }
});

test("invalid tool groups stop server startup", async () => {
  const server = await startServer("read,admin");
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Invalid server did not exit")), 10_000);
    server.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exitCode, 1);
  assert.match(server.stderr(), /Unknown CREATOR_WORKS_TOOL_GROUPS value/);
});
