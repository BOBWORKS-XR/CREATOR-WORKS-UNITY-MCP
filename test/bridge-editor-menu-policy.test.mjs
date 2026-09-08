import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = fs.readFileSync(
  path.join(root, "unity-extension", "Editor", "BanterMCPBridge.cs"),
  "utf8"
);
const bridgeLogo = path.join(
  root,
  "unity-extension",
  "Editor",
  "CreatorWorksMCPLogo.png"
);

test("status window uses the Creator Works launcher lockup", () => {
  assert.ok(fs.existsSync(bridgeLogo));
  assert.match(bridge, /LogoAssetFileName = "CreatorWorksMCPLogo\.png"/);
  assert.match(bridge, /titleContent = new GUIContent\("Creator Works MCP", logoTexture\)/);
  assert.match(bridge, />CREATOR<\/color>/);
  assert.match(bridge, />WORKS<\/color>/);
  assert.match(bridge, />MCP<\/color>/);
  assert.match(bridge, /SHADER GRAPH PREVIEW/);
  assert.doesNotMatch(bridge, /GUILayout\.Label\("BANT"/);
  assert.doesNotMatch(bridge, /MCP Status/);
});

test("Editor menu commands block unsafe Editor states and built-in roots", () => {
  assert.match(bridge, /EditorApplication\.isCompiling \|\| EditorApplication\.isUpdating/);
  assert.match(bridge, /EditorApplication\.isPlayingOrWillChangePlaymode && !cmd\.allowInPlayMode/);
  assert.match(bridge, /activeScene\.isDirty && !cmd\.allowDirtyScene/);
  for (const rootName of ["File", "Edit", "Assets", "GameObject", "Component", "Window", "Help", "CONTEXT"]) {
    assert.match(bridge, new RegExp(`"${rootName}"`));
  }
});

test("Editor menu commands return correlated execution evidence", () => {
  assert.match(bridge, /EditorApplication\.ExecuteMenuItem\(menuPath\)/);
  assert.match(bridge, /Path\.Combine\(EditorMenuResultsFolder, cmd\.id \+ "\.json"\)/);
  assert.match(bridge, /result\.before = CaptureEditorOperationState|before = CaptureEditorOperationState/);
  assert.match(bridge, /result\.after = CaptureEditorOperationState\(\)/);
  assert.match(bridge, /result\.durationMs = Math\.Max/);
  assert.match(bridge, /LogType\.Exception/);
  assert.match(bridge, /LogType\.Assert/);
  assert.match(bridge, /result\.executionSucceeded = true/);
});

test("targeted hierarchy queries are correlated and avoid full-state export", () => {
  assert.match(bridge, /case "query_hierarchy"/);
  assert.match(bridge, /Path\.Combine\(HierarchyQueryResultsFolder, cmd\.id \+ "\.json"\)/);
  assert.match(bridge, /CreateGameObjectInfo/);
  assert.doesNotMatch(bridge, /case "query_hierarchy":[\s\S]{0,300}ExportProjectState/);
});

test("hierarchy text filters inspect identity fields without serializing properties", () => {
  assert.match(bridge, /Live hierarchy queries require rootPath, filter, componentType, or propertyNames/);
  assert.match(bridge, /IdentityTextMatches\(gameObject\.name, filter, match\)/);
  assert.match(bridge, /IdentityTextMatches\(component\.GetType\(\)\.FullName, filter, match\)/);
  assert.doesNotMatch(bridge, /JsonUtility\.ToJson\(info\)\.IndexOf\(filter/);
});

test("targeted hierarchy property reads expose bounded renderer material identity", () => {
  assert.match(bridge, /includedPropertyNames/);
  assert.match(bridge, /CreateRendererMaterialProperty/);
  assert.match(bridge, /renderer\.sharedMaterials/);
  assert.match(bridge, /sharedMaterials\.Take\(64\)/);
  assert.match(bridge, /string assetPath = material != null \? AssetDatabase\.GetAssetPath\(material\) : null/);
  assert.match(bridge, /shader = material != null && material\.shader != null \? material\.shader\.name : null/);
});
