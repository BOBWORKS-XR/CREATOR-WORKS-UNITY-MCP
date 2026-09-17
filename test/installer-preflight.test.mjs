import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('native NSIS fixture uses the exact production command line', () => {
  const command = file => readFileSync(file, 'utf8').split(/\r?\n/)
    .find(line => line.trimStart().startsWith('nsExec::ExecToStack'))?.trim();
  const production = command('launcher/src-tauri/windows/installer-hooks.nsh');
  assert.ok(production);
  assert.equal(command('test/fixtures/installer-hook-harness.nsi'), production);
});

test('installed acceptance can run on the approved test branch without publishing', () => {
  const workflow = readFileSync('.github/workflows/windows-installer-acceptance.yml', 'utf8');
  assert.match(workflow, /push:\s+branches:\s+- feature\/creator-hub-compatibility/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|tags:|gh release|tauri-apps\/tauri-action/);
});

test('stable and alpha upgrades test one build before exposing the accepted candidate', () => {
  const workflow = readFileSync('.github/workflows/windows-installer-acceptance.yml', 'utf8');
  assert.match(workflow, /baseline: \['2\.6\.0', '2\.7\.0-alpha\.1', '2\.7\.0-alpha\.2', '2\.7\.0', '2\.7\.1'\]/);
  assert.equal((workflow.match(/build --bundles nsis/g) || []).length, 1);
  assert.match(workflow, /accepted-candidate:\s+needs: \[build-candidate, installed-upgrade\]/);
  assert.match(workflow, /EXPECTED_INSTALLER_SHA256: \$\{\{ needs\.build-candidate\.outputs\.installer-sha256 \}\}/);
  const harness = readFileSync('scripts/test-installed-upgrade-ci.ps1', 'utf8');
  assert.match(harness, /ValidateSet\('2\.6\.0', '2\.7\.0-alpha\.1', '2\.7\.0-alpha\.2', '2\.7\.0', '2\.7\.1'\)/);
  assert.match(harness, /4782b6ab04e09a8d24c5fd67d8c75fde8b508d09c04cb1391d953cd51d3aaa66/);
  assert.match(harness, /6e1ba9d8d4eee99b35b60c9093efd1b3c19183d2cc184266a0696b8a57b0376d/);
  assert.match(harness, /Packaged runtime cleanup differs from the reviewed source/);
  assert.match(harness, /MCP_SHUTDOWN_NODE/);
  assert.match(workflow, /run-id: 34985053768/);
  assert.match(workflow, /name: mcp-windows-stable-candidate/);
  assert.match(harness, /e5997ad60ae7d331b15a0b1038042e8062492589602724206eeb943093113c1e/);
  assert.match(harness, /7138bbf4efe3e58018071e7023220f0c637ddd89339f1a9de0d8db2a6b5f62e7/);
  assert.ok(harness.indexOf('Accepted alpha 2 artifact hash mismatch') < harness.indexOf("Run-Setup $baseline '/S /NS'"));
  assert.match(harness, /8f39b9f2e120076346873dc8cc3186e6a2c055e1cca4cf9b8b66dfb700f12c41/);
  assert.match(harness, /04971c5c6cc2c3346606d4ae96bbea465c9924b564a1fe928f7d7d006527de65/);
  assert.ok(harness.indexOf('Candidate differs from the exact installer') < harness.indexOf("Run-Setup $baseline '/S /NS'"));
  assert.match(harness, /ExpectedSourceCommit = \$env:GITHUB_SHA/);
  assert.match(harness, /sourceCommit -ceq \$ExpectedSourceCommit/);
  assert.match(harness, /baselineVersion = \$BaselineVersion/);
});

test('candidate replay pins the original build and never rebuilds or publishes it', () => {
  const workflow = readFileSync('.github/workflows/windows-candidate-replay.yml', 'utf8');
  assert.match(workflow, /35283535011/);
  assert.match(workflow, /c9c0c64a1bdff5008904afbad266089fca52171c/);
  assert.match(workflow, /13f0e14bf321227f59788f13ec9253dff092891bb3144607e37263d5ee16e2ca/);
  assert.match(workflow, /CANDIDATE_EXECUTABLE_SHA256: '815147c99d04fa496c2d6d0d6d984aa99dee7c91b7cd880fefa2488eb089f610'/);
  assert.match(workflow, /if \(\$env:BASELINE_VERSION -ceq '2\.7\.1'\) \{ \$extra\.TestInteractivePrompts = \$true \}/);
  assert.match(workflow, /accepted-candidate:\s+needs: \[upgrade, lifecycle\]/);
  assert.doesNotMatch(workflow, /cargo build|tauri.*build|gh release|contents: write/);
  const diagnostic = readFileSync('scripts/test-installed-upgrade-ci.ps1', 'utf8');
  assert.match(diagnostic, /if \(\$child.ExitCode -ne \$expected\) \{\s+Save-RefusalDiagnostic/);
});

test('reviewed stable hotfixes promote accepted Windows bytes without a tag rebuild or checksum overwrite', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  for (const job of ['windows', 'linux', 'macos', 'checksums']) {
    const body = workflow.split(`\n  ${job}:\r\n`)[1] ?? workflow.split(`\n  ${job}:\n`)[1];
    assert.ok(body, job);
    assert.match(body.split(/\r?\n  [a-z]+:/)[0], /if: \$\{\{ [^\r\n]*github\.ref_name != 'v2\.7\.0' && github\.ref_name != 'v2\.7\.1' && github\.ref_name != 'v2\.7\.2' \}\}/);
  }
  assert.equal((workflow.match(/!contains\(github\.ref_name, '-'\)/g) || []).length, 3);
});

test('native installer prompt helper refuses local execution before inspecting windows', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'test/fixtures/installer-native-prompts.ps1'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted' },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Native installer prompt acceptance requires a disposable GitHub-hosted Windows runner/);
});

test('installed-upgrade CI harness refuses a local machine before resolving installer paths', {
  skip: process.platform !== 'win32',
}, () => {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('scripts/test-installed-upgrade-ci.ps1'), '-Installer', 'must-not-be-opened.exe'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted' },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
});

test('native lifecycle driver and window helper refuse local execution before accessing app state', {
  skip: process.platform !== 'win32',
}, () => {
  const env = { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted' };
  const driver = spawnSync(process.execPath, ['scripts/smoke-native-lifecycle-ci.mjs'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, env,
  });
  assert.ifError(driver.error);
  assert.notEqual(driver.status, 0);
  assert.match(driver.stderr, /Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner/);
  const helper = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.resolve('test/fixtures/native-lifecycle-window.ps1'), '-TargetPid', '1',
    '-Executable', 'must-not-be-opened.exe', '-ExpectedSha256', '0'.repeat(64)], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, env,
  });
  assert.ifError(helper.error);
  assert.notEqual(helper.status, 0);
  assert.match(helper.stderr, /Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner/);
});

test('Windows PowerShell preserves installer paths and refuses locked/running targets without changes', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('test/fixtures/installer-preflight-windows.ps1'),
    '-Guard', path.resolve('launcher/src-tauri/windows/installer-preflight.ps1'),
    '-Stopper', path.resolve('launcher/src-tauri/windows/installer-runtime-stop.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 110_000, maxBuffer: 128 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.ok(report.checks >= 20);
  for (const check of report.results) assert.equal(check.passed, true, check.test);
});
