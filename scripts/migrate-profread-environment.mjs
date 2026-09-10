import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { basename, resolve } from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || process.argv.length !== 4 || basename(source) !== 'afterdraft.env' || basename(destination) !== 'profread.env' || resolve(source) === resolve(destination)) {
  throw new Error('usage: node scripts/migrate-profread-environment.mjs /path/afterdraft.env /path/profread.env');
}
const text = await readFile(source, 'utf8');
const seen = new Set();
const migrated = text.replace(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/gm, (_match, prefix, name, equals) => {
  const canonical = name.replace(/^AFTERDRAFT_/, 'PROFREAD_');
  if (seen.has(canonical)) throw new Error(`Conflicting configuration variable: ${canonical}`);
  seen.add(canonical);
  return `${prefix}${canonical}${equals}`;
});
await writeFile(destination, migrated, { mode: 0o600, flag: 'wx' });
console.log('ProfRead environment created with unchanged credential values; the original remains available for rollback.');
