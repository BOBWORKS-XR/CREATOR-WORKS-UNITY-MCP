using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CreatorWorks.Plugins.Editor.Tests")]

namespace CreatorWorks.Plugins
{
    [Serializable] internal sealed class CatalogueIndex { public int schemaVersion; public string[] entries; }
    [Serializable] internal sealed class Author { public string name, url, discord; }
    [Serializable] internal sealed class Compatibility { public string[] unity, creatorSdk, banterSdk; }
    [Serializable] internal sealed class PackageDownload { public string url, path, sha256; public long byteLength; }
    [Serializable] internal sealed class Listing
    {
        public int schemaVersion;
        public string id, version, name, category, description, license, licensePath, instructionsPath;
        public string sourceUrl, discussionUrl, previewImage, scope, testNotes, usage, reviewStatus;
        public Author author;
        public Compatibility compatibility;
        public string[] dependencies, contents;
        public bool includesCode;
        public PackageDownload download;
    }
    [Serializable] internal sealed class ImportRequest
    {
        public int schemaVersion = 1;
        public string requestId, projectPath, packageId, version, name, sha256, packageFile;
        public long byteLength;
    }
    [Serializable] internal sealed class ImportReceipt
    {
        public int schemaVersion = 1;
        public string requestId, status, message;
    }

