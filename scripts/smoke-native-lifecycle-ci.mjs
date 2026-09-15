import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';

assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows', 'Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner.');
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve('artifacts/lifecycle-tools/node_modules/@playwright/test'));
const executable = path.resolve('artifacts/lifecycle-payload/creator-works-mcp-launcher.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256 = 'a35414684d943d214f9584d79debbb64db8e482489bc3c40fafc02368e9fb1dc';
assert.equal(hash(executable), sha256);
const out = path.resolve('artifacts/native-lifecycle');
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, executableSha256: sha256, sourceCommit: '8caf8a818ff5654dc255ab2c02fcf7c21525e7d5', acceptanceCommit: process.env.GITHUB_SHA, checks: [], productionUserMachineUsed: false };
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9239', WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
child.on('error', error => { report.launchError = String(error); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, milliseconds = 30000) {
  let error;
  for (const deadline = Date.now() + milliseconds; Date.now() < deadline;) {
    try { return await fn(); } catch (failure) { error = failure; await delay(200); }
  }
  throw error ?? Error('Native lifecycle deadline expired.');
}
function native(action = 'state') {
  // The workflow is hosted by PowerShell 7; keep its module environment in the same shell.
  const shell = path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  return JSON.parse(execFileSync(shell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/fixtures/native-lifecycle-window.ps1'),'-TargetPid',String(child.pid),'-Executable',executable,'-Action',action], { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}
let browser, page, lease;
try {
  browser = await wait(() => chromium.connectOverCDP('http://127.0.0.1:9239'), 60000);
  page = await wait(() => { const found = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); assert.ok(found); return found; });
  await page.waitForFunction(() => window.CreatorRuntime?.ready && window.__TAURI__?.core?.invoke);
  lease = await wait(() => page.evaluate(() => window.__TAURI__.core.invoke('begin_ui_operation')), 60000);
  await page.evaluate(async () => { window.nativeCloseRefusals = 0; await window.CreatorRuntime.listen('creator-lifecycle-close-blocked', () => window.nativeCloseRefusals++); });
  const busy = native(); assert.equal(busy.protocol, 1); assert.equal(busy.busy, 1); assert.equal(busy.closing, 0);
  const wrong = await page.evaluate(id => window.__TAURI__.core.invoke('finish_ui_operation', { id: id + 1 }).then(() => false, () => true), lease);
  assert.equal(wrong, true); assert.equal(native().busy, 1);
  report.checks.push('Exact packaged app exposes native protocol/busy properties; wrong lease cannot unlock it.');
  native('close');
  await page.waitForFunction(() => window.nativeCloseRefusals === 1);
  assert.equal(child.exitCode, null); assert.equal(native().busy, 1);
  await page.screenshot({ path: path.join(out, 'busy-close-refused.png') });
  report.checks.push('Actual WM_CLOSE was refused while a native UI operation was active, with the real refusal event.');
  await page.evaluate(id => window.__TAURI__.core.invoke('finish_ui_operation', { id }), lease); lease = null;
  await wait(() => { assert.equal(native().busy, 0); });
  native('close');
  await wait(() => { assert.notEqual(child.exitCode, null); }); assert.equal(child.exitCode, 0);
  report.checks.push('After the matching lease completed, actual idle WM_CLOSE exited the exact app normally.');
  assert.equal(hash(executable), sha256);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  if (lease != null && page && !page.isClosed()) await page.evaluate(id => window.__TAURI__.core.invoke('finish_ui_operation', { id }), lease).catch(() => {});
  if (child.exitCode === null) {
    try { native('close'); await wait(() => { assert.notEqual(child.exitCode, null); }, 10000); }
    catch (error) { report.cleanupError = String(error); report.passed = false; }
  }
  if (browser) await browser.close().catch(() => {});
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  // A still-busy owned process is left for disposable-runner cleanup, never killed.
  if (child.exitCode === null) child.unref();
  process.exitCode = report.passed ? 0 : 1;
}
