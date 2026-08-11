import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import {
  writerProposalResultSchema,
  writerProposalToolInputSchema,
  writerProposalToolName,
  type WriterProposalChange,
  type WriterProposalResult,
  type WriterProposalToolInput,
} from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';
import { effectiveVersion } from '../edits/effective.js';
import { promptTemplate, renderPrompt } from './prompts.js';
import { isWriterApplying } from './writer-activity.js';

const editableTags=new Set(['h1','h2','h3','h4','h5','h6','p','li','blockquote','pre','figcaption','caption']);
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

export interface WriterDocumentBlock {
  id:string;
  ordinal:number;
  tag:string;
  text:string;
  primaryTitle:boolean;
}

export interface WriterSourceSnapshot {
  id:string;
  key:string;
  sourceType:string;
  sourceId:string;
  label:string;
  anchorId:string|null;
  snapshot:unknown;
  snapshotHash:string;
  createdAt:string;
}

export interface WriterRunSnapshot {
  documentId:string;
  documentVersionId:string;
  threadId:string;
  baseRevision:number;
  baseHtmlHash:string;
  sourceHash:string;
  instruction:string;
  blocks:WriterDocumentBlock[];
  sources:WriterSourceSnapshot[];
  prompt:string;
  systemPrompt:string;
  tokenEstimate:number;
}

type StoredWriterSource={id:string;source_type:string;source_id:string;label:string;anchor_id:string|null;snapshot_json:string;snapshot_hash:string;created_at:string};
type StoredProposal={id:string;thread_id:string;model_run_id:string;document_version_id:string;base_revision:number;base_html_hash:string;source_hash:string;instruction:string;title:string;summary:string;changes_json:string;status:string;applied_revision:number|null;applied_change_ids_json:string|null;created_at:string;updated_at:string;applied_at:string|null};

function sourceRows(threadId:string):StoredWriterSource[]{return rows<StoredWriterSource>('SELECT * FROM writer_sources WHERE thread_id=? ORDER BY created_at,id',threadId)}

export function writerSourceHash(threadId:string):string {
  return sha256(JSON.stringify(sourceRows(threadId).map(source=>({id:source.id,type:source.source_type,sourceId:source.source_id,snapshotHash:source.snapshot_hash}))));
}

function serializeSources(stored:StoredWriterSource[]):WriterSourceSnapshot[]{return stored.map(source=>({
  id:source.id,key:source.id,sourceType:source.source_type,sourceId:source.source_id,label:source.label,anchorId:source.anchor_id,
  snapshot:JSON.parse(source.snapshot_json),snapshotHash:source.snapshot_hash,createdAt:source.created_at,
}))}

function serializeProposal(stored:StoredProposal):WriterProposalResult{return writerProposalResultSchema.parse({
  id:stored.id,threadId:stored.thread_id,modelRunId:stored.model_run_id,documentVersionId:stored.document_version_id,
  baseRevision:stored.base_revision,baseHtmlHash:stored.base_html_hash,sourceHash:stored.source_hash,instruction:stored.instruction,
  title:stored.title,summary:stored.summary,changes:JSON.parse(stored.changes_json),status:stored.status,
  appliedRevision:stored.applied_revision,appliedChangeIds:stored.applied_change_ids_json?JSON.parse(stored.applied_change_ids_json):null,
  createdAt:stored.created_at,updatedAt:stored.updated_at,appliedAt:stored.applied_at,
})}

export function writerProposalForRun(modelRunId:string):WriterProposalResult|undefined{
  const proposal=row<StoredProposal>('SELECT * FROM writer_proposals WHERE model_run_id=?',modelRunId);
  return proposal?serializeProposal(proposal):undefined;
}

export function writerProposals(threadId:string):WriterProposalResult[]{return rows<StoredProposal>('SELECT * FROM writer_proposals WHERE thread_id=? ORDER BY created_at DESC',threadId).map(serializeProposal)}

