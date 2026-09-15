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
            var implicitPending = JsonUtility.FromJson<Listing>(File.ReadAllText(Path.Combine(project, "implicit-pending-listing.json")));
            PluginProtocol.ValidateListing(implicitPending);
            Check(implicitPending.reviewStatus == "pending", "Omitted review status must remain pending, never download-enabled.");
            implicitPending.reviewStatus = "approved";
            bool invalidRejected = false;
            try { PluginProtocol.ValidateListing(implicitPending); }
            catch (InvalidDataException) { invalidRejected = true; }
            Check(invalidRejected, "Unknown review states must still be rejected.");
            byte[] data = Encoding.ASCII.GetBytes("Not a Unity package. Protocol test bytes only.");
            string hash; using (var stream = new MemoryStream(data)) hash = PluginProtocol.Hash(stream);
            var request = new ImportRequest { requestId = new string('b', 32), projectPath = project, packageId = "fixture.package", version = "1.0.0", name = "No import fixture", byteLength = data.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
            PluginProtocol.SaveNew(project, "packages/" + request.packageFile, data);
            PluginProtocol.SaveNew(project, "inbox/" + request.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(request)));
            var loaded = ImportReview.Read<ImportRequest>(PluginProtocol.Area(project, "inbox/" + request.requestId + ".json"));
            PluginProtocol.ValidateRequest(loaded, project);
            Check(loaded.sha256 == hash, "Request JSON identity lost.");
            Check(ImportReview.Receipt(loaded).status == "queued", "New request should only be queued.");
            var receipt = ImportReview.Acknowledge(loaded);
            Check(receipt.status == "queued" && !File.Exists(PluginProtocol.Area(project, "receipts/" + loaded.requestId + ".json")), "Acknowledgement must not create a mutable receipt.");
            using (var stream = PluginProtocol.LockPackage(loaded, project)) Check(stream.Length == data.Length, "Package verification failed.");
            Check(ImportReview.Active == null, "Queued data must not start an import.");
            Check(!File.Exists(PluginProtocol.Area(project, "active-review.json")), "An active import was created without consent.");
            Check(!File.Exists(Path.Combine(Application.dataPath, "No import fixture")), "Queue wrote to Assets.");
            Check(typeof(CreatorPluginsWindow).Assembly.GetName().Name == "CreatorWorks.Plugins.Editor", "Helper asmdef was not loaded.");
            checks += CreatorPluginsQueueTests.Run(Path.Combine(project, "queue-fixtures"));
            // Seed an interrupted review fixture, not a real import, for a second Editor process.
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(loaded)));
            Check(ImportReview.Receipt(loaded).status == "review", "Review must be derived from the durable active request.");
            var changed = JsonUtility.FromJson<ImportRequest>(JsonUtility.ToJson(loaded)); changed.name = "Changed identity";
            bool changedRejected = false;
            try { ImportReview.Receipt(changed); } catch (InvalidDataException) { changedRejected = true; }
            Check(changedRejected, "An active request with the same ID but changed content was accepted.");
            var legacy = JsonUtility.FromJson<ImportRequest>(JsonUtility.ToJson(loaded)); legacy.requestId = new string('c', 32);
            string legacyPath = "receipts/" + legacy.requestId + ".json";
            byte[] legacyBytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(new ImportReceipt { requestId = legacy.requestId, status = "queued", message = "Older helper fixture" }));
            PluginProtocol.SaveNew(project, legacyPath, legacyBytes);
            bool legacyRejected = false;
            try { ImportReview.Acknowledge(legacy); } catch (InvalidDataException) { legacyRejected = true; }
            Check(legacyRejected && Convert.ToBase64String(File.ReadAllBytes(PluginProtocol.Area(project, legacyPath))) == Convert.ToBase64String(legacyBytes), "Older mutable receipt was not rejected and preserved.");
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
            Check(ImportReview.Receipt(pending).status == "cancelled" && ImportReview.Active == null, "Matching cancellation was not recorded. " + ImportReview.RecoveryError);
            Check(!File.Exists(PluginProtocol.Area(project, "active-review.json")), "Finished tracking file was not cleared.");
            string finalPath = PluginProtocol.Area(project, "receipts/" + pending.requestId + ".json");
            byte[] finalBytes = File.ReadAllBytes(finalPath);
            var timestamp = File.GetLastWriteTimeUtc(finalPath);
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(pending)));
            Check(ImportReview.Receipt(pending).status == "cancelled", "Durable final outcome must win over leftover active tracking.");
            File.Delete(PluginProtocol.Area(project, "active-review.json"));
            method.Invoke(null, new object[] { pending.sha256, "imported", "Duplicate callback must do nothing" });
            for (int n = 0; n < 100; n++) ImportReview.Acknowledge(pending);
            Check(Convert.ToBase64String(File.ReadAllBytes(finalPath)) == Convert.ToBase64String(finalBytes) && File.GetLastWriteTimeUtc(finalPath) == timestamp, "Polling or duplicate callback rewrote the final outcome.");
            pending.requestId = Guid.NewGuid().ToString("N");
            PluginProtocol.SaveNew(project, "inbox/" + pending.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(pending)));
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(pending)));
            ImportReview.Active = pending;
            using (new PluginQueueLock(project))
                method.Invoke(null, new object[] { pending.sha256, "failed", "Unity failure\r\nWindows detail\t\u0000" });
            var failure = ImportReview.Receipt(pending);
            Check(failure.status == "failed" && failure.message == "Unity failure\nWindows detail\t ", "Failure receipt is unreadable after message normalization.");
            Check(ImportReview.Active == null && ImportReview.RecoveryError == null, "Desktop queue lock prevented the final callback receipt.");
            result.passed = true;
        }
        catch (Exception error) { result.error = error.ToString(); Debug.LogError(error); }
        result.checks = checks;
        File.WriteAllText(Path.Combine(project, "creator-plugins-recovery.json"), JsonUtility.ToJson(result, true));
        EditorApplication.Exit(result.passed ? 0 : 1);
    }
}
