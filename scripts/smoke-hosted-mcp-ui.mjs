import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

// Browser-only contract fixture. No installed Hub, native backend, settings or Unity is opened.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts', 'hosted-mcp-ui');
await fs.mkdir(output, { recursive: true });
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), name + '/');
    else files[name] = (await fs.readFile(path.join(directory, entry.name))).toString('base64');
  }
}
await collect(path.join(root, 'launcher', 'src'));
const server = http.createServer((request, response) => {
  if (request.url === '/files') response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(files));
  else response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body style="margin:0;background:#090b0d"><div id="mount"></div></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [];
const errors = [];
const external = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base + '/')) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(base);
  await page.evaluate(async () => {
    const files = await (await fetch('/files')).json();
    const decode = name => new TextDecoder().decode(Uint8Array.from(atob(files[name]), c => c.charCodeAt(0)));
    const data = name => `data:${name.endsWith('.js') ? 'text/javascript' : name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/css'};base64,${files[name]}`;
    const doc = new DOMParser().parseFromString(decode('index.html'), 'text/html');
    for (const script of doc.querySelectorAll('script[src]')) script.src = data(script.getAttribute('src'));
    for (const style of doc.querySelectorAll('link[rel="stylesheet"]')) {
      const css = decode(style.getAttribute('href')).replace(/url\(['"]?([^)'"\s]+)['"]?\)/g, (_, name) => `url("${data(name)}")`);
      style.href = 'data:text/css;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(css)));
    }
    for (const img of doc.querySelectorAll('img[src]')) img.src = data(img.getAttribute('src'));
    const csp = doc.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "default-src 'none'; script-src data:; style-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    doc.head.prepend(csp);
    const frame = document.createElement('iframe');
    frame.id = 'mcp-frame'; frame.title = 'MCP contract fixture';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'display:block;width:100%;height:900px;border:0';
    const channel = new MessageChannel();
    const state = window.fixture = { calls: [], port: channel.port1, ready: false, picker: null, failSnapshot: false };
    const name = 'Creator project with a deliberately long name for compatibility and layout verification';
    const config = { channels: [
      { id: 'one', name, unity_project_path: 'C:\\Fixtures\\' + name, enabled: true },
      { id: 'two', name: 'Second fixture <not markup>', unity_project_path: 'C:\\Fixtures\\Second', enabled: false }],
      active_channel_id: 'one', mcp_server_path: 'C:\\Fixtures\\CreatorWorks\\dist\\index.js', auto_start: true,
      enable_custom_scripts: false, allow_all_tests: true, tool_groups: 'core', automatic_update_checks: true };
    function reply(id, result, error) { state.port.postMessage({ type: 'result', id, ok: !error, result, error }); }
    state.finishPicker = value => { reply(state.picker, value); state.picker = null; };
    state.port.onmessage = ({ data }) => {
      if (data.type === 'ready') { state.ready = true; return; }
      if (data.type !== 'invoke') return;
      state.calls.push(data);
      if (data.command === 'get_hosted_snapshot') reply(data.id,
        { config, source: 'current', readOnly: true, resourceDir: 'C:\\Fixtures\\CreatorWorks' },
        state.failSnapshot ? 'Invalid saved configuration; unchanged.' : undefined);
      else if (data.command === 'pick_project_folder') state.picker = data.id;
      else if (data.command === 'open_official_url') reply(data.id, null);
      else reply(data.id, null, 'Unexpected command');
    };
    frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'creator-host-connect', protocol: 1 }, '*', [channel.port2]), { once: true });
    frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
    document.getElementById('mount').append(frame);
  });
  const frame = page.frameLocator('#mcp-frame');
  await frame.locator('#hostedPreviewStatus').filter({ hasText: 'Saved configuration loaded' }).waitFor();
  assert.equal(await frame.locator('#workspaceControls').evaluate(el => el.disabled), true);
  assert.equal(await frame.locator('.header').isVisible(), false);
  assert.equal(await frame.locator('.footer').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => fixture.calls.map(item => item.command)), ['get_hosted_snapshot']);
  assert.equal(await frame.locator('.project-card').count(), 2);
  checks.push('shared UI loads one read-only snapshot, no startup migration or update fetch');
  for (const width of [900, 560, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await frame.locator('body').evaluate(() => ({
      width: innerWidth, scroll: document.documentElement.scrollWidth,
      fieldsDisabled: [...document.querySelectorAll('#workspaceControls button, #workspaceControls input, #workspaceControls select')].every(el => el.matches(':disabled')),
      title: document.querySelector('#hostedPreview strong').textContent,
      images: [...document.images].every(img => img.complete && img.naturalWidth > 0),
    }));
    assert.equal(geometry.width, geometry.scroll, `overflow at ${width}`);
    assert.equal(geometry.fieldsDisabled, true);
    assert.equal(geometry.images, true);
    await page.screenshot({ path: path.join(output, `hosted-${width}.png`), fullPage: true });
    checks.push(`hosted ${width}px with long names and disabled mutation controls`);
  }
  await frame.locator('#hostedBrowse').click();
  await page.waitForFunction(() => fixture.picker !== null);
  assert.equal(await frame.locator('#hostedRefresh').isDisabled(), true);
  assert.equal(await frame.locator('#hostedBrowse').isDisabled(), true);
  await page.evaluate(() => document.getElementById('mount').hidden = true);
  await page.evaluate(() => fixture.finishPicker('C:\\Fixtures\\Unsaved folder choice'));
  await page.evaluate(() => document.getElementById('mount').hidden = false);
  await frame.locator('#hostedPickedFolder').filter({ hasText: 'Unsaved folder choice' }).waitFor();
  assert.equal(await frame.locator('#hostedBrowse').isEnabled(), true);
  checks.push('picker locks conflicting controls; folder choice survives hidden-frame completion without persistence');
  await page.evaluate(() => fixture.failSnapshot = true);
  await frame.locator('#hostedRefresh').click();
  await frame.locator('#hostedPreviewStatus').filter({ hasText: 'Invalid saved configuration' }).waitFor();
  assert.equal(await frame.locator('.project-card').count(), 2);
  assert.equal(await frame.locator('#hostedRefresh').isEnabled(), true);
  checks.push('read failure preserves last displayed snapshot and allows retry');
  const denied = await frame.locator('body').evaluate(async () => {
    try { await window.CreatorRuntime.invoke('save_config', {}); return false; } catch { return true; }
  });
  assert.equal(denied, true);
  assert.equal(await page.evaluate(() => fixture.calls.some(item => item.command === 'save_config')), false);
  checks.push('mutation request blocked by adapter before host transport');
  await frame.locator('#hostedBrowse').click();
  await page.waitForFunction(() => fixture.picker !== null);
  const before = await page.evaluate(() => fixture.calls.length);
  await page.evaluate(() => fixture.port.postMessage({ type: 'disconnect' }));
  await frame.locator('#hostedPreviewStatus').filter({ hasText: 'disconnected' }).waitFor();
  assert.equal(await frame.locator('#hostedBrowse').isDisabled(), true);
  assert.equal(await frame.locator('#hostedRefresh').isDisabled(), true);
  assert.equal(await page.evaluate(() => fixture.calls.length), before);
  checks.push('disconnect during picker permanently locks preview; no retries or false completion');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks, errors, external, native: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
