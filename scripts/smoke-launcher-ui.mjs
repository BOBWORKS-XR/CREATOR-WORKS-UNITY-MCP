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
const output = path.resolve(process.env.LAUNCHER_UI_ARTIFACTS || path.join(root, 'artifacts', 'launcher-ui'));
await fs.mkdir(output, { recursive: true });
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']],
  ['/app-chrome.js', ['app-chrome.js', 'text/javascript']],
  ['/runtime.js', ['runtime.js', 'text/javascript']],
  ['/community-adapter.js', ['community-adapter.js', 'text/javascript']],
  ['/community.js', ['community.js', 'text/javascript']],
  ['/community.css', ['community.css', 'text/css']],
  ['/icons/puzzle.svg', ['icons/puzzle.svg', 'image/svg+xml']],
  ['/icons/creator-plugins.png', ['icons/creator-plugins.png', 'image/png']],
  ['/icons/folder-open.svg', ['icons/folder-open.svg', 'image/svg+xml']],
  ['/icons/refresh-cw.svg', ['icons/refresh-cw.svg', 'image/svg+xml']],
  ['/icons/download.svg', ['icons/download.svg', 'image/svg+xml']],
  ['/icons/layout-grid.svg', ['icons/layout-grid.svg', 'image/svg+xml']],
  ['/icons/list.svg', ['icons/list.svg', 'image/svg+xml']],
  ['/updates.js', ['updates.js', 'text/javascript']], ['/creator-works-logo.png', ['creator-works-logo.png', 'image/png']],
  ['/sidequest-mark-white.svg', ['sidequest-mark-white.svg', 'image/svg+xml']],
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
  const communityEntry = JSON.parse(await fs.readFile(path.join(root, 'launcher/tests/fixtures/community/start-location.json'), 'utf8'));
  await context.addInitScript(entry => {
    const channel = (id, name) => ({ id, name, unity_project_path: `C:\\UnityFixtures\\${name}` });
    const channels = [channel('a', 'Creator Forest'), channel('b', 'Banter Playground'), channel('c', 'Unity Sandbox')];
    const state = window.fixture = { calls: [], links: [], gates: {}, errors: {}, channels,
      config: { channels, active_channel_id: 'a', mcp_server_path: 'C:\\CreatorWorks\\server.mjs',
        tool_groups: 'core', auto_start: true, enable_custom_scripts: false, allow_all_tests: true,
        automatic_update_checks: false } };
    state.community = {entries:[{...entry, previewImage:null}, {...entry, id:'fixture.download', name:'Download test fixture', author:{name:'Fixture author'}, category:'prefab', reviewStatus:'listed', previewImage:null}], warnings:[], stale:false};
    state.pluginProjects = [
      {id:'project-closed',name:'Closed disposable project',path:'C:\\UnityFixtures\\Closed disposable project',unityVersion:'6000.3.21f1',sdk:'Creator SDK',helper:'missing',open:false},
      {id:'project-open',name:'Open project',path:'C:\\UnityFixtures\\Open project',unityVersion:'6000.3.21f1',sdk:'Unity',helper:'missing',open:true}
    ];
    state.importStatus = 'review';
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
          case 'begin_ui_operation': return 1;
          case 'finish_ui_operation': return;
          case 'community_catalogue': return structuredClone(state.community);
          case 'open_community_link': return;
          case 'download_community_package': await state.hold('download'); return 'Saved fixture package; no Unity import.';
          case 'community_projects':
            if (state.delayProjects) await state.hold('projects');
            return {projects:structuredClone(state.pluginProjects),warnings:[]};
          case 'choose_community_project': return null;
          case 'install_community_menu':
            await state.hold('installMenu');
            state.pluginProjects.find(p => p.id === args.projectId).helper = 'installed';
            return 'Fixture menu added; no real project changed.';
          case 'queue_community_import':
            await state.hold('queueImport');
            return {projectId:args.projectId,requestId:'fixture-request',status:'queued',message:'Nothing imported.'};
          case 'community_import_status': return {...args,status:state.importStatus,message:'Fixture Unity result.'};
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
  }, communityEntry);
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
        images:[...document.images].filter(img => img.hasAttribute('src')).every(img => img.complete && img.naturalWidth > 0),
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
  assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c => !/^(begin_ui_operation|finish_ui_operation|load_config|discover_unity_projects|get_)/.test(c.name))), []);
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
  assert.equal(await items.count(), 4);
  assert.equal(await menu.locator('[data-app-link="setup"]').count(), 0);
  assert.deepEqual(await items.locator('strong').allTextContents(), ['Creator Hub', 'Creator Works MCP', 'Creator Converter', 'Creator Plugins']);
  assert.equal(await items.nth(0).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await items.last().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.links), []);
  await closed();
  assert.equal(await page.locator('#view-plugins').isVisible(), true);
  await toggle.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await closed();
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  await toggle.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.links), []);
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.links), []);
  assert.equal(await page.locator('#view-mcp').isVisible(), true);
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
  const hubMark = await page.locator('.app-icon-hub').evaluate(el => ({
    border:getComputedStyle(el).borderTopWidth, radius:getComputedStyle(el).borderRadius,
    background:getComputedStyle(el).backgroundColor, top:getComputedStyle(el,'::before').backgroundColor,
    silhouette:getComputedStyle(el,'::before').clipPath, sides:getComputedStyle(el,'::after').backgroundImage,
    image:{width:el.querySelector('img').width,source:el.querySelector('img').getAttribute('src')},
    badgeLayer:getComputedStyle(el.querySelector('.app-letter')).zIndex
  }));
  assert.equal(hubMark.border,'0px');
  assert.equal(hubMark.radius,'0px');
  assert.equal(hubMark.background,'rgba(0, 0, 0, 0)');
  assert.equal(hubMark.top,'rgb(105, 117, 127)');
  assert.match(hubMark.silhouette,/polygon/);
  assert.match(hubMark.sides,/rgb\(76, 89, 100\).*rgb\(52, 63, 72\)/);
  assert.deepEqual(hubMark.image,{width:22,source:'creator-works-logo.png'});
  assert.equal(hubMark.badgeLayer,'2');
  checks.push('Hub gray cube backplate, original 22px bitmap and outside H badge');
  const converterMark = await page.locator('.app-icon-converter').evaluate(el => ({
    background:getComputedStyle(el).backgroundColor, radius:getComputedStyle(el).borderRadius,
    width:el.clientWidth, imageWidth:el.querySelector('img').width,
    loaded:el.querySelector('img').naturalWidth > 0, badge:el.querySelector('.app-letter').textContent
  }));
  assert.deepEqual(converterMark,{background:'rgb(0, 0, 0)',radius:'5px',width:34,imageWidth:22,loaded:true,badge:'C'});
  checks.push('official SideQuest Converter mark and non-actionable Converter entry');
  const pluginsMark = await page.locator('[data-local-view="plugins"] .app-icon').evaluate(el => ({
    source:el.querySelector('img').getAttribute('src'), loaded:el.querySelector('img').complete && el.querySelector('img').naturalWidth === 256,
    width:el.querySelector('img').width, badges:el.querySelectorAll('.app-letter').length
  }));
  assert.deepEqual(pluginsMark,{source:'icons/creator-plugins.png',loaded:true,width:30,badges:0});
  const pixels = await page.locator('[data-local-view="plugins"] img').evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 30;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0, 30, 30);
    const data = context.getImageData(0, 0, 30, 30).data;
    const counts = { transparent: 0, visible: 0, cyan: 0, red: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = data.subarray(i, i + 4);
      if (a === 0) counts.transparent++;
      if (a > 128) {
        counts.visible++;
        if (b > 100 && g > 100 && r < 80) counts.cyan++;
        if (r > 150 && g < 130 && b < 130) counts.red++;
      }
    }
    return counts;
  });
  assert.ok(pixels.transparent > 100 && pixels.visible > 100 && pixels.cyan > 3 && pixels.red > 3, JSON.stringify(pixels));
  checks.push('approved transparent Plugins PNG renders cyan/red artwork at 30px without an overlapping letter badge');
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
  checks.push('four-entry menu without Project Setup; Hub public link, MCP/Plugins navigation, disabled Converter, keyboard, Escape, Tab and outside dismissal');

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
    const lastItem = el.querySelector('[role="menuitem"]:last-child');
    const last = lastItem.getBoundingClientRect();
    return {shellBottom:shell.bottom,scroll:el.scrollTop,lastBottom:last.bottom,active:document.activeElement === lastItem};
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
  const configBeforePlugins = await page.evaluate(() => JSON.stringify(fixture.config));
  await page.locator('#projectPath').fill('C:\\UnsavedFixtureDraft');
  await toggle.click();
  await page.locator('[data-local-view="plugins"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.community-item').length === 2 && !document.querySelector('[data-community-download]').disabled);
  const catalogueList = page.locator('.community-list');
  const gridView = page.getByRole('button', {name:'Grid view',exact:true});
  const listView = page.getByRole('button', {name:'List view',exact:true});
  assert.equal(await catalogueList.getAttribute('data-layout'), 'grid');
  assert.equal(await gridView.getAttribute('aria-pressed'), 'true');
  const initialCalls = await page.evaluate(() => fixture.calls.length);
  await listView.focus();
  await page.keyboard.press('Enter');
  assert.equal(await listView.getAttribute('aria-pressed'), 'true');
  assert.equal(await gridView.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('creator-plugins.layout.v1')), 'list');
  await page.locator('[aria-label="Search contributions"]').fill('Download test');
  await page.locator('.community-details summary').click();
  await page.evaluate(() => { window.keptPlugin = document.querySelector('.community-item'); });
  await gridView.focus();
  await page.keyboard.press('Space');
  assert.equal(await catalogueList.getAttribute('data-layout'), 'grid');
  assert.equal(await page.locator('[aria-label="Search contributions"]').inputValue(), 'Download test');
  assert.ok(await page.evaluate(() => keptPlugin === document.querySelector('.community-item') && keptPlugin.querySelector('details').open));
  assert.equal(await page.evaluate(() => fixture.calls.length), initialCalls);
  await page.locator('[aria-label="Search contributions"]').fill('');
  checks.push('Grid default; keyboard List/Grid toggle persists preference without IPC, lost search or replaced open details');
  assert.match(await page.locator('[data-id="egon-gb.start-location"]').innerText(), /Mr\. E \/ egon\.gb/);
  assert.equal(await page.locator('[data-id="egon-gb.start-location"] [data-community-download]').count(), 0);
  const addUnityMenu = page.getByRole('button', {name:'Add Unity menu',exact:true,includeHidden:true});
  assert.equal(await addUnityMenu.isVisible(), false);
  assert.equal(await page.locator('[data-community-import]').count(), 0);
  for (const disabledValue of [false, 'true', 1]) {
    await page.evaluate(value => { fixture.community.projectImportEnabled = value; }, disabledValue);
    await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh catalogue"]').disabled);
    assert.equal(await addUnityMenu.isVisible(), false);
    assert.equal(await page.locator('[data-community-import]').count(), 0);
    await addUnityMenu.evaluate(button => button.click());
    assert.equal(await page.locator('.community-project-dialog').isVisible(), false);
  }
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => ['community_projects','install_community_menu','queue_community_import'].includes(c.name)).length), 0);
  for (const width of [900,560,390]) {
    await page.setViewportSize({width,height:800});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:path.join(output,`community-downloads-only-${width}.png`),fullPage:true});
  }
  checks.push('Downloads-only is fail-closed for absent/false/non-boolean import authority; hidden actions cannot open project picker or issue writes');
  // Exercise the explicit capability independently from fail-closed older snapshots.
  await page.evaluate(() => { fixture.community.projectImportEnabled = true; });
  await page.evaluate(() => {
    const base = fixture.community.entries[0];
    fixture.community.entries.push(
      {...base, id:'fixture.mcp-tool', name:'MCP tool fixture', category:'mcp-tool', reviewStatus:'listed', includesCode:true,
        download:{url:'https://cdn.sidequestvr.com/file/1/tool.zip', sha256:'a'.repeat(64), byteLength:128}},
      {...base, id:'fixture.ai-skill', name:'AI skill instructions fixture', category:'ai-skill', scope:'instructions-only', reviewStatus:'listed', download:null}
    );
  });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.community-item').length === 4);
  await page.evaluate(() => {
    window.savedPluginEntries = structuredClone(fixture.community.entries);
    fixture.community.entries[1].name = 'VeryLongContributionName'.repeat(6);
    fixture.community.entries[1].author.name = 'LongAuthorName'.repeat(5);
    fixture.community.entries[1].description = 'A longer fixture description that must wrap and leave the actions accessible. '.repeat(7);
  });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh catalogue"]').disabled);
  for (const mode of ['grid', 'list']) {
    await (mode === 'grid' ? gridView : listView).click();
    for (const width of [1200,900,560,390,320]) {
      await page.setViewportSize({width,height:800});
      const bounds = await page.locator('.community-item').evaluateAll(items => items.map(item => {
        const rect = item.getBoundingClientRect(), actions = item.querySelector('.community-item-actions').getBoundingClientRect();
        const description = item.querySelector('.community-description').getBoundingClientRect();
        return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,scroll:item.scrollWidth,width:item.clientWidth,
          actionTop:actions.top,actionBottom:actions.bottom,descriptionBottom:description.bottom};
      }));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} ${width}: page overflow`);
      for (const box of bounds) assert.ok(box.scroll <= box.width && box.left >= 0 && box.right <= width && box.actionTop >= box.descriptionBottom && box.actionBottom <= box.bottom, `${mode} ${width}: card overlap`);
      if (mode === 'grid') for (const box of bounds) for (const peer of bounds.filter(peer => Math.abs(peer.top - box.top) < 1)) {
        assert.ok(Math.abs(box.bottom - peer.bottom) < 1, 'Grid row heights differ');
      }
      await page.screenshot({path:path.join(output,`plugins-${mode}-long-${width}.png`),fullPage:true});
    }
  }
  await page.evaluate(() => { fixture.community.entries = savedPluginEntries; });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh catalogue"]').disabled);
  await gridView.click();
  checks.push('List/Grid responsive long-name cards at 1200/900/560/390/320px; equal grid row heights and visible nonoverlapping actions');
  for (const [category, id] of [['mcp-tool','fixture.mcp-tool'], ['ai-skill','fixture.ai-skill']]) {
    await page.locator(`[data-category="${category}"]`).click();
    assert.equal(await page.locator('.community-item').count(), 1);
    assert.equal(await page.locator('.community-item').getAttribute('data-id'), id);
    assert.equal(await page.locator('[data-community-import]').count(), 0);
  }
  assert.match(await page.locator('.community-review').innerText(), /Instructions only/);
  assert.equal(await page.locator('[data-community-download]').count(), 0);
  await page.locator('[data-category="mcp-tool"]').click();
  assert.equal(await page.locator('[data-community-download]').isEnabled(), true);
  assert.equal(await page.locator('.community-code').innerText(), 'Includes code');
  assert.match(await page.locator('.community-caution').textContent(), /Review code before installing or running it/);
  await page.locator('[data-category="all"]').click();
  for (const width of [900,560,390]) {
    await page.setViewportSize({width,height:800});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:path.join(output,`community-categories-${width}.png`),fullPage:true});
  }
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => ['download_community_package','queue_community_import'].includes(c.name)).length), 0);
  await page.evaluate(() => { fixture.community.entries = fixture.community.entries.filter(entry => !['fixture.mcp-tool','fixture.ai-skill'].includes(entry.id)); });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.community-item').length === 2);
  checks.push('MCP tools and AI skills filters, ZIP download-only, instructions-only labels, code caution, no import actions and 900/560/390px layouts');
  await page.locator('[data-category="graph"]').click();
  assert.equal(await page.locator('.community-item').count(), 1);
  for (const width of [900, 560, 390]) {
    await page.setViewportSize({width, height:800});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:path.join(output,`community-${width}.png`),fullPage:true});
  }
  await page.locator('[aria-label="Search contributions"]').fill('missing test item');
  assert.equal(await page.locator('.community-item').count(), 0);
  await page.getByRole('button', {name:'Clear filters',exact:true}).click();
  assert.equal(await page.locator('.community-item').count(), 2);
  assert.equal(await page.locator('[data-id="egon-gb.start-location"] [data-community-import]').isDisabled(), true);
  await page.evaluate(() => { fixture.delayProjects = true; });
  await page.getByRole('button', {name:'Add Unity menu',exact:true}).click();
  const projectDialog = page.locator('.community-project-dialog');
  assert.match(await projectDialog.innerText(), /Experimental project integration/);
  const projectSelect = page.locator('#community-project-select');
  const addMenu = projectDialog.getByRole('button',{name:'Add menu to project',exact:true});
  await page.waitForFunction(() => typeof fixture.gates.projects === 'function');
  assert.equal(await projectDialog.getAttribute('aria-busy'), 'true');
  assert.equal(await projectDialog.getByText('Loading Unity projects... Please wait.',{exact:true}).isVisible(), true);
  assert.equal(await projectSelect.isDisabled(), true);
  assert.equal(await projectDialog.getByRole('button',{name:'Close',exact:true}).isDisabled(), true);
  await page.screenshot({path:path.join(output,'community-project-loading.png')});
  await page.evaluate(() => { fixture.delayProjects = false; fixture.gates.projects(); });
  await page.waitForFunction(() => document.querySelector('#community-project-select option[value="project-open"]'));
  assert.equal(await projectDialog.getAttribute('aria-busy'), 'false');
  assert.equal(await projectDialog.getByText('Loading Unity projects... Please wait.',{exact:true}).isVisible(), false);
  assert.equal(await addMenu.isDisabled(), true);
  await projectSelect.selectOption('project-open');
  assert.equal(await addMenu.isDisabled(), true);
  assert.match(await projectDialog.innerText(), /Close this project in Unity/);
  await projectDialog.getByRole('button',{name:'Browse',exact:true}).click();
  assert.equal(await projectSelect.inputValue(),'project-open');
  await projectSelect.selectOption('project-closed');
  await addMenu.click();
  await page.waitForFunction(() => typeof fixture.gates.installMenu === 'function');
  await page.keyboard.press('Escape');
  assert.equal(await projectDialog.isVisible(), true);
  assert.equal(await projectDialog.getByRole('button',{name:'Close',exact:true}).isDisabled(), true);
  assert.equal(await page.locator('#workspaceControls').evaluate(el => el.disabled), true);
  assert.match(await page.evaluate(() => CreatorCommunityInvoke('queue_community_import',{id:'fixture.download',projectId:'project-closed'}).catch(String)), /Another MCP operation/);
  await page.evaluate(() => fixture.gates.installMenu());
  await page.waitForFunction(() => document.querySelector('.community-project-dialog .community-project-safety').textContent.includes('menu installed'));
  assert.equal(await addMenu.isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await projectDialog.isVisible(), false);
  await page.locator('[data-id="fixture.download"] [data-community-import]').click();
  await projectSelect.selectOption('project-closed');
  const sendImport = projectDialog.getByRole('button',{name:'Send to Unity for review',exact:true});
  await page.evaluate(() => {
    document.querySelector('.community-project-path').textContent = 'C:\\UnityFixtures\\' + 'VeryLongProjectFolderName'.repeat(12);
  });
  for (const width of [900,560,390]) {
    await page.setViewportSize({width,height:700});
    const bounds = await projectDialog.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {left:r.left,right:r.right,bottom:r.bottom,top:r.top,scroll:el.scrollWidth,width:el.clientWidth};
    });
    assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= 700 && bounds.scroll <= bounds.width);
    await page.screenshot({path:path.join(output,`community-project-${width}.png`)});
  }
  await sendImport.click();
  await page.waitForFunction(() => typeof fixture.gates.queueImport === 'function');
  await page.keyboard.press('Escape');
  assert.equal(await projectDialog.isVisible(), true);
  assert.equal(await page.locator('#workspaceControls').evaluate(el => el.disabled), true);
  await page.evaluate(() => fixture.gates.queueImport());
  await page.waitForFunction(() => [...document.querySelectorAll('.community-project-dialog .community-message')].some(node => !node.hidden && node.textContent.includes('Queued, not imported')));
  assert.equal(await sendImport.isDisabled(), true);
  const checkImport = projectDialog.getByRole('button',{name:'Check Unity status',exact:true});
  await checkImport.click();
  assert.match(await projectDialog.innerText(), /Waiting for the Unity import outcome/);
  await page.evaluate(() => { fixture.importStatus = 'cancelled'; });
  await checkImport.click();
  assert.match(await projectDialog.innerText(), /Cancelled/);
  await projectDialog.getByRole('button',{name:'Close',exact:true}).click();
  assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c=>c.name==='install_community_menu').map(c=>c.args)),[{projectId:'project-closed'}]);
  assert.deepEqual(await page.evaluate(() => fixture.calls.filter(c=>c.name==='queue_community_import').map(c=>c.args)),[{id:'fixture.download',projectId:'project-closed'}]);
  checks.push('Project picker and install/queue/status modal: pending/open-project blocking, ID-only requests, native workflow exclusion, busy Escape lock, cancelled picker, queued-versus-imported wording and 900/560/390px long-path layouts');
  await page.locator('[data-id="fixture.download"] [data-community-download]').click();
  await page.waitForFunction(() => typeof fixture.gates.download === 'function');
  const pendingCalls = await page.evaluate(() => fixture.calls.length);
  await page.evaluate(() => { window.pendingDownloadButton = document.querySelector('[data-community-download]'); });
  await listView.click();
  await gridView.click();
  assert.ok(await page.evaluate(() => pendingDownloadButton === document.querySelector('[data-community-download]') && pendingDownloadButton.disabled));
  assert.equal(await page.evaluate(() => fixture.calls.length), pendingCalls);
  checks.push('Switching layout during download preserves the same disabled button and issues no extra IPC');
  await toggle.click();
  await page.locator('[data-local-view="mcp"]').click();
  assert.equal(await page.locator('#workspaceControls').evaluate(el => el.disabled), true);
  assert.equal(await page.locator('#setupBtn').isDisabled(), true);
  assert.equal(await page.locator('#projectPath').inputValue(), 'C:\\UnsavedFixtureDraft');
  const blocked = await page.evaluate(() => CreatorCommunityInvoke('download_community_package',{id:'fixture.download'}).catch(String));
  assert.match(blocked, /Another MCP operation/);
  await page.evaluate(() => fixture.gates.download());
  await page.waitForFunction(() => !document.getElementById('workspaceControls').disabled);
  await toggle.click();
  await page.locator('[data-local-view="plugins"]').click();
  assert.match(await page.locator('#view-plugins > .community-message').innerText(), /Saved fixture/);
  assert.equal(await page.locator('[data-community-download]').isEnabled(), true);
  await page.evaluate(() => { fixture.community.stale = true; });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.community-count').textContent.includes('refresh required'));
  assert.equal(await page.locator('[data-community-download]').isDisabled(), true);
  await page.evaluate(() => { fixture.errors.community_catalogue = 'Fixture offline'; });
  await page.getByRole('button', {name:'Refresh catalogue',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.community-message').textContent.includes('Fixture offline'));
  assert.equal(await page.locator('[data-community-download]').isDisabled(), true);
  assert.equal(await page.evaluate(() => JSON.stringify(fixture.config)), configBeforePlugins);
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.name === 'download_community_package').length), 1);
  checks.push('Plugins lazy loading, initial download readiness, pending review, author credit, filters, 900/560/390px layouts, preserved drafts, download workflow exclusion and stale/offline refusal');
  await listView.click();
  await page.reload();
  await ready();
  assert.equal(await catalogueList.getAttribute('data-layout'), 'list');
  for (const [stored, expected] of [[null,'grid'], ['grid','grid'], ['list','list'], ['invalid','grid'], ['unavailable','grid']]) {
    const isolated = await context.newPage();
    isolated.on('pageerror', error => failures.push(error.message));
    await isolated.addInitScript(value => {
      if (value === 'unavailable') {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
      } else if (value === null) localStorage.removeItem('creator-plugins.layout.v1');
      else localStorage.setItem('creator-plugins.layout.v1', value);
    }, stored);
    await isolated.goto(base);
    await isolated.waitForFunction(() => document.querySelector('.community-list')?.dataset.layout);
    assert.equal(await isolated.locator('.community-list').getAttribute('data-layout'), expected, `stored=${stored}`);
    await isolated.locator('#appSwitcherToggle').click();
    await isolated.locator('[data-local-view="plugins"]').click();
    await isolated.waitForFunction(() => document.querySelectorAll('.community-item').length === 2);
    await isolated.getByRole('button',{name:'List view',exact:true}).click();
    await isolated.getByRole('button',{name:'Grid view',exact:true}).click();
    assert.equal(await isolated.locator('.community-list').getAttribute('data-layout'), 'grid');
    await isolated.close();
  }
  checks.push('Explicit List survives reload; fresh/invalid/blocked storage uses Grid and both modes remain usable');
  await fs.writeFile(path.join(output,'motion-results.json'),JSON.stringify({motion,reversed,short,reduced},null,2) + '\n');
  assert.deepEqual(failures,[]);
  const report = {success:true, checks, limitations:'Mocked browser/Tauri only. No native GUI, real setup, install or Unity runtime actions performed.'};
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2) + '\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
