import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const adapter = fs.readFileSync('launcher/src/community-adapter.js', 'utf8');
const commands = ['community_catalogue', 'open_community_link', 'download_community_package'];

test('community workers retain native lifecycle protection and are standalone-only', () => {
  const source = fs.readFileSync('launcher/src-tauri/src/community_api.rs', 'utf8');
  assert.equal((source.match(/spawn_blocking\(move \|\| \{\s*let _command = LIFECYCLE.command\(\)/g) || []).length, 3);
  for (const file of ['launcher/src/runtime.js', 'launcher/src-tauri/src/hosted.rs', 'launcher/src-tauri/src/hosted_commands.rs']) {
    const hosted = fs.readFileSync(file, 'utf8');
    for (const command of commands) assert.ok(!hosted.includes(`"${command}"`) && !hosted.includes(`'${command}'`), `${command} must not enter ${file}`);
  }
  const html = fs.readFileSync('launcher/src/index.html', 'utf8');
  assert.ok(html.indexOf('src="community-adapter.js"') < html.indexOf('src="community.js"'));
});

test('community adapter preserves results, scopes downloads and rejects hosted access', async () => {
  const calls = [];
  const window = { CreatorRuntime: { ready: Promise.resolve(), hosted: false,
    invoke: async (command, args) => { calls.push({command, args}); return 'native result'; } },
    CreatorMcpOperations: { run: async action => { calls.push({command:'guard'}); return action(); } } };
  vm.runInNewContext(adapter, { window });
  assert.equal(await window.CreatorCommunityInvoke('community_catalogue', {refresh:false}), 'native result');
  assert.equal(await window.CreatorCommunityInvoke('download_community_package', {id:'fixture'}), 'native result');
  assert.deepEqual(calls.map(c => c.command), ['community_catalogue', 'guard', 'download_community_package']);
  await assert.rejects(window.CreatorCommunityInvoke('install_app', {}), /Use Creator Plugins/);
  window.CreatorRuntime.hosted = true;
  for (const command of commands) await assert.rejects(window.CreatorCommunityInvoke(command, {}), /Use Creator Plugins/);
  assert.equal(calls.length, 3);
});
