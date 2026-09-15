import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = 'launcher/unity/com.creatorworks.plugins';
const source = fs.readFileSync(`${root}/Editor/CreatorPluginsWindow.cs`, 'utf8');
const windowSource = source.slice(source.indexOf('public sealed class CreatorPluginsWindow'));
function section(start, end, text = source) {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Expected bounded source section: ${start} to ${end}`);
  return text.slice(first, last);
}

test('all embedded helper files survive Windows and Unix checkout byte-for-byte', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-helper-checkout-'));
  const git = args => execFileSync('git', args, { cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const files = ['Editor/CreatorPluginsWindow.cs', 'Editor/CreatorWorks.Plugins.Editor.asmdef', 'LICENSE.md', 'package.json'];
    fs.mkdirSync(path.join(fixture, root, 'Editor'), { recursive: true });
    fs.copyFileSync('.gitattributes', path.join(fixture, '.gitattributes'));
    for (const file of files) fs.copyFileSync(`${root}/${file}`, path.join(fixture, root, file));
    git(['init', '--quiet']);
    git(['-c', 'core.autocrlf=false', 'add', '--', '.gitattributes', root]);
    for (const file of files) {
      const relative = `${root}/${file}`;
      const expected = fs.readFileSync(relative);
      assert.deepEqual(git(['show', `:${relative}`]), expected, `${file}: index bytes`);
      for (const autocrlf of ['false', 'true']) {
        assert.deepEqual(git(['-c', `core.autocrlf=${autocrlf}`, 'cat-file', '--filters', `:${relative}`]), expected, `${file}: autocrlf=${autocrlf}`);
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

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
  const review = section('internal static void Review(', 'private static void Started(');
  assert.doesNotMatch(review, /DisplayDialog\(/);
  assert.ok(review.indexOf('if (Busy)') >= 0 && review.indexOf('if (Busy)') < review.indexOf('LockPackage'));
  assert.ok(review.indexOf('LockPackage') < review.indexOf('AssetDatabase.ImportPackage'));
  assert.match(review, /Receipt\(request\)\.status != "queued"/);
  assert.match(source, /importPackageCompleted \+=/);
  assert.match(source, /importPackageCancelled \+=/);
  assert.match(source, /importPackageFailed \+=/);
  const poll = section('private void PollInbox()', 'private void ClearPreviews()');
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
  assert.match(source, /Previous import restored\. Its outcome is not confirmed; nothing was retried\./);
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
  const download = section('private void Download(Listing entry)', 'private void OpenImport(');
  assert.ok(download.indexOf('PluginProtocol.CanImport(entry)') < download.indexOf('Fetch('));
  assert.match(source, /!PluginProtocol\.CanImport\(entry\)/);
});

test('one-click import keeps safety text visible in both tabs and Unity file selection interactive', () => {
  const gui = section('private void OnGUI()', 'private void DrawCatalogue()', windowSource);
  const warning = gui.indexOf('Packages may run C# on import. Checksums confirm file integrity, not code safety.');
  assert.ok(warning >= 0 && warning < gui.indexOf('if (tab == 0)'));
  assert.match(gui, /EditorGUILayout\.HelpBox\("Packages may run C#/);
  const open = section('private void OpenImport(', 'internal static ImportRequest QueueImport(');
  assert.match(open, /ImportReview\.Review\(item\)/);
  assert.match(source, /AssetDatabase\.ImportPackage\([^\n]+, true\)/);
});

test('retry rejects instructions-only entries before download access and creates a new immutable request', () => {
  const retry = section('private void RetryImport(', 'private void CancelDownload(');
  assert.match(retry, /PluginProtocol\.CanImport\(value\) &&/);
  assert.ok(retry.indexOf('PluginProtocol.CanImport(value)') < retry.indexOf('value.download'));
  assert.ok(retry.indexOf('if (entry == null)') < retry.indexOf('Import(entry)'));
  const queue = section('internal static ImportRequest QueueImport(', 'private void RetryImport(');
  assert.match(queue, /Guid\.NewGuid\(\)\.ToString\("N"\)/);
  assert.match(queue, /PluginQueue\.Enqueue\(ImportReview\.Project, item, package\)/);
  assert.doesNotMatch(queue + retry, /File\.Delete|File\.Replace|"receipts\//);
  const start = section('private void Import(Listing entry)', 'private void Download(Listing entry)');
  assert.match(start, /if \(!Fresh\) \{ pendingImport = entry; RefreshCatalogue\(\)/);
});

test('preview requests are separate, bounded and released without hiding contribution actions', () => {
  const preview = section('private void RequestPreview(', 'internal static bool SameDownload(');
  assert.match(preview, /BoundedDownload\(2 \* 1024 \* 1024\)/);
  assert.match(preview, /redirectLimit = 0/);
  assert.ok(preview.indexOf('ImageDimensions(bytes)') < preview.indexOf('texture.LoadImage'));
  assert.match(preview, /320f \/ Mathf\.Max/);
  assert.match(preview, /RenderTexture\.ReleaseTemporary\(target\)/);
  assert.match(preview, /previewRequest\.Dispose\(\); previewRequest = null/);
  assert.match(windowSource, /OnDisable\(\).*ClearPreviews\(\)/);
  assert.doesNotMatch(preview, /ImportPackage|SaveScene|SaveAssets/);
});

test('asset organization is a separate reviewed selection, never an import callback or save', () => {
  assert.match(source, /MenuItem\("Creator Plugins\/Organize selected assets\.\.\."\)/);
  assert.match(source, /AssetOrganizer\.Plan\(Selection\.objects\)/);
  const organizer = section('internal static class AssetOrganizer', 'internal sealed class PluginQueueLock');
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

test('Unity enqueue validates bounded history under the shared native lock without rewriting receipts', () => {
  const lock = section('internal sealed class PluginQueueLock', 'internal static class PluginQueue');
  assert.match(lock, /LockFileEx\(stream.SafeFileHandle, 3, 0, uint.MaxValue, uint.MaxValue/);
  assert.match(lock, /Flock\(stream.SafeFileHandle.DangerousGetHandle\(\).ToInt32\(\), 2 \| 4\)/);
  assert.doesNotMatch(lock, /\.Lock\(|FileMode\.Create|File\.Delete/);
  const queue = section('internal static class PluginQueue', '[InitializeOnLoad]');
  assert.match(queue, /ActiveLimit = 100, ScanLimit = 1000/);
  assert.match(queue, /Take\(ScanLimit \+ 1\)/);
  assert.match(queue, /unresolved.Length >= ActiveLimit/);
  assert.match(queue, /item.request.packageId == request.packageId/);
  assert.match(queue, /archived && final == null/);
  assert.match(queue, /File\.Move\(source, destination\)/);
  assert.doesNotMatch(queue, /File\.Delete|File\.Replace|SaveNew\(project, "receipts/);
  const enqueue = queue.slice(queue.indexOf('internal static void Enqueue('));
  assert.ok(enqueue.indexOf('using (new PluginQueueLock') < enqueue.indexOf('Inspect(project)'));
  assert.ok(enqueue.indexOf('Inspect(project)') < enqueue.indexOf('File.Move'));
  assert.ok(enqueue.indexOf('Verify(PluginProtocol.ReadBounded(cache') < enqueue.indexOf('File.Move'));
  const callback = section('private static void Complete(', 'private static void ReleaseLock(');
  assert.doesNotMatch(callback, /PluginQueueLock/);
});
