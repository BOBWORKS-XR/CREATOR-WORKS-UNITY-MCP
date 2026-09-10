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

test("tag builds stay draft and mark prerelease versions correctly", () => {
  assert.match(releaseWorkflow, /releaseDraft: true/);
  assert.equal((releaseWorkflow.match(/prerelease: \$\{\{ contains\(github.ref_name, '-'\) \}\}/g) || []).length, 3);
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
  assert.match(releaseWorkflow, /node scripts\/release-checksums.mjs release-assets.json > SHA256SUMS.txt/);
  assert.match(releaseWorkflow, /gh release upload "\${{ github\.ref_name }}" SHA256SUMS\.txt/);
});


test("release labels resolve draft-safe asset URLs", () => {
  assert.match(releaseWorkflow, /gh release view .*--json assets --jq.*apiUrl/);
  assert.match(releaseWorkflow, /while read -r asset_api_url asset_name/);
  assert.match(releaseWorkflow, /gh api -X PATCH "\$asset_api_url"/);
  assert.doesNotMatch(releaseWorkflow, /releases\/tags\//);
  assert.doesNotMatch(releaseWorkflow, /-f label=.*\|\| true/);
});

test("NSIS setup guards the bundled runtime without force-closing clients", () => {
  assert.match(
    tauriConfig,
    /"installerHooks": "\.\/windows\/installer-hooks\.nsh"/
  );
  assert.match(installerHooks, /NSIS_HOOK_PREINSTALL/);
  const guard = fs.readFileSync(path.join(root, 'launcher/src-tauri/windows/installer-preflight.ps1'), 'utf8');
  assert.match(installerHooks, /MUI_CUSTOMFUNCTION_GUIINIT CreatorMcpPreflight/);
  assert.match(installerHooks, /-File "\$PLUGINSDIR\\creator-mcp-preflight\.ps1" -InstallDir "\$3\\\."/);
  assert.doesNotMatch(installerHooks, /^\s*nsExec::[^\r\n]*\s-Command\s/m);
  assert.match(guard, /server\\runtime\\node\.exe/);
  assert.match(guard, /Get-CimInstance Win32_Process/);
  assert.match(guard, /-OperationTimeoutSec 8 -ErrorAction Stop/);
  assert.match(guard, /ExecutablePath/);
  assert.match(guard, /OrdinalIgnoreCase/);
  assert.match(guard, /FileShare\]::None/);
  assert.match(installerHooks, /MB_RETRYCANCEL/);
  assert.match(installerHooks, /IfSilent creator_preflight_cancel/);
  assert.match(installerHooks, /SetErrorLevel 10/);
  assert.doesNotMatch(
    installerHooks + guard,
    /\b(?:taskkill|Stop-Process|TerminateProcess)\b/i
  );
});
