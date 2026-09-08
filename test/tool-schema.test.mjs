import assert from "node:assert/strict";
import test from "node:test";

import {
  combineEditorMenuSettleResult,
  isValidUnityTestRunId,
  normalizeUnityAssetGuid,
  normalizeUnityAssetReferencePath,
  normalizeCustomEditorMenuPath,
  normalizeUnityVisualScriptingAssetPath,
  normalizeUnitySceneAssetPath,
  playModeStateMatches,
  registerTools,
  searchSidequestVSNodes,
} from "../dist/tools/index.js";

const tools = new Map(registerTools().map((tool) => [tool.name, tool]));

test("tool names are unique", () => {
  const names = registerTools().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
});

test("project routing exposes stable explicit session selection", () => {
  const list = tools.get("list_unity_projects")?.inputSchema;
  assert.ok(list);

  const select = tools.get("select_unity_project")?.inputSchema;
  assert.deepEqual(select?.required, ["projectId"]);
  assert.equal(select?.properties.projectId.pattern, "^unity-[a-f0-9]{20}$");
});

test("scene tools expose stable ID selectors with path compatibility", () => {
  for (const name of ["delete_gameobject", "modify_gameobject", "add_component", "get_object_bounds"]) {
    const schema = tools.get(name)?.inputSchema;
    assert.ok(schema, `missing ${name}`);
    assert.ok(schema.properties.objectId, `${name} must expose objectId`);
    assert.ok(schema.properties.objectPath, `${name} must retain objectPath`);
    assert.ok(
      schema.anyOf?.some((option) => option.required.includes("objectId")),
      `${name} must accept objectId`
    );
  }
});

test("component property writes expose typed values and component IDs", () => {
  const schema = tools.get("set_component_property")?.inputSchema;
  assert.ok(schema);
  assert.ok(schema.properties.componentId);
  assert.ok(schema.properties.value.oneOf);
  assert.ok(schema.properties.value.oneOf.some((option) => option.type === "boolean"));
  assert.ok(schema.properties.value.oneOf.some((option) => option.type === "array"));
});

test("asset references expose stable selectors and fail-closed asset targets", () => {
  const schema = tools.get("set_asset_reference")?.inputSchema;
  assert.ok(schema);
  assert.deepEqual(schema.required, ["propertyName"]);
  assert.equal(schema.properties.assetGuid.pattern, "^[0-9a-fA-F]{32}$");
  assert.equal(schema.properties.clear.default, false);
  assert.equal(schema.allOf.length, 2);
  assert.equal(schema.allOf[1].anyOf[2].properties.clear.const, true);

  assert.equal(
    normalizeUnityAssetReferencePath("Assets\\Graphs\\Respawn.asset"),
    "Assets/Graphs/Respawn.asset"
  );
  assert.equal(
    normalizeUnityAssetReferencePath("Packages/com.example/Runtime/Data.asset"),
    "Packages/com.example/Runtime/Data.asset"
  );
  assert.equal(normalizeUnityAssetReferencePath("Assets/../Outside.asset"), undefined);
  assert.equal(normalizeUnityAssetReferencePath("C:/Outside.asset"), undefined);
  assert.equal(normalizeUnityAssetGuid("ABCDEF0123456789ABCDEF0123456789"), "abcdef0123456789abcdef0123456789");
  assert.equal(normalizeUnityAssetGuid("not-a-guid"), undefined);
});

test("batch tools advertise rollback-first behavior", () => {
  for (const name of ["batch_create", "batch_instantiate_prefabs"]) {
    const option = tools.get(name)?.inputSchema.properties.continueOnError;
    assert.ok(option, `missing ${name}.continueOnError`);
    assert.equal(option.default, false);
  }
});

