using System;
using System.IO;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsEditorSmoke
{
    [Serializable] private sealed class Result { public bool passed; public int checks; public string unityVersion, error; }
    private static int checks;
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
    public static void Run()
    {
        var result = new Result { unityVersion = Application.unityVersion };
        string project = Path.GetDirectoryName(Application.dataPath);
        try
        {
            Check(File.Exists(Path.Combine(project, ".creator-plugins-disposable-fixture")), "Refusing a real project.");
            var entry = JsonUtility.FromJson<Listing>(File.ReadAllText(Path.Combine(project, "pending-listing.json")));
            PluginProtocol.ValidateListing(entry);
            Check(entry.reviewStatus == "pending" && entry.includesCode, "Fixture must remain pending and disclose C#.");
            Check(entry.author.name == "Mr. E", "Contributor credit was lost.");
            byte[] data = Encoding.ASCII.GetBytes("Not a Unity package. Protocol test bytes only.");
            string hash; using (var stream = new MemoryStream(data)) hash = PluginProtocol.Hash(stream);
            var request = new ImportRequest { requestId = new string('b', 32), projectPath = project, packageId = "fixture.package", version = "1.0.0", name = "No import fixture", byteLength = data.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
            PluginProtocol.SaveNew(project, "packages/" + request.packageFile, data);
            PluginProtocol.SaveNew(project, "inbox/" + request.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(request)));
            var loaded = ImportReview.Read<ImportRequest>(PluginProtocol.Area(project, "inbox/" + request.requestId + ".json"));
            PluginProtocol.ValidateRequest(loaded, project);
            Check(loaded.sha256 == hash, "Request JSON identity lost.");
            Check(ImportReview.Receipt(loaded).status == "queued", "New request should only be queued.");
            ImportReview.Acknowledge(loaded);
            var receipt = ImportReview.Read<ImportReceipt>(PluginProtocol.Area(project, "receipts/" + loaded.requestId + ".json"));
            Check(receipt.status == "queued" && receipt.requestId == loaded.requestId, "Queued acknowledgement did not round trip.");
            using (var stream = PluginProtocol.LockPackage(loaded, project)) Check(stream.Length == data.Length, "Package verification failed.");
            Check(ImportReview.Active == null, "Queued data must not start an import.");
            Check(!File.Exists(PluginProtocol.Area(project, "active-review.json")), "An active import was created without consent.");
            Check(!File.Exists(Path.Combine(Application.dataPath, "No import fixture")), "Queue wrote to Assets.");
            Check(typeof(CreatorPluginsWindow).Assembly.GetName().Name == "CreatorWorks.Plugins.Editor", "Helper asmdef was not loaded.");
            // Seed an interrupted review fixture, not a real import, for a second Editor process.
            receipt.status = "review"; receipt.message = "Simulated interrupted review fixture, no import performed.";
            File.WriteAllText(PluginProtocol.Area(project, "receipts/" + loaded.requestId + ".json"), JsonUtility.ToJson(receipt));
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(loaded)));
            result.passed = true;
        }
        catch (Exception error) { result.error = error.ToString(); Debug.LogError(error); }
        result.checks = checks;
        File.WriteAllText(Path.Combine(project, "creator-plugins-smoke.json"), JsonUtility.ToJson(result, true));
        EditorApplication.Exit(result.passed ? 0 : 1);
    }
    public static void Recover()
    {
        var result = new Result { unityVersion = Application.unityVersion };
        string project = Path.GetDirectoryName(Application.dataPath);
        try
        {
            Check(File.Exists(Path.Combine(project, ".creator-plugins-disposable-fixture")), "Refusing a real project.");
            Check(ImportReview.Active != null && ImportReview.Recovered, "Pending review did not survive a new Editor process.");
            var pending = ImportReview.Active;
            Check(ImportReview.Receipt(pending).status == "review", "Restart invented an import outcome.");
            var method = typeof(ImportReview).GetMethod("Finished", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            method.Invoke(null, new object[] { "unrelated-package", "imported", "Unrelated callback fixture" });
            Check(ImportReview.Active == pending, "Unrelated package callback completed this request.");
            method.Invoke(null, new object[] { pending.sha256, "cancelled", "Simulated cancellation callback fixture. No actual import." });
            Check(ImportReview.Receipt(pending).status == "cancelled" && ImportReview.Active == null, "Matching cancellation was not recorded.");
            Check(!File.Exists(PluginProtocol.Area(project, "active-review.json")), "Finished tracking file was not cleared.");
            result.passed = true;
        }
        catch (Exception error) { result.error = error.ToString(); Debug.LogError(error); }
        result.checks = checks;
        File.WriteAllText(Path.Combine(project, "creator-plugins-recovery.json"), JsonUtility.ToJson(result, true));
        EditorApplication.Exit(result.passed ? 0 : 1);
    }
}
