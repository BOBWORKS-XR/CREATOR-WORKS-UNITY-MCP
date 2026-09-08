param(
    [string]$UnityEditorPath = "C:\Program Files\Unity\Hub\Editor\6000.3.10f1\Editor\Unity.exe"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $UnityEditorPath -PathType Leaf)) {
    throw "Unity Editor was not found: $UnityEditorPath"
}

$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar)
$FixtureId = [System.Guid]::NewGuid().ToString("N")
$ProjectPath = Join-Path $TempRoot ("bantworks-unity-asset-reference-" + $FixtureId)
$CreateLog = Join-Path $TempRoot ("bantworks-unity-asset-reference-" + $FixtureId + "-create.log")
$SmokeLog = Join-Path $TempRoot ("bantworks-unity-asset-reference-" + $FixtureId + "-smoke.log")

function Invoke-Unity([string[]]$Arguments, [string]$LogPath) {
    $process = Start-Process -FilePath $UnityEditorPath -ArgumentList $Arguments `
        -PassThru -WindowStyle Hidden
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        $tail = if (Test-Path -LiteralPath $LogPath) {
            (Get-Content -LiteralPath $LogPath -Tail 120) -join [Environment]::NewLine
        } else {
            "Unity did not create a log file."
        }
        throw "Unity exited with code $($process.ExitCode).`n$tail"
    }
}

try {
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
    Invoke-Unity -Arguments @(
        "-batchmode", "-nographics", "-quit",
        "-createProject", $ProjectPath,
        "-logFile", $CreateLog
    ) -LogPath $CreateLog

    $ManifestPath = Join-Path $ProjectPath "Packages\manifest.json"
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($null -eq $Manifest.dependencies.PSObject.Properties["com.unity.visualscripting"]) {
        $Manifest.dependencies | Add-Member -NotePropertyName "com.unity.visualscripting" -NotePropertyValue "1.9.9"
    } else {
        $Manifest.dependencies."com.unity.visualscripting" = "1.9.9"
    }
    [System.IO.File]::WriteAllText(
        $ManifestPath,
        ($Manifest | ConvertTo-Json -Depth 20),
        [System.Text.UTF8Encoding]::new($false))

    $EditorPath = Join-Path $ProjectPath "Assets\Editor"
    New-Item -ItemType Directory -Path $EditorPath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "unity-extension\Editor\BanterMCPBridge.cs") `
        -Destination (Join-Path $EditorPath "BanterMCPBridge.cs") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "unity-extension\Editor\CreatorWorksMCPLogo.png") `
        -Destination (Join-Path $EditorPath "CreatorWorksMCPLogo.png") -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\HierarchyQuerySmoke.cs") `
        -Destination (Join-Path $EditorPath "HierarchyQuerySmoke.cs") -Force

    $FixtureAssetSource = @'
using UnityEngine;

public sealed class FixtureAsset : ScriptableObject
{
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $ProjectPath "Assets\FixtureAsset.cs"),
        $FixtureAssetSource,
        [System.Text.UTF8Encoding]::new($false))

    $FixtureComponentSource = @'
using UnityEngine;

