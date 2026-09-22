const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('release packaging cannot use a dispatched branch name as a release tag', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  const jobs = [...source.matchAll(/^    if: (.+)$/gm)].map(match => match[1]);
  assert.ok(jobs.length > 0);
  for (const condition of jobs) {
    assert.ok(condition.includes("github.ref_type == 'tag' && startsWith(github.ref_name, 'v') &&"));
  }
});