test("Play Mode schema is bounded and state matching waits for compilation", () => {
  const schema = tools.get("control_play_mode")?.inputSchema;
  assert.deepEqual(schema?.properties.action.enum, ["play", "pause", "resume", "stop"]);
  assert.equal(schema?.properties.timeoutMs.maximum, 120000);

  assert.equal(
    playModeStateMatches("play", { isPlaying: true, isPaused: false, isCompiling: true }),
    false
  );
  assert.equal(
    playModeStateMatches("pause", { isPlaying: true, isPaused: true, isCompiling: false }),
    true
  );
  assert.equal(
    playModeStateMatches("stop", {
      isPlaying: false,
      isPaused: false,
      isCompiling: false,
      isPlayingOrWillChangePlaymode: true,
    }),
    false
  );
});

test("screenshot tool exposes bounded Game and Scene capture", () => {
  const schema = tools.get("capture_unity_screenshot")?.inputSchema;
  assert.deepEqual(schema?.properties.source.enum, ["game", "scene"]);
  assert.equal(schema?.properties.width.minimum, 64);
  assert.equal(schema?.properties.width.maximum, 2048);
  assert.equal(schema?.properties.height.maximum, 2048);
  assert.ok(schema?.properties.cameraId);
  assert.equal(schema?.properties.includeImage.default, true);
  assert.equal(schema?.properties.maxImageBytes.default, 2097152);
  assert.equal(schema?.properties.maxImageBytes.maximum, 16777216);
});

test("project discovery exposes packages and bounded AssetDatabase search", () => {
  const packages = tools.get("get_unity_packages")?.inputSchema;
  assert.equal(packages?.properties.directOnly.default, false);
  assert.ok(tools.get("get_banter_sdk_info"));

  const assets = tools.get("search_unity_assets")?.inputSchema;
  assert.deepEqual(assets?.required, ["query"]);
  assert.equal(assets?.properties.limit.maximum, 500);
  assert.equal(assets?.properties.includePackages.default, false);
});

test("project state queries expose bounded exact hierarchy inspection", () => {
  const schema = tools.get("query_project_state")?.inputSchema;
  assert.deepEqual(schema?.properties.query.enum, ["hierarchy", "components"]);
  assert.deepEqual(schema?.properties.match.enum, ["contains", "exact"]);
  assert.equal(schema?.properties.includeDescendants.default, false);
  assert.equal(schema?.properties.maxDepth.maximum, 100);
  assert.equal(schema?.properties.maxResults.default, 200);
  assert.equal(schema?.properties.maxResults.maximum, 5000);
  assert.equal(schema?.properties.propertyNames.maxItems, 50);
  assert.equal(schema?.properties.maxResponseBytes.default, 65536);
  assert.equal(schema?.properties.maxResponseBytes.maximum, 4194304);
  assert.equal(schema?.properties.refresh.default, true);
  assert.equal(schema?.properties.timeoutMs.maximum, 120000);
});

test("prefab catalog exposes an explicit bounded result limit", () => {
  const schema = tools.get("get_prefab_catalog")?.inputSchema;
  assert.equal(schema?.properties.limit.type, "integer");
  assert.equal(schema?.properties.limit.minimum, 1);
  assert.equal(schema?.properties.limit.maximum, 500);
  assert.equal(schema?.properties.limit.default, 100);
});

test("console queries expose normalized errors and bounded source filters", () => {
  const schema = tools.get("get_console_logs")?.inputSchema;
  assert.equal(schema?.properties.limit.maximum, 1000);
  assert.equal(schema?.properties.limit.default, 50);
  assert.ok(schema?.properties.sinceTimestamp);
  assert.ok(schema?.properties.contains);
  assert.ok(schema?.properties.regex);
  assert.ok(schema?.properties.stackContains);
});

test("compile wait is explicit and bounded", () => {
  const schema = tools.get("wait_for_unity_compile")?.inputSchema;
  assert.equal(schema?.properties.timeoutMs.default, 30000);
  assert.equal(schema?.properties.timeoutMs.minimum, 1000);
  assert.equal(schema?.properties.timeoutMs.maximum, 120000);
});

