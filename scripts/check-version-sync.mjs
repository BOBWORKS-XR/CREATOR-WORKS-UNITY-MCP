import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(
  readFileSync("launcher/src-tauri/tauri.conf.json", "utf8")
).version;
const cargoManifest = readFileSync("launcher/src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const serverSource = readFileSync("src/index.ts", "utf8");
assert.match(serverSource, /version:\s*MCP_VERSION/);
const serverVersion = readFileSync("src/lib/version.ts", "utf8").match(/MCP_VERSION\s*=\s*"([^"]+)"/)?.[1];
const launcherHtml = readFileSync("launcher/src/index.html", "utf8");
const launcherUiVersion = launcherHtml.match(/id="appVersion">v([^<]+)</)?.[1];
const unityBridge = readFileSync("unity-extension/Editor/BanterMCPBridge.cs", "utf8");
const bridgeVersion = unityBridge.match(/BridgeVersion\s*=\s*"([^"]+)"/)?.[1];

assert.ok(packageVersion, "package.json version is missing");
assert.equal(tauriVersion, packageVersion, "Tauri config version does not match package.json");
assert.equal(cargoVersion, packageVersion, "Cargo package version does not match package.json");
assert.equal(serverVersion, packageVersion, "MCP protocol version does not match package.json");
assert.equal(launcherUiVersion, packageVersion, "Launcher UI version does not match package.json");
assert.equal(bridgeVersion, packageVersion, "Unity bridge version does not match package.json");

const releaseTag = process.env.GITHUB_REF_NAME;
if (releaseTag?.startsWith("v")) {
  assert.equal(releaseTag, `v${packageVersion}`, "Release tag does not match package.json");
}

console.log(`Version metadata is synchronized at ${packageVersion}`);
