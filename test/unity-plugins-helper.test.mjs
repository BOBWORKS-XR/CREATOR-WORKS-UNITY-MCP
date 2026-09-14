import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = 'launcher/unity/com.creatorworks.plugins';
const source = fs.readFileSync(`${root}/Editor/CreatorPluginsWindow.cs`, 'utf8');

test('optional Unity catalogue package is Editor-only without an SDK or MCP dependency', () => {
  const manifest = JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8'));
  const assembly = JSON.parse(fs.readFileSync(`${root}/Editor/CreatorWorks.Plugins.Editor.asmdef`, 'utf8'));
  assert.equal(manifest.name, 'com.creatorworks.plugins');
  assert.equal(manifest.unity, '2022.3');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(assembly.includePlatforms, ['Editor']);
  assert.equal(assembly.allowUnsafeCode, false);
  assert.match(source, /MenuItem\("Creator Plugins\/Browse"\)/);
  assert.doesNotMatch(source, /egon|start-location|4591278|4591279/);
});

test('Unity package review has one interactive import entry and no scene or automatic import calls', () => {
  assert.equal((source.match(/AssetDatabase\.ImportPackage\(/g) || []).length, 1);
  assert.match(source, /AssetDatabase\.ImportPackage\([^\n]+, true\)/);
  assert.doesNotMatch(source, /SaveScene|OpenScene|LoadScene|ImportPackage\([^\n]+false\)|Process\.Start|Task\.Run/);
  const review = source.slice(source.indexOf('internal static void Review('), source.indexOf('private static void Started('));
  assert.ok(review.indexOf('DisplayDialog') < review.indexOf('LockPackage'));
  assert.ok(review.indexOf('LockPackage') < review.indexOf('AssetDatabase.ImportPackage'));
  assert.match(review, /Receipt\(request\)\.status != "queued"/);
  assert.match(source, /importPackageCompleted \+=/);
  assert.match(source, /importPackageCancelled \+=/);
  assert.match(source, /importPackageFailed \+=/);
  const poll = source.slice(source.indexOf('private void PollInbox()'), source.indexOf('private void ClearPreview()'));
  assert.doesNotMatch(poll, /ImportPackage|LockPackage|\.Hash\(/);
  assert.match(poll, /Take\(101\)/);
});

test('queued review uses external content-addressed files and bounded transport', () => {
  assert.match(source, /request\.packageFile != request\.sha256 \+ "\.unitypackage"/);
  assert.match(source, /request\.projectPath/);
  assert.match(source, /FileAttributes\.ReparsePoint/);
  assert.match(source, /MaxPackage = 32 \* 1024 \* 1024/);
  assert.match(source, /DownloadHandlerScript/);
  assert.match(source, /redirectLimit = 0/);
  assert.match(source, /File\.Move\(temporary, path\)/);
  assert.match(source, /active-review\.json/);
  assert.match(source, /Previous import review restored\. Its outcome is not confirmed; nothing was retried\./);
});
