import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync("launcher/src-tauri/src/main.rs", "utf8");
const hub = fs.readFileSync("launcher/src-tauri/src/hub.rs", "utf8");

test("Hub metadata dispatch precedes all existing launcher startup code", () => {
  const entry = main.slice(main.indexOf("fn main() {"));
  assert.match(entry, /^fn main\(\) \{\s*if let Some\(code\) = hub::handle_entry/);
  assert.ok(entry.indexOf("std::process::exit(code)") < entry.indexOf("tauri::Builder"));
  assert.ok(entry.indexOf("std::process::exit(code)") < entry.indexOf("env::set_var"));
});

test("Hub module cannot reach application/configuration/network or project operations", () => {
  assert.doesNotMatch(hub, /tauri::|crate::|super::(?!\*)|std::fs|std::net|Command::|reqwest|load_config|save_config|one_click_setup/);
  assert.match(hub, /version: env!\("CARGO_PKG_VERSION"\)/);
  assert.match(hub, /MAX_INFO_BYTES: usize = 4096/);
  assert.doesNotMatch(hub, /"launch\.singleInstance"/);
});

test("metadata does not add a first-run prompt, Hub dependency or single-instance plugin", () => {
  const manifest = fs.readFileSync("launcher/src-tauri/Cargo.toml", "utf8");
  assert.doesNotMatch(manifest, /single-instance|creator-hub/);
  assert.doesNotMatch(main, /tauri_plugin_single_instance/);
});
