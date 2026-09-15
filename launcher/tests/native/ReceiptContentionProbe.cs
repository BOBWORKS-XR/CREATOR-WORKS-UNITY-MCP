using System;
using System.Diagnostics;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Diagnostic only. New owned folders; failures and temporary files are preserved.
public static class ReceiptContentionProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReplaceFileW(string destination, string source, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder name, uint capacity, uint flags);
    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(IntPtr file);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint count, string[] paths, uint applications, IntPtr processes, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, ref uint reasons);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint session);
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public UniqueProcess process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
        public uint type, status, session;
        [MarshalAs(UnmanagedType.Bool)] public bool restartable;
    }
    private static string Users(string path)
    {
        uint session;
        int result = RmStartSession(out session, 0, new StringBuilder(33));
        if (result != 0) return "RmStartSession=" + result;
        try
        {
            result = RmRegisterResources(session, 1, new[] { path }, 0, IntPtr.Zero, 0, IntPtr.Zero);
            if (result != 0) return "RmRegisterResources=" + result;
            uint needed, count = 64, reasons = 0;
            var processes = new ProcessInfo[count];
            result = RmGetList(session, out needed, ref count, processes, ref reasons);
            var message = new StringBuilder("RmGetList=" + result + " needed=" + needed + " count=" + count);
            if (result == 0) for (int i = 0; i < count; i++) message.Append(" pid=" + processes[i].process.pid + " name=" + processes[i].name);
            return message.ToString();
        }
        finally { RmEndSession(session); }
    }

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "child")
        {
            var names = new StringBuilder();
            for (int h = 4; h < 65536; h += 4)
            {
                var handle = new IntPtr(h);
                if (GetFileType(handle) != 1) continue;
                var name = new StringBuilder(2048);
                if (GetFinalPathNameByHandleW(handle, name, 2048, 0) > 0 && name.ToString().Contains("creator-receipt-contention-"))
                    names.AppendLine(h + ": " + name);
            }
            File.WriteAllText(args[1], names.ToString());
            Thread.Sleep(50);
            return 0;
        }
        if (args.Length != 1 || !Directory.Exists(args[0])) return 2;
        var root = Path.Combine(Path.GetFullPath(args[0]), "creator-receipt-contention-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var log = new StringBuilder();
        foreach (var mode in new[] { "replace", "replace-backup", "move" })
        {
            string directory = Path.Combine(root, "mapped-" + mode);
            Directory.CreateDirectory(directory);
            string original = Path.Combine(directory, "receipt.json"), replacement = Path.Combine(directory, "new.json");
            File.WriteAllText(original, "old-complete-record"); File.WriteAllText(replacement, "new-complete-record");
            using (var file = new FileStream(original, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var mapping = MemoryMappedFile.CreateFromFile(file, null, 0, MemoryMappedFileAccess.Read, HandleInheritability.None, true))
            using (var view = mapping.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read))
            {
                bool replaced = mode == "move" ? MoveFileExW(replacement, original, 1)
                    : ReplaceFileW(original, replacement, mode == "replace-backup" ? Path.Combine(directory, "backup.json") : null, 0, IntPtr.Zero, IntPtr.Zero);
                int error = replaced ? 0 : Marshal.GetLastWin32Error();
                log.AppendLine("mapped " + mode + " success=" + replaced + " error=" + error + " content=" + File.ReadAllText(original) + " mappedFirst=" + view.ReadByte(0));
            }
        }
        foreach (bool backup in new[] { false, true })
        foreach (bool spawn in new[] { false, true })
        {
            var folder = Path.Combine(root, (backup ? "backup-" : "no-backup-") + (spawn ? "with-child" : "solo"));
            Directory.CreateDirectory(folder);
            int done = 0, children = 0;
            bool finished = false;
            Exception workerError = null;
            var worker = new Thread(() => {
                try
                {
                    while (!Volatile.Read(ref finished))
                    {
                        var output = Path.Combine(folder, "child-" + children + ".txt");
                        var info = new ProcessStartInfo(typeof(ReceiptContentionProbe).Assembly.Location, "child \"" + output + "\"")
                        { UseShellExecute = false, CreateNoWindow = true };
                        using (var process = Process.Start(info)) { process.WaitForExit(); if (process.ExitCode != 0) throw new Exception("Child failed"); }
                        children++;
                    }
                }
                catch (Exception error) { workerError = error; }
            });
            var destination = Path.Combine(folder, "receipt.json");
            File.WriteAllText(destination, "initial");
            if (spawn) worker.Start();
            try
            {
                for (int i = 0; i < 5000; i++)
                {
                    var source = Path.Combine(folder, "new-" + i + ".json");
                    var data = Encoding.UTF8.GetBytes("receipt " + i);
                    using (var stream = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    { stream.Write(data, 0, data.Length); stream.Flush(true); }
                    string saved = backup ? Path.Combine(folder, "old-" + i + ".json") : null;
                    if (!ReplaceFileW(destination, source, saved, 0, IntPtr.Zero, IntPtr.Zero))
                    {
                        int error = Marshal.GetLastWin32Error();
                        log.AppendLine("backup=" + backup + " spawn=" + spawn + " failed=" + error + " iteration=" + i + " attributes=" + File.GetAttributes(destination));
                        log.AppendLine(Users(destination));
                        break;
                    }
                    if (File.ReadAllText(destination) != "receipt " + i) throw new Exception("Readback mismatch");
                    if (saved != null)
                    {
                        if (File.ReadAllText(saved) != (i == 0 ? "initial" : "receipt " + (i - 1))) throw new Exception("Backup readback mismatch");
                        try { File.Delete(saved); } catch (IOException error) { log.AppendLine("backup cleanup failed: " + error.Message); }
                    }
                    done++;
                }
            }
            finally { Volatile.Write(ref finished, true); if (spawn) worker.Join(); }
            log.AppendLine("backup=" + backup + " spawn=" + spawn + " completed=" + done + " children=" + children + " workerError=" + workerError);
        }
        File.WriteAllText(Path.Combine(root, "result.txt"), log.ToString());
        Console.WriteLine(root);
        Console.WriteLine(log);
        return 0;
    }
}
