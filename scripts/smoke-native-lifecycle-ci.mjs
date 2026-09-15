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
const sha256 = process.env.CANDIDATE_EXECUTABLE_SHA256;
const sourceCommit = process.env.CANDIDATE_SOURCE;
assert.match(sha256 ?? '', /^[a-f0-9]{64}$/, 'A reviewed executable hash is required.');
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'A reviewed source commit is required.');
assert.equal(hash(executable), sha256);
const out = path.resolve('artifacts/native-lifecycle');
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, executableSha256: sha256, sourceCommit, acceptanceCommit: process.env.GITHUB_SHA, checks: [], productionUserMachineUsed: false };
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
  return JSON.parse(execFileSync(shell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/fixtures/native-lifecycle-window.ps1'),'-TargetPid',String(child.pid),'-Executable',executable,'-ExpectedSha256',sha256,'-Action',action], { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}
let browser, page, lease;
try {
  browser = await wait(() => chromium.connectOverCDP('http://127.0.0.1:9239'), 60000);
  page = await wait(() => { const found = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); assert.ok(found); return found; });
  await page.waitForFunction(() => window.CreatorRuntime?.ready && window.__TAURI__?.core?.invoke);
  await page.locator('#appSwitcherToggle').click();
  await page.locator('[data-local-view="plugins"]').waitFor({ state: 'visible' });
  const logo = await page.locator('[data-local-view="plugins"] img').evaluate(async img => {
    await img.decode();
    const response = await fetch(img.src);
    if (!response.ok) throw new Error('Packaged logo could not be read.');
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 30;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0, 30, 30);
    const data = context.getImageData(0, 0, 30, 30).data;
    const pixels = { transparent: 0, visible: 0, cyan: 0, red: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = data.subarray(i, i + 4);
      if (a === 0) pixels.transparent++;
      if (a > 128) {
        pixels.visible++;
        if (b > 100 && g > 100 && r < 80) pixels.cyan++;
        if (r > 150 && g < 130 && b < 130) pixels.red++;
      }
    }
    return { sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), width: img.naturalWidth, height: img.naturalHeight, renderedWidth: img.width, pixels };
  });
  assert.equal(logo.sha256, 'ff107f1c0bca0380f35f25754fd023d60311fa4457f6fd84255a8f41f78fee6d');
  assert.equal(logo.width, 256); assert.equal(logo.height, 256); assert.equal(logo.renderedWidth, 30);
  assert.ok(logo.pixels.transparent > 100 && logo.pixels.visible > 100 && logo.pixels.cyan > 3 && logo.pixels.red > 3);
  report.logo = logo;
  await page.screenshot({ path: path.join(out, 'approved-logo-menu.png') });
  await page.keyboard.press('Escape');
  report.checks.push('Exact packaged app serves the approved PNG hash and renders transparent cyan/red artwork at menu size.');
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
