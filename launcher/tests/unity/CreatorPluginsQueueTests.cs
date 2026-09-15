using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using CreatorWorks.Plugins;
using UnityEngine;

internal static class CreatorPluginsQueueTests
{
    private static int checks;
    private static readonly byte[] Package = Encoding.UTF8.GetBytes("Queue fixture only, never imported");
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static void Reject(Action action, string name) { try { action(); } catch { checks++; return; } throw new Exception(name); }
    private static string NewRoot(string parent, string name)
    {
        string root = Path.Combine(parent, name);
        if (Directory.Exists(root)) throw new Exception("Refusing an existing queue fixture.");
        Directory.CreateDirectory(root);
        using (new PluginQueueLock(root)) { }
        return root;
    }
    private static ImportRequest Request(string root, string package = "fixture.package")
    {
        string hash; using (var stream = new MemoryStream(Package)) hash = PluginProtocol.Hash(stream);
        return new ImportRequest { requestId = Guid.NewGuid().ToString("N"), projectPath = root, packageId = package,
            version = "1.0.0", name = "Queue fixture", byteLength = Package.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
    }
    private static string PathFor(string root, string area, ImportRequest request) => PluginProtocol.Area(root, area + "/" + request.requestId + ".json");
    private static void Final(string root, ImportRequest request, string status = "cancelled") =>
        PluginProtocol.SaveNew(root, "receipts/" + request.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(new ImportReceipt { requestId = request.requestId, status = status, message = "Fixture terminal outcome" }, true)));
    private static string Snapshot(string root) => string.Join("\n", Directory.GetFiles(root, "*", SearchOption.AllDirectories).OrderBy(path => path, StringComparer.Ordinal).Select(path => path.Substring(root.Length) + ":" + (Path.GetFileName(path) == "desktop.lock" ? "lock:" + new FileInfo(path).Length : Convert.ToBase64String(File.ReadAllBytes(path))) + ":" + File.GetLastWriteTimeUtc(path).Ticks));
    private static int InboxCount(string root) => Directory.GetFiles(PluginProtocol.Area(root, "inbox"), "*.json").Length;

