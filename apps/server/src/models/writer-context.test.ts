import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, now, row, rows } from '../db/index.js';
import { saveEdits } from '../edits/index.js';
import { importSource } from '../ingest/index.js';
import { beginWriterApply, endWriterApply } from './writer-activity.js';
import { buildWriterRunSnapshot, normalizeWriterProposal, persistWriterProposal, writerProposalTool, writerSourceHash } from './writer-context.js';

function expectStrictProviderSchema(schema:unknown,root=true):void{
  const value=schema as Record<string,unknown>;expect(value).not.toHaveProperty('$schema');expect(value).not.toHaveProperty('oneOf');expect(value).not.toHaveProperty('minLength');expect(value).not.toHaveProperty('maxLength');
  if(root){expect(value.type).toBe('object');expect(value).not.toHaveProperty('anyOf')}
  if(value.type==='object'){const properties=value.properties as Record<string,unknown>;expect(value.additionalProperties).toBe(false);expect(new Set(value.required as string[])).toEqual(new Set(Object.keys(properties)));for(const property of Object.values(properties))expectStrictProviderSchema(property,false)}
  if(Array.isArray(value.anyOf))for(const option of value.anyOf)expectStrictProviderSchema(option,false);
  if(value.items&&typeof value.items==='object')expectStrictProviderSchema(value.items,false);
}

function addWriterRun(threadId:string):string{
  const id=randomUUID();db.prepare(`INSERT INTO model_runs(id,thread_id,request_id,action,profile,routing_reason,context_tier,status,created_at)
    VALUES(?,?,?,'document-write','writer','test writer','writer-full','completed',?)`).run(id,threadId,randomUUID(),now());return id;
}

