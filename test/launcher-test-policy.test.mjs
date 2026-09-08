import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../launcher/src/app.js", import.meta.url), "utf8");

function fixture(invoke) {
  const controls = Object.fromEntries([...source.matchAll(/elements\.(\w+)/g)].map(([, name]) => [name, {
    checked: false, disabled: false, handlers: {},
    addEventListener(event, handler) { this.handlers[event] = handler; },
  }]));
  const messages = [];
  const context = vm.createContext({
    document: { addEventListener() {} }, window: { __TAURI__: { core: { invoke } } }, controls, messages,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    Object.assign(elements, controls);
    config = { allow_all_tests: true, active_channel_id: 'a', channels: [
      {id:'a', unity_project_path:'ProjectA'}, {id:'b', unity_project_path:'ProjectB'}
    ] };
    showToast = message => messages.push(message);
    setupEventListeners();
  `, context);
  return { control: controls.allowAllTests, messages, context };
}

test("test-policy toggle does not update Unity if saving the preference fails", async () => {
  const calls = [];
  const f = fixture(async name => { calls.push(name); throw new Error("read-only config"); });
  await f.control.handlers.change();
  assert.deepEqual(calls, ["save_config"]);
  assert.equal(f.control.checked, true);
  assert.equal(f.control.disabled, false);
  assert.match(f.messages[0], /Failed to save test policy/);
});

test("test-policy toggle reports project write failure without an unhandled rejection", async () => {
  const f = fixture(async name => {
    if (name === "set_unity_allow_all_tests") throw new Error("invalid settings");
  });
  await f.control.handlers.change();
  assert.equal(f.control.disabled, false);
  assert.match(f.messages[0], /project test policy was not updated/);
});

test("test-policy toggle keeps the project selected when the action began", async () => {
  const calls = [];
  const f = fixture(async (name, args) => {
    if (name === "save_config") vm.runInContext("config.active_channel_id = 'b'", f.context);
    else calls.push({name, path: args.unityProjectPath, enabled: args.enabled});
  });
  await f.control.handlers.change();
  assert.deepEqual(calls, [{name: "set_unity_allow_all_tests", path: "ProjectA", enabled: false}]);
  assert.equal(f.control.disabled, false);
  assert.deepEqual(f.messages, []);
});
