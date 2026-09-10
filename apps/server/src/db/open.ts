import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Create the new database through SQLite, including committed legacy WAL pages.
 * Keep the legacy database untouched for recovery; never replace an existing new database.
 */
export function openProfReadDatabase(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, 'profread.sqlite');
  const legacy = join(directory, 'afterdraft.sqlite');
  if (!existsSync(destination) && existsSync(legacy)) {
    const temporary = join(directory, `.profread-migration-${randomUUID()}.sqlite`);
    const source = new DatabaseSync(legacy, { readOnly: true });
    try {
      source.prepare('VACUUM INTO ?').run(temporary);
      const candidate = new DatabaseSync(temporary, { readOnly: true });
      try {
        const integrity = candidate.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') {
          throw new Error('Legacy ProfRead database failed integrity verification');
        }
        if (candidate.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('Legacy ProfRead database contains invalid foreign keys');
        }
      } finally {
        candidate.close();
      }
      // An exclusive link makes publication atomic and refuses a conflicting migration.
      try { linkSync(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      source.close();
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return new DatabaseSync(destination);
}
