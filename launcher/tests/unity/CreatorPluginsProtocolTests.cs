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
            byte[] data = Encoding.ASCII.GetBytes("fixture");
            string hash; using (var stream = new MemoryStream(data)) hash = PluginProtocol.Hash(stream);
            var request = new ImportRequest { requestId = new string('a', 32), projectPath = project, packageId = "fixture.package", version = "1.0.0", name = "Fixture", byteLength = data.Length, sha256 = hash, packageFile = hash + ".unitypackage" };
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
            Console.WriteLine("Creator Plugins protocol: " + count + " checks passed. No Unity APIs or imports executed.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
