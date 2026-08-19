import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createImportJobsTableSql, schema } from './schema.js';

describe('migration 16',()=>{
  it('adds PDF and URL sources without losing existing import jobs or findings',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration16-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath);
    legacy.exec(schema);for(let version=1;version<=15;version++)legacy.prepare('INSERT INTO migrations(version,applied_at)VALUES(?,?)').run(version,'legacy');
    legacy.exec('PRAGMA foreign_keys=OFF');legacy.exec('DROP TABLE import_jobs');legacy.exec(createImportJobsTableSql('import_jobs',false).replace(",'pdf','url'",''));legacy.exec('PRAGMA foreign_keys=ON');
    const jobId=randomUUID(),findingId=randomUUID(),time='2026-08-19T00:00:00.000Z';
    legacy.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES(?,?,?,?,?,?,'failed','failed',?,?)").run(jobId,'html','legacy.html','text/html',join(dataDir,'legacy.html'),'a'.repeat(64),time,time);
    legacy.prepare("INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,created_at,updated_at)VALUES(?,?,'deterministic','legacy_warning','warning','Legacy warning','Preserved finding',?,?)").run(findingId,jobId,time,time);legacy.close();

    const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href,script=`
      process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
      process.env.AFTERDRAFT_PASSWORD='test-owner-password';
      process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
      const imported=await import(${JSON.stringify(moduleUrl)}),db=imported.db;
      const insert=db.prepare("INSERT OR IGNORE INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES(?,?,?,?,?,?,'queued','queued',?,?)"),now=new Date().toISOString();
      insert.run('pdf-job','pdf','paper.pdf','application/pdf','/tmp/paper.pdf','b'.repeat(64),now,now);
      insert.run('url-job','url','https://example.test/paper','text/uri-list','/tmp/source.url','c'.repeat(64),now,now);
      let invalidRejected=false;try{db.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES(?,?,?,?,?,?,'queued','queued',?,?)").run('bad-job','ftp','bad','text/plain','/tmp/bad','d'.repeat(64),now,now)}catch{invalidRejected=true}
      console.log(JSON.stringify({migrationCount:db.prepare('SELECT count(*) count FROM migrations WHERE version=16').get().count,legacy:db.prepare('SELECT source_kind FROM import_jobs WHERE id=?').get(${JSON.stringify(jobId)}),finding:db.prepare('SELECT description FROM import_findings WHERE id=?').get(${JSON.stringify(findingId)}),kinds:db.prepare("SELECT source_kind FROM import_jobs WHERE id IN ('pdf-job','url-job') ORDER BY source_kind").all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),invalidRejected}));
    `,run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8',timeout:5000}),first=run();
    expect(first.status,first.stderr).toBe(0);const result=JSON.parse(first.stdout.trim());expect(result).toMatchObject({migrationCount:1,legacy:{source_kind:'html'},finding:{description:'Preserved finding'},kinds:[{source_kind:'pdf'},{source_kind:'url'}],foreignKeys:[],invalidRejected:true});
    const second=run();expect(second.status,second.stderr).toBe(0);expect(JSON.parse(second.stdout.trim())).toEqual(result);
  });
});
