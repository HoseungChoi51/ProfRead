import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openProfReadDatabase } from './open.js';

const directories: string[] = [];
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'profread-db-rename-')); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('ProfRead database identity', () => {
  it('imports committed WAL records without changing the legacy database', () => {
    const directory = temporary(), path = join(directory, 'afterdraft.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes VALUES(1,\'Saved discussion\')');
    const original = readFileSync(path), wal = readFileSync(`${path}-wal`);
    const migrated = openProfReadDatabase(directory);
    try {
      expect(migrated.prepare('SELECT body FROM notes').get()).toEqual({ body: 'Saved discussion' });
      expect(readFileSync(path)).toEqual(original);
      expect(readFileSync(`${path}-wal`)).toEqual(wal);
      migrated.exec("INSERT INTO notes VALUES(2,'New ProfRead note')");
      expect(legacy.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 1 });
    } finally { migrated.close(); legacy.close(); }
    const reopened = openProfReadDatabase(directory);
    try { expect(reopened.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 2 }); }
    finally { reopened.close(); }
  });

  it('never falls back to the legacy library when the new database already exists', () => {
    const directory = temporary(), legacy = new DatabaseSync(join(directory, 'afterdraft.sqlite'));
    legacy.exec('CREATE TABLE old_only(id)'); legacy.close();
    const current = new DatabaseSync(join(directory, 'profread.sqlite'));
    current.exec('CREATE TABLE current_only(id)'); current.close();
    const reopened = openProfReadDatabase(directory);
    try { expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'current_only' }]); }
    finally { reopened.close(); }
  });
});
