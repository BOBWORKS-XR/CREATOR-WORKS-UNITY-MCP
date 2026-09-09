using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace CreatorWorksSmoke
{
    public static class Release260Smoke
    {
        private static string menuCommandId;
        private static bool sawDispatch;
        private static Type Bridge => AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetType("BantworksMCP.BantworksMCPBridge")).First(t => t != null);
        private static string State => Path.Combine(Directory.GetParent(Application.dataPath).FullName, ".bantworks-mcp", "state");
        [Serializable] private class Hierarchy { public bool complete; public string scope; public Item[] objects; }
        [Serializable] private class Item { public string name; public int depth; }
        [Serializable] private class Result { public bool success; public string error; public string status; public Receipt observed; }
        [Serializable] private class Receipt { public float[] worldPosition; public float[] localScale; }

        [MenuItem("Creator Works Smoke/Long Command")]
        public static void LongCommand()
        {
            var status = JsonUtility.FromJson<Result>(File.ReadAllText(Path.Combine(State, "command-status", menuCommandId + ".json")));
            sawDispatch = status.status == "dispatched" && !status.success;
            Thread.Sleep(1200);
        }

        private static Result Command(string json)
        {
            var result = Bridge.GetMethod("ExecuteCommandJson", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { json, null });
            Bridge.GetMethod("WriteCommandResult", BindingFlags.Static | BindingFlags.NonPublic, null, new[] { result.GetType() }, null).Invoke(null, new[] { result });
            var parsed = JsonUtility.FromJson<Result>(JsonUtility.ToJson(result));
            if (!parsed.success) throw new Exception(parsed.error ?? "Command failed");
            return parsed;
        }

        private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }

        public static void Run()
        {
            try
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var root = new GameObject("Depth0");
                var parent = root.transform;
                for (int i = 1; i < 32; i++) { var child = new GameObject("Depth" + i); child.transform.SetParent(parent); parent = child.transform; }
                Bridge.GetMethod("ExportSceneHierarchy", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
                var hierarchy = JsonUtility.FromJson<Hierarchy>(File.ReadAllText(Path.Combine(State, "scene-hierarchy.json")));
                Require(hierarchy.complete && hierarchy.scope == "active_scene", "Missing completeness metadata");
                Require(hierarchy.objects.Length == 32 && hierarchy.objects.Last().depth == 31, "Hierarchy dropped deep children");
                UnityEngine.Object.DestroyImmediate(root);

                var scaledParent = new GameObject("ScaledParent");
                scaledParent.transform.localScale = new Vector3(2, 3, 4);
                var created = Command("{\"id\":\"" + Guid.NewGuid() + "\",\"type\":\"create_gameobject\",\"name\":\"Child\",\"position\":[4,5,6],\"scale\":[1,1,1],\"parentPath\":\"ScaledParent\"}");
                Require(Math.Abs(created.observed.localScale[0] - 0.5f) < 0.001f, "Create receipt echoed request rather than resulting local scale");
                var changed = Command("{\"id\":\"" + Guid.NewGuid() + "\",\"type\":\"modify_gameobject\",\"objectPath\":\"ScaledParent/Child\",\"position\":[7,8,9],\"scale\":[2,2,2]}");
                Require(changed.observed.worldPosition.SequenceEqual(new float[] {7,8,9}), "Incorrect world-position receipt");
                var childTransform = scaledParent.transform.GetChild(0);
                scaledParent.transform.position += Vector3.right;
                Require((childTransform.position - new Vector3(8,8,9)).sqrMagnitude < 0.001f, "Child no longer follows parent");

                menuCommandId = Guid.NewGuid().ToString();
                Command("{\"id\":\"" + menuCommandId + "\",\"type\":\"execute_editor_menu_item\",\"menuPath\":\"Creator Works Smoke/Long Command\",\"allowDirtyScene\":true}");
                Require(sawDispatch, "No dispatch record existed while the menu blocked");
                var complete = JsonUtility.FromJson<Result>(File.ReadAllText(Path.Combine(State, "command-status", menuCommandId + ".json")));
                Require(complete.status == "completed" && complete.success, "Retained completion missing");
                File.WriteAllText(Path.Combine(State, "release-260-smoke.json"), "{\"success\":true,\"hierarchyObjects\":32,\"maxDepth\":31,\"measuredTransforms\":true,\"parentFollow\":true,\"dispatchDuringBlockingMenu\":true,\"unity\":\"" + Application.unityVersion + "\"}");
                EditorApplication.Exit(0);
            }
            catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
        }
    }
}