test("Visual Scripting write tools constrain asset names", () => {
  for (const name of ["generate_vs_graph", "write_vs_graph"]) {
    const graphName = tools.get(name)?.inputSchema.properties.graphName;
    assert.equal(graphName.minLength, 1);
    assert.equal(graphName.maxLength, 128);
    assert.ok(graphName.pattern);
  }

  const unityValidation = tools.get("validate_vs_graph_in_unity")?.inputSchema;
  assert.deepEqual(unityValidation?.required, ["assetPath"]);
  assert.equal(unityValidation?.properties.assetPath.maxLength, 1024);
  assert.equal(unityValidation?.properties.allowUnboundValueInputs.default, false);
  assert.equal(
    normalizeUnityVisualScriptingAssetPath("Assets\\Graphs\\Respawn.asset"),
    "Assets/Graphs/Respawn.asset"
  );
  assert.equal(normalizeUnityVisualScriptingAssetPath("Assets/../Outside.asset"), undefined);
  assert.equal(normalizeUnityVisualScriptingAssetPath("Packages/Graph.asset"), undefined);

  const banterValidation = tools.get("validate_banter_visual_scripting")?.inputSchema;
  assert.deepEqual(banterValidation?.properties, {});

  const generation = tools.get("generate_vs_graph")?.inputSchema;
  const node = generation?.properties.nodes.items;
  assert.deepEqual(node?.properties.position.required, ["x", "y"]);
  assert.deepEqual(node?.properties.size.required, ["width", "height"]);
  assert.equal(generation?.properties.layout.properties.gridSize.minimum, 1);
  assert.equal(generation?.properties.layout.properties.horizontalGap.maximum, 2048);
});

test("SideQuest Visual Scripting catalog search is targeted and bounded", () => {
  const schema = tools.get("search_sidequest_vs_nodes")?.inputSchema;
  assert.deepEqual(schema?.required, ["query"]);
  assert.equal(schema?.properties.query.maxLength, 128);
  assert.equal(schema?.properties.limit.default, 10);
  assert.equal(schema?.properties.limit.maximum, 25);

  const exact = searchSidequestVSNodes("TeleportTo", "User", 10);
  assert.equal(exact.success, true);
  assert.equal(exact.nodes[0].name, "TeleportTo");
  assert.equal(exact.nodes[0].defaultValues.some((value) => value.name === "Stop Velocity"), true);

  const bounded = searchSidequestVSNodes("on", undefined, 2);
  assert.equal(bounded.success, true);
  assert.equal(bounded.nodes.length, 2);
  assert.equal(bounded.truncated, true);

  const invalid = searchSidequestVSNodes("TeleportTo", undefined, 26);
  assert.equal(invalid.success, false);
  assert.deepEqual(invalid.nodes, []);
  for (const category of [null, 42, {}, []]) {
    assert.equal(searchSidequestVSNodes("TeleportTo", category).success, false);
  }
});

test("Unity Test Runner tools expose bounded filters and safe run IDs", () => {
  const discover = tools.get("discover_unity_tests")?.inputSchema;
  assert.deepEqual(discover?.properties.mode.enum, ["edit", "play", "all"]);
  assert.equal(discover?.properties.search.maxLength, 512);
  assert.equal(discover?.properties.maxResults.maximum, 5000);
  assert.equal(discover?.properties.timeoutMs.maximum, 120000);

  const run = tools.get("run_unity_tests")?.inputSchema;
  assert.deepEqual(run?.properties.mode.enum, ["edit", "play", "all"]);
  assert.equal(run?.properties.timeoutMs.maximum, 600000);
  assert.equal(run?.properties.maxResults.maximum, 5000);
  assert.equal(run?.properties.testNames.maxItems, 200);

  const cancel = tools.get("cancel_unity_test_run")?.inputSchema;
  assert.deepEqual(cancel?.required, ["runId"]);
  assert.equal(cancel?.properties.runId.maxLength, 128);

  const status = tools.get("get_unity_test_run")?.inputSchema;
  assert.deepEqual(status?.required, ["runId"]);
  assert.equal(isValidUnityTestRunId("2a2aa2d2-10ef-41c7-b852-fbc43a95f30c"), true);
  assert.equal(isValidUnityTestRunId("../outside"), false);
});

