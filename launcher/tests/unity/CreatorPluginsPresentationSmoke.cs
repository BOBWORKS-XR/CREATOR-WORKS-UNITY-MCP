using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEngine;

public static class CreatorPluginsPresentationSmoke
{
    [Serializable] private sealed class Report { public bool passed; public string unity, error; public string[] checks; }
    private static readonly List<string> checks = new List<string>();
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
    private static object Call(object instance, string method, params object[] args) => instance.GetType().GetMethod(method, Private).Invoke(instance, args);
    private static T Get<T>(object instance, string field) => (T)instance.GetType().GetField(field, Private).GetValue(instance);
    private static void Set(object instance, string field, object value) => instance.GetType().GetField(field, Private).SetValue(instance, value);
    public static void Run()
    {
        string project = Path.GetDirectoryName(Application.dataPath);
        if (!File.Exists(Path.Combine(project, ".presentation-test-fixture"))) throw new Exception("Refusing a real project.");
        CreatorPluginsWindow window = null;
        bool hadLayout = EditorPrefs.HasKey(CreatorPluginsWindow.LayoutPreference);
        string savedLayout = EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference, "list");
        var report = new Report { unity = Application.unityVersion };
        try
        {
            Check(CreatorPluginsWindow.Summary(null) == "", "null summary");
            Check(CreatorPluginsWindow.Summary("Short description") == "Short description", "short summary unchanged");
            Check(CreatorPluginsWindow.Summary("Two\nlines") == "Two lines", "multiline summary");
            Check(CreatorPluginsWindow.Summary(new string('x', 400)).Length == 200, "unbroken summary bounded");
            Check(CreatorPluginsWindow.Summary(string.Join(" ", Enumerable.Repeat("description", 50))).EndsWith("..."), "long summary shortened");
            var entry = JsonUtility.FromJson<Listing>(File.ReadAllText(Path.Combine(project, "listing.json")));
            entry.reviewStatus = "listed";
            PluginProtocol.ValidateListing(entry);
            Check(PluginProtocol.CanImport(entry), "listed graph remains importable");
            var changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry));
            Check(CreatorPluginsWindow.SameDownload(entry, changed), "unchanged identity matches");
            changed.download.sha256 = new string('a', 64);
            Check(!CreatorPluginsWindow.SameDownload(entry, changed), "changed hash refused");
            changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); changed.version = "9.9.9";
            Check(!CreatorPluginsWindow.SameDownload(entry, changed), "changed version refused");
            changed = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); changed.reviewStatus = "pending";
            Check(!PluginProtocol.CanImport(changed), "withdrawn listing not importable");
            changed.category = "ai-skill"; changed.reviewStatus = "listed";
            Check(!PluginProtocol.CanImport(changed), "AI skill does not route into Unity");

            EditorPrefs.DeleteKey(CreatorPluginsWindow.LayoutPreference);
            window = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(Get<bool>(window, "gridView"), "fresh window defaults to grid");
            Call(window, "StopDownload");
            Check(CreatorPluginsWindow.GridColumns(330) == 1, "narrow grid has one column");
            Check(CreatorPluginsWindow.GridColumns(540) == 2, "medium grid has two columns");
            Check(CreatorPluginsWindow.GridColumns(810) == 3, "wide grid has three columns");
            Check(CreatorPluginsWindow.GridColumns(0) == 1, "grid always has a column");
            Set(window, "selected", entry); Set(window, "search", "kept search");
            Call(window, "SetLayout", true);
            Check(Get<bool>(window, "gridView") && EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference) == "grid", "grid selection persisted");
            Check(Get<Listing>(window, "selected") == entry && Get<string>(window, "search") == "kept search", "view switch preserves selected detail and search");
            var reopened = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(Get<bool>(reopened, "gridView"), "reopened window restores grid");
            UnityEngine.Object.DestroyImmediate(reopened);
            Call(window, "SetLayout", false);
            Check(!Get<bool>(window, "gridView") && EditorPrefs.GetString(CreatorPluginsWindow.LayoutPreference) == "list", "list selection persisted");
            reopened = ScriptableObject.CreateInstance<CreatorPluginsWindow>();
            Check(!Get<bool>(reopened, "gridView"), "explicit list preference survives reopen");
            UnityEngine.Object.DestroyImmediate(reopened);
            var noImage = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry)); noImage.previewImage = "http://unapproved.invalid/image.png";
            Call(window, "RequestPreview", noImage);
            Check(Get<object>(window, "previewRequest") == null, "unapproved preview not fetched");
            Check(Get<object>(window, "request") == null, "thumbnail path independent of action request");
            var source = new Texture2D(1024, 512, TextureFormat.RGBA32, false);
            var thumbnail = (Texture2D)typeof(CreatorPluginsWindow).GetMethod("MakeThumbnail", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { source });
            Check(thumbnail.width == 320 && thumbnail.height == 160, "thumbnail bounded with preserved aspect ratio");
            Check(!thumbnail.isReadable, "thumbnail CPU pixels released");
            UnityEngine.Object.DestroyImmediate(source);
            Get<Dictionary<string, Texture2D>>(window, "previews").Add("fixture", thumbnail);
            Call(window, "ClearPreviews");
            Check(thumbnail == null && Get<Dictionary<string, Texture2D>>(window, "previews").Count == 0, "preview textures disposed");

            Set(window, "catalogueFresh", true); Set(window, "catalogueLoadedAt", EditorApplication.timeSinceStartup - 181);
            Call(window, "Import", entry);
            Check(Get<Listing>(window, "pendingImport") == entry && Get<object>(window, "request") != null, "expired catalogue starts revalidation on explicit import");
            Check(!Directory.Exists(PluginProtocol.Area(project, "inbox")), "revalidation writes no import request");
            Call(window, "CancelDownload");
            Check(Get<Listing>(window, "pendingImport") == null && Get<object>(window, "request") == null, "cancel clears download and deferred import");
            Check(Get<string>(window, "message").Contains("try again"), "cancel offers recovery without reopening");
            Get<List<Listing>>(window, "listings").Add(changed);
            Set(window, "pendingListings", Array.Empty<string>()); Set(window, "pendingImport", entry);
            Set(window, "catalogueDeadline", EditorApplication.timeSinceStartup + 30);
            Call(window, "NextListing");
            Check(Get<Listing>(window, "pendingImport") == null && Get<string>(window, "message").Contains("No import started"), "withdrawal during revalidation does not import");

            byte[] bytes = Encoding.UTF8.GetBytes("Harmless state-machine test bytes; not an importable archive.");
            entry.download.byteLength = bytes.Length;
            using (var stream = new MemoryStream(bytes)) entry.download.sha256 = PluginProtocol.Hash(stream);
            string file = entry.download.sha256 + ".unitypackage";
            PluginProtocol.SaveNew(project, "packages/" + file, bytes);
            var first = CreatorPluginsWindow.QueueImport(entry, file);
            PluginProtocol.SaveNew(project, "active-review.json", Encoding.UTF8.GetBytes(JsonUtility.ToJson(first)));
            ImportReview.Active = first;
            // Callback-state test only: no claim of physically clicking Unity's native dialog.
            typeof(ImportReview).GetMethod("Finished", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { file, "cancelled", "Fixture cancellation callback" });
            Check(ImportReview.Receipt(first).status == "cancelled", "cancellation callback persists final receipt");
            Check(ImportReview.Active == null && !File.Exists(PluginProtocol.Area(project, "active-review.json")), "cancellation releases pending state");
            Get<Dictionary<string, ImportReceipt>>(window, "receipts").Add(first.requestId, new ImportReceipt { requestId = first.requestId, status = "review" });
            Set(window, "nextPoll", EditorApplication.timeSinceStartup + 60);
            Call(window, "Tick");
            Check(Get<Dictionary<string, ImportReceipt>>(window, "receipts")[first.requestId].status == "cancelled", "completion refreshes without waiting for poll timer");
            Check(Get<string>(window, "message").Contains("cancelled"), "cancel replaces outdated import prompt");
            byte[] receiptBefore = File.ReadAllBytes(PluginProtocol.Area(project, "receipts/" + first.requestId + ".json"));
            var instructions = JsonUtility.FromJson<Listing>(JsonUtility.ToJson(entry));
            instructions.download = null; instructions.scope = "instructions-only";
            PluginProtocol.ValidateListing(instructions);
            Check(!PluginProtocol.CanImport(instructions), "instructions-only listing without download remains valid but not importable");
            Get<List<Listing>>(window, "listings").Clear();
            Get<List<Listing>>(window, "listings").Add(instructions);
            Call(window, "RetryImport", first);
            Check(Get<string>(window, "message").Contains("Refresh the catalogue") && Get<int>(window, "tab") == 0, "retry after download withdrawal returns to catalogue without exception");
            Check(Directory.GetFiles(PluginProtocol.Area(project, "inbox"), "*.json").Length == 1 && ImportReview.Active == null, "withdrawn retry creates no request or import");
            var second = CreatorPluginsWindow.QueueImport(entry, file);
            Check(second.requestId != first.requestId && ImportReview.Receipt(second).status == "queued", "retry has a new queued identity");
            Check(File.Exists(PluginProtocol.Area(project, "history/requests/" + first.requestId + ".json")) && !File.Exists(PluginProtocol.Area(project, "inbox/" + first.requestId + ".json")), "retry archives only the completed request");
            Check(File.ReadAllBytes(PluginProtocol.Area(project, "receipts/" + first.requestId + ".json")).SequenceEqual(receiptBefore), "retry preserves cancellation evidence");
            Check(File.ReadAllBytes(PluginProtocol.Area(project, "packages/" + file)).SequenceEqual(bytes), "retry reuses unchanged cached bytes");
            File.WriteAllBytes(PluginProtocol.Area(project, "packages/" + file), new byte[] { 1, 2, 3 });
            Set(window, "catalogueFresh", true); Set(window, "catalogueLoadedAt", EditorApplication.timeSinceStartup);
            Call(window, "Download", entry);
            Check(Get<string>(window, "message").Contains("checksum"), "corrupted cache rejected before import");
            Check(Directory.GetFiles(PluginProtocol.Area(project, "inbox"), "*.json").Length == 1, "corrupted cache produces no extra request");
            Check(ImportReview.Active == null, "no import or scene operation was started");
            report.passed = true;
        }
        catch (Exception error) { report.error = error.ToString(); Debug.LogException(error); }
        finally
        {
            if (window != null) UnityEngine.Object.DestroyImmediate(window);
            if (hadLayout) EditorPrefs.SetString(CreatorPluginsWindow.LayoutPreference, savedLayout); else EditorPrefs.DeleteKey(CreatorPluginsWindow.LayoutPreference);
            report.checks = checks.ToArray();
            File.WriteAllText(Path.Combine(project, "presentation-result.json"), JsonUtility.ToJson(report, true));
            EditorApplication.Exit(report.passed ? 0 : 1);
        }
    }
}
