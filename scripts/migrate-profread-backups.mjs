import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (process.argv.length !== 4 || !sourceArgument || !targetArgument) throw new Error('usage: node scripts/migrate-profread-backups.mjs /path/afterdraft /path/profread');
const source = resolve(sourceArgument), target = resolve(targetArgument);
if (basename(source) !== 'afterdraft' || basename(target) !== 'profread' || dirname(source) !== dirname(target)) throw new Error('Backup history roots must be sibling afterdraft and profread directories');
if (!(await lstat(source)).isDirectory()) throw new Error('Legacy backup history must be a real directory, not a symbolic link');
const marker = '.profread-history-migration-incomplete';
if ((await readdir(source)).includes(marker)) throw new Error('Legacy source contains an unfinished migration marker');
// Exclusive creation refuses both existing histories and interrupted attempts.
// Keep an interrupted target and its marker for investigation, never delete it.
await mkdir(target, { mode: 0o750 });
await writeFile(join(target, marker), 'Do not accept this history until its verified-copy command completes. The legacy history is unchanged.\n', { flag: 'wx', mode: 0o640 });
for (const name of await readdir(source)) await cp(join(source, name), join(target, name), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
let files = 0, bytes = 0;
async function verify(relative = '') {
  const sourcePath = join(source, relative), targetPath = join(target, relative);
  const expected = (await readdir(sourcePath)).sort(), actual = (await readdir(targetPath)).filter(name => relative || name !== marker).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Backup history entries differ; retain both roots for inspection');
  for (const name of expected) {
    const next = join(relative, name), original = join(source, next), copied = join(target, next), a = await lstat(original), b = await lstat(copied);
    if (a.isDirectory() && b.isDirectory()) await verify(next);
    else if (a.isSymbolicLink() && b.isSymbolicLink()) { if (await readlink(original) !== await readlink(copied)) throw new Error('Backup history symbolic-link mismatch'); }
    else if (a.isFile() && b.isFile()) {
      if (a.size !== b.size || await digest(original) !== await digest(copied)) throw new Error('Backup history checksum mismatch');
      files++; bytes += a.size;
    } else throw new Error('Unexpected backup filesystem entry');
  }
}
await verify();
await unlink(join(target, marker));
console.log(JSON.stringify({ source, target, copiedFilesVerified: files, copiedBytesVerified: bytes, legacyHistoryPreserved: true }));