describe('document Writer context and proposal validation',()=>{
  it('uses the complete effective block document and only immutable selected source snapshots',async()=>{
    const marker=randomUUID(),imported=await importSource({buffer:Buffer.from(`<title>Writer ${marker}</title><h1>Writer title</h1><p>Original paragraph</p><p>Removable paragraph</p>`),filename:`writer-${marker}.html`,mimeType:'text/html'}),time=now(),writerId=randomUUID(),documentId=imported.documentId!,versionId=imported.versionId!;
    db.prepare("INSERT INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES(?,?,?,'writer',?,?)").run(writerId,documentId,'Document Writer',time,time);
    const paragraph=row<{id:string}>('SELECT id FROM blocks WHERE document_version_id=? AND text_content=?',versionId,'Original paragraph')!;
    await saveEdits(versionId,0,[{type:'replace-text',blockId:paragraph.id,text:'Effective edited paragraph'}]);
    const selectedId=randomUUID(),selectedSnapshot={type:'message',messageId:'answer-selected',text:`Selected conclusion ${marker}`},selectedJson=JSON.stringify(selectedSnapshot);
    db.prepare('INSERT INTO writer_sources(id,thread_id,source_type,source_id,label,anchor_id,snapshot_json,snapshot_hash,created_at)VALUES(?,?,?,?,?,?,?,?,?)').run(selectedId,writerId,'message','answer-selected','Selected answer',null,selectedJson,await digest(selectedJson),time);
    const unselectedThread=randomUUID();db.prepare("INSERT INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES(?,?,?,'discussion',?,?)").run(unselectedThread,documentId,'Unselected',time,time);db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at)VALUES(?,?,?,?,?)').run(randomUUID(),unselectedThread,'assistant',`UNSELECTED-LEAK-${marker}`,time);
    const snapshot=await buildWriterRunSnapshot(versionId,writerId,'Integrate the selected conclusion.');
    expect(snapshot.baseRevision).toBe(1);expect(snapshot.blocks.map(block=>block.text)).toContain('Effective edited paragraph');expect(snapshot.blocks.map(block=>block.tag)).toContain('h1');expect(snapshot.prompt).toContain(`Selected conclusion ${marker}`);expect(snapshot.prompt).not.toContain(`UNSELECTED-LEAK-${marker}`);expect(snapshot.sourceHash).toBe(writerSourceHash(writerId));
    const removable=snapshot.blocks.find(block=>block.text==='Removable paragraph')!,edited=snapshot.blocks.find(block=>block.text==='Effective edited paragraph')!;
    const normalized=normalizeWriterProposal(snapshot,{version:1,title:'Integrate conclusion',summary:'Revises the explanation and adds a supporting section.',changes:[
      {operation:{type:'replace-text',blockId:edited.id,text:'Revised with the selected conclusion.'},rationale:'Use the selected answer.',sourceKeys:[selectedId]},
      {operation:{type:'insert-text-block',blockId:edited.id,position:'after',tag:'h2',text:'Additional context'},rationale:'Create a clear section.',sourceKeys:[selectedId]},
      {operation:{type:'delete-text-block',blockId:removable.id},rationale:'Remove obsolete prose.',sourceKeys:[]},
    ]});
    expect(normalized.changes).toHaveLength(3);expect(normalized.changes[0]).toMatchObject({beforeText:'Effective edited paragraph',beforeTag:'p'});expect(new Set(normalized.changes.map(change=>change.id)).size).toBe(3);
    const title=snapshot.blocks.find(block=>block.primaryTitle)!;
    expect(()=>normalizeWriterProposal(snapshot,{version:1,title:'Bad',summary:'Cannot delete title.',changes:[{operation:{type:'delete-text-block',blockId:title.id},rationale:'Bad',sourceKeys:[]}]})).toThrow(/primary document title/);
    expect(()=>normalizeWriterProposal(snapshot,{version:1,title:'Blank title',summary:'Cannot blank title.',changes:[{operation:{type:'replace-text',blockId:title.id,text:'   '},rationale:'Bad',sourceKeys:[]}]})).toThrow(/blank the primary document title/);
    expect(()=>normalizeWriterProposal(snapshot,{version:1,title:'No-op',summary:'No-op.',changes:[{operation:{type:'replace-text',blockId:edited.id,text:edited.text},rationale:'No-op',sourceKeys:[]}]})).toThrow(/no-op/);
    expect(()=>normalizeWriterProposal(snapshot,{version:1,title:'Leak',summary:'Unknown source.',changes:[{operation:{type:'replace-text',blockId:edited.id,text:'Different'},rationale:'Unknown',sourceKeys:['not-selected']}]})).toThrow(/unselected source/);
  });

  it('uses a strict provider tool contract and carries each persisted instruction into the next run prompt',async()=>{
    expectStrictProviderSchema(writerProposalTool().schema);
    const marker=randomUUID(),imported=await importSource({buffer:Buffer.from(`<title>Writer conversation ${marker}</title><h1>Conversation</h1><p>Draft paragraph</p>`),filename:`writer-conversation-${marker}.html`,mimeType:'text/html'}),writerId=randomUUID(),time=now();
    if(!imported.documentId||!imported.versionId)throw new Error('Writer conversation fixture failed');
    db.prepare("INSERT INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES(?,?,?,'writer',?,?)").run(writerId,imported.documentId,'Document Writer',time,time);
    const firstInstruction='First instruction: tighten the draft paragraph.',first=await buildWriterRunSnapshot(imported.versionId,writerId,firstInstruction),paragraph=first.blocks.find(block=>block.text==='Draft paragraph')!;
    const firstProposal=persistWriterProposal(first,addWriterRun(writerId),{version:1,title:'First pass',summary:'Tightens the draft.',changes:[{operation:{type:'replace-text',blockId:paragraph.id,text:'Tighter draft paragraph.'},rationale:'Follow the instruction.',sourceKeys:[]}]});
    expect(rows<{role:string;content:string}>('SELECT role,content FROM messages WHERE thread_id=? ORDER BY created_at,id',writerId)).toEqual([
      {role:'user',content:firstInstruction},{role:'assistant',content:'**First pass**\n\nTightens the draft.'},
    ]);
    const second=await buildWriterRunSnapshot(imported.versionId,writerId,'Second instruction: add context.');
    const priorUser=second.prompt.indexOf(`user: ${firstInstruction}`),priorAssistant=second.prompt.indexOf('assistant: **First pass**');
    expect(priorUser).toBeGreaterThan(-1);expect(priorAssistant).toBeGreaterThan(priorUser);expect(second.prompt).toContain('Second instruction: add context.');

    expect(beginWriterApply(writerId)).toBe(true);
    try{
      expect(()=>persistWriterProposal(second,addWriterRun(writerId),{version:1,title:'Blocked pass',summary:'Must not supersede during apply.',changes:[{operation:{type:'replace-text',blockId:paragraph.id,text:'Blocked replacement.'},rationale:'Blocked.',sourceKeys:[]}]})).toThrow('being applied');
    }finally{endWriterApply(writerId)}
    expect(row<{status:string}>('SELECT status FROM writer_proposals WHERE id=?',firstProposal.id)?.status).toBe('draft');
  });
});

async function digest(value:string):Promise<string>{const {createHash}=await import('node:crypto');return createHash('sha256').update(value).digest('hex')}
