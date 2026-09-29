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
const draftSmokeWorkflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "draft-install-smoke.yml"),
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

test("draft install smoke does not reuse PowerShell's automatic Matches variable", () => {
  assert.match(draftSmokeWorkflow, /\$assets = @\(\$release\.assets/);
  assert.doesNotMatch(draftSmokeWorkflow, /\$matches\s*=/i);
  assert.doesNotMatch(draftSmokeWorkflow, /\$matches\[/i);
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

test("release publishes Apple silicon and Intel macOS DMG bundles", () => {
  assert.equal(JSON.parse(tauriConfig).bundle.macOS.signingIdentity, "-");
  assert.match(releaseWorkflow, /name:\s*macOS DMG bundle/);
  assert.match(releaseWorkflow, /- os:\s*macos-latest\s+label:\s*Apple silicon/);
  assert.match(releaseWorkflow, /- os:\s*macos-15-intel\s+label:\s*Intel/);
  assert.match(releaseWorkflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/);
  assert.match(releaseWorkflow, /args:\s*"--bundles dmg"/);
  assert.match(releaseWorkflow, /name:\s*Verify macOS DMG/);
  assert.match(releaseWorkflow, /gh release view "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(releaseWorkflow, /gh release download "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(releaseWorkflow, /codesign --verify --deep --strict/);
});

test("release consolidates multi-platform checksums across all artifacts", () => {
  assert.match(releaseWorkflow, /needs:\s*\[windows,\s*linux,\s*macos,\s*verify-macos\]/);
  assert.match(releaseWorkflow, /node scripts\/release-checksums.mjs release-assets.json > SHA256SUMS.txt/);
  assert.match(releaseWorkflow, /gh release upload "\${{ github\.ref_name }}" SHA256SUMS\.txt/);
});


test("release labels resolve draft-safe asset URLs", () => {
  assert.match(releaseWorkflow, /gh release view .*--json assets --jq.*apiUrl/);
  assert.match(releaseWorkflow, /while read -r asset_api_url asset_name/);
  assert.match(releaseWorkflow, /gh api -X PATCH "\$asset_api_url"/);
  assert.match(releaseWorkflow, /\*aarch64\.dmg\)\s+label="Creator-Works-MCP-\$\{VERSION\}-macos-arm64\.dmg"/);
  assert.match(releaseWorkflow, /\*x64\.dmg\)\s+label="Creator-Works-MCP-\$\{VERSION\}-macos-x64\.dmg"/);
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
