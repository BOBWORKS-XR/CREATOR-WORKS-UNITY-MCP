using System;
using System.IO;
using System.Linq;
using System.Text;
using CreatorWorks.Plugins;

internal static class CreatorPluginsProtocolTests
{
    private static int count;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); count++; }
    private static void Reject(Action action, string name) { try { action(); } catch { count++; return; } throw new Exception(name); }
    public static int Main(string[] args)
    {
        try
        {
            string project = Path.GetFullPath(args[0]); Directory.CreateDirectory(project);
            if (args.Length > 1) count += CreatorPluginsLockTests.Run(project, args[1]);
            Check(PluginProtocol.ReceiptMessage("line1\r\nline2\rline3\t\u0000") == "line1\nline2\nline3\t ", "Failure receipt did not normalize Windows errors.");
            Check(PluginProtocol.Text(PluginProtocol.ReceiptMessage(null), 4000), "Missing callback message creates an invalid receipt.");
            Check(PluginProtocol.ReceiptMessage(new string('x', 4001)).Length == 4000, "Receipt message exceeds its shared bound.");
            Check(PluginProtocol.ReceiptMessage(new string('x', 3999) + "\ud83d\ude00").Length == 3999, "Receipt bound split a surrogate pair.");
            byte[] data = Encoding.ASCII.GetBytes("fixture");
            string hash; using (var stream = new MemoryStream(data)) hash = PluginProtocol.Hash(stream);
            var request = new ImportRequest { requestId = new string('a', 32), projectPath = project, packageId = "fixture.package", version = "1.0.0", name = "Fixture", byteLength = data.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
            var listing = new Listing {
                schemaVersion = 1, id = "fixture.ai", version = "1.0.0", name = "AI fixture",
                description = "Offline category validation fixture", author = new Author { name = "Fixture author" },
                license = "MIT", licensePath = "packages/fixture/LICENSE", instructionsPath = "packages/fixture/README.md",
                testNotes = "Protocol validation only", compatibility = new Compatibility()
            };
            foreach (var category in new[] { "mcp-tool", "ai-skill" })
            {
                listing.category = category; listing.scope = "instructions-only"; listing.download = null; listing.reviewStatus = null;
                PluginProtocol.ValidateListing(listing);
                Check(listing.reviewStatus == "pending", "new category bypassed default pending review");
                listing.reviewStatus = "listed"; listing.scope = "editor-only";
                listing.download = new PackageDownload { url = "https://cdn.sidequestvr.com/file/1/tool.zip", sha256 = hash, byteLength = data.Length };
                PluginProtocol.ValidateListing(listing); count++;
                Check(!PluginProtocol.CanImport(listing), "AI ZIP contribution allowed into Unity");
                listing.download.url = "https://cdn.sidequestvr.com/file/1/tool.unitypackage";
                Check(!PluginProtocol.CanImport(listing), "AI category disguised as unitypackage allowed into Unity");
                request.packageFile = hash + ".zip";
                Reject(() => PluginProtocol.ValidateRequest(request, project), "ZIP accepted as Unity import request");
                request.packageFile = hash + ".unitypackage";
            }
            foreach (var category in new[] { "graph", "prefab", "plugin", "community-tool" })
            {
                listing.category = category; listing.reviewStatus = "listed";
                listing.download.url = "https://cdn.sidequestvr.com/file/1/tool.unitypackage";
                foreach (var scope in new[] { "editor-only", "runtime", "both" })
                {
                    listing.scope = scope;
                    Check(PluginProtocol.CanImport(listing), "valid Unity contribution route rejected");
                }
                listing.scope = "instructions-only";
                Check(!PluginProtocol.CanImport(listing), "instructions-only scope allowed into Unity");
                listing.scope = "editor-only"; listing.reviewStatus = "pending";
                Check(!PluginProtocol.CanImport(listing), "pending contribution allowed into Unity");
                listing.reviewStatus = "listed"; listing.download.url = "https://cdn.sidequestvr.com/file/1/tool.zip";
                Check(!PluginProtocol.CanImport(listing), "ZIP contribution allowed into Unity");
            }
            listing.category = "unknown-tool";
            Reject(() => PluginProtocol.ValidateListing(listing), "unknown contribution category accepted");
            PluginProtocol.ValidateRequest(request, project); count++;
            Reject(() => PluginProtocol.ValidateRequest(request, project + "-other"), "wrong project accepted");
            request.packageFile = "../outside.unitypackage";
            Reject(() => PluginProtocol.ValidateRequest(request, project), "unsafe package basename accepted");
            request.packageFile = hash + ".unitypackage";
            request.requestId = new string('A', 32);
            Reject(() => PluginProtocol.ValidateRequest(request, project), "uppercase request ID accepted");
            request.requestId = new string('a', 32);
            Check(!PluginProtocol.Hex(new string('a', 31) + "\n", 32), "newline in request ID accepted");
            Check(!PluginProtocol.Id("test.id\n"), "newline in package ID accepted");
            Check(!PluginProtocol.Version("1.0.0\n"), "newline in version accepted");
            Check(!PluginProtocol.RepositoryPath("packages/item\n"), "newline in repository path accepted");
            Reject(() => PluginProtocol.Area(project, "../../outside"), "cache escape accepted");
            foreach (var url in new[] { "http://cdn.sidequestvr.com/file/a.png", "https://evil.test/file/a.png", "https://github.com.evil.test/a", "file:///C:/a", "https://user@github.com/a", "https://github.com/a?command=x" }) Check(!PluginProtocol.WebUrl(url), "unsafe URL accepted");
            Check(PluginProtocol.WebUrl("https://cdn.sidequestvr.com/file/a.png", true), "CDN image rejected");
            Check(!PluginProtocol.WebUrl("https://github.com/a/b", true), "non-image host accepted");
            foreach (var path in new[] { "../a", "packages/../a", "a//b", "a/%2e%2e/b", "a/b?c", "a\\b/c" }) Check(!PluginProtocol.RepositoryPath(path), "repository escape accepted");
            PluginProtocol.Verify(data, data.Length, hash); count++;
            Reject(() => PluginProtocol.Verify(data, data.Length + 1, hash), "wrong length accepted");
            Reject(() => PluginProtocol.Verify(data, data.Length, new string('0', 64)), "wrong hash accepted");
            PluginProtocol.SaveNew(project, "packages/" + request.packageFile, data);
            Reject(() => PluginProtocol.SaveNew(project, "packages/" + request.packageFile, Encoding.ASCII.GetBytes("replace")), "existing file overwritten");
            using (var file = PluginProtocol.LockPackage(request, project)) Check(file.Length == data.Length, "locked package mismatch");
            Check(PluginProtocol.ReadBounded(PluginProtocol.Area(project, "packages/" + request.packageFile), 100).SequenceEqual(data), "original bytes changed");
            Reject(() => PluginProtocol.ReadBounded(PluginProtocol.Area(project, "packages/" + request.packageFile), 1), "unbounded read");
            Check(PluginProtocol.MatchesCallback(request, hash), "exact callback rejected");
            Check(!PluginProtocol.MatchesCallback(request, "unrelated"), "unrelated callback accepted");
            byte[] png = new byte[24]; byte[] header = { 137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82 };
            Array.Copy(header, png, header.Length); png[19] = 32; png[23] = 32;
            Check(PluginProtocol.ImageDimensions(png), "bounded PNG header rejected");
            png[16] = 1; Check(!PluginProtocol.ImageDimensions(png), "oversized image accepted");
            Check(!PluginProtocol.ImageDimensions(new byte[] { 1, 2, 3 }), "invalid image accepted");
            var graph = new OrganizationPolicy.Asset { path = "Assets/Imported/Start.asset", guid = new string('a', 32), kind = "graph" };
            var prefab = new OrganizationPolicy.Asset { path = "Assets/Imported/Chair.prefab", guid = new string('b', 32), kind = "prefab" };
            Func<string, bool> none = _ => false;
            var move = OrganizationPolicy.Plan(new[] { graph }, none, none).Single();
            Check(move.source == graph.path && move.destination == "Assets/Visual Scripting/Start.asset" && move.guid == graph.guid, "graph default plan changed identity");
            foreach (string folder in OrganizationPolicy.GraphFolders)
                Check(OrganizationPolicy.Plan(new[] { graph }, p => p == folder, none).Single().destination == folder + "/Start.asset", "existing graph folder was ignored");
            Check(OrganizationPolicy.Plan(new[] { prefab }, none, none).Single().destination == "Assets/Prefabs/Chair.prefab", "prefab destination wrong");
            Reject(() => OrganizationPolicy.Plan(new[] { graph, prefab }, none, none), "mixed category selection accepted");
            Reject(() => OrganizationPolicy.Plan(new[] { graph, graph }, none, none), "duplicate selection accepted");
            Reject(() => OrganizationPolicy.Plan(new OrganizationPolicy.Asset[0], none, none), "empty selection accepted");
            Reject(() => OrganizationPolicy.Plan(Enumerable.Repeat(graph, 65).ToArray(), none, none), "unbounded selection accepted");
            Reject(() => OrganizationPolicy.Plan(new[] { graph }, none, p => p == "Assets/Visual Scripting"), "file in folder location accepted");
            Reject(() => OrganizationPolicy.Plan(new[] { graph }, none, p => p.EndsWith("/Start.asset")), "destination overwrite accepted");
            var sameName = new OrganizationPolicy.Asset { path = "Assets/Other/start.asset", guid = new string('c', 32), kind = "graph" };
            Reject(() => OrganizationPolicy.Plan(new[] { graph, sameName }, none, none), "case-insensitive basename collision accepted");
            foreach (string unsafePath in new[] { "Packages/foo/Start.asset", "Assets/../Start.asset", "Assets//Start.asset", "Assets/./Start.asset", "Assets/a\\b.asset", "Assets/a:b.asset", "Assets/a\n.asset" })
                Check(!OrganizationPolicy.AssetPath(unsafePath), "unsafe asset path accepted");
            graph.path = "Assets/Visual Scripting/Start.asset";
            Reject(() => OrganizationPolicy.Plan(new[] { graph }, none, none), "already organized selection accepted");
            graph.path = "Assets/Imported/Script.cs"; graph.kind = "script";
            Reject(() => OrganizationPolicy.Plan(new[] { graph }, none, none), "C# move accepted");
            Console.WriteLine("Creator Plugins protocol: " + count + " checks passed. No Unity APIs or imports executed.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
