import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('migration 11',()=>{
  it('adds guarded semantic columns and backfills legacy highlight colors',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration11-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TABLE highlights(id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0,color TEXT NOT NULL DEFAULT 'yellow',note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE threads(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,anchor_id TEXT,parent_message_id TEXT,title TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE artifacts(id TEXT PRIMARY KEY,document_version_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,content_json TEXT NOT NULL,source_refs_json TEXT NOT NULL,promoted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(kind,scope_type,scope_id,version));
    `);
    const insert=legacy.prepare('INSERT INTO highlights(id,anchor_id,checked,color,note,created_at,updated_at)VALUES(?,?,?,?,?,?,?)');
    for(const color of ['yellow','green','blue','pink'])insert.run(randomUUID(),randomUUID(),0,color,null,'legacy','legacy');
    legacy.close();

    const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href;
    const script=`
      process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
      process.env.AFTERDRAFT_PASSWORD='test-owner-password';
      process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
      await import(${JSON.stringify(moduleUrl)});
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(databasePath)});
      const names=table=>db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name);
      console.log(JSON.stringify({migration:Boolean(db.prepare('SELECT 1 FROM migrations WHERE version=11').get()),highlight:names('highlights'),thread:names('threads'),artifact:names('artifacts'),kinds:db.prepare('SELECT color,kind FROM highlights ORDER BY color').all()}));
    `;
    const run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8'});
    const first=run();
    expect(first.status,first.stderr).toBe(0);
    const result=JSON.parse(first.stdout.trim());
    expect(result.migration).toBe(true);
    expect(result.highlight).toContain('kind');
    expect(result.thread).toContain('annotation_text');
    expect(result.artifact).toEqual(expect.arrayContaining(['basis_document_version_id','basis_revision','basis_signal_hash']));
    expect(result.kinds).toEqual([{color:'blue',kind:'question'},{color:'green',kind:'important'},{color:'pink',kind:'comment'},{color:'yellow',kind:'important'}]);
    const second=run();
    expect(second.status,second.stderr).toBe(0);
  });

  it('normalizes legacy block-local anchor offsets without moving valid global offsets',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration11-anchors-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath),documentId=randomUUID(),versionId=randomUUID(),blockId=randomUUID(),localAnchorId=randomUUID(),globalAnchorId=randomUUID(),unmatchedAnchorId=randomUUID(),missingVisualAnchorId=randomUUID(),text='lead same quote between same quote tail',blockStart=100,exact='same quote',firstLocal=text.indexOf(exact),secondLocal=text.lastIndexOf(exact);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT);
      CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,content_hash TEXT NOT NULL UNIQUE,source_name TEXT NOT NULL,entry_path TEXT NOT NULL,sanitized_html_path TEXT NOT NULL,canonical_text TEXT NOT NULL,token_estimate INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
      CREATE TABLE blocks(id TEXT NOT NULL,document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,block_type TEXT NOT NULL,text_content TEXT NOT NULL,visual_data TEXT,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,PRIMARY KEY(document_version_id,id),UNIQUE(document_version_id,ordinal));
      CREATE TABLE anchors(id TEXT PRIMARY KEY,document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,block_id TEXT NOT NULL,exact_quote TEXT NOT NULL,prefix_text TEXT NOT NULL,suffix_text TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,block_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'attached',migrated_from_id TEXT,created_at TEXT NOT NULL);
    `);
    legacy.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,'Legacy anchors','legacy');
    legacy.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(versionId,documentId,randomUUID(),'legacy.html','legacy.html','/tmp/legacy.html',text,10,2,'legacy');
    legacy.prepare('INSERT INTO blocks(id,document_version_id,ordinal,block_type,text_content,start_offset,end_offset)VALUES(?,?,?,?,?,?,?)').run(blockId,versionId,0,'text',text,blockStart,blockStart+text.length);
    const insertAnchor=legacy.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    insertAnchor.run(localAnchorId,versionId,blockId,exact,text.slice(secondLocal-8,secondLocal),text.slice(secondLocal+exact.length,secondLocal+exact.length+8),secondLocal,secondLocal+exact.length,'text','attached','legacy');
    insertAnchor.run(globalAnchorId,versionId,blockId,exact,text.slice(0,firstLocal),text.slice(firstLocal+exact.length,firstLocal+exact.length+8),blockStart+firstLocal,blockStart+firstLocal+exact.length,'text','attached','legacy');
    insertAnchor.run(unmatchedAnchorId,versionId,blockId,'absent phrase','','',0,text.length,'text','unmatched','legacy');
    insertAnchor.run(missingVisualAnchorId,versionId,'removed-visual','','','',250,250,'image','attached','legacy');
    legacy.close();

    const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href,script=`
      process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
      process.env.AFTERDRAFT_PASSWORD='test-owner-password';
      process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
      await import(${JSON.stringify(moduleUrl)});
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(databasePath)});
      console.log(JSON.stringify(Object.fromEntries(db.prepare('SELECT id,block_id,start_offset,end_offset,status FROM anchors ORDER BY id').all().map(anchor=>[anchor.id,anchor]))));
    `,run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8',timeout:5000}),first=run();
    expect(first.status,first.stderr).toBe(0);
    const normalized=JSON.parse(first.stdout.trim());
    expect(normalized[localAnchorId]).toMatchObject({block_id:blockId,start_offset:blockStart+secondLocal,end_offset:blockStart+secondLocal+exact.length,status:'attached'});
    expect(normalized[globalAnchorId]).toMatchObject({block_id:blockId,start_offset:blockStart+firstLocal,end_offset:blockStart+firstLocal+exact.length,status:'attached'});
    expect(normalized[unmatchedAnchorId]).toMatchObject({block_id:blockId,start_offset:blockStart,end_offset:blockStart+text.length,status:'unmatched'});
    expect(normalized[missingVisualAnchorId]).toMatchObject({block_id:blockId,start_offset:blockStart,end_offset:blockStart,status:'unmatched'});
    const second=run();
    expect(second.status,second.stderr).toBe(0);
    expect(JSON.parse(second.stdout.trim())).toEqual(normalized);
  });
});
