using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace BantworksMCPFixture
{
    public static class HierarchyQuerySmoke
    {
        [Serializable]
        private sealed class Query
        {
            public string id;
            public string type = "query_hierarchy";
            public string queryKind = "hierarchy";
            public string filter = "";
            public string match = "contains";
            public string rootPath = "";
            public bool includeDescendants = true;
            public int maxDepth = -1;
            public int maxResults = 10;
            public string componentType = "";
            public string[] propertyNames = new string[0];
            public bool includeComponents = true;
            public bool includeComponentProperties = true;
            public long timestamp;
        }

        [Serializable]
        private sealed class Property
        {
            public string name;
            public string value;
        }

        [Serializable]
        private sealed class Item
        {
            public string name;
            public string path;
            public string objectPath;
            public string type;
            public Property[] properties;
            public Item[] components;
            public string[] missingProperties;
        }

        [Serializable]
        private sealed class Result
        {
            public string commandId;
            public bool success;
            public string error;
            public Item[] objects;
            public Item[] components;
            public int totalMatches;
            public int returned;
            public bool truncated;
        }

        public static void Run()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var unrelated = new GameObject("Unrelated").AddComponent<FixtureComponent>();
            unrelated.label = "Space";
            var parent = new GameObject("Container");
            var target = new GameObject("SpawnSpace");
            target.transform.SetParent(parent.transform);
            target.AddComponent<FixtureComponent>().count = 7;
            var inactive = new GameObject("InactiveSpace");
            inactive.SetActive(false);

            var contains = Execute(new Query { filter = "Space" });
            Check(contains.totalMatches == 2, "Contains matched a hidden property or missed an inactive object");
            Check(contains.objects.Any(item => item.path == "Container/SpawnSpace"), "Contains missed a nested object");

            var exact = Execute(new Query { filter = "Space", match = "exact" });
            Check(exact.totalMatches == 0, "Exact matching behaved like contains");

            var capped = Execute(new Query { filter = "Space", maxResults = 1 });
            Check(capped.totalMatches == 2 && capped.returned == 1 && capped.truncated,
                "Live result limit lost total count or truncation metadata");

            var identity = Execute(new Query { filter = "FixtureComp" });
            Check(identity.totalMatches == 2, "Hierarchy component type matching failed");

            var components = Execute(new Query {
                queryKind = "components", filter = "SpawnSpace", componentType = "FixtureComponent",
                propertyNames = new[] { "count" }
            });
            Check(components.components.Length == 1 && components.components[0].objectPath == "Container/SpawnSpace",
                "Component query did not retain the intended child");
            Check(components.components[0].properties.Length == 1 && components.components[0].properties[0].name == "count",
                "Component property projection returned unrelated values");

            var projected = Execute(new Query { queryKind = "components", propertyNames = new[] { "count" } });
            Check(projected.components.Count(item => item.type == "FixtureComponent") == 2,
                "A valid property-only query was rejected or lost components");
            Check(projected.components.All(item => item.properties.All(property => property.name == "count")),
                "Property-only query included unrequested properties");

            var rendererObject = GameObject.CreatePrimitive(PrimitiveType.Cube);
            rendererObject.name = "RendererProbe";
            foreach (bool enabled in new[] { false, true })
            {
                rendererObject.GetComponent<Renderer>().enabled = enabled;
                var renderer = Execute(new Query {
                    queryKind = "components", rootPath = "RendererProbe", componentType = "MeshRenderer",
                    propertyNames = new[] { "m_Enabled", "m_Materials", "NotAProperty" }
                }).components.Single();
                Check(renderer.properties.Single(p => p.name == "m_Enabled").value == (enabled ? "true" : "false"),
                    "Renderer enabled projection must distinguish false from missing");
                Check(renderer.properties.Count(p => p.name == "m_Materials") == 1,
                    "Renderer materials must be a single bounded summary under the requested name");
                Check(renderer.missingProperties.SequenceEqual(new[] { "NotAProperty" }),
                    "Missing property evidence is absent or falsely includes supported fields");
            }
            var nested = Execute(new Query {
                queryKind = "components", rootPath = "RendererProbe", componentType = "Transform",
                propertyNames = new[] { "m_LocalPosition.x" }
            }).components.Single();
            Check(nested.properties.Single().name == "m_LocalPosition.x", "Nested serialized property path was lost");

            var compact = Execute(new Query { rootPath = "RendererProbe", includeComponentProperties = false });
            Check(compact.objects.Single().components.All(c => c.properties.Length == 0),
                "Identity-only hierarchy results still serialized properties");
            var noComponents = Execute(new Query { rootPath = "RendererProbe", includeComponents = false });
            Check(noComponents.objects.Single().components.Length == 0, "Transform-only query still serialized components");
            Debug.Log("[CREATOR WORKS FIXTURE] Live hierarchy query smoke passed");
        }

        private static Result Execute(Query command)
        {
            command.id = Guid.NewGuid().ToString();
            command.timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string root = Path.Combine(Directory.GetParent(Application.dataPath).FullName, ".bantworks-mcp");
            string commands = Path.Combine(root, "commands");
            string snapshot = Path.Combine(root, "state", "scene-hierarchy.json");
            byte[] before = File.Exists(snapshot) ? File.ReadAllBytes(snapshot) : null;
            Directory.CreateDirectory(commands);
            File.WriteAllText(Path.Combine(commands, command.id + ".json"), JsonUtility.ToJson(command));
            MethodInfo process = typeof(BantworksMCP.BantworksMCPBridge).GetMethod(
                "ProcessCommands", BindingFlags.Static | BindingFlags.NonPublic);
            Check(process != null, "Bridge command processor not found");
            process.Invoke(null, null);
            string resultPath = Path.Combine(root, "state", "hierarchy-query-results", command.id + ".json");
            Check(File.Exists(resultPath), "No correlated live hierarchy result");
            var result = JsonUtility.FromJson<Result>(File.ReadAllText(resultPath));
            Check(result.commandId == command.id && result.success, "Live hierarchy query failed: " + result.error);
            Check(before == null ? !File.Exists(snapshot) : File.ReadAllBytes(snapshot).SequenceEqual(before),
                "Targeted query rewrote the full scene snapshot");
            return result;
        }

        private static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
