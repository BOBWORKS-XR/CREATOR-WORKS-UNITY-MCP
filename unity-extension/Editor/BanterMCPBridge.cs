using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;
using Unity.Profiling;

namespace BantworksMCP
{
    /// <summary>
    /// Unity Editor extension that bridges the Creator Works MCP server with Unity.
    /// Exports project state and handles MCP commands.
    /// Full Inspector integration - can see and modify all component properties.
    ///
    /// Installation:
    /// 1. Copy this file to your Unity project: Assets/Editor/BantworksMCPBridge.cs
    /// 2. Unity will compile it automatically
    /// 3. The bridge starts when Unity Editor opens
    /// </summary>
    [InitializeOnLoad]
    public static class BantworksMCPBridge
    {
        private static readonly string ProjectRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Directory.GetCurrentDirectory();
        private static readonly string MCPFolder = Path.Combine(ProjectRoot, ".bantworks-mcp");
        private static readonly string StateFolder = Path.Combine(MCPFolder, "state");
        private static readonly string CommandsFolder = Path.Combine(MCPFolder, "commands");
        private static readonly string FailedCommandsFolder = Path.Combine(CommandsFolder, "failed");
        private static readonly string CommandResultsFolder = Path.Combine(StateFolder, "command-results");
        private static readonly string BoundsResultsFolder = Path.Combine(StateFolder, "bounds-results");
        private static readonly string ScreenshotResultsFolder = Path.Combine(StateFolder, "screenshot-results");
        private static readonly string AssetSearchResultsFolder = Path.Combine(StateFolder, "asset-search-results");
        private static readonly string ShaderGraphResultsFolder = Path.Combine(StateFolder, "shader-graph-results");
        private static readonly string VisualScriptingValidationResultsFolder = Path.Combine(StateFolder, "vs-validation-results");
        private static readonly string BanterValidationResultsFolder = Path.Combine(StateFolder, "banter-validation-results");
        private static readonly string TestRunResultsFolder = Path.Combine(StateFolder, "test-runs");
        private static readonly string TestDiscoveryResultsFolder = Path.Combine(StateFolder, "test-discovery");
        private static readonly string SceneResultsFolder = Path.Combine(StateFolder, "scene-results");
        private static readonly string EditorMenuResultsFolder = Path.Combine(StateFolder, "editor-menu-results");
        private static readonly string HierarchyQueryResultsFolder = Path.Combine(StateFolder, "hierarchy-query-results");
        private static readonly Dictionary<string, UnityEngine.Object> ActiveTestDiscoveryApis = new Dictionary<string, UnityEngine.Object>();
        private const string BridgeVersion = "2.5.1";
        private const int BridgeProtocolVersion = 1;
        private const int MinimumBridgeProtocolVersion = 1;
        private const int MaximumPipeCommandCharacters = 4 * 1024 * 1024;
        private static readonly string PipeName = BuildPipeName();
        private static readonly ConcurrentQueue<PendingPipeCommand> PendingPipeCommands =
            new ConcurrentQueue<PendingPipeCommand>();
        private static readonly object PipeServerLock = new object();
        private static Thread pipeServerThread;
        private static NamedPipeServerStream activePipeServer;
        private static volatile bool pipeServerShutdownRequested;
        private static volatile bool pipeServerAvailable;

        private static double lastCommandCheck = 0;
        private static double lastLightweightStateExport = 0;
        private static double lastPeriodicPlayModeStateExport = 0;
        private static double lastConsoleExport = 0;
        private static double lastLauncherSettingsCheck = 0;
        private static double lastTestRunCheck = 0;
        private static double automaticStateExportNotBefore = 0;
        private static bool automaticStateExportPending;
        private static volatile bool consoleExportPending;
        private static readonly double CommandCheckInterval = 0.5; // seconds
        private static readonly double LightweightStateExportInterval = 1.0; // seconds
        private static readonly double PeriodicPlayModeStateExportInterval = 2.0; // seconds
        private static readonly double AutomaticStateExportDebounce = 0.5; // seconds
        private static readonly double ConsoleExportDebounce = 0.25; // seconds
        private static readonly double LauncherSettingsCheckInterval = 1.0; // seconds
        private const string BackgroundStateExportMenuItem = "Creator Works MCP/Background State Export In Play Mode";
        private const string BackgroundStateExportKey = "BantworksMCP_BackgroundStateExportInPlayMode";
        private const string BackgroundEditModeStateExportMenuItem = "Creator Works MCP/Background State Export In Edit Mode";
        private const string BackgroundEditModeStateExportKey = "BantworksMCP_BackgroundStateExportInEditMode";
        private static readonly ProfilerMarker AutomaticStateExportProfilerMarker =
            new ProfilerMarker("Creator Works MCP.AutomaticStateExport");
        private static readonly ProfilerMarker FullStateExportProfilerMarker =
            new ProfilerMarker("Creator Works MCP.ExportProjectState");
        private static DateTime lastLauncherSettingsWriteTime = DateTime.MinValue;
        private static string activeTestRunId;
        private static object activeTestRunnerApi;
        private static object activeTestRunnerCallback;

        // Public status for window
        public static bool IsConnected { get; private set; }
        public static string LastActivity { get; private set; }
        public static int CommandsProcessed { get; private set; }

        // Prefab scan progress
        public static bool IsScanningPrefabs { get; private set; }
        public static int ScanProgress { get; private set; }      // Current prefab being scanned
        public static int ScanTotal { get; private set; }         // Total prefabs to scan
        public static string ScanStatus { get; private set; }     // Current status message
        public static float ScanStartTime { get; private set; }   // When scan started (EditorApplication.timeSinceStartup)

        // Project mode toggle - enables custom script support for non-Banter projects
        private static readonly string EnableCustomScriptsKey = "BantworksMCP_EnableCustomScripts";
        public static bool EnableCustomScripts
        {
            get => EditorPrefs.GetBool(EnableCustomScriptsKey, false);
            set => EditorPrefs.SetBool(EnableCustomScriptsKey, value);
        }

        // Test runner policy - controls whether unfiltered full test suite sweeps are allowed
        private static readonly string AllowAllTestsKey = "BantworksMCP_AllowAllTests";
        public static bool AllowAllTests
        {
            get => EditorPrefs.GetBool(AllowAllTestsKey, true);
            set => EditorPrefs.SetBool(AllowAllTestsKey, value);
        }

        private static bool BackgroundStateExportInPlayMode
        {
            get => EditorPrefs.GetBool(BackgroundStateExportKey, false);
            set => EditorPrefs.SetBool(BackgroundStateExportKey, value);
        }

        private static bool BackgroundStateExportInEditMode
        {
            get => EditorPrefs.GetBool(BackgroundEditModeStateExportKey, false);
            set => EditorPrefs.SetBool(BackgroundEditModeStateExportKey, value);
        }

        private static bool AutomaticStateExportAllowed =>
            EditorApplication.isPlayingOrWillChangePlaymode
                ? BackgroundStateExportInPlayMode
                : BackgroundStateExportInEditMode;

        // Console log capture
        private static readonly List<ConsoleLogEntry> capturedLogs = new List<ConsoleLogEntry>();
        private static readonly int MaxLogEntries = 500;
        private static readonly object logLock = new object();
        private static readonly List<CompilationMessageInfo> compilationMessages = new List<CompilationMessageInfo>();
        private static long compilationStartedAt;
        private static bool compilationMessagesTruncated;

        static BantworksMCPBridge()
        {
            // Initialize folders
            EnsureDirectories();
            StartPipeServer();
            LoadLauncherSettingsIfChanged();

            // Subscribe to editor events
            EditorApplication.update += OnEditorUpdate;
            EditorApplication.projectChanged += OnProjectChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            Selection.selectionChanged += OnSelectionChanged;
            Undo.undoRedoPerformed += OnUndoRedoPerformed;
            EditorSceneManager.sceneOpened += OnSceneOpened;
            EditorSceneManager.sceneSaved += OnSceneSaved;
            AssemblyReloadEvents.beforeAssemblyReload += ShutdownPipeServer;
            EditorApplication.quitting += ShutdownPipeServer;

            // Do not export the complete hierarchy for ordinary transform/property edits.
            // Large scenes are refreshed explicitly by query_project_state; serializing them
            // from editor modification callbacks blocks Unity's main thread while authoring.

            // Subscribe to asset import events
            AssetDatabase.importPackageCompleted += OnImportCompleted;
            AssetDatabase.importPackageFailed += OnImportFailed;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished += OnCompilationFinished;

            // Subscribe to console log events
            Application.logMessageReceived += OnLogMessageReceived;

            // Background full exports are opt-in. Explicit MCP/manual refreshes still work.
            ScheduleAutomaticStateExport();

            // Scan prefabs on startup (delayed to not block editor)
            EditorApplication.delayCall += () => {
                ScanAndExportPrefabCatalog();
            };
            EditorApplication.delayCall += ResumePendingTestRun;

            IsConnected = true;
            LastActivity = DateTime.Now.ToString("HH:mm:ss") + " - Initialized";
            CommandsProcessed = 0;

            Debug.Log("[Creator Works MCP] Bridge initialized. State folder: " + StateFolder);
        }

        private static void EnsureDirectories()
        {
            if (!Directory.Exists(MCPFolder))
                Directory.CreateDirectory(MCPFolder);
            if (!Directory.Exists(StateFolder))
                Directory.CreateDirectory(StateFolder);
            if (!Directory.Exists(CommandsFolder))
                Directory.CreateDirectory(CommandsFolder);
            if (!Directory.Exists(FailedCommandsFolder))
                Directory.CreateDirectory(FailedCommandsFolder);
            if (!Directory.Exists(CommandResultsFolder))
                Directory.CreateDirectory(CommandResultsFolder);
            if (!Directory.Exists(BoundsResultsFolder))
                Directory.CreateDirectory(BoundsResultsFolder);
            if (!Directory.Exists(ScreenshotResultsFolder))
                Directory.CreateDirectory(ScreenshotResultsFolder);
            if (!Directory.Exists(AssetSearchResultsFolder))
                Directory.CreateDirectory(AssetSearchResultsFolder);
            if (!Directory.Exists(ShaderGraphResultsFolder))
                Directory.CreateDirectory(ShaderGraphResultsFolder);
            if (!Directory.Exists(VisualScriptingValidationResultsFolder))
                Directory.CreateDirectory(VisualScriptingValidationResultsFolder);
            if (!Directory.Exists(BanterValidationResultsFolder))
                Directory.CreateDirectory(BanterValidationResultsFolder);
            if (!Directory.Exists(TestRunResultsFolder))
                Directory.CreateDirectory(TestRunResultsFolder);
            if (!Directory.Exists(TestDiscoveryResultsFolder))
                Directory.CreateDirectory(TestDiscoveryResultsFolder);
            if (!Directory.Exists(SceneResultsFolder))
                Directory.CreateDirectory(SceneResultsFolder);
            if (!Directory.Exists(EditorMenuResultsFolder))
                Directory.CreateDirectory(EditorMenuResultsFolder);
            if (!Directory.Exists(HierarchyQueryResultsFolder))
                Directory.CreateDirectory(HierarchyQueryResultsFolder);

            string ignorePath = Path.Combine(MCPFolder, ".gitignore");
            if (!File.Exists(ignorePath))
                File.WriteAllText(ignorePath, "*\n!.gitignore\n");
        }

        private static void OnEditorUpdate()
        {
            double time = EditorApplication.timeSinceStartup;

            // Pipe threads only receive bytes. Unity API work is always drained here.
            ProcessPendingPipeCommands();

            // Check for commands periodically
            if (time - lastCommandCheck > CommandCheckInterval)
            {
                lastCommandCheck = time;
                ProcessCommands();
            }

            // Keep editor status fresh without traversing the scene hierarchy.
            if (time - lastLightweightStateExport > LightweightStateExportInterval)
            {
                lastLightweightStateExport = time;
                ExportEditorState();
            }

            if (consoleExportPending && time - lastConsoleExport > ConsoleExportDebounce)
            {
                consoleExportPending = false;
                lastConsoleExport = time;
                ExportConsoleLogs();
            }

            bool fullStateExported = false;
            if (automaticStateExportPending && time >= automaticStateExportNotBefore)
            {
                automaticStateExportPending = false;
                ExportProjectStateAutomatically();
                fullStateExported = true;
            }

            // Periodic full snapshots remain an explicit Play-mode opt-in.
            if (!fullStateExported && EditorApplication.isPlaying && BackgroundStateExportInPlayMode &&
                time - lastPeriodicPlayModeStateExport > PeriodicPlayModeStateExportInterval)
            {
                lastPeriodicPlayModeStateExport = time;
                ExportProjectStateAutomatically();
            }

            // Pick up launcher settings changes while Unity is open
            if (time - lastLauncherSettingsCheck > LauncherSettingsCheckInterval)
            {
                lastLauncherSettingsCheck = time;
                LoadLauncherSettingsIfChanged();
            }

            if (time - lastTestRunCheck > 1.0)
            {
                lastTestRunCheck = time;
                CheckActiveTestRunDeadline();
            }
        }

        private static void ExportProjectStateAutomatically()
        {
            if (!AutomaticStateExportAllowed)
                return;

            using (AutomaticStateExportProfilerMarker.Auto())
            {
                ExportProjectState();
            }
        }

        private static void ScheduleAutomaticStateExport(double delay = -1)
        {
            if (!AutomaticStateExportAllowed)
                return;

            double debounce = delay < 0 ? AutomaticStateExportDebounce : delay;
            automaticStateExportPending = true;
            automaticStateExportNotBefore = EditorApplication.timeSinceStartup + debounce;
        }

        private static void LoadLauncherSettingsIfChanged()
        {
            string settingsPath = Path.Combine(StateFolder, "launcher-settings.json");
            if (!File.Exists(settingsPath))
                return;

            try
            {
                DateTime writeTime = File.GetLastWriteTimeUtc(settingsPath);
                if (writeTime <= lastLauncherSettingsWriteTime)
                    return;

                string json = File.ReadAllText(settingsPath);
                var settings = JsonUtility.FromJson<LauncherSettings>(json);
                if (settings != null)
                {
                    if (EnableCustomScripts != settings.enableCustomScripts)
                    {
                        EnableCustomScripts = settings.enableCustomScripts;
                        LastActivity = DateTime.Now.ToString("HH:mm:ss") + " - Launcher settings applied";
                        Debug.Log($"[Creator Works MCP] Custom scripts {(settings.enableCustomScripts ? "enabled" : "disabled")} from launcher settings");
                    }

                    if (AllowAllTests != settings.allowAllTests)
                    {
                        AllowAllTests = settings.allowAllTests;
                        LastActivity = DateTime.Now.ToString("HH:mm:ss") + " - Launcher test policy applied";
                        Debug.Log($"[Creator Works MCP] Unfiltered test runs {(settings.allowAllTests ? "allowed" : "blocked")} from launcher settings");
                    }
                }

                lastLauncherSettingsWriteTime = writeTime;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Creator Works MCP] Could not read launcher settings: {e.Message}");
            }
        }

        private static void OnPlayModeChanged(PlayModeStateChange state)
        {
            ExportEditorState();

            if (state == PlayModeStateChange.EnteredEditMode)
            {
                ScheduleAutomaticStateExport();
            }
            else if (state == PlayModeStateChange.EnteredPlayMode && BackgroundStateExportInPlayMode)
            {
                lastPeriodicPlayModeStateExport = EditorApplication.timeSinceStartup;
                ScheduleAutomaticStateExport(0);
            }
        }

        private static void OnProjectChanged()
        {
            ScheduleAutomaticStateExport();
        }

        private static void OnSelectionChanged()
        {
            ExportEditorState();
        }

        private static void OnUndoRedoPerformed()
        {
            ScheduleAutomaticStateExport();
        }

        private static void OnSceneOpened(UnityEngine.SceneManagement.Scene scene, OpenSceneMode mode)
        {
            ScheduleAutomaticStateExport();
        }

        private static void OnSceneSaved(UnityEngine.SceneManagement.Scene scene)
        {
            ScheduleAutomaticStateExport();
        }

        private static void OnImportCompleted(string packageName)
        {
            ExportImportStatus(true, null);
        }

        private static void OnImportFailed(string packageName, string errorMessage)
        {
            ExportImportStatus(false, errorMessage);
        }

        private static void OnCompilationStarted(object context)
        {
            compilationMessages.Clear();
            compilationMessagesTruncated = false;
            compilationStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            ExportCompilationStatus(false);
            ExportEditorState();
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            if (messages == null)
                return;

            foreach (CompilerMessage message in messages)
            {
                if (compilationMessages.Count >= 500)
                {
                    compilationMessagesTruncated = true;
                    if (message.type != CompilerMessageType.Error)
                        continue;

                    int warningIndex = compilationMessages.FindLastIndex(
                        existing => string.Equals(existing.type, CompilerMessageType.Warning.ToString(), StringComparison.Ordinal));
                    if (warningIndex < 0)
                        continue;
                    compilationMessages.RemoveAt(warningIndex);
                }

                compilationMessages.Add(new CompilationMessageInfo
                {
                    assemblyPath = assemblyPath,
                    type = message.type.ToString(),
                    message = message.message,
                    file = message.file,
                    line = message.line,
                    column = message.column
                });
            }

            ExportCompilationStatus(false);
        }

        private static void OnCompilationFinished(object context)
        {
            ExportCompilationStatus(true);
            ExportEditorState();
        }

        private static void OnLogMessageReceived(string condition, string stackTrace, LogType type)
        {
            lock (logLock)
            {
                var entry = new ConsoleLogEntry
                {
                    level = type.ToString(),
                    message = condition,
                    stackTrace = stackTrace,
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };

                capturedLogs.Add(entry);

                // Keep only the last MaxLogEntries
                while (capturedLogs.Count > MaxLogEntries)
                {
                    capturedLogs.RemoveAt(0);
                }

                consoleExportPending = true;
            }
        }

        #region Menu Items

        [MenuItem("Creator Works MCP/Show Status Window")]
        private static void ShowStatusWindow()
        {
            BantworksMCPWindow.ShowWindow();
        }

        [MenuItem("Creator Works MCP/Refresh State")]
        private static void RefreshState()
        {
            ExportProjectState();
            LastActivity = DateTime.Now.ToString("HH:mm:ss") + " - Manual refresh";
            Debug.Log("[Creator Works MCP] State refreshed manually");
        }

