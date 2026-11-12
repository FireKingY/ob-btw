import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const host = resolve(process.env.BTW_HOST_DIR ?? resolve(root, '../openchamber'));
const manifest = JSON.parse(await readFile(resolve(root, 'host-files.json'), 'utf8'));
for (const file of manifest.files) {
  if (!/^packages\/(?:ui\/src|sdk)\//.test(file) || file.split('/').includes('..')) throw new Error(`Invalid source path: ${file}`);
}
let patch = execFileSync('git', ['diff', '--no-ext-diff', '--binary', manifest.baseCommit, '--', ...manifest.files], { cwd: host, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const included = new Set([...patch.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map((match) => match[1]));
for (const file of manifest.files) {
  if (included.has(file)) continue;
  const existed = spawnSync('git', ['cat-file', '-e', `${manifest.baseCommit}:${file}`], { cwd: host, stdio: 'ignore' }).status === 0;
  if (existed) continue;
  const added = spawnSync('git', ['diff', '--no-index', '--binary', '--', '/dev/null', file], { cwd: host, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (added.status !== 1 || !added.stdout.includes('new file mode')) throw new Error(`Could not include new source: ${file}`);
  patch += added.stdout;
}
await writeFile(resolve(root, 'host.patch'), patch);
console.log(JSON.stringify({ files: [...patch.matchAll(/^diff --git /gm)].length, newFiles: [...patch.matchAll(/^new file mode /gm)].length,
  sha256: createHash('sha256').update(patch).digest('hex') }, null, 2));
