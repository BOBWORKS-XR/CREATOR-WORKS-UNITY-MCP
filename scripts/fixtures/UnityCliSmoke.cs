using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace CreatorWorksSmoke
{
    [InitializeOnLoad]
    public static class UnityCliSmoke
    {
        private static readonly string Root = Path.GetDirectoryName(Application.dataPath);

        static UnityCliSmoke()
        {
            if (Array.IndexOf(Environment.GetCommandLineArgs(), "-creatorWorksCliSmoke") < 0 ||
                !File.Exists(Path.Combine(Root, "cli-smoke-owner.json"))) return;
            EditorApplication.delayCall += Prepare;
            EditorApplication.update += CheckShutdown;
        }

        private static void Prepare()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                EditorApplication.delayCall += Prepare;
                return;
            }
            if (File.Exists(Path.Combine(Root, "cli-smoke-ready.json"))) return;
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("CreatorWorksCliProbe");
            for (var index = 0; index < 2; index++)
            {
                var child = new GameObject("CLI Probe & Quoted");
                child.transform.SetParent(root.transform, false);
                child.transform.localPosition = new Vector3(index, 2, 3);
            }
            var parent = root.transform;
            new GameObject("--no-cloud & \"quoted\"").transform.SetParent(root.transform, false);
            for (var index = 0; index < 31; index++)
            {
                var child = new GameObject("Depth" + index);
                child.transform.SetParent(parent, false);
                parent = child.transform;
            }
            EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), "Assets/CliProbe.unity");
            File.WriteAllText(Path.Combine(Root, "cli-smoke-ready.json"),
                "{\"ready\":true,\"expectedNamedObjects\":2,\"expectedObjects\":35}");
        }

        private static void CheckShutdown()
        {
            if (File.Exists(Path.Combine(Root, "cli-smoke-stop"))) EditorApplication.Exit(0);
        }
    }
}
