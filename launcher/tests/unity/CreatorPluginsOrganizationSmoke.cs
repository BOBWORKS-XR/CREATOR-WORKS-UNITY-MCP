using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using CreatorWorks.Plugins;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CreatorPluginsOrganizationSmoke
{
    [Serializable] private sealed class Result { public bool passed, danglingMetadataLinkTested; public int checks; public string unityVersion, error; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool CreateSymbolicLinkW(string link, string target, int flags);
    private static int checks;
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
    private static void Reject(Action action, string message)
    {
        bool rejected = false;
        try { action(); } catch (InvalidDataException) { rejected = true; } catch (IOException) { rejected = true; } catch (InvalidOperationException) { rejected = true; }
        Check(rejected, message);
    }
    private static ScriptableObject Graph(string typeName, string path)
    {
        var type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(typeName, false)).FirstOrDefault(t => t != null);
        if (type == null) throw new Exception("Visual Scripting is not loaded: " + typeName);
        var asset = ScriptableObject.CreateInstance(type);
        AssetDatabase.CreateAsset(asset, path);
        return asset;
    }
    public static void Run()
    {
        string project = Path.GetDirectoryName(Application.dataPath);
        if (!File.Exists(Path.Combine(project, ".creator-plugins-organization-fixture"))) throw new InvalidOperationException("Refusing a real project.");
        var result = new Result { unityVersion = Application.unityVersion };
        try
        {
            Check(!AssetDatabase.IsValidFolder("Assets/Imported"), "Fixture must be fresh.");
            AssetDatabase.CreateFolder("Assets", "Imported");
            var graph = Graph("Unity.VisualScripting.ScriptGraphAsset", "Assets/Imported/Flow.asset");
            var state = Graph("Unity.VisualScripting.StateGraphAsset", "Assets/Imported/State.asset");
            var obj = new GameObject("Chair");
            var prefab = PrefabUtility.SaveAsPrefabAsset(obj, "Assets/Imported/Chair.prefab");
            UnityEngine.Object.DestroyImmediate(obj);
            var holder = ScriptableObject.CreateInstance<CreatorPluginsReferenceFixture>();
            holder.graph = graph; holder.stateGraph = state; holder.prefab = prefab;
            AssetDatabase.CreateAsset(holder, "Assets/References.asset");
            AssetDatabase.SaveAssets();
            string holderBytes = Convert.ToBase64String(File.ReadAllBytes("Assets/References.asset"));
            string graphGuid = AssetDatabase.AssetPathToGUID("Assets/Imported/Flow.asset");
            string stateGuid = AssetDatabase.AssetPathToGUID("Assets/Imported/State.asset");
            string prefabGuid = AssetDatabase.AssetPathToGUID("Assets/Imported/Chair.prefab");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.MarkSceneDirty(scene);
            Debug.Log("Organization fixture after scene replacement: flowAlive=" + (graph != null) + ", stateAlive=" + (state != null));
            graph = AssetDatabase.LoadAssetAtPath<ScriptableObject>("Assets/Imported/Flow.asset");
            state = AssetDatabase.LoadAssetAtPath<ScriptableObject>("Assets/Imported/State.asset");
            prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Imported/Chair.prefab");
            Check(graph != null && state != null && AssetDatabase.IsMainAsset(graph) && AssetDatabase.IsMainAsset(state), "Fixture graph assets were not loaded as Project selections.");
            var planned = AssetOrganizer.Plan(new UnityEngine.Object[] { graph, state });
            Check(planned.Length == 2 && planned[0].destination == "Assets/Visual Scripting/Flow.asset", "Default graph folder wrong.");
            Check(!Directory.Exists("Assets/Visual Scripting"), "Preview created a folder before consent.");
            Check(AssetDatabase.GUIDToAssetPath(graphGuid) == "Assets/Imported/Flow.asset", "Preview moved an asset.");
            Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { graph, prefab }), "Mixed graphs and prefabs accepted.");
            Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { graph, holder }), "Unsupported asset mixed with graph accepted.");
            Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("Assets/Imported") }), "Folder move accepted.");
            EditorUtility.SetDirty(graph);
            Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { graph }), "Dirty graph was silently saved/moved.");
            AssetDatabase.SaveAssetIfDirty(graph);
            Check(AssetOrganizer.Apply(planned) == 2, "Graph moves did not finish.");
            Check(AssetDatabase.AssetPathToGUID("Assets/Visual Scripting/Flow.asset") == graphGuid && AssetDatabase.AssetPathToGUID("Assets/Visual Scripting/State.asset") == stateGuid, "Graph GUIDs changed.");
            Check(!File.Exists("Assets/Imported/Flow.asset") && !File.Exists("Assets/Imported/Flow.asset.meta"), "Original graph file or meta left behind.");
            Check(AssetDatabase.GUIDToAssetPath(prefabGuid) == "Assets/Imported/Chair.prefab", "Unselected prefab moved.");
            Check(Convert.ToBase64String(File.ReadAllBytes("Assets/References.asset")) == holderBytes, "Referencing asset was rewritten.");
            AssetDatabase.ImportAsset("Assets/References.asset", ImportAssetOptions.ForceSynchronousImport);
            holder = AssetDatabase.LoadAssetAtPath<CreatorPluginsReferenceFixture>("Assets/References.asset");
            Check(holder.graph == graph && holder.stateGraph == state && holder.prefab == prefab, "Serialized references broke after graph move.");
            var dependencies = AssetDatabase.GetDependencies("Assets/References.asset");
            Check(dependencies.Contains("Assets/Visual Scripting/Flow.asset") && dependencies.Contains("Assets/Visual Scripting/State.asset"), "Dependency paths did not follow GUIDs.");
            var prefabPlan = AssetOrganizer.Plan(new UnityEngine.Object[] { prefab });
            Check(!Directory.Exists("Assets/Prefabs"), "Prefab preview created a folder.");
            Check(AssetOrganizer.Apply(prefabPlan) == 1 && AssetDatabase.AssetPathToGUID("Assets/Prefabs/Chair.prefab") == prefabGuid, "Prefab move changed identity.");
            Check(holder.prefab == prefab && AssetDatabase.GetDependencies("Assets/References.asset").Contains("Assets/Prefabs/Chair.prefab"), "Prefab reference broke.");
            Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { graph }), "Already organized graph did not produce a no-op explanation.");

            var collision = Graph("Unity.VisualScripting.ScriptGraphAsset", "Assets/Imported/Collision.asset");
            var untouched = Graph("Unity.VisualScripting.ScriptGraphAsset", "Assets/Imported/Untouched.asset");
            AssetDatabase.SaveAssets();
            var stale = AssetOrganizer.Plan(new UnityEngine.Object[] { untouched, collision });
            var existing = Graph("Unity.VisualScripting.ScriptGraphAsset", "Assets/Visual Scripting/Collision.asset");
            AssetDatabase.SaveAssets();
            string existingGuid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(existing));
            Reject(() => AssetOrganizer.Apply(stale), "Destination appearing after preview was overwritten.");
            Check(AssetDatabase.GetAssetPath(untouched) == "Assets/Imported/Untouched.asset" && AssetDatabase.GetAssetPath(collision) == "Assets/Imported/Collision.asset", "Collision caused a partial move.");
            Check(AssetDatabase.AssetPathToGUID("Assets/Visual Scripting/Collision.asset") == existingGuid, "Existing destination was changed.");
            var staleIdentity = AssetOrganizer.Plan(new UnityEngine.Object[] { untouched });
            staleIdentity[0].guid = new string('f', 32);
            Reject(() => AssetOrganizer.Apply(staleIdentity), "Changed GUID accepted after preview.");
            var linkedCheck = AssetOrganizer.Plan(new UnityEngine.Object[] { untouched });
            linkedCheck[0].destination = "Assets/Elsewhere/Untouched.asset";
            Reject(() => AssetOrganizer.Apply(linkedCheck), "Changed destination accepted after preview.");
            Check(!Directory.Exists("Assets/Elsewhere"), "Invalid plan created an unapproved folder.");
            string metadataLink = Path.Combine(project, "Assets/Visual Scripting/Untouched.asset.meta");
            if (Application.platform == RuntimePlatform.WindowsEditor && CreateSymbolicLinkW(metadataLink, Path.Combine(project, "missing-meta-target"), 2))
            {
                try
                {
                    Check((File.GetAttributes(metadataLink) & FileAttributes.ReparsePoint) != 0, "Fixture did not create a real metadata link.");
                    Reject(() => AssetOrganizer.Plan(new UnityEngine.Object[] { untouched }), "Dangling destination metadata link was accepted.");
                    Check(AssetDatabase.GetAssetPath(untouched) == "Assets/Imported/Untouched.asset", "Rejected metadata link changed source.");
                    result.danglingMetadataLinkTested = true;
                }
                finally { File.Delete(metadataLink); }
            }
            else Debug.LogWarning("Dangling metadata link test unavailable; OS error " + Marshal.GetLastWin32Error());
            Check(string.IsNullOrEmpty(AssetDatabase.MoveAsset("Assets/Visual Scripting", "Assets/VS")), "Could not prepare existing VS folder fixture.");
            var existingFolderPlan = AssetOrganizer.Plan(new UnityEngine.Object[] { untouched });
            Check(existingFolderPlan.Single().destination == "Assets/VS/Untouched.asset" && !Directory.Exists("Assets/Visual Scripting"), "Existing VS folder ignored or preview created another folder.");
            Check(AssetOrganizer.Apply(existingFolderPlan) == 1 && AssetDatabase.GetAssetPath(untouched) == "Assets/VS/Untouched.asset", "Existing VS folder move did not finish.");
            Check(scene.isDirty && string.IsNullOrEmpty(scene.path), "Organizer saved or replaced the dirty scene.");
            Check(!Directory.Exists(Path.Combine(project, ".creator-plugins", "receipts")), "Organizer fabricated an import receipt.");
            result.passed = true;
        }
        catch (Exception error) { result.error = error.ToString(); Debug.LogError(error); }
        result.checks = checks;
        File.WriteAllText(Path.Combine(project, "organization-result.json"), JsonUtility.ToJson(result, true));
        EditorApplication.Exit(result.passed ? 0 : 1);
    }
}
