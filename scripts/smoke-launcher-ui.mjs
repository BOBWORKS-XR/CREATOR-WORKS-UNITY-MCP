import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Supply an existing Playwright installation. No production dependency, Tauri
// process, client config, project directory or external website is used here.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'launcher-ui');
await fs.mkdir(output, { recursive: true });
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']],
  ['/app-chrome.js', ['app-chrome.js', 'text/javascript']],
  ['/updates.js', ['updates.js', 'text/javascript']], ['/creator-works-logo.png', ['creator-works-logo.png', 'image/png']],
  ['/icons/external-link.svg', ['icons/external-link.svg', 'image/svg+xml']]
]);
const server = http.createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://localhost').pathname);
  if (!entry) { response.writeHead(404).end(); return; }
  try {
    const data = await fs.readFile(path.join(root, 'launcher', 'src', entry[0]));
    response.writeHead(200, { 'Content-Type': entry[1] }).end(data);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext();
  const failures = [];
  await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  await context.addInitScript(() => {
    const channel = (id, name) => ({ id, name, unity_project_path: `C:\\UnityFixtures\\${name}` });
    const channels = [channel('a', 'Creator Forest'), channel('b', 'Banter Playground'), channel('c', 'Unity Sandbox')];
    const state = window.fixture = { calls: [], links: [], gates: {}, errors: {}, channels,
      config: { channels, active_channel_id: 'a', mcp_server_path: 'C:\\CreatorWorks\\server.mjs',
        tool_groups: 'core', auto_start: true, enable_custom_scripts: false, allow_all_tests: true,
        automatic_update_checks: false } };
    state.hold = name => new Promise(resolve => { state.gates[name] = resolve; });
    const profile = project => ({ profile: project?.includes('Banter') ? 'banter' : 'creator',
      label: state.long ? 'Creator SDK 4.0.14 experimental compatibility verification pending' :
        (project?.includes('Banter') ? 'Banter SDK 3.1.2' : 'Creator SDK 4.0.14'), packages: [] });
    window.__TAURI__ = {
      shell: { open: async url => { state.links.push(url); if (state.errors.link) throw new Error('fixture link failure'); } },
      dialog: { open: async () => state.hold('picker') },
      core: { invoke: async (name, args) => {
        state.calls.push({ name, args });
        if (state.errors[name]) throw new Error(state.errors[name]);
        switch (name) {
          case 'load_config': return structuredClone(state.config);
          case 'save_config': state.config = structuredClone(args.config); return;
          case 'discover_unity_projects': return state.config.channels.map(c => ({name:c.name,path:c.unity_project_path,unityVersion:'6000.3.21f1'}));
          case 'get_onboarding_status':
            if (state.deferStatus) { await state.hold('status'); }
            return {runtime:{ready:true,bundled:true}, project: args.unityProjectPath ? {valid:!state.invalid,
              bridgeInstalled:true,bridgeCurrent:true,stateStatus:'fresh',sdkProfile:profile(args.unityProjectPath)} : null,
              clients:['codex','claude','antigravity','opencode'].map(id => ({id,detected:true,configured:true}))};
          case 'get_project_feedback_settings': return {enabled:false,usageCheckIns:false};
          case 'get_project_sdk_profile': return profile(args.unityProjectPath);
          case 'get_unity_extension_status': return {current:true,installed:true};
          case 'one_click_setup': return state.hold('setup');
          case 'update_configured_unity_extensions': await state.hold('bridges'); return {updated:3,failed:[]};
          case 'update_codex_mcp_config':
          case 'update_claude_mcp_config':
          case 'update_antigravity_mcp_config':
          case 'update_opencode_mcp_config':
          case 'set_project_feedback_settings':
          case 'set_unity_allow_all_tests':
          case 'set_unity_custom_scripts': return;
          default: throw new Error('Unexpected mocked command: ' + name);
        }
      } }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  async function ready() {
    await page.waitForFunction(() => !document.getElementById('workspaceControls').disabled &&
      document.querySelectorAll('.bridge-badge.success').length === 3);
  }
  async function layout(label, width, height) {
    await page.evaluate(() => document.querySelector('.toast')?.remove());
    await page.setViewportSize({width,height});
    const geometry = await page.evaluate(() => {
      const tab = document.querySelector('.app-tab').getBoundingClientRect();
      const header = document.querySelector('.header').getBoundingClientRect();
      return { scroll:document.documentElement.scrollWidth, viewport:innerWidth, tab:{x:tab.x,w:tab.width,h:tab.height},
        headerHeight:header.height, font:getComputedStyle(document.body).fontFamily,
        titleX:document.querySelector('.brand-lockup').getBoundingClientRect().x,
        bg:getComputedStyle(document.body).backgroundColor,
        images:[...document.images].every(img => img.complete && img.naturalWidth > 0),
        badgeVisible:[...document.querySelectorAll('.project-meta')].every(el => getComputedStyle(el).display !== 'none') };
    });
    if (geometry.scroll !== geometry.viewport) {
      console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el =>
        el.getBoundingClientRect().right > innerWidth && el.getBoundingClientRect().width).map(el =>
        ({tag:el.tagName,id:el.id,class:el.className,right:el.getBoundingClientRect().right})).slice(0,20)));
      await page.screenshot({path:path.join(output,label + '-failed.png'),fullPage:true});
    }
    assert.equal(geometry.scroll, geometry.viewport, label + ': horizontal overflow');
    assert.deepEqual(geometry.tab, {x:-1,w:54,h:46});
    assert.equal(geometry.titleX,76);
    if (width > 520) assert.equal(geometry.headerHeight, 72);
    assert.match(geometry.font, /Segoe UI/);
    assert.equal(geometry.bg, 'rgb(9, 11, 13)');
    assert.ok(geometry.images && geometry.badgeVisible);
    await page.screenshot({path:path.join(output, label + '.png'),fullPage:true});
    checks.push(label);
  }
  await page.setViewportSize({width:900,height:700});
  await page.goto(base);
  await ready();
  assert.equal(await page.locator('#setupBtn').isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => !/^(load_config|discover_unity_projects|get_)/.test(c.name))), []);
  await layout('desktop-900',900,700);
  await layout('compact-desktop-560',560,600);
  await page.setViewportSize({width:900,height:700});
  const toggle = page.locator('#appSwitcherToggle');
  const menu = page.locator('#appSwitcherMenu');
  const shell = page.locator('#appSwitcherShell');
  const items = menu.getByRole('menuitem');
  async function closed() {
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await menu.evaluate(el => el.inert),true);
    assert.equal(await items.count(),0);
    await page.waitForFunction(() => {
      const shell = document.getElementById('appSwitcherShell');
      return shell.getBoundingClientRect().width === 55 &&
        getComputedStyle(document.getElementById('appSwitcherMenu')).visibility === 'hidden';
    });
    assert.equal(await menu.isVisible(),false);
  }
  async function expanded() {
    await page.waitForFunction(() => {
      const shell = document.getElementById('appSwitcherShell').getBoundingClientRect();
      return shell.width === 224 && shell.height === Math.min(294, innerHeight - 24) &&
        getComputedStyle(document.getElementById('appSwitcherMenu')).opacity === '1';
    });
    assert.equal(await menu.evaluate(el => el.inert),false);
    assert.equal(await page.locator('.brand-lockup').evaluate(el => getComputedStyle(el).opacity),'0');
  }
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await items.nth(0).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await items.nth(3).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.links), []);
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await closed();
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  await toggle.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.links), ['https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases']);
  await closed();
  await toggle.press('ArrowDown');
  await page.keyboard.press('Escape');
  await closed();
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  await toggle.click();
  await expanded();
  await toggle.click();
  await closed();
  await toggle.click();
  await expanded();
  const setupPosition = await page.locator('#setupBtn').boundingBox();
  await page.mouse.move(setupPosition.x + setupPosition.width / 2, setupPosition.y + setupPosition.height / 2);
  await page.mouse.down();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true', 'pointerdown must not dismiss scrim early');
  await page.mouse.up();
  await closed();
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'one_click_setup').length),0);
  await toggle.click();
  await expanded();
  const bridgesPosition = await page.locator('#updateBridgesBtn').boundingBox();
  await page.mouse.click(bridgesPosition.x + bridgesPosition.width / 2, bridgesPosition.y + bridgesPosition.height / 2);
  await closed();
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'update_configured_unity_extensions').length),0);
  checks.push('click-away consumes setup and bridge-update clicks without invoking either operation');
  await toggle.click();
  await page.keyboard.press('Tab');
  await closed();
  assert.equal(await page.locator('#projectPath').evaluate(el => el === document.activeElement), true);
  await toggle.click();
  await page.keyboard.press('Shift+Tab');
  await closed();
  await toggle.click();
  await expanded();
  assert.equal(await shell.evaluate(el => el.getBoundingClientRect().width),224);
  await page.screenshot({path:path.join(output,'desktop-menu.png')});
  await page.keyboard.press('Escape');
  await closed();
  await toggle.click();
  await items.nth(0).click();
  assert.equal(await page.evaluate(() => fixture.links.at(-1)),
    'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md');
  await closed();
  await page.evaluate(() => { fixture.errors.link = true; });
  await toggle.click();
  await items.nth(0).click();
  await page.getByRole('alert').filter({hasText:'Could not open the public page'}).waitFor();
  await closed();
  await page.evaluate(() => { fixture.errors.link = false; document.querySelector('.toast')?.remove(); });
  checks.push('menu keyboard, current/disabled entries, public release link, Escape, Tab and outside dismissal');

  await page.locator('#browseProjectBtn').click();
  await page.waitForFunction(() => !!fixture.gates.picker);
  assert.equal(await page.locator('#setupBtn').isEnabled(),false);
  await page.evaluate(() => fixture.gates.picker(null));
  await ready();
  await page.locator('.project-select').nth(1).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => fixture.config.active_channel_id === 'b' && !document.getElementById('workspaceControls').disabled);
  assert.equal(await page.locator('.project-select').nth(1).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#projectPath').inputValue(),'C:\\UnityFixtures\\Banter Playground');
  await page.locator('.project-select').nth(0).click();
  await page.waitForFunction(() => fixture.config.active_channel_id === 'a' && !document.getElementById('workspaceControls').disabled);
  checks.push('public plan/error handling, cancelled picker and keyboard project selection');

  await page.locator('#setupBtn').click();
  await page.waitForFunction(() => !!fixture.gates.setup);
  for (const selector of ['#browseProjectBtn','#addProjectBtn','#updateBridgesBtn','#projectPath','#connectCodex','#toolGroups','#allowAllTests','#automaticUpdates','.project-select','.remove-project']) {
    assert.equal(await page.locator(selector).first().isEnabled(), false, selector + ' should be locked');
  }
  await page.locator('#setupBtn').evaluate(el => el.click());
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'one_click_setup').length),1);
  assert.equal(await toggle.isEnabled(),true);
  await page.screenshot({path:path.join(output,'setup-busy.png')});
  await page.evaluate(() => fixture.gates.setup());
  await ready();
  assert.equal(await page.locator('#usageCheckIns').isEnabled(),false);
  assert.equal(await page.locator('#setupBtn').isEnabled(),true);
  const setupCall = await page.evaluate(() => fixture.calls.find(c => c.name === 'one_click_setup'));
  assert.equal(setupCall.args.unityProjectPath, 'C:\\UnityFixtures\\Creator Forest');
  assert.equal(Object.keys(setupCall.args).length,7);
  await page.evaluate(() => { fixture.errors.one_click_setup = 'Mock setup failed'; });
  await page.locator('#setupBtn').click();
  await page.waitForFunction(() => document.getElementById('setupMessage').textContent.includes('Mock setup failed'));
  assert.equal(await page.locator('#browseProjectBtn').isEnabled(),true);
  checks.push('operation lock, duplicate suppression, captured project/consent, success and failure recovery');

  await page.locator('#updateBridgesBtn').click();
  await page.waitForFunction(() => !!fixture.gates.bridges);
  assert.equal(await page.locator('.project-select').first().isEnabled(),false);
  await page.evaluate(() => fixture.gates.bridges());
  await ready();
  await page.evaluate(() => { fixture.deferStatus = true; fixture.invalid = true; });
  await page.locator('#projectPath').fill('C:\\UnityFixtures\\Invalid');
  assert.equal(await page.locator('#setupBtn').isEnabled(),false);
  await page.waitForFunction(() => !!fixture.gates.status);
  assert.equal(await page.locator('#setupBtn').isEnabled(),false);
  await page.evaluate(() => { fixture.deferStatus = false; fixture.gates.status(); });
  await page.waitForFunction(() => document.querySelector('[data-check="project"] strong').textContent === 'Invalid');
  checks.push('bridge-update lock and no stale readiness after project edits');

  await page.reload();
  await ready();
  await page.evaluate(() => {
    fixture.long = true;
    fixture.config.channels[0].name = 'CreatorForest_LongProjectName_WithUnbrokenText_'.repeat(5);
    fixture.config.channels[0].unity_project_path = 'C:\\UnityFixtures\\' + 'VeryLongProjectDirectory'.repeat(14);
  });
  await page.locator('#updateBridgesBtn').click();
  await page.waitForFunction(() => !!fixture.gates.bridges);
  await page.evaluate(() => fixture.gates.bridges());
  await ready();
  await page.locator('details').evaluate(el => { el.open = true; });
  await layout('long-names-900',900,700);
  await layout('small-desktop-640',640,600);
  await layout('minimum-desktop-560',560,600);
  await layout('mobile-390',390,844);
  await layout('narrow-320',320,700);
  await page.evaluate(() => scrollTo(0,0));
  await toggle.click();
  await expanded();
  await page.screenshot({path:path.join(output,'narrow-menu.png')});
  await page.keyboard.press('Escape');
  await closed();
  await page.setViewportSize({width:900,height:700});
  const motion = await page.evaluate(async () => {
    const shell = document.getElementById('appSwitcherShell');
    const tab = document.getElementById('appSwitcherToggle');
    const rect = () => {
      const r = document.querySelector('.main').getBoundingClientRect();
      return [r.x,r.y,r.width,r.height,scrollY];
    };
    const baseline = rect();
    const samples = [];
    const start = performance.now();
    tab.click();
    do {
      await new Promise(requestAnimationFrame);
      const r = shell.getBoundingClientRect();
      samples.push({ms:Math.round(performance.now()-start),w:r.width,h:r.height,
        tabX:tab.getBoundingClientRect().x,bodyStable:JSON.stringify(rect()) === JSON.stringify(baseline),
        shellScroll:shell.scrollTop});
    } while (performance.now() - start < 300);
    return samples;
  });
  assert.ok(motion.some(s => s.w > 55 && s.w < 224 && s.h > 48 && s.h < 294), 'intermediate animation frames');
  assert.ok(motion.every(s => s.bodyStable && s.shellScroll === 0), 'drawer must not resize/scroll the body or frame');
  assert.equal(motion.at(-1).w,224);
  assert.equal(motion.at(-1).tabX,168);
  await expanded();
  await page.keyboard.press('Escape');
  await closed();
  const reversed = await page.evaluate(async () => {
    const toggle = document.getElementById('appSwitcherToggle');
    const menu = document.getElementById('appSwitcherMenu');
    toggle.click();
    await new Promise(requestAnimationFrame);
    toggle.click();
    const inertImmediately = menu.inert && menu.getAttribute('aria-hidden') === 'true';
    menu.querySelector('[role="menuitem"]').focus();
    return {inertImmediately,focusRetained:document.activeElement === toggle};
  });
  assert.deepEqual(reversed,{inertImmediately:true,focusRetained:true});
  await closed();

  // Pause actual CSS transitions only for an inspectable intermediate screenshot.
  await page.evaluate(() => {
    document.getElementById('appSwitcherToggle').click();
    document.getElementById('appSwitcherShell').getBoundingClientRect();
    window.fixture.motionAnimations = document.getAnimations();
    for (const animation of fixture.motionAnimations) { animation.pause(); animation.currentTime = 90; }
  });
  await page.screenshot({path:path.join(output,'drawer-midmotion.png')});
  await page.evaluate(() => { for (const animation of fixture.motionAnimations) animation.finish(); });
  await expanded();
  await page.keyboard.press('Escape');
  await closed();
  checks.push('intermediate morph frames, moving logo, stable body/frame, reversal and immediate inert focus protection');

  await page.setViewportSize({width:560,height:240});
  await toggle.press('ArrowUp');
  await expanded();
  const short = await menu.evaluate(el => {
    const shell = document.getElementById('appSwitcherShell').getBoundingClientRect();
    const last = el.querySelector('[aria-disabled="true"]').getBoundingClientRect();
    return {shellBottom:shell.bottom,scroll:el.scrollTop,lastBottom:last.bottom,active:document.activeElement === el.querySelector('[aria-disabled="true"]')};
  });
  assert.ok(short.shellBottom <= 228 && short.lastBottom <= short.shellBottom && short.scroll > 0 && short.active);
  await page.screenshot({path:path.join(output,'drawer-short-window.png')});
  await page.keyboard.press('Home');
  assert.equal(await menu.evaluate(el => el.scrollTop),6);
  await page.keyboard.press('Escape');
  await closed();
  checks.push('short viewport drawer scroll and keyboard access to all entries');

  await page.setViewportSize({width:900,height:700});
  await page.emulateMedia({reducedMotion:'reduce'});
  await toggle.click();
  await expanded();
  const reduced = await page.evaluate(() => [...document.querySelectorAll('.app-shell,.app-scrim,.app-menu,.app-drawer-title,.brand-lockup')]
    .map(el => ({duration:getComputedStyle(el).transitionDuration,transform:getComputedStyle(el).transform})));
  assert.ok(reduced.every(value => value.duration === '0s' && value.transform === 'none'));
  await page.screenshot({path:path.join(output,'drawer-reduced-motion.png')});
  await toggle.click();
  await closed();
  checks.push('reduced-motion disables all drawer and title transitions');
  await fs.writeFile(path.join(output,'motion-results.json'),JSON.stringify({motion,reversed,short,reduced},null,2) + '\n');
  assert.deepEqual(failures,[]);
  const report = {success:true, checks, limitations:'Mocked browser/Tauri only. No native GUI, real setup, install or Unity runtime actions performed.'};
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2) + '\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
