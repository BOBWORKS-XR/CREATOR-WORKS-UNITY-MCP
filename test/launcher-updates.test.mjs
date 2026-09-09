import assert from 'node:assert/strict';
import test from 'node:test';
import { stableUpdate, checkStableUpdate, RELEASE_API } from '../launcher/src/updates.js';
const release = tag => ({ tag_name: tag, html_url: `https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/${tag}`, draft: false, prerelease: false, published_at: '2026-09-09T00:00:00Z' });

test('stable updates compare numeric versions and never downgrade', () => {
  assert.equal(stableUpdate('2.6.0', release('v2.10.0')).available, true);
  assert.equal(stableUpdate('2.6.0-rc.1', release('v2.6.0')).available, true);
  assert.equal(stableUpdate('2.6.0', release('v2.6.0')).available, false);
  assert.equal(stableUpdate('2.7.0-rc.1', release('v2.6.0')).available, false);
});

test('update metadata rejects previews, drafts, malformed versions and foreign links', () => {
  for (const bad of [{ ...release('v2.6.0'), draft: true }, { ...release('v2.6.0'), prerelease: true },
    release('v2.7.0-rc.1'), release('2.06.0'), { ...release('v2.7.0'), html_url: 'https://invalid.example' }])
    assert.throws(() => stableUpdate('2.6.0', bad));
});

test('update check requests only public release metadata with no credentials or project data', async () => {
  const result = await checkStableUpdate('2.5.1', async (url, options) => {
    assert.equal(url, RELEASE_API);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify(release('v2.6.0')));
  });
  assert.equal(result.available, true);
});

test('update failures and oversized responses are not reported as up to date', async () => {
  await assert.rejects(checkStableUpdate('2.6.0', async () => new Response('', { status: 403 })), /403/);
  await assert.rejects(checkStableUpdate('2.6.0', async () => new Response('x'.repeat(600000))), /size limit/);
  await assert.rejects(checkStableUpdate('2.6.0', async () => new Response('bad json')), /JSON/);
});