    // Pure file/identity policy is separated from Editor APIs for offline contract tests.
    internal static class PluginProtocol
    {
        internal const string Root = "https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/";
        internal const string Repository = "https://github.com/SideQuestVR/Creator-Community";
        internal const long MaxPackage = 32 * 1024 * 1024;
        internal static bool Hex(string value, int length) => value != null && value.Length == length && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
        internal static bool Text(string value, int max) => !string.IsNullOrWhiteSpace(value) && value.Length <= max && !value.Any(c => char.IsControl(c) && c != '\n' && c != '\t');
        internal static string ReceiptMessage(string value)
        {
            string text = (value ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
            text = new string(text.Select(c => char.IsControl(c) && c != '\n' && c != '\t' ? ' ' : c).ToArray());
            if (string.IsNullOrWhiteSpace(text)) return "Unity reported a final import outcome.";
            if (text.Length > 4000) text = text.Substring(0, char.IsHighSurrogate(text[3999]) ? 3999 : 4000);
            return text;
        }
        internal static bool Id(string value) => Text(value, 100) && value.Contains(".") && Regex.IsMatch(value, @"^[a-z0-9][a-z0-9.-]*\z");
        internal static bool Version(string value) => Text(value, 80) && Regex.IsMatch(value, @"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\z");
        internal static bool RepositoryPath(string value) => value != null && value.Length <= 500 && value.Contains("/") && value.Split('/').All(p => Regex.IsMatch(p, @"^[A-Za-z0-9_-][A-Za-z0-9._-]*\z"));
        internal static string RepositoryUrl(string path)
        {
            if (!RepositoryPath(path)) throw new InvalidDataException("Invalid catalogue path.");
            return Root + path;
        }
        internal static bool WebUrl(string value, bool media = false)
        {
            if (value == null || value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0) return false;
            if (uri.Host == "cdn.sidequestvr.com") return uri.AbsolutePath.StartsWith("/file/", StringComparison.Ordinal);
            if (uri.Host == "raw.githubusercontent.com") return uri.AbsolutePath.StartsWith("/SideQuestVR/Creator-Community/main/", StringComparison.Ordinal);
            return !media && (uri.Host == "github.com" || uri.Host == "discord.com") && uri.AbsolutePath != "/";
        }
        internal static string DownloadUrl(PackageDownload download)
        {
            if (download == null || download.byteLength <= 0 || download.byteLength > MaxPackage || !Hex(download.sha256, 64)) throw new InvalidDataException("Invalid package size or checksum.");
            if (string.IsNullOrEmpty(download.url) == string.IsNullOrEmpty(download.path)) throw new InvalidDataException("Package needs exactly one download location.");
            string url = string.IsNullOrEmpty(download.url) ? RepositoryUrl(download.path) : download.url;
            if (!WebUrl(url) || !(new Uri(url).AbsolutePath.EndsWith(".unitypackage", StringComparison.Ordinal) || new Uri(url).AbsolutePath.EndsWith(".zip", StringComparison.Ordinal))) throw new InvalidDataException("Unapproved package URL.");
            return url;
        }
        internal static void ValidateListing(Listing entry)
        {
            if (entry == null || entry.schemaVersion != 1 || !Id(entry.id) || !Version(entry.version) || !Text(entry.name, 120) || !Text(entry.description, 2000) || entry.author == null || !Text(entry.author.name, 120) || !Text(entry.license, 120) || !Text(entry.testNotes, 4000)) throw new InvalidDataException("Invalid listing identity.");
            // JsonUtility leaves omitted fields null; omission must never grant listed status.
            if (entry.reviewStatus == null) entry.reviewStatus = "pending";
            if (!new[] { "graph", "prefab", "recipe", "plugin", "community-tool", "mcp-tool", "ai-skill" }.Contains(entry.category) || !new[] { "pending", "listed" }.Contains(entry.reviewStatus) || !new[] { "editor-only", "runtime", "both", "instructions-only" }.Contains(entry.scope)) throw new InvalidDataException("Invalid listing category or review state.");
            if (!RepositoryPath(entry.licensePath) || !RepositoryPath(entry.instructionsPath)) throw new InvalidDataException("Invalid listing instructions path.");
            foreach (string url in new[] { entry.sourceUrl, entry.discussionUrl, entry.author.url }) if (!string.IsNullOrEmpty(url) && !WebUrl(url)) throw new InvalidDataException("Unapproved listing link.");
            if (!string.IsNullOrEmpty(entry.previewImage) && !RepositoryPath(entry.previewImage) && !WebUrl(entry.previewImage, true)) throw new InvalidDataException("Unapproved preview.");
            if (entry.compatibility == null || !Strings(entry.compatibility.unity, 50, 80) || !Strings(entry.compatibility.creatorSdk, 50, 80) || !Strings(entry.compatibility.banterSdk, 50, 80) || !Strings(entry.dependencies, 50, 200) || !Strings(entry.contents, 200, 500)) throw new InvalidDataException("Invalid compatibility or content list.");
            if (entry.usage != null && entry.usage.Length > 4000) throw new InvalidDataException("Instructions are too long.");
            if (entry.author.discord != null && !Text(entry.author.discord, 120)) throw new InvalidDataException("Invalid contributor name.");
            if (entry.download != null) DownloadUrl(entry.download);
        }
        internal static bool CanImport(Listing entry)
        {
            if (entry == null || entry.reviewStatus != "listed" ||
                !new[] { "graph", "prefab", "plugin", "community-tool" }.Contains(entry.category) ||
                !new[] { "editor-only", "runtime", "both" }.Contains(entry.scope)) return false;
            try { return new Uri(DownloadUrl(entry.download)).AbsolutePath.EndsWith(".unitypackage", StringComparison.Ordinal); }
            catch (InvalidDataException) { return false; }
        }
        private static bool Strings(string[] values, int count, int length) => values == null || values.Length <= count && values.All(v => Text(v, length));
        internal static string Canonical(string path) => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        internal static void ValidateRequest(ImportRequest request, string project)
        {
            if (request == null || request.schemaVersion != 1 || !Hex(request.requestId, 32) || !Hex(request.sha256, 64) || !Id(request.packageId) || !Version(request.version) || !Text(request.name, 120) || request.byteLength <= 0 || request.byteLength > MaxPackage || request.packageFile != request.sha256 + ".unitypackage") throw new InvalidDataException("Invalid import request.");
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (string.IsNullOrEmpty(request.projectPath) || !Path.IsPathRooted(request.projectPath) || !string.Equals(Canonical(request.projectPath), Canonical(project), comparison)) throw new InvalidDataException("This request belongs to another project.");
        }
        internal static string Area(string project, string relative)
        {
            string root = Canonical(project), path = Path.GetFullPath(Path.Combine(root, ".creator-plugins", relative));
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            string area = root + Path.DirectorySeparatorChar + ".creator-plugins";
            if (path != area && !path.StartsWith(area + Path.DirectorySeparatorChar, comparison)) throw new InvalidDataException("Path escapes the plugin cache.");
            for (string item = path; item != root; item = Path.GetDirectoryName(item))
            {
                if (string.IsNullOrEmpty(item)) throw new InvalidDataException("Invalid cache root.");
                if ((File.Exists(item) || Directory.Exists(item)) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Linked plugin cache paths are not allowed.");
            }
            return path;
        }
        internal static byte[] ReadBounded(string path, long max)
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (file.Length > max) throw new InvalidDataException("File exceeds its size limit.");
                var data = new byte[(int)file.Length];
                int read = 0;
                while (read < data.Length) { int count = file.Read(data, read, data.Length - read); if (count == 0) throw new EndOfStreamException(); read += count; }
                return data;
            }
        }
        internal static string Hash(Stream stream)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        internal static void Verify(byte[] bytes, long length, string hash)
        {
            using (var stream = new MemoryStream(bytes, false)) if (bytes.LongLength != length || Hash(stream) != hash) throw new InvalidDataException("Package size or checksum did not match. Nothing imported.");
        }
        internal static FileStream LockPackage(ImportRequest request, string project)
        {
            ValidateRequest(request, project);
            string path = Area(project, "packages/" + request.packageFile);
            var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            try { if (file.Length != request.byteLength || Hash(file) != request.sha256) throw new InvalidDataException("Package size or checksum did not match. Nothing imported."); return file; }
            catch { file.Dispose(); throw; }
        }
        internal static void SaveNew(string project, string relative, byte[] bytes)
        {
            string path = Area(project, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            Area(project, relative);
            string temporary = Area(project, Path.Combine(Path.GetDirectoryName(relative) ?? "", ".tmp-" + Guid.NewGuid().ToString("N")));
            try
            {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
                File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        internal static bool MatchesCallback(ImportRequest request, string name) => request != null && name != null && name.Length <= 1024 && Path.GetFileNameWithoutExtension(name) == request.sha256;
        internal static bool ImageDimensions(byte[] bytes)
        {
            int width = 0, height = 0;
            if (bytes.Length >= 24 && bytes.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) && bytes[8] == 0 && bytes[9] == 0 && bytes[10] == 0 && bytes[11] == 13 && Encoding.ASCII.GetString(bytes, 12, 4) == "IHDR")
            {
                width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
                height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
            }
            else if (bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216)
            {
                for (int offset = 2; offset + 8 < bytes.Length;)
                {
                    if (bytes[offset++] != 255) return false;
                    while (offset < bytes.Length && bytes[offset] == 255) offset++;
                    if (offset + 3 >= bytes.Length) return false;
                    int marker = bytes[offset++], length = (bytes[offset] << 8) | bytes[offset + 1];
                    if (length < 2 || offset + length > bytes.Length) return false;
                    if (marker == 192 || marker == 193 || marker == 194) { if (length < 8) return false; height = (bytes[offset + 3] << 8) | bytes[offset + 4]; width = (bytes[offset + 5] << 8) | bytes[offset + 6]; break; }
                    offset += length;
                }
            }
            return width > 0 && height > 0 && width <= 4096 && height <= 4096 && (long)width * height <= 4 * 1024 * 1024;
        }
    }

    internal static class OrganizationPolicy
    {
        internal sealed class Asset
        {
            internal string path, guid, kind;
        }
        internal sealed class Move
        {
            internal string source, destination, guid;
        }
        internal static readonly string[] GraphFolders = { "Assets/Visual Scripting", "Assets/Visual Scripts", "Assets/VisualScripts", "Assets/VisualScripting", "Assets/VS" };
        internal static bool AssetPath(string path) => path != null && path.StartsWith("Assets/", StringComparison.Ordinal) &&
            path.Split('/').All(part => part.Length > 0 && part != "." && part != ".." && !part.Any(c => char.IsControl(c) || "\\:*?\"<>|".Contains(c)));

        internal static Move[] Plan(Asset[] assets, Func<string, bool> folderExists, Func<string, bool> occupied)
        {
            if (assets == null || assets.Length == 0 || assets.Length > 64) throw new InvalidDataException("Select 1 to 64 graph assets or prefabs in the Project window.");
            if (assets.Any(a => a == null || !AssetPath(a.path) || !PluginProtocol.Hex(a.guid, 32) || (a.kind != "graph" && a.kind != "prefab")))
                throw new InvalidDataException("Only standalone Visual Scripting graphs or prefabs inside Assets can be organized.");
            if (assets.Select(a => a.kind).Distinct().Count() != 1) throw new InvalidDataException("Select graphs or prefabs separately, not both together.");
            if (assets.Select(a => a.path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != assets.Length || assets.Select(a => a.guid).Distinct().Count() != assets.Length)
                throw new InvalidDataException("The selection contains duplicate assets.");
            string folder = assets[0].kind == "prefab" ? "Assets/Prefabs" : GraphFolders.FirstOrDefault(folderExists) ?? GraphFolders[0];
            if (!folderExists(folder) && occupied(folder)) throw new InvalidDataException("The destination folder name is already in use: " + folder);
            var moves = assets.Select(a => new Move { source = a.path, destination = folder + "/" + Path.GetFileName(a.path), guid = a.guid })
                .Where(m => !string.Equals(m.source, m.destination, StringComparison.Ordinal)).ToArray();
            if (moves.Length == 0) throw new InvalidDataException("The selected assets are already in their destination folder.");
            if (moves.Select(m => m.destination).Distinct(StringComparer.OrdinalIgnoreCase).Count() != moves.Length)
                throw new InvalidDataException("Two selected assets have the same file name. Rename one in Unity first.");
            foreach (var move in moves) if (occupied(move.destination)) throw new InvalidDataException("Nothing moved. Destination already exists: " + move.destination);
            return moves;
        }
    }

    // Explicit Project selection is the move scope, never a package's dependency closure.
    internal static class AssetOrganizer
    {
        internal static void RequireIdle()
        {
            if (ImportReview.Busy) throw new InvalidOperationException("Wait for Unity to finish importing or compiling, and leave Play mode first.");
        }
        private static bool Occupied(string path) => File.Exists(path) || Directory.Exists(path) || File.Exists(path + ".meta") || !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path));
        private static void RequireUnlinked(string path)
        {
            if (!OrganizationPolicy.AssetPath(path)) throw new InvalidDataException("Asset path is outside Assets.");
            string root = ImportReview.Project;
            for (string item = Path.GetFullPath(Path.Combine(root, path)); item != root; item = Path.GetDirectoryName(item))
            {
                if (string.IsNullOrEmpty(item)) throw new InvalidDataException("Invalid asset path.");
                try
                {
                    if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("Linked asset paths cannot be organized: " + path);
                }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
            }
        }
        private static OrganizationPolicy.Asset ReadAsset(UnityEngine.Object asset)
        {
            if (asset == null || !AssetDatabase.IsMainAsset(asset) || AssetDatabase.IsSubAsset(asset)) throw new InvalidDataException("Select standalone assets, not scene objects, folders, or sub-assets.");
            string path = AssetDatabase.GetAssetPath(asset);
            RequireUnlinked(path);
            RequireUnlinked(path + ".meta");
            if (EditorUtility.IsDirty(asset)) throw new InvalidDataException("Save your changes to this asset first: " + path);
            string type = asset.GetType().FullName;
            string kind = (type == "Unity.VisualScripting.ScriptGraphAsset" || type == "Unity.VisualScripting.StateGraphAsset") && path.EndsWith(".asset", StringComparison.OrdinalIgnoreCase) ? "graph" :
                asset is GameObject && path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ? "prefab" : null;
            return new OrganizationPolicy.Asset { path = path, guid = AssetDatabase.AssetPathToGUID(path), kind = kind };
        }
        internal static OrganizationPolicy.Move[] Plan(UnityEngine.Object[] selection)
        {
            RequireIdle();
            if (selection == null || selection.Length == 0 || selection.Length > 64) throw new InvalidDataException("Select 1 to 64 graph assets or prefabs in the Project window.");
            var plan = OrganizationPolicy.Plan(selection.Select(ReadAsset).ToArray(), AssetDatabase.IsValidFolder, Occupied);
            foreach (var move in plan) { RequireUnlinked(move.destination); RequireUnlinked(move.destination + ".meta"); }
            return plan;
        }
        internal static int Apply(OrganizationPolicy.Move[] plan)
        {
            RequireIdle();
            if (plan == null || plan.Length == 0 || plan.Length > 64) throw new InvalidDataException("No move plan to confirm.");
            // Recheck the entire preview before creating a folder or moving the first asset.
            var current = Plan(plan.Select(m => AssetDatabase.LoadMainAssetAtPath(m.source)).ToArray());
            if (current.Length != plan.Length || current.Where((m, i) => m.source != plan[i].source || m.destination != plan[i].destination || m.guid != plan[i].guid).Any())
                throw new InvalidOperationException("The assets or destination changed. Close this preview and select them again.");
            string folder = Path.GetDirectoryName(plan[0].destination).Replace('\\', '/');
            if (!AssetDatabase.IsValidFolder(folder))
            {
                if (Occupied(folder)) throw new IOException("Destination folder name is already in use.");
                string guid = AssetDatabase.CreateFolder("Assets", Path.GetFileName(folder));
                if (string.IsNullOrEmpty(guid) || AssetDatabase.GUIDToAssetPath(guid) != folder) throw new IOException("Could not create the exact destination folder. Nothing moved.");
            }
            foreach (var move in plan)
            {
                string error = AssetDatabase.ValidateMoveAsset(move.source, move.destination);
                if (!string.IsNullOrEmpty(error)) throw new IOException("Nothing moved: " + error);
            }
            int moved = 0;
            try
            {
                foreach (var move in plan)
                {
                    RequireIdle();
                    RequireUnlinked(move.source); RequireUnlinked(move.destination);
                    RequireUnlinked(move.destination + ".meta");
                    if (Occupied(move.destination) || ReadAsset(AssetDatabase.LoadMainAssetAtPath(move.source)).guid != move.guid)
                        throw new IOException("An asset or destination changed after the preview.");
                    string error = AssetDatabase.MoveAsset(move.source, move.destination);
                    if (!string.IsNullOrEmpty(error)) throw new IOException(error);
                    moved++;
                    if (AssetDatabase.AssetPathToGUID(move.destination) != move.guid) throw new IOException("The moved asset's identity could not be verified.");
                }
            }
            catch (Exception error) { throw new IOException("Moved " + moved + " of " + plan.Length + " selected assets. Stopped without retrying or overwriting. Check the Project window. " + error.Message, error); }
            return moved;
        }
    }

