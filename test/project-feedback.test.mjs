import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectFeedback, FEEDBACK_HEADER } from '../dist/tools/project-feedback.js';

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-feedback-'));
  fs.mkdirSync(path.join(project, 'Assets'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return { unityProjectPath: project, mcpStatePath: path.join(project, '.bantworks-mcp', 'state') };
}
const enable = { action: 'configure', enabled: true, usageCheckIns: true, userConsent: true };
const day = 86400000;

test('feedback defaults off without creating files and cannot enable itself without consent', async t => {
  const c = fixture(t);
  assert.equal((await projectFeedback({}, c)).enabled, false);
  assert.equal((await projectFeedback({ action: 'record', attempted: 'test' }, c)).disabled, true);
  assert.equal((await projectFeedback({ ...enable, userConsent: false }, c)).success, false);
  assert.deepEqual(fs.readdirSync(c.unityProjectPath), ['Assets']);
});

test('usage requires per-report consent; notes append without overwriting manual entries', async t => {
  const c = fixture(t);
  const { file } = await projectFeedback(enable, c, 1000);
  assert.equal(fs.readFileSync(file, 'utf8'), FEEDBACK_HEADER);
  fs.appendFileSync(file, '\nManual note\n');
  assert.equal((await projectFeedback({ action: 'record', usage: '20% left' }, c)).success, false);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /20%/);
  const result = await projectFeedback({ action: 'record', usage: '20% left (weekly)', userConsent: true, actual: 'Placed a room' }, c);
  assert.equal(result.usageRecorded, true);
  assert.equal(result.uploaded, false);
  assert.match(fs.readFileSync(file, 'utf8'), /Manual note[\s\S]*20% left \(weekly\)/);
  assert.equal((await projectFeedback({ action: 'configure', enabled: false }, c)).enabled, false);
  assert.equal((await projectFeedback({ action: 'record', actual: 'later' }, c)).disabled, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /later/);
});

test('check-ins require five unique task boundaries and 24 hours; retries and restart cannot nag', async t => {
  const c = fixture(t);
  await projectFeedback(enable, c, 1000);
  for (let i = 0; i < 5; i++) assert.equal((await projectFeedback({ action: 'task_complete', taskId: `task${i}` }, c, 2000)).promptDue, false);
  assert.equal((await projectFeedback({ action: 'task_complete', taskId: 'task4' }, c, day + 2000)).duplicate, true);
  assert.equal((await projectFeedback({ action: 'task_complete', taskId: 'task5' }, c, day + 2000)).promptDue, true);
  for (let i = 6; i < 15; i++) assert.equal((await projectFeedback({ action: 'task_complete', taskId: `task${i}` }, c, day + 3000)).promptDue, false);
  assert.equal((await projectFeedback({ action: 'task_complete', taskId: 'task15' }, c, 2 * day + 3000)).promptDue, true);
});

test('feedback is project scoped, bounded, and quotes supplied markup as data', async t => {
  const c = fixture(t), other = fixture(t);
  const { file } = await projectFeedback(enable, c);
  assert.equal((await projectFeedback({}, other)).enabled, false);
  assert.equal((await projectFeedback({ action: 'record', actual: 'x'.repeat(1001) }, c)).success, false);
  await projectFeedback({ action: 'record', actual: '<script>alert(1)</script>\n[upload](https://invalid.example)' }, c);
  const note = fs.readFileSync(file, 'utf8');
  assert.match(note, /&lt;script&gt;/);
  assert.match(note, /> \\\[upload\\\]/);
  assert.doesNotMatch(note, /<script>/);
});

test('a held cross-process lock refuses writes without corrupting feedback', async t => {
  const c = fixture(t);
  const { file } = await projectFeedback(enable, c);
  const before = fs.readFileSync(file, 'utf8');
  const lock = path.join(path.dirname(file), '.write-lock');
  fs.writeFileSync(lock, '');
  assert.equal((await projectFeedback({ action: 'record', actual: 'not written' }, c)).success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(lock), true);
});
