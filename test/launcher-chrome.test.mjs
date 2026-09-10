import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync('launcher/src/index.html', 'utf8');
const chrome = fs.readFileSync('launcher/src/app-chrome.js', 'utf8');
const source = fs.readFileSync('launcher/src/app.js', 'utf8');

test('standalone switcher exposes only public pages with truthful future states', () => {
  assert.match(html, /aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /In development/);
  assert.match(html, /Coming soon/);
  assert.doesNotMatch(html, /FIRST RUN|Shader Graph Preview/);
  assert.doesNotMatch(chrome, /core\.invoke|dialog\.|location\.|URLSearchParams|localStorage|exec\(/);
  assert.equal((chrome.match(/https:\/\//g) || []).length, 2);
  assert.match(chrome, /publicPages\[item.dataset.appLink\]/);
});

test('drawer has one frame and closes accessibility immediately without transition timers', () => {
  const css = fs.readFileSync('launcher/src/styles.css', 'utf8');
  assert.match(html, /id="appSwitcherShell"/);
  assert.match(html, /id="appSwitcherMenu" inert aria-hidden="true"/);
  assert.doesNotMatch(html, /appSwitcherClose|app-menu-heading/);
  assert.match(chrome, /menu.inert = true/);
  assert.match(chrome, /menu.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(chrome, /preventScroll: true/);
  assert.match(chrome, /scrim.addEventListener\('click'/);
  assert.match(chrome, /if \(event.target === scrim\) return/);
  assert.match(css, /\.app-shell.expanded \{ height: 294px; width: 224px; \}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('Hub badge uses a three-face cube backplate without replacing the original bitmap', () => {
  const css = fs.readFileSync('launcher/src/styles.css', 'utf8');
  assert.match(css, /\.app-icon-hub \{ border: 0; border-radius: 0; background: transparent; \}/);
  assert.match(css, /clip-path: polygon\(50% 0, 94% 25%, 94% 75%, 50% 100%, 6% 75%, 6% 25%\)/);
  assert.match(css, /linear-gradient\(90deg, #4c5964 50%, #343f48 50%\)/);
  assert.match(css, /\.app-icon-hub img \{ height: 22px; position: relative; width: 22px; z-index: 1; \}/);
  assert.match(html, /app-icon app-icon-hub[^>]*><img src="creator-works-logo.png"/);
});

function fixture() {
  const fieldset = { disabled: false, attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; } };
  const messages = [];
  const context = vm.createContext({ document: { addEventListener() {} }, fieldset, messages });
  vm.runInContext(source, context);
  vm.runInContext(`
    elements.workspaceControls = fieldset;
    elements.setupBtn = {};
    for (const name of ['connectCodex','connectClaude','connectAntigravity','connectOpenCode']) elements[name] = {checked:true};
    onboarding = {project:{valid:true}, runtime:{ready:true}};
    showToast = message => messages.push(message);
  `, context);
  return { context, fieldset, messages };
}

test('one operation locks the workspace, rejects overlapping actions and unlocks on completion', async () => {
  const f = fixture();
  let resolve;
  f.context.action = () => new Promise(done => { resolve = done; });
  let second = false;
  f.context.second = () => { second = true; };
  const first = vm.runInContext('runUIOperation(action)', f.context);
  assert.equal(f.fieldset.disabled, true);
  assert.equal(f.fieldset.attrs['aria-busy'], 'true');
  vm.runInContext('updateSetupButton()', f.context);
  assert.equal(vm.runInContext('elements.setupBtn.disabled', f.context), true);
  await vm.runInContext('runUIOperation(second)', f.context);
  assert.equal(second, false);
  resolve();
  await first;
  assert.equal(f.fieldset.disabled, false);
  assert.equal(f.fieldset.attrs['aria-busy'], undefined);
  assert.equal(vm.runInContext('elements.setupBtn.disabled', f.context), false);
});

test('a rejected operation surfaces the failure and preserves individual disabled states', async () => {
  const f = fixture();
  f.context.action = async () => { throw new Error('fixture failure'); };
  vm.runInContext('onboarding = null; elements.localFeedback = {disabled:true}', f.context);
  await vm.runInContext('runUIOperation(action)', f.context);
  assert.equal(f.fieldset.disabled, false);
  assert.equal(vm.runInContext('elements.setupBtn.disabled', f.context), true);
  assert.equal(vm.runInContext('elements.localFeedback.disabled', f.context), true);
  assert.match(f.messages[0], /fixture failure/);
});

test('stale project checks cannot replace the selected project readiness', async () => {
  const f = fixture();
  let resolve;
  f.context.window = { __TAURI__: { core: { invoke: () => new Promise(done => { resolve = done; }) } } };
  vm.runInContext("selectedProjectPath = 'A'; onboarding = null;", f.context);
  const pending = vm.runInContext('refreshOnboardingStatus()', f.context);
  vm.runInContext("selectedProjectPath = 'B';", f.context);
  resolve({ project: { valid: true }, runtime: { ready: true } });
  await pending;
  assert.equal(vm.runInContext('onboarding', f.context), null);
});

test('out-of-order readiness responses for the same path keep the newest result', async () => {
  const f = fixture();
  const pending = [];
  f.context.window = { __TAURI__: { core: { invoke: () => new Promise(done => pending.push(done)) } } };
  vm.runInContext("selectedProjectPath = 'A'; onboarding = null; clientSelectionInitialized = true; refreshFeedbackSettings = async () => {};", f.context);
  const first = vm.runInContext('refreshOnboardingStatus()', f.context);
  const second = vm.runInContext('refreshOnboardingStatus()', f.context);
  pending[1]({project:{valid:false}});
  await second;
  pending[0]({project:{valid:true}});
  await first;
  assert.equal(vm.runInContext('onboarding.project.valid', f.context), false);
});
