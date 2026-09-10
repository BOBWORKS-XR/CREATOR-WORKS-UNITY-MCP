import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync('launcher/src/runtime.js', 'utf8');
function fixture(standalone = false) {
  const events = new Map();
  const classes = new Set();
  const sent = [];
  const fieldset = { disabled: false };
  let timeout;
  const window = { parent: {}, addEventListener: (name, callback) => events.set(name, callback) };
  if (standalone) window.parent = window;
  const port = { postMessage: message => sent.push(message), close() { this.closed = true; } };
  const context = vm.createContext({ window, console, TextEncoder,
    document: { documentElement: { classList: { add: name => classes.add(name) } }, getElementById: () => fieldset },
    setTimeout: callback => { timeout = callback; return 1; }, clearTimeout: () => { timeout = undefined; },
  });
  vm.runInContext(source, context);
  return { runtime: window.CreatorRuntime, window, classes, sent, port, fieldset,
    connect: (source = window.parent, data = { type: 'creator-host-connect', protocol: 1 }, ports = [port]) => events.get('message')({ source, data, ports }),
    reply: data => port.onmessage({ data }), timeout: () => timeout?.(),
  };
}
test('standalone adapter delegates all four API families without changing arguments or results', async () => {
  const f = fixture(true);
  const calls = [];
  const unlisten = () => {};
  f.window.__TAURI__ = {
    core: { invoke: async (...args) => { calls.push(args); return 42; } },
    event: { listen: async (...args) => { calls.push(args); return unlisten; } },
    dialog: { open: async options => { calls.push(options); return 'folder'; } },
    shell: { open: async url => calls.push(url) },
  };
  await f.runtime.ready;
  const callback = () => {};
  assert.equal(await f.runtime.invoke('load_config', { a: 1 }), 42);
  assert.equal(await f.runtime.listen('test', callback), unlisten);
  assert.equal(await f.runtime.openDialog({ directory: true }), 'folder');
  await f.runtime.openExternal('https://example.org');
  assert.deepEqual(calls, [['load_config', { a: 1 }], ['test', callback], { directory: true }, 'https://example.org']);
  assert.equal(f.runtime.hosted, false);
  assert.equal(f.classes.size, 0);
});
test('frame presence alone grants no hosted chrome and ignores incorrect connection messages', async () => {
  const f = fixture();
  f.connect({}); f.connect(f.window.parent, { type: 'creator-host-connect', protocol: 2 });
  f.connect(f.window.parent, { type: 'creator-host-connect', protocol: 1 }, []);
  assert.equal(f.classes.size, 0);
  assert.equal(f.runtime.hosted, false);
  f.connect(); await f.runtime.ready;
  assert.equal(f.runtime.hosted, true);
  assert.ok(f.classes.has('creator-hosted'));
  f.connect();
  assert.equal(f.sent.filter(m => m.type === 'ready').length, 1);
});
test('hosted requests serialize and a failed operation does not poison or replay the next one', async () => {
  const f = fixture(); f.connect();
  const first = f.runtime.invoke('get_hosted_snapshot');
  const second = f.runtime.openDialog({ directory: true, multiple: false });
  assert.equal(f.sent.length, 2);
  const rejected = assert.rejects(first, /fixture error/);
  f.reply({ type: 'result', id: 1, ok: false, error: 'fixture error' });
  await rejected;
  assert.equal(f.sent.at(-1).command, 'pick_project_folder');
  f.reply({ type: 'result', id: 2, ok: true, result: null });
  assert.equal(await second, null);
});
test('read-only allowlist, pending limit and UTF-8 byte limit reject before dispatch', async () => {
  const f = fixture(); f.connect();
  await assert.rejects(f.runtime.invoke('save_config'), /read-only/);
  await assert.rejects(f.runtime.invoke('get_hosted_snapshot', []), /arguments/);
  await assert.rejects(f.runtime.openDialog({ directory: false }), /folder/);
  await assert.rejects(f.runtime.openDialog({ directory: true, defaultPath: 'unapproved' }), /folder/);
  await assert.rejects(f.runtime.invoke('open_official_url', { url: '\u2603'.repeat(21000) }), /size/);
  const requests = Array.from({ length: 16 }, () => f.runtime.invoke('get_hosted_snapshot'));
  await assert.rejects(f.runtime.invoke('get_hosted_snapshot'), /Too many/);
  const results = Promise.allSettled(requests);
  f.reply({ type: 'disconnect' });
  assert.ok((await results).every(item => item.status === 'rejected'));
  assert.equal(f.sent.filter(m => m.type === 'invoke').length, 1);
});
test('disconnect fails queued and future requests without retries and locks controls', async () => {
  const f = fixture(); f.connect();
  let reason;
  const remove = await f.runtime.listen('creator-runtime-disconnected', event => { reason = event.payload; });
  const result = Promise.allSettled([f.runtime.invoke('get_hosted_snapshot'), f.runtime.invoke('get_hosted_snapshot')]);
  f.reply({ type: 'disconnect' });
  assert.ok((await result).every(item => item.status === 'rejected'));
  assert.match(reason, /unknown/);
  assert.equal(f.fieldset.disabled, true);
  await assert.rejects(f.runtime.invoke('get_hosted_snapshot'), /disconnected/);
  remove();
});
test('out-of-order replies fail closed and only scoped events reach listeners', async () => {
  const f = fixture(); f.connect();
  let count = 0;
  const stop = await f.runtime.listen('creator-lifecycle-close-blocked', () => { count++; });
  f.reply({ type: 'event', name: 'creator-lifecycle-close-blocked' });
  stop();
  f.reply({ type: 'event', name: 'creator-lifecycle-close-blocked' });
  await assert.rejects(f.runtime.listen('arbitrary', () => {}), /Unsupported/);
  assert.equal(count, 1);
  const pending = assert.rejects(f.runtime.invoke('get_hosted_snapshot'), /unexpected/);
  f.reply({ type: 'result', id: 42, ok: true });
  await pending;
  assert.equal(f.port.closed, true);
});
test('missing host fails bounded initialization without a standalone fallback', async () => {
  const f = fixture();
  const pending = assert.rejects(f.runtime.ready, /did not connect/);
  const queued = assert.rejects(f.runtime.invoke('get_hosted_snapshot'), /did not connect/);
  f.timeout(); await pending; await queued;
  f.connect();
  assert.equal(f.runtime.hosted, false);
  assert.equal(f.sent.length, 0);
});
test('all MCP frontend native calls go through the adapter; native preview has no write/discovery routes', () => {
  for (const name of ['app.js', 'app-chrome.js']) assert.doesNotMatch(fs.readFileSync('launcher/src/' + name, 'utf8'), /__TAURI__/);
  const native = fs.readFileSync('launcher/src-tauri/src/hosted.rs', 'utf8').split('#[cfg(test)]')[0];
  assert.doesNotMatch(native, /crate::(?:load_config|save_config|resolve_mcp_root|discover_unity_projects|get_config_path)\(/);
  assert.doesNotMatch(native, /std::process::Command|fs::write|create_dir|TcpListener|TcpStream/);
});