        [MenuItem(BackgroundStateExportMenuItem)]
        private static void ToggleBackgroundStateExportInPlayMode()
        {
            bool enabled = !BackgroundStateExportInPlayMode;
            BackgroundStateExportInPlayMode = enabled;
            UnityEditor.Menu.SetChecked(BackgroundStateExportMenuItem, enabled);
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                if (enabled)
                {
                    lastPeriodicPlayModeStateExport = EditorApplication.timeSinceStartup;
                    ScheduleAutomaticStateExport(0);
                }
                else
                {
                    automaticStateExportPending = false;
                }
            }
            LastActivity = DateTime.Now.ToString("HH:mm:ss") +
                (enabled ? " - Play-mode background export enabled" : " - Play-mode background export disabled");
            Debug.Log($"[Creator Works MCP] Play-mode background state export {(enabled ? "enabled" : "disabled")}");
        }

        [MenuItem(BackgroundStateExportMenuItem, true)]
        private static bool ValidateBackgroundStateExportInPlayMode()
        {
            UnityEditor.Menu.SetChecked(BackgroundStateExportMenuItem, BackgroundStateExportInPlayMode);
            return true;
        }

        [MenuItem(BackgroundEditModeStateExportMenuItem)]
        private static void ToggleBackgroundStateExportInEditMode()
        {
            bool enabled = !BackgroundStateExportInEditMode;
            BackgroundStateExportInEditMode = enabled;
            UnityEditor.Menu.SetChecked(BackgroundEditModeStateExportMenuItem, enabled);
            if (!EditorApplication.isPlayingOrWillChangePlaymode)
            {
                if (enabled)
                    ScheduleAutomaticStateExport(0);
                else
                    automaticStateExportPending = false;
            }

            LastActivity = DateTime.Now.ToString("HH:mm:ss") +
                (enabled ? " - Edit-mode background export enabled" : " - Edit-mode background export disabled");
            Debug.Log($"[Creator Works MCP] Edit-mode background state export {(enabled ? "enabled" : "disabled")}");
        }

        [MenuItem(BackgroundEditModeStateExportMenuItem, true)]
        private static bool ValidateBackgroundStateExportInEditMode()
        {
            UnityEditor.Menu.SetChecked(BackgroundEditModeStateExportMenuItem, BackgroundStateExportInEditMode);
            return true;
        }

        [MenuItem("Creator Works MCP/Open MCP Folder")]
        private static void OpenMCPFolder()
        {
            EditorUtility.RevealInFinder(MCPFolder);
        }

        [MenuItem("Creator Works MCP/Clear Commands")]
        private static void ClearCommands()
        {
            if (Directory.Exists(CommandsFolder))
            {
                foreach (var file in Directory.GetFiles(CommandsFolder, "*.json"))
                {
                    File.Delete(file);
                }
            }
            Debug.Log("[Creator Works MCP] Commands folder cleared");
        }

        [MenuItem("Creator Works MCP/Scan Prefabs")]
        private static void ScanPrefabsMenuItem()
        {
            if (IsScanningPrefabs)
            {
                Debug.LogWarning("[Creator Works MCP] Prefab scan already in progress");
                return;
            }
            ScanAndExportPrefabCatalog();
        }

        #endregion

        #region Command Processing

        private static string BuildPipeName()
        {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
            {
                return "bantworks-unity-" + process.Id + "-" +
                    process.StartTime.ToUniversalTime().Ticks.ToString("x16", CultureInfo.InvariantCulture);
            }
        }

        private static void StartPipeServer()
        {
            if (Application.platform != RuntimePlatform.WindowsEditor)
                return;

            pipeServerShutdownRequested = false;
            pipeServerThread = new Thread(PipeServerLoop)
            {
                IsBackground = true,
                Name = "Creator Works MCP Named Pipe"
            };
            pipeServerThread.Start();
        }

        private static void ShutdownPipeServer()
        {
            pipeServerShutdownRequested = true;
            pipeServerAvailable = false;

            NamedPipeServerStream serverToDispose;
            lock (PipeServerLock)
            {
                serverToDispose = activePipeServer;
                activePipeServer = null;
            }

            if (serverToDispose != null)
            {
                try
                {
                    if (!serverToDispose.IsConnected)
                    {
                        using (var wakeClient = new NamedPipeClientStream(
                            ".",
                            PipeName,
                            PipeDirection.Out,
                            PipeOptions.None))
                        {
                            wakeClient.Connect(250);
                        }
                    }
                }
                catch
                {
                }

                try
                {
                    serverToDispose.Dispose();
                }
                catch
                {
                }
            }

            PendingPipeCommand pending;
            while (PendingPipeCommands.TryDequeue(out pending))
            {
                pending.responseJson = JsonUtility.ToJson(CreateCommandResult(
                    pending.commandId,
                    false,
                    null,
                    "Unity is reloading or shutting down."));
                pending.completed.Set();
            }

            if (pipeServerThread != null && pipeServerThread.IsAlive)
                pipeServerThread.Join(2000);
            pipeServerThread = null;
        }

        private static void PipeServerLoop()
        {
            while (!pipeServerShutdownRequested)
            {
                NamedPipeServerStream server = null;
                try
                {
                    server = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.InOut,
                        4,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None);

                    lock (PipeServerLock)
                    {
                        activePipeServer = server;
                    }
                    pipeServerAvailable = true;
                    server.WaitForConnection();
                    if (pipeServerShutdownRequested)
                        break;

                    string requestJson;
                    using (var reader = new StreamReader(
                        server,
                        new UTF8Encoding(false),
                        false,
                        4096,
                        true))
                    {
                        requestJson = ReadBoundedPipeLine(reader);
                    }

                    string commandId = ExtractCommandId(requestJson);
                    var pending = new PendingPipeCommand
                    {
                        commandId = commandId,
                        requestJson = requestJson,
                        completed = new ManualResetEventSlim(false)
                    };
                    PendingPipeCommands.Enqueue(pending);

                    if (!pending.completed.Wait(TimeSpan.FromMinutes(2)))
                    {
                        pending.timedOut = true;
                        pending.responseJson = BuildPipeErrorJson(
                            commandId,
                            "Unity did not process the command before the bridge timeout.");
                    }

                    using (var writer = new StreamWriter(
                        server,
                        new UTF8Encoding(false),
                        4096,
                        true))
                    {
                        writer.WriteLine(pending.responseJson);
                        writer.Flush();
                    }
                    if (!pending.timedOut)
                        pending.completed.Dispose();
                }
                catch (ObjectDisposedException)
                {
                    if (!pipeServerShutdownRequested)
                        System.Console.WriteLine("[Creator Works MCP] Named pipe was disposed unexpectedly.");
                }
                catch (PlatformNotSupportedException e)
                {
                    System.Console.WriteLine("[Creator Works MCP] Named pipe transport is unavailable: " + e.Message);
                    pipeServerShutdownRequested = true;
                }
                catch (Exception e)
                {
                    if (!pipeServerShutdownRequested)
                        System.Console.WriteLine("[Creator Works MCP] Named pipe error: " + e.Message);
                }
                finally
                {
                    pipeServerAvailable = false;
                    lock (PipeServerLock)
                    {
                        if (ReferenceEquals(activePipeServer, server))
                            activePipeServer = null;
                    }
                    if (server != null)
                        server.Dispose();
                }
            }
        }

        private static string ReadBoundedPipeLine(StreamReader reader)
        {
            var builder = new StringBuilder();
            while (true)
            {
                int value = reader.Read();
                if (value < 0 || value == '\n')
                    break;
                if (value == '\r')
                    continue;
                if (builder.Length >= MaximumPipeCommandCharacters)
                    throw new InvalidDataException("Named-pipe command exceeds the 4 MiB character limit.");
                builder.Append((char)value);
            }

            if (builder.Length == 0)
                throw new InvalidDataException("Named-pipe command was empty.");
            return builder.ToString();
        }

        private static string ExtractCommandId(string json)
        {
            if (string.IsNullOrEmpty(json))
                return null;

            const string marker = "\"id\"";
            int markerIndex = json.IndexOf(marker, StringComparison.Ordinal);
            if (markerIndex < 0)
                return null;
            int colonIndex = json.IndexOf(':', markerIndex + marker.Length);
            int openingQuote = colonIndex >= 0 ? json.IndexOf('"', colonIndex + 1) : -1;
            int closingQuote = openingQuote >= 0 ? json.IndexOf('"', openingQuote + 1) : -1;
            if (openingQuote < 0 || closingQuote <= openingQuote + 1)
                return null;

            string value = json.Substring(openingQuote + 1, closingQuote - openingQuote - 1);
            if (value.Length > 128 || value.Any(c => !char.IsLetterOrDigit(c) && c != '-'))
                return null;
            return value;
        }

        private static string BuildPipeErrorJson(string commandId, string error)
        {
            string id = string.IsNullOrEmpty(commandId) ? "" : commandId;
            string escapedError = (error ?? "Unknown bridge error")
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"");
            return "{\"commandId\":\"" + id + "\",\"success\":false,\"error\":\"" +
                escapedError + "\",\"timestamp\":" +
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static void ProcessPendingPipeCommands()
        {
            PendingPipeCommand pending;
            while (PendingPipeCommands.TryDequeue(out pending))
            {
                CommandResult result = ExecuteCommandJson(pending.requestJson);
                pending.responseJson = JsonUtility.ToJson(result);
                WriteCommandResult(result);
                pending.completed.Set();
            }
        }

        private static void ProcessCommands()
        {
            if (!Directory.Exists(CommandsFolder))
                return;

            string[] commandFiles = Directory.GetFiles(CommandsFolder, "*.json");

            foreach (string file in commandFiles)
            {
                MCPCommand command = null;
                try
                {
                    string json = File.ReadAllText(file);
                    command = JsonUtility.FromJson<MCPCommand>(json);
                    CommandResult result = ExecuteCommandJson(json, command);
                    WriteCommandResult(result);
                    if (result.success)
                        File.Delete(file);
                    else
                        ArchiveFailedCommand(file);
                }
                catch (Exception e)
                {
                    Debug.LogError($"[Creator Works MCP] Error processing command {file}: {e.Message}");
                    WriteCommandResult(command?.id, false, null, e.Message);
                    ArchiveFailedCommand(file);
                }
            }
        }

        private static CommandResult ExecuteCommandJson(string json, MCPCommand command = null)
        {
            try
            {
                if (command == null)
                    command = JsonUtility.FromJson<MCPCommand>(json);
                string message = ProcessCommandJson(json, command);
                CommandsProcessed++;
                LastActivity = DateTime.Now.ToString("HH:mm:ss") + " - Command processed";
                return CreateCommandResult(command != null ? command.id : null, true, message, null);
            }
            catch (Exception e)
            {
                Debug.LogError("[Creator Works MCP] Command failed: " + e.Message);
                return CreateCommandResult(command != null ? command.id : ExtractCommandId(json), false, null, e.Message);
            }
        }

        private static string ProcessCommandJson(string json, MCPCommand baseCommand)
        {
            if (baseCommand == null || string.IsNullOrWhiteSpace(baseCommand.type))
                throw new InvalidOperationException("Command is missing a type");
            if (baseCommand.protocolVersion != 0 && baseCommand.protocolVersion != BridgeProtocolVersion)
                throw new InvalidOperationException(
                    "Unsupported bridge protocol version " + baseCommand.protocolVersion +
                    "; expected " + BridgeProtocolVersion + ".");
            ValidateCommandTarget(baseCommand);

            switch (baseCommand.type)
            {
                case "refresh":
                    AssetDatabase.Refresh();
                    ExportImportStatus(true, null);
                    return "Unity assets refreshed";

                case "export-state":
                    ExportProjectState();
                    return "Project state exported";

                case "query_hierarchy":
                    var hierarchyQueryCmd = JsonUtility.FromJson<HierarchyQueryCommand>(json);
                    QueryHierarchy(hierarchyQueryCmd);
                    return "Queried live Unity hierarchy";

                case "control_play_mode":
                    var playModeCmd = JsonUtility.FromJson<PlayModeCommand>(json);
                    ControlPlayMode(playModeCmd);
                    return $"Play Mode action requested: {playModeCmd.action}";

                case "capture_screenshot":
                    var screenshotCmd = JsonUtility.FromJson<ScreenshotCommand>(json);
                    CaptureScreenshot(screenshotCmd);
                    return $"Captured {screenshotCmd.source} screenshot";

                case "search_assets":
                    var assetSearchCmd = JsonUtility.FromJson<AssetSearchCommand>(json);
                    SearchAssets(assetSearchCmd);
                    return $"Searched Unity assets: {assetSearchCmd.query}";

                case "shader_graph_capabilities":
                    var shaderCapabilitiesCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(shaderCapabilitiesCmd, ShaderGraphOperation.Capabilities);
                    return "Read Shader Graph capabilities";

                case "list_shader_graphs":
                    var listShaderGraphsCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(listShaderGraphsCmd, ShaderGraphOperation.List);
                    return "Listed Shader Graph assets";

                case "inspect_shader_graph":
                    var inspectShaderGraphCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(inspectShaderGraphCmd, ShaderGraphOperation.Inspect);
                    return $"Inspected Shader Graph: {inspectShaderGraphCmd.assetPath}";

                case "create_shader_graph":
                    var createShaderGraphCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(createShaderGraphCmd, ShaderGraphOperation.Create);
                    return $"Created Shader Graph: {createShaderGraphCmd.assetPath}";

                case "add_shader_graph_node":
                    var addShaderGraphNodeCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(addShaderGraphNodeCmd, ShaderGraphOperation.AddNode);
                    return $"Added Shader Graph node: {addShaderGraphNodeCmd.nodeType}";

                case "connect_shader_graph_nodes":
                    var connectShaderGraphNodesCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(connectShaderGraphNodesCmd, ShaderGraphOperation.Connect);
                    return $"Connected Shader Graph nodes in: {connectShaderGraphNodesCmd.assetPath}";

                case "validate_shader_graph":
                    var validateShaderGraphCmd = JsonUtility.FromJson<ShaderGraphCommand>(json);
                    ExecuteShaderGraphCommand(validateShaderGraphCmd, ShaderGraphOperation.Validate);
                    return $"Validated Shader Graph: {validateShaderGraphCmd.assetPath}";

                case "validate_vs_graph_asset":
                    var validateGraphCmd = JsonUtility.FromJson<ValidateVSGraphAssetCommand>(json);
                    ValidateVisualScriptingGraphAsset(validateGraphCmd);
                    return $"Validated Visual Scripting graph asset: {validateGraphCmd.assetPath}";

                case "validate_banter_visual_scripting":
                    var validateBanterCmd = JsonUtility.FromJson<ValidateBanterVisualScriptingCommand>(json);
                    ValidateBanterVisualScripting(validateBanterCmd);
                    return "Ran SideQuest SDK Visual Scripting validation";

                case "run_tests":
                    var runTestsCmd = JsonUtility.FromJson<RunTestsCommand>(json);
                    RunUnityTests(runTestsCmd);
                    return $"Started Unity {runTestsCmd.mode} tests";

                case "discover_tests":
                    var discoverTestsCmd = JsonUtility.FromJson<DiscoverTestsCommand>(json);
                    DiscoverUnityTests(discoverTestsCmd);
                    return $"Started Unity {discoverTestsCmd.mode} test discovery";

                case "cancel_tests":
                    var cancelTestsCmd = JsonUtility.FromJson<CancelTestsCommand>(json);
                    CancelUnityTests(cancelTestsCmd);
                    return $"Requested cancellation for Unity test run: {cancelTestsCmd.runId}";

                case "get_scenes":
                    var getScenesCmd = JsonUtility.FromJson<GetScenesCommand>(json);
                    ExportSceneManagementResult(getScenesCmd.id, "Read Unity scene state");
                    return "Read Unity scene state";

                case "save_scene":
                    var saveSceneCmd = JsonUtility.FromJson<SaveSceneCommand>(json);
                    SaveUnityScene(saveSceneCmd);
                    return "Saved Unity scene";

                case "open_scene":
                    var openSceneCmd = JsonUtility.FromJson<OpenSceneCommand>(json);
                    OpenUnityScene(openSceneCmd);
                    return $"Opened Unity scene: {openSceneCmd.scenePath}";

                case "set_build_scenes":
                    var setBuildScenesCmd = JsonUtility.FromJson<SetBuildScenesCommand>(json);
                    SetUnityBuildScenes(setBuildScenesCmd);
                    return "Updated Unity build scenes";

                case "execute_editor_menu_item":
                    var executeMenuCmd = JsonUtility.FromJson<ExecuteEditorMenuItemCommand>(json);
                    ExecuteEditorMenuItem(executeMenuCmd);
                    return $"Executed Unity Editor menu item: {executeMenuCmd.menuPath}";

                case "create_gameobject":
                    var createCmd = JsonUtility.FromJson<CreateGameObjectCommand>(json);
                    CreateGameObject(createCmd);
                    return $"Created GameObject: {createCmd.name}";

                case "delete_gameobject":
                    var deleteCmd = JsonUtility.FromJson<DeleteGameObjectCommand>(json);
                    DeleteGameObject(deleteCmd);
                    return $"Deleted GameObject: {deleteCmd.objectPath}";

                case "modify_gameobject":
                    var modifyCmd = JsonUtility.FromJson<ModifyGameObjectCommand>(json);
                    ModifyGameObject(modifyCmd);
                    return $"Modified GameObject: {modifyCmd.objectPath}";

                case "add_component":
                    var addCompCmd = JsonUtility.FromJson<AddComponentCommand>(json);
                    AddComponentToObject(addCompCmd);
                    return $"Added component: {addCompCmd.componentType}";

                case "remove_component":
                    var removeCompCmd = JsonUtility.FromJson<RemoveComponentCommand>(json);
                    RemoveComponentFromObject(removeCompCmd);
                    return $"Removed component: {removeCompCmd.componentType}";

                case "set_component_property":
                    var setPropCmd = JsonUtility.FromJson<SetComponentPropertyCommand>(json);
                    SetComponentProperty(setPropCmd);
                    return $"Set component property: {setPropCmd.componentType}.{setPropCmd.propertyName}";

                case "set_object_reference":
                    var setRefCmd = JsonUtility.FromJson<SetObjectReferenceCommand>(json);
                    SetObjectReference(setRefCmd);
                    return $"Set object reference: {setRefCmd.componentType}.{setRefCmd.propertyName}";

                case "set_asset_reference":
                    var setAssetRefCmd = JsonUtility.FromJson<SetAssetReferenceCommand>(json);
                    string assignedAsset = SetAssetReference(setAssetRefCmd);
                    return $"Set asset reference: {setAssetRefCmd.componentType}.{setAssetRefCmd.propertyName} -> {assignedAsset}";

                case "batch":
                    var batchCmd = JsonUtility.FromJson<BatchCommand>(json);
                    ProcessBatchCommand(batchCmd);
                    return "Batch command completed";

                case "instantiate_prefab":
                    var prefabCmd = JsonUtility.FromJson<InstantiatePrefabCommand>(json);
                    InstantiatePrefab(prefabCmd);
                    return $"Instantiated prefab: {prefabCmd.prefabPath}";

                case "scan_prefabs":
                    ScanAndExportPrefabCatalog();
                    return "Prefab catalog scan completed";

                case "get_object_bounds":
                    var boundsCmd = JsonUtility.FromJson<GetBoundsCommand>(json);
                    GetObjectBounds(boundsCmd);
                    return $"Read bounds for: {boundsCmd.objectPath}";

                default:
                    throw new InvalidOperationException($"Unknown command type: {baseCommand.type}");
            }
        }

        private static void ArchiveFailedCommand(string sourcePath)
        {
            try
            {
                if (!File.Exists(sourcePath))
                    return;

                string targetPath = Path.Combine(FailedCommandsFolder, Path.GetFileName(sourcePath));
                if (File.Exists(targetPath))
                    targetPath = Path.Combine(FailedCommandsFolder, $"{Path.GetFileNameWithoutExtension(sourcePath)}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.json");

                File.Move(sourcePath, targetPath);
            }
            catch (Exception e)
            {
                Debug.LogError($"[Creator Works MCP] Could not archive failed command {sourcePath}: {e.Message}");
            }
        }

        private static void WriteCommandResult(string commandId, bool success, string message, string error)
        {
            WriteCommandResult(CreateCommandResult(commandId, success, message, error));
        }

        private static CommandResult CreateCommandResult(string commandId, bool success, string message, string error)
        {
            return new CommandResult
            {
                commandId = commandId,
                success = success,
                message = message,
                error = error,
                projectPath = ProjectRoot,
                editorInstanceId = GetEditorInstanceId(),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }


        private static void ValidateCommandTarget(MCPCommand command)
        {
            if (!string.IsNullOrWhiteSpace(command.expectedProjectPath))
            {
                string expected = Path.GetFullPath(command.expectedProjectPath)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string actual = Path.GetFullPath(ProjectRoot)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException(
                        $"Command target mismatch: expected project '{expected}', bridge project is '{actual}'.");
            }

            if (!string.IsNullOrWhiteSpace(command.expectedEditorInstanceId))
            {
                string actualInstanceId = GetEditorInstanceId();
                if (!string.Equals(command.expectedEditorInstanceId, actualInstanceId, StringComparison.Ordinal))
                    throw new InvalidOperationException(
                        $"Command target mismatch: expected editor instance '{command.expectedEditorInstanceId}', current instance is '{actualInstanceId}'.");
            }
        }

        private static void WriteCommandResult(CommandResult result)
        {
            if (result == null || string.IsNullOrWhiteSpace(result.commandId))
                return;

            try
            {
                WriteAtomicText(
                    Path.Combine(CommandResultsFolder, $"{result.commandId}.json"),
                    JsonUtility.ToJson(result, true));
                DeleteOldFiles(CommandResultsFolder, "*.json", 200);
            }
            catch (Exception e)
            {
                System.Console.WriteLine($"[Creator Works MCP] Could not write command result: {e.Message}");
            }
        }

        private static void CreateGameObject(CreateGameObjectCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.name))
                throw new InvalidOperationException("Create GameObject command requires a name");

            GameObject parent = ResolveOptionalGameObject(cmd.parentId, cmd.parentPath);
            GameObject obj = null;

            // Create based on primitive type
            if (string.IsNullOrEmpty(cmd.primitiveType))
            {
                obj = new GameObject(cmd.name);
            }
            else
            {
                PrimitiveType primType;
                if (Enum.TryParse(cmd.primitiveType, true, out primType))
                {
                    obj = GameObject.CreatePrimitive(primType);
                    obj.name = cmd.name;
                }
                else
                {
                    throw new InvalidOperationException($"Unknown primitive type: {cmd.primitiveType}");
                }
            }

            // Set transform
            if (cmd.position != null && cmd.position.Length == 3)
            {
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);
            }

            if (cmd.rotation != null && cmd.rotation.Length == 3)
            {
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);
            }

            if (cmd.scale != null && cmd.scale.Length == 3)
            {
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);
            }

            // Set parent if specified
            if (parent != null)
            {
                obj.transform.SetParent(parent.transform, true);
            }

            // Mark scene dirty
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());

            // Select the new object
            Selection.activeGameObject = obj;

            Debug.Log($"[Creator Works MCP] Created GameObject: {cmd.name}");
            ExportSceneHierarchy();
        }

        private static void DeleteGameObject(DeleteGameObjectCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            Undo.DestroyObjectImmediate(obj);
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Deleted GameObject: {DescribeObject(cmd.objectId, cmd.objectPath)}");
            ExportSceneHierarchy();
        }

        private static void ControlPlayMode(PlayModeCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.action))
                throw new InvalidOperationException("Play Mode command requires an action");
            if (EditorApplication.isCompiling)
                throw new InvalidOperationException("Unity is compiling. Wait for compilation to finish before changing Play Mode.");

            switch (cmd.action.Trim().ToLowerInvariant())
            {
                case "play":
                    if (EditorApplication.isPlaying)
                        EditorApplication.isPaused = false;
                    else if (!EditorApplication.isPlayingOrWillChangePlaymode)
                        EditorApplication.isPlaying = true;
                    break;
                case "pause":
                    if (!EditorApplication.isPlaying)
                        throw new InvalidOperationException("Unity must be in Play Mode before it can be paused");
                    EditorApplication.isPaused = true;
                    break;
                case "resume":
                    if (!EditorApplication.isPlaying)
                        throw new InvalidOperationException("Unity must be in Play Mode before it can be resumed");
                    EditorApplication.isPaused = false;
                    break;
                case "stop":
                    if (EditorApplication.isPlayingOrWillChangePlaymode)
                        EditorApplication.isPlaying = false;
                    break;
                default:
                    throw new InvalidOperationException($"Unknown Play Mode action: {cmd.action}");
            }

            ExportEditorState();
        }

        private static void CaptureScreenshot(ScreenshotCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.id))
                throw new InvalidOperationException("Screenshot command requires an ID");

            string source = string.IsNullOrWhiteSpace(cmd.source)
                ? "game"
                : cmd.source.Trim().ToLowerInvariant();
            int width = cmd.width == 0 ? 1280 : cmd.width;
            int height = cmd.height == 0 ? 720 : cmd.height;
            if (width < 64 || width > 2048 || height < 64 || height > 2048)
                throw new InvalidOperationException("Screenshot width and height must be between 64 and 2048 pixels");

            Camera camera;
            string cameraSelection;
            int cameraCandidateCount;
            bool cameraSelectionAmbiguous;
            string sceneViewName = null;
            switch (source)
            {
                case "game":
                {
                    camera = ResolveScreenshotCamera(cmd.cameraId, cmd.cameraPath);
                    var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                    Camera[] candidates = Resources.FindObjectsOfTypeAll<Camera>()
                        .Where(candidate => candidate.gameObject.scene == activeScene && candidate.enabled)
                        .ToArray();
                    cameraCandidateCount = candidates.Length;
                    cameraSelection = !string.IsNullOrWhiteSpace(cmd.cameraId)
                        ? "explicit-id"
                        : !string.IsNullOrWhiteSpace(cmd.cameraPath)
                            ? "explicit-path"
                            : Camera.main == camera ? "main-camera" : "first-enabled-camera";
                    cameraSelectionAmbiguous = string.IsNullOrWhiteSpace(cmd.cameraId) &&
                        string.IsNullOrWhiteSpace(cmd.cameraPath) && candidates.Length > 1;
                    break;
                }
                case "scene":
                {
                    SceneView[] sceneViews = SceneView.sceneViews.OfType<SceneView>().ToArray();
                    var sceneView = SceneView.lastActiveSceneView ?? sceneViews.FirstOrDefault();
                    camera = sceneView?.camera;
                    if (camera == null)
                        throw new InvalidOperationException("No Scene View camera is available. Open a Scene View and try again.");
                    cameraCandidateCount = sceneViews.Length;
                    cameraSelection = SceneView.lastActiveSceneView != null ? "last-active-scene-view" : "first-scene-view";
                    cameraSelectionAmbiguous = sceneViews.Length > 1 && SceneView.lastActiveSceneView == null;
                    sceneViewName = sceneView.titleContent != null ? sceneView.titleContent.text : null;
                    break;
                }
                default:
                    throw new InvalidOperationException($"Unknown screenshot source: {cmd.source}");
            }
            string outputPath = Path.Combine(ScreenshotResultsFolder, cmd.id + ".png");
            RenderTexture renderTexture = null;
            Texture2D texture = null;
            RenderTexture previousActive = RenderTexture.active;
            RenderTexture previousTarget = camera.targetTexture;

            try
            {
                renderTexture = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
                camera.targetTexture = renderTexture;
                camera.Render();

                RenderTexture.active = renderTexture;
                texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply(false, false);

                byte[] png = texture.EncodeToPNG();
                if (png == null || png.Length == 0)
                    throw new InvalidOperationException("Unity returned an empty screenshot");

                WriteAtomicBytes(outputPath, png);
                var screenshotResult = new ScreenshotResult
                {
                    commandId = cmd.id,
                    success = true,
                    source = source,
                    width = width,
                    height = height,
                    byteLength = png.Length,
                    cameraId = source == "game" ? GetStableObjectId(camera) : null,
                    cameraPath = source == "game" ? GetGameObjectPath(camera.gameObject) : null,
                    cameraName = camera.name,
                    cameraSelection = cameraSelection,
                    cameraCandidateCount = cameraCandidateCount,
                    cameraSelectionAmbiguous = cameraSelectionAmbiguous,
                    sceneViewName = sceneViewName,
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                WriteAtomicText(
                    Path.Combine(ScreenshotResultsFolder, cmd.id + ".json"),
                    JsonUtility.ToJson(screenshotResult, true));
                DeleteOldFiles(ScreenshotResultsFolder, "*.png", 20);
                DeleteOldFiles(ScreenshotResultsFolder, "*.json", 20);

                Debug.Log($"[Creator Works MCP] Captured {source} screenshot {width}x{height} using {camera.name}");
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                if (renderTexture != null)
                    RenderTexture.ReleaseTemporary(renderTexture);
                if (texture != null)
                    UnityEngine.Object.DestroyImmediate(texture);
            }
        }

        private static Camera ResolveScreenshotCamera(string cameraId, string cameraPath)
        {
            if (!string.IsNullOrWhiteSpace(cameraId))
            {
                GlobalObjectId globalObjectId;
                if (!GlobalObjectId.TryParse(cameraId, out globalObjectId))
                    throw new InvalidOperationException($"Invalid camera GlobalObjectId: {cameraId}");

                var cameraById = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalObjectId) as Camera;
                var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                if (cameraById == null || cameraById.gameObject.scene != activeScene)
                    throw new InvalidOperationException($"Camera ID is stale or not in the active scene: {cameraId}");
                return cameraById;
            }

            if (!string.IsNullOrWhiteSpace(cameraPath))
            {
                var owner = ResolveGameObject(null, cameraPath);
                return ResolveComponent(owner, null, "Camera") as Camera;
            }

            if (Camera.main != null)
                return Camera.main;

            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var camera = Resources.FindObjectsOfTypeAll<Camera>()
                .FirstOrDefault(candidate => candidate.gameObject.scene == scene && candidate.enabled);
            if (camera == null)
                throw new InvalidOperationException("No enabled Camera exists in the active scene");
            return camera;
        }

        private static void SearchAssets(AssetSearchCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.id))
                throw new InvalidOperationException("Asset search command requires an ID");
            if (string.IsNullOrWhiteSpace(cmd.query))
                throw new InvalidOperationException("Asset search requires a non-empty query");

            int limit = cmd.limit == 0 ? 100 : cmd.limit;
            if (limit < 1 || limit > 500)
                throw new InvalidOperationException("Asset search limit must be between 1 and 500");

            string[] searchFolders = null;
            if (cmd.folders != null && cmd.folders.Length > 0)
            {
                searchFolders = cmd.folders
                    .Select(folder => (folder ?? "").Replace('\\', '/').TrimEnd('/'))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();

                foreach (string folder in searchFolders)
                {
                    bool allowedRoot = folder == "Assets" || folder.StartsWith("Assets/", StringComparison.Ordinal) ||
                        (cmd.includePackages && (folder == "Packages" || folder.StartsWith("Packages/", StringComparison.Ordinal)));
                    if (!allowedRoot || !AssetDatabase.IsValidFolder(folder))
                        throw new InvalidOperationException($"Invalid or disallowed asset search folder: {folder}");
                }
            }
            else if (!cmd.includePackages)
            {
                searchFolders = new[] { "Assets" };
            }

            string[] guids = searchFolders == null
                ? AssetDatabase.FindAssets(cmd.query)
                : AssetDatabase.FindAssets(cmd.query, searchFolders);

            var paths = guids
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(assetPath => !string.IsNullOrWhiteSpace(assetPath))
                .Where(assetPath => cmd.includePackages || !assetPath.StartsWith("Packages/", StringComparison.Ordinal))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(assetPath => assetPath, StringComparer.Ordinal)
                .ToList();

            var result = new AssetSearchResult
            {
                commandId = cmd.id,
                success = true,
                query = cmd.query,
                totalMatches = paths.Count,
                truncated = paths.Count > limit,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                assets = paths.Take(limit).Select(assetPath => new AssetSearchEntry
                {
                    guid = AssetDatabase.AssetPathToGUID(assetPath),
                    path = assetPath,
                    name = Path.GetFileNameWithoutExtension(assetPath),
                    type = AssetDatabase.GetMainAssetTypeAtPath(assetPath)?.FullName,
                    isFolder = AssetDatabase.IsValidFolder(assetPath)
                }).ToList()
            };

            WriteAtomicText(
                Path.Combine(AssetSearchResultsFolder, cmd.id + ".json"),
                JsonUtility.ToJson(result, true));
            DeleteOldFiles(AssetSearchResultsFolder, "*.json", 50);
        }

        private static void ValidateVisualScriptingGraphAsset(ValidateVSGraphAssetCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Visual Scripting validation requires a safe correlation ID");

            var result = new VSGraphAssetValidationResult
            {
                commandId = cmd.id,
                success = false,
                assetPath = cmd.assetPath,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                elementTypes = new List<string>(),
                warnings = new List<string>(),
                allowUnboundValueInputs = cmd.allowUnboundValueInputs,
                unboundValueInputs = new List<VSValueInputDiagnostic>()
            };

            try
            {
                if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                    throw new InvalidOperationException("Unity is compiling or importing assets. Wait for the Editor to settle.");

                string assetPath = NormalizeVisualScriptingAssetPath(cmd.assetPath);
                string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
                if (!File.Exists(fullPath))
                    throw new FileNotFoundException("Visual Scripting graph asset does not exist", assetPath);

                AssetDatabase.ImportAsset(
                    assetPath,
                    ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

                UnityEngine.Object asset = AssetDatabase.LoadMainAssetAtPath(assetPath);
                if (asset == null)
                    throw new InvalidOperationException("Unity could not load the graph's main asset after import. Check the Console for deserialization errors.");

                Type assetType = asset.GetType();
                result.assetPath = assetPath;
                result.assetGuid = AssetDatabase.AssetPathToGUID(assetPath);
                result.assetType = assetType.FullName;
                result.dependencyHash = AssetDatabase.GetAssetDependencyHash(assetPath).ToString();

                if (!string.Equals(assetType.FullName, "Unity.VisualScripting.ScriptGraphAsset", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Expected Unity.VisualScripting.ScriptGraphAsset but Unity loaded {assetType.FullName}");
                }

                const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                System.Reflection.PropertyInfo graphProperty = assetType.GetProperty("graph", flags);
                FieldInfo graphField = graphProperty == null ? assetType.GetField("graph", flags) : null;
                object graph = graphProperty != null ? graphProperty.GetValue(asset) : graphField?.GetValue(asset);
                if (graph == null)
                    throw new InvalidOperationException("Unity loaded the ScriptGraphAsset but its graph is null");

                Type graphType = graph.GetType();
                result.graphType = graphType.FullName;
                System.Reflection.PropertyInfo elementsProperty = graphType.GetProperty("elements", flags);
                FieldInfo elementsField = elementsProperty == null ? graphType.GetField("elements", flags) : null;
                object elementsValue = elementsProperty != null
                    ? elementsProperty.GetValue(graph)
                    : elementsField?.GetValue(graph);
                var elements = elementsValue as System.Collections.IEnumerable;
                if (elements == null)
                    throw new InvalidOperationException("Unity loaded the graph but did not expose an elements collection");

                var elementTypes = new HashSet<string>(StringComparer.Ordinal);
                foreach (object element in elements)
                {
                    result.elementCount++;
                    if (element == null)
                    {
                        result.missingElementCount++;
                        continue;
                    }

                    string typeName = element.GetType().FullName ?? element.GetType().Name;
                    elementTypes.Add(typeName);
                    if (typeName == "Unity.VisualScripting.ControlConnection")
                        result.controlConnectionCount++;
                    else if (typeName == "Unity.VisualScripting.ValueConnection")
                        result.valueConnectionCount++;
                    else if (typeName == "Unity.VisualScripting.GraphGroup")
                        result.groupCount++;
                    else
                        result.nodeCount++;

                    InspectValueInputs(element, result);

                    if (typeName.IndexOf("Missing", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        typeName.IndexOf("Unknown", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        result.missingElementCount++;
                    }
                }

                result.elementTypes = elementTypes.OrderBy(name => name, StringComparer.Ordinal).Take(200).ToList();
                if (result.missingElementCount > 0)
                    result.warnings.Add($"Unity exposed {result.missingElementCount} missing or unknown graph elements");

                if (result.unboundValueInputCount > 0)
                {
                    result.warnings.Add(
                        $"Unity exposed {result.unboundValueInputCount} value inputs with no valid connection or persisted default. " +
                        "These inputs can throw MissingValuePortInputException when evaluated.");
                }

                result.success = result.missingElementCount == 0 &&
                    result.failedUnitDefinitionCount == 0 &&
                    result.valuePortInspectionErrorCount == 0 &&
                    (cmd.allowUnboundValueInputs || result.unboundValueInputCount == 0);
                if (!result.success)
                {
                    if (result.missingElementCount > 0)
                        result.error = "The graph imported, but one or more elements could not be resolved";
                    else if (result.failedUnitDefinitionCount > 0)
                        result.error = "The graph imported, but one or more units failed to define their ports";
                    else if (result.valuePortInspectionErrorCount > 0)
                        result.error = "The graph imported, but required value-port inspection did not complete";
                    else
                        result.error = "The graph imported, but one or more value inputs have no valid connection or persisted default";
                }
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                result.error = actual.Message;
            }

            WriteAtomicText(
                Path.Combine(VisualScriptingValidationResultsFolder, cmd.id + ".json"),
                JsonUtility.ToJson(result, true));
            DeleteOldFiles(VisualScriptingValidationResultsFolder, "*.json", 50);
        }

        private static void InspectValueInputs(object element, VSGraphAssetValidationResult result)
        {
            if (element == null)
                return;

            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            Type unitType = element.GetType();
            System.Reflection.PropertyInfo valueInputsProperty = unitType.GetProperty("valueInputs", flags);
            if (valueInputsProperty == null)
                return;

            result.valuePortInspectionAvailable = true;

            try
            {
                MethodInfo ensureDefined = unitType.GetMethod(
                    "EnsureDefined",
                    flags,
                    null,
                    Type.EmptyTypes,
                    null);
                ensureDefined?.Invoke(element, null);

                if (ReadBooleanProperty(element, unitType, "failedToDefine", flags))
                {
                    result.failedUnitDefinitionCount++;
                    object definitionException = ReadProperty(element, unitType, "definitionException", flags);
                    result.warnings.Add(
                        $"Unit {unitType.FullName} ({ReadProperty(element, unitType, "guid", flags)}) failed to define: " +
                        (definitionException is Exception exception ? exception.Message : "unknown definition error"));
                    return;
                }

                var valueInputs = valueInputsProperty.GetValue(element) as System.Collections.IEnumerable;
                if (valueInputs == null)
                    return;

                foreach (object input in valueInputs)
                {
                    if (input == null)
                        continue;

                    result.valueInputCount++;
                    Type inputRuntimeType = input.GetType();
                    bool hasValidConnection = ReadBooleanProperty(input, inputRuntimeType, "hasValidConnection", flags);
                    bool hasDefaultValue = ReadBooleanProperty(input, inputRuntimeType, "hasDefaultValue", flags);
                    if (hasValidConnection || hasDefaultValue)
                        continue;

                    result.unboundValueInputCount++;
                    if (result.unboundValueInputs.Count >= 200)
                    {
                        result.unboundValueInputsTruncated = true;
                        continue;
                    }

                    object expectedType = ReadProperty(input, inputRuntimeType, "type", flags);
                    result.unboundValueInputs.Add(new VSValueInputDiagnostic
                    {
                        unitType = unitType.FullName ?? unitType.Name,
                        unitGuid = Convert.ToString(ReadProperty(element, unitType, "guid", flags), CultureInfo.InvariantCulture),
                        portKey = Convert.ToString(ReadProperty(input, inputRuntimeType, "key", flags), CultureInfo.InvariantCulture),
                        expectedType = expectedType is Type type ? type.FullName : Convert.ToString(expectedType, CultureInfo.InvariantCulture),
                        hasValidConnection = false,
                        hasDefaultValue = false
                    });
                }
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                result.valuePortInspectionErrorCount++;
                result.warnings.Add($"Could not inspect value inputs on {unitType.FullName}: {actual.Message}");
            }
        }

        private static void QueryHierarchy(HierarchyQueryCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Hierarchy query requires a safe correlation ID");

            var result = new HierarchyQueryResult
            {
                commandId = cmd.id,
                queryKind = cmd.queryKind,
                objects = new List<GameObjectInfo>(),
                components = new List<ComponentQueryInfo>(),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };

            try
            {
                if (cmd.queryKind != "hierarchy" && cmd.queryKind != "components")
                    throw new InvalidOperationException("queryKind must be hierarchy or components");
                if (cmd.match != "contains" && cmd.match != "exact")
                    throw new InvalidOperationException("match must be contains or exact");
                if (cmd.maxDepth < -1 || cmd.maxDepth > 100)
                    throw new InvalidOperationException("maxDepth must be -1 or a whole number between 0 and 100");
                if (cmd.maxResults < 1 || cmd.maxResults > 5000)
                    throw new InvalidOperationException("maxResults must be between 1 and 5000");
                if (string.IsNullOrWhiteSpace(cmd.rootPath) &&
                    string.IsNullOrWhiteSpace(cmd.componentType) &&
                    string.IsNullOrWhiteSpace(cmd.filter) &&
                    (cmd.propertyNames == null || cmd.propertyNames.Length == 0))
                {
                    throw new InvalidOperationException("Live hierarchy queries require rootPath, filter, componentType, or propertyNames");
                }

                var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                if (!activeScene.IsValid() || !activeScene.isLoaded)
                    throw new InvalidOperationException("The active Unity scene is not loaded");

                result.sceneName = activeScene.name;
                result.scenePath = activeScene.path;
                var candidates = new List<HierarchyQueryCandidate>();
                if (!string.IsNullOrWhiteSpace(cmd.rootPath))
                {
                    GameObject root = FindGameObjectByPath(cmd.rootPath);
                    AddHierarchyQueryCandidate(
                        root,
                        candidates,
                        GetHierarchyDepth(root),
                        0,
                        cmd.includeDescendants,
                        cmd.maxDepth);
                }
                else
                {
                    foreach (GameObject root in activeScene.GetRootGameObjects())
                        AddHierarchyQueryCandidate(root, candidates, 0, 0, true, cmd.maxDepth);
                }

                foreach (HierarchyQueryCandidate candidate in candidates)
                {
                    bool needsComponentIdentities = cmd.queryKind == "components" ||
                        !string.IsNullOrWhiteSpace(cmd.componentType) ||
                        !string.IsNullOrWhiteSpace(cmd.filter);
                    Component[] allComponents = needsComponentIdentities
                        ? candidate.gameObject.GetComponents<Component>().Where(component => component != null).ToArray()
                        : null;
                    Component[] matchingComponents = string.IsNullOrWhiteSpace(cmd.componentType)
                        ? allComponents
                        : allComponents.Where(component =>
                            string.Equals(component.GetType().Name, cmd.componentType, StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(component.GetType().FullName, cmd.componentType, StringComparison.OrdinalIgnoreCase))
                            .ToArray();
                    if (!string.IsNullOrWhiteSpace(cmd.componentType) && matchingComponents.Length == 0)
                        continue;

                    if (cmd.queryKind == "hierarchy")
                    {
                        if (!MatchesHierarchyIdentityFilter(
                            candidate.gameObject,
                            allComponents,
                            cmd.filter,
                            cmd.match))
                            continue;

                        result.totalMatches++;
                        if (result.objects.Count < cmd.maxResults)
                        {
                            result.objects.Add(CreateGameObjectInfo(
                                candidate.gameObject,
                                candidate.depth,
                                !cmd.includeComponents ? new Component[0] :
                                    string.IsNullOrWhiteSpace(cmd.componentType) ? null : matchingComponents,
                                cmd.propertyNames,
                                cmd.includeComponentProperties));
                        }
                        continue;
                    }

                    Component[] components = string.IsNullOrWhiteSpace(cmd.componentType)
                        ? allComponents
                        : matchingComponents;
                    foreach (Component component in components)
                    {
                        if (!MatchesComponentIdentityFilter(
                            candidate.gameObject,
                            component,
                            cmd.filter,
                            cmd.match))
                            continue;

                        result.totalMatches++;
                        if (result.components.Count >= cmd.maxResults)
                            continue;

                        var serialized = SerializeComponent(component, cmd.propertyNames, cmd.includeComponentProperties);
                        var info = new ComponentQueryInfo
                        {
                            objectName = candidate.gameObject.name,
                            objectPath = GetGameObjectPath(candidate.gameObject),
                            depth = candidate.depth,
                            type = component.GetType().Name,
                            fullType = component.GetType().FullName,
                            globalObjectId = GetStableObjectId(component),
                            properties = serialized.properties,
                            missingProperties = serialized.missingProperties
                        };
                        result.components.Add(info);
                    }
                }

                result.returned = cmd.queryKind == "hierarchy" ? result.objects.Count : result.components.Count;
                result.truncated = result.totalMatches > result.returned;
                result.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                result.success = true;
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                result.success = false;
                result.error = actual.Message;
                result.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            finally
            {
                WriteAtomicText(
                    Path.Combine(HierarchyQueryResultsFolder, cmd.id + ".json"),
                    JsonUtility.ToJson(result, true));
                DeleteOldFiles(HierarchyQueryResultsFolder, "*.json", 50);
            }
        }

        private static void AddHierarchyQueryCandidate(
            GameObject gameObject,
            List<HierarchyQueryCandidate> candidates,
            int absoluteDepth,
            int relativeDepth,
            bool includeDescendants,
            int maxDepth)
        {
            if (maxDepth >= 0 && relativeDepth > maxDepth)
                return;

            candidates.Add(new HierarchyQueryCandidate
            {
                gameObject = gameObject,
                depth = absoluteDepth
            });
            if (!includeDescendants)
                return;

            foreach (Transform child in gameObject.transform)
            {
                AddHierarchyQueryCandidate(
                    child.gameObject,
                    candidates,
                    absoluteDepth + 1,
                    relativeDepth + 1,
                    true,
                    maxDepth);
            }
        }

        private static int GetHierarchyDepth(GameObject gameObject)
        {
            int depth = 0;
            Transform parent = gameObject.transform.parent;
            while (parent != null)
            {
                depth++;
                parent = parent.parent;
            }
            return depth;
        }

        private static bool MatchesHierarchyIdentityFilter(
            GameObject gameObject,
            Component[] components,
            string filter,
            string match)
        {
            if (string.IsNullOrWhiteSpace(filter))
                return true;

            return IdentityTextMatches(gameObject.name, filter, match) ||
                IdentityTextMatches(GetGameObjectPath(gameObject), filter, match) ||
                (components != null && components.Any(component =>
                    IdentityTextMatches(component.GetType().Name, filter, match) ||
                    IdentityTextMatches(component.GetType().FullName, filter, match)));
        }

        private static bool MatchesComponentIdentityFilter(
            GameObject gameObject,
            Component component,
            string filter,
            string match)
        {
            if (string.IsNullOrWhiteSpace(filter))
                return true;

            return IdentityTextMatches(gameObject.name, filter, match) ||
                IdentityTextMatches(GetGameObjectPath(gameObject), filter, match) ||
                IdentityTextMatches(component.GetType().Name, filter, match) ||
                IdentityTextMatches(component.GetType().FullName, filter, match);
        }

        private static bool IdentityTextMatches(string value, string filter, string match)
        {
            if (string.IsNullOrEmpty(value))
                return false;
            return match == "exact"
                ? string.Equals(value, filter, StringComparison.OrdinalIgnoreCase)
                : value.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static void ExecuteEditorMenuItem(ExecuteEditorMenuItemCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Editor menu execution requires a safe correlation ID");

            long startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var result = new EditorMenuExecutionResult
            {
                commandId = cmd.id,
                menuPath = cmd.menuPath,
                startedAt = startedAt,
                before = CaptureEditorOperationState(),
                diagnostics = new List<ConsoleLogEntry>()
            };
            Application.LogCallback diagnosticCapture = null;

            try
            {
                string menuPath = NormalizeCustomEditorMenuPath(cmd.menuPath);
                result.menuPath = menuPath;

                if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                    throw new InvalidOperationException("Unity is compiling or updating assets. Wait for the Editor to settle before executing a menu item.");
                if (EditorApplication.isPlayingOrWillChangePlaymode && !cmd.allowInPlayMode)
                    throw new InvalidOperationException("Unity is in or entering Play Mode. Set allowInPlayMode only when this menu command is designed for Play Mode.");

                var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                if (activeScene.IsValid() && activeScene.isDirty && !cmd.allowDirtyScene)
                    throw new InvalidOperationException("The active scene has unsaved changes. Save it first or explicitly set allowDirtyScene.");

                diagnosticCapture = (condition, stackTrace, logType) =>
                {
                    if (logType != LogType.Error && logType != LogType.Exception && logType != LogType.Assert)
                        return;
                    if (result.diagnostics.Count >= 100)
                    {
                        result.diagnosticsTruncated = true;
                        return;
                    }

                    result.diagnostics.Add(new ConsoleLogEntry
                    {
                        level = logType.ToString(),
                        message = condition,
                        stackTrace = stackTrace,
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    });
                };
                Application.logMessageReceived += diagnosticCapture;

                result.executionReturnedTrue = EditorApplication.ExecuteMenuItem(menuPath);
                if (!result.executionReturnedTrue)
                    throw new InvalidOperationException($"No enabled Unity Editor menu item was found at '{menuPath}'.");
                if (result.diagnostics.Count > 0)
                    throw new InvalidOperationException($"The menu item logged {result.diagnostics.Count} synchronous Unity errors.");

                result.executionSucceeded = true;
                result.success = true;
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                result.success = false;
                result.error = actual.Message;
            }
            finally
            {
                if (diagnosticCapture != null)
                    Application.logMessageReceived -= diagnosticCapture;

                result.after = CaptureEditorOperationState();
                result.finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                result.durationMs = Math.Max(0, result.finishedAt - result.startedAt);
                WriteAtomicText(
                    Path.Combine(EditorMenuResultsFolder, cmd.id + ".json"),
                    JsonUtility.ToJson(result, true));
                DeleteOldFiles(EditorMenuResultsFolder, "*.json", 50);
            }
        }

        private static string NormalizeCustomEditorMenuPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException("menuPath is required");

            string normalized = value.Trim().Replace('\\', '/');
            if (normalized.Length > 512 || normalized.StartsWith("/", StringComparison.Ordinal) ||
                normalized.EndsWith("/", StringComparison.Ordinal) || normalized.Contains("//") ||
                normalized.Any(character => char.IsControl(character)))
            {
                throw new InvalidOperationException("menuPath is malformed");
            }

            string root = normalized.Split('/')[0];
            string[] blockedBuiltInRoots =
            {
                "File", "Edit", "Assets", "GameObject", "Component", "Window", "Help", "CONTEXT"
            };
            if (blockedBuiltInRoots.Any(candidate => string.Equals(candidate, root, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException(
                    $"Built-in Unity menu root '{root}' is blocked. This command only executes project-defined custom menu items.");
            }

            return normalized;
        }

        private static EditorOperationState CaptureEditorOperationState()
        {
            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            return new EditorOperationState
            {
                isPlaying = EditorApplication.isPlaying,
                isPlayingOrWillChangePlaymode = EditorApplication.isPlayingOrWillChangePlaymode,
                isCompiling = EditorApplication.isCompiling,
                isUpdating = EditorApplication.isUpdating,
                activeScenePath = activeScene.IsValid() ? activeScene.path : null,
                activeSceneDirty = activeScene.IsValid() && activeScene.isDirty,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }

        private static object ReadProperty(object target, Type targetType, string propertyName, BindingFlags flags)
        {
            return targetType.GetProperty(propertyName, flags)?.GetValue(target);
        }

        private static bool ReadBooleanProperty(object target, Type targetType, string propertyName, BindingFlags flags)
        {
            object value = ReadProperty(target, targetType, propertyName, flags);
            return value is bool boolean && boolean;
        }

        private static string NormalizeVisualScriptingAssetPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException("assetPath is required");

            string normalized = value.Replace('\\', '/').Trim();
            if (!normalized.StartsWith("Assets/", StringComparison.Ordinal) ||
                !string.Equals(Path.GetExtension(normalized), ".asset", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("assetPath must be an Assets/... path ending in .asset");
            }
            if (normalized.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
                throw new InvalidOperationException("assetPath contains an invalid path segment");

            string assetsRoot = Path.GetFullPath(Application.dataPath)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, normalized));
            if (!fullPath.StartsWith(assetsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("assetPath must stay inside the project's Assets folder");

            return normalized;
        }

        private static void ValidateBanterVisualScripting(ValidateBanterVisualScriptingCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("SideQuest SDK Visual Scripting validation requires a safe correlation ID");

            const int maxDiagnostics = 200;
            const int maxDiagnosticStackTraceLength = 2048;
            var result = new BanterVisualScriptingValidationResult
            {
                commandId = cmd.id,
                success = false,
                validatorAvailable = false,
                validationCompleted = false,
                validationPassed = false,
                diagnostics = new List<ConsoleLogEntry>(),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
            int observedDiagnosticCount = 0;
            Application.LogCallback diagnosticCapture = null;

            try
            {
                if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                    throw new InvalidOperationException("Unity is compiling or importing assets. Wait for the Editor to settle.");

                string[] validatorTypeNames =
                {
                    "BS.SDKEditor.ValidateVisualScripting",
                    "Banter.SDKEditor.ValidateVisualScripting"
                };
                string[] validatorAssemblyNames = { "BS.SDKEditor", "Banter.SDKEditor" };
                Type validatorType = null;
                for (int index = 0; index < validatorTypeNames.Length && validatorType == null; index++)
                {
                    string candidateTypeName = validatorTypeNames[index];
                    string candidateAssemblyName = validatorAssemblyNames[index];
                    validatorType = Type.GetType(candidateTypeName + ", " + candidateAssemblyName, false) ??
                        AppDomain.CurrentDomain.GetAssemblies()
                            .Select(assembly => assembly.GetType(candidateTypeName, false))
                            .FirstOrDefault(candidate => candidate != null);
                }
                if (validatorType == null)
                {
                    throw new InvalidOperationException(
                        "No supported SideQuest Visual Scripting validator is available. Install either the Creator SDK or Banter SDK with Unity Visual Scripting, then wait for compilation to finish.");
                }

                MethodInfo validatorMethod = validatorType.GetMethod(
                    "CheckVsNodes",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    Type.EmptyTypes,
                    null);
                if (validatorMethod == null || validatorMethod.ReturnType != typeof(bool))
                    throw new MissingMethodException(validatorType.FullName, "public static bool CheckVsNodes()");

                result.validatorAvailable = true;
                result.validatorType = validatorType.FullName;
                result.validatorAssembly = validatorType.Assembly.GetName().Name;
                result.validatorMethod = validatorMethod.Name;
                result.sdkProfile = validatorType.FullName.StartsWith("BS.", StringComparison.Ordinal)
                    ? "creator"
                    : "banter";

                diagnosticCapture = (condition, stackTrace, logType) =>
                {
                    if (string.IsNullOrEmpty(condition) ||
                        !condition.StartsWith("[VisualScripting]", StringComparison.Ordinal))
                    {
                        return;
                    }

                    observedDiagnosticCount++;
                    if (result.diagnostics.Count >= maxDiagnostics)
                        return;

                    result.diagnostics.Add(new ConsoleLogEntry
                    {
                        level = logType.ToString(),
                        message = condition,
                        stackTrace = string.IsNullOrEmpty(stackTrace)
                            ? ""
                            : stackTrace.Substring(0, Math.Min(stackTrace.Length, maxDiagnosticStackTraceLength)),
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    });
                };
                Application.logMessageReceived += diagnosticCapture;

                object validatorReturn = validatorMethod.Invoke(null, null);
                result.validationPassed = validatorReturn is bool && (bool)validatorReturn;
                result.validationCompleted = true;
                result.success = result.validationPassed;
                if (!result.validationPassed)
                    result.error = "The selected SideQuest SDK Visual Scripting validator reported one or more errors.";
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                result.error = actual.Message;
            }
            finally
            {
                if (diagnosticCapture != null)
                    Application.logMessageReceived -= diagnosticCapture;
            }

            result.diagnosticCount = observedDiagnosticCount;
            result.diagnosticsTruncated = observedDiagnosticCount > result.diagnostics.Count;
            WriteAtomicText(
                Path.Combine(BanterValidationResultsFolder, cmd.id + ".json"),
                JsonUtility.ToJson(result, true));
            DeleteOldFiles(BanterValidationResultsFolder, "*.json", 50);
        }

        private static void RunUnityTests(RunTestsCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.id))
                throw new InvalidOperationException("Unity test command requires an ID");
            if (!IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Unity test command ID contains unsupported characters");
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                throw new InvalidOperationException("Unity is compiling or importing assets. Wait for the Editor to settle before running tests.");
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Stop Play Mode before starting a Unity Test Runner job.");

            string mode = string.IsNullOrWhiteSpace(cmd.mode)
                ? "edit"
                : cmd.mode.Trim().ToLowerInvariant();
            if (mode != "edit" && mode != "play" && mode != "all")
                throw new InvalidOperationException("Unity test mode must be 'edit', 'play', or 'all'");

            int maxResults = cmd.maxResults == 0 ? 500 : cmd.maxResults;
            if (maxResults < 1 || maxResults > 5000)
                throw new InvalidOperationException("Unity test maxResults must be between 1 and 5000");

            int timeoutMs = cmd.timeoutMs == 0 ? 120000 : cmd.timeoutMs;
            if (timeoutMs < 1000 || timeoutMs > 600000)
                throw new InvalidOperationException("Unity test timeoutMs must be between 1000 and 600000");

            if (FindPendingTestRun() != null || IsUnityTestRunActive())
                throw new InvalidOperationException("A Unity Test Runner job is already active");

            Type apiType = FindTestRunnerType("TestRunnerApi");
            Type callbackType = FindTestRunnerType("ICallbacks");
            Type filterType = FindTestRunnerType("Filter");
            Type executionSettingsType = FindTestRunnerType("ExecutionSettings");
            Type testModeType = FindTestRunnerType("TestMode");
            if (apiType == null || callbackType == null || filterType == null ||
                executionSettingsType == null || testModeType == null)
            {
                throw new InvalidOperationException(
                    "Unity Test Framework is not available. Add com.unity.test-framework to this project first.");
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var run = new UnityTestRunResult
            {
                commandId = cmd.id,
                success = false,
                testsPassed = false,
                status = "starting",
                mode = mode,
                startedAt = now,
                updatedAt = now,
                deadline = now + Math.Max(timeoutMs + 120000L, 1800000L),
                maxResults = maxResults,
                testNames = CleanFilterValues(cmd.testNames),
                groupNames = CleanFilterValues(cmd.groupNames),
                categoryNames = CleanFilterValues(cmd.categoryNames),
                assemblyNames = CleanFilterValues(cmd.assemblyNames),
                tests = new List<UnityTestCaseResult>()
            };

            if (!AllowAllTests &&
                run.testNames.Length == 0 &&
                run.groupNames.Length == 0 &&
                run.categoryNames.Length == 0 &&
                run.assemblyNames.Length == 0)
            {
                throw new InvalidOperationException(
                    "Running all tests without a filter is disabled for this project in Creator Works MCP settings. " +
                    "Specify targeted testNames, groupNames, or assembly filters, or enable 'Allow Running All Tests' in the MCP settings window.");
            }

            SaveTestRunResult(run);

            try
            {
                object filter = Activator.CreateInstance(filterType);
                SetTestRunnerField(filterType, filter, "testMode", ParseTestMode(testModeType, mode));
                SetTestRunnerField(filterType, filter, "testNames", EmptyToNull(run.testNames));
                SetTestRunnerField(filterType, filter, "groupNames", EmptyToNull(run.groupNames));
                SetTestRunnerField(filterType, filter, "categoryNames", EmptyToNull(run.categoryNames));
                SetTestRunnerField(filterType, filter, "assemblyNames", EmptyToNull(run.assemblyNames));

                Array filters = Array.CreateInstance(filterType, 1);
                filters.SetValue(filter, 0);
                ConstructorInfo settingsConstructor = executionSettingsType.GetConstructor(new[] { filters.GetType() });
                if (settingsConstructor == null)
                    throw new MissingMethodException(executionSettingsType.FullName, ".ctor(Filter[])");

                object executionSettings = settingsConstructor.Invoke(new object[] { filters });
                SetTestRunnerField(executionSettingsType, executionSettings, "runSynchronously", false);

                RegisterTestRunnerCallback(cmd.id, apiType, callbackType);
                MethodInfo executeMethod = apiType.GetMethod("Execute", new[] { executionSettingsType });
                if (executeMethod == null)
                    throw new MissingMethodException(apiType.FullName, "Execute");

                object jobId = executeMethod.Invoke(activeTestRunnerApi, new[] { executionSettings });
                run = LoadTestRunResult(cmd.id) ?? run;
                run.jobId = jobId?.ToString();
                run.status = "running";
                run.updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                SaveTestRunResult(run);
                DeleteOldFiles(TestRunResultsFolder, "*.json", 20);
            }
            catch (Exception exception)
            {
                Exception actual = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException
                    : exception;
                run = LoadTestRunResult(cmd.id) ?? run;
                run.status = "failed";
                run.error = actual.Message;
                run.finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                run.updatedAt = run.finishedAt;
                SaveTestRunResult(run);
                UnregisterActiveTestRunnerCallback();
                throw new InvalidOperationException("Unity Test Framework could not start: " + actual.Message, actual);
            }
        }

        private static void DiscoverUnityTests(DiscoverTestsCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Unity test discovery requires a safe command ID");
            if (EditorApplication.isCompiling || EditorApplication.isUpdating || EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Stop Play Mode and wait for Unity compilation/import to finish before discovering tests.");
            if (ActiveTestDiscoveryApis.Count > 0)
                throw new InvalidOperationException("A Unity test discovery request is already active");

            string mode = string.IsNullOrWhiteSpace(cmd.mode) ? "all" : cmd.mode.Trim().ToLowerInvariant();
            if (mode != "edit" && mode != "play" && mode != "all")
                throw new InvalidOperationException("Unity test discovery mode must be 'edit', 'play', or 'all'");

            int maxResults = cmd.maxResults == 0 ? 1000 : cmd.maxResults;
            if (maxResults < 1 || maxResults > 5000)
                throw new InvalidOperationException("Unity test discovery maxResults must be between 1 and 5000");
            string search = string.IsNullOrWhiteSpace(cmd.search) ? null : cmd.search.Trim();
            if (search != null && search.Length > 512)
                throw new InvalidOperationException("Unity test discovery search must not exceed 512 characters");

            Type apiType = FindTestRunnerType("TestRunnerApi");
            Type adaptorType = FindTestRunnerType("ITestAdaptor");
            Type testModeType = FindTestRunnerType("TestMode");
            if (apiType == null || adaptorType == null || testModeType == null)
            {
                throw new InvalidOperationException(
                    "Unity Test Framework is not available. Add com.unity.test-framework to this project first.");
            }

            UnityEngine.Object api = ScriptableObject.CreateInstance(apiType);
            ActiveTestDiscoveryApis[cmd.id] = api;
            try
            {
                MethodInfo helper = typeof(BantworksMCPBridge).GetMethod(
                    nameof(StartTypedTestDiscovery),
                    BindingFlags.NonPublic | BindingFlags.Static);
                if (helper == null)
                    throw new MissingMethodException(typeof(BantworksMCPBridge).FullName, nameof(StartTypedTestDiscovery));
                helper.MakeGenericMethod(adaptorType).Invoke(
                    null,
                    new object[] { api, ParseTestMode(testModeType, mode), cmd.id, mode, search, maxResults });
            }
            catch
            {
                ReleaseTestDiscoveryApi(cmd.id);
                throw;
            }
        }

        private static void StartTypedTestDiscovery<T>(
            object api,
            object testMode,
            string commandId,
            string mode,
            string search,
            int maxResults)
        {
            Type actionType = typeof(Action<T>);
            MethodInfo retrieve = api.GetType().GetMethod(
                "RetrieveTestList",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                new[] { testMode.GetType(), actionType },
                null);
            if (retrieve == null)
                throw new MissingMethodException(api.GetType().FullName, "RetrieveTestList");

            Action<T> callback = root => CompleteTestDiscovery(commandId, mode, search, maxResults, root);
            retrieve.Invoke(api, new object[] { testMode, callback });
        }

        private static void CompleteTestDiscovery(
            string commandId,
            string mode,
            string search,
            int maxResults,
            object root)
        {
            var result = new TestDiscoveryResult
            {
                commandId = commandId,
                success = false,
                mode = mode,
                search = search,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                tests = new List<DiscoveredTestEntry>()
            };

            try
            {
                int visitedNodes = 0;
                WalkDiscoveredTestTree(root, search, maxResults, result, 0, ref visitedNodes);
                result.success = true;
                result.returned = result.tests.Count;
                result.truncated = result.matchingTests > result.returned;
            }
            catch (Exception exception)
            {
                result.error = exception.Message;
            }
            finally
            {
                WriteAtomicText(
                    Path.Combine(TestDiscoveryResultsFolder, commandId + ".json"),
                    JsonUtility.ToJson(result, true));
                DeleteOldFiles(TestDiscoveryResultsFolder, "*.json", 50);
                ReleaseTestDiscoveryApi(commandId);
            }
        }

        private static void WalkDiscoveredTestTree(
            object node,
            string search,
            int maxResults,
            TestDiscoveryResult result,
            int depth,
            ref int visitedNodes)
        {
            if (node == null)
                return;
            if (depth > 64 || ++visitedNodes > 100000)
                throw new InvalidOperationException("Unity returned an unexpectedly large or deep test tree");

            bool isSuite = ReadReflectedValue(node, "IsSuite", false);
            if (!isSuite)
            {
                result.totalTests++;
                string name = ReadReflectedValue(node, "Name", "");
                string fullName = ReadReflectedValue(node, "FullName", "");
                string assemblyName = FindDiscoveredTestAssembly(node);
                string[] categories = ReadReflectedObject(node, "Categories") as string[] ?? new string[0];
                bool matches = string.IsNullOrWhiteSpace(search) ||
                    name.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    fullName.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    assemblyName.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    categories.Any(category => category.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0);

                if (matches)
                {
                    result.matchingTests++;
                    if (result.tests.Count < maxResults)
                    {
                        result.tests.Add(new DiscoveredTestEntry
                        {
                            id = ReadReflectedValue(node, "Id", ""),
                            name = name,
                            fullName = fullName,
                            uniqueName = ReadReflectedValue(node, "UniqueName", ""),
                            assemblyName = assemblyName,
                            mode = ReadReflectedObject(node, "TestMode")?.ToString(),
                            runState = ReadReflectedObject(node, "RunState")?.ToString(),
                            description = ReadReflectedValue(node, "Description", ""),
                            skipReason = ReadReflectedValue(node, "SkipReason", ""),
                            categories = categories
                        });
                    }
                }
            }

            var children = ReadReflectedObject(node, "Children") as System.Collections.IEnumerable;
            if (children == null)
                return;
            foreach (object child in children)
                WalkDiscoveredTestTree(child, search, maxResults, result, depth + 1, ref visitedNodes);
        }

        private static string FindDiscoveredTestAssembly(object node)
        {
            object current = node;
            for (int depth = 0; current != null && depth < 64; depth++)
            {
                if (ReadReflectedValue(current, "IsTestAssembly", false))
                {
                    string assembly = ReadReflectedValue(current, "Name", "");
                    return assembly.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
                        ? assembly.Substring(0, assembly.Length - 4)
                        : assembly;
                }
                current = ReadReflectedObject(current, "Parent");
            }
            return "";
        }

        private static void ReleaseTestDiscoveryApi(string commandId)
        {
            if (ActiveTestDiscoveryApis.TryGetValue(commandId, out UnityEngine.Object api))
            {
                ActiveTestDiscoveryApis.Remove(commandId);
                if (api != null)
                    UnityEngine.Object.DestroyImmediate(api);
            }
        }

        private static void CancelUnityTests(CancelTestsCommand cmd)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id) || !IsSafeCorrelationId(cmd.runId))
                throw new InvalidOperationException("Unity test cancellation requires safe command and run IDs");

            UnityTestRunResult run = LoadTestRunResult(cmd.runId);
            if (run == null)
                throw new InvalidOperationException("Unity test run was not found: " + cmd.runId);
            if (run.status != "starting" && run.status != "running")
                throw new InvalidOperationException("Unity test run is not active: " + run.status);
            if (string.IsNullOrWhiteSpace(run.jobId))
                throw new InvalidOperationException("Unity test run has not published its Test Framework job ID yet");

            Type apiType = FindTestRunnerType("TestRunnerApi");
            MethodInfo cancel = apiType?.GetMethod(
                "CancelTestRun",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(string) },
                null);
            if (cancel == null)
            {
                throw new NotSupportedException(
                    "The installed Unity Test Framework does not expose public cancellation. CancelTestRun requires a newer package (available in 1.6+).");
            }

            bool accepted = cancel.Invoke(null, new object[] { run.jobId }) is bool value && value;
            if (!accepted)
                throw new InvalidOperationException("Unity Test Framework did not accept cancellation for job: " + run.jobId);

            run.cancellationRequested = true;
            run.cancellationRequestedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            run.updatedAt = run.cancellationRequestedAt;
            SaveTestRunResult(run);
        }

        private static Type FindTestRunnerType(string typeName)
        {
            string fullName = "UnityEditor.TestTools.TestRunner.Api." + typeName;
            Type type = Type.GetType(fullName + ", UnityEditor.TestRunner", false);
            if (type != null)
                return type;

            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType(fullName, false))
                .FirstOrDefault(candidate => candidate != null);
        }

        private static object ParseTestMode(Type testModeType, string mode)
        {
            if (mode == "all")
            {
                int edit = Convert.ToInt32(Enum.Parse(testModeType, "EditMode"), CultureInfo.InvariantCulture);
                int play = Convert.ToInt32(Enum.Parse(testModeType, "PlayMode"), CultureInfo.InvariantCulture);
                return Enum.ToObject(testModeType, edit | play);
            }

            return Enum.Parse(testModeType, mode == "play" ? "PlayMode" : "EditMode");
        }

        private static void SetTestRunnerField(Type ownerType, object owner, string fieldName, object value)
        {
            FieldInfo field = ownerType.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (field == null)
                throw new MissingFieldException(ownerType.FullName, fieldName);
            field.SetValue(owner, value);
        }

        private static string[] CleanFilterValues(string[] values)
        {
            string[] cleaned = values == null
                ? new string[0]
                : values.Where(value => !string.IsNullOrWhiteSpace(value))
                    .Select(value => value.Trim())
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
            if (cleaned.Length > 200 || cleaned.Any(value => value.Length > 512))
                throw new InvalidOperationException("Unity test filters allow at most 200 values of at most 512 characters each");
            return cleaned;
        }

        private static bool IsSafeCorrelationId(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Length <= 128 &&
                value.All(character => char.IsLetterOrDigit(character) || character == '-');
        }

        private static string[] EmptyToNull(string[] values)
        {
            return values != null && values.Length > 0 ? values : null;
        }

        private static void RegisterTestRunnerCallback(string runId, Type apiType = null, Type callbackType = null)
        {
            if (activeTestRunId == runId && activeTestRunnerCallback != null)
                return;

            UnregisterActiveTestRunnerCallback();
            apiType = apiType ?? FindTestRunnerType("TestRunnerApi");
            callbackType = callbackType ?? FindTestRunnerType("ICallbacks");
            if (apiType == null || callbackType == null)
                throw new InvalidOperationException("Unity Test Framework callback API is unavailable");

            MethodInfo createProxy = typeof(DispatchProxy).GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(method => method.Name == "Create" && method.IsGenericMethodDefinition &&
                    method.GetGenericArguments().Length == 2 && method.GetParameters().Length == 0);
            if (createProxy == null)
                throw new MissingMethodException(typeof(DispatchProxy).FullName, "Create<T,TProxy>");

            object callback = createProxy
                .MakeGenericMethod(callbackType, typeof(TestRunnerCallbackProxy))
                .Invoke(null, null);
            ((TestRunnerCallbackProxy)callback).RunId = runId;

            object api = ScriptableObject.CreateInstance(apiType);
            MethodInfo register = apiType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(method => method.Name == "RegisterCallbacks" && method.IsGenericMethodDefinition);
            if (register == null)
                throw new MissingMethodException(apiType.FullName, "RegisterCallbacks");

            register.MakeGenericMethod(callbackType).Invoke(api, new[] { callback, (object)0 });
            activeTestRunId = runId;
            activeTestRunnerApi = api;
            activeTestRunnerCallback = callback;
        }

        private static void UnregisterActiveTestRunnerCallback()
        {
            if (activeTestRunnerApi != null && activeTestRunnerCallback != null)
            {
                try
                {
                    Type apiType = activeTestRunnerApi.GetType();
                    Type callbackType = FindTestRunnerType("ICallbacks");
                    MethodInfo unregister = apiType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                        .FirstOrDefault(method => method.Name == "UnregisterCallbacks" && method.IsGenericMethodDefinition);
                    unregister?.MakeGenericMethod(callbackType).Invoke(
                        activeTestRunnerApi,
                        new[] { activeTestRunnerCallback });
                }
                catch (Exception exception)
                {
                    Debug.LogWarning("[Creator Works MCP] Could not unregister Test Runner callback: " + exception.Message);
                }

                if (activeTestRunnerApi is UnityEngine.Object unityObject)
                    UnityEngine.Object.DestroyImmediate(unityObject);
            }

            activeTestRunId = null;
            activeTestRunnerApi = null;
            activeTestRunnerCallback = null;
        }

        private static void ResumePendingTestRun()
        {
            if (!string.IsNullOrWhiteSpace(activeTestRunId))
                return;

            UnityTestRunResult pending = FindPendingTestRun();
            if (pending == null)
                return;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (pending.deadline > 0 && now > pending.deadline)
            {
                FailTestRun(pending, "The persisted Unity test run expired before a completion callback was received.");
                return;
            }

            try
            {
                RegisterTestRunnerCallback(pending.commandId);
                Debug.Log("[Creator Works MCP] Restored Test Runner callback for " + pending.commandId);
            }
            catch (Exception exception)
            {
                FailTestRun(pending, "Could not restore Unity Test Runner callback: " + exception.Message);
            }
        }

        private static UnityTestRunResult FindPendingTestRun()
        {
            if (!Directory.Exists(TestRunResultsFolder))
                return null;

            foreach (string file in Directory.GetFiles(TestRunResultsFolder, "*.json")
                .OrderByDescending(File.GetLastWriteTimeUtc))
            {
                try
                {
                    var result = JsonUtility.FromJson<UnityTestRunResult>(File.ReadAllText(file));
                    if (result != null && (result.status == "starting" || result.status == "running"))
                        return result;
                }
                catch
                {
                    // Ignore incomplete or unrelated files and continue to the next run.
                }
            }

            return null;
        }

        private static bool IsUnityTestRunActive()
        {
            return TryGetUnityTestRunActive(out bool active) && active;
        }

        private static bool TryGetUnityTestRunActive(out bool active)
        {
            active = false;
            Type apiType = FindTestRunnerType("TestRunnerApi");
            MethodInfo method = apiType?.GetMethod("IsRunActive", BindingFlags.NonPublic | BindingFlags.Static);
            if (method == null)
                return false;

            try
            {
                object result = method.Invoke(null, null);
                if (!(result is bool value))
                    return false;
                active = value;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void CheckActiveTestRunDeadline()
        {
            if (string.IsNullOrWhiteSpace(activeTestRunId))
                return;

            UnityTestRunResult run = LoadTestRunResult(activeTestRunId);
            if (run == null || run.status == "completed" || run.status == "failed")
            {
                UnregisterActiveTestRunnerCallback();
                return;
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (run.cancellationRequested && run.cancellationRequestedAt > 0 &&
                now - run.cancellationRequestedAt >= 2000 &&
                !EditorApplication.isPlayingOrWillChangePlaymode &&
                TryGetUnityTestRunActive(out bool testRunActive) && !testRunActive)
            {
                // Play Mode cancellation can reload scripts after the framework's terminal callback.
                run.status = "completed";
                run.success = true;
                run.testsPassed = false;
                run.completionSource = "cancellation_cleanup_observed";
                run.finishedAt = now;
                run.updatedAt = now;
                SaveTestRunResult(run);
                UnregisterActiveTestRunnerCallback();
                return;
            }

            if (run.deadline > 0 && now > run.deadline)
            {
                FailTestRun(run, "Unity Test Runner did not finish before the safety deadline.");
                UnregisterActiveTestRunnerCallback();
            }
        }

        private static void HandleTestRunnerCallback(string runId, string callbackName, object argument)
        {
            UnityTestRunResult run = LoadTestRunResult(runId);
            if (run == null || run.status == "completed" || run.status == "failed")
                return;

            try
            {
                switch (callbackName)
                {
                    case "RunStarted":
                        run.status = "running";
                        run.loadedTestCount = ReadReflectedValue(argument, "TestCaseCount", run.loadedTestCount);
                        break;

                    case "TestFinished":
                        object test = ReadReflectedObject(argument, "Test");
                        bool isSuite = test != null && ReadReflectedValue(test, "IsSuite", false);
                        if (!isSuite)
                        {
                            if (run.tests == null)
                                run.tests = new List<UnityTestCaseResult>();

                            if (run.tests.Count < run.maxResults)
                            {
                                run.tests.Add(new UnityTestCaseResult
                                {
                                    name = ReadReflectedValue(argument, "Name", ""),
                                    fullName = ReadReflectedValue(argument, "FullName", ""),
                                    resultState = ReadReflectedValue(argument, "ResultState", ""),
                                    status = ReadReflectedObject(argument, "TestStatus")?.ToString(),
                                    duration = ReadReflectedValue(argument, "Duration", 0d),
                                    message = ReadReflectedValue(argument, "Message", ""),
                                    stackTrace = ReadReflectedValue(argument, "StackTrace", ""),
                                    output = ReadReflectedValue(argument, "Output", "")
                                });
                            }
                            else
                            {
                                run.truncated = true;
                            }
                            run.completedCount++;
                        }
                        break;

                    case "RunFinished":
                        run.status = "completed";
                        run.success = true;
                        run.completionSource = "run_finished";
                        run.passed = ReadReflectedValue(argument, "PassCount", 0);
                        run.failed = ReadReflectedValue(argument, "FailCount", 0);
                        run.skipped = ReadReflectedValue(argument, "SkipCount", 0);
                        run.inconclusive = ReadReflectedValue(argument, "InconclusiveCount", 0);
                        run.total = run.passed + run.failed + run.skipped + run.inconclusive;
                        run.completedCount = run.total;
                        run.duration = ReadReflectedValue(argument, "Duration", 0d);
                        run.noTests = run.total == 0;
                        run.testsPassed = !run.cancellationRequested && !run.noTests && run.failed == 0;
                        run.finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        break;
                }

                run.updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                SaveTestRunResult(run);

                if (callbackName == "RunFinished")
                    UnregisterActiveTestRunnerCallback();
            }
            catch (Exception exception)
            {
                Debug.LogError("[Creator Works MCP] Test Runner callback failed: " + exception);
                FailTestRun(run, "Could not serialize Unity Test Runner result: " + exception.Message);
                UnregisterActiveTestRunnerCallback();
            }
        }

        private static object ReadReflectedObject(object source, string propertyName)
        {
            if (source == null)
                return null;
            return source.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance)?.GetValue(source, null);
        }

        private static T ReadReflectedValue<T>(object source, string propertyName, T fallback)
        {
            object value = ReadReflectedObject(source, propertyName);
            if (value == null)
                return fallback;
            if (value is T typed)
                return typed;

            try
            {
                return (T)Convert.ChangeType(value, typeof(T), CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static UnityTestRunResult LoadTestRunResult(string runId)
        {
            if (string.IsNullOrWhiteSpace(runId))
                return null;

            string resultPath = Path.Combine(TestRunResultsFolder, runId + ".json");
            if (!File.Exists(resultPath))
                return null;

            try
            {
                return JsonUtility.FromJson<UnityTestRunResult>(File.ReadAllText(resultPath));
            }
            catch
            {
                return null;
            }
        }

        private static void SaveTestRunResult(UnityTestRunResult run)
        {
            if (run == null || string.IsNullOrWhiteSpace(run.commandId))
                return;
            WriteAtomicText(
                Path.Combine(TestRunResultsFolder, run.commandId + ".json"),
                JsonUtility.ToJson(run, true));
        }

        private static void FailTestRun(UnityTestRunResult run, string error)
        {
            if (run == null)
                return;
            run.status = "failed";
            run.success = false;
            run.testsPassed = false;
            run.error = error;
            run.finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            run.updatedAt = run.finishedAt;
            SaveTestRunResult(run);
        }

        public class TestRunnerCallbackProxy : DispatchProxy
        {
            public string RunId { get; set; }

            protected override object Invoke(MethodInfo targetMethod, object[] args)
            {
                if (targetMethod != null)
                    HandleTestRunnerCallback(RunId, targetMethod.Name, args != null && args.Length > 0 ? args[0] : null);
                return null;
            }
        }

        private static void SaveUnityScene(SaveSceneCommand cmd)
        {
            ValidateSceneCommand(cmd?.id);
            EnsureSceneEditingReady();

            UnityEngine.SceneManagement.Scene scene;
            if (string.IsNullOrWhiteSpace(cmd.scenePath))
            {
                scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            }
            else
            {
                string sourcePath = NormalizeSceneAssetPath(cmd.scenePath, "scenePath");
                scene = UnityEngine.SceneManagement.SceneManager.GetSceneByPath(sourcePath);
                if (!scene.IsValid() || !scene.isLoaded)
                    throw new InvalidOperationException("The requested scene is not open: " + sourcePath);
            }

            if (!scene.IsValid() || !scene.isLoaded)
                throw new InvalidOperationException("No loaded scene is available to save");

            string saveAsPath = null;
            if (!string.IsNullOrWhiteSpace(cmd.saveAsPath))
            {
                saveAsPath = NormalizeSceneAssetPath(cmd.saveAsPath, "saveAsPath");
                string parentFolder = Path.GetDirectoryName(saveAsPath)?.Replace('\\', '/');
                if (string.IsNullOrWhiteSpace(parentFolder) || !AssetDatabase.IsValidFolder(parentFolder))
                    throw new InvalidOperationException("The saveAsPath parent must be an existing Unity asset folder: " + parentFolder);

                bool samePath = string.Equals(scene.path, saveAsPath, StringComparison.Ordinal);
                bool destinationExists = File.Exists(Path.Combine(ProjectRoot, saveAsPath)) ||
                    AssetDatabase.LoadAssetAtPath<SceneAsset>(saveAsPath) != null;
                if (destinationExists && !samePath && !cmd.overwrite)
                    throw new InvalidOperationException("A scene already exists at saveAsPath. Set overwrite=true to replace it.");
            }
            else if (string.IsNullOrWhiteSpace(scene.path))
            {
                throw new InvalidOperationException("The active scene has never been saved. Provide saveAsPath under Assets/.");
            }

            bool saved = saveAsPath == null
                ? EditorSceneManager.SaveScene(scene)
                : EditorSceneManager.SaveScene(scene, saveAsPath, false);
            if (!saved)
                throw new InvalidOperationException("Unity did not save the scene");

            ExportProjectState();
            ExportSceneManagementResult(cmd.id, "Saved scene: " + scene.path);
        }

        private static void OpenUnityScene(OpenSceneCommand cmd)
        {
            ValidateSceneCommand(cmd?.id);
            EnsureSceneEditingReady();

            string scenePath = NormalizeSceneAssetPath(cmd.scenePath, "scenePath");
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scenePath) == null)
                throw new InvalidOperationException("Scene asset was not found: " + scenePath);

            string requestedMode = string.IsNullOrWhiteSpace(cmd.mode)
                ? "single"
                : cmd.mode.Trim().ToLowerInvariant();
            if (requestedMode != "single" && requestedMode != "additive")
                throw new InvalidOperationException("Scene open mode must be 'single' or 'additive'");

            var openMode = requestedMode == "additive" ? OpenSceneMode.Additive : OpenSceneMode.Single;
            var existing = UnityEngine.SceneManagement.SceneManager.GetSceneByPath(scenePath);
            bool alreadySatisfiesRequest = existing.IsValid() && existing.isLoaded &&
                (openMode == OpenSceneMode.Additive || UnityEngine.SceneManagement.SceneManager.sceneCount == 1);

            UnityEngine.SceneManagement.Scene openedScene;
            if (alreadySatisfiesRequest)
            {
                openedScene = existing;
            }
            else
            {
                if (openMode == OpenSceneMode.Single)
                    SaveDirtyOpenScenesOrThrow(cmd.saveModifiedScenes);
                openedScene = EditorSceneManager.OpenScene(scenePath, openMode);
            }

            if (!openedScene.IsValid() || !openedScene.isLoaded)
                throw new InvalidOperationException("Unity did not load scene: " + scenePath);
            if (cmd.setActive && UnityEngine.SceneManagement.SceneManager.GetActiveScene() != openedScene &&
                !UnityEngine.SceneManagement.SceneManager.SetActiveScene(openedScene))
            {
                throw new InvalidOperationException("Unity loaded the scene but could not make it active: " + scenePath);
            }

            ExportProjectState();
            ExportSceneManagementResult(cmd.id, "Opened scene: " + scenePath);
        }

        private static void SaveDirtyOpenScenesOrThrow(bool saveModifiedScenes)
        {
            var dirtyScenes = new List<UnityEngine.SceneManagement.Scene>();
            for (int index = 0; index < UnityEngine.SceneManagement.SceneManager.sceneCount; index++)
            {
                var scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(index);
                if (scene.isLoaded && scene.isDirty)
                    dirtyScenes.Add(scene);
            }

            if (dirtyScenes.Count == 0)
                return;
            if (!saveModifiedScenes)
            {
                string names = string.Join(", ", dirtyScenes.Select(scene => string.IsNullOrWhiteSpace(scene.path) ? scene.name + " (unsaved)" : scene.path));
                throw new InvalidOperationException("Opening a scene in Single mode would discard modified scenes: " + names + ". Save them first or set saveModifiedScenes=true.");
            }

            foreach (var scene in dirtyScenes)
            {
                if (string.IsNullOrWhiteSpace(scene.path))
                    throw new InvalidOperationException("Cannot automatically save an untitled scene. Save it with save_unity_scene first.");
                string fullPath = Path.Combine(ProjectRoot, scene.path);
                if (File.Exists(fullPath) && (File.GetAttributes(fullPath) & FileAttributes.ReadOnly) != 0)
                    throw new InvalidOperationException("Cannot automatically save a read-only scene: " + scene.path);
            }

            foreach (var scene in dirtyScenes)
            {
                if (!EditorSceneManager.SaveScene(scene))
                    throw new InvalidOperationException("Unity could not save modified scene: " + scene.path);
            }
        }

        private static void SetUnityBuildScenes(SetBuildScenesCommand cmd)
        {
            ValidateSceneCommand(cmd?.id);
            EnsureSceneEditingReady();
            if (cmd.scenes == null)
                throw new InvalidOperationException("set_build_scenes requires an ordered scenes array");
            if (cmd.scenes.Length > 500)
                throw new InvalidOperationException("Build settings support at most 500 scenes per command");

            var normalized = new List<EditorBuildSettingsScene>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (BuildSceneInput input in cmd.scenes)
            {
                string scenePath = NormalizeSceneAssetPath(input?.path, "scenes[].path");
                if (!seen.Add(scenePath))
                    throw new InvalidOperationException("Build settings contain a duplicate scene path: " + scenePath);
                if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scenePath) == null)
                    throw new InvalidOperationException("Build settings scene asset was not found: " + scenePath);
                normalized.Add(new EditorBuildSettingsScene(scenePath, input.enabled));
            }

            EditorBuildSettingsScene[] previous = EditorBuildSettings.scenes;
            try
            {
                EditorBuildSettings.scenes = normalized.ToArray();
                AssetDatabase.SaveAssets();
            }
            catch
            {
                EditorBuildSettings.scenes = previous;
                throw;
            }

            ExportSceneManagementResult(cmd.id, "Replaced Unity build scene settings");
        }

        private static void EnsureSceneEditingReady()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                throw new InvalidOperationException("Unity is compiling or importing assets. Wait for the Editor to settle.");
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Stop Play Mode before changing scenes or build settings.");
            if (IsUnityTestRunActive())
                throw new InvalidOperationException("Wait for the active Unity Test Runner job to finish.");
        }

        private static void ValidateSceneCommand(string commandId)
        {
            if (!IsSafeCorrelationId(commandId))
                throw new InvalidOperationException("Scene command requires a safe correlation ID");
        }

        private static string NormalizeSceneAssetPath(string value, string label)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException(label + " is required");

            string normalized = value.Replace('\\', '/').Trim();
            if (!normalized.StartsWith("Assets/", StringComparison.Ordinal) ||
                !string.Equals(Path.GetExtension(normalized), ".unity", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(label + " must be an Assets/... path ending in .unity");
            }
            if (normalized.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
                throw new InvalidOperationException(label + " contains an invalid path segment");

            string assetsRoot = Path.GetFullPath(Application.dataPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, normalized));
            if (!fullPath.StartsWith(assetsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(label + " must stay inside the project's Assets folder");

            return normalized;
        }

        private static void ExportSceneManagementResult(string commandId, string message)
        {
            ValidateSceneCommand(commandId);
            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var result = new SceneManagementResult
            {
                commandId = commandId,
                success = true,
                message = message,
                activeScenePath = activeScene.path,
                activeSceneName = activeScene.name,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                openScenes = new List<OpenSceneEntry>(),
                buildScenes = new List<BuildSceneEntry>()
            };

            for (int index = 0; index < UnityEngine.SceneManagement.SceneManager.sceneCount; index++)
            {
                var scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(index);
                result.openScenes.Add(new OpenSceneEntry
                {
                    handle = scene.handle,
                    name = scene.name,
                    path = scene.path,
                    guid = string.IsNullOrWhiteSpace(scene.path) ? null : AssetDatabase.AssetPathToGUID(scene.path),
                    isLoaded = scene.isLoaded,
                    isDirty = scene.isDirty,
                    isActive = scene == activeScene,
                    buildIndex = scene.buildIndex,
                    rootCount = scene.isLoaded ? scene.rootCount : 0
                });
            }

            EditorBuildSettingsScene[] buildScenes = EditorBuildSettings.scenes;
            for (int index = 0; index < buildScenes.Length; index++)
            {
                EditorBuildSettingsScene scene = buildScenes[index];
                result.buildScenes.Add(new BuildSceneEntry
                {
                    index = index,
                    path = scene.path,
                    guid = AssetDatabase.AssetPathToGUID(scene.path),
                    enabled = scene.enabled
                });
            }

            WriteAtomicText(Path.Combine(SceneResultsFolder, commandId + ".json"), JsonUtility.ToJson(result, true));
            DeleteOldFiles(SceneResultsFolder, "*.json", 50);
        }

        private static void ModifyGameObject(ModifyGameObjectCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);

            Undo.RecordObject(obj.transform, "MCP Modify Transform");

            if (cmd.position != null && cmd.position.Length == 3)
            {
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);
            }

            if (cmd.rotation != null && cmd.rotation.Length == 3)
            {
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);
            }

            if (cmd.scale != null && cmd.scale.Length == 3)
            {
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);
            }

            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Modified GameObject: {DescribeObject(cmd.objectId, cmd.objectPath)}");
            ExportSceneHierarchy();
        }

        private static void AddComponentToObject(AddComponentCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);

            // Try to find the component type
            Type componentType = FindComponentType(cmd.componentType);
            if (componentType == null)
            {
                throw new InvalidOperationException($"Component type not found: {cmd.componentType}");
            }

            Undo.AddComponent(obj, componentType);
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Added component {cmd.componentType} to {cmd.objectPath}");
            ExportSceneHierarchy();
        }

        private static void RemoveComponentFromObject(RemoveComponentCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            var component = ResolveComponent(obj, cmd.componentId, cmd.componentType);

            Undo.DestroyObjectImmediate(component);
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Removed component {cmd.componentType} from {cmd.objectPath}");
            ExportSceneHierarchy();
        }

        private static void SetComponentProperty(SetComponentPropertyCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            var component = ResolveComponent(obj, cmd.componentId, cmd.componentType);

            var so = new SerializedObject(component);
            var prop = so.FindProperty(cmd.propertyName);
            if (prop == null)
            {
                throw new InvalidOperationException($"Property not found: {cmd.propertyName} on {cmd.componentType}");
            }

            Undo.RecordObject(component, "MCP Set Property");

            SetSerializedPropertyValue(prop, cmd.valueJson, cmd.value);

            so.ApplyModifiedProperties();
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Set {cmd.propertyName} on {cmd.componentType}");
            ExportSceneHierarchy();
        }

        private static void SetObjectReference(SetObjectReferenceCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            var component = ResolveComponent(obj, cmd.componentId, cmd.componentType);

            var so = new SerializedObject(component);
            var prop = so.FindProperty(cmd.propertyName);
            if (prop == null)
            {
                throw new InvalidOperationException($"Property not found: {cmd.propertyName} on {cmd.componentType}");
            }

            if (prop.propertyType != SerializedPropertyType.ObjectReference)
            {
                throw new InvalidOperationException($"Property is not an object reference: {cmd.propertyName} on {cmd.componentType}");
            }

            UnityEngine.Object targetObject = null;
            bool clearReference = string.IsNullOrWhiteSpace(cmd.targetId) &&
                                  (string.IsNullOrWhiteSpace(cmd.targetPath) ||
                                   string.Equals(cmd.targetPath, "null", StringComparison.OrdinalIgnoreCase));

            if (!clearReference)
            {
                var targetGameObject = ResolveGameObject(cmd.targetId, cmd.targetPath);

                targetObject = ResolveObjectReferenceTarget(component.GetType(), cmd.propertyName, targetGameObject, cmd.targetComponent);
                if (targetObject == null)
                {
                    throw new InvalidOperationException($"Could not resolve target reference for {cmd.propertyName} from {cmd.targetPath}");
                }
            }

            Undo.RecordObject(component, "MCP Set Object Reference");
            prop.objectReferenceValue = targetObject;
            so.ApplyModifiedProperties();

            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Set reference {cmd.propertyName} on {cmd.componentType}");
            ExportSceneHierarchy();
        }

        private static string SetAssetReference(SetAssetReferenceCommand cmd)
        {
            if (cmd == null)
                throw new InvalidOperationException("Asset reference command is missing");

            bool hasAssetPath = !string.IsNullOrWhiteSpace(cmd.assetPath);
            bool hasAssetGuid = !string.IsNullOrWhiteSpace(cmd.assetGuid);
            int targetCount = (hasAssetPath ? 1 : 0) + (hasAssetGuid ? 1 : 0) + (cmd.clear ? 1 : 0);
            if (targetCount != 1)
                throw new InvalidOperationException("Asset reference requires exactly one assetPath, assetGuid, or clear=true target");
            if (string.IsNullOrWhiteSpace(cmd.propertyName) || cmd.propertyName.Length > 512)
                throw new InvalidOperationException("Asset reference requires a bounded property path");

            var obj = ResolveGameObject(cmd.objectId, cmd.objectPath);
            var component = ResolveComponent(obj, cmd.componentId, cmd.componentType);
            string propertyPath = cmd.propertyName.Trim();
            var serializedObject = new SerializedObject(component);
            var property = serializedObject.FindProperty(propertyPath);
            if (property != null && property.propertyType != SerializedPropertyType.ObjectReference)
                throw new InvalidOperationException($"Property is not an object reference: {cmd.propertyName} on {cmd.componentType}");

            string resolvedPath = null;
            UnityEngine.Object targetAsset = null;
            if (!cmd.clear)
            {
                if (hasAssetGuid)
                {
                    string normalizedGuid = cmd.assetGuid.Trim().ToLowerInvariant();
                    if (normalizedGuid.Length != 32 || normalizedGuid.Any(c => !Uri.IsHexDigit(c)))
                        throw new InvalidOperationException("assetGuid must be a 32-character hexadecimal Unity GUID");
                    resolvedPath = AssetDatabase.GUIDToAssetPath(normalizedGuid);
                    if (string.IsNullOrWhiteSpace(resolvedPath))
                        throw new InvalidOperationException($"No Unity asset exists for GUID: {normalizedGuid}");
                }
                else
                {
                    resolvedPath = cmd.assetPath;
                }

                resolvedPath = NormalizeAssetReferencePath(resolvedPath);
                targetAsset = AssetDatabase.LoadMainAssetAtPath(resolvedPath);
                if (targetAsset == null)
                    throw new InvalidOperationException($"Unity could not load the main asset at: {resolvedPath}");

                if (!string.IsNullOrWhiteSpace(cmd.expectedAssetType) &&
                    !AssetMatchesExpectedType(targetAsset, cmd.expectedAssetType.Trim()))
                {
                    string actualType = targetAsset.GetType().FullName ?? targetAsset.GetType().Name;
                    throw new InvalidOperationException(
                        $"Asset type mismatch at {resolvedPath}: expected {cmd.expectedAssetType.Trim()}, loaded {actualType}");
                }
            }

            if (property == null)
            {
                SetReflectedAssetReference(component, propertyPath, targetAsset, cmd.componentType);
            }
            else
            {
                SetSerializedAssetReference(
                    component,
                    serializedObject,
                    property,
                    propertyPath,
                    targetAsset,
                    cmd.componentType);
            }

            EditorUtility.SetDirty(component);
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            Debug.Log($"[Creator Works MCP] Set asset reference {cmd.propertyName} on {cmd.componentType} -> {(cmd.clear ? "null" : resolvedPath)}");
            ExportSceneHierarchy();
            return cmd.clear ? "null" : resolvedPath;
        }

        private static void SetSerializedAssetReference(
            Component component,
            SerializedObject serializedObject,
            SerializedProperty property,
            string propertyPath,
            UnityEngine.Object targetAsset,
            string componentType)
        {
            UnityEngine.Object previousAsset = property.objectReferenceValue;

            // Assign on the SerializedObject without applying first. Unity rejects
            // incompatible references here, so no scene mutation has occurred.
            property.objectReferenceValue = targetAsset;
            if (property.objectReferenceValue != targetAsset)
            {
                serializedObject.Update();
                string actualType = targetAsset == null ? "null" : targetAsset.GetType().FullName;
                throw new InvalidOperationException(
                    $"Asset {actualType} is not compatible with {componentType}.{propertyPath}");
            }

            serializedObject.Update();
            property = serializedObject.FindProperty(propertyPath);
            Undo.RecordObject(component, "MCP Set Asset Reference");
            try
            {
                property.objectReferenceValue = targetAsset;
                serializedObject.ApplyModifiedProperties();
                serializedObject.Update();
                property = serializedObject.FindProperty(propertyPath);
                if (property == null || property.objectReferenceValue != targetAsset)
                    throw new InvalidOperationException("Unity did not retain the requested reference");
            }
            catch (Exception assignmentError)
            {
                string rollbackError = null;
                try
                {
                    var rollbackObject = new SerializedObject(component);
                    var rollbackProperty = rollbackObject.FindProperty(propertyPath);
                    if (rollbackProperty == null)
                    {
                        rollbackError = "property could not be resolved during rollback";
                    }
                    else
                    {
                        rollbackProperty.objectReferenceValue = previousAsset;
                        rollbackObject.ApplyModifiedProperties();
                        rollbackObject.Update();
                        rollbackProperty = rollbackObject.FindProperty(propertyPath);
                        if (rollbackProperty == null || rollbackProperty.objectReferenceValue != previousAsset)
                            rollbackError = "the previous reference was not retained during rollback";
                    }
                }
                catch (Exception error)
                {
                    rollbackError = GetInnermostExceptionMessage(error);
                }

                string rollbackResult = rollbackError == null
                    ? "; the previous value was restored"
                    : $"; rollback could not be verified: {rollbackError}";
                throw new InvalidOperationException(
                    $"Could not set asset reference on {componentType}.{propertyPath}: " +
                    $"{GetInnermostExceptionMessage(assignmentError)}{rollbackResult}");
            }
        }

        private static void SetReflectedAssetReference(
            Component component,
            string propertyPath,
            UnityEngine.Object targetAsset,
            string componentType)
        {
            ReflectedReferenceAccessor accessor = ResolveReflectedReferenceAccessor(component, propertyPath);
            if (!typeof(UnityEngine.Object).IsAssignableFrom(accessor.ValueType))
                throw new InvalidOperationException($"Property is not an object reference: {propertyPath} on {componentType}");
            if (targetAsset != null && !accessor.ValueType.IsAssignableFrom(targetAsset.GetType()))
            {
                throw new InvalidOperationException(
                    $"Asset {targetAsset.GetType().FullName} is not compatible with {componentType}.{propertyPath}");
            }

            UnityEngine.Object previousAsset = accessor.GetValue() as UnityEngine.Object;
            Undo.RecordObject(component, "MCP Set Asset Reference");
            try
            {
                accessor.SetValue(targetAsset);
                UnityEngine.Object retainedAsset = accessor.GetValue() as UnityEngine.Object;
                if (retainedAsset != targetAsset)
                    throw new InvalidOperationException("the property did not retain the requested reference");
            }
            catch (Exception assignmentError)
            {
                string rollbackError = null;
                try
                {
                    accessor.SetValue(previousAsset);
                    UnityEngine.Object restoredAsset = accessor.GetValue() as UnityEngine.Object;
                    if (restoredAsset != previousAsset)
                        rollbackError = "the previous reference was not retained during rollback";
                }
                catch (Exception error)
                {
                    rollbackError = GetInnermostExceptionMessage(error);
                }

                string rollbackResult = rollbackError == null
                    ? "; the previous value was restored"
                    : $"; rollback could not be verified: {rollbackError}";
                throw new InvalidOperationException(
                    $"Could not set asset reference on {componentType}.{propertyPath}: " +
                    $"{GetInnermostExceptionMessage(assignmentError)}{rollbackResult}");
            }
        }

        private static ReflectedReferenceAccessor ResolveReflectedReferenceAccessor(object root, string propertyPath)
        {
            string[] segments = propertyPath.Split('.');
            if (segments.Length == 0 || segments.Any(segment => !IsSafeMemberName(segment)))
                throw new InvalidOperationException($"Invalid reflected property path: {propertyPath}");

            object owner = root;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            for (int i = 0; i < segments.Length; i++)
            {
                if (owner == null)
                    throw new InvalidOperationException($"Property path contains a null owner before: {segments[i]}");

                Type ownerType = owner.GetType();
                System.Reflection.PropertyInfo property = ownerType.GetProperty(segments[i], flags);
                FieldInfo field = property == null ? ownerType.GetField(segments[i], flags) : null;
                bool isLast = i == segments.Length - 1;

                if (property != null)
                {
                    MethodInfo getter = property.GetGetMethod(true);
                    if (getter == null || getter.IsStatic || property.GetIndexParameters().Length != 0)
                        throw new InvalidOperationException($"Property is not a readable instance member: {segments[i]}");
                    if (isLast)
                    {
                        MethodInfo setter = property.GetSetMethod(true);
                        if (setter == null || setter.IsStatic)
                            throw new InvalidOperationException($"Property is not writable: {propertyPath}");
                        return new ReflectedReferenceAccessor(owner, property);
                    }
                    owner = property.GetValue(owner);
                    continue;
                }

                if (field != null)
                {
                    if (field.IsStatic)
                        throw new InvalidOperationException($"Field is not an instance member: {segments[i]}");
                    if (isLast)
                    {
                        if (field.IsInitOnly || field.IsLiteral)
                            throw new InvalidOperationException($"Field is not writable: {propertyPath}");
                        return new ReflectedReferenceAccessor(owner, field);
                    }
                    owner = field.GetValue(owner);
                    continue;
                }

                throw new InvalidOperationException($"Property not found: {propertyPath} on {root.GetType().FullName}");
            }

            throw new InvalidOperationException($"Property not found: {propertyPath} on {root.GetType().FullName}");
        }

        private static bool IsSafeMemberName(string value)
        {
            if (string.IsNullOrEmpty(value) || !(char.IsLetter(value[0]) || value[0] == '_'))
                return false;
            return value.Skip(1).All(character => char.IsLetterOrDigit(character) || character == '_');
        }

        private static string GetInnermostExceptionMessage(Exception error)
        {
            while (error.InnerException != null)
                error = error.InnerException;
            return error.Message;
        }

        private static string NormalizeAssetReferencePath(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 1024)
                throw new InvalidOperationException("Asset path is missing or exceeds 1024 characters");

            string normalized = value.Replace('\\', '/').Trim();
            string[] segments = normalized.Split('/');
            if (segments.Length < 2 ||
                (segments[0] != "Assets" && segments[0] != "Packages") ||
                segments.Any(segment => string.IsNullOrEmpty(segment) || segment == "." || segment == ".."))
            {
                throw new InvalidOperationException("Asset path must be a normalized Assets/... or Packages/... path without traversal");
            }
            return string.Join("/", segments);
        }

        private static bool AssetMatchesExpectedType(UnityEngine.Object asset, string expectedTypeName)
        {
            Type actualType = asset.GetType();
            if (string.Equals(actualType.FullName, expectedTypeName, StringComparison.Ordinal) ||
                string.Equals(actualType.Name, expectedTypeName, StringComparison.Ordinal) ||
                string.Equals(actualType.AssemblyQualifiedName, expectedTypeName, StringComparison.Ordinal))
            {
                return true;
            }

            Type expectedType = Type.GetType(expectedTypeName, false) ??
                AppDomain.CurrentDomain.GetAssemblies()
                    .Select(assembly => {
                        try { return assembly.GetType(expectedTypeName, false); }
                        catch { return null; }
                    })
                    .FirstOrDefault(type => type != null);
            return expectedType != null && expectedType.IsAssignableFrom(actualType);
        }

        private static UnityEngine.Object ResolveObjectReferenceTarget(Type componentType, string propertyName, GameObject targetGameObject, string targetComponent)
        {
            if (!string.IsNullOrEmpty(targetComponent))
            {
                if (string.Equals(targetComponent, "GameObject", StringComparison.OrdinalIgnoreCase))
                    return targetGameObject;

                Type explicitType = FindComponentType(targetComponent);
                if (explicitType == null)
                    return null;

                return targetGameObject.GetComponent(explicitType);
            }

            Type memberType = FindSerializedMemberType(componentType, propertyName);
            if (memberType == null || memberType == typeof(UnityEngine.Object) || memberType == typeof(GameObject))
                return targetGameObject;

            if (typeof(Component).IsAssignableFrom(memberType))
                return targetGameObject.GetComponent(memberType);

            if (typeof(GameObject).IsAssignableFrom(memberType))
                return targetGameObject;

            return null;
        }

        private static Type FindSerializedMemberType(Type componentType, string propertyName)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

            Type currentType = componentType;
            while (currentType != null)
            {
                var field = currentType.GetField(propertyName, flags);
                if (field != null)
                    return field.FieldType;

                currentType = currentType.BaseType;
            }

            var property = componentType.GetProperty(propertyName, flags);
            return property?.PropertyType;
        }

        private static Type FindComponentType(string typeName)
        {
            // Try common Unity namespaces first
            string[] namespaces = new string[]
            {
                "UnityEngine.",
                "UnityEngine.UI.",
                "",
                "BS.",
                "Banter.",
                "Banter.SDK."
            };

            foreach (var ns in namespaces)
            {
                var type = Type.GetType(ns + typeName + ", UnityEngine");
                if (type != null) return type;

                type = Type.GetType(ns + typeName + ", UnityEngine.CoreModule");
                if (type != null) return type;

                type = Type.GetType(ns + typeName + ", UnityEngine.PhysicsModule");
                if (type != null) return type;

                type = Type.GetType(ns + typeName + ", UnityEngine.UI");
                if (type != null) return type;
            }

            // Search all assemblies
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    // First try exact match by full name (namespace.classname)
                    var type = assembly.GetType(typeName);
                    if (type != null &&
                        typeof(Component).IsAssignableFrom(type) &&
                        (IsAllowedSDKComponentType(type) || EnableCustomScripts))
                        return type;

                    // Then try by simple name, preserving the SDK-only component boundary.
                    type = assembly.GetTypes().FirstOrDefault(t =>
                        t.Name == typeName &&
                        typeof(Component).IsAssignableFrom(t) &&
                        (IsAllowedSDKComponentType(t) || EnableCustomScripts));
                    if (type != null)
                        return type;

                    // Only search user namespaces if custom scripts toggle is ON
                    if (EnableCustomScripts)
                    {
                        string[] userNamespaces = new string[]
                        {
                            "PhysicsCharacterController.",
                            "Player.",
                            "Character.",
                            "VR.",
                            "Game.",
                            "Scripts."
                        };

                        foreach (var userNs in userNamespaces)
                        {
                            type = assembly.GetType(userNs + typeName);
                            if (type != null && typeof(Component).IsAssignableFrom(type))
                                return type;
                        }
                    }
                }
                catch (ReflectionTypeLoadException)
                {
                    // Some assemblies may fail to load types, skip them
                    continue;
                }
            }

            return null;
        }

        private static bool IsAllowedSDKComponentType(Type type)
        {
            string typeNamespace = type.Namespace ?? "";
            return typeNamespace == "BS" ||
                   typeNamespace.StartsWith("BS.", StringComparison.Ordinal) ||
                   typeNamespace == "Banter" ||
                   typeNamespace.StartsWith("Banter.", StringComparison.Ordinal) ||
                   typeNamespace == "UnityEngine" ||
                   typeNamespace.StartsWith("UnityEngine.", StringComparison.Ordinal);
        }

        private static GameObject ResolveGameObject(string objectId, string objectPath)
        {
            if (string.IsNullOrWhiteSpace(objectId))
                return FindGameObjectByPath(objectPath);

            GlobalObjectId globalObjectId;
            if (!GlobalObjectId.TryParse(objectId, out globalObjectId))
                throw new InvalidOperationException($"Invalid Unity GlobalObjectId: {objectId}");

            var obj = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalObjectId) as GameObject;
            if (obj == null)
                throw new InvalidOperationException($"GameObject ID is stale or does not identify a GameObject: {objectId}");

            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            if (obj.scene != activeScene)
                throw new InvalidOperationException($"GameObject ID is not in the active scene: {objectId}");

            return obj;
        }

        private static GameObject ResolveOptionalGameObject(string objectId, string objectPath)
        {
            return string.IsNullOrWhiteSpace(objectId) && string.IsNullOrWhiteSpace(objectPath)
                ? null
                : ResolveGameObject(objectId, objectPath);
        }

        private static Component ResolveComponent(GameObject owner, string componentId, string componentType)
        {
            if (!string.IsNullOrWhiteSpace(componentId))
            {
                GlobalObjectId globalObjectId;
                if (!GlobalObjectId.TryParse(componentId, out globalObjectId))
                    throw new InvalidOperationException($"Invalid component GlobalObjectId: {componentId}");

                var component = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalObjectId) as Component;
                if (component == null)
                    throw new InvalidOperationException($"Component ID is stale or does not identify a Component: {componentId}");
                if (component.gameObject != owner)
                    throw new InvalidOperationException($"Component ID does not belong to GameObject '{GetGameObjectPath(owner)}': {componentId}");
                if (!string.IsNullOrWhiteSpace(componentType) &&
                    !string.Equals(component.GetType().Name, componentType, StringComparison.Ordinal) &&
                    !string.Equals(component.GetType().FullName, componentType, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Component ID identifies {component.GetType().FullName}, not requested type {componentType}");
                }

                return component;
            }

            if (string.IsNullOrWhiteSpace(componentType))
                throw new InvalidOperationException("Component type or componentId is required");

            var matches = owner.GetComponents<Component>()
                .Where(component => component != null &&
                    (string.Equals(component.GetType().Name, componentType, StringComparison.Ordinal) ||
                     string.Equals(component.GetType().FullName, componentType, StringComparison.Ordinal)))
                .ToList();

            if (matches.Count == 1)
                return matches[0];
            if (matches.Count == 0)
                throw new InvalidOperationException($"Component not found: {componentType} on {GetGameObjectPath(owner)}");

            throw new InvalidOperationException(
                $"Component type is ambiguous on {GetGameObjectPath(owner)}: {componentType}. Supply componentId from scene-hierarchy.json.");
        }

        private static string GetStableObjectId(UnityEngine.Object obj)
        {
            return obj == null ? null : GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString();
        }

        private static string DescribeObject(string objectId, string objectPath)
        {
            return !string.IsNullOrWhiteSpace(objectPath) ? objectPath : objectId;
        }

        private static GameObject FindGameObjectByPath(string objectPath)
        {
            if (string.IsNullOrWhiteSpace(objectPath))
                throw new InvalidOperationException("GameObject path is required");

            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var matches = Resources.FindObjectsOfTypeAll<GameObject>()
                .Where(candidate => candidate.scene == activeScene && GetGameObjectPath(candidate) == objectPath)
                .ToList();

            if (matches.Count == 1)
                return matches[0];

            if (matches.Count == 0)
                throw new InvalidOperationException($"GameObject not found in active scene: {objectPath}");

            throw new InvalidOperationException(
                $"GameObject path is ambiguous: {objectPath}. Rename duplicate siblings before issuing a mutation command.");
        }

        private static void InstantiatePrefab(InstantiatePrefabCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.prefabPath))
                throw new InvalidOperationException("Instantiate prefab command requires prefabPath");

            GameObject parent = ResolveOptionalGameObject(cmd.parentId, cmd.parentPath);
            // Load prefab from asset path
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(cmd.prefabPath);
            if (prefab == null)
            {
                throw new InvalidOperationException($"Prefab not found: {cmd.prefabPath}");
            }

            // Instantiate prefab
            GameObject obj = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (obj == null)
            {
                throw new InvalidOperationException($"Failed to instantiate prefab: {cmd.prefabPath}");
            }

            // Set name if provided
            if (!string.IsNullOrEmpty(cmd.name))
            {
                obj.name = cmd.name;
            }

            // Set transform
            if (cmd.position != null && cmd.position.Length == 3)
            {
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);
            }

            if (cmd.rotation != null && cmd.rotation.Length == 3)
            {
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);
            }

            if (cmd.scale != null && cmd.scale.Length == 3)
            {
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);
            }

            // Set parent if specified
            if (parent != null)
            {
                obj.transform.SetParent(parent.transform, true);
            }

            // Register undo
            Undo.RegisterCreatedObjectUndo(obj, "MCP Instantiate Prefab");

            // Mark scene dirty
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());

            Debug.Log($"[Creator Works MCP] Instantiated prefab: {cmd.prefabPath}");
            ExportSceneHierarchy();
        }

        private static void InstantiatePrefabSilent(InstantiatePrefabCommand cmd)
        {
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(cmd.prefabPath);
            if (prefab == null) throw new InvalidOperationException($"Prefab not found: {cmd.prefabPath}");

            GameObject obj = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (obj == null) throw new InvalidOperationException($"Failed to instantiate prefab: {cmd.prefabPath}");
            Undo.RegisterCreatedObjectUndo(obj, "MCP Batch Instantiate Prefab");

            if (!string.IsNullOrEmpty(cmd.name))
                obj.name = cmd.name;

            if (cmd.position != null && cmd.position.Length == 3)
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);

            if (cmd.rotation != null && cmd.rotation.Length == 3)
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);

            if (cmd.scale != null && cmd.scale.Length == 3)
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);

            var parent = ResolveOptionalGameObject(cmd.parentId, cmd.parentPath);
            if (parent != null)
            {
                obj.transform.SetParent(parent.transform, true);
            }
        }

        private static void GetObjectBounds(GetBoundsCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);

            Bounds bounds = CalculateGameObjectBounds(obj);
            ExportBoundsResult(cmd.id, GetStableObjectId(obj), GetGameObjectPath(obj), true, bounds);
            Debug.Log($"[Creator Works MCP] Got bounds for {GetGameObjectPath(obj)}: size={bounds.size}, center={bounds.center}");
        }

        private static void ExportBoundsResult(string commandId, string objectId, string objectPath, bool success, Bounds? bounds)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(commandId))
                    throw new InvalidOperationException("Bounds command is missing an ID");

                var sb = new System.Text.StringBuilder();
                sb.AppendLine("{");
                sb.AppendLine($"    \"commandId\": \"{EscapeJsonString(commandId)}\",");
                sb.AppendLine($"    \"success\": {(success ? "true" : "false")},");
                sb.AppendLine($"    \"objectId\": \"{EscapeJsonString(objectId)}\",");
                sb.AppendLine($"    \"objectPath\": \"{EscapeJsonString(objectPath)}\",");
                sb.AppendLine($"    \"timestamp\": {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},");

                if (success && bounds.HasValue)
                {
                    var b = bounds.Value;
                    sb.AppendLine($"    \"bounds\": {{");
                    sb.AppendLine($"        \"center\": [{FormatJsonFloat(b.center.x)}, {FormatJsonFloat(b.center.y)}, {FormatJsonFloat(b.center.z)}],");
                    sb.AppendLine($"        \"size\": [{FormatJsonFloat(b.size.x)}, {FormatJsonFloat(b.size.y)}, {FormatJsonFloat(b.size.z)}],");
                    sb.AppendLine($"        \"min\": [{FormatJsonFloat(b.min.x)}, {FormatJsonFloat(b.min.y)}, {FormatJsonFloat(b.min.z)}],");
                    sb.AppendLine($"        \"max\": [{FormatJsonFloat(b.max.x)}, {FormatJsonFloat(b.max.y)}, {FormatJsonFloat(b.max.z)}]");
                    sb.AppendLine($"    }}");
                }
                else
                {
                    sb.AppendLine($"    \"error\": \"Object not found\"");
                }

                sb.AppendLine("}");

                WriteAtomicText(Path.Combine(BoundsResultsFolder, $"{commandId}.json"), sb.ToString());
            }
            catch (Exception e)
            {
                Debug.LogError($"[Creator Works MCP] Error exporting bounds result: {e.Message}");
            }
        }

        private static void ProcessBatchCommand(BatchCommand batchCmd)
        {
            var commandStrings = batchCmd?.commands?
                .Where(command => !string.IsNullOrWhiteSpace(command))
                .ToList() ?? new List<string>();

            if (commandStrings.Count == 0)
                throw new InvalidOperationException("Batch requires at least one command");

            PreflightBatchCommands(commandStrings);

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Creator Works MCP Batch");

            int appliedCount = 0;
            var errors = new List<string>();

            for (int index = 0; index < commandStrings.Count; index++)
            {
                try
                {
                    ExecuteBatchCommand(commandStrings[index]);
                    appliedCount++;
                }
                catch (Exception e)
                {
                    string error = $"Operation {index + 1} failed: {e.Message}";
                    errors.Add(error);
                    Debug.LogError($"[Creator Works MCP] Batch {error}");

                    if (!batchCmd.continueOnError)
                    {
                        Undo.RevertAllDownToGroup(undoGroup);
                        ExportSceneHierarchy();
                        throw new InvalidOperationException($"Batch rolled back. {error}");
                    }
                }
            }

            Undo.CollapseUndoOperations(undoGroup);
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            ExportSceneHierarchy();

            if (errors.Count > 0)
            {
                throw new InvalidOperationException(
                    $"Batch completed with {errors.Count} failed operation(s) and {appliedCount} applied operation(s): {string.Join("; ", errors)}");
            }

            Debug.Log($"[Creator Works MCP] Batch completed: {appliedCount} operations");
        }

        private static void ExecuteBatchCommand(string commandJson)
        {
            var baseCmd = JsonUtility.FromJson<MCPCommand>(commandJson);
            if (baseCmd == null || string.IsNullOrWhiteSpace(baseCmd.type))
                throw new InvalidOperationException("Batch operation is missing a command type");

            switch (baseCmd.type)
            {
                case "create_gameobject":
                    CreateGameObjectSilent(JsonUtility.FromJson<CreateGameObjectCommand>(commandJson));
                    break;
                case "delete_gameobject":
                    DeleteGameObjectSilent(JsonUtility.FromJson<DeleteGameObjectCommand>(commandJson));
                    break;
                case "modify_gameobject":
                    ModifyGameObjectSilent(JsonUtility.FromJson<ModifyGameObjectCommand>(commandJson));
                    break;
                case "instantiate_prefab":
                    InstantiatePrefabSilent(JsonUtility.FromJson<InstantiatePrefabCommand>(commandJson));
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported batch command type: {baseCmd.type}");
            }
        }

        private static void PreflightBatchCommands(List<string> commandStrings)
        {
            var plannedObjectPaths = new HashSet<string>(StringComparer.Ordinal);

            for (int index = 0; index < commandStrings.Count; index++)
            {
                try
                {
                    string commandJson = commandStrings[index];
                    var baseCmd = JsonUtility.FromJson<MCPCommand>(commandJson);
                    if (baseCmd == null || string.IsNullOrWhiteSpace(baseCmd.type))
                        throw new InvalidOperationException("Command type is required");

                    switch (baseCmd.type)
                    {
                        case "create_gameobject":
                            PreflightCreateGameObject(
                                JsonUtility.FromJson<CreateGameObjectCommand>(commandJson),
                                plannedObjectPaths);
                            break;
                        case "delete_gameobject":
                            var deleteCmd = JsonUtility.FromJson<DeleteGameObjectCommand>(commandJson);
                            ResolveGameObject(deleteCmd?.objectId, deleteCmd?.objectPath);
                            break;
                        case "modify_gameobject":
                            var modifyCmd = JsonUtility.FromJson<ModifyGameObjectCommand>(commandJson);
                            ResolveGameObject(modifyCmd?.objectId, modifyCmd?.objectPath);
                            ValidateTransformValues(modifyCmd?.position, "position");
                            ValidateTransformValues(modifyCmd?.rotation, "rotation");
                            ValidateTransformValues(modifyCmd?.scale, "scale");
                            break;
                        case "instantiate_prefab":
                            PreflightInstantiatePrefab(
                                JsonUtility.FromJson<InstantiatePrefabCommand>(commandJson),
                                plannedObjectPaths);
                            break;
                        default:
                            throw new InvalidOperationException($"Unsupported batch command type: {baseCmd.type}");
                    }
                }
                catch (Exception e)
                {
                    throw new InvalidOperationException($"Batch preflight failed at operation {index + 1}: {e.Message}");
                }
            }
        }

        private static void PreflightCreateGameObject(
            CreateGameObjectCommand cmd,
            HashSet<string> plannedObjectPaths)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.name))
                throw new InvalidOperationException("Create GameObject command requires a name");
            ValidateObjectName(cmd.name);

            if (!string.IsNullOrWhiteSpace(cmd.primitiveType))
            {
                PrimitiveType primitiveType;
                if (!Enum.TryParse(cmd.primitiveType, true, out primitiveType))
                    throw new InvalidOperationException($"Unknown primitive type: {cmd.primitiveType}");
            }

            ValidateTransformValues(cmd.position, "position");
            ValidateTransformValues(cmd.rotation, "rotation");
            ValidateTransformValues(cmd.scale, "scale");

            string parentPath = ResolveBatchParentPath(cmd.parentId, cmd.parentPath, plannedObjectPaths);
            RegisterPlannedObjectPath(parentPath, cmd.name, plannedObjectPaths);
        }

        private static void PreflightInstantiatePrefab(
            InstantiatePrefabCommand cmd,
            HashSet<string> plannedObjectPaths)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.prefabPath))
                throw new InvalidOperationException("Instantiate prefab command requires prefabPath");

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(cmd.prefabPath);
            if (prefab == null)
                throw new InvalidOperationException($"Prefab not found: {cmd.prefabPath}");

            string objectName = string.IsNullOrWhiteSpace(cmd.name) ? prefab.name : cmd.name;
            ValidateObjectName(objectName);
            ValidateTransformValues(cmd.position, "position");
            ValidateTransformValues(cmd.rotation, "rotation");
            ValidateTransformValues(cmd.scale, "scale");

            string parentPath = ResolveBatchParentPath(cmd.parentId, cmd.parentPath, plannedObjectPaths);
            RegisterPlannedObjectPath(parentPath, objectName, plannedObjectPaths);
        }

        private static string ResolveBatchParentPath(
            string parentId,
            string parentPath,
            HashSet<string> plannedObjectPaths)
        {
            if (!string.IsNullOrWhiteSpace(parentId))
                return GetGameObjectPath(ResolveGameObject(parentId, parentPath));
            if (string.IsNullOrWhiteSpace(parentPath))
                return null;
            if (plannedObjectPaths.Contains(parentPath))
                return parentPath;

            return GetGameObjectPath(ResolveGameObject(null, parentPath));
        }

        private static void RegisterPlannedObjectPath(
            string parentPath,
            string objectName,
            HashSet<string> plannedObjectPaths)
        {
            string objectPath = string.IsNullOrWhiteSpace(parentPath)
                ? objectName
                : parentPath + "/" + objectName;

            if (!plannedObjectPaths.Add(objectPath))
                throw new InvalidOperationException($"Batch would create duplicate object path: {objectPath}");

            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            bool pathAlreadyExists = Resources.FindObjectsOfTypeAll<GameObject>()
                .Any(candidate => candidate.scene == activeScene && GetGameObjectPath(candidate) == objectPath);
            if (pathAlreadyExists)
                throw new InvalidOperationException($"Object path already exists in the active scene: {objectPath}");
        }

        private static void ValidateObjectName(string objectName)
        {
            if (objectName.Contains("/"))
                throw new InvalidOperationException("GameObject names containing '/' are not supported by the bridge path contract");
        }

        private static void ValidateTransformValues(float[] values, string fieldName)
        {
            if (values == null)
                return;
            if (values.Length != 3)
                throw new InvalidOperationException($"{fieldName} must contain exactly three numbers");
            if (values.Any(value => float.IsNaN(value) || float.IsInfinity(value)))
                throw new InvalidOperationException($"{fieldName} must contain finite numbers");
        }

        /// <summary>
        /// Creates a GameObject inside the current batch Undo group.
        /// </summary>
        private static void CreateGameObjectSilent(CreateGameObjectCommand cmd)
        {
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.name))
                throw new InvalidOperationException("Create GameObject command requires a name");

            GameObject parent = ResolveOptionalGameObject(cmd.parentId, cmd.parentPath);
            GameObject obj = null;

            if (string.IsNullOrEmpty(cmd.primitiveType))
            {
                obj = new GameObject(cmd.name);
            }
            else
            {
                PrimitiveType primType;
                if (Enum.TryParse(cmd.primitiveType, true, out primType))
                {
                    obj = GameObject.CreatePrimitive(primType);
                    obj.name = cmd.name;
                }
                else
                {
                    throw new InvalidOperationException($"Unknown primitive type: {cmd.primitiveType}");
                }
            }

            Undo.RegisterCreatedObjectUndo(obj, "MCP Batch Create GameObject");

            if (cmd.position != null && cmd.position.Length == 3)
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);

            if (cmd.rotation != null && cmd.rotation.Length == 3)
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);

            if (cmd.scale != null && cmd.scale.Length == 3)
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);

            if (parent != null)
            {
                obj.transform.SetParent(parent.transform, true);
            }
        }

        private static void DeleteGameObjectSilent(DeleteGameObjectCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            Undo.DestroyObjectImmediate(obj);
        }

        private static void ModifyGameObjectSilent(ModifyGameObjectCommand cmd)
        {
            var obj = ResolveGameObject(cmd?.objectId, cmd?.objectPath);
            Undo.RecordObject(obj.transform, "MCP Batch Modify GameObject");

            if (cmd.position != null && cmd.position.Length == 3)
                obj.transform.position = new Vector3(cmd.position[0], cmd.position[1], cmd.position[2]);

            if (cmd.rotation != null && cmd.rotation.Length == 3)
                obj.transform.eulerAngles = new Vector3(cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);

            if (cmd.scale != null && cmd.scale.Length == 3)
                obj.transform.localScale = new Vector3(cmd.scale[0], cmd.scale[1], cmd.scale[2]);
        }

        private static void SetSerializedPropertyValue(SerializedProperty prop, string typedJson, string legacyValue)
        {
            bool hasTypedValue = typedJson != null;
            string scalarValue = GetScalarValue(typedJson, legacyValue, hasTypedValue);

            switch (prop.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    bool boolValue;
                    if (!bool.TryParse(scalarValue, out boolValue))
                        throw new InvalidOperationException($"Expected a boolean for {prop.propertyPath}, got: {scalarValue}");
                    prop.boolValue = boolValue;
                    break;
                case SerializedPropertyType.Integer:
                    prop.intValue = ParseInt(scalarValue, prop.propertyPath);
                    break;
                case SerializedPropertyType.Float:
                    prop.floatValue = ParseFloat(scalarValue, prop.propertyPath);
                    break;
                case SerializedPropertyType.String:
                    prop.stringValue = hasTypedValue && IsJsonString(typedJson)
                        ? ParseJsonString(typedJson)
                        : scalarValue;
                    break;
                case SerializedPropertyType.Vector2:
                    var v2 = ParseFloatArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 2, prop.propertyPath);
                    prop.vector2Value = new Vector2(v2[0], v2[1]);
                    break;
                case SerializedPropertyType.Vector3:
                    var v3 = ParseFloatArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 3, prop.propertyPath);
                    prop.vector3Value = new Vector3(v3[0], v3[1], v3[2]);
                    break;
                case SerializedPropertyType.Vector4:
                    var v4 = ParseFloatArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 4, prop.propertyPath);
                    prop.vector4Value = new Vector4(v4[0], v4[1], v4[2], v4[3]);
                    break;
                case SerializedPropertyType.Vector2Int:
                    var v2Int = ParseIntArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 2, prop.propertyPath);
                    prop.vector2IntValue = new Vector2Int(v2Int[0], v2Int[1]);
                    break;
                case SerializedPropertyType.Vector3Int:
                    var v3Int = ParseIntArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 3, prop.propertyPath);
                    prop.vector3IntValue = new Vector3Int(v3Int[0], v3Int[1], v3Int[2]);
                    break;
                case SerializedPropertyType.Quaternion:
                    var quaternion = ParseFloatArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 4, prop.propertyPath);
                    prop.quaternionValue = new Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
                    break;
                case SerializedPropertyType.Color:
                    var color = ParseFloatArray(GetStructuredValue(typedJson, legacyValue, hasTypedValue), 4, prop.propertyPath);
                    prop.colorValue = new Color(color[0], color[1], color[2], color[3]);
                    break;
                case SerializedPropertyType.Enum:
                    prop.enumValueIndex = ParseEnumValue(prop, scalarValue);
                    break;
                case SerializedPropertyType.LayerMask:
                    prop.intValue = ParseInt(scalarValue, prop.propertyPath);
                    break;
                case SerializedPropertyType.Rect:
                    prop.rectValue = ParseRect(GetStructuredValue(typedJson, legacyValue, hasTypedValue), prop.propertyPath);
                    break;
                case SerializedPropertyType.Bounds:
                    prop.boundsValue = ParseBounds(GetStructuredValue(typedJson, legacyValue, hasTypedValue), prop.propertyPath);
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported property type: {prop.propertyType}");
            }
        }

        private static string GetScalarValue(string typedJson, string legacyValue, bool hasTypedValue)
        {
            if (!hasTypedValue)
                return legacyValue;

            return IsJsonString(typedJson) ? ParseJsonString(typedJson) : typedJson;
        }

        private static string GetStructuredValue(string typedJson, string legacyValue, bool hasTypedValue)
        {
            return hasTypedValue && IsJsonString(typedJson)
                ? ParseJsonString(typedJson)
                : (hasTypedValue ? typedJson : legacyValue);
        }

        private static bool IsJsonString(string value)
        {
            return !string.IsNullOrEmpty(value) && value.TrimStart().StartsWith("\"");
        }

        private static string ParseJsonString(string json)
        {
            try
            {
                var wrapper = JsonUtility.FromJson<StringJsonValue>("{\"value\":" + json + "}");
                return wrapper?.value;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException($"Invalid JSON string value: {e.Message}");
            }
        }

        private static int ParseInt(string value, string propertyPath)
        {
            int parsed;
            if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                throw new InvalidOperationException($"Expected an integer for {propertyPath}, got: {value}");
            return parsed;
        }

        private static float ParseFloat(string value, string propertyPath)
        {
            float parsed;
            if (!float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ||
                float.IsNaN(parsed) || float.IsInfinity(parsed))
            {
                throw new InvalidOperationException($"Expected a finite number for {propertyPath}, got: {value}");
            }
            return parsed;
        }

        private static float[] ParseFloatArray(string json, int expectedLength, string propertyPath)
        {
            try
            {
                var wrapper = JsonUtility.FromJson<FloatArrayJsonValue>("{\"values\":" + json + "}");
                if (wrapper?.values == null || wrapper.values.Length != expectedLength)
                    throw new InvalidOperationException($"Expected {expectedLength} numbers for {propertyPath}");
                if (wrapper.values.Any(value => float.IsNaN(value) || float.IsInfinity(value)))
                    throw new InvalidOperationException($"Expected finite numbers for {propertyPath}");
                return wrapper.values;
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException($"Invalid numeric array for {propertyPath}: {e.Message}");
            }
        }

        private static int[] ParseIntArray(string json, int expectedLength, string propertyPath)
        {
            try
            {
                var wrapper = JsonUtility.FromJson<IntArrayJsonValue>("{\"values\":" + json + "}");
                if (wrapper?.values == null || wrapper.values.Length != expectedLength)
                    throw new InvalidOperationException($"Expected {expectedLength} integers for {propertyPath}");
                return wrapper.values;
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException($"Invalid integer array for {propertyPath}: {e.Message}");
            }
        }

        private static int ParseEnumValue(SerializedProperty prop, string value)
        {
            int index;
            if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
            {
                if (index < 0 || index >= prop.enumNames.Length)
                    throw new InvalidOperationException($"Enum index out of range for {prop.propertyPath}: {index}");
                return index;
            }

            index = Array.FindIndex(prop.enumNames, name => string.Equals(name, value, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
                index = Array.FindIndex(prop.enumDisplayNames, name => string.Equals(name, value, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
                throw new InvalidOperationException($"Unknown enum value for {prop.propertyPath}: {value}");
            return index;
        }

        private static Rect ParseRect(string json, string propertyPath)
        {
            if (json != null && json.TrimStart().StartsWith("["))
            {
                var values = ParseFloatArray(json, 4, propertyPath);
                return new Rect(values[0], values[1], values[2], values[3]);
            }

            try
            {
                var value = JsonUtility.FromJson<RectJsonValue>(json);
                if (value == null)
                    throw new InvalidOperationException($"Expected a Rect object for {propertyPath}");
                return new Rect(value.x, value.y, value.width, value.height);
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException($"Invalid Rect for {propertyPath}: {e.Message}");
            }
        }

        private static Bounds ParseBounds(string json, string propertyPath)
        {
            try
            {
                var value = JsonUtility.FromJson<BoundsJsonValue>(json);
                if (value?.center == null || value.center.Length != 3 || value.size == null || value.size.Length != 3)
                    throw new InvalidOperationException($"Bounds for {propertyPath} requires center and size arrays of length 3");
                if (value.center.Concat(value.size).Any(item => float.IsNaN(item) || float.IsInfinity(item)))
                    throw new InvalidOperationException($"Bounds for {propertyPath} requires finite numbers");
                return new Bounds(
                    new Vector3(value.center[0], value.center[1], value.center[2]),
                    new Vector3(value.size[0], value.size[1], value.size[2]));
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception e)
            {
                throw new InvalidOperationException($"Invalid Bounds for {propertyPath}: {e.Message}");
            }
        }

        private static void ExecuteShaderGraphCommand(ShaderGraphCommand cmd, ShaderGraphOperation operation)
        {
            if (cmd == null || !IsSafeCorrelationId(cmd.id))
                throw new InvalidOperationException("Shader Graph commands require a safe correlation ID");

            var result = new ShaderGraphCommandResult
            {
                commandId = cmd.id,
                success = false,
                operation = operation.ToString(),
                assetPath = cmd.assetPath,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                warnings = new List<string>()
            };

            try
            {
                if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                    throw new InvalidOperationException("Unity is compiling or importing assets. Wait for the Editor to settle.");

                switch (operation)
                {
                    case ShaderGraphOperation.Capabilities:
                        result.capabilities = ProbeShaderGraphCapabilities();
                        result.success = true;
                        break;
                    case ShaderGraphOperation.List:
                        result.capabilities = ProbeShaderGraphCapabilities();
                        result.assets = ListShaderGraphAssets(cmd.limit <= 0 ? 200 : Mathf.Clamp(cmd.limit, 1, 1000));
                        result.success = true;
                        break;
                    case ShaderGraphOperation.Inspect:
                        result.assetPath = NormalizeShaderGraphAssetPath(cmd.assetPath);
                        result.graph = InspectShaderGraph(result.assetPath, cmd.openInEditor);
                        result.success = result.graph.graphDeserialized;
                        if (!result.success)
                            result.error = "Unity could not deserialize the Shader Graph with the installed package API.";
                        break;
                    case ShaderGraphOperation.Validate:
                        result.assetPath = NormalizeShaderGraphAssetPath(cmd.assetPath);
                        result.graph = InspectShaderGraph(result.assetPath, false);
                        result.success = result.graph.validationPassed;
                        if (!result.success)
                            result.error = BuildShaderGraphValidationError(result.graph);
                        break;
                    case ShaderGraphOperation.Create:
                        CreateShaderGraphTransactional(cmd, result);
                        break;
                    case ShaderGraphOperation.AddNode:
                        MutateShaderGraphTransactional(cmd, result, ShaderGraphOperation.AddNode);
                        break;
                    case ShaderGraphOperation.Connect:
                        MutateShaderGraphTransactional(cmd, result, ShaderGraphOperation.Connect);
                        break;
                }
            }
            catch (Exception exception)
            {
                Exception actual = exception;
                while (actual is TargetInvocationException && actual.InnerException != null)
                    actual = actual.InnerException;
                result.error = actual.Message;
                result.errorType = actual.GetType().FullName;
            }

            WriteAtomicText(
                Path.Combine(ShaderGraphResultsFolder, cmd.id + ".json"),
                JsonUtility.ToJson(result, true));
            DeleteOldFiles(ShaderGraphResultsFolder, "*.json", 50);
        }

        private static ShaderGraphCapabilities ProbeShaderGraphCapabilities()
        {
            var missing = new List<string>();
            var package = UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages()
                .FirstOrDefault(item => string.Equals(item.name, "com.unity.shadergraph", StringComparison.Ordinal));
            System.Reflection.Assembly assembly = GetShaderGraphAssembly();
            Type graphData = FindLoadedType("UnityEditor.ShaderGraph.GraphData");
            Type fileUtilities = FindLoadedType("UnityEditor.ShaderGraph.FileUtilities");
            Type multiJson = FindLoadedType("UnityEditor.ShaderGraph.Serialization.MultiJson");
            Type abstractNode = FindLoadedType("UnityEditor.ShaderGraph.AbstractMaterialNode");
            Type materialSlot = FindLoadedType("UnityEditor.ShaderGraph.MaterialSlot");
            Type target = FindLoadedType("UnityEditor.ShaderGraph.Target");
            Type block = FindLoadedType("UnityEditor.ShaderGraph.BlockFieldDescriptor");
            Type category = FindLoadedType("UnityEditor.ShaderGraph.CategoryData");

            if (graphData == null) missing.Add("UnityEditor.ShaderGraph.GraphData");
            if ((fileUtilities == null || FindTryReadGraphMethod(fileUtilities) == null) &&
                (multiJson == null || FindMultiJsonDeserializeMethod(multiJson, graphData) == null))
                missing.Add("FileUtilities.TryReadGraphDataFromDisk or MultiJson.Deserialize<GraphData>");
            if (multiJson == null || FindMultiJsonSerializeMethod(multiJson, graphData) == null)
                missing.Add("MultiJson.Serialize");
            if (abstractNode == null) missing.Add("AbstractMaterialNode");
            if (materialSlot == null) missing.Add("MaterialSlot");
            if (target == null) missing.Add("Target");
            if (block == null) missing.Add("BlockFieldDescriptor");
            if (category == null || !category.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .Any(method => method.Name == "DefaultCategory" &&
                    method.GetParameters().All(parameter => parameter.IsOptional)))
                missing.Add("CategoryData.DefaultCategory(optional arguments)");

            bool canRead = graphData != null &&
                ((fileUtilities != null && FindTryReadGraphMethod(fileUtilities) != null) ||
                    (multiJson != null && FindMultiJsonDeserializeMethod(multiJson, graphData) != null));
            bool canWrite = canRead && multiJson != null &&
                FindMultiJsonSerializeMethod(multiJson, graphData) != null;
            bool canCreate = canWrite && target != null && block != null && category != null &&
                graphData.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Any(method => method.Name == "InitializeOutputs" && method.GetParameters().Length == 2) &&
                graphData.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Any(method => method.Name == "AddCategory" && method.GetParameters().Length == 1);
            bool canMutateNodes = canWrite && abstractNode != null &&
                graphData.GetMethod("AddNode", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) != null;
            bool canConnect = canMutateNodes && materialSlot != null &&
                graphData.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Any(method => method.Name == "Connect" && method.GetParameters().Length == 2) &&
                materialSlot.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Any(method => method.Name == "IsCompatibleWith" && method.GetParameters().Length == 1);

            return new ShaderGraphCapabilities
            {
                packageInstalled = package != null,
                assemblyLoaded = assembly != null,
                readSupported = canRead,
                writeSupported = canWrite,
                createSupported = canCreate,
                nodeMutationSupported = canMutateNodes,
                connectionSupported = canConnect,
                packageVersion = package?.version,
                assemblyVersion = assembly?.GetName().Version?.ToString(),
                activeRenderPipeline = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline == null
                    ? "BuiltIn"
                    : UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().FullName,
                supportedTemplates = DiscoverShaderGraphTemplates(),
                missingMembers = missing
            };
        }

        private static List<string> DiscoverShaderGraphTemplates()
        {
            var templates = new List<string>();
            if (FindLoadedType("UnityEditor.Rendering.BuiltIn.ShaderGraph.BuiltInTarget") != null)
            {
                templates.Add("built_in/unlit");
                templates.Add("built_in/lit");
            }
            if (FindLoadedType("UnityEditor.Rendering.Universal.ShaderGraph.UniversalTarget") != null)
            {
                templates.Add("urp/unlit");
                templates.Add("urp/lit");
            }
            return templates;
        }

        private static List<ShaderGraphAssetEntry> ListShaderGraphAssets(int limit)
        {
            var results = new List<ShaderGraphAssetEntry>();
            foreach (string assetPath in AssetDatabase.GetAllAssetPaths()
                .Where(path => path.StartsWith("Assets/", StringComparison.Ordinal) &&
                    path.EndsWith(".shadergraph", StringComparison.OrdinalIgnoreCase))
                .OrderBy(path => path, StringComparer.Ordinal)
                .Take(limit))
            {
                Shader shader = AssetDatabase.LoadAssetAtPath<Shader>(assetPath);
                results.Add(new ShaderGraphAssetEntry
                {
                    assetPath = assetPath,
                    guid = AssetDatabase.AssetPathToGUID(assetPath),
                    name = Path.GetFileNameWithoutExtension(assetPath),
                    dependencyHash = AssetDatabase.GetAssetDependencyHash(assetPath).ToString(),
                    hasCompileErrors = shader != null && ShaderUtil.ShaderHasError(shader)
                });
            }
            return results;
        }

        private static ShaderGraphSummary InspectShaderGraph(string assetPath, bool openInEditor)
        {
            string normalized = NormalizeShaderGraphAssetPath(assetPath);
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, normalized));
            if (!File.Exists(fullPath))
                throw new FileNotFoundException("Shader Graph asset does not exist", normalized);

            ShaderGraphCapabilities capabilities = ProbeShaderGraphCapabilities();
            if (!capabilities.readSupported)
                throw new InvalidOperationException(
                    "The installed Shader Graph package does not expose the required GraphData reader: " +
                    string.Join(", ", capabilities.missingMembers));

            AssetDatabase.ImportAsset(
                normalized,
                ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            Shader shader = AssetDatabase.LoadAssetAtPath<Shader>(normalized);
            object graph = ReadShaderGraphData(normalized);
            var summary = BuildShaderGraphSummary(normalized, graph, shader);
            if (openInEditor && shader != null)
                AssetDatabase.OpenAsset(shader);
            return summary;
        }

        private static ShaderGraphSummary BuildShaderGraphSummary(string assetPath, object graph, Shader shader)
        {
            var summary = new ShaderGraphSummary
            {
                assetPath = assetPath,
                assetGuid = AssetDatabase.AssetPathToGUID(assetPath),
                dependencyHash = AssetDatabase.GetAssetDependencyHash(assetPath).ToString(),
                contentHash = ComputeSha256(File.ReadAllBytes(Path.GetFullPath(Path.Combine(ProjectRoot, assetPath)))),
                shaderLoaded = shader != null,
                shaderName = shader?.name,
                graphDeserialized = graph != null,
                nodes = new List<ShaderGraphNodeInfo>(),
                edges = new List<ShaderGraphEdgeInfo>(),
                targets = new List<ShaderGraphTargetInfo>(),
                properties = new List<ShaderGraphPropertyInfo>(),
                diagnostics = ReadShaderDiagnostics(shader),
                warnings = new List<string>()
            };
            if (graph == null)
                return summary;

            var unknownObjects = new HashSet<object>();

            Type abstractNodeType = RequireShaderGraphType("UnityEditor.ShaderGraph.AbstractMaterialNode");
            IEnumerable nodes = InvokeGenericEnumerable(graph, "GetNodes", abstractNodeType);
            if (nodes == null)
                throw new InvalidOperationException("GraphData.GetNodes<AbstractMaterialNode>() was unavailable.");

            foreach (object node in nodes)
            {
                if (node == null)
                {
                    unknownObjects.Add("null-node:" + summary.nodes.Count);
                    continue;
                }
                ShaderGraphNodeInfo info = BuildShaderGraphNodeInfo(node);
                summary.nodes.Add(info);
                TrackUnknownShaderGraphObject(node, unknownObjects);
                foreach (ShaderGraphSlotInfo slot in info.slots)
                {
                    if (slot.type.IndexOf("Unknown", StringComparison.OrdinalIgnoreCase) >= 0)
                        unknownObjects.Add(slot.type + ":" + info.id + ":" + slot.id);
                }
                object descriptor = ReadMember(node, "descriptor");
                if (descriptor != null && ReadBoolMember(descriptor, "isUnknown"))
                    unknownObjects.Add(descriptor);
            }

            foreach (object edge in ReadEnumerableMember(graph, "edges"))
            {
                object output = ReadMember(edge, "outputSlot");
                object input = ReadMember(edge, "inputSlot");
                summary.edges.Add(new ShaderGraphEdgeInfo
                {
                    outputNodeId = ReadStringMember(ReadMember(output, "node"), "objectId"),
                    outputSlotId = ReadIntMember(output, "slotId"),
                    inputNodeId = ReadStringMember(ReadMember(input, "node"), "objectId"),
                    inputSlotId = ReadIntMember(input, "slotId")
                });
            }

            foreach (object target in ReadEnumerableMember(graph, "activeTargets"))
            {
                if (target == null)
                {
                    unknownObjects.Add("null-target:" + summary.targets.Count);
                    continue;
                }
                string type = target.GetType().FullName ?? target.GetType().Name;
                summary.targets.Add(new ShaderGraphTargetInfo
                {
                    type = type,
                    displayName = ReadStringMember(target, "displayName") ?? target.GetType().Name
                });
                TrackUnknownShaderGraphObject(target, unknownObjects);
                TrackUnknownShaderGraphObject(ReadMember(target, "activeSubTarget"), unknownObjects);
            }

            foreach (object property in ReadEnumerableMember(graph, "properties"))
            {
                if (property == null)
                {
                    unknownObjects.Add("null-property:" + summary.properties.Count);
                    continue;
                }
                string type = property.GetType().FullName ?? property.GetType().Name;
                summary.properties.Add(new ShaderGraphPropertyInfo
                {
                    id = ReadStringMember(property, "objectId"),
                    type = type,
                    displayName = ReadStringMember(property, "displayName"),
                    referenceName = ReadStringMember(property, "referenceName"),
                    exposed = ReadBoolMember(property, "isExposed") || ReadBoolMember(property, "generatePropertyBlock")
                });
                TrackUnknownShaderGraphObject(property, unknownObjects);
            }

            foreach (object target in ReadEnumerableMember(graph, "allPotentialTargets"))
            {
                TrackUnknownShaderGraphObject(target, unknownObjects);
                TrackUnknownShaderGraphObject(ReadMember(target, "activeSubTarget"), unknownObjects);
            }
            foreach (object extension in ReadEnumerableMember(graph, "SubDatas"))
                TrackUnknownShaderGraphObject(extension, unknownObjects);

            summary.nodeCount = summary.nodes.Count;
            summary.edgeCount = summary.edges.Count;
            summary.targetCount = summary.targets.Count;
            summary.propertyCount = summary.properties.Count;
            summary.unknownObjectCount = unknownObjects.Count;
            summary.hasCompileErrors = summary.diagnostics.Any(item =>
                item.severity.IndexOf("Error", StringComparison.OrdinalIgnoreCase) >= 0) ||
                (shader != null && ShaderUtil.ShaderHasError(shader));
            if (summary.targetCount == 0)
                summary.warnings.Add("The graph has no active target and cannot generate a functional shader.");
            if (summary.unknownObjectCount > 0)
                summary.warnings.Add($"The graph contains {summary.unknownObjectCount} unresolved serialized objects.");
            if (summary.hasCompileErrors)
                summary.warnings.Add("Unity reports Shader Graph compiler errors.");
            summary.validationPassed = summary.graphDeserialized && shader != null &&
                summary.targetCount > 0 && summary.unknownObjectCount == 0 && !summary.hasCompileErrors;
            return summary;
        }

        private static void TrackUnknownShaderGraphObject(object value, HashSet<object> unknownObjects)
        {
            if (value == null)
                return;
            string type = value.GetType().FullName ?? value.GetType().Name;
            if (type.IndexOf("Unknown", StringComparison.OrdinalIgnoreCase) >= 0 ||
                type.IndexOf("LegacyUnknown", StringComparison.OrdinalIgnoreCase) >= 0)
                unknownObjects.Add(value);
        }

        private static ShaderGraphNodeInfo BuildShaderGraphNodeInfo(object node)
        {
            Rect rect = ReadShaderGraphNodeRect(node);
            string type = node.GetType().FullName ?? node.GetType().Name;
            object descriptor = ReadMember(node, "descriptor");
            return new ShaderGraphNodeInfo
            {
                id = ReadStringMember(node, "objectId"),
                name = ReadStringMember(node, "name") ?? node.GetType().Name,
                type = type,
                isBlock = type.EndsWith(".BlockNode", StringComparison.Ordinal) || node.GetType().Name == "BlockNode",
                blockDescriptor = descriptor == null
                    ? null
                    : ReadStringMember(descriptor, "name") ?? ReadStringMember(descriptor, "displayName"),
                position = new[] { rect.x, rect.y, rect.width, rect.height },
                slots = ReadShaderGraphSlots(node)
            };
        }

        private static List<ShaderGraphSlotInfo> ReadShaderGraphSlots(object node)
        {
            Type slotType = RequireShaderGraphType("UnityEditor.ShaderGraph.MaterialSlot");
            Type listType = typeof(List<>).MakeGenericType(slotType);
            object list = Activator.CreateInstance(listType);
            MethodInfo method = node.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(item => item.Name == "GetSlots" && item.IsGenericMethodDefinition &&
                    item.GetParameters().Length == 1);
            if (method == null)
                throw new InvalidOperationException($"{node.GetType().FullName} does not expose GetSlots<T>.");
            method.MakeGenericMethod(slotType).Invoke(node, new[] { list });

            var slots = new List<ShaderGraphSlotInfo>();
            foreach (object slot in (IEnumerable)list)
            {
                slots.Add(new ShaderGraphSlotInfo
                {
                    id = ReadIntMember(slot, "id"),
                    name = ReadStringMember(slot, "displayName"),
                    type = slot.GetType().FullName ?? slot.GetType().Name,
                    direction = ReadBoolMember(slot, "isInputSlot") ? "input" : "output",
                    valueType = ReadMember(slot, "concreteValueType")?.ToString() ??
                        ReadMember(slot, "valueType")?.ToString()
                });
            }
            return slots;
        }

        private static List<ShaderGraphCompilerDiagnostic> ReadShaderDiagnostics(Shader shader)
        {
            var diagnostics = new List<ShaderGraphCompilerDiagnostic>();
            if (shader == null)
                return diagnostics;

            MethodInfo getMessages = typeof(ShaderUtil).GetMethod(
                "GetShaderMessages",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
                null,
                new[] { typeof(Shader) },
                null);
            var messages = getMessages?.Invoke(null, new object[] { shader }) as IEnumerable;
            if (messages == null)
                return diagnostics;

            foreach (object message in messages)
            {
                diagnostics.Add(new ShaderGraphCompilerDiagnostic
                {
                    severity = ReadMember(message, "severity")?.ToString() ?? "Unknown",
                    message = ReadStringMember(message, "message"),
                    file = ReadStringMember(message, "file"),
                    line = ReadIntMember(message, "line")
                });
                if (diagnostics.Count >= 200)
                    break;
            }
            return diagnostics;
        }

        private static void CreateShaderGraphTransactional(ShaderGraphCommand cmd, ShaderGraphCommandResult result)
        {
            string assetPath = NormalizeShaderGraphAssetPath(cmd.assetPath);
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
            bool existed = File.Exists(fullPath);
            if (existed && !cmd.overwrite)
                throw new InvalidOperationException("Shader Graph already exists. Set overwrite=true to replace it.");

            byte[] original = existed ? File.ReadAllBytes(fullPath) : null;
            result.assetPath = assetPath;
            result.originalHash = ComputeSha256(original);
            if (existed)
            {
                EnsureShaderGraphAssetIsNotOpen(assetPath);
                EnsureExpectedShaderGraphHash(cmd.expectedContentHash, result.originalHash);
            }
            try
            {
                EnsureUnityAssetFolder(Path.GetDirectoryName(assetPath).Replace('\\', '/'));
                object graph = CreateTargetedShaderGraphData(cmd.pipeline, cmd.shaderType);
                var requestedNodes = new Dictionary<string, object>(StringComparer.Ordinal);
                foreach (ShaderGraphNodeRequest request in cmd.nodes ?? Array.Empty<ShaderGraphNodeRequest>())
                {
                    if (request == null || string.IsNullOrWhiteSpace(request.id))
                        throw new InvalidOperationException("Every Shader Graph node requires a non-empty request id.");
                    if (requestedNodes.ContainsKey(request.id))
                        throw new InvalidOperationException("Duplicate Shader Graph node request id: " + request.id);
                    object node = AddShaderGraphNodeToData(graph, request.nodeType, request.position, true);
                    requestedNodes.Add(request.id, node);
                }
                foreach (ShaderGraphConnectionRequest connection in cmd.connections ?? Array.Empty<ShaderGraphConnectionRequest>())
                {
                    object source = ResolveShaderGraphNode(graph, requestedNodes, connection.from);
                    object destination = ResolveShaderGraphNode(graph, requestedNodes, connection.to);
                    ConnectShaderGraphNodeData(
                        graph,
                        source,
                        connection.fromSlot,
                        destination,
                        connection.toSlot,
                        false);
                }

                result.writeAttempted = true;
                WriteShaderGraphData(assetPath, graph);
                result.writeCompleted = true;
                result.writtenHash = ComputeSha256(File.ReadAllBytes(fullPath));
                result.graph = InspectShaderGraph(assetPath, cmd.openInEditor);
                if (!result.graph.validationPassed)
                    throw new InvalidOperationException(BuildShaderGraphValidationError(result.graph));
                result.success = true;
            }
            catch (Exception mutationException)
            {
                TryRollBackShaderGraphAsset(assetPath, original, existed, mutationException, result);
                throw;
            }
        }

        private static void MutateShaderGraphTransactional(
            ShaderGraphCommand cmd,
            ShaderGraphCommandResult result,
            ShaderGraphOperation operation)
        {
            string assetPath = NormalizeShaderGraphAssetPath(cmd.assetPath);
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
            if (!File.Exists(fullPath))
                throw new FileNotFoundException("Shader Graph asset does not exist", assetPath);

            byte[] original = File.ReadAllBytes(fullPath);
            result.assetPath = assetPath;
            result.originalHash = ComputeSha256(original);
            EnsureShaderGraphAssetIsNotOpen(assetPath);
            EnsureExpectedShaderGraphHash(cmd.expectedContentHash, result.originalHash);
            try
            {
                object graph = ReadShaderGraphData(assetPath);
                if (operation == ShaderGraphOperation.AddNode)
                {
                    ShaderGraphPoint position = cmd.hasPosition ? cmd.position : FindOpenShaderGraphPosition(graph);
                    object node = AddShaderGraphNodeToData(graph, cmd.nodeType, position, true);
                    result.mutation = new ShaderGraphMutationResult
                    {
                        nodeId = ReadStringMember(node, "objectId"),
                        nodeType = node.GetType().FullName,
                        slots = ReadShaderGraphSlots(node)
                    };
                }
                else
                {
                    object source = ResolveShaderGraphNode(graph, null, cmd.sourceNodeId);
                    object destination = ResolveShaderGraphNode(graph, null, cmd.destinationNodeId);
                    ConnectShaderGraphNodeData(
                        graph,
                        source,
                        cmd.sourceSlotId,
                        destination,
                        cmd.destinationSlotId,
                        cmd.replaceExistingInput);
                    result.mutation = new ShaderGraphMutationResult { connectionCreated = true };
                }

                result.writeAttempted = true;
                WriteShaderGraphData(assetPath, graph);
                result.writeCompleted = true;
                result.writtenHash = ComputeSha256(File.ReadAllBytes(fullPath));
                result.graph = InspectShaderGraph(assetPath, false);
                if (!result.graph.validationPassed)
                    throw new InvalidOperationException(BuildShaderGraphValidationError(result.graph));
                result.success = true;
            }
            catch (Exception mutationException)
            {
                TryRollBackShaderGraphAsset(assetPath, original, true, mutationException, result);
                throw;
            }
        }

        private static void EnsureExpectedShaderGraphHash(string expectedHash, string actualHash)
        {
            if (string.IsNullOrWhiteSpace(expectedHash) ||
                !System.Text.RegularExpressions.Regex.IsMatch(expectedHash, "^[a-fA-F0-9]{64}$"))
                throw new InvalidOperationException(
                    "Shader Graph mutation requires expectedContentHash from inspect_shader_graph.");
            if (!string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(
                    $"Shader Graph changed since inspection. Expected {expectedHash.ToLowerInvariant()}, " +
                    $"but current content hash is {actualHash}. Inspect the graph again before mutating it.");
        }

        private static void EnsureShaderGraphAssetIsNotOpen(string assetPath)
        {
            string guid = AssetDatabase.AssetPathToGUID(assetPath);
            if (string.IsNullOrEmpty(guid))
                return;
            foreach (EditorWindow window in UnityEngine.Resources.FindObjectsOfTypeAll<EditorWindow>())
            {
                if (window == null || window.GetType().FullName !=
                    "UnityEditor.ShaderGraph.Drawing.MaterialGraphEditWindow")
                    continue;
                if (string.Equals(ReadStringMember(window, "selectedGuid"), guid, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        "Close this asset's Shader Graph window before mutating it. " +
                        "This prevents overwriting unsaved or stale in-memory graph state.");
                }
            }
        }

        private static object CreateTargetedShaderGraphData(string requestedPipeline, string requestedShaderType)
        {
            ShaderGraphCapabilities capabilities = ProbeShaderGraphCapabilities();
            if (!capabilities.createSupported)
                throw new InvalidOperationException(
                    "Shader Graph creation is unavailable: " + string.Join(", ", capabilities.missingMembers));

            string pipeline = string.IsNullOrWhiteSpace(requestedPipeline)
                ? "auto"
                : requestedPipeline.Trim().ToLowerInvariant();
            string shaderType = string.IsNullOrWhiteSpace(requestedShaderType)
                ? "unlit"
                : requestedShaderType.Trim().ToLowerInvariant();
            if (shaderType != "lit" && shaderType != "unlit")
                throw new InvalidOperationException("shaderType must be 'lit' or 'unlit'.");
            if (pipeline == "auto")
            {
                string current = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline?.GetType().FullName ?? "";
                if (string.IsNullOrEmpty(current))
                    pipeline = "built_in";
                else if (current.IndexOf("Universal", StringComparison.OrdinalIgnoreCase) >= 0)
                    pipeline = "urp";
                else
                    throw new InvalidOperationException(
                        "pipeline=auto does not support the active render pipeline: " + current +
                        ". Select a supported pipeline explicitly or use inspection-only tools.");
            }
            if (pipeline != "built_in" && pipeline != "urp")
                throw new InvalidOperationException("pipeline must be 'auto', 'built_in', or 'urp'.");

            string targetName = pipeline == "urp"
                ? "UnityEditor.Rendering.Universal.ShaderGraph.UniversalTarget"
                : "UnityEditor.Rendering.BuiltIn.ShaderGraph.BuiltInTarget";
            string subTargetName = pipeline == "urp"
                ? (shaderType == "lit"
                    ? "UnityEditor.Rendering.Universal.ShaderGraph.UniversalLitSubTarget"
                    : "UnityEditor.Rendering.Universal.ShaderGraph.UniversalUnlitSubTarget")
                : (shaderType == "lit"
                    ? "UnityEditor.Rendering.BuiltIn.ShaderGraph.BuiltInLitSubTarget"
                    : "UnityEditor.Rendering.BuiltIn.ShaderGraph.BuiltInUnlitSubTarget");
            Type targetType = FindLoadedType(targetName);
            Type subTargetType = FindLoadedType(subTargetName);
            if (targetType == null || subTargetType == null)
                throw new InvalidOperationException(
                    $"The installed packages do not provide the requested {pipeline}/{shaderType} Shader Graph target.");

            object target = Activator.CreateInstance(targetType, true);
            MethodInfo setSubTarget = targetType.GetMethod(
                "TrySetActiveSubTarget",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null,
                new[] { typeof(Type) },
                null);
            if (setSubTarget == null || !(bool)setSubTarget.Invoke(target, new object[] { subTargetType }))
                throw new InvalidOperationException("Shader Graph rejected the requested active sub-target.");

            Type targetBase = RequireShaderGraphType("UnityEditor.ShaderGraph.Target");
            Array targets = Array.CreateInstance(targetBase, 1);
            targets.SetValue(target, 0);
            Array blocks = BuildShaderGraphBlockDescriptors(shaderType);

            Type graphType = RequireShaderGraphType("UnityEditor.ShaderGraph.GraphData");
            object graph = Activator.CreateInstance(graphType, true);
            InvokeRequired(graph, "AddContexts");
            InvokeRequired(graph, "InitializeOutputs", targets, blocks);
            TryAddDefaultShaderGraphCategory(graph);
            SetMember(graph, "path", "Shader Graphs");
            return graph;
        }

        private static Array BuildShaderGraphBlockDescriptors(string shaderType)
        {
            Type blockType = RequireShaderGraphType("UnityEditor.ShaderGraph.BlockFieldDescriptor");
            Type blockFields = RequireShaderGraphType("UnityEditor.ShaderGraph.BlockFields");
            var names = new List<string>
            {
                "VertexDescription.Position",
                "VertexDescription.Normal",
                "VertexDescription.Tangent",
                "SurfaceDescription.BaseColor"
            };
            if (shaderType == "lit")
            {
                names.AddRange(new[]
                {
                    "SurfaceDescription.NormalTS",
                    "SurfaceDescription.Metallic",
                    "SurfaceDescription.Smoothness",
                    "SurfaceDescription.Emission",
                    "SurfaceDescription.Occlusion"
                });
            }

            Array blocks = Array.CreateInstance(blockType, names.Count);
            for (int index = 0; index < names.Count; index++)
            {
                string[] parts = names[index].Split('.');
                Type nested = blockFields.GetNestedType(parts[0], BindingFlags.Public | BindingFlags.NonPublic);
                FieldInfo field = nested?.GetField(parts[1], BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                object descriptor = field?.GetValue(null);
                if (descriptor == null)
                    throw new InvalidOperationException("Shader Graph block descriptor is unavailable: " + names[index]);
                blocks.SetValue(descriptor, index);
            }
            return blocks;
        }

        private static void TryAddDefaultShaderGraphCategory(object graph)
        {
            Type categoryType = FindLoadedType("UnityEditor.ShaderGraph.CategoryData");
            const BindingFlags staticFlags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            const BindingFlags instanceFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            MethodInfo defaultCategory = categoryType?.GetMethods(staticFlags)
                .Where(method => method.Name == "DefaultCategory")
                .OrderBy(method => method.GetParameters().Length)
                .FirstOrDefault(method => method.GetParameters().All(parameter => parameter.IsOptional));
            if (defaultCategory == null)
                throw new InvalidOperationException("Shader Graph CategoryData.DefaultCategory is unavailable.");

            object category = defaultCategory.Invoke(
                null,
                defaultCategory.GetParameters()
                    .Select(parameter => parameter.DefaultValue == DBNull.Value ? Type.Missing : parameter.DefaultValue)
                    .ToArray());
            MethodInfo addCategory = graph.GetType().GetMethods(instanceFlags)
                .FirstOrDefault(method =>
                    method.Name == "AddCategory" &&
                    method.GetParameters().Length == 1 &&
                    method.GetParameters()[0].ParameterType.IsInstanceOfType(category));
            if (addCategory == null)
                throw new InvalidOperationException("Shader Graph GraphData.AddCategory is unavailable.");
            addCategory.Invoke(graph, new[] { category });
        }

        private static object AddShaderGraphNodeToData(
            object graph,
            string nodeTypeName,
            ShaderGraphPoint position,
            bool positionRequired)
        {
            Type nodeType = ResolveShaderGraphNodeType(nodeTypeName);
            if (nodeType == null)
                throw new InvalidOperationException("Unknown or unsupported Shader Graph node type: " + nodeTypeName);
            object node = Activator.CreateInstance(nodeType, true);
            InvokeOptional(node, "UpdateNodeAfterDeserialization");
            SetShaderGraphNodePosition(node, positionRequired ? position : null);
            InvokeRequired(graph, "AddNode", node);
            InvokeOptional(node, "UpdateNodeAfterDeserialization");
            string objectId = ReadStringMember(node, "objectId");
            if (string.IsNullOrEmpty(objectId))
                throw new InvalidOperationException("Shader Graph did not assign an object ID to the new node.");
            return node;
        }

        private static Type ResolveShaderGraphNodeType(string requested)
        {
            if (string.IsNullOrWhiteSpace(requested))
                return null;
            Type baseType = RequireShaderGraphType("UnityEditor.ShaderGraph.AbstractMaterialNode");
            Type exact = FindLoadedType(requested.Trim());
            if (exact != null && !exact.IsAbstract && baseType.IsAssignableFrom(exact))
                return exact;

            string normalized = new string(requested.Where(char.IsLetterOrDigit).ToArray());
            if (!normalized.EndsWith("Node", StringComparison.OrdinalIgnoreCase))
                normalized += "Node";
            var matches = new List<Type>();
            foreach (System.Reflection.Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                foreach (Type candidate in GetLoadableTypes(assembly))
                {
                    if (candidate == null || candidate.IsAbstract || !baseType.IsAssignableFrom(candidate))
                        continue;
                    if (string.Equals(candidate.Name, normalized, StringComparison.OrdinalIgnoreCase))
                    {
                        matches.Add(candidate);
                        continue;
                    }
                    string candidateLabel = new string(candidate.Name.Where(char.IsLetterOrDigit).ToArray());
                    if (string.Equals(candidateLabel, normalized, StringComparison.OrdinalIgnoreCase))
                        matches.Add(candidate);
                }
            }
            matches = matches.Distinct().OrderBy(type => type.FullName, StringComparer.Ordinal).ToList();
            if (matches.Count > 1)
            {
                throw new InvalidOperationException(
                    "Shader Graph node name is ambiguous. Use one of these fully-qualified types: " +
                    string.Join(", ", matches.Select(type => type.FullName)));
            }
            return matches.SingleOrDefault();
        }

        private static object ResolveShaderGraphNode(
            object graph,
            Dictionary<string, object> requestedNodes,
            string selector)
        {
            if (string.IsNullOrWhiteSpace(selector))
                throw new InvalidOperationException("Shader Graph connections require node selectors.");
            if (requestedNodes != null && requestedNodes.TryGetValue(selector, out object requested))
                return requested;

            Type abstractNode = RequireShaderGraphType("UnityEditor.ShaderGraph.AbstractMaterialNode");
            IEnumerable nodes = InvokeGenericEnumerable(graph, "GetNodes", abstractNode);
            string blockName = selector.StartsWith("block:", StringComparison.OrdinalIgnoreCase)
                ? selector.Substring("block:".Length)
                : null;
            foreach (object node in nodes)
            {
                if (string.Equals(ReadStringMember(node, "objectId"), selector, StringComparison.Ordinal))
                    return node;
                if (blockName != null)
                {
                    object descriptor = ReadMember(node, "descriptor");
                    string name = ReadStringMember(descriptor, "name") ?? ReadStringMember(descriptor, "displayName");
                    if (string.Equals(name, blockName, StringComparison.OrdinalIgnoreCase))
                        return node;
                }
            }
            throw new InvalidOperationException("Shader Graph node was not found: " + selector);
        }

        private static void ConnectShaderGraphNodeData(
            object graph,
            object sourceNode,
            int sourceSlotId,
            object destinationNode,
            int destinationSlotId,
            bool replaceExistingInput)
        {
            object sourceSlot = FindShaderGraphSlot(sourceNode, sourceSlotId);
            object destinationSlot = FindShaderGraphSlot(destinationNode, destinationSlotId);
            if (!ReadBoolMember(sourceSlot, "isOutputSlot"))
                throw new InvalidOperationException($"Source slot {sourceSlotId} is not an output slot.");
            if (!ReadBoolMember(destinationSlot, "isInputSlot"))
                throw new InvalidOperationException($"Destination slot {destinationSlotId} is not an input slot.");

            MethodInfo compatible = sourceSlot.GetType()
                .GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method =>
                    method.Name == "IsCompatibleWith" &&
                    method.GetParameters().Length == 1 &&
                    method.GetParameters()[0].ParameterType.IsInstanceOfType(destinationSlot));
            if (compatible != null && !(bool)compatible.Invoke(sourceSlot, new[] { destinationSlot }))
                throw new InvalidOperationException("Shader Graph rejected the connection because the slots are incompatible.");

            object sourceReference = ReadMember(sourceSlot, "slotReference");
            object destinationReference = ReadMember(destinationSlot, "slotReference");
            bool destinationOccupied = ReadEnumerableMember(graph, "edges").Cast<object>().Any(edge =>
            {
                object input = ReadMember(edge, "inputSlot");
                return ReferenceEquals(ReadMember(input, "node"), destinationNode) &&
                    ReadIntMember(input, "slotId") == destinationSlotId;
            });
            if (destinationOccupied && !replaceExistingInput)
            {
                throw new InvalidOperationException(
                    $"Destination input slot {destinationSlotId} already has a connection. " +
                    "Set replaceExistingInput=true only if replacing that edge is intentional.");
            }
            MethodInfo connect = graph.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method => method.Name == "Connect" && method.GetParameters().Length == 2 &&
                    method.GetParameters()[0].ParameterType.IsInstanceOfType(sourceReference) &&
                    method.GetParameters()[1].ParameterType.IsInstanceOfType(destinationReference));
            if (connect == null)
                throw new InvalidOperationException("GraphData.Connect(SlotReference, SlotReference) is unavailable.");
            object edge = connect.Invoke(graph, new[] { sourceReference, destinationReference });
            if (edge == null)
                throw new InvalidOperationException("Shader Graph did not create the requested connection.");
            InvokeOptional(graph, "ValidateGraph");
        }

        private static object FindShaderGraphSlot(object node, int slotId)
        {
            Type slotType = RequireShaderGraphType("UnityEditor.ShaderGraph.MaterialSlot");
            Type listType = typeof(List<>).MakeGenericType(slotType);
            object list = Activator.CreateInstance(listType);
            MethodInfo method = node.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(item => item.Name == "GetSlots" && item.IsGenericMethodDefinition &&
                    item.GetParameters().Length == 1);
            method?.MakeGenericMethod(slotType).Invoke(node, new[] { list });
            foreach (object slot in (IEnumerable)list)
            {
                if (ReadIntMember(slot, "id") == slotId)
                    return slot;
            }
            throw new InvalidOperationException($"Slot {slotId} was not found on node {ReadStringMember(node, "objectId")}.");
        }

        private static ShaderGraphPoint FindOpenShaderGraphPosition(object graph)
        {
            Type abstractNode = RequireShaderGraphType("UnityEditor.ShaderGraph.AbstractMaterialNode");
            var occupied = new List<Rect>();
            foreach (object node in InvokeGenericEnumerable(graph, "GetNodes", abstractNode))
                occupied.Add(ReadShaderGraphNodeRect(node));

            float x = occupied.Count == 0 ? 0 : Mathf.Ceil(occupied.Max(rect => rect.xMax) / 24f) * 24f + 96f;
            float y = 0;
            var candidate = new Rect(x, y, 240, 144);
            while (occupied.Any(rect => RectsOverlapWithPadding(candidate, rect, 24f)))
            {
                y += 192f;
                candidate.y = y;
            }
            return new ShaderGraphPoint { x = x, y = y };
        }

        private static bool RectsOverlapWithPadding(Rect left, Rect right, float padding)
        {
            return left.xMin < right.xMax + padding && left.xMax + padding > right.xMin &&
                left.yMin < right.yMax + padding && left.yMax + padding > right.yMin;
        }

        private static Rect ReadShaderGraphNodeRect(object node)
        {
            object drawState = ReadMember(node, "drawState");
            object position = ReadMember(drawState, "position");
            return position is Rect ? (Rect)position : new Rect(0, 0, 240, 144);
        }

        private static void SetShaderGraphNodePosition(object node, ShaderGraphPoint position)
        {
            if (position == null || float.IsNaN(position.x) || float.IsInfinity(position.x) ||
                float.IsNaN(position.y) || float.IsInfinity(position.y))
            {
                throw new InvalidOperationException("Shader Graph node positions must contain finite x and y values.");
            }

            System.Reflection.PropertyInfo drawStateProperty = node.GetType().GetProperty(
                "drawState",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (drawStateProperty == null || !drawStateProperty.CanWrite)
                throw new InvalidOperationException("Shader Graph node drawState is unavailable.");
            object drawState = drawStateProperty.GetValue(node);
            Rect current = ReadMember(drawState, "position") is Rect
                ? (Rect)ReadMember(drawState, "position")
                : new Rect(0, 0, 240, 144);
            SetMember(drawState, "position", new Rect(position.x, position.y, current.width, current.height));
            drawStateProperty.SetValue(node, drawState);
        }

        private static object ReadShaderGraphData(string assetPath)
        {
            Type fileUtilities = FindLoadedType("UnityEditor.ShaderGraph.FileUtilities");
            MethodInfo reader = FindTryReadGraphMethod(fileUtilities);
            if (reader != null)
            {
                object[] args = { assetPath, null };
                bool read = (bool)reader.Invoke(null, args);
                if (!read || args[1] == null)
                    throw new InvalidOperationException("Shader Graph MultiJson deserialization failed.");
                return args[1];
            }

            Type graphType = RequireShaderGraphType("UnityEditor.ShaderGraph.GraphData");
            Type multiJson = RequireShaderGraphType("UnityEditor.ShaderGraph.Serialization.MultiJson");
            MethodInfo deserialize = FindMultiJsonDeserializeMethod(multiJson, graphType);
            if (deserialize == null)
                throw new InvalidOperationException(
                    "Neither FileUtilities.TryReadGraphDataFromDisk nor MultiJson.Deserialize<GraphData> is available.");

            object graph = Activator.CreateInstance(graphType, true);
            SetMember(graph, "assetGuid", AssetDatabase.AssetPathToGUID(assetPath));
            Type messageManager = FindLoadedType("UnityEditor.ShaderGraph.MessageManager");
            if (messageManager != null)
                SetMember(graph, "messageManager", Activator.CreateInstance(messageManager, true));
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
            string contents = File.ReadAllText(fullPath, Encoding.UTF8);
            MethodInfo closedDeserialize = deserialize.MakeGenericMethod(graphType);
            object[] deserializeArgs = closedDeserialize.GetParameters()
                .Select((parameter, index) => index == 0
                    ? graph
                    : index == 1
                        ? contents
                        : parameter.DefaultValue == DBNull.Value ? Type.Missing : parameter.DefaultValue)
                .ToArray();
            closedDeserialize.Invoke(null, deserializeArgs);
            InvokeOptional(graph, "OnEnable");
            InvokeOptional(graph, "ValidateGraph");
            return graph;
        }

        private static void WriteShaderGraphData(string assetPath, object graph)
        {
            Type multiJson = RequireShaderGraphType("UnityEditor.ShaderGraph.Serialization.MultiJson");
            MethodInfo serialize = FindMultiJsonSerializeMethod(multiJson, graph.GetType());
            if (serialize == null)
                throw new InvalidOperationException("MultiJson.Serialize(GraphData) is unavailable.");
            string contents = serialize.Invoke(null, new[] { graph }) as string;
            if (string.IsNullOrWhiteSpace(contents))
                throw new InvalidOperationException("Shader Graph serialization produced no content.");

            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
            WriteAtomicText(fullPath, contents);
            AssetDatabase.ImportAsset(
                assetPath,
                ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        }

        private static void TryRollBackShaderGraphAsset(
            string assetPath,
            byte[] original,
            bool existed,
            Exception mutationException,
            ShaderGraphCommandResult result)
        {
            try
            {
                RollBackShaderGraphAsset(assetPath, original, existed);
                result.rolledBack = true;
            }
            catch (Exception rollbackException)
            {
                result.rollbackError = rollbackException.Message;
                throw new InvalidOperationException(
                    $"Shader Graph mutation failed: {mutationException.Message} " +
                    $"Rollback also failed: {rollbackException.Message}",
                    new AggregateException(mutationException, rollbackException));
            }
        }

        private static void RollBackShaderGraphAsset(string assetPath, byte[] original, bool existed)
        {
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
            if (existed && original != null)
            {
                WriteAtomicBytes(fullPath, original);
                string restoredHash = ComputeSha256(File.ReadAllBytes(fullPath));
                string expectedHash = ComputeSha256(original);
                if (!string.Equals(restoredHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Restored Shader Graph bytes did not match the original SHA-256 hash.");
                AssetDatabase.ImportAsset(
                    assetPath,
                    ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            }
            else
            {
                string metaPath = fullPath + ".meta";
                bool deletedByAssetDatabase = AssetDatabase.DeleteAsset(assetPath);
                if (!deletedByAssetDatabase && File.Exists(fullPath))
                    File.Delete(fullPath);
                if (!deletedByAssetDatabase && File.Exists(metaPath))
                    File.Delete(metaPath);
                if (File.Exists(fullPath) || File.Exists(metaPath))
                    throw new IOException("New Shader Graph asset or metadata remained after rollback.");
            }
        }

        private static string BuildShaderGraphValidationError(ShaderGraphSummary graph)
        {
            if (graph == null || !graph.graphDeserialized)
                return "Unity could not deserialize the Shader Graph.";
            if (graph.targetCount == 0)
                return "Shader Graph has no active target.";
            if (!graph.shaderLoaded)
                return "Shader Graph import did not produce a loadable Shader asset.";
            if (graph.unknownObjectCount > 0)
                return $"Shader Graph contains {graph.unknownObjectCount} unresolved serialized objects.";
            ShaderGraphCompilerDiagnostic firstError = graph.diagnostics?.FirstOrDefault(item =>
                item.severity.IndexOf("Error", StringComparison.OrdinalIgnoreCase) >= 0);
            if (firstError != null)
                return "Shader Graph compilation failed: " + firstError.message;
            if (graph.hasCompileErrors)
                return "Unity reports Shader Graph compiler errors.";
            return "Shader Graph validation did not pass.";
        }

        private static string NormalizeShaderGraphAssetPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 1024)
                throw new InvalidOperationException("assetPath is required and must be at most 1024 characters.");
            string normalized = value.Trim().Replace('\\', '/');
            if (!normalized.StartsWith("Assets/", StringComparison.Ordinal) ||
                !normalized.EndsWith(".shadergraph", StringComparison.OrdinalIgnoreCase) ||
                normalized.Split('/').Any(part => part == ".." || part.Length == 0))
            {
                throw new InvalidOperationException("assetPath must be a normalized Assets/... path ending in .shadergraph.");
            }
            string fullPath = Path.GetFullPath(Path.Combine(ProjectRoot, normalized));
            string assetsRoot = Path.GetFullPath(Application.dataPath).TrimEnd(Path.DirectorySeparatorChar) +
                Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(assetsRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Shader Graph assetPath escaped the project's Assets folder.");
            return normalized;
        }

        private static void EnsureUnityAssetFolder(string assetFolder)
        {
            if (string.IsNullOrEmpty(assetFolder) || assetFolder == "Assets")
                return;
            string[] parts = assetFolder.Split('/');
            string current = parts[0];
            for (int index = 1; index < parts.Length; index++)
            {
                string next = current + "/" + parts[index];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    string guid = AssetDatabase.CreateFolder(current, parts[index]);
                    if (string.IsNullOrEmpty(guid))
                        throw new InvalidOperationException("Could not create Shader Graph folder: " + next);
                }
                current = next;
            }
        }

        private static System.Reflection.Assembly GetShaderGraphAssembly()
        {
            System.Reflection.Assembly assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(item =>
                string.Equals(item.GetName().Name, "Unity.ShaderGraph.Editor", StringComparison.Ordinal));
            if (assembly != null)
                return assembly;
            try
            {
                return System.Reflection.Assembly.Load("Unity.ShaderGraph.Editor");
            }
            catch
            {
                return null;
            }
        }

        private static Type FindLoadedType(string fullName)
        {
            foreach (System.Reflection.Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type = assembly.GetType(fullName, false);
                if (type != null)
                    return type;
            }
            GetShaderGraphAssembly();
            foreach (System.Reflection.Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type = assembly.GetType(fullName, false);
                if (type != null)
                    return type;
            }
            return null;
        }

        private static Type RequireShaderGraphType(string fullName)
        {
            Type type = FindLoadedType(fullName);
            if (type == null)
                throw new InvalidOperationException("Shader Graph API type is unavailable: " + fullName);
            return type;
        }

        private static Type[] GetLoadableTypes(System.Reflection.Assembly assembly)
        {
            try
            {
                return assembly.GetTypes();
            }
            catch (ReflectionTypeLoadException exception)
            {
                return exception.Types.Where(type => type != null).ToArray();
            }
            catch
            {
                return Array.Empty<Type>();
            }
        }

        private static MethodInfo FindTryReadGraphMethod(Type fileUtilities)
        {
            return fileUtilities?.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method => method.Name == "TryReadGraphDataFromDisk" &&
                    method.GetParameters().Length == 2 && method.GetParameters()[1].IsOut);
        }

        private static MethodInfo FindMultiJsonDeserializeMethod(Type multiJson, Type graphType)
        {
            if (multiJson == null || graphType == null)
                return null;

            return multiJson.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method => method.Name == "Deserialize" &&
                    method.IsGenericMethodDefinition && method.GetGenericArguments().Length == 1 &&
                    method.GetParameters().Length >= 2 &&
                    method.GetParameters()[0].ParameterType.IsGenericParameter &&
                    method.GetParameters()[1].ParameterType == typeof(string) &&
                    method.GetParameters().Skip(2).All(parameter => parameter.IsOptional));
        }

        private static MethodInfo FindMultiJsonSerializeMethod(Type multiJson, Type graphType)
        {
            if (multiJson == null || graphType == null)
                return null;
            return multiJson.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method => method.Name == "Serialize" && method.GetParameters().Length == 1 &&
                    method.GetParameters()[0].ParameterType.IsAssignableFrom(graphType));
        }

        private static IEnumerable InvokeGenericEnumerable(object target, string methodName, Type genericType)
        {
            MethodInfo method = target.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(item => item.Name == methodName && item.IsGenericMethodDefinition &&
                    item.GetGenericArguments().Length == 1 && item.GetParameters().Length == 0);
            return method?.MakeGenericMethod(genericType).Invoke(target, null) as IEnumerable;
        }

        private static IEnumerable ReadEnumerableMember(object target, string name)
        {
            return ReadMember(target, name) as IEnumerable ?? Array.Empty<object>();
        }

        private static object ReadMember(object target, string name)
        {
            if (target == null)
                return null;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Static |
                BindingFlags.Public | BindingFlags.NonPublic;
            Type type = target as Type ?? target.GetType();
            object instance = target is Type ? null : target;
            System.Reflection.PropertyInfo property = type.GetProperty(name, flags);
            if (property != null && property.GetIndexParameters().Length == 0)
                return property.GetValue(instance);
            FieldInfo field = type.GetField(name, flags) ?? type.GetField("m_" + char.ToUpperInvariant(name[0]) + name.Substring(1), flags);
            return field?.GetValue(instance);
        }

        private static void SetMember(object target, string name, object value)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            Type type = target.GetType();
            System.Reflection.PropertyInfo property = type.GetProperty(name, flags);
            if (property != null && property.CanWrite)
            {
                property.SetValue(target, value);
                return;
            }
            FieldInfo field = type.GetField(name, flags) ?? type.GetField("m_" + char.ToUpperInvariant(name[0]) + name.Substring(1), flags);
            if (field == null)
                throw new InvalidOperationException($"{type.FullName}.{name} is unavailable.");
            field.SetValue(target, value);
        }

        private static string ReadStringMember(object target, string name)
        {
            return ReadMember(target, name)?.ToString();
        }

        private static int ReadIntMember(object target, string name)
        {
            object value = ReadMember(target, name);
            return value == null ? 0 : Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }

        private static bool ReadBoolMember(object target, string name)
        {
            object value = ReadMember(target, name);
            return value != null && Convert.ToBoolean(value, CultureInfo.InvariantCulture);
        }

        private static object InvokeRequired(object target, string methodName, params object[] args)
        {
            MethodInfo method = FindCompatibleMethod(target.GetType(), methodName, args);
            if (method == null)
                throw new InvalidOperationException($"{target.GetType().FullName}.{methodName} is unavailable.");
            return method.Invoke(target, args);
        }

        private static object InvokeOptional(object target, string methodName, params object[] args)
        {
            MethodInfo method = FindCompatibleMethod(target.GetType(), methodName, args);
            return method?.Invoke(target, args);
        }

        private static MethodInfo FindCompatibleMethod(Type type, string name, object[] args)
        {
            return type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(method => method.Name == name && method.GetParameters().Length == args.Length &&
                    method.GetParameters().Select((parameter, index) =>
                        args[index] == null || parameter.ParameterType.IsInstanceOfType(args[index])).All(matches => matches));
        }

        private static string ComputeSha256(byte[] bytes)
        {
            if (bytes == null)
                return null;
            using (var sha = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }

        #endregion

        #region State Export

        private static void WriteAtomicText(string destinationPath, string contents)
        {
            string temporaryPath = destinationPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporaryPath, contents);

                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        if (File.Exists(destinationPath))
                            File.Replace(temporaryPath, destinationPath, null);
                        else
                            File.Move(temporaryPath, destinationPath);
                        return;
                    }
                    catch (IOException) when (attempt < 8)
                    {
                        // A polling MCP reader can hold the previous file for a few milliseconds on Windows.
                        System.Threading.Thread.Sleep(25);
                    }
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
            }
        }

        private static void WriteAtomicBytes(string destinationPath, byte[] contents)
        {
            string temporaryPath = destinationPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(temporaryPath, contents);

                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        if (File.Exists(destinationPath))
                            File.Replace(temporaryPath, destinationPath, null);
                        else
                            File.Move(temporaryPath, destinationPath);
                        return;
                    }
                    catch (IOException) when (attempt < 8)
                    {
                        System.Threading.Thread.Sleep(25);
                    }
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
            }
        }

        private static void DeleteOldFiles(string folder, string searchPattern, int filesToKeep)
        {
            try
            {
                foreach (var file in new DirectoryInfo(folder)
                    .GetFiles(searchPattern)
                    .OrderByDescending(candidate => candidate.LastWriteTimeUtc)
                    .Skip(filesToKeep))
                {
                    file.Delete();
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Creator Works MCP] Could not prune old result files in {folder}: {e.Message}");
            }
        }

        private static string FormatJsonFloat(float value)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        private static void ExportProjectState()
        {
            using (FullStateExportProfilerMarker.Auto())
            {
                ExportSceneHierarchy();
                ExportEditorState();
                ExportConsoleLogs();
            }
        }

        private static void ExportSceneHierarchy()
        {
            try
            {
                var hierarchy = new SceneHierarchy();
                hierarchy.sceneName = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name;
                hierarchy.scenePath = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;
                hierarchy.objects = new List<GameObjectInfo>();

                // Get all root objects
                var rootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();

                foreach (var obj in rootObjects)
                {
                    AddObjectToHierarchy(obj, hierarchy.objects, 0);
                }

                hierarchy.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                string json = JsonUtility.ToJson(hierarchy, true);
                WriteAtomicText(Path.Combine(StateFolder, "scene-hierarchy.json"), json);
            }
            catch (Exception e)
            {
                Debug.LogError($"[Creator Works MCP] Error exporting hierarchy: {e.Message}");
            }
        }

        private static void AddObjectToHierarchy(GameObject obj, List<GameObjectInfo> list, int depth)
        {
            list.Add(CreateGameObjectInfo(obj, depth));

            // Recurse into children (limit depth to prevent huge exports)
            if (depth < 10)
            {
                foreach (Transform child in obj.transform)
                {
                    AddObjectToHierarchy(child.gameObject, list, depth + 1);
                }
            }
        }

        private static GameObjectInfo CreateGameObjectInfo(GameObject obj, int depth, Component[] includedComponents = null, string[] includedPropertyNames = null, bool includeComponentProperties = true)
        {
            var info = new GameObjectInfo
            {
                name = obj.name,
                globalObjectId = GetStableObjectId(obj),
                path = GetGameObjectPath(obj),
                active = obj.activeSelf,
                layer = obj.layer,
                tag = obj.tag,
                depth = depth,
                // Transform data
                position = new float[] {
                    obj.transform.position.x,
                    obj.transform.position.y,
                    obj.transform.position.z
                },
                rotation = new float[] {
                    obj.transform.eulerAngles.x,
                    obj.transform.eulerAngles.y,
                    obj.transform.eulerAngles.z
                },
                scale = new float[] {
                    obj.transform.localScale.x,
                    obj.transform.localScale.y,
                    obj.transform.localScale.z
                },
                localPosition = new float[] {
                    obj.transform.localPosition.x,
                    obj.transform.localPosition.y,
                    obj.transform.localPosition.z
                },
                localRotation = new float[] {
                    obj.transform.localEulerAngles.x,
                    obj.transform.localEulerAngles.y,
                    obj.transform.localEulerAngles.z
                },
                localScale = new float[] {
                    obj.transform.localScale.x,
                    obj.transform.localScale.y,
                    obj.transform.localScale.z
                },
                components = new List<ComponentInfo>()
            };

            // Serialize all components with their properties
            var components = includedComponents ?? obj.GetComponents<Component>();
            foreach (var comp in components)
            {
                if (comp != null)
                {
                    info.components.Add(SerializeComponent(comp, includedPropertyNames, includeComponentProperties));
                }
            }
            return info;
        }

        private static ComponentInfo SerializeComponent(Component comp, string[] includedPropertyNames = null, bool includeProperties = true)
        {
            var info = new ComponentInfo
            {
                type = comp.GetType().Name,
                fullType = comp.GetType().FullName,
                globalObjectId = GetStableObjectId(comp),
                properties = new List<PropertyInfo>()
            };
            if (!includeProperties) return info;

            string[] requested = includedPropertyNames == null ? new string[0] :
                includedPropertyNames.Distinct(StringComparer.Ordinal).ToArray();
            if (requested.Length > 0) info.missingProperties = new List<string>();

            try
            {
                using (var so = new SerializedObject(comp))
                {
                if (requested.Length > 0)
                {
                    foreach (string name in requested)
                    {
                        PropertyInfo value = null;
                        if (comp is Renderer renderer)
                        {
                            if (string.Equals(name, "enabled", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(name, "m_Enabled", StringComparison.OrdinalIgnoreCase))
                                value = new PropertyInfo { name = name, type = "Boolean", value = renderer.enabled ? "true" : "false" };
                            else if (string.Equals(name, "materials", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(name, "sharedMaterials", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(name, "m_Materials", StringComparison.OrdinalIgnoreCase))
                            {
                                value = CreateRendererMaterialProperty(renderer);
                                value.name = name;
                            }
                        }
                        // FindProperty includes hidden and nested serialized fields skipped by NextVisible.
                        if (value == null && name != "m_Script" && name != "m_ObjectHideFlags")
                        {
                            var selected = so.FindProperty(name);
                            if (selected != null) value = new PropertyInfo {
                                name = name, propertyPath = selected.propertyPath,
                                type = selected.propertyType.ToString(), value = GetSerializedPropertyValue(selected)
                            };
                        }
                        if (value == null) info.missingProperties.Add(name);
                        else info.properties.Add(value);
                    }
                    return info;
                }
                var prop = so.GetIterator();
                bool enterChildren = true;

                while (prop.NextVisible(enterChildren))
                {
                    enterChildren = false;

                    // Skip some internal properties
                    if (prop.name == "m_Script" || prop.name == "m_ObjectHideFlags")
                        continue;
                    info.properties.Add(new PropertyInfo
                    {
                        name = prop.name,
                        type = prop.propertyType.ToString(),
                        value = GetSerializedPropertyValue(prop)
                    });
                }

                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Creator Works MCP] Could not serialize component {comp.GetType().Name}: {e.Message}");
                if (requested.Length > 0)
                    info.missingProperties = requested.Where(name => !info.properties.Any(property => property.name == name)).ToList();
            }

            return info;
        }

        private static PropertyInfo CreateRendererMaterialProperty(Renderer renderer)
        {
            Material[] sharedMaterials = renderer.sharedMaterials ?? new Material[0];
            var summary = new RendererMaterialSummary
            {
                totalCount = sharedMaterials.Length,
                truncated = sharedMaterials.Length > 64,
                materials = new List<MaterialReferenceInfo>()
            };

            foreach (Material material in sharedMaterials.Take(64))
            {
                string assetPath = material != null ? AssetDatabase.GetAssetPath(material) : null;
                summary.materials.Add(new MaterialReferenceInfo
                {
                    name = material != null ? material.name : null,
                    assetPath = string.IsNullOrWhiteSpace(assetPath) ? null : assetPath,
                    assetGuid = string.IsNullOrWhiteSpace(assetPath) ? null : AssetDatabase.AssetPathToGUID(assetPath),
                    shader = material != null && material.shader != null ? material.shader.name : null
                });
            }

            return new PropertyInfo
            {
                name = "materials",
                type = "Material[]",
                value = JsonUtility.ToJson(summary)
            };
        }

        private static string GetSerializedPropertyValue(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Boolean:
                    return prop.boolValue.ToString().ToLower();
                case SerializedPropertyType.Integer:
                    return prop.intValue.ToString();
                case SerializedPropertyType.Float:
                    return prop.floatValue.ToString("G");
                case SerializedPropertyType.String:
                    return prop.stringValue ?? "";
                case SerializedPropertyType.Vector2:
                    return $"[{prop.vector2Value.x},{prop.vector2Value.y}]";
                case SerializedPropertyType.Vector3:
                    return $"[{prop.vector3Value.x},{prop.vector3Value.y},{prop.vector3Value.z}]";
                case SerializedPropertyType.Vector4:
                    return $"[{prop.vector4Value.x},{prop.vector4Value.y},{prop.vector4Value.z},{prop.vector4Value.w}]";
                case SerializedPropertyType.Quaternion:
                    return $"[{prop.quaternionValue.x},{prop.quaternionValue.y},{prop.quaternionValue.z},{prop.quaternionValue.w}]";
                case SerializedPropertyType.Color:
                    return $"[{prop.colorValue.r},{prop.colorValue.g},{prop.colorValue.b},{prop.colorValue.a}]";
                case SerializedPropertyType.Enum:
                    return prop.enumDisplayNames.Length > prop.enumValueIndex && prop.enumValueIndex >= 0
                        ? prop.enumDisplayNames[prop.enumValueIndex]
                        : prop.enumValueIndex.ToString();
                case SerializedPropertyType.ObjectReference:
                    return prop.objectReferenceValue != null ? prop.objectReferenceValue.name : "null";
                case SerializedPropertyType.LayerMask:
                    return prop.intValue.ToString();
                case SerializedPropertyType.Bounds:
                    var b = prop.boundsValue;
                    return $"{{center:[{b.center.x},{b.center.y},{b.center.z}],size:[{b.size.x},{b.size.y},{b.size.z}]}}";
                case SerializedPropertyType.Rect:
                    var r = prop.rectValue;
                    return $"{{x:{r.x},y:{r.y},w:{r.width},h:{r.height}}}";
                default:
                    return $"<{prop.propertyType}>";
            }
        }

        private static string GetGameObjectPath(GameObject obj)
        {
            string path = obj.name;
            Transform parent = obj.transform.parent;

            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }

            return path;
        }

        private static void ExportEditorState()
        {
            try
            {
                var state = new EditorState
                {
                    isPlaying = EditorApplication.isPlaying,
                    isPaused = EditorApplication.isPaused,
                    isCompiling = EditorApplication.isCompiling,
                    isPlayingOrWillChangePlaymode = EditorApplication.isPlayingOrWillChangePlaymode,
                    isUpdating = EditorApplication.isUpdating,
                    activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                    activeSceneDirty = UnityEngine.SceneManagement.SceneManager.GetActiveScene().isDirty,
                    selectedObjects = Selection.gameObjects?.Select(o => o.name).ToArray() ?? new string[0],
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };

                string json = JsonUtility.ToJson(state, true);
                WriteAtomicText(Path.Combine(StateFolder, "editor-state.json"), json);
                ExportProjectInstance();
            }
            catch (Exception e)
            {
                Debug.LogError($"[Creator Works MCP] Error exporting editor state: {e.Message}");
            }
        }

        private static void ExportProjectInstance()
        {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
            {
                DateTime processStart = process.StartTime.ToUniversalTime();
                var instance = new ProjectInstanceState
                {
                    editorInstanceId = GetEditorInstanceId(),
                    bridgeVersion = BridgeVersion,
                    protocolVersion = BridgeProtocolVersion,
                    minimumProtocolVersion = MinimumBridgeProtocolVersion,
                    capabilities = CurrentBridgeCapabilities(),
                    preferredTransport = pipeServerAvailable ? "named_pipe" : "file",
                    pipeName = pipeServerAvailable ? PipeName : null,
                    projectPath = ProjectRoot,
                    projectName = Path.GetFileName(ProjectRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)),
                    unityVersion = Application.unityVersion,
                    processId = process.Id,
                    processStartedAt = new DateTimeOffset(processStart).ToUnixTimeMilliseconds(),
                    updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                WriteAtomicText(Path.Combine(StateFolder, "project-instance.json"), JsonUtility.ToJson(instance, true));
            }
        }

        private static string GetEditorInstanceId()
        {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
            {
                DateTime processStart = process.StartTime.ToUniversalTime();
                return process.Id + "-" + processStart.Ticks.ToString("x16", CultureInfo.InvariantCulture);
            }
        }

        private static string[] CurrentBridgeCapabilities()
        {
            var capabilities = new List<string>
            {
                "file_commands",
                "correlated_command_results",
                "manual_full_state_export",
                "targeted_hierarchy_queries",
                "project_bound_commands",
                "command_status_polling",
                "selective_component_properties",
                "screenshot_metadata",
                "main_thread_unity_api",
                "unity_test_runner",
                "banter_visual_scripting",
                "sidequest_sdk_profiles",
                "shader_graph_commands"
            };
            if (pipeServerAvailable)
                capabilities.Insert(0, "named_pipe_commands");
            return capabilities.ToArray();
        }

        private static void ExportConsoleLogs()
        {
            try
            {
                var logs = new ConsoleLogs();
                logs.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                lock (logLock)
                {
                    logs.logs = new List<ConsoleLogEntry>(capturedLogs);
                }

                // Build JSON manually for better formatting
                var sb = new System.Text.StringBuilder();
                sb.AppendLine("{");
                sb.AppendLine($"    \"timestamp\": {logs.timestamp},");
                sb.AppendLine($"    \"count\": {logs.logs.Count},");
                sb.AppendLine("    \"logs\": [");

                for (int i = 0; i < logs.logs.Count; i++)
                {
                    var log = logs.logs[i];
                    sb.Append("        {");
                    sb.Append($"\"level\": \"{log.level}\", ");
                    sb.Append($"\"message\": \"{EscapeJsonString(log.message)}\", ");
                    sb.Append($"\"timestamp\": {log.timestamp}");
                    if (!string.IsNullOrEmpty(log.stackTrace))
                    {
                        sb.Append($", \"stackTrace\": \"{EscapeJsonString(log.stackTrace)}\"");
                    }
                    sb.Append("}");
                    if (i < logs.logs.Count - 1) sb.AppendLine(",");
                    else sb.AppendLine();
                }

                sb.AppendLine("    ]");
                sb.AppendLine("}");

                WriteAtomicText(Path.Combine(StateFolder, "console-log.json"), sb.ToString());
            }
            catch (Exception e)
            {
                // Avoid recursive logging by using Console.WriteLine
                System.Console.WriteLine($"[Creator Works MCP] Error exporting console logs: {e.Message}");
            }
        }

        private static void ExportImportStatus(bool success, string error)
        {
            try
            {
                var status = new ImportStatus
                {
                    completed = true,
                    hasErrors = !success,
                    errorMessage = error,
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };

                string json = JsonUtility.ToJson(status, true);
                WriteAtomicText(Path.Combine(StateFolder, "import-status.json"), json);
            }
            catch (Exception e)
            {
                Debug.LogError($"[Creator Works MCP] Error exporting import status: {e.Message}");
            }
        }

        /// <summary>
        /// Scans all prefabs in the Assets folder and exports a categorized catalog.
        /// This runs on startup and can be triggered via the scan_prefabs command.
        /// </summary>
        private static void ScanAndExportPrefabCatalog()
        {
            try
            {
                Debug.Log("[Creator Works MCP] Scanning prefabs...");
                var stopwatch = System.Diagnostics.Stopwatch.StartNew();

                // Find all prefab GUIDs
                string[] prefabGuids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" });

                // Initialize progress tracking
                IsScanningPrefabs = true;
                ScanProgress = 0;
                ScanTotal = prefabGuids.Length;
                ScanStartTime = (float)EditorApplication.timeSinceStartup;
                ScanStatus = $"Found {prefabGuids.Length} prefabs to scan...";

                // Build catalog structure
                var categories = new Dictionary<string, PrefabCategory>();
                int totalCount = 0;

                for (int i = 0; i < prefabGuids.Length; i++)
                {
                    string guid = prefabGuids[i];
                    string path = AssetDatabase.GUIDToAssetPath(guid);
                    if (string.IsNullOrEmpty(path)) continue;

                    // Update progress
                    ScanProgress = i + 1;
                    if (i % 100 == 0 || i == prefabGuids.Length - 1)
                    {
                        float elapsed = (float)EditorApplication.timeSinceStartup - ScanStartTime;
                        float rate = (i + 1) / Mathf.Max(elapsed, 0.001f);
                        int remaining = prefabGuids.Length - i - 1;
                        float eta = rate > 0 ? remaining / rate : 0;
                        ScanStatus = $"Scanning: {i + 1}/{prefabGuids.Length} ({(i + 1) * 100 / prefabGuids.Length}%) - ETA: {eta:F0}s";
                    }

                    // Extract category from path (first folder after Assets/)
                    string relativePath = path.Substring("Assets/".Length);
                    string[] pathParts = relativePath.Split('/');

                    string category = pathParts.Length > 1 ? pathParts[0] : "Root";
                    string subcategory = pathParts.Length > 2 ? pathParts[1] : null;
                    string prefabName = Path.GetFileNameWithoutExtension(path);

                    // Get or create category
                    if (!categories.ContainsKey(category))
                    {
                        categories[category] = new PrefabCategory
                        {
                            name = category,
                            count = 0,
                            subcategories = new Dictionary<string, int>(),
                            prefabs = new List<PrefabEntry>()
                        };
                    }

                    var cat = categories[category];
                    cat.count++;
                    totalCount++;

                    // Track subcategory
                    if (!string.IsNullOrEmpty(subcategory))
                    {
                        if (!cat.subcategories.ContainsKey(subcategory))
                            cat.subcategories[subcategory] = 0;
                        cat.subcategories[subcategory]++;
                    }

                    // Calculate prefab bounds
                    float[] boundsSize = null;
                    float[] boundsCenter = null;
                    GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    if (prefabAsset != null)
                    {
                        Bounds bounds = CalculatePrefabBounds(prefabAsset);
                        boundsSize = new float[] { bounds.size.x, bounds.size.y, bounds.size.z };
                        boundsCenter = new float[] { bounds.center.x, bounds.center.y, bounds.center.z };
                    }

                    // Add prefab entry
                    cat.prefabs.Add(new PrefabEntry
                    {
                        path = path,
                        name = prefabName,
                        category = category,
                        subcategory = subcategory,
                        boundsSize = boundsSize,
                        boundsCenter = boundsCenter
                    });
                }

                // Build JSON manually for proper structure
                var sb = new System.Text.StringBuilder();
                sb.AppendLine("{");
                sb.AppendLine($"    \"version\": 1,");
                sb.AppendLine($"    \"timestamp\": {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},");
                sb.AppendLine($"    \"totalCount\": {totalCount},");
                sb.AppendLine($"    \"categories\": {{");

                var catList = categories.Values.OrderByDescending(c => c.count).ToList();
                for (int i = 0; i < catList.Count; i++)
                {
                    var cat = catList[i];
                    sb.AppendLine($"        \"{EscapeJsonString(cat.name)}\": {{");
                    sb.AppendLine($"            \"count\": {cat.count},");

                    // Subcategories
                    sb.Append($"            \"subcategories\": {{");
                    var subList = cat.subcategories.OrderByDescending(s => s.Value).Take(20).ToList();
                    for (int j = 0; j < subList.Count; j++)
                    {
                        sb.Append($"\"{EscapeJsonString(subList[j].Key)}\": {subList[j].Value}");
                        if (j < subList.Count - 1) sb.Append(", ");
                    }
                    sb.AppendLine("},");

                    // Prefabs (limit to first 500 per category to keep file size reasonable)
                    sb.AppendLine($"            \"prefabs\": [");
                    var prefabList = cat.prefabs.Take(500).ToList();
                    for (int j = 0; j < prefabList.Count; j++)
                    {
                        var p = prefabList[j];
                        sb.Append($"                {{\"path\": \"{EscapeJsonString(p.path)}\", \"name\": \"{EscapeJsonString(p.name)}\", \"category\": \"{EscapeJsonString(p.category)}\"");
                        if (!string.IsNullOrEmpty(p.subcategory))
                            sb.Append($", \"subcategory\": \"{EscapeJsonString(p.subcategory)}\"");
                        if (p.boundsSize != null)
                            sb.Append($", \"boundsSize\": [{FormatJsonFloat(p.boundsSize[0])}, {FormatJsonFloat(p.boundsSize[1])}, {FormatJsonFloat(p.boundsSize[2])}]");
                        if (p.boundsCenter != null)
                            sb.Append($", \"boundsCenter\": [{FormatJsonFloat(p.boundsCenter[0])}, {FormatJsonFloat(p.boundsCenter[1])}, {FormatJsonFloat(p.boundsCenter[2])}]");
                        sb.Append("}");
                        if (j < prefabList.Count - 1) sb.AppendLine(",");
                        else sb.AppendLine();
                    }
                    sb.AppendLine($"            ]");

                    sb.Append($"        }}");
                    if (i < catList.Count - 1) sb.AppendLine(",");
                    else sb.AppendLine();
                }

                sb.AppendLine("    }");
                sb.AppendLine("}");

                // Write catalog file
                string catalogPath = Path.Combine(StateFolder, "prefab-catalog.json");
                WriteAtomicText(catalogPath, sb.ToString());

                stopwatch.Stop();

                // Mark scan complete
                IsScanningPrefabs = false;
                ScanStatus = $"Complete: {totalCount} prefabs in {categories.Count} categories ({stopwatch.ElapsedMilliseconds}ms)";

                Debug.Log($"[Creator Works MCP] Prefab catalog exported: {totalCount} prefabs in {categories.Count} categories ({stopwatch.ElapsedMilliseconds}ms)");
                LastActivity = DateTime.Now.ToString("HH:mm:ss") + $" - Scanned {totalCount} prefabs";
            }
            catch (Exception e)
            {
                IsScanningPrefabs = false;
                ScanStatus = $"Error: {e.Message}";
                Debug.LogError($"[Creator Works MCP] Error scanning prefabs: {e.Message}");
            }
        }

        private static string EscapeJsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;

            var escaped = new System.Text.StringBuilder(s.Length + 16);
            foreach (char character in s)
            {
                switch (character)
                {
                    case '\\': escaped.Append("\\\\"); break;
                    case '"': escaped.Append("\\\""); break;
                    case '\b': escaped.Append("\\b"); break;
                    case '\f': escaped.Append("\\f"); break;
                    case '\n': escaped.Append("\\n"); break;
                    case '\r': escaped.Append("\\r"); break;
                    case '\t': escaped.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                            escaped.Append("\\u").Append(((int)character).ToString("X4", CultureInfo.InvariantCulture));
                        else
                            escaped.Append(character);
                        break;
                }
            }

            return escaped.ToString();
        }

        /// <summary>
        /// Calculates the combined bounds of a prefab including all renderers
        /// </summary>
        private static Bounds CalculatePrefabBounds(GameObject prefab)
        {
            Bounds bounds = new Bounds(Vector3.zero, Vector3.zero);
            bool boundsInitialized = false;

            // Get all renderers in the prefab
            Renderer[] renderers = prefab.GetComponentsInChildren<Renderer>(true);
            foreach (Renderer renderer in renderers)
            {
                if (!boundsInitialized)
                {
                    bounds = renderer.bounds;
                    boundsInitialized = true;
                }
                else
                {
                    bounds.Encapsulate(renderer.bounds);
                }
            }

            // If no renderers, try colliders
            if (!boundsInitialized)
            {
                Collider[] colliders = prefab.GetComponentsInChildren<Collider>(true);
                foreach (Collider collider in colliders)
                {
                    if (!boundsInitialized)
                    {
                        bounds = collider.bounds;
                        boundsInitialized = true;
                    }
                    else
                    {
                        bounds.Encapsulate(collider.bounds);
                    }
                }
            }

            // Default to a 1x1x1 bounds if nothing found
            if (!boundsInitialized)
            {
                bounds = new Bounds(Vector3.zero, Vector3.one);
            }

            return bounds;
        }

        /// <summary>
        /// Calculates the combined bounds of a scene GameObject including all children
        /// </summary>
        private static Bounds CalculateGameObjectBounds(GameObject obj)
        {
            Bounds bounds = new Bounds(obj.transform.position, Vector3.zero);
            bool boundsInitialized = false;

            Renderer[] renderers = obj.GetComponentsInChildren<Renderer>(true);
            foreach (Renderer renderer in renderers)
            {
                if (!boundsInitialized)
                {
                    bounds = renderer.bounds;
                    boundsInitialized = true;
                }
                else
                {
                    bounds.Encapsulate(renderer.bounds);
                }
            }

            if (!boundsInitialized)
            {
                Collider[] colliders = obj.GetComponentsInChildren<Collider>(true);
                foreach (Collider collider in colliders)
                {
                    if (!boundsInitialized)
                    {
                        bounds = collider.bounds;
                        boundsInitialized = true;
                    }
                    else
                    {
                        bounds.Encapsulate(collider.bounds);
                    }
                }
            }

            if (!boundsInitialized)
            {
                bounds = new Bounds(obj.transform.position, Vector3.one);
            }

            return bounds;
        }

        // Helper classes for prefab catalog
        private class PrefabCategory
        {
            public string name;
            public int count;
            public Dictionary<string, int> subcategories;
            public List<PrefabEntry> prefabs;
        }

        private class PrefabEntry
        {
            public string path;
            public string name;
            public string category;
            public string subcategory;
            public float[] boundsSize;    // [width, height, depth]
            public float[] boundsCenter;  // [x, y, z] offset from pivot
        }

        #endregion

        #region Data Classes

        [Serializable]
        private class MCPCommand
        {
            public string id;
            public string type;
            public string path;
            public string stateType;
            public int protocolVersion;
            public string expectedProjectId;
            public string expectedProjectPath;
            public string expectedEditorInstanceId;
            public long timestamp;
        }

        [Serializable]
        private class CreateGameObjectCommand
        {
            public string type;
            public string name;
            public string primitiveType;
            public float[] position;
            public float[] rotation;
            public float[] scale;
            public string parentId;
            public string parentPath;
        }

        [Serializable]
        private class DeleteGameObjectCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
        }

        [Serializable]
        private class ModifyGameObjectCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public float[] position;
            public float[] rotation;
            public float[] scale;
        }

        [Serializable]
        private class AddComponentCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public string componentType;
        }

        [Serializable]
        private class RemoveComponentCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public string componentType;
            public string componentId;
        }

        [Serializable]
        private class SetComponentPropertyCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public string componentType;
            public string componentId;
            public string propertyName;
            public string value;
            public string valueJson;
        }

        private static void ExportCompilationStatus(bool completed)
        {
            try
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var errors = compilationMessages
                    .Where(message => string.Equals(message.type, CompilerMessageType.Error.ToString(), StringComparison.Ordinal))
                    .ToList();
                var warnings = compilationMessages
                    .Where(message => string.Equals(message.type, CompilerMessageType.Warning.ToString(), StringComparison.Ordinal))
                    .ToList();
                var status = new CompilationStatus
                {
                    completed = completed,
                    hasErrors = errors.Count > 0,
                    startedAt = compilationStartedAt == 0 ? now : compilationStartedAt,
                    timestamp = now,
                    errorCount = errors.Count,
                    warningCount = warnings.Count,
                    messagesTruncated = compilationMessagesTruncated,
                    errors = errors,
                    warnings = warnings
                };

                WriteAtomicText(Path.Combine(StateFolder, "compilation-status.json"), JsonUtility.ToJson(status, true));
            }
            catch (Exception e)
            {
                System.Console.WriteLine($"[Creator Works MCP] Error exporting compilation status: {e.Message}");
            }
        }

        [Serializable]
        private class PlayModeCommand
        {
            public string type;
            public string action;
        }

        [Serializable]
        private class ScreenshotCommand
        {
            public string id;
            public string type;
            public string source;
            public int width;
            public int height;
            public string cameraId;
            public string cameraPath;
        }

        [Serializable]
        private class ScreenshotResult
        {
            public string commandId;
            public bool success;
            public string source;
            public int width;
            public int height;
            public int byteLength;
            public string cameraId;
            public string cameraPath;
            public string cameraName;
            public string cameraSelection;
            public int cameraCandidateCount;
            public bool cameraSelectionAmbiguous;
            public string sceneViewName;
            public long timestamp;
        }
        [Serializable]
        private class AssetSearchCommand
        {
            public string id;
            public string type;
            public string query;
            public string[] folders;
            public int limit;
            public bool includePackages;
        }

        [Serializable]
        private class AssetSearchResult
        {
            public string commandId;
            public bool success;
            public string query;
            public int totalMatches;
            public bool truncated;
            public long timestamp;
            public List<AssetSearchEntry> assets;
        }

        [Serializable]
        private class AssetSearchEntry
        {
            public string guid;
            public string path;
            public string name;
            public string type;
            public bool isFolder;
        }

        private enum ShaderGraphOperation
        {
            Capabilities,
            List,
            Inspect,
            Create,
            AddNode,
            Connect,
            Validate
        }

        [Serializable]
        private class ShaderGraphCommand
        {
            public string id;
            public string type;
            public string assetPath;
            public string pipeline;
            public string shaderType;
            public bool overwrite;
            public string expectedContentHash;
            public bool openInEditor;
            public int limit;
            public string nodeType;
            public bool hasPosition;
            public ShaderGraphPoint position;
            public string sourceNodeId;
            public int sourceSlotId;
            public string destinationNodeId;
            public int destinationSlotId;
            public bool replaceExistingInput;
            public ShaderGraphNodeRequest[] nodes;
            public ShaderGraphConnectionRequest[] connections;
        }

        [Serializable]
        private class ShaderGraphPoint
        {
            public float x;
            public float y;
        }

        [Serializable]
        private class ShaderGraphNodeRequest
        {
            public string id;
            public string nodeType;
            public ShaderGraphPoint position;
        }

        [Serializable]
        private class ShaderGraphConnectionRequest
        {
            public string from;
            public int fromSlot;
            public string to;
            public int toSlot;
        }

        [Serializable]
        private class ShaderGraphCommandResult
        {
            public string commandId;
            public bool success;
            public string operation;
            public string assetPath;
            public string error;
            public string errorType;
            public bool rolledBack;
            public string rollbackError;
            public bool writeAttempted;
            public bool writeCompleted;
            public string originalHash;
            public string writtenHash;
            public long timestamp;
            public ShaderGraphCapabilities capabilities;
            public List<ShaderGraphAssetEntry> assets;
            public ShaderGraphSummary graph;
            public ShaderGraphMutationResult mutation;
            public List<string> warnings;
        }

        [Serializable]
        private class ShaderGraphCapabilities
        {
            public bool packageInstalled;
            public bool assemblyLoaded;
            public bool readSupported;
            public bool writeSupported;
            public bool createSupported;
            public bool nodeMutationSupported;
            public bool connectionSupported;
            public string packageVersion;
            public string assemblyVersion;
            public string activeRenderPipeline;
            public List<string> supportedTemplates;
            public List<string> missingMembers;
        }

        [Serializable]
        private class ShaderGraphAssetEntry
        {
            public string assetPath;
            public string guid;
            public string name;
            public string dependencyHash;
            public bool hasCompileErrors;
        }

        [Serializable]
        private class ShaderGraphSummary
        {
            public string assetPath;
            public string assetGuid;
            public string dependencyHash;
            public string contentHash;
            public string shaderName;
            public bool shaderLoaded;
            public int nodeCount;
            public int edgeCount;
            public int targetCount;
            public int propertyCount;
            public int unknownObjectCount;
            public bool graphDeserialized;
            public bool hasCompileErrors;
            public bool validationPassed;
            public List<ShaderGraphNodeInfo> nodes;
            public List<ShaderGraphEdgeInfo> edges;
            public List<ShaderGraphTargetInfo> targets;
            public List<ShaderGraphPropertyInfo> properties;
            public List<ShaderGraphCompilerDiagnostic> diagnostics;
            public List<string> warnings;
        }

        [Serializable]
        private class ShaderGraphNodeInfo
        {
            public string id;
            public string name;
            public string type;
            public bool isBlock;
            public string blockDescriptor;
            public float[] position;
            public List<ShaderGraphSlotInfo> slots;
        }

        [Serializable]
        private class ShaderGraphSlotInfo
        {
            public int id;
            public string name;
            public string type;
            public string direction;
            public string valueType;
        }

        [Serializable]
        private class ShaderGraphEdgeInfo
        {
            public string outputNodeId;
            public int outputSlotId;
            public string inputNodeId;
            public int inputSlotId;
        }

        [Serializable]
        private class ShaderGraphTargetInfo
        {
            public string type;
            public string displayName;
        }

        [Serializable]
        private class ShaderGraphPropertyInfo
        {
            public string id;
            public string type;
            public string displayName;
            public string referenceName;
            public bool exposed;
        }

        [Serializable]
        private class ShaderGraphCompilerDiagnostic
        {
            public string severity;
            public string message;
            public string file;
            public int line;
        }

        [Serializable]
        private class ShaderGraphMutationResult
        {
            public string requestedId;
            public string nodeId;
            public string nodeType;
            public List<ShaderGraphSlotInfo> slots;
            public bool connectionCreated;
        }

        [Serializable]
        private class ValidateVSGraphAssetCommand
        {
            public string id;
            public string type;
            public string assetPath;
            public bool allowUnboundValueInputs;
        }

        [Serializable]
        private class VSGraphAssetValidationResult
        {
            public string commandId;
            public bool success;
            public string assetPath;
            public string assetGuid;
            public string assetType;
            public string graphType;
            public string dependencyHash;
            public int elementCount;
            public int nodeCount;
            public int controlConnectionCount;
            public int valueConnectionCount;
            public int groupCount;
            public int missingElementCount;
            public int failedUnitDefinitionCount;
            public bool valuePortInspectionAvailable;
            public int valueInputCount;
            public int unboundValueInputCount;
            public bool unboundValueInputsTruncated;
            public int valuePortInspectionErrorCount;
            public bool allowUnboundValueInputs;
            public string error;
            public long timestamp;
            public List<string> elementTypes;
            public List<string> warnings;
            public List<VSValueInputDiagnostic> unboundValueInputs;
        }

        [Serializable]
        private class VSValueInputDiagnostic
        {
            public string unitType;
            public string unitGuid;
            public string portKey;
            public string expectedType;
            public bool hasValidConnection;
            public bool hasDefaultValue;
        }

        [Serializable]
        private class ValidateBanterVisualScriptingCommand
        {
            public string id;
            public string type;
        }

        [Serializable]
        private class BanterVisualScriptingValidationResult
        {
            public string commandId;
            public bool success;
            public bool validatorAvailable;
            public bool validationCompleted;
            public bool validationPassed;
            public string validatorType;
            public string validatorAssembly;
            public string validatorMethod;
            public string sdkProfile;
            public int diagnosticCount;
            public bool diagnosticsTruncated;
            public List<ConsoleLogEntry> diagnostics;
            public string error;
            public long timestamp;
        }

        [Serializable]
        private class GetScenesCommand
        {
            public string id;
            public string type;
        }

        [Serializable]
        private class SaveSceneCommand
        {
            public string id;
            public string type;
            public string scenePath;
            public string saveAsPath;
            public bool overwrite;
        }

        [Serializable]
        private class OpenSceneCommand
        {
            public string id;
            public string type;
            public string scenePath;
            public string mode;
            public bool saveModifiedScenes;
            public bool setActive;
        }

        [Serializable]
        private class SetBuildScenesCommand
        {
            public string id;
            public string type;
            public BuildSceneInput[] scenes;
        }

        [Serializable]
        private class ExecuteEditorMenuItemCommand
        {
            public string id;
            public string type;
            public string menuPath;
            public bool allowInPlayMode;
            public bool allowDirtyScene;
        }

        [Serializable]
        private class HierarchyQueryCommand
        {
            public string id;
            public string type;
            public string queryKind;
            public string filter;
            public string match;
            public string rootPath;
            public bool includeDescendants;
            public int maxDepth;
            public int maxResults;
            public string componentType;
            public string[] propertyNames;
            public bool includeComponents = true;
            public bool includeComponentProperties = true;
        }

        [Serializable]
        private class HierarchyQueryResult
        {
            public string commandId;
            public bool success;
            public string queryKind;
            public string sceneName;
            public string scenePath;
            public List<GameObjectInfo> objects;
            public List<ComponentQueryInfo> components;
            public int totalMatches;
            public int returned;
            public bool truncated;
            public string error;
            public long timestamp;
        }

        private class HierarchyQueryCandidate
        {
            public GameObject gameObject;
            public int depth;
        }

        [Serializable]
        private class ComponentQueryInfo
        {
            public string objectName;
            public string objectPath;
            public int depth;
            public string type;
            public string fullType;
            public string globalObjectId;
            public List<PropertyInfo> properties;
            public List<string> missingProperties;
        }

        [Serializable]
        private class EditorMenuExecutionResult
        {
            public string commandId;
            public bool success;
            public string menuPath;
            public bool executionReturnedTrue;
            public bool executionSucceeded;
            public string error;
            public long startedAt;
            public long finishedAt;
            public long durationMs;
            public EditorOperationState before;
            public EditorOperationState after;
            public bool diagnosticsTruncated;
            public List<ConsoleLogEntry> diagnostics;
        }

        [Serializable]
        private class EditorOperationState
        {
            public bool isPlaying;
            public bool isPlayingOrWillChangePlaymode;
            public bool isCompiling;
            public bool isUpdating;
            public string activeScenePath;
            public bool activeSceneDirty;
            public long timestamp;
        }

        [Serializable]
        private class BuildSceneInput
        {
            public string path;
            public bool enabled;
        }

        [Serializable]
        private class SceneManagementResult
        {
            public string commandId;
            public bool success;
            public string message;
            public string activeScenePath;
            public string activeSceneName;
            public long timestamp;
            public List<OpenSceneEntry> openScenes;
            public List<BuildSceneEntry> buildScenes;
        }

        [Serializable]
        private class OpenSceneEntry
        {
            public int handle;
            public string name;
            public string path;
            public string guid;
            public bool isLoaded;
            public bool isDirty;
            public bool isActive;
            public int buildIndex;
            public int rootCount;
        }

        [Serializable]
        private class BuildSceneEntry
        {
            public int index;
            public string path;
            public string guid;
            public bool enabled;
        }

        [Serializable]
        private class RunTestsCommand
        {
            public string id;
            public string type;
            public string mode;
            public string[] testNames;
            public string[] groupNames;
            public string[] categoryNames;
            public string[] assemblyNames;
            public int timeoutMs;
            public int maxResults;
        }

        [Serializable]
        private class DiscoverTestsCommand
        {
            public string id;
            public string type;
            public string mode;
            public string search;
            public int maxResults;
        }

        [Serializable]
        private class CancelTestsCommand
        {
            public string id;
            public string type;
            public string runId;
        }

        [Serializable]
        private class TestDiscoveryResult
        {
            public string commandId;
            public bool success;
            public string mode;
            public string search;
            public string error;
            public int totalTests;
            public int matchingTests;
            public int returned;
            public bool truncated;
            public long timestamp;
            public List<DiscoveredTestEntry> tests;
        }

        [Serializable]
        private class DiscoveredTestEntry
        {
            public string id;
            public string name;
            public string fullName;
            public string uniqueName;
            public string assemblyName;
            public string mode;
            public string runState;
            public string description;
            public string skipReason;
            public string[] categories;
        }

        [Serializable]
        private class UnityTestRunResult
        {
            public string commandId;
            public string jobId;
            public bool success;
            public bool testsPassed;
            public bool noTests;
            public bool cancellationRequested;
            public long cancellationRequestedAt;
            public string status;
            public string mode;
            public string error;
            public string completionSource;
            public long startedAt;
            public long updatedAt;
            public long finishedAt;
            public long deadline;
            public int maxResults;
            public int loadedTestCount;
            public int completedCount;
            public int total;
            public int passed;
            public int failed;
            public int skipped;
            public int inconclusive;
            public double duration;
            public bool truncated;
            public string[] testNames;
            public string[] groupNames;
            public string[] categoryNames;
            public string[] assemblyNames;
            public List<UnityTestCaseResult> tests;
        }

        [Serializable]
        private class UnityTestCaseResult
        {
            public string name;
            public string fullName;
            public string resultState;
            public string status;
            public double duration;
            public string message;
            public string stackTrace;
            public string output;
        }

        [Serializable]
        private class StringJsonValue
        {
            public string value;
        }

        [Serializable]
        private class FloatArrayJsonValue
        {
            public float[] values;
        }

        [Serializable]
        private class IntArrayJsonValue
        {
            public int[] values;
        }

        [Serializable]
        private class RectJsonValue
        {
            public float x;
            public float y;
            public float width;
            public float height;
        }

        [Serializable]
        private class BoundsJsonValue
        {
            public float[] center;
            public float[] size;
        }

        [Serializable]
        private class SetObjectReferenceCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public string componentType;
            public string componentId;
            public string propertyName;
            public string targetId;
            public string targetPath;
            public string targetComponent;
        }

        [Serializable]
        private class SetAssetReferenceCommand
        {
            public string type;
            public string objectId;
            public string objectPath;
            public string componentType;
            public string componentId;
            public string propertyName;
            public string assetPath;
            public string assetGuid;
            public bool clear;
            public string expectedAssetType;
        }

        private sealed class ReflectedReferenceAccessor
        {
            private readonly object owner;
            private readonly System.Reflection.PropertyInfo property;
            private readonly FieldInfo field;

            public ReflectedReferenceAccessor(object owner, System.Reflection.PropertyInfo property)
            {
                this.owner = owner;
                this.property = property;
                ValueType = property.PropertyType;
            }

            public ReflectedReferenceAccessor(object owner, FieldInfo field)
            {
                this.owner = owner;
                this.field = field;
                ValueType = field.FieldType;
            }

            public Type ValueType { get; }

            public object GetValue()
            {
                return property != null ? property.GetValue(owner) : field.GetValue(owner);
            }

            public void SetValue(object value)
            {
                if (property != null)
                    property.SetValue(owner, value);
                else
                    field.SetValue(owner, value);
            }
        }

        [Serializable]
        private class BatchCommand
        {
            public string type;
            public string[] commands;  // Array of JSON strings, each representing a command
            public bool continueOnError;
        }

        [Serializable]
        private class InstantiatePrefabCommand
        {
            public string type;
            public string prefabPath;  // Asset path like "Assets/Prefabs/MyPrefab.prefab"
            public string name;        // Optional: rename the instance
            public float[] position;
            public float[] rotation;
            public float[] scale;
            public string parentId;
            public string parentPath;
        }

        [Serializable]
        private class GetBoundsCommand
        {
            public string id;
            public string type;
            public string objectId;
            public string objectPath;
        }

        [Serializable]
        private class SceneHierarchy
        {
            public string sceneName;
            public string scenePath;
            public List<GameObjectInfo> objects;
            public long timestamp;
        }

        [Serializable]
        private class GameObjectInfo
        {
            public string name;
            public string globalObjectId;
            public string path;
            public bool active;
            public int layer;
            public string tag;
            public int depth;
            public float[] position;
            public float[] rotation;
            public float[] scale;
            public float[] localPosition;
            public float[] localRotation;
            public float[] localScale;
            public List<ComponentInfo> components;
        }

        [Serializable]
        private class ComponentInfo
        {
            public string type;
            public string fullType;
            public string globalObjectId;
            public List<PropertyInfo> properties;
            public List<string> missingProperties;
        }

        [Serializable]
        private class PropertyInfo
        {
            public string name;
            public string propertyPath;
            public string type;
            public string value;
        }

        [Serializable]
        private class RendererMaterialSummary
        {
            public int totalCount;
            public bool truncated;
            public List<MaterialReferenceInfo> materials;
        }

        [Serializable]
        private class MaterialReferenceInfo
        {
            public string name;
            public string assetPath;
            public string assetGuid;
            public string shader;
        }

        [Serializable]
        private class EditorState
        {
            public bool isPlaying;
            public bool isPaused;
            public bool isCompiling;
            public bool isPlayingOrWillChangePlaymode;
            public bool isUpdating;
            public string activeScene;
            public bool activeSceneDirty;
            public string[] selectedObjects;
            public long timestamp;
        }

        [Serializable]
        private class ConsoleLogs
        {
            public List<ConsoleLogEntry> logs;
            public long timestamp;
        }

        [Serializable]
        private class ConsoleLogEntry
        {
            public string level;
            public string message;
            public string stackTrace;
            public long timestamp;
        }

        [Serializable]
        private class ImportStatus
        {
            public bool completed;
            public bool hasErrors;
            public string errorMessage;
            public long timestamp;
        }

        [Serializable]
        private class CompilationStatus
        {
            public bool completed;
            public bool hasErrors;
            public long startedAt;
            public long timestamp;
            public int errorCount;
            public int warningCount;
            public bool messagesTruncated;
            public List<CompilationMessageInfo> errors;
            public List<CompilationMessageInfo> warnings;
        }

        [Serializable]
        private class CompilationMessageInfo
        {
            public string assemblyPath;
            public string type;
            public string message;
            public string file;
            public int line;
            public int column;
        }

        [Serializable]
        private class ProjectInstanceState
        {
            public string editorInstanceId;
            public string bridgeVersion;
            public int protocolVersion;
            public int minimumProtocolVersion;
            public string[] capabilities;
            public string preferredTransport;
            public string pipeName;
            public string projectPath;
            public string projectName;
            public string unityVersion;
            public int processId;
            public long processStartedAt;
            public long updatedAt;
        }

        [Serializable]
        private class CommandResult
        {
            public string commandId;
            public bool success;
            public string message;
            public string error;
            public long timestamp;
            public string projectPath;
            public string editorInstanceId;
        }

        private class PendingPipeCommand
        {
            public string commandId;
            public string requestJson;
            public string responseJson;
            public ManualResetEventSlim completed;
            public bool timedOut;
        }

        [Serializable]
        private class LauncherSettings
        {
            public bool enableCustomScripts;
            public bool allowAllTests = true;
        }

        #endregion
    }

    /// <summary>
    /// Status window for Creator Works MCP
    /// </summary>
    public class BantworksMCPWindow : EditorWindow
    {
        private const string LogoAssetFileName = "CreatorWorksMCPLogo.png";
        private Vector2 scrollPosition;
        private Texture2D logoTexture;
        private static readonly Color CyanColor = new Color(0f, 0.83f, 1f);   // #00d4ff
        private static readonly Color RedColor = new Color(1f, 0.23f, 0.23f); // #ff3b3b
        private static readonly Color PreviewColor = new Color(1f, 0.67f, 0f); // #ffaa00
        private static Color MpcTextColor => EditorGUIUtility.isProSkin
            ? new Color(0.76f, 0.79f, 0.84f)
            : new Color(0.24f, 0.27f, 0.32f);

        public static void ShowWindow()
        {
            var window = GetWindow<BantworksMCPWindow>("Creator Works MCP");
            window.minSize = new Vector2(350, 300);
        }

        private void OnEnable()
        {
            logoTexture = LoadLogoTexture();
            titleContent = new GUIContent("Creator Works MCP", logoTexture);
        }

        private void OnGUI()
        {
            scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);

            DrawBrandHeader();
            EditorGUILayout.Space();

            // Connection status
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Status:", GUILayout.Width(100));
            GUI.color = BantworksMCPBridge.IsConnected ? Color.green : Color.red;
            GUILayout.Label(BantworksMCPBridge.IsConnected ? "● Connected" : "○ Disconnected");
            GUI.color = Color.white;
            EditorGUILayout.EndHorizontal();

            // Last activity
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Last Activity:", GUILayout.Width(100));
            GUILayout.Label(BantworksMCPBridge.LastActivity ?? "None");
            EditorGUILayout.EndHorizontal();

            // Commands processed
            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("Commands:", GUILayout.Width(100));
            GUILayout.Label(BantworksMCPBridge.CommandsProcessed.ToString());
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();
            DrawSeparator();
            EditorGUILayout.Space();

            // Prefab Scan Section
            GUILayout.Label("Prefab Catalog", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            if (BantworksMCPBridge.IsScanningPrefabs)
            {
                // Show scanning progress
                EditorGUILayout.BeginHorizontal();
                GUILayout.Label("Status:", GUILayout.Width(100));
                GUI.color = new Color(1f, 0.8f, 0.2f); // Yellow/orange
                GUILayout.Label("● Scanning...");
                GUI.color = Color.white;
                EditorGUILayout.EndHorizontal();

                // Progress bar
                float progress = BantworksMCPBridge.ScanTotal > 0
                    ? (float)BantworksMCPBridge.ScanProgress / BantworksMCPBridge.ScanTotal
                    : 0f;

                EditorGUILayout.BeginHorizontal();
                GUILayout.Label("Progress:", GUILayout.Width(100));
                Rect progressRect = EditorGUILayout.GetControlRect(GUILayout.Height(20));
                EditorGUI.ProgressBar(progressRect, progress,
                    $"{BantworksMCPBridge.ScanProgress} / {BantworksMCPBridge.ScanTotal} ({(progress * 100):F0}%)");
                EditorGUILayout.EndHorizontal();

                // Elapsed time
                float elapsed = (float)EditorApplication.timeSinceStartup - BantworksMCPBridge.ScanStartTime;
                EditorGUILayout.BeginHorizontal();
                GUILayout.Label("Elapsed:", GUILayout.Width(100));
                GUILayout.Label(FormatTime(elapsed));
                EditorGUILayout.EndHorizontal();

                // ETA
                if (progress > 0.01f)
                {
                    float eta = (elapsed / progress) * (1f - progress);
                    EditorGUILayout.BeginHorizontal();
                    GUILayout.Label("ETA:", GUILayout.Width(100));
                    GUILayout.Label(FormatTime(eta));
                    EditorGUILayout.EndHorizontal();
                }

                // Status message
                EditorGUILayout.BeginHorizontal();
                GUILayout.Label("Details:", GUILayout.Width(100));
                GUILayout.Label(BantworksMCPBridge.ScanStatus ?? "", EditorStyles.wordWrappedLabel);
                EditorGUILayout.EndHorizontal();
            }
            else
            {
                // Show idle/complete status
                EditorGUILayout.BeginHorizontal();
                GUILayout.Label("Status:", GUILayout.Width(100));
                if (!string.IsNullOrEmpty(BantworksMCPBridge.ScanStatus) && BantworksMCPBridge.ScanStatus.StartsWith("Complete"))
                {
                    GUI.color = Color.green;
                    GUILayout.Label("● Ready");
                }
                else if (!string.IsNullOrEmpty(BantworksMCPBridge.ScanStatus) && BantworksMCPBridge.ScanStatus.StartsWith("Error"))
                {
                    GUI.color = Color.red;
                    GUILayout.Label("● Error");
                }
                else
                {
                    GUI.color = Color.gray;
                    GUILayout.Label("○ Idle");
                }
                GUI.color = Color.white;
                EditorGUILayout.EndHorizontal();

                // Last scan result
                if (!string.IsNullOrEmpty(BantworksMCPBridge.ScanStatus))
                {
                    EditorGUILayout.BeginHorizontal();
                    GUILayout.Label("Last Scan:", GUILayout.Width(100));
                    GUILayout.Label(BantworksMCPBridge.ScanStatus, EditorStyles.wordWrappedLabel);
                    EditorGUILayout.EndHorizontal();
                }

                // Prefab count summary
                if (BantworksMCPBridge.ScanTotal > 0)
                {
                    EditorGUILayout.BeginHorizontal();
                    GUILayout.Label("Total Prefabs:", GUILayout.Width(100));
                    GUILayout.Label(BantworksMCPBridge.ScanTotal.ToString("N0"));
                    EditorGUILayout.EndHorizontal();
                }
            }

            EditorGUILayout.Space();
            DrawSeparator();
            EditorGUILayout.Space();

            // Project Mode Section
            GUILayout.Label("Project Mode", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("C# Components:", GUILayout.Width(100));
            bool customScriptsEnabled = BantworksMCPBridge.EnableCustomScripts;
            bool newValue = EditorGUILayout.Toggle(customScriptsEnabled, GUILayout.Width(20));
            if (newValue != customScriptsEnabled)
            {
                BantworksMCPBridge.EnableCustomScripts = newValue;
            }
            GUILayout.Label(newValue ? "Enabled (Project Scripts)" : "Disabled (SDK Only)",
                EditorStyles.miniLabel);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("", GUILayout.Width(100));
            EditorGUILayout.HelpBox(
                newValue
                    ? "MCP can add existing components from compiled project C# assemblies"
                    : "MCP only adds Unity built-in, Banter SDK, and Creator SDK components",
                MessageType.Info);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("All Tests:", GUILayout.Width(100));
            bool allowAllTests = BantworksMCPBridge.AllowAllTests;
            bool newAllowAllTests = EditorGUILayout.Toggle(allowAllTests, GUILayout.Width(20));
            if (newAllowAllTests != allowAllTests)
            {
                BantworksMCPBridge.AllowAllTests = newAllowAllTests;
            }
            GUILayout.Label(newAllowAllTests ? "Allowed (Default)" : "Blocked (Filtered Only)",
                EditorStyles.miniLabel);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.BeginHorizontal();
            GUILayout.Label("", GUILayout.Width(100));
            EditorGUILayout.HelpBox(
                newAllowAllTests
                    ? "MCP is permitted to run all tests when no filter is provided"
                    : "MCP requires specific testNames, groupNames, or assembly filters to prevent freezing on large suites",
                MessageType.Info);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();
            DrawSeparator();
            EditorGUILayout.Space();

            // Actions section
            GUILayout.Label("Actions", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Refresh State", GUILayout.Height(28)))
            {
                EditorApplication.ExecuteMenuItem("Creator Works MCP/Refresh State");
            }
            if (GUILayout.Button("Rescan Prefabs", GUILayout.Height(28)))
            {
                EditorApplication.ExecuteMenuItem("Creator Works MCP/Scan Prefabs");
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Open MCP Folder", GUILayout.Height(28)))
            {
                EditorApplication.ExecuteMenuItem("Creator Works MCP/Open MCP Folder");
            }
            if (GUILayout.Button("Clear Commands", GUILayout.Height(28)))
            {
                EditorApplication.ExecuteMenuItem("Creator Works MCP/Clear Commands");
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.EndScrollView();
        }

        private void DrawBrandHeader()
        {
            if (logoTexture == null)
            {
                logoTexture = LoadLogoTexture();
                titleContent = new GUIContent("Creator Works MCP", logoTexture);
            }

            EditorGUILayout.BeginHorizontal(GUILayout.Height(42));
            if (logoTexture != null)
            {
                GUILayout.Label(logoTexture, GUIStyle.none, GUILayout.Width(36), GUILayout.Height(36));
            }
            else
            {
                GUILayout.Space(36);
            }

            GUILayout.Space(8);
            EditorGUILayout.BeginVertical();
            GUILayout.Space(1);

            var titleStyle = new GUIStyle(EditorStyles.boldLabel)
            {
                fontSize = 14,
                richText = true,
                alignment = TextAnchor.MiddleLeft
            };
            var mcpColor = ColorUtility.ToHtmlStringRGB(MpcTextColor);
            GUILayout.Label(
                $"<color=#{ColorUtility.ToHtmlStringRGB(CyanColor)}>CREATOR</color> " +
                $"<color=#{ColorUtility.ToHtmlStringRGB(RedColor)}>WORKS</color> " +
                $"<color=#{mcpColor}>MCP</color>",
                titleStyle,
                GUILayout.Height(18));

            var previewStyle = new GUIStyle(EditorStyles.miniBoldLabel)
            {
                normal = { textColor = PreviewColor },
                fontSize = 9,
                alignment = TextAnchor.MiddleLeft
            };
            GUILayout.Label("SHADER GRAPH PREVIEW", previewStyle, GUILayout.Height(14));
            EditorGUILayout.EndVertical();
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();
        }

        private Texture2D LoadLogoTexture()
        {
            var script = MonoScript.FromScriptableObject(this);
            var scriptPath = AssetDatabase.GetAssetPath(script);
            if (!string.IsNullOrEmpty(scriptPath))
            {
                var scriptDirectory = Path.GetDirectoryName(scriptPath);
                if (!string.IsNullOrEmpty(scriptDirectory))
                {
                    var adjacentLogoPath = Path.Combine(scriptDirectory, LogoAssetFileName).Replace('\\', '/');
                    var adjacentLogo = AssetDatabase.LoadAssetAtPath<Texture2D>(adjacentLogoPath);
                    if (adjacentLogo != null)
                    {
                        return adjacentLogo;
                    }
                }
            }

            return AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Editor/" + LogoAssetFileName);
        }

        private void DrawSeparator()
        {
            Rect rect = EditorGUILayout.GetControlRect(GUILayout.Height(1));
            EditorGUI.DrawRect(rect, new Color(0.5f, 0.5f, 0.5f, 0.5f));
        }

        private string FormatTime(float seconds)
        {
            if (seconds < 60)
                return $"{seconds:F0}s";
            else if (seconds < 3600)
                return $"{(int)(seconds / 60)}m {(int)(seconds % 60)}s";
            else
                return $"{(int)(seconds / 3600)}h {(int)((seconds % 3600) / 60)}m";
        }

        private void OnInspectorUpdate()
        {
            // Repaint frequently during scanning for smooth progress updates
            if (BantworksMCPBridge.IsScanningPrefabs)
                Repaint();
        }

        private void Update()
        {
            // Also repaint in Update for more frequent updates during scanning
            if (BantworksMCPBridge.IsScanningPrefabs)
                Repaint();
        }
    }
}