export async function buildWriterRunSnapshot(documentVersionId:string,threadId:string,instructionValue:string):Promise<WriterRunSnapshot>{
  const instruction=instructionValue.trim();if(!instruction)throw Object.assign(new Error('Document Writer instruction is required'),{statusCode:400});
  const thread=row<{document_id:string;kind:string;anchor_id:string|null;parent_message_id:string|null;latest_version_id:string|null}>(`SELECT t.document_id,t.kind,t.anchor_id,t.parent_message_id,
    (SELECT v.id FROM document_versions v WHERE v.document_id=t.document_id ORDER BY v.version DESC LIMIT 1) latest_version_id FROM threads t WHERE t.id=?`,threadId);
  if(!thread)throw Object.assign(new Error('Writer thread not found'),{statusCode:404});
  if(thread.kind!=='writer'||thread.anchor_id||thread.parent_message_id)throw Object.assign(new Error('Document Writer requires its document-level Writer thread'),{statusCode:400});
  if(thread.latest_version_id!==documentVersionId)throw Object.assign(new Error('Document Writer requires the latest document version'),{statusCode:409});
  const version=effectiveVersion(documentVersionId);if(!version||version.document_id!==thread.document_id)throw Object.assign(new Error('Writer document version mismatch'),{statusCode:400});
  const html=await readFile(version.htmlPath,'utf8'),$=cheerio.load(html),tags=new Map<string,string>();
  $('[data-block-id]').each((_index,element)=>{const id=$(element).attr('data-block-id');if(id&&!tags.has(id))tags.set(id,element.tagName.toLowerCase())});
  const storedBlocks=rows<{id:string;ordinal:number;text_content:string;block_type:string}>('SELECT id,ordinal,text_content,block_type FROM blocks WHERE document_version_id=? ORDER BY ordinal',documentVersionId);
  const firstH1=storedBlocks.find(block=>tags.get(block.id)==='h1')?.id;
  const blocks=storedBlocks.map(block=>({id:block.id,ordinal:block.ordinal,tag:tags.get(block.id)??block.block_type,text:block.text_content,primaryTitle:block.id===firstH1}));
  const sources=serializeSources(sourceRows(threadId)),sourceHash=writerSourceHash(threadId);
  const conversation=rows<{role:string;content:string}>('SELECT role,content FROM messages WHERE thread_id=? ORDER BY created_at,id',threadId);
  const previous=row<{title:string;summary:string;changes_json:string}>('SELECT title,summary,changes_json FROM writer_proposals WHERE thread_id=? ORDER BY created_at DESC LIMIT 1',threadId);
  const documentJson=JSON.stringify({version:1,title:row<{title:string}>('SELECT title FROM documents WHERE id=?',thread.document_id)?.title??'',blocks});
  const sourceSnapshots=JSON.stringify(sources.map(source=>({key:source.key,type:source.sourceType,label:source.label,anchorId:source.anchorId,data:source.snapshot})));
  const writerConversation=conversation.map(message=>`${message.role}: ${message.content}`).join('\n');
  const previousProposal=previous?JSON.stringify({title:previous.title,summary:previous.summary,changes:JSON.parse(previous.changes_json)}):'(none)';
  const contract=promptTemplate('contract.document-write'),prompt=renderPrompt('writer.envelope',{documentJson,sourceSnapshots,writerConversation,previousProposal,instruction,contract}),systemPrompt=promptTemplate('system.document-writer');
  return{documentId:thread.document_id,documentVersionId,threadId,baseRevision:version.revision,baseHtmlHash:sha256(html),sourceHash,instruction,blocks,sources,prompt,systemPrompt,tokenEstimate:Math.ceil((prompt.length+systemPrompt.length)/4)};
}

const strictWriterString=()=>({type:'string'} as const);
const strictWriterObject=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false} as const);
const writerOperationSchema={anyOf:[
  strictWriterObject({type:{type:'string',enum:['replace-text']},blockId:strictWriterString(),text:strictWriterString()}),
  strictWriterObject({type:{type:'string',enum:['insert-text-block']},blockId:strictWriterString(),position:{type:'string',enum:['before','after']},tag:{type:'string',enum:['p','h2','h3','h4','h5','h6','blockquote','pre']},text:strictWriterString()}),
  strictWriterObject({type:{type:'string',enum:['delete-text-block']},blockId:strictWriterString()}),
]} as const;
const writerProposalToolSchema=strictWriterObject({
  version:{type:'integer',enum:[1]},
  title:strictWriterString(),
  summary:strictWriterString(),
  changes:{type:'array',minItems:1,maxItems:200,items:strictWriterObject({
    operation:writerOperationSchema,
    rationale:strictWriterString(),
    sourceKeys:{type:'array',maxItems:50,items:strictWriterString()},
  })},
});
export function writerProposalTool(){return{name:writerProposalToolName,schema:writerProposalToolSchema}}

