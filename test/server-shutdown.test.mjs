import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

async function start(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'creator-stdio-test-'));
  mkdirSync(path.join(root, 'Assets'));
  const child = spawn(process.env.MCP_SHUTDOWN_NODE || process.execPath, [process.env.MCP_SHUTDOWN_ENTRY || 'dist/index.js'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, UNITY_PROJECT_PATH: root, BANTER_PROJECT_PATH: root,
      CREATOR_WORKS_LAUNCHER_CONFIG: path.join(root, 'no-config.json'), CREATOR_WORKS_TOOL_GROUPS: 'all' },
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const responses = new Map();
  let buffer = '';
  child.stdout.on('data', b => {
    buffer += b;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      responses.set(msg.id, msg);
    }
  });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  async function response(id) {
    for (let i = 0; i < 200 && !responses.has(id); i++) await delay(25);
    assert.ok(responses.has(id), `No response ${id}: ${stderr}`);
    return responses.get(id);
  }
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
    capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' } } });
  await response(1);
  send({ method: 'notifications/initialized' });
  return { child, exited, send, response };
}

test('connected idle server stays alive and remains usable', async t => {
  const s = await start(t);
  await delay(500);
  assert.equal(s.child.exitCode, null);
  s.send({ id: 2, method: 'tools/list' });
  assert.ok((await s.response(2)).result.tools.length > 0);
});

for (const pending of [false, true]) test(`stdin EOF exits ${pending ? 'during a pending Unity wait' : 'while idle'}`, async t => {
  const s = await start(t);
  if (pending) {
    s.send({ id: 2, method: 'tools/call', params: { name: 'wait_for_unity_compile', arguments: { timeoutMs: 120000 } } });
    // A later ping proves the pending request has entered the server.
    s.send({ id: 3, method: 'ping' });
    await s.response(3);
  }
  s.child.stdin.end();
  const result = await Promise.race([s.exited, delay(2000).then(() => null)]);
  assert.ok(result, 'Server kept its runtime locked after the client disconnected');
  assert.equal(result.code, 0);
});