public sealed class FixtureComponent : MonoBehaviour
{
    public FixtureAsset asset;
    public int count;
    public string label;
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $ProjectPath "Assets\FixtureComponent.cs"),
        $FixtureComponentSource,
        [System.Text.UTF8Encoding]::new($false))

    $SmokeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace BantworksMCPFixture
{
    public static class AssetReferenceSmoke
    {
        [Serializable]
        private sealed class AssetReferenceCommand
        {
            public string id;
            public string type = "set_asset_reference";
            public string objectPath = "AssetReferenceTarget";
            public string componentType = "FixtureComponent";
            public string propertyName = "asset";
            public string assetPath;
            public string assetGuid;
            public bool clear;
            public string expectedAssetType;
            public long timestamp;
        }

        [Serializable]
        private sealed class CommandResult
        {
            public string commandId;
            public bool success;
            public string message;
            public string error;
        }

        public static void Run()
        {
            try
            {
                RunAssertions();
                File.WriteAllText(
                    Path.Combine(Directory.GetParent(Application.dataPath).FullName, "asset-reference-smoke.json"),
                    "{\"success\":true}");
                Debug.Log("[BANTWORKS FIXTURE] Asset reference smoke passed");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                throw;
            }
        }

        private static void RunAssertions()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var fixture = ScriptableObject.CreateInstance<FixtureAsset>();
            AssetDatabase.CreateAsset(fixture, "Assets/Fixture.asset");
            var incompatible = new Texture2D(1, 1);
            AssetDatabase.CreateAsset(incompatible, "Assets/Incompatible.asset");
            AssetDatabase.SaveAssets();

            var target = new GameObject("AssetReferenceTarget");
            var component = target.AddComponent<FixtureComponent>();
            string fixtureGuid = AssetDatabase.AssetPathToGUID("Assets/Fixture.asset");

            ExpectSuccess(new AssetReferenceCommand {
                assetPath = "Assets/Fixture.asset",
                expectedAssetType = "FixtureAsset"
            });
            Assert(component.asset == fixture, "Path assignment did not retain the fixture asset");

            ExpectSuccess(new AssetReferenceCommand { clear = true });
            Assert(component.asset == null, "Clear did not remove the asset reference");

            ExpectSuccess(new AssetReferenceCommand {
                assetGuid = fixtureGuid,
                expectedAssetType = "FixtureAsset"
            });
            Assert(component.asset == fixture, "GUID assignment did not retain the fixture asset");

            ExpectFailure(new AssetReferenceCommand {
                assetPath = "Assets/Fixture.asset",
                expectedAssetType = "UnityEngine.Texture2D"
            }, "Asset type mismatch");
            Assert(component.asset == fixture, "Expected-type failure changed the existing reference");

            ExpectFailure(new AssetReferenceCommand {
                assetPath = "Assets/Incompatible.asset",
                expectedAssetType = "UnityEngine.Texture2D"
            }, "not compatible");
            Assert(component.asset == fixture, "Incompatible assignment changed the existing reference");

            ExpectFailure(new AssetReferenceCommand {
                assetPath = "Assets/../Fixture.asset"
            }, "without traversal");
            Assert(component.asset == fixture, "Traversal failure changed the existing reference");

            ExpectFailure(new AssetReferenceCommand {
                propertyName = "count",
                assetPath = "Assets/Fixture.asset"
            }, "not an object reference");
            Assert(component.asset == fixture, "Wrong-property failure changed the existing reference");

            RunVisualScriptingAttachment(target);
            HierarchyQuerySmoke.Run();
        }

        private static void RunVisualScriptingAttachment(GameObject target)
        {
            Type graphType = FindType("Unity.VisualScripting.ScriptGraphAsset");
            Type machineType = FindType("Unity.VisualScripting.ScriptMachine");
            Assert(graphType != null, "Visual Scripting 1.9.9 did not provide ScriptGraphAsset");
            Assert(machineType != null, "Visual Scripting 1.9.9 did not provide ScriptMachine");

            UnityEngine.Object graph = ScriptableObject.CreateInstance(graphType);
            AssetDatabase.CreateAsset(graph, "Assets/AttachedGraph.asset");
            AssetDatabase.SaveAssets();
            var machine = target.AddComponent(machineType);
            const string propertyPath = "nest.macro";

            ExpectSuccess(new AssetReferenceCommand {
                componentType = machineType.FullName,
                propertyName = propertyPath,
                assetPath = "Assets/AttachedGraph.asset",
                expectedAssetType = graphType.FullName
            });
            Assert(
                GetNestedMemberValue(machine, propertyPath) == graph,
                "ScriptMachine did not retain the ScriptGraphAsset reference");

            const string scenePath = "Assets/AssetReferenceFixture.unity";
            Assert(EditorSceneManager.SaveScene(SceneManager.GetActiveScene(), scenePath),
                "Could not save the assigned ScriptMachine fixture scene");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            target = GameObject.Find("AssetReferenceTarget");
            Assert(target != null, "Saved fixture target did not reload");
            machine = target.GetComponent(machineType);
            Assert(machine != null, "Saved ScriptMachine did not reload");
            graph = AssetDatabase.LoadMainAssetAtPath("Assets/AttachedGraph.asset");
            Assert(
                GetNestedMemberValue(machine, propertyPath) == graph,
                "ScriptMachine graph reference did not persist through scene reload");

            ExpectFailure(new AssetReferenceCommand {
                componentType = machineType.FullName,
                propertyName = "nest.source",
                assetPath = "Assets/AttachedGraph.asset"
            }, "not an object reference");
            Assert(
                GetNestedMemberValue(machine, propertyPath) == graph,
                "Rejected reflected-property assignment changed the graph reference");

            ExpectSuccess(new AssetReferenceCommand {
                componentType = machineType.FullName,
                propertyName = propertyPath,
                clear = true
            });
            Assert(
                GetNestedMemberValue(machine, propertyPath) == null,
                "ScriptMachine graph reference did not clear");
            Assert(EditorSceneManager.SaveScene(SceneManager.GetActiveScene()),
                "Could not save the cleared ScriptMachine fixture scene");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            target = GameObject.Find("AssetReferenceTarget");
            machine = target.GetComponent(machineType);
            Assert(
                GetNestedMemberValue(machine, propertyPath) == null,
                "Cleared ScriptMachine graph reference did not persist through scene reload");
        }

        private static UnityEngine.Object GetNestedMemberValue(object root, string propertyPath)
        {
            object value = root;
            foreach (string segment in propertyPath.Split('.'))
            {
                Type type = value.GetType();
                PropertyInfo property = type.GetProperty(
                    segment, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                FieldInfo field = property == null
                    ? type.GetField(segment, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    : null;
                value = property != null ? property.GetValue(value) : field.GetValue(value);
            }
            return value as UnityEngine.Object;
        }

        private static Type FindType(string fullName)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => {
                    try { return assembly.GetType(fullName, false); }
                    catch { return null; }
                })
                .FirstOrDefault(type => type != null);
        }

        private static void ExpectSuccess(AssetReferenceCommand command)
        {
            CommandResult result = Execute(command);
            Assert(result.success, "Expected command success: " + result.error);
        }

        private static void ExpectFailure(AssetReferenceCommand command, string expectedError)
        {
            CommandResult result = Execute(command);
            Assert(!result.success, "Expected command failure");
            Assert(
                !string.IsNullOrEmpty(result.error) &&
                result.error.IndexOf(expectedError, StringComparison.OrdinalIgnoreCase) >= 0,
                "Expected error containing '" + expectedError + "', got: " + result.error);
        }

        private static CommandResult Execute(AssetReferenceCommand command)
        {
            command.id = Guid.NewGuid().ToString();
            command.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string projectRoot = Directory.GetParent(Application.dataPath).FullName;
            string commandFolder = Path.Combine(projectRoot, ".bantworks-mcp", "commands");
            string resultPath = Path.Combine(
                projectRoot, ".bantworks-mcp", "state", "command-results", command.id + ".json");
            Directory.CreateDirectory(commandFolder);
            File.WriteAllText(
                Path.Combine(commandFolder, command.id + ".json"),
                JsonUtility.ToJson(command, true));

            MethodInfo process = typeof(BantworksMCP.BantworksMCPBridge).GetMethod(
                "ProcessCommands", BindingFlags.Static | BindingFlags.NonPublic);
            Assert(process != null, "Could not reflect the bridge command processor");
            process.Invoke(null, null);
            Assert(File.Exists(resultPath), "Bridge did not publish a correlated command result");
            return JsonUtility.FromJson<CommandResult>(File.ReadAllText(resultPath));
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
'@
    [System.IO.File]::WriteAllText(
        (Join-Path $EditorPath "AssetReferenceSmoke.cs"),
        $SmokeSource,
        [System.Text.UTF8Encoding]::new($false))

    Invoke-Unity -Arguments @(
        "-batchmode", "-nographics", "-quit", "-accept-apiupdate",
        "-projectPath", $ProjectPath,
        "-executeMethod", "BantworksMCPFixture.AssetReferenceSmoke.Run",
        "-logFile", $SmokeLog
    ) -LogPath $SmokeLog

    $Marker = Join-Path $ProjectPath "asset-reference-smoke.json"
    if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
        throw "Unity completed without publishing the asset-reference smoke marker."
    }
    $MarkerData = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
    if ($MarkerData.success -ne $true) {
        throw "Unity asset-reference smoke marker did not report success."
    }

    Write-Host "Unity asset-reference smoke passed: $UnityEditorPath"
}
finally {
    if (Test-Path -LiteralPath $ProjectPath) {
        $ResolvedProject = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar)
        $RequiredPrefix = $TempRoot + [System.IO.Path]::DirectorySeparatorChar + "bantworks-unity-asset-reference-"
        if (-not $ResolvedProject.StartsWith($RequiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove unexpected fixture path: $ResolvedProject"
        }
        Remove-Item -LiteralPath $ResolvedProject -Recurse -Force
    }
    Remove-Item -LiteralPath $CreateLog, $SmokeLog -Force -ErrorAction SilentlyContinue
}