    internal sealed class OrganizeAssetsWindow : EditorWindow
    {
        private OrganizationPolicy.Move[] plan;
        private Vector2 scroll;
        private string result;
        [MenuItem("Creator Plugins/Organize selected assets...")]
        internal static void Open()
        {
            try
            {
                var preview = AssetOrganizer.Plan(Selection.objects);
                var window = GetWindow<OrganizeAssetsWindow>(true, "Organize selected assets", true);
                window.plan = preview; window.result = null;
                Rect main = EditorGUIUtility.GetMainWindowPosition();
                float width = Mathf.Min(600, Mathf.Max(1, main.width - 40));
                float height = Mathf.Min(420, Mathf.Max(1, main.height - 80));
                window.minSize = new Vector2(Mathf.Min(420, width), Mathf.Min(260, height));
                window.position = new Rect(main.x + (main.width - width) / 2, main.y + (main.height - height) / 2, width, height);
                window.Show();
            }
            catch (Exception error) { EditorUtility.DisplayDialog("Organize selected assets", error.Message, "OK"); }
        }
        [MenuItem("Creator Plugins/Organize selected assets...", true)]
        private static bool Available() => !ImportReview.Busy && Selection.objects.Length > 0;
        private void OnGUI()
        {
            EditorGUILayout.HelpBox("Only the selected assets will move. Dependencies, scripts and scenes stay where they are. Asset references are kept. No scene is saved.", MessageType.Info);
            scroll = EditorGUILayout.BeginScrollView(scroll);
            if (plan != null) foreach (var move in plan)
            {
                GUILayout.Label(move.source, EditorStyles.wordWrappedLabel);
                GUILayout.Label("To: " + move.destination, EditorStyles.wordWrappedLabel);
                GUILayout.Space(8);
            }
            EditorGUILayout.EndScrollView();
            if (result != null) EditorGUILayout.HelpBox(result, MessageType.Info);
            using (new EditorGUI.DisabledScope(plan == null || ImportReview.Busy))
                if (GUILayout.Button("Move selected assets"))
                {
                    try { result = "Organized " + AssetOrganizer.Apply(plan) + " selected assets. Import status has not changed."; }
                    catch (Exception error) { result = error.Message; }
                    plan = null;
                }
            if (GUILayout.Button(plan == null ? "Close" : "Cancel")) Close();
        }
    }

    // Match fs2's nonblocking lock so Unity and all desktop writers share one queue boundary.
    internal sealed class PluginQueueLock : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct Overlapped { public UIntPtr internalLow, internalHigh; public uint offset, offsetHigh; public IntPtr eventHandle; }
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LockFileEx(Microsoft.Win32.SafeHandles.SafeFileHandle file, uint flags, uint reserved, uint low, uint high, ref Overlapped overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnlockFile(Microsoft.Win32.SafeHandles.SafeFileHandle file, uint offset, uint offsetHigh, uint low, uint high);
        [DllImport("libc", EntryPoint = "flock", SetLastError = true)]
        private static extern int Flock(int file, int operation);
        private FileStream stream;
        private readonly bool windows;
        internal PluginQueueLock(string project)
        {
            string path = PluginProtocol.Area(project, "desktop.lock");
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            PluginProtocol.Area(project, "desktop.lock");
            windows = Environment.OSVersion.Platform == PlatformID.Win32NT;
            if (!windows && Environment.OSVersion.Platform != PlatformID.Unix && Environment.OSVersion.Platform != PlatformID.MacOSX)
                throw new PlatformNotSupportedException("Plugin queue locking is unavailable on this platform.");
            stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
            try
            {
                var overlapped = new Overlapped();
                bool locked = windows ? LockFileEx(stream.SafeFileHandle, 3, 0, uint.MaxValue, uint.MaxValue, ref overlapped) : Flock(stream.SafeFileHandle.DangerousGetHandle().ToInt32(), 2 | 4) == 0;
                if (!locked) throw new IOException("Another Creator app is using the plugin queue, or its lock is unavailable. Try again after it finishes. OS error " + Marshal.GetLastWin32Error() + ".");
            }
            catch { stream.Dispose(); stream = null; throw; }
        }
        public void Dispose()
        {
            if (stream == null) return;
            try
            {
                if (windows) UnlockFile(stream.SafeFileHandle, 0, 0, uint.MaxValue, uint.MaxValue);
                else Flock(stream.SafeFileHandle.DangerousGetHandle().ToInt32(), 8);
            }
            finally { stream.Dispose(); stream = null; }
        }
    }