    internal static int Run(string parent)
    {
        checks = 0;
        string root = NewRoot(parent, "boundary");
        for (int n = 0; n < 100; n++) PluginQueue.Enqueue(root, Request(root, "fixture.package" + n), Package);
        Check(InboxCount(root) == 100, "The 100th unresolved request was not accepted.");
        string before = Snapshot(root);
        Reject(() => PluginQueue.Enqueue(root, Request(root, "fixture.overflow"), Package), "The 101st unresolved request was accepted.");
        Check(Snapshot(root) == before, "Full queue refusal changed files.");

        root = NewRoot(parent, "missing-receipt");
        var missing = Request(root);
        PluginQueue.Enqueue(root, missing, Package);
        before = Snapshot(root);
        Reject(() => PluginQueue.Enqueue(root, Request(root), Package), "An unresolved duplicate package was accepted.");
        Check(Snapshot(root) == before, "Unresolved duplicate refusal changed files.");
        PluginQueue.Enqueue(root, Request(root, "fixture.other"), Package);
        Check(InboxCount(root) == 2 && File.Exists(PathFor(root, "inbox", missing)), "Missing receipt was treated as a terminal outcome.");
        Check(PluginQueue.Find(root, missing.requestId).requestId == missing.requestId, "Current request could not be read.");

        foreach (string status in new[] { "imported", "cancelled", "failed" })
        {
            root = NewRoot(parent, "terminal-" + status);
            var first = Request(root);
            PluginQueue.Enqueue(root, first, Package);
            byte[] original = File.ReadAllBytes(PathFor(root, "inbox", first));
            Final(root, first, status);
            byte[] receipt = File.ReadAllBytes(PathFor(root, "receipts", first));
            DateTime timestamp = File.GetLastWriteTimeUtc(PathFor(root, "receipts", first));
            var next = Request(root);
            PluginQueue.Enqueue(root, next, Package);
            Check(InboxCount(root) == 1 && !File.Exists(PathFor(root, "inbox", first)), "Terminal request still consumes an inbox slot.");
            Check(File.ReadAllBytes(PathFor(root, "history/requests", first)).SequenceEqual(original), "Archival changed request bytes.");
            Check(File.ReadAllBytes(PathFor(root, "receipts", first)).SequenceEqual(receipt) && File.GetLastWriteTimeUtc(PathFor(root, "receipts", first)) == timestamp, "Archival rewrote the final receipt.");
            Check(PluginQueue.Find(root, first.requestId).requestId == first.requestId && PluginQueue.TerminalReceipt(root, first.requestId).status == status, "Archived request or final outcome is unreadable.");
            File.Delete(PathFor(root, "receipts", first));
            Reject(() => PluginQueue.Find(root, first.requestId), "History without its final receipt was treated as queued.");
        }

        foreach (string invalid in new[] { "not-json", "{}", "queued", "review", "unknown", "wrong-id", "wrong-schema", "empty-message" })
        {
            root = NewRoot(parent, "invalid-" + invalid);
            var terminal = Request(root, "fixture.terminal");
            PluginQueue.Enqueue(root, terminal, Package);
            var bad = Request(root, "fixture.bad");
            PluginQueue.Enqueue(root, bad, Package);
            Final(root, terminal);
            var receipt = new ImportReceipt { requestId = bad.requestId, status = invalid, message = "Invalid fixture" };
            if (invalid == "wrong-id") { receipt.requestId = Guid.NewGuid().ToString("N"); receipt.status = "cancelled"; }
            if (invalid == "wrong-schema") { receipt.schemaVersion = 2; receipt.status = "cancelled"; }
            if (invalid == "empty-message") { receipt.message = ""; receipt.status = "cancelled"; }
            string json = invalid == "not-json" || invalid == "{}" ? invalid : JsonUtility.ToJson(receipt);
            PluginProtocol.SaveNew(root, "receipts/" + bad.requestId + ".json", Encoding.UTF8.GetBytes(json));
            before = Snapshot(root);
            Reject(() => PluginQueue.Enqueue(root, Request(root, "fixture.new"), Package), "Invalid receipt was accepted: " + invalid);
            Check(Snapshot(root) == before, "Invalid receipt caused partial archival: " + invalid);
        }

        root = NewRoot(parent, "malformed-request");
        var done = Request(root);
        PluginQueue.Enqueue(root, done, Package); Final(root, done);
        PluginProtocol.SaveNew(root, "inbox/" + new string('f', 32) + ".json", Encoding.UTF8.GetBytes("{}"));
        before = Snapshot(root);
        Reject(() => PluginQueue.Enqueue(root, Request(root, "fixture.new"), Package), "Malformed request did not stop archival.");
        Check(Snapshot(root) == before, "Malformed request changed the snapshot.");

        root = NewRoot(parent, "archive-collision");
        done = Request(root);
        PluginQueue.Enqueue(root, done, Package); Final(root, done);
        PluginProtocol.SaveNew(root, "history/requests/" + done.requestId + ".json", File.ReadAllBytes(PathFor(root, "inbox", done)));
        before = Snapshot(root);
        Reject(() => PluginQueue.Enqueue(root, Request(root), Package), "Identical history collision was overwritten or deleted.");
        Reject(() => PluginQueue.Find(root, done.requestId), "Conflicting current/history locations were accepted.");
        Check(Snapshot(root) == before, "History collision changed files.");

        root = NewRoot(parent, "repeat-cancel-retry");
        var expected = new Dictionary<string, byte[]>();
        for (int n = 0; n < 125; n++)
        {
            var item = Request(root);
            PluginQueue.Enqueue(root, item, Package);
            Check(InboxCount(root) == 1, "Retry accumulated completed inbox slots.");
            expected.Add("history/requests/" + item.requestId + ".json", File.ReadAllBytes(PathFor(root, "inbox", item)));
            Final(root, item);
            expected.Add("receipts/" + item.requestId + ".json", File.ReadAllBytes(PathFor(root, "receipts", item)));
        }
        PluginQueue.Enqueue(root, Request(root), Package);
        Check(InboxCount(root) == 1 && Directory.GetFiles(PluginProtocol.Area(root, "history/requests")).Length == 125, "Repeated terminal requests exhausted the inbox.");
        Check(expected.All(pair => File.ReadAllBytes(PluginProtocol.Area(root, pair.Key)).SequenceEqual(pair.Value)), "Repeated retry changed or lost history.");

        root = NewRoot(parent, "legacy-terminal-inbox");
        var cached = Request(root);
        PluginProtocol.SaveNew(root, "packages/" + cached.packageFile, Package);
        for (int n = 0; n < 101; n++)
        {
            var item = Request(root);
            PluginProtocol.SaveNew(root, "inbox/" + item.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(item)));
            Final(root, item);
        }
        PluginQueue.Enqueue(root, Request(root), Package);
        Check(InboxCount(root) == 1 && Directory.GetFiles(PluginProtocol.Area(root, "history/requests")).Length == 101, "Legacy terminal overflow could not be archived within the scan bound.");

        root = NewRoot(parent, "scan-bound");
        for (int n = 0; n < 1001; n++)
        {
            var item = Request(root, "fixture.item" + n);
            PluginProtocol.SaveNew(root, "inbox/" + item.requestId + ".json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(item)));
            Final(root, item);
        }
        before = Snapshot(root);
        Reject(() => PluginQueue.Enqueue(root, Request(root), Package), "Inbox inspection exceeded its 1000-entry bound.");
        Check(Snapshot(root) == before, "Scan limit refusal changed queue history.");

        root = NewRoot(parent, "lock-exclusion");
        var queued = Request(root);
        using (new PluginQueueLock(root))
        {
            before = Snapshot(root);
            Reject(() => PluginQueue.Enqueue(root, queued, Package), "Queue ignored another operation lock.");
            Check(Snapshot(root) == before, "Lock refusal changed queue files.");
        }
        PluginQueue.Enqueue(root, queued, Package);
        Check(InboxCount(root) == 1, "Released lock did not allow a new explicit attempt.");
        Check(!Directory.Exists(Path.Combine(parent, "Assets")), "Queue test wrote asset content.");
        return checks;
    }
}
