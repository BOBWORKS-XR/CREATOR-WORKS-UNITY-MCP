using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

// Native dialog acceptance only. Never installed outside a marked disposable fixture.
[InitializeOnLoad]
public static class CreatorPluginsInteractiveSmoke
{
    [Serializable] private sealed class Result
    {
        public bool passed, csharpTypeLoaded, csharpValueVerified, reloadAfterImportStarted;
        public string[] statuses;
    }
    private static string Project => Path.GetDirectoryName(Application.dataPath);
    private static bool IsFixture => File.Exists(Path.Combine(Project, ".creator-plugins-interactive-fixture"));
    static CreatorPluginsInteractiveSmoke()
    {
        if (!IsFixture) return;
        AssetDatabase.importPackageStarted += name => Record("started", name);
        AssetDatabase.importPackageCompleted += name => Record("completed", name);
        AssetDatabase.importPackageCancelled += name => Record("cancelled", name);
        AssetDatabase.importPackageFailed += (name, error) => Record("failed", name + ": " + error);
        Record("assembly-loaded", Application.unityVersion);
    }
    private static void Record(string kind, string value)
    {
        File.AppendAllText(Path.Combine(Project, "interactive-events.log"), DateTime.UtcNow.ToString("O") + " " + kind + " " + value + "\n");
    }
    public static void Prepare()
    {
        if (!IsFixture) throw new InvalidOperationException("Refusing a real project.");
        Queue("1", "01 Cancel check", "Assets/CreatorPluginCancelled.txt", "This must never be imported.\n");
        Queue("2", "02 Text import check", "Assets/CreatorPluginImported.txt", "Harmless Creator Plugins native import fixture.\n");
        Queue("3", "03 C# import check", "Assets/Editor/CreatorPluginImportedCode.cs", "internal static class CreatorPluginImportedCode { internal const int Value = 42; }\n");
        File.WriteAllText(Path.Combine(Project, "interactive-prepared.txt"), "Three locally generated test packages. No third-party code.\n");
        EditorApplication.Exit(0);
    }
    private static void Queue(string id, string name, string assetPath, string contents)
    {
        string asset = Path.Combine(Project, assetPath);
        if (File.Exists(asset)) throw new InvalidOperationException("Refusing to overwrite a fixture asset.");
        Directory.CreateDirectory(Path.GetDirectoryName(asset));
        File.WriteAllText(asset, contents);
        AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
        string export = Path.Combine(Project, "fixture-" + id + ".unitypackage");
        AssetDatabase.ExportPackage(assetPath, export, ExportPackageOptions.Default);
        byte[] bytes = File.ReadAllBytes(export);
        string hash; using (var stream = new MemoryStream(bytes)) hash = PluginProtocol.Hash(stream);
        var request = new ImportRequest { requestId = new string(id[0], 32), projectPath = Project, packageId = "fixture.native-" + id, version = "1.0.0", name = name, byteLength = bytes.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
        PluginProtocol.SaveNew(Project, "packages/" + request.packageFile, bytes);
        PluginProtocol.SaveNew(Project, "inbox/" + request.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(request)));
        if (!AssetDatabase.DeleteAsset(assetPath)) throw new IOException("Could not remove staging asset from disposable fixture.");
    }
    [MenuItem("Creator Plugins/Fixture/Open test window")]
    public static void Open()
    {
        if (!IsFixture) throw new InvalidOperationException("Refusing a real project.");
        foreach (var existing in Resources.FindObjectsOfTypeAll<CreatorPluginsWindow>()) existing.Close();
        var window = EditorWindow.GetWindow<CreatorPluginsWindow>("Creator Plugins", true, typeof(SceneView));
        window.minSize = new Vector2(360, 360);
        window.Show();
        window.Focus();
        Record("window-position", window.position.ToString());
    }
    [MenuItem("Creator Plugins/Fixture/Verify and close")]
    public static void VerifyAndClose()
    {
        if (!IsFixture) throw new InvalidOperationException("Refusing a real project.");
        var requests = Directory.GetFiles(PluginProtocol.Area(Project, "inbox"), "*.json").Select(ImportReview.Read<ImportRequest>).ToArray();
        if (requests.Length != 3) throw new InvalidOperationException("Expected exactly three fixture requests.");
        var status = new[] { "1", "2", "3" }.Select(id => ImportReview.Receipt(requests.Single(request => request.packageId == "fixture.native-" + id)).status).ToArray();
        var codeRequest = requests.Single(request => request.packageId == "fixture.native-3");
        var codeTypes = AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType("CreatorPluginImportedCode", false)).Where(type => type != null).ToArray();
        bool typeLoaded = codeTypes.Length == 1;
        bool valueVerified = typeLoaded && Equals(codeTypes[0].GetField("Value", BindingFlags.Static | BindingFlags.NonPublic)?.GetRawConstantValue(), 42);
        string eventPath = Path.Combine(Project, "interactive-events.log");
        var events = File.Exists(eventPath) ? File.ReadAllLines(eventPath) : Array.Empty<string>();
        int started = Array.FindIndex(events, line => line.Contains(" started ") && line.Contains(codeRequest.sha256));
        bool reloaded = started >= 0 && events.Skip(started + 1).Any(line => line.Contains(" assembly-loaded "));
        bool pass = status.SequenceEqual(new[] { "cancelled", "imported", "imported" }) &&
            !File.Exists(Path.Combine(Application.dataPath, "CreatorPluginCancelled.txt")) &&
            File.ReadAllText(Path.Combine(Application.dataPath, "CreatorPluginImported.txt")) == "Harmless Creator Plugins native import fixture.\n" &&
            File.ReadAllText(Path.Combine(Application.dataPath, "Editor/CreatorPluginImportedCode.cs")) == "internal static class CreatorPluginImportedCode { internal const int Value = 42; }\n" &&
            ImportReview.Active == null && !File.Exists(PluginProtocol.Area(Project, "active-review.json")) &&
            !EditorApplication.isCompiling && !EditorApplication.isUpdating && typeLoaded && valueVerified && reloaded;
        File.WriteAllText(Path.Combine(Project, "interactive-result.json"), JsonUtility.ToJson(new Result {
            passed = pass, statuses = status, csharpTypeLoaded = typeLoaded,
            csharpValueVerified = valueVerified, reloadAfterImportStarted = reloaded
        }, true));
        if (!pass) throw new InvalidOperationException("Native import acceptance failed; inspect receipts and assets.");
        EditorApplication.Exit(0);
    }
}