    internal static class PluginQueue
    {
        internal const int ActiveLimit = 100, ScanLimit = 1000;
        private sealed class Item { internal ImportRequest request; internal byte[] bytes, finalBytes; }
        private static T Read<T>(byte[] bytes) => JsonUtility.FromJson<T>(Encoding.UTF8.GetString(bytes));
        private static bool Exists(string path)
        {
            try
            {
                var attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                    throw new InvalidDataException("Linked paths or folders cannot replace plugin records.");
                return true;
            }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
        }
        internal static ImportReceipt TerminalReceipt(string project, string id) => Receipt(project, id, out _);
        private static ImportReceipt Receipt(string project, string id, out byte[] bytes)
        {
            if (!PluginProtocol.Hex(id, 32)) throw new InvalidDataException("Invalid import request identifier.");
            string path = PluginProtocol.Area(project, "receipts/" + id + ".json");
            bytes = null;
            if (!Exists(path)) return null;
            bytes = PluginProtocol.ReadBounded(path, 16 * 1024);
            var receipt = Read<ImportReceipt>(bytes);
            if (receipt == null || receipt.schemaVersion != 1 || receipt.requestId != id || !PluginProtocol.Text(receipt.message, 4000))
                throw new InvalidDataException("Invalid import receipt. Existing data was preserved.");
            if (!new[] { "imported", "cancelled", "failed" }.Contains(receipt.status))
                throw new InvalidDataException("This request has an older or invalid receipt. Existing data was preserved; no import was started.");
            return receipt;
        }
        private static List<Item> Inspect(string project)
        {
            string folder = PluginProtocol.Area(project, "inbox");
            var result = new List<Item>();
            if (!Directory.Exists(folder))
            {
                if (Exists(folder)) throw new InvalidDataException("Plugin inbox must be a directory.");
                return result;
            }
            foreach (string file in Directory.EnumerateFileSystemEntries(folder).Take(ScanLimit + 1))
            {
                if (result.Count == ScanLimit) throw new InvalidDataException("The plugin inbox exceeds its inspection limit. Existing files were preserved.");
                string id = Path.GetFileNameWithoutExtension(file);
                if (!PluginProtocol.Hex(id, 32) || Path.GetFileName(file) != id + ".json" || !Exists(PluginProtocol.Area(project, "inbox/" + id + ".json")))
                    throw new InvalidDataException("An existing plugin inbox entry is invalid. Existing files were preserved.");
                var item = new Item { bytes = PluginProtocol.ReadBounded(file, 16 * 1024) };
                item.request = Read<ImportRequest>(item.bytes);
                PluginProtocol.ValidateRequest(item.request, project);
                if (item.request.requestId != id) throw new InvalidDataException("Plugin inbox filename does not match its request.");
                Receipt(project, id, out item.finalBytes);
                if (Exists(PluginProtocol.Area(project, "history/requests/" + id + ".json")))
                    throw new InvalidDataException("This request exists in both inbox and history. Nothing was overwritten.");
                result.Add(item);
            }
            return result;
        }
        internal static ImportRequest Find(string project, string id)
        {
            if (!PluginProtocol.Hex(id, 32)) throw new InvalidDataException("Invalid import request identifier.");
            using (new PluginQueueLock(project))
            {
                string inbox = PluginProtocol.Area(project, "inbox/" + id + ".json"), history = PluginProtocol.Area(project, "history/requests/" + id + ".json");
                bool current = Exists(inbox), archived = Exists(history);
                if (current == archived) throw new InvalidDataException("Import request is missing or has conflicting history.");
                var request = Read<ImportRequest>(PluginProtocol.ReadBounded(current ? inbox : history, 16 * 1024));
                PluginProtocol.ValidateRequest(request, project);
                if (request.requestId != id) throw new InvalidDataException("Import request identity changed.");
                var final = TerminalReceipt(project, id);
                if (archived && final == null) throw new InvalidDataException("Archived request has no valid final receipt. Its outcome is unknown.");
                return request;
            }
        }
        internal static void Enqueue(string project, ImportRequest request, byte[] package = null)
        {
            PluginProtocol.ValidateRequest(request, project);
            if (package != null) PluginProtocol.Verify(package, request.byteLength, request.sha256);
            byte[] requestBytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(request));
            if (requestBytes.Length > 16 * 1024) throw new InvalidDataException("Import request exceeds its metadata limit.");
            using (new PluginQueueLock(project))
            {
                // Validate the entire bounded snapshot before moving any history or saving a request.
                var items = Inspect(project);
                var unresolved = items.Where(item => item.finalBytes == null).ToArray();
                if (unresolved.Length >= ActiveLimit) throw new InvalidOperationException("The plugin inbox has 100 unresolved requests. Finish an existing import before adding another.");
                if (unresolved.Any(item => item.request.packageId == request.packageId))
                    throw new InvalidOperationException("This package already has an unresolved Unity request. Finish or cancel that request first.");
                foreach (string relative in new[] { "inbox/", "history/requests/", "receipts/" })
                    if (Exists(PluginProtocol.Area(project, relative + request.requestId + ".json"))) throw new InvalidDataException("Import request identifier already exists. Nothing was overwritten.");
                string cache = PluginProtocol.Area(project, "packages/" + request.packageFile);
                if (Exists(cache)) PluginProtocol.Verify(PluginProtocol.ReadBounded(cache, PluginProtocol.MaxPackage), request.byteLength, request.sha256);
                else if (package == null) throw new InvalidDataException("The checked package is missing. Nothing was queued.");
                foreach (var item in items.Where(value => value.finalBytes != null))
                {
                    string source = PluginProtocol.Area(project, "inbox/" + item.request.requestId + ".json");
                    string destination = PluginProtocol.Area(project, "history/requests/" + item.request.requestId + ".json");
                    if (!PluginProtocol.ReadBounded(source, 16 * 1024).SequenceEqual(item.bytes) || !PluginProtocol.ReadBounded(PluginProtocol.Area(project, "receipts/" + item.request.requestId + ".json"), 16 * 1024).SequenceEqual(item.finalBytes))
                        throw new InvalidDataException("Plugin history changed during review. No import was queued.");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    PluginProtocol.Area(project, "history/requests/" + item.request.requestId + ".json");
                    File.Move(source, destination);
                    if (!PluginProtocol.ReadBounded(destination, 16 * 1024).SequenceEqual(item.bytes))
                        throw new InvalidDataException("Plugin request changed during archival. Inspect its preserved history before continuing.");
                }
                if (!Exists(cache)) PluginProtocol.SaveNew(project, "packages/" + request.packageFile, package);
                PluginProtocol.SaveNew(project, "inbox/" + request.requestId + ".json", requestBytes);
            }
        }
    }

