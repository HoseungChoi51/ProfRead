import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

describe('migration 15',()=>{
  it('keeps only valid uniquely identified text anchors attached, without changing visual anchors',()=>{
    const dataDir=mkdtempSync(join(tmpdir(),'afterdraft-migration15-')),databasePath=join(dataDir,'afterdraft.sqlite'),legacy=new DatabaseSync(databasePath);
    legacy.exec(schema);
    const insertMigration=legacy.prepare('INSERT INTO migrations(version,applied_at)VALUES(?,?)');for(let version=1;version<=14;version++)insertMigration.run(version,'legacy');
    const documentId=randomUUID(),versionId=randomUUID(),validId=randomUUID(),splitContextId=randomUUID(),ambiguousId=randomUUID(),invalidId=randomUUID(),visualId=randomUUID(),unmatchedId=randomUUID();
    legacy.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,'Migration 15 document','legacy');
    legacy.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(versionId,documentId,randomUUID(),'legacy.html','legacy.html','/tmp/legacy.html','Migration 15 body',5,1,'legacy');
    const uniqueText='🙂 lead unique tail',duplicateText='before target after',invalidText='left precise right',insertBlock=legacy.prepare('INSERT INTO blocks(id,document_version_id,ordinal,block_type,text_content,start_offset,end_offset)VALUES(?,?,?,?,?,?,?)'),uniqueBlock=randomUUID(),duplicateOne=randomUUID(),duplicateTwo=randomUUID(),invalidBlock=randomUUID(),visualBlock=randomUUID();
    insertBlock.run(uniqueBlock,versionId,0,'text',uniqueText,100,100+uniqueText.length);
    insertBlock.run(duplicateOne,versionId,1,'text',duplicateText,200,200+duplicateText.length);
    insertBlock.run(duplicateTwo,versionId,2,'text',duplicateText,300,300+duplicateText.length);
    insertBlock.run(invalidBlock,versionId,3,'text',invalidText,400,400+invalidText.length);
    insertBlock.run(visualBlock,versionId,4,'image','Figure 1',500,508);
    const insertAnchor=legacy.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,status,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?)'),uniqueLocal=uniqueText.indexOf('unique'),duplicateLocal=duplicateText.indexOf('target'),invalidLocal=invalidText.indexOf('precise');
    insertAnchor.run(validId,versionId,uniqueBlock,'unique',uniqueText.slice(0,uniqueLocal),uniqueText.slice(uniqueLocal+'unique'.length),100+uniqueLocal,100+uniqueLocal+'unique'.length,'text','attached','legacy');
    insertAnchor.run(splitContextId,versionId,uniqueBlock,'unique',uniqueText.slice(1,uniqueLocal),uniqueText.slice(uniqueLocal+'unique'.length),100+uniqueLocal,100+uniqueLocal+'unique'.length,'text','attached','legacy');
    insertAnchor.run(ambiguousId,versionId,duplicateTwo,'target',duplicateText.slice(0,duplicateLocal),duplicateText.slice(duplicateLocal+'target'.length),300+duplicateLocal,300+duplicateLocal+'target'.length,'text','attached','legacy');
    insertAnchor.run(invalidId,versionId,invalidBlock,'precise',invalidText.slice(0,invalidLocal),invalidText.slice(invalidLocal+'precise'.length),400+invalidLocal+1,400+invalidLocal+1+'precise'.length,'text','attached','legacy');
    insertAnchor.run(visualId,versionId,visualBlock,'','','',500,500,'image','attached','legacy');
    insertAnchor.run(unmatchedId,versionId,uniqueBlock,'lead','🙂 ',' unique',103,107,'text','unmatched','legacy');
    legacy.close();

    const moduleUrl=pathToFileURL(resolve('apps/server/src/db/index.ts')).href,script=`
      process.env.AFTERDRAFT_DATA_DIR=${JSON.stringify(dataDir)};
      process.env.AFTERDRAFT_PASSWORD='test-owner-password';
      process.env.AFTERDRAFT_SESSION_SECRET='test-session-secret-with-more-than-thirty-two-characters';
      await import(${JSON.stringify(moduleUrl)});
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(databasePath)});
      console.log(JSON.stringify({migrationCount:db.prepare('SELECT count(*) AS count FROM migrations WHERE version=15').get().count,statuses:Object.fromEntries(db.prepare('SELECT id,status FROM anchors ORDER BY id').all().map(anchor=>[anchor.id,anchor.status]))}));
    `,run=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:resolve('.'),encoding:'utf8',timeout:5000}),first=run();
    expect(first.status,first.stderr).toBe(0);
    const result=JSON.parse(first.stdout.trim());
    expect(result.migrationCount).toBe(1);
    expect(result.statuses).toMatchObject({[validId]:'attached',[splitContextId]:'unmatched',[ambiguousId]:'unmatched',[invalidId]:'unmatched',[visualId]:'attached',[unmatchedId]:'unmatched'});
    const second=run();expect(second.status,second.stderr).toBe(0);expect(JSON.parse(second.stdout.trim())).toEqual(result);
  });
});
