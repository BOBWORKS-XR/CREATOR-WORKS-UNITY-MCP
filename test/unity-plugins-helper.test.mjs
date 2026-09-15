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

test('Unity started callback does not claim the user approved or imported files', () => {
  const started = source.slice(source.indexOf('private static void Started('), source.indexOf('private static void Finished('));
  assert.match(started, /before approval/);
  assert.doesNotMatch(started, /WriteReceipt|SaveNew|File\./);
  assert.doesNotMatch(source, /File\.Replace|WriteReceipt/);
  const complete = source.slice(source.indexOf('private static void Complete('), source.indexOf('private static void ReleaseLock('));
  assert.match(complete, /PluginProtocol\.SaveNew\(Project, "receipts\//);
  assert.ok(complete.indexOf('RequireSameRequest') < complete.indexOf('PluginProtocol.SaveNew'));
  assert.ok(complete.indexOf('PluginProtocol.SaveNew') < complete.indexOf('File.Delete'));
});

test('omitted Unity catalogue review state remains pending rather than download-enabled', () => {
  assert.match(source, /if \(entry.reviewStatus == null\) entry.reviewStatus = "pending"/);
  assert.match(source, /entry.reviewStatus != "listed"/);
});

test('Unity catalogue checks its type-aware import route before fetching or queueing bytes', () => {
  const download = source.slice(source.indexOf('private void Download(Listing entry)'), source.indexOf('private void Link('));
  assert.ok(download.indexOf('PluginProtocol.CanImport(entry)') < download.indexOf('Fetch('));
  assert.match(source, /!PluginProtocol\.CanImport\(selected\)/);
});

test('asset organization is a separate reviewed selection, never an import callback or save', () => {
  assert.match(source, /MenuItem\("Creator Plugins\/Organize selected assets\.\.\."\)/);
  assert.match(source, /AssetOrganizer\.Plan\(Selection\.objects\)/);
  const organizer = source.slice(source.indexOf('internal static class AssetOrganizer'), source.indexOf('[InitializeOnLoad]'));
  assert.match(organizer, /AssetDatabase\.MoveAsset/);
  assert.match(organizer, /AssetDatabase\.ValidateMoveAsset/);
  assert.match(organizer, /AssetDatabase\.IsSubAsset/);
  assert.match(organizer, /EditorUtility\.IsDirty/);
  assert.match(organizer, /guid != plan\[i\]\.guid/);
  assert.doesNotMatch(organizer, /GetDependencies|SaveAssets|SaveScene|SaveAssetIfDirty|ImportPackage|SaveNew/);
  const apply = organizer.slice(organizer.indexOf('internal static int Apply'));
  assert.ok(apply.indexOf('var current = Plan(') < apply.indexOf('AssetDatabase.CreateFolder'));
  const callbacks = source.slice(source.indexOf('internal static class ImportReview'), source.indexOf('public sealed class CreatorPluginsWindow'));
  assert.doesNotMatch(callbacks, /AssetOrganizer|OrganizeAssetsWindow/);
});
