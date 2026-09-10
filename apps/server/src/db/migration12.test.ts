import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('migration 12',()=>{
  it('adds durable writer, annotation candidate, review, and edit-origin state idempotently',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration12-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT);
      CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,content_hash TEXT NOT NULL UNIQUE,source_name TEXT NOT NULL,entry_path TEXT NOT NULL,sanitized_html_path TEXT NOT NULL,canonical_text TEXT NOT NULL,token_estimate INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
      CREATE TABLE document_edit_revisions(id TEXT PRIMARY KEY,document_version_id TEXT NOT NULL,revision INTEGER NOT NULL,edited_html_path TEXT NOT NULL,canonical_text TEXT NOT NULL,base_title TEXT NOT NULL,summary_json TEXT NOT NULL,restored_from_revision INTEGER,created_at TEXT NOT NULL,UNIQUE(document_version_id,revision));
      CREATE TABLE threads(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,anchor_id TEXT,parent_message_id TEXT,title TEXT,annotation_text TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE model_runs(id TEXT PRIMARY KEY,thread_id TEXT,request_id TEXT NOT NULL UNIQUE,action TEXT NOT NULL,provider_id TEXT,model_id TEXT,profile TEXT NOT NULL,routing_reason TEXT NOT NULL,context_tier TEXT NOT NULL,fallback_model_id TEXT,status TEXT NOT NULL,ttft_ms INTEGER,latency_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,provider_response_id TEXT,response_text TEXT,error TEXT,created_at TEXT NOT NULL,completed_at TEXT);
      CREATE TABLE artifacts(id TEXT PRIMARY KEY,document_version_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,content_json TEXT NOT NULL,source_refs_json TEXT NOT NULL,promoted INTEGER NOT NULL DEFAULT 0,basis_document_version_id TEXT,basis_revision INTEGER,basis_signal_hash TEXT,created_at TEXT NOT NULL,UNIQUE(kind,scope_type,scope_id,version));
    `);
    const insertMigration=legacy.prepare('INSERT INTO migrations(version,applied_at)VALUES(?,?)');for(let version=1;version<=11;version++)insertMigration.run(version,'legacy');
    legacy.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run('document-1','Legacy document','legacy');
    legacy.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run('version-1','document-1','legacy-hash','legacy.html','legacy.html','/tmp/legacy.html','Legacy body',3,1,'legacy');
    legacy.prepare('INSERT INTO threads(id,document_id,title,annotation_text,created_at,updated_at)VALUES(?,?,?,?,?,?)').run('thread-1','document-1','Legacy discussion','Saved annotation','legacy','legacy');
    legacy.prepare('INSERT INTO document_edit_revisions(id,document_version_id,revision,edited_html_path,canonical_text,base_title,summary_json,created_at)VALUES(?,?,?,?,?,?,?,?)').run('revision-1','version-1',1,'/tmp/1.html','Legacy body','Legacy document','{}','legacy');
    legacy.prepare("INSERT INTO model_runs(id,thread_id,request_id,action,profile,routing_reason,context_tier,status,created_at)VALUES('orphan-run','thread-1','orphan-request','document-write','deep','legacy','writer-full','running','legacy')").run();
    legacy.close();

    const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href,script=`
      process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
      process.env.AFTERDRAFT_PASSWORD='test-owner-password';
      process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
      await import(${JSON.stringify(moduleUrl)});
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(join(dataDir,'profread.sqlite'))});
      const columns=table=>db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name);
      const fails=callback=>{try{callback();return false}catch{return true}};
      db.prepare("INSERT OR IGNORE INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES('writer-1','document-1','Writer','writer','now','now')").run();
      const duplicateWriterGuard=fails(()=>db.prepare("INSERT INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES('writer-2','document-1','Writer 2','writer','now','now')").run());
      const kindGuard=fails(()=>db.prepare("UPDATE threads SET kind='invalid' WHERE id='thread-1'").run());
      const candidateGuard=fails(()=>db.prepare("UPDATE threads SET annotation_candidate_status='invalid' WHERE id='thread-1'").run());
      db.prepare("INSERT OR IGNORE INTO writer_sources(id,thread_id,source_type,source_id,label,anchor_id,snapshot_json,snapshot_hash,created_at)VALUES('source-1','writer-1','message','deleted-answer','Retained answer',NULL,?,?,'now')").run(JSON.stringify({text:'snapshot'}),'a'.repeat(64));
      db.prepare("UPDATE document_edit_revisions SET origin_type='writer-proposal',origin_id='proposal-1' WHERE id='revision-1'").run();
      const duplicateOriginGuard=fails(()=>db.prepare("INSERT INTO document_edit_revisions(id,document_version_id,revision,edited_html_path,canonical_text,base_title,summary_json,origin_type,origin_id,created_at)VALUES('revision-2','version-1',2,'/tmp/2.html','Body','Legacy document','{}','writer-proposal','proposal-1','now')").run());
      console.log(JSON.stringify({
        migration:Boolean(db.prepare('SELECT 1 FROM migrations WHERE version=12').get()),
        threadColumns:columns('threads'),revisionColumns:columns('document_edit_revisions'),sourceColumns:columns('writer_sources'),proposalColumns:columns('writer_proposals'),reviewColumns:columns('summary_reviews'),
        oldKind:db.prepare("SELECT kind FROM threads WHERE id='thread-1'").get().kind,
        retainedSource:db.prepare("SELECT label,snapshot_json FROM writer_sources WHERE id='source-1'").get(),
        orphanRun:db.prepare("SELECT status,error,completed_at FROM model_runs WHERE id='orphan-run'").get(),
        duplicateWriterGuard,kindGuard,candidateGuard,duplicateOriginGuard,
      }));
    `,run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8',timeout:5000}),first=run();
    expect(first.status,first.stderr).toBe(0);
    const result=JSON.parse(first.stdout.trim());
    expect(result.migration).toBe(true);
    expect(result.threadColumns).toEqual(expect.arrayContaining(['kind','annotation_candidate_text','annotation_candidate_source_message_id','annotation_candidate_status','annotation_candidate_created_at']));
    expect(result.revisionColumns).toEqual(expect.arrayContaining(['origin_type','origin_id']));
    expect(result.sourceColumns).toEqual(expect.arrayContaining(['label','anchor_id','snapshot_json','snapshot_hash']));
    expect(result.proposalColumns).toEqual(expect.arrayContaining(['model_run_id','base_revision','base_html_hash','source_snapshot_json','changes_json','applied_change_ids_json']));
    expect(result.reviewColumns).toEqual(expect.arrayContaining(['artifact_id','model_run_id','document_version_id','artifact_version','basis_revision','basis_signal_hash','snapshot_json','decision','result_json','status']));
    expect(result.oldKind).toBe('discussion');
    expect(result.retainedSource).toEqual({label:'Retained answer',snapshot_json:'{"text":"snapshot"}'});
    expect(result.orphanRun).toMatchObject({status:'failed',error:'Interrupted by service restart'});expect(result.orphanRun.completed_at).toBeTruthy();
    expect(result).toMatchObject({duplicateWriterGuard:true,kindGuard:true,candidateGuard:true,duplicateOriginGuard:true});
    const second=run();expect(second.status,second.stderr).toBe(0);
  });
});
