import { readFile, writeFile, mkdir, mkdtemp, readdir, symlink, cp, stat } from 'node:fs/promises';
import { resolve, join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = resolve(import.meta.dirname, '..');
const host = resolve(process.env.BTW_HOST_DIR ?? resolve(source, '../openchamber'));
const output = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'release-'));
const cleanHost = join(root, 'openchamber');
const cleanExtension = join(root, 'ob-btw');
await mkdir(cleanHost);
const manifest = JSON.parse(await readFile(join(source, 'host-files.json'), 'utf8'));
const archive = execFileSync('git', ['archive', manifest.baseCommit], { cwd: host, maxBuffer: 256 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', cleanHost], { input: archive });
execFileSync('git', ['apply', join(source, 'host.patch')], { cwd: cleanHost });
execFileSync('git', ['init', '--quiet'], { cwd: cleanHost });
execFileSync('git', ['fetch', '--quiet', '--depth=1', host, manifest.baseCommit], { cwd: cleanHost });
execFileSync('git', ['reset', '--mixed', '--quiet', 'FETCH_HEAD'], { cwd: cleanHost });
async function verifySource() {
  for (const file of manifest.files) {
    const expected = await readFile(join(host, file));
    const actual = await readFile(join(cleanHost, file));
    if (!actual.equals(expected)) throw new Error(`The public patch does not reconstruct ${file}`);
  }
}
await verifySource();

// Dependencies are reused, but workspace package links resolve to this clean checkout.
async function linkDependencies(from, to) {
  if (!await stat(from).catch(() => null)) return;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '@openchamber') {
      await mkdir(join(to, entry.name), { recursive: true });
      for (const packageName of await readdir(join(from, entry.name))) {
        const own = join(cleanHost, 'packages', packageName);
        await symlink(await stat(own).catch(() => null) ? own : join(from, entry.name, packageName), join(to, entry.name, packageName));
      }
    } else await symlink(join(from, entry.name), join(to, entry.name));
  }
}
await linkDependencies(join(host, 'node_modules'), join(cleanHost, 'node_modules'));
for (const packageName of ['sdk', 'ui', 'web', 'electron', 'vscode', 'mobile']) await linkDependencies(join(host, 'packages', packageName, 'node_modules'), join(cleanHost, 'packages', packageName, 'node_modules'));
await cp(source, cleanExtension, { recursive: true, filter: (path) => !path.split('/').some((part) => ['node_modules', '.git', '.verification-output'].includes(part)) });
await linkDependencies(join(source, 'node_modules'), join(cleanExtension, 'node_modules'));

const bun = process.env.BUN_BIN ?? 'bun';
const env = { ...process.env, ...(bun.includes('/') ? { PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ''}` } : {}) };
const run = (cwd, args) => execFileSync(bun, args, { cwd, env, stdio: 'inherit' });
run(join(cleanHost, 'packages/sdk'), ['run', 'build']);
run(cleanHost, ['run', 'check:changed', '--base', manifest.baseCommit]);
run(cleanHost, ['run', 'build:web']);
run(cleanExtension, ['run', 'build']);
run(cleanExtension, ['run', 'typecheck']);
run(cleanExtension, ['run', 'check']);
await verifySource();
const record = { sourceBaseCommit: manifest.baseCommit,
  patchSha256: createHash('sha256').update(await readFile(join(source, 'host.patch'))).digest('hex'),
  verifiedSourceFiles: manifest.files.length, cleanPatchReconstruction: 'passed', cleanHostTypecheck: 'passed', cleanHostChangedGate: 'passed',
  cleanHostBuild: 'passed', cleanExtensionBuild: 'passed', cleanExtensionTypecheck: 'passed', extensionManifest: 'passed',
  scope: 'Pinned upstream source plus public host.patch. Workspace links resolve to the reconstructed source; third-party dependencies are reused.' };
await writeFile(join(source, 'verification/release-proof.json'), JSON.stringify(record, null, 2) + '\n');
await writeFile(join(output, 'release-directory.json'), JSON.stringify({ directory: root, host: cleanHost, extension: cleanExtension }, null, 2));
console.log(JSON.stringify(record, null, 2));