    [InitializeOnLoad]
    internal static class ImportReview
    {
        internal static string Project => PluginProtocol.Canonical(Path.GetDirectoryName(Application.dataPath));
        internal static bool EditorBusy => EditorApplication.isCompiling || EditorApplication.isUpdating || EditorApplication.isPlayingOrWillChangePlaymode;
        internal static ImportRequest Active;
        internal static string RecoveryError;
        internal static bool Recovered;
        private static FileStream packageLock;
        private static string otherImport;
        internal static bool Busy => EditorBusy || Active != null || RecoveryError != null || otherImport != null;
        static ImportReview()
        {
            AssetDatabase.importPackageStarted += Started;
            AssetDatabase.importPackageCompleted += name => Finished(name, "imported", "Unity reported package import completed. Compilation and runtime behavior still need checking.");
            AssetDatabase.importPackageCancelled += name => Finished(name, "cancelled", "Unity reported that the import was cancelled.");
            AssetDatabase.importPackageFailed += (name, error) => Finished(name, "failed", "Unity reported an import failure: " + error);
            AssemblyReloadEvents.beforeAssemblyReload += ReleaseLock;
            EditorApplication.quitting += ReleaseLock;
            try
            {
                string path = PluginProtocol.Area(Project, "active-review.json");
                if (File.Exists(path))
                {
                    Active = Read<ImportRequest>(path); PluginProtocol.ValidateRequest(Active, Project);
                    if (new[] { "imported", "cancelled", "failed" }.Contains(Receipt(Active).status)) { File.Delete(path); Active = null; }
                    else Recovered = true;
                }
            }
            catch (Exception error) { Active = null; RecoveryError = "Pending review could not be read. No import retried. " + error.Message; }
        }
        internal static T Read<T>(string path) => JsonUtility.FromJson<T>(Encoding.UTF8.GetString(PluginProtocol.ReadBounded(path, 16 * 1024)));
        internal static ImportReceipt Receipt(ImportRequest request)
        {
            PluginProtocol.ValidateRequest(request, Project);
            var receipt = PluginQueue.TerminalReceipt(Project, request.requestId);
            if (receipt == null)
            {
                string activePath = PluginProtocol.Area(Project, "active-review.json");
                if (File.Exists(activePath))
                {
                    var pending = Read<ImportRequest>(activePath);
                    PluginProtocol.ValidateRequest(pending, Project);
                    if (pending.requestId == request.requestId)
                    {
                        RequireSameRequest(pending, request);
                        return new ImportReceipt { requestId = request.requestId, status = "review", message = "Review requested. Waiting for Unity's final outcome; nothing confirmed imported yet." };
                    }
                }
                return new ImportReceipt { requestId = request.requestId, status = "queued", message = "Ready for your review. Nothing imported." };
            }
            return receipt;
        }
        private static void RequireSameRequest(ImportRequest saved, ImportRequest expected)
        {
            if (saved.requestId != expected.requestId || saved.sha256 != expected.sha256 || saved.packageFile != expected.packageFile || saved.byteLength != expected.byteLength || saved.packageId != expected.packageId || saved.version != expected.version || saved.name != expected.name)
                throw new InvalidDataException("Pending review identity changed; existing files were preserved.");
        }
        internal static ImportReceipt Acknowledge(ImportRequest request) => Receipt(request);
        internal static void Review(ImportRequest request)
        {
            if (Busy) throw new InvalidOperationException("Wait for Unity to finish, or resolve the pending review first.");
            if (Receipt(request).status != "queued") throw new InvalidOperationException("This request has already been reviewed. No automatic retry is allowed.");
            packageLock = PluginProtocol.LockPackage(request, Project);
            try
            {
                PluginProtocol.SaveNew(Project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(request)));
                Active = request;
                Recovered = false;
                AssetDatabase.ImportPackage(PluginProtocol.Area(Project, "packages/" + request.packageFile), true);
            }
            catch (Exception error)
            {
                if (Active != null) Complete("failed", "Could not open import review: " + error.Message);
                else ReleaseLock();
                throw;
            }
        }
        private static void Started(string name)
        {
            if (!PluginProtocol.MatchesCallback(Active, name)) { otherImport = name; return; }
            // Started also fires before approval. The durable active request already represents review.
        }
        private static void Finished(string name, string status, string message)
        {
            if (otherImport == name) otherImport = null;
            if (!PluginProtocol.MatchesCallback(Active, name)) return;
            Complete(status, message);
        }
        internal static void ClearUnconfirmed()
        {
            if (Active == null || EditorBusy || otherImport != null) return;
            if (EditorUtility.DisplayDialog("Clear unconfirmed review?", "Only do this after closing Unity's import dialog. This records an unknown outcome as failed tracking. It will not undo files, import again, or report success.", "Clear review", "Keep waiting")) Complete("failed", "Import outcome was not confirmed. User cleared the pending review; check Unity before creating a new request.");
        }
        private static void Complete(string status, string message)
        {
            try
            {
                string path = PluginProtocol.Area(Project, "active-review.json");
                var saved = Read<ImportRequest>(path);
                PluginProtocol.ValidateRequest(saved, Project);
                RequireSameRequest(saved, Active);
                if (!new[] { "imported", "cancelled", "failed" }.Contains(status)) throw new InvalidDataException("Only a final outcome can be recorded.");
                var receipt = new ImportReceipt { requestId = Active.requestId, status = status, message = PluginProtocol.ReceiptMessage(message) };
                PluginProtocol.SaveNew(Project, "receipts/" + Active.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(receipt)));
                File.Delete(path);
                Active = null; Recovered = false; RecoveryError = null;
            }
            catch (Exception error) { RecoveryError = "Could not record the final import outcome: " + error.Message; }
            finally { ReleaseLock(); }
        }
        private static void ReleaseLock() { packageLock?.Dispose(); packageLock = null; }
    }

    public sealed class CreatorPluginsWindow : EditorWindow
    {
        private static readonly string[] Categories = { "All types", "Visual Scripting", "Prefabs", "Plugins", "Editor tools", "Recipes", "MCP tools", "AI skills" };
        private static readonly string[] CategoryKeys = { "", "graph", "prefab", "plugin", "community-tool", "recipe", "mcp-tool", "ai-skill" };
        private readonly List<Listing> listings = new List<Listing>();
        private readonly List<ImportRequest> inbox = new List<ImportRequest>();
        private readonly Dictionary<string, ImportReceipt> receipts = new Dictionary<string, ImportReceipt>();
        private Listing selected;
        private Listing pendingImport;
        private string search = "", message = "", queueMessage = "";
        private int category, tab;
        private Vector2 scroll;
        private readonly Dictionary<string, Texture2D> previews = new Dictionary<string, Texture2D>();
        private readonly HashSet<string> previewAttempts = new HashSet<string>();
        private UnityWebRequest previewRequest;
        private string previewKey;
        private double previewDeadline;
        private UnityWebRequest request;
        private Action<byte[]> success;
        private Action<string> failure;
        private double deadline, catalogueDeadline, catalogueLoadedAt, nextPoll;
        private bool catalogueFresh;
        private string[] pendingListings;
        private int listingIndex, warnings;
        private GUIStyle wrapped, heading, cardTitle, cardAuthor, previewLabel;
        private bool Fresh => catalogueFresh && EditorApplication.timeSinceStartup - catalogueLoadedAt < 180;

        [MenuItem("Creator Plugins/Browse")]
        public static void Browse() { var window = GetWindow<CreatorPluginsWindow>("Creator Plugins"); window.minSize = new Vector2(360, 360); window.Show(); }
        private void OnEnable() { EditorApplication.update += Tick; EditorApplication.delayCall += LoadWhenOpened; nextPoll = 0; }
        private void OnDisable() { EditorApplication.update -= Tick; EditorApplication.delayCall -= LoadWhenOpened; StopDownload(); ClearPreviews(); }
        private void LoadWhenOpened() { if (this != null && listings.Count == 0 && request == null && !ImportReview.Busy) RefreshCatalogue(); }
        private void StopDownload() { if (request != null) { request.Abort(); request.Dispose(); request = null; } success = null; failure = null; }
        private void Tick()
        {
            TickPreview();
            if (request != null)
            {
                if (!request.isDone && EditorApplication.timeSinceStartup > deadline) request.Abort();
                if (request.isDone)
                {
                    var current = request; var done = success; var failed = failure;
                    request = null; success = null; failure = null;
                    try
                    {
                        if (current.result != UnityWebRequest.Result.Success || current.responseCode != 200) throw new IOException("Community file unavailable or request refused. Refresh to retry.");
                        done(((BoundedDownload)current.downloadHandler).Bytes());
                    }
                    catch (Exception error) { failed(error.Message); }
                    finally { current.Dispose(); Repaint(); }
                }
            }
            bool importFinished = ImportReview.Active == null && ImportReview.RecoveryError == null && receipts.Values.Any(value => value.status == "review");
            if ((EditorApplication.timeSinceStartup >= nextPoll || importFinished) && !ImportReview.EditorBusy && request == null)
            {
                nextPoll = EditorApplication.timeSinceStartup + 5;
                PollInbox(); Repaint();
            }
        }
        private void Fetch(string url, long max, Action<byte[]> done, Action<string> failed)
        {
            if (request != null) throw new InvalidOperationException("A download is already running.");
            if (!PluginProtocol.WebUrl(url)) throw new InvalidDataException("Unapproved community URL.");
            request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbGET) { downloadHandler = new BoundedDownload(max), timeout = 25, redirectLimit = 0 };
            success = done; failure = failed; deadline = EditorApplication.timeSinceStartup + 27;
            try { request.SendWebRequest(); }
            catch { StopDownload(); throw; }
        }
        private void RefreshCatalogue()
        {
            if (request != null || ImportReview.Busy) return;
            catalogueFresh = false; message = "Loading catalogue..."; listings.Clear(); selected = null; ClearPreviews(); warnings = 0;
            Fetch(PluginProtocol.Root + "index.json", 32 * 1024, bytes =>
            {
                var index = JsonUtility.FromJson<CatalogueIndex>(Encoding.UTF8.GetString(bytes));
                if (index == null || index.schemaVersion != 1 || index.entries == null || index.entries.Length > 50) throw new InvalidDataException("Invalid catalogue index.");
                pendingListings = index.entries; listingIndex = 0; catalogueDeadline = EditorApplication.timeSinceStartup + 30; NextListing();
            }, error => { message = error; catalogueFresh = false; pendingImport = null; });
        }
        private void NextListing()
        {
            if (listingIndex >= pendingListings.Length || EditorApplication.timeSinceStartup > catalogueDeadline)
            {
                catalogueFresh = listingIndex >= pendingListings.Length && warnings == 0;
                catalogueLoadedAt = EditorApplication.timeSinceStartup;
                listings.Sort((a, b) => string.Compare(a.name, b.name, StringComparison.OrdinalIgnoreCase));
                message = catalogueFresh ? (listings.Count == 0 ? "No contributions are listed yet." : listings.Count + (listings.Count == 1 ? " contribution" : " contributions")) : "Some listings could not be loaded. Refresh before downloading.";
                if (pendingImport != null)
                {
                    var expected = pendingImport; pendingImport = null;
                    var current = listings.FirstOrDefault(entry => SameDownload(entry, expected));
                    if (catalogueFresh && current != null && PluginProtocol.CanImport(current)) { selected = current; Download(current); }
                    else message = "The catalogue changed or could not be verified. No import started. Refresh and choose the contribution again.";
                }
                return;
            }
            string path = pendingListings[listingIndex++];
            try
            {
                if (!PluginProtocol.RepositoryPath(path) || !path.StartsWith("packages/", StringComparison.Ordinal) || !path.EndsWith("/listing.json", StringComparison.Ordinal)) throw new InvalidDataException("Invalid listing path.");
                Fetch(PluginProtocol.RepositoryUrl(path), 16 * 1024, bytes =>
                {
                    try
                    {
                        var entry = JsonUtility.FromJson<Listing>(Encoding.UTF8.GetString(bytes)); PluginProtocol.ValidateListing(entry);
                        if (listings.Any(e => e.id == entry.id)) throw new InvalidDataException("Duplicate listing.");
                        listings.Add(entry);
                    }
                    catch { warnings++; }
                    NextListing();
                }, error => { warnings++; NextListing(); });
            }
            catch { warnings++; NextListing(); }
        }
        private void PollInbox()
        {
            try { using (new PluginQueueLock(ImportReview.Project)) PollInboxLocked(); }
            catch (Exception error) { queueMessage = error.Message; }
        }
        private void PollInboxLocked()
        {
            var pending = new HashSet<string>(receipts.Where(pair => pair.Value.status == "review").Select(pair => pair.Key));
            inbox.Clear(); receipts.Clear(); queueMessage = "";
            try
            {
                string folder = PluginProtocol.Area(ImportReview.Project, "inbox");
                if (!Directory.Exists(folder)) return;
                int count = 0;
                foreach (string file in Directory.EnumerateFiles(folder, "*.json").Take(101))
                {
                    if (++count > 100) { queueMessage = "Queue limit reached. Review existing requests before adding more."; break; }
                    try
                    {
                        string id = Path.GetFileNameWithoutExtension(file);
                        if (!PluginProtocol.Hex(id, 32)) throw new InvalidDataException();
                        var entry = ImportReview.Read<ImportRequest>(PluginProtocol.Area(ImportReview.Project, "inbox/" + id + ".json"));
                        PluginProtocol.ValidateRequest(entry, ImportReview.Project);
                        if (entry.requestId != id) throw new InvalidDataException();
                        var receipt = ImportReview.Acknowledge(entry);
                        receipts[entry.requestId] = receipt;
                        if (pending.Contains(entry.requestId) && receipt.status != "review") message = receipt.status == "cancelled" ? "Import cancelled. You can try again." : receipt.message;
                        inbox.Add(entry);
                    }
                    catch { queueMessage = "Some requests were invalid or unreadable. Their files were preserved."; }
                }
            }
            catch (Exception error) { queueMessage = error.Message; }
        }
        private void ClearPreviews()
        {
            if (previewRequest != null) { previewRequest.Abort(); previewRequest.Dispose(); previewRequest = null; }
            foreach (var texture in previews.Values) if (texture != null) DestroyImmediate(texture);
            previews.Clear(); previewAttempts.Clear(); previewKey = null;
        }
        private void RequestPreview(Listing entry)
        {
            string key = entry.previewImage;
            if (string.IsNullOrEmpty(key) || previewRequest != null || previewAttempts.Contains(key)) return;
            previewAttempts.Add(key);
            string url = PluginProtocol.RepositoryPath(key) ? PluginProtocol.RepositoryUrl(key) : key;
            if (!PluginProtocol.WebUrl(url)) return;
            previewRequest = new UnityWebRequest(url, UnityWebRequest.kHttpVerbGET) { downloadHandler = new BoundedDownload(2 * 1024 * 1024), timeout = 25, redirectLimit = 0 };
            previewKey = key; previewDeadline = EditorApplication.timeSinceStartup + 27;
            try { previewRequest.SendWebRequest(); }
            catch { previewRequest.Dispose(); previewRequest = null; previewKey = null; }
        }
        private void TickPreview()
        {
            if (previewRequest == null) return;
            if (!previewRequest.isDone && EditorApplication.timeSinceStartup > previewDeadline) previewRequest.Abort();
            if (!previewRequest.isDone) return;
            Texture2D texture = null;
            try
            {
                if (previewRequest.result != UnityWebRequest.Result.Success || previewRequest.responseCode != 200) return;
                byte[] bytes = ((BoundedDownload)previewRequest.downloadHandler).Bytes();
                if (!PluginProtocol.ImageDimensions(bytes)) throw new InvalidDataException("Preview dimensions or format are unsupported.");
                texture = new Texture2D(2, 2, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
                if (!texture.LoadImage(bytes, true)) throw new InvalidDataException("Preview unavailable.");
                // At most 50 listings, each retaining only a 320px thumbnail, never full-size images.
                if (texture.width > 320 || texture.height > 320)
                {
                    Texture2D thumbnail = MakeThumbnail(texture);
                    DestroyImmediate(texture); texture = thumbnail;
                }
                previews[previewKey] = texture; texture = null;
            }
            catch { /* A failed image must not hide the listing or disable its actions. */ }
            finally
            {
                if (texture != null) DestroyImmediate(texture);
                previewRequest.Dispose(); previewRequest = null; previewKey = null; Repaint();
            }
        }
        private static Texture2D MakeThumbnail(Texture2D source)
        {
            float scale = Mathf.Min(1f, 320f / Mathf.Max(source.width, source.height));
            int width = Mathf.Max(1, Mathf.RoundToInt(source.width * scale)), height = Mathf.Max(1, Mathf.RoundToInt(source.height * scale));
            var target = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            var previous = RenderTexture.active;
            Texture2D result = null;
            try
            {
                Graphics.Blit(source, target); RenderTexture.active = target;
                result = new Texture2D(width, height, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
                result.ReadPixels(new Rect(0, 0, width, height), 0, 0); result.Apply(false, true);
                return result;
            }
            catch { if (result != null) DestroyImmediate(result); throw; }
            finally { RenderTexture.active = previous; RenderTexture.ReleaseTemporary(target); }
        }
        internal static bool SameDownload(Listing a, Listing b) => a != null && b != null && a.id == b.id && a.version == b.version && a.download != null && b.download != null && a.download.sha256 == b.download.sha256 && a.download.byteLength == b.download.byteLength;
        private void Import(Listing entry)
        {
            if (ImportReview.Busy || request != null) return;
            if (!PluginProtocol.CanImport(entry)) { message = "This contribution is not available for Unity import. Follow its instructions instead."; return; }
            if (!Fresh) { pendingImport = entry; RefreshCatalogue(); message = "Checking the latest catalogue before importing..."; return; }
            Download(entry);
        }
        private void Download(Listing entry)
        {
            if (!Fresh || ImportReview.Busy || request != null || entry.reviewStatus != "listed") return;
            if (!PluginProtocol.CanImport(entry)) { message = "This item is not a Unity import. Use the desktop download and follow the contributor instructions."; return; }
            try
            {
                string filename = entry.download.sha256 + ".unitypackage", relative = "packages/" + filename;
                string cached = PluginProtocol.Area(ImportReview.Project, relative);
                if (File.Exists(cached))
                {
                    PluginProtocol.Verify(PluginProtocol.ReadBounded(cached, PluginProtocol.MaxPackage), entry.download.byteLength, entry.download.sha256);
                    OpenImport(entry, filename);
                    return;
                }
                message = "Downloading package and checking its checksum...";
                Fetch(PluginProtocol.DownloadUrl(entry.download), entry.download.byteLength, bytes =>
                {
                    PluginProtocol.Verify(bytes, entry.download.byteLength, entry.download.sha256);
                    OpenImport(entry, filename, bytes);
                }, error => message = error);
            }
            catch (Exception error) { message = error.Message; }
        }
        private void OpenImport(Listing entry, string filename, byte[] package = null)
        {
            var item = QueueImport(entry, filename, package);
            tab = 1; PollInbox();
            if (ImportReview.Busy) { message = "Package is ready. Wait for Unity to finish, then click Import into project."; return; }
            ImportReview.Review(item);
            message = "Choose the files to add in Unity's import window."; nextPoll = 0;
        }
        internal static ImportRequest QueueImport(Listing entry, string filename, byte[] package = null)
        {
            if (!PluginProtocol.CanImport(entry)) throw new InvalidDataException("This contribution is not available for Unity import.");
            var item = new ImportRequest { requestId = Guid.NewGuid().ToString("N"), projectPath = ImportReview.Project, packageId = entry.id, version = entry.version, name = entry.name, byteLength = entry.download.byteLength, sha256 = entry.download.sha256, packageFile = filename };
            PluginProtocol.ValidateRequest(item, ImportReview.Project);
            PluginQueue.Enqueue(ImportReview.Project, item, package);
            return item;
        }
        private void RetryImport(ImportRequest item)
        {
            var entry = listings.FirstOrDefault(value => PluginProtocol.CanImport(value) && value.id == item.packageId && value.version == item.version && value.download.sha256 == item.sha256 && value.download.byteLength == item.byteLength);
            if (entry == null) { message = "Refresh the catalogue and choose the current contribution before importing again."; tab = 0; return; }
            Import(entry);
        }
        private void CancelDownload() { StopDownload(); pendingImport = null; message = "Download cancelled. You can try again."; }
        private void Link(string url) { if (PluginProtocol.WebUrl(url)) Application.OpenURL(url); else message = "Unapproved community link."; }
        private void OnGUI()
        {
            if (wrapped == null)
            {
                wrapped = new GUIStyle(EditorStyles.wordWrappedLabel) { richText = false };
                heading = new GUIStyle(EditorStyles.boldLabel) { wordWrap = true, richText = false, fontSize = 16 };
                cardTitle = new GUIStyle(EditorStyles.boldLabel) { wordWrap = true, richText = false, fontSize = 13 };
                cardAuthor = new GUIStyle(EditorStyles.miniLabel) { wordWrap = true, richText = false };
                previewLabel = new GUIStyle(EditorStyles.centeredGreyMiniLabel) { wordWrap = true, richText = false };
            }
            GUILayout.Space(8); GUILayout.Label("Creator Plugins", heading);
            tab = GUILayout.Toolbar(tab, new[] { "Catalogue", "Imports" });
            EditorGUILayout.HelpBox("Packages may run C# on import. Checksums confirm file integrity, not code safety.", MessageType.Info);
            if (ImportReview.EditorBusy) EditorGUILayout.HelpBox("Unity is busy or in Play mode. Importing is unavailable.", MessageType.Info);
            if (ImportReview.RecoveryError != null) EditorGUILayout.HelpBox(ImportReview.RecoveryError, MessageType.Warning);
            if (ImportReview.Active != null)
            {
                EditorGUILayout.HelpBox(ImportReview.Recovered ? "Previous import restored. Its outcome is not confirmed; nothing was retried." : "Finish or cancel Unity's import window.", MessageType.Info);
                using (new EditorGUI.DisabledScope(ImportReview.EditorBusy)) if (GUILayout.Button("Clear unconfirmed import...")) ImportReview.ClearUnconfirmed();
            }
            if (request != null && GUILayout.Button("Cancel download")) CancelDownload();
            scroll = EditorGUILayout.BeginScrollView(scroll);
            if (tab == 0) DrawCatalogue(); else DrawInbox();
            EditorGUILayout.EndScrollView();
            if (!string.IsNullOrEmpty(message)) EditorGUILayout.HelpBox(message, MessageType.Info);
            if (GUILayout.Button("SideQuest Creator Community")) Link(PluginProtocol.Repository);
        }
        private void DrawCatalogue()
        {
            using (new EditorGUI.DisabledScope(request != null || ImportReview.Busy)) if (GUILayout.Button("Refresh catalogue")) RefreshCatalogue();
            search = EditorGUILayout.TextField("Search", search);
            category = EditorGUILayout.Popup("Type", category, Categories);
            int visibleCount = 0;
            foreach (var entry in listings.Where(e => (category == 0 || e.category == CategoryKeys[category]) && (e.name + " " + e.description + " " + e.author.name + " " + e.author.discord).IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0).ToArray())
            {
                visibleCount++;
                GUILayout.Space(6);
                EditorGUILayout.BeginVertical(EditorStyles.helpBox);
                EditorGUILayout.BeginHorizontal();
                Rect imageRect = GUILayoutUtility.GetRect(108, 81, GUILayout.Width(108), GUILayout.Height(81));
                DrawCardPreview(entry, imageRect);
                EditorGUILayout.BeginVertical();
                GUILayout.Label(new GUIContent(entry.name, entry.name), cardTitle);
                GUILayout.Label("By " + entry.author.name + (string.IsNullOrEmpty(entry.author.discord) ? "" : " / " + entry.author.discord), cardAuthor);
                GUILayout.Space(3);
                GUILayout.Label(Summary(entry.description), wrapped);
                EditorGUILayout.EndVertical();
                EditorGUILayout.EndHorizontal();
                EditorGUILayout.BeginHorizontal();
                using (new EditorGUI.DisabledScope(request != null || ImportReview.Busy || !PluginProtocol.CanImport(entry)))
                    if (GUILayout.Button("Import into project")) Import(entry);
                if (GUILayout.Button(selected == entry ? "Hide details" : "Details", GUILayout.Width(92))) selected = selected == entry ? null : entry;
                EditorGUILayout.EndHorizontal();
                if (selected == entry) DrawDetails();
                EditorGUILayout.EndVertical();
            }
            if (visibleCount == 0 && listings.Count > 0) EditorGUILayout.HelpBox("No contributions match these filters.", MessageType.Info);
        }
        internal static string Summary(string description)
        {
            string text = (description ?? "").Replace('\r', ' ').Replace('\n', ' ');
            if (text.Length <= 200) return text;
            int end = text.LastIndexOf(' ', 197, 60);
            return text.Substring(0, end >= 138 ? end : 197).TrimEnd() + "...";
        }
        private void DrawCardPreview(Listing entry, Rect rect)
        {
            if (Event.current.type != EventType.Repaint) return;
            EditorGUI.DrawRect(rect, EditorGUIUtility.isProSkin ? new Color(.09f, .10f, .11f) : new Color(.72f, .73f, .74f));
            string key = entry.previewImage;
            if (!string.IsNullOrEmpty(key) && previews.TryGetValue(key, out var texture)) GUI.DrawTexture(rect, texture, ScaleMode.ScaleToFit);
            else
            {
                bool attempted = !string.IsNullOrEmpty(key) && previewAttempts.Contains(key);
                GUI.Label(rect, string.IsNullOrEmpty(key) ? "No preview" : attempted && key != previewKey ? "Preview unavailable" : "Loading preview...", previewLabel);
                if (rect.yMax >= scroll.y && rect.yMin <= scroll.y + position.height) RequestPreview(entry);
            }
        }
        private void DrawDetails()
        {
            GUILayout.Space(8);
            GUILayout.Label(selected.description, wrapped);
            GUILayout.Label(selected.reviewStatus == "listed" ? "Listed contribution" : "Review pending", EditorStyles.boldLabel);
            GUILayout.Label("Licence: " + selected.license, wrapped);
            GUILayout.Label("Unity tested: " + Versions(selected.compatibility.unity), wrapped);
            GUILayout.Label("Creator SDK tested: " + Versions(selected.compatibility.creatorSdk), wrapped);
            GUILayout.Label("Banter SDK tested: " + Versions(selected.compatibility.banterSdk), wrapped);
            GUILayout.Label("Dependencies: " + (selected.dependencies == null || selected.dependencies.Length == 0 ? "None declared" : string.Join(", ", selected.dependencies)), wrapped);
            GUILayout.Label(selected.usage ?? "See contributor instructions.", wrapped);
            GUILayout.Label(selected.testNotes, wrapped);
            if (selected.contents != null) foreach (string file in selected.contents) GUILayout.Label(file, wrapped);
            if (selected.includesCode) EditorGUILayout.HelpBox("Review code before installing or running it. Unity C# can run on import; a checksum is not a safety check.", MessageType.Warning);
            if (GUILayout.Button("Full instructions")) Link(PluginProtocol.Repository + "/blob/main/" + selected.instructionsPath);
            if (GUILayout.Button("Licence notes")) Link(PluginProtocol.Repository + "/blob/main/" + selected.licensePath);
            if (!string.IsNullOrEmpty(selected.sourceUrl) && GUILayout.Button("Source")) Link(selected.sourceUrl);
            if (!string.IsNullOrEmpty(selected.discussionUrl) && GUILayout.Button("Discussion")) Link(selected.discussionUrl);
        }
        private static string Versions(string[] values) => values == null || values.Length == 0 ? "Not yet verified" : string.Join(", ", values);
        private void DrawInbox()
        {
            GUILayout.Label("Packages stay outside Assets until you approve files in Unity's import dialog.", wrapped);
            if (!string.IsNullOrEmpty(queueMessage)) EditorGUILayout.HelpBox(queueMessage, MessageType.Warning);
            if (inbox.Count == 0) GUILayout.Label("No imports yet.", wrapped);
            foreach (var item in inbox.ToArray())
            {
                GUILayout.Space(8); GUILayout.Label(item.name + " / " + item.version, EditorStyles.boldLabel);
                try
                {
                    var receipt = receipts[item.requestId];
                    GUILayout.Label(receipt.status == "review" ? "Waiting for your selection in Unity's import window." : receipt.status == "queued" ? "Ready to import." : receipt.status + ": " + receipt.message, wrapped);
                    bool retry = receipt.status == "cancelled" || receipt.status == "failed";
                    using (new EditorGUI.DisabledScope(ImportReview.Busy || request != null || (receipt.status != "queued" && !retry)))
                        if (GUILayout.Button(retry ? "Try import again" : "Import into project"))
                        {
                            try { if (retry) RetryImport(item); else ImportReview.Review(item); }
                            catch (Exception error) { message = error.Message; }
                            nextPoll = 0;
                        }
                }
                catch (Exception error) { GUILayout.Label(error.Message, wrapped); }
            }
            using (new EditorGUI.DisabledScope(ImportReview.Busy || request != null || Selection.objects.Length == 0))
                if (GUILayout.Button("Organize selected assets...")) OrganizeAssetsWindow.Open();
        }
        private sealed class BoundedDownload : DownloadHandlerScript
        {
            private readonly long max;
            private readonly MemoryStream buffer = new MemoryStream();
            private bool oversized;
            internal BoundedDownload(long maximum) : base(new byte[16 * 1024]) { max = maximum; }
            protected override void ReceiveContentLengthHeader(ulong length) { oversized = length > (ulong)max; }
            protected override bool ReceiveData(byte[] bytes, int count)
            {
                if (oversized || bytes == null || count < 0 || buffer.Length + count > max) return false;
                buffer.Write(bytes, 0, count); return true;
            }
            internal byte[] Bytes() { if (oversized) throw new InvalidDataException("File exceeds its size limit."); return buffer.ToArray(); }
        }
    }
}
