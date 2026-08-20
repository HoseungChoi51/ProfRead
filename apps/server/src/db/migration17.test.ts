import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviewWorkflowSchema } from './review-schema.js';
import { schema } from './schema.js';

function runDatabase(dataDir:string){
  const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href,script=`
    process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
    process.env.AFTERDRAFT_PASSWORD='test-owner-password';
    process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
    const {db}=await import(${JSON.stringify(moduleUrl)});
    const names=table=>db.prepare('PRAGMA table_info('+table+')').all().map(value=>value.name);
    const parentFks=db.prepare('PRAGMA foreign_key_list(import_review_revisions)').all().filter(value=>value.from==='parent_revision_id');
    const revision=db.prepare("INSERT INTO import_review_revisions(id,import_job_id,repair_batch_id,parent_revision_id,status,base_derivative_hash,candidate_derivative_hash,html_path,canonical_hash,inventory_hash,operations_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    if(!db.prepare("SELECT 1 FROM import_jobs WHERE id='chain-job'").get()){db.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES('chain-job','html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review','now','now')").run('a'.repeat(64));db.prepare("INSERT INTO import_repair_batches(id,import_job_id,status,base_derivative_hash,candidate_derivative_hash,created_at,updated_at)VALUES('b1','chain-job','accepted','base','one','now','now'),('b2','chain-job','accepted','one','two','now','now')").run();revision.run('r1','chain-job','b1',null,'candidate','base','one','/tmp/one','c','i','[]','now');revision.run('r2','chain-job','b2','r1','active','one','two','/tmp/two','c','i','[]','now')}
    let invalidParentRejected=false;try{revision.run('bad','chain-job','b1','missing','candidate','base','bad','/tmp/bad','c','i','[]','now')}catch{invalidParentRejected=true}
    db.prepare("DELETE FROM import_jobs WHERE id='chain-job'").run();const chainDeleteOk=!db.prepare("SELECT 1 FROM import_review_revisions WHERE import_job_id='chain-job'").get();
    console.log(JSON.stringify({migrationCount:db.prepare('SELECT count(*) count FROM migrations WHERE version=17').get().count,migration18Count:db.prepare('SELECT count(*) count FROM migrations WHERE version=18').get().count,findingColumns:names('import_findings'),legacyFinding:db.prepare("SELECT description,source_comparison FROM import_findings WHERE id='legacy-finding'").get(),recovered:db.prepare("SELECT status,stage,qa_status,error FROM import_jobs WHERE id='rebuild-job'").get(),recheckRecovered:db.prepare("SELECT status,stage,qa_status,error FROM import_jobs WHERE id='recheck-job'").get(),issueColumns:names('import_review_issues'),batchIssueColumns:names('import_repair_batch_issues'),revisionColumns:names('import_review_revisions'),parentFks,foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),invalidParentRejected,chainDeleteOk}));
  `;
  return spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8',timeout:5000});
}

describe('migration 17',()=>{
  it('upgrades the pre-review schema idempotently with the revision-parent foreign key',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration17-upgrade-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath);
    legacy.exec(schema.replace(reviewWorkflowSchema,''));
    legacy.exec('ALTER TABLE import_findings DROP COLUMN source_comparison');
    for(let version=1;version<=16;version++)legacy.prepare('INSERT INTO migrations(version,applied_at)VALUES(?,?)').run(version,'legacy');
    legacy.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES('legacy-job','html','legacy.html','text/html','/tmp/legacy.html',?,'failed','failed','legacy','legacy')").run('f'.repeat(64));
    legacy.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,qa_status,created_at,updated_at)VALUES('rebuild-job','html','rebuild.html','text/html','/tmp/rebuild.html',?,'review-ready','review-rebuild','running','legacy','legacy')").run('e'.repeat(64));
    legacy.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,qa_status,created_at,updated_at)VALUES('recheck-job','html','recheck.html','text/html','/tmp/recheck.html',?,'review-ready','review-recheck','running','legacy','legacy')").run('d'.repeat(64));
    legacy.prepare("INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,created_at,updated_at)VALUES('legacy-finding','legacy-job','deterministic','legacy','warning','Legacy','Preserved finding','legacy','legacy')").run();
    legacy.close();
    const first=runDatabase(dataDir);expect(first.status,first.stderr).toBe(0);const result=JSON.parse(first.stdout.trim());
    expect(result).toMatchObject({migrationCount:1,migration18Count:1,foreignKeys:[],invalidParentRejected:true,chainDeleteOk:true});
    expect(result.issueColumns).toContain('policy_ids_json');
    expect(result.findingColumns).toContain('source_comparison');expect(result.legacyFinding).toEqual({description:'Preserved finding',source_comparison:''});
    expect(result.recovered).toMatchObject({status:'review-ready',stage:'review',qa_status:'failed',error:'Interrupted by service restart'});
    expect(result.recheckRecovered).toMatchObject({status:'review-ready',stage:'review',qa_status:'failed',error:'Interrupted by service restart'});
    expect(result.batchIssueColumns).not.toContain('parent_revision_id');
    expect(result.revisionColumns).toContain('parent_revision_id');
    expect(result.parentFks).toEqual([expect.objectContaining({table:'import_review_revisions',from:'parent_revision_id',to:'id'})]);
    const second=runDatabase(dataDir);expect(second.status,second.stderr).toBe(0);expect(JSON.parse(second.stdout.trim())).toEqual(result);
  });

  it('creates the same valid workflow schema in a fresh database',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration17-fresh-')),result=runDatabase(dataDir);
    expect(result.status,result.stderr).toBe(0);const value=JSON.parse(result.stdout.trim());
    expect(value).toMatchObject({migrationCount:1,migration18Count:1,foreignKeys:[],invalidParentRejected:true,chainDeleteOk:true});
    expect(value.revisionColumns).toContain('parent_revision_id');
    expect(value.batchIssueColumns).not.toContain('parent_revision_id');
  });

  it('upgrades the brief v17 RESTRICT schema and can cascade-delete an existing chain',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration18-restrict-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath),restrictWorkflow=reviewWorkflowSchema.replace('ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED','ON DELETE RESTRICT');
    legacy.exec(schema.replace(reviewWorkflowSchema,restrictWorkflow));for(let version=1;version<=17;version++)legacy.prepare('INSERT INTO migrations(version,applied_at)VALUES(?,?)').run(version,'legacy');
    legacy.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at)VALUES('chain-job','html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review','now','now')").run('a'.repeat(64));
    legacy.prepare("INSERT INTO import_repair_batches(id,import_job_id,status,base_derivative_hash,candidate_derivative_hash,created_at,updated_at)VALUES('b1','chain-job','accepted','base','one','now','now'),('b2','chain-job','accepted','one','two','now','now')").run();
    const revision=legacy.prepare("INSERT INTO import_review_revisions(id,import_job_id,repair_batch_id,parent_revision_id,status,base_derivative_hash,candidate_derivative_hash,html_path,canonical_hash,inventory_hash,operations_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    revision.run('r1','chain-job','b1',null,'candidate','base','one','/tmp/one','c','i','[]','now');revision.run('r2','chain-job','b2','r1','active','one','two','/tmp/two','c','i','[]','now');legacy.close();
    const upgraded=runDatabase(dataDir);expect(upgraded.status,upgraded.stderr).toBe(0);expect(JSON.parse(upgraded.stdout.trim())).toMatchObject({migration18Count:1,chainDeleteOk:true,foreignKeys:[]});
  });
});