function parseToolInput(value:unknown):WriterProposalToolInput{
  if(typeof value==='string'){try{return writerProposalToolInputSchema.parse(JSON.parse(value))}catch(error){if(error instanceof SyntaxError)throw new Error('Document Writer returned invalid proposal JSON');throw error}}
  return writerProposalToolInputSchema.parse(value);
}

export function normalizeWriterProposal(snapshot:WriterRunSnapshot,value:unknown):{input:WriterProposalToolInput;changes:WriterProposalChange[]}{
  const input=parseToolInput(value),blocks=new Map(snapshot.blocks.map(block=>[block.id,block])),sourceKeys=new Set(snapshot.sources.map(source=>source.key)),claimed=new Map<string,string>(),changes:WriterProposalChange[]=[];
  for(const change of input.changes){
    const operation=change.operation,target=blocks.get(operation.blockId);
    if(!target||!editableTags.has(target.tag))throw new Error(`Writer proposal targets an unknown or non-text block: ${operation.blockId}`);
    if(operation.type!=='insert-text-block'){
      const prior=claimed.get(operation.blockId);if(prior)throw new Error(`Writer proposal contains conflicting changes for block ${operation.blockId}`);claimed.set(operation.blockId,operation.type);
    }
    if(operation.type==='delete-text-block'&&target.primaryTitle)throw new Error('Writer proposal cannot delete the primary document title');
    if(operation.type==='replace-text'&&target.primaryTitle&&!operation.text.trim())throw new Error('Writer proposal cannot blank the primary document title');
    if(operation.type==='replace-text'&&operation.text===target.text)throw new Error(`Writer proposal contains a no-op replacement for block ${operation.blockId}`);
    for(const key of change.sourceKeys)if(!sourceKeys.has(key))throw new Error(`Writer proposal cites an unselected source: ${key}`);
    changes.push({...change,id:nanoid(),beforeText:target.text,beforeTag:target.tag});
  }
  return{input,changes};
}

export function persistWriterProposal(snapshot:WriterRunSnapshot,modelRunId:string,value:unknown):WriterProposalResult{
  const existing=writerProposalForRun(modelRunId);if(existing)return existing;
  if(isWriterApplying(snapshot.threadId))throw Object.assign(new Error('Writer proposal is being applied'),{statusCode:409});
  const {input,changes}=normalizeWriterProposal(snapshot,value),id=nanoid(),userMessageId=nanoid(),assistantMessageId=nanoid(),time=now(),assistantTime=new Date(Date.parse(time)+1).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{
    if(isWriterApplying(snapshot.threadId))throw Object.assign(new Error('Writer proposal is being applied'),{statusCode:409});
    db.prepare("UPDATE writer_proposals SET status='superseded',updated_at=? WHERE thread_id=? AND status='draft'").run(time,snapshot.threadId);
    db.prepare(`INSERT INTO writer_proposals(id,thread_id,model_run_id,document_version_id,base_revision,base_html_hash,source_hash,source_snapshot_json,instruction,title,summary,changes_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`).run(id,snapshot.threadId,modelRunId,snapshot.documentVersionId,snapshot.baseRevision,snapshot.baseHtmlHash,snapshot.sourceHash,JSON.stringify(snapshot.sources),snapshot.instruction,input.title,input.summary,JSON.stringify(changes),time,time);
    db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)').run(userMessageId,snapshot.threadId,'user',snapshot.instruction,time);
    db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)').run(assistantMessageId,snapshot.threadId,'assistant',`**${input.title}**\n\n${input.summary}`,assistantTime);
    db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(assistantTime,snapshot.threadId);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return serializeProposal(row<StoredProposal>('SELECT * FROM writer_proposals WHERE id=?',id)!);
}

export async function currentWriterBasis(documentVersionId:string,threadId:string):Promise<{documentVersionId:string;revision:number;htmlHash:string;sourceHash:string}>{
  const version=effectiveVersion(documentVersionId);if(!version)throw new Error('Document version not found');
  return{documentVersionId,revision:version.revision,htmlHash:sha256(await readFile(version.htmlPath)),sourceHash:writerSourceHash(threadId)};
}
