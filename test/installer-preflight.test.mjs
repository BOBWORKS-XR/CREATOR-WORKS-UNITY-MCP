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

test('Windows PowerShell preserves installer paths and refuses locked/running targets without changes', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('test/fixtures/installer-preflight-windows.ps1'),
    '-Guard', path.resolve('launcher/src-tauri/windows/installer-preflight.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 110_000, maxBuffer: 128 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.ok(report.checks >= 20);
  for (const check of report.results) assert.equal(check.passed, true, check.test);
});