test("scene lifecycle tools expose explicit dirty-scene and build-list contracts", () => {
  const open = tools.get("open_unity_scene")?.inputSchema;
  assert.deepEqual(open?.properties.mode.enum, ["single", "additive"]);
  assert.equal(open?.properties.saveModifiedScenes.default, false);
  assert.deepEqual(open?.required, ["scenePath"]);

  const build = tools.get("set_unity_build_scenes")?.inputSchema;
  assert.equal(build?.properties.scenes.maxItems, 500);
  assert.deepEqual(build?.properties.scenes.items.required, ["path", "enabled"]);

  assert.equal(normalizeUnitySceneAssetPath("Assets/Scenes/Main.unity"), "Assets/Scenes/Main.unity");
  assert.equal(normalizeUnitySceneAssetPath("Assets\\Scenes\\Main.unity"), "Assets/Scenes/Main.unity");
  assert.equal(normalizeUnitySceneAssetPath("Assets/../Outside.unity"), undefined);
  assert.equal(normalizeUnitySceneAssetPath("Packages/demo.unity"), undefined);
});

test("Editor menu execution is custom-only and fail-closed by default", () => {
  const schema = tools.get("execute_editor_menu_item")?.inputSchema;
  assert.deepEqual(schema?.required, ["menuPath"]);
  assert.equal(schema?.properties.allowInPlayMode.default, false);
  assert.equal(schema?.properties.allowDirtyScene.default, false);
  assert.equal(schema?.properties.waitForSettled.default, true);
  assert.equal(schema?.properties.timeoutMs.maximum, 120000);

  assert.equal(normalizeCustomEditorMenuPath("Banter Kart/Rebuild Bundles"), "Banter Kart/Rebuild Bundles");
  assert.equal(normalizeCustomEditorMenuPath("Tools/BANTWORKS/Test"), "Tools/BANTWORKS/Test");
  assert.equal(normalizeCustomEditorMenuPath("File/Exit"), undefined);
  assert.equal(normalizeCustomEditorMenuPath("Assets/Delete"), undefined);
  assert.equal(normalizeCustomEditorMenuPath("Window/Layouts/Delete All"), undefined);
});

test("Editor menu execution remains successful when settling is unverified", () => {
  const stale = combineEditorMenuSettleResult(
    { success: true, executionReturnedTrue: true },
    { success: false, settled: false, stale: true, message: "Unity editor state is stale." }
  );
  const compileFailure = combineEditorMenuSettleResult(
    { success: true, executionReturnedTrue: true },
    { success: false, settled: true, stale: false, compilationHasErrors: true, message: "Compilation failed." }
  );

  assert.equal(stale.success, true);
  assert.equal(stale.executionSucceeded, true);
  assert.equal(stale.settleVerified, false);
  assert.match(stale.warning ?? "", /not verified/);
  assert.equal(compileFailure.success, false);
  assert.equal(compileFailure.executionSucceeded, true);
  assert.equal(compileFailure.settleVerified, true);
  assert.equal(compileFailure.settleError, "Compilation failed.");
});

test("Unity command status requires both correlation and project identity", () => {
  const schema = tools.get("get_unity_command_status")?.inputSchema;
  assert.deepEqual(schema?.required, ["commandId", "projectId"]);
  assert.equal(schema?.properties.commandId.format, "uuid");
  assert.equal(schema?.properties.projectId.pattern, "^unity-[a-f0-9]{20}$");
});
