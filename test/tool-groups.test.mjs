import assert from "node:assert/strict";
import test from "node:test";

import { createConfigForProject } from "../dist/lib/config.js";
import { handleResourceRead, registerResources } from "../dist/resources/index.js";
import {
  ALWAYS_AVAILABLE_TOOLS,
  TOOL_GROUP_MEMBERSHIP,
  TOOL_GROUP_NAMES,
  describeToolGroupSelection,
  handleToolCall,
  parseToolGroupSelection,
  registerTools,
} from "../dist/tools/index.js";

test("tool groups cover every registered tool", () => {
  const allTools = registerTools().map((tool) => tool.name);
  const covered = new Set(ALWAYS_AVAILABLE_TOOLS);
  for (const group of TOOL_GROUP_NAMES) {
    for (const name of TOOL_GROUP_MEMBERSHIP[group]) covered.add(name);
  }

  assert.equal(allTools.length, 53);
  assert.deepEqual([...covered].sort(), [...allTools].sort());
});

test("tool group resource is generated from the enforced membership", () => {
  const config = createConfigForProject("");
  assert.ok(registerResources(config).some((resource) => resource.uri === "banter://tool-groups"));
  const response = handleResourceRead("banter://tool-groups", config);
  const payload = JSON.parse(response.contents[0].text);

  assert.equal(payload.default, "all");
  assert.equal(payload.serverDefaultWhenUnset, "all");
  assert.equal(payload.launcherDefault, "core");
  assert.deepEqual(payload.alwaysAvailable.sort(), [...ALWAYS_AVAILABLE_TOOLS].sort());
  for (const group of TOOL_GROUP_NAMES) {
    assert.deepEqual(payload.groups[group].sort(), [...TOOL_GROUP_MEMBERSHIP[group]].sort());
  }
});

test("tool group parsing is composable and rejects ambiguous configuration", () => {
  assert.equal(parseToolGroupSelection(undefined), "all");
  assert.equal(parseToolGroupSelection(" ALL "), "all");
  assert.equal(describeToolGroupSelection(parseToolGroupSelection("none")), "none");
  assert.equal(
    describeToolGroupSelection(parseToolGroupSelection("banter, core,banter")),
    "core,banter"
  );

  assert.throws(() => parseToolGroupSelection("all,read"), /cannot combine/i);
  assert.throws(() => parseToolGroupSelection("none,test"), /cannot combine/i);
  assert.throws(() => parseToolGroupSelection("admin"), /Unknown CREATOR_WORKS_TOOL_GROUPS/);
  assert.throws(() => parseToolGroupSelection(",,,"), /must contain/);
});

test("limited selections retain project routing and expose only selected capabilities", () => {
  const minimalNames = registerTools(parseToolGroupSelection("none")).map((tool) => tool.name);
  assert.deepEqual(minimalNames.sort(), [...ALWAYS_AVAILABLE_TOOLS].sort());

  const coreNames = new Set(registerTools(parseToolGroupSelection("core")).map((tool) => tool.name));
  assert.ok(coreNames.has("query_project_state"));
  assert.ok(coreNames.has("create_gameobject"));
  assert.ok(coreNames.has("set_asset_reference"));
  assert.ok(!coreNames.has("generate_vs_graph"));
  assert.ok(!coreNames.has("run_unity_tests"));

  const readNames = new Set(registerTools(parseToolGroupSelection("read")).map((tool) => tool.name));
  assert.ok(readNames.has("query_project_state"));
  assert.ok(readNames.has("capture_unity_screenshot"));
  assert.ok(!readNames.has("create_gameobject"));
  assert.ok(!readNames.has("run_unity_tests"));

  const banterNames = new Set(registerTools(parseToolGroupSelection("banter")).map((tool) => tool.name));
  assert.ok(banterNames.has("search_sidequest_vs_nodes"));
  assert.ok(banterNames.has("write_vs_graph"));
  assert.ok(banterNames.has("validate_banter_visual_scripting"));
  assert.ok(!banterNames.has("modify_gameobject"));
});

test("authoring profiles include the validation and inspection prerequisites of their graph tools", () => {
  for (const value of ["author", "core,author"]) {
    const names = new Set(registerTools(parseToolGroupSelection(value)).map((tool) => tool.name));
    for (const required of [
      "generate_vs_graph", "validate_vs_graph", "write_vs_graph", "get_banter_sdk_info",
      "search_sidequest_vs_nodes", "get_shader_graph_capabilities", "list_shader_graphs",
      "inspect_shader_graph", "create_shader_graph", "validate_shader_graph",
    ]) {
      assert.ok(names.has(required), `${value} is missing ${required}`);
    }
  }
});

test("disabled tools cannot be invoked by name", async () => {
  await assert.rejects(
    handleToolCall(
      "create_gameobject",
      {},
      createConfigForProject(""),
      undefined,
      parseToolGroupSelection("read")
    ),
    /disabled by CREATOR_WORKS_TOOL_GROUPS/
  );
});
