import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

class Element {
  constructor() { this.listeners = {}; this.checked = false; this.disabled = false; this.hidden = false; this.inert = false; this.textContent = ''; this.open = false; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {}, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function harness(file, ids, { storageFails = false } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  for (const id of ['#usage-terms-continue', '#ai-usage-confirm']) if (elements[id]) elements[id].disabled = true;
  const dialog = elements['#usage-terms-dialog'] || elements['#ai-usage-confirm-dialog'];
  const children = [new Element(), new Element()];
  const store = new Map();
  const localStorage = {
    getItem(key) { if (storageFails) throw new Error('storage unavailable'); return store.get(key) ?? null; },
    setItem(key, value) { if (storageFails) throw new Error('storage unavailable'); store.set(key, value); },
  };
  const document = { body: { children }, querySelector: selector => elements[selector] };
  const window = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document, localStorage, Promise, Date, JSON });
  return { elements, children, store, window };
}

const termsFile = 'launcher/src/usage-terms.js';
const termsIds = ['#usage-terms-dialog', '#usage-terms-form', '#usage-terms-checkbox', '#usage-terms-continue', '#usage-terms-error'];
const html = fs.readFileSync('launcher/src/index.html', 'utf8');

test('MCP consent locks app until checked, saves acceptance, then unlocks app', async () => {
  const { elements, children, store, window } = harness(termsFile, termsIds);
  const accepted = window.CreatorUsageTerms.requireAcceptance();
  assert.equal(elements['#usage-terms-dialog'].open, true);
  assert.deepEqual(children.map(child => child.inert), [true, true]);
  assert.equal(elements['#usage-terms-continue'].disabled, true);
  elements['#usage-terms-checkbox'].checked = true;
  elements['#usage-terms-checkbox'].fire('change');
  assert.equal(elements['#usage-terms-continue'].disabled, false);
  elements['#usage-terms-continue'].fire('click');
  assert.equal(await accepted, true);
  assert.equal(JSON.parse(store.get('creator-usage-terms.mcp')).policyVersion, '2026-09-28-v1');
  assert.deepEqual(children.map(child => child.inert), [false, false]);
});

test('MCP consent remains locked if local acceptance cannot be stored', async () => {
  const { elements, children, window } = harness(termsFile, termsIds, { storageFails: true });
  const accepted = window.CreatorUsageTerms.requireAcceptance();
  elements['#usage-terms-checkbox'].checked = true;
  elements['#usage-terms-continue'].fire('click');
  assert.equal(elements['#usage-terms-error'].hidden, false);
  assert.match(elements['#usage-terms-error'].textContent, /remain locked/);
  assert.equal(elements['#usage-terms-dialog'].open, true);
  assert.deepEqual(children.map(child => child.inert), [true, true]);
  await Promise.race([accepted.then(() => assert.fail('Acceptance must not resolve')), new Promise(resolve => setTimeout(resolve, 0))]);
});

test('AI usage warning only persists dismissal after a second checked confirmation', () => {
  const ids = ['#ai-usage-notice', '#ai-usage-dont-show', '#ai-usage-dismiss', '#ai-usage-confirm-dialog', '#ai-usage-confirm-form', '#ai-usage-confirm-checkbox', '#ai-usage-confirm', '#ai-usage-confirm-error', '#ai-usage-keep'];
  const { elements, store, window } = harness('launcher/src/ai-usage-notice.js', ids);
  window.CreatorAiUsageNotice.initialize();
  assert.equal(elements['#ai-usage-notice'].hidden, false);
  elements['#ai-usage-dismiss'].fire('click');
  assert.equal(elements['#ai-usage-notice'].hidden, true);
  assert.equal(store.size, 0);
  window.CreatorAiUsageNotice.initialize();
  elements['#ai-usage-dont-show'].checked = true;
  elements['#ai-usage-dismiss'].fire('click');
  assert.equal(elements['#ai-usage-confirm-dialog'].open, true);
  assert.equal(elements['#ai-usage-confirm'].disabled, true);
  elements['#ai-usage-confirm-checkbox'].checked = true;
  elements['#ai-usage-confirm-checkbox'].fire('change');
  elements['#ai-usage-confirm'].fire('click');
  assert.equal(elements['#ai-usage-confirm-dialog'].open, false);
  assert.equal(elements['#ai-usage-notice'].hidden, true);
  assert.equal(store.get('creator-works-mcp.ai-usage-notice-hidden.v1'), 'true');
});

test('MCP help is fixed-access and covers client support, token controls and plugin formats', () => {
  assert.match(html, /id="context-help-open"/);
  assert.match(html, /id="context-help-dialog"/);
  assert.match(html, /Claude Desktop is not currently supported/);
  assert.match(html, /disable fast or high-cost modes/);
  assert.match(html, /Visual Scripting is a graph/);
  assert.match(fs.readFileSync('launcher/src/help.js', 'utf8'), /showModal\(\)/);
});
