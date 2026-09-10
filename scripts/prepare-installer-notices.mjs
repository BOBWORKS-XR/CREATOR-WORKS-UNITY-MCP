import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'artifacts', 'notices-tool');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts/notices-tool.json'), 'utf8'));
const git = args => execFileSync('git', ['-C', tool, ...args], { encoding: 'utf8', windowsHide: true }).trim();
if (git(['rev-parse', 'HEAD']) !== pin.revision || git(['diff', 'HEAD', '--name-only']) || git(['ls-files', '--others', '--exclude-standard'])) {
  throw Error('Check out the clean pinned notices tool under artifacts/notices-tool before packaging.');
}
const output = path.join(root, 'release', 'licenses');
execFileSync(process.execPath, [path.join(tool, 'scripts/collect-rust-notices.cjs'),
  path.join(root, 'launcher/src-tauri/Cargo.toml'), path.join(root, 'LICENSE'), output,
  path.join(root, 'launcher/src/icons/LICENSE-lucide'), path.join(root, 'THIRD_PARTY_NOTICES.md')],
{ stdio: 'inherit', windowsHide: true });

// Include all locked production packages, a conservative superset of the bundle.
const { licenseFiles } = createRequire(import.meta.url)(path.join(tool, 'scripts/collect-rust-notices.cjs'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const nodePackages = [];
const notices = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev) continue;
  if (!location.startsWith('node_modules/') || location.split('/').includes('..') || entry.link) throw Error('Unexpected production package location.');
  const directory = path.join(root, location);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== entry.version) throw Error(`Installed package differs from lock: ${location}`);
  const files = licenseFiles(directory);
  if (!files.length) throw Error(`Missing license text: ${pkg.name}@${pkg.version}`);
  const inventory = { name: pkg.name, version: pkg.version, license: pkg.license, files: [] };
  notices.push(`\n=== Node: ${pkg.name} ${pkg.version} ===\nDeclared license: ${pkg.license}\nSource: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`);
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const name = path.relative(directory, file).replaceAll('\\', '/');
    inventory.files.push({ name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    notices.push(`\n--- ${name} ---\n${bytes.toString('utf8')}\n`);
  }
  nodePackages.push(inventory);
}
fs.appendFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join(''));
fs.writeFileSync(path.join(output, 'node-dependencies.json'), `${JSON.stringify({ schemaVersion: 1, packages: nodePackages }, null, 2)}\n`);
const base = JSON.parse(fs.readFileSync(path.join(root, 'launcher/src-tauri/tauri.conf.json'), 'utf8'));
const resources = { ...base.bundle.resources };
for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'rust-dependencies.json', 'node-dependencies.json']) {
  resources[path.join(output, name)] = `licenses/${name}`;
}
fs.writeFileSync(path.join(root, 'release', 'tauri-notices.json'), JSON.stringify({ bundle: { resources } }, null, 2));
console.log(`Included license notices for ${nodePackages.length} locked Node production packages.`);
