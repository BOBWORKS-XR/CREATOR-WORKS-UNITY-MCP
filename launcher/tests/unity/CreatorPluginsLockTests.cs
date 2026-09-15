using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using CreatorWorks.Plugins;

internal static class CreatorPluginsLockTests
{
    private static Process Probe(string executable, string arguments) => Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false, CreateNoWindow = true });
    private static int Exit(Process process)
    {
        if (!process.WaitForExit(25000)) throw new Exception("Lock probe exceeded its own 20-second deadline; inspect the fixture process.");
        return process.ExitCode;
    }
    internal static int Run(string project, string executable)
    {
        if (!File.Exists(executable)) throw new Exception("Missing Rust fs2 lock probe.");
        string file = PluginProtocol.Area(project, "desktop.lock");
        using (new PluginQueueLock(project))
        using (var probe = Probe(executable, "try \"" + file + "\""))
            if (Exit(probe) != 10) throw new Exception("Rust acquired a lock already held by Unity C#.");
        using (var probe = Probe(executable, "try \"" + file + "\""))
            if (Exit(probe) != 0) throw new Exception("C# did not release the lock for Rust.");
        string ready = Path.Combine(project, "rust-ready"), release = Path.Combine(project, "rust-release");
        using (var probe = Probe(executable, "hold \"" + file + "\" \"" + ready + "\" \"" + release + "\""))
        {
            try
            {
                var timer = Stopwatch.StartNew();
                while (!File.Exists(ready) && !probe.HasExited && timer.Elapsed.TotalSeconds < 10) Thread.Sleep(20);
                if (!File.Exists(ready) || probe.HasExited) throw new Exception("Rust lock probe did not become ready.");
                bool blocked = false;
                try { using (new PluginQueueLock(project)) { } } catch (IOException) { blocked = true; }
                if (!blocked) throw new Exception("Unity C# acquired the lock already held by Rust.");
            }
            finally { File.WriteAllText(release, "release"); Exit(probe); }
            if (probe.ExitCode != 0) throw new Exception("Rust lock probe failed.");
        }
        using (new PluginQueueLock(project)) { }
        return 4;
    }
}
