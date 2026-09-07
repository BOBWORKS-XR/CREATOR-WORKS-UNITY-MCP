import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseWorkflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "release.yml"),
  "utf8"
);
const tauriConfig = fs.readFileSync(
  path.join(root, "launcher", "src-tauri", "tauri.conf.json"),
  "utf8"
);
const installerHooks = fs.readFileSync(
  path.join(root, "launcher", "src-tauri", "windows", "installer-hooks.nsh"),
  "utf8"
);

test("release checksums use GitHub-normalized asset names", () => {
  assert.match(
    releaseWorkflow,
    /\$releaseAssetName = \$artifact\.Name\.Replace\(" ", "\."\)/
  );
  assert.match(releaseWorkflow, /"\$hash  \$releaseAssetName"/);
});

test("release metadata states the enforced standalone Node requirement", () => {
  assert.match(releaseWorkflow, /standalone ZIP remains available for manual Node\.js 20\+ deployments/);
  assert.doesNotMatch(releaseWorkflow, /Node\.js 18\+/);
});

test("tag builds create a stable draft for final asset inspection", () => {
  assert.match(releaseWorkflow, /releaseDraft: true/);
  assert.match(releaseWorkflow, /prerelease: false/);
});

test("release publishes one guided Windows installer path", () => {
  assert.match(releaseWorkflow, /args: "--bundles nsis"/);
  assert.doesNotMatch(releaseWorkflow, /--bundles[^\r\n]*msi/i);
  assert.match(releaseWorkflow, /\.Extension -eq "\.exe"/);
  assert.doesNotMatch(releaseWorkflow, /\.Extension -in[^\r\n]*\.msi/i);
});

test("release publishes Linux AppImage, DEB, and RPM bundles", () => {
  assert.match(releaseWorkflow, /name:\s*Linux AppImage, DEB, and RPM bundle/);
  assert.match(releaseWorkflow, /runs-on:\s*ubuntu-22\.04/);
  assert.match(releaseWorkflow, /NO_STRIP:\s*1/);
  assert.match(releaseWorkflow, /args:\s*"--bundles appimage,deb,rpm"/);
});

test("release publishes macOS DMG bundle", () => {
  assert.match(releaseWorkflow, /name:\s*macOS DMG bundle/);
  assert.match(releaseWorkflow, /runs-on:\s*macos-latest/);
  assert.match(releaseWorkflow, /args:\s*"--bundles dmg"/);
});

test("release consolidates multi-platform checksums across all artifacts", () => {
  assert.match(releaseWorkflow, /needs:\s*\[windows,\s*linux,\s*macos\]/);
  assert.match(releaseWorkflow, /select\(\.name != "SHA256SUMS\.txt"\)/);
  assert.match(releaseWorkflow, /gh release upload "\${{ github\.ref_name }}" SHA256SUMS\.txt/);
});


test("NSIS setup guards the bundled runtime without force-closing clients", () => {
  assert.match(
    tauriConfig,
    /"installerHooks": "\.\/windows\/installer-hooks\.nsh"/
  );
  assert.match(installerHooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(installerHooks, /server\\runtime\\node\.exe/);
  assert.match(installerHooks, /Get-CimInstance Win32_Process/);
  assert.match(installerHooks, /-ErrorAction Stop/);
  assert.match(installerHooks, /catch \{ exit 11 \}/);
  assert.match(installerHooks, /ExecutablePath/);
  assert.match(installerHooks, /OrdinalIgnoreCase/);
  assert.match(installerHooks, /MB_RETRYCANCEL/);
  assert.match(installerHooks, /IfSilent creator_works_mcp_runtime_silent_abort/);
  assert.match(installerHooks, /SetErrorLevel 10/);
  assert.doesNotMatch(
    installerHooks,
    /\b(?:taskkill|Stop-Process|TerminateProcess)\b/i
  );
});
