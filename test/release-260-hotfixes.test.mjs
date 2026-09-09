import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getUnityCommandStatus } from '../dist/tools/get-unity-command-status.js';
import { handleToolCall } from '../dist/tools/index.js';

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-260-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const c = { unityProjectPath: project, projectId: 'unity-fixture', assetsPath: path.join(project, 'Assets'),
    mcpStatePath: path.join(project, '.bantworks-mcp/state'), mcpCommandsPath: path.join(project, '.bantworks-mcp/commands') };
  fs.mkdirSync(c.mcpStatePath, { recursive: true });
  fs.mkdirSync(c.assetsPath, { recursive: true });
  return c;
}

test('retained dispatch survives pipe timeout without claiming completion or encouraging retry', t => {
  const c = fixture(t), id = randomUUID();
  const folder = path.join(c.mcpStatePath, 'command-status');
  fs.mkdirSync(folder);
  const file = path.join(folder, `${id}.json`);
  const record = { commandId: id, status: 'dispatched', success: false, projectPath: c.unityProjectPath, editorInstanceId: 'editor1', timestamp: 1000 };
  fs.writeFileSync(file, JSON.stringify(record));
  const pending = getUnityCommandStatus(id, c.projectId, c);
  assert.equal(pending.status, 'dispatched');
  assert.equal(pending.success, false);
  assert.equal(pending.pending, true);
  assert.match(pending.message, /not proof.*still running/);
  fs.writeFileSync(file, JSON.stringify({ ...record, status: 'completed', success: true, observed: { worldPosition: [1, 2, 3] } }));
  for (let i = 0; i < 2; i++) {
    const complete = getUnityCommandStatus(id, c.projectId, c);
    assert.equal(complete.status, 'completed');
    assert.deepEqual(complete.observed.worldPosition, [1, 2, 3]);
  }
  fs.writeFileSync(path.join(c.mcpStatePath, 'project-instance.json'), JSON.stringify({ editorInstanceId: 'editor2' }));
  assert.equal(getUnityCommandStatus(id, c.projectId, c).success, false);
});

test('hierarchy metadata leads the payload and old snapshots are explicitly unverified', async t => {
  const c = fixture(t);
  const file = path.join(c.mcpStatePath, 'scene-hierarchy.json');
  const objects = Array.from({ length: 32 }, (_, i) => ({ name: `depth${i}`, path: `Root/${i}`, depth: i }));
  for (const complete of [undefined, true, false]) {
    fs.writeFileSync(file, JSON.stringify({ sceneName: 'Fixture', timestamp: Date.now(), objects, complete }));
    const response = await handleToolCall('query_project_state', { query: 'hierarchy', refresh: false, maxResults: 100, fields: ['name', 'depth'] }, c);
    const text = response.content[0].text;
    const body = JSON.parse(text);
    assert.equal(body.query.sourceCompleteness, complete === undefined ? 'unknown' : complete ? 'complete' : 'incomplete');
    assert.ok(text.indexOf('"query"') < text.indexOf('"data"'));
    assert.equal(body.data.objects.length, 32);
    assert.equal(body.query.responseBytes, Buffer.byteLength(text));
  }
});

test('bridge exports all depths iteratively and journals dispatch before calling Unity', () => {
  const source = fs.readFileSync('unity-extension/Editor/BanterMCPBridge.cs', 'utf8');
  const traversal = source.slice(source.indexOf('private static void AddObjectToHierarchy'), source.indexOf('private static GameObjectInfo CreateGameObjectInfo'));
  assert.match(traversal, /Stack<KeyValuePair<GameObject, int>>/);
  assert.doesNotMatch(traversal, /depth\s*</);
  const dispatcher = source.slice(source.indexOf('private static string ProcessCommandJson'), source.indexOf('private static void ArchiveFailedCommand'));
  assert.ok(dispatcher.indexOf('ValidateCommandTarget') < dispatcher.indexOf('dispatch.status'));
  assert.ok(dispatcher.indexOf('dispatch.status') < dispatcher.indexOf('switch (baseCommand.type)'));
  assert.match(source, /CaptureTransformReceipt\(CreateGameObject\(createCmd\)\)/);
  assert.match(source, /CaptureTransformReceipt\(ModifyGameObject\(modifyCmd\)\)/);
});
