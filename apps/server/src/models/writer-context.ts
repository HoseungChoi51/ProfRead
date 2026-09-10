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
} from '@profread/shared';
import { db, now, row, rows } from '../db/index.js';
import { effectiveVersion } from '../edits/effective.js';
import { promptTemplate, renderPrompt } from './prompts.js';
import { estimateModelRequestTokens } from './token-estimate.js';
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
  /** Prompt-only block reference -> persisted block ID. */
  blockAliases:Readonly<Record<string,string>>;
  /** Prompt-only source reference -> persisted Writer source key. */
  sourceAliases:Readonly<Record<string,string>>;
  prompt:string;
  systemPrompt:string;
  tokenEstimate:number;
}

type StoredWriterSource={id:string;source_type:string;source_id:string;label:string;anchor_id:string|null;snapshot_json:string;snapshot_hash:string;created_at:string};
type StoredProposal={id:string;thread_id:string;model_run_id:string;document_version_id:string;base_revision:number;base_html_hash:string;source_hash:string;instruction:string;title:string;summary:string;changes_json:string;status:string;applied_revision:number|null;applied_change_ids_json:string|null;created_at:string;updated_at:string;applied_at:string|null};
type WriterConversationMessage={role:string;content:string};

const writerConversationLimit=16_000;
const writerConversationRecentLimit=10_000;
const writerConversationRecentMessages=16;
const writerConversationDigestMessages=12;
const writerConversationDigestExcerpt=180;
const previousProposalLimit=12_000;

function sourceRows(threadId:string):StoredWriterSource[]{return rows<StoredWriterSource>('SELECT * FROM writer_sources WHERE thread_id=? ORDER BY created_at,id',threadId)}

export function writerSourceHash(threadId:string):string {
  return sha256(JSON.stringify(sourceRows(threadId).map(source=>({id:source.id,type:source.source_type,sourceId:source.source_id,snapshotHash:source.snapshot_hash}))));
}

function serializeSources(stored:StoredWriterSource[]):WriterSourceSnapshot[]{return stored.map(source=>({
  id:source.id,key:source.id,sourceType:source.source_type,sourceId:source.source_id,label:source.label,anchorId:source.anchor_id,
  snapshot:JSON.parse(source.snapshot_json),snapshotHash:source.snapshot_hash,createdAt:source.created_at,
}))}

function aliases<T extends{id:string}>(values:T[],prefix:string):Record<string,string>{
  return Object.fromEntries(values.map((value,index)=>[`${prefix}${index.toString(36)}`,value.id]));
}

function aliasById(values:Readonly<Record<string,string>>):Map<string,string>{
  return new Map(Object.entries(values).map(([alias,id])=>[id,alias]));
}

function sourceEnvelopeMetadataKey(key:string):boolean{
  return key==='id'||key==='sourceRefs'||/(?:Id|Ids)$/.test(key)||/(?:_id|_ids)$/.test(key);
}

function withoutSourceEnvelopeMetadata(value:unknown):unknown{
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .filter(([key])=>key!=='type'&&!sourceEnvelopeMetadataKey(key)));
}

function truncateForPrompt(value:string,limit:number):string{
  if(value.length<=limit)return value;
  const suffix='…';let result='';
  for(const character of value){if(result.length+character.length+suffix.length>limit)break;result+=character}
  return result+suffix;
}

function conversationProjection(messages:WriterConversationMessage[]):string{
  const complete={v:2,columns:['role','content'],messages:messages.map(message=>[message.role,message.content])};
  const serialized=JSON.stringify(complete);if(serialized.length<=writerConversationLimit)return serialized;
  let recentLimit=writerConversationRecentLimit,digestExcerpt=writerConversationDigestExcerpt;
  for(;;){
    const recent:WriterConversationMessage[]=[];let recentBudget=recentLimit;
    for(let index=messages.length-1;index>=0&&recent.length<writerConversationRecentMessages&&recentBudget>0;index--){
      const message=messages[index]!,content=truncateForPrompt(message.content,recentBudget);recent.unshift({...message,content});recentBudget-=content.length;
    }
    const omitted=messages.slice(0,messages.length-recent.length),digestIndexes=[...Array.from({length:Math.min(4,omitted.length)},(_value,index)=>index),...Array.from({length:Math.min(8,omitted.length)},(_value,index)=>omitted.length-Math.min(8,omitted.length)+index)],selectedIndexes=[...new Set(digestIndexes)].slice(0,writerConversationDigestMessages);
    const compacted=JSON.stringify({
      v:2,
      columns:['role','content'],
      compacted:{omittedMessages:omitted.length,digest:selectedIndexes.map(index=>[omitted[index]!.role,truncateForPrompt(omitted[index]!.content,digestExcerpt)])},
      messages:recent.map(message=>[message.role,message.content]),
    });
    if(compacted.length<=writerConversationLimit)return compacted;
    recentLimit=Math.max(32,Math.floor(recentLimit*0.7));digestExcerpt=Math.max(8,Math.floor(digestExcerpt*0.7));
  }
}

function compactOperation(operation:WriterProposalChange['operation'],blockAliasById:Map<string,string>,textLimit?:number):unknown[]{
  const blockRef=blockAliasById.get(operation.blockId)??null;
  const text=textLimit===undefined?undefined:truncateForPrompt(operation.type==='delete-text-block'?'':operation.text,textLimit);
  if(operation.type==='replace-text')return[operation.type,blockRef,text??operation.text];
  if(operation.type==='insert-text-block')return[operation.type,blockRef,operation.position,operation.tag,text??operation.text];
  return[operation.type,blockRef];
}

function previousProposalProjection(stored:Pick<StoredProposal,'title'|'summary'|'changes_json'>,blockAliasById:Map<string,string>,sourceAliasById:Map<string,string>):string{
  const changes=JSON.parse(stored.changes_json) as WriterProposalChange[];
  const complete=JSON.stringify({
    v:2,
    title:stored.title,
    summary:stored.summary,
    columns:['operation','rationale','sourceRefs'],
    changes:changes.map(change=>[
      compactOperation(change.operation,blockAliasById),
      change.rationale,
      change.sourceKeys.map(key=>sourceAliasById.get(key)??null),
    ]),
  });
  if(complete.length<=previousProposalLimit)return complete;
  const indexes=[...new Set([...Array.from({length:Math.min(4,changes.length)},(_value,index)=>index),...Array.from({length:Math.min(4,changes.length)},(_value,index)=>changes.length-Math.min(4,changes.length)+index)])];
  let textLimit=400,rationaleLimit=160,summaryLimit=1_000,selected=indexes;
  for(;;){
    const compacted=JSON.stringify({
      v:2,
      title:stored.title,
      summary:truncateForPrompt(stored.summary,summaryLimit),
      compacted:{totalChanges:changes.length,includedChanges:selected.length,truncated:true},
      columns:['operation','rationale','sourceRefs'],
      changes:selected.map(index=>{
        const change=changes[index]!;return[compactOperation(change.operation,blockAliasById,textLimit),truncateForPrompt(change.rationale,rationaleLimit),change.sourceKeys.map(key=>sourceAliasById.get(key)??null)];
      }),
    });
    if(compacted.length<=previousProposalLimit)return compacted;
    if(textLimit>32)textLimit=Math.max(32,Math.floor(textLimit*0.6));
    else if(rationaleLimit>32)rationaleLimit=Math.max(32,Math.floor(rationaleLimit*0.6));
    else if(summaryLimit>160)summaryLimit=Math.max(160,Math.floor(summaryLimit*0.6));
    else if(selected.length>2)selected=[selected[0]!,selected.at(-1)!];
    else return JSON.stringify({v:2,title:truncateForPrompt(stored.title,80),summary:truncateForPrompt(stored.summary,80),compacted:{totalChanges:changes.length,includedChanges:0,truncated:true},columns:['operation','rationale','sourceRefs'],changes:[]});
  }
}

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
  const html=await readFile(version.htmlPath,'utf8'),$=cheerio.load(html),domBlocks=new Map<string,{tag:string;text:string}>();
  $('[data-block-id]').each((_index,element)=>{const id=$(element).attr('data-block-id');if(id&&!domBlocks.has(id))domBlocks.set(id,{tag:element.tagName.toLowerCase(),text:$(element).text()})});
  const storedBlocks=rows<{id:string;ordinal:number;text_content:string;block_type:string}>('SELECT id,ordinal,text_content,block_type FROM blocks WHERE document_version_id=? ORDER BY ordinal',documentVersionId);
  const firstH1=storedBlocks.find(block=>domBlocks.get(block.id)?.tag==='h1')?.id;
  const blocks=storedBlocks.map(block=>{const domBlock=domBlocks.get(block.id);return{id:block.id,ordinal:block.ordinal,tag:domBlock?.tag??block.block_type,text:domBlock?.tag==='pre'?domBlock.text:block.text_content,primaryTitle:block.id===firstH1}});
  const sources=serializeSources(sourceRows(threadId)),sourceHash=writerSourceHash(threadId),blockAliases=aliases(blocks,'b'),sourceAliases=aliases(sources,'s'),blockAliasById=aliasById(blockAliases),sourceAliasById=aliasById(sourceAliases);
  const conversation=rows<{role:string;content:string}>('SELECT role,content FROM messages WHERE thread_id=? ORDER BY created_at,id',threadId);
  const previous=row<{title:string;summary:string;changes_json:string}>('SELECT title,summary,changes_json FROM writer_proposals WHERE thread_id=? ORDER BY created_at DESC LIMIT 1',threadId);
  const primaryTitle=blocks.find(block=>block.primaryTitle),documentJson=JSON.stringify({v:2,title:row<{title:string}>('SELECT title FROM documents WHERE id=?',thread.document_id)?.title??'',primary:primaryTitle?blockAliasById.get(primaryTitle.id):null,columns:['ref','tag','text'],blocks:blocks.map(block=>[blockAliasById.get(block.id),block.tag,block.text])});
  const sourceSnapshots=JSON.stringify({v:2,columns:['ref','type','label','data'],sources:sources.map(source=>[sourceAliasById.get(source.key),source.sourceType,source.label,withoutSourceEnvelopeMetadata(source.snapshot)])});
  const writerConversation=conversationProjection(conversation);
  const previousProposal=previous?previousProposalProjection(previous,blockAliasById,sourceAliasById):'(none)';
  const contract=promptTemplate('contract.document-write'),prompt=renderPrompt('writer.envelope',{documentJson,sourceSnapshots,writerConversation,previousProposal,instruction,contract}),systemPrompt=promptTemplate('system.document-writer'),tool=writerProposalTool();
  const tokenEstimate=estimateModelRequestTokens({messages:[{role:'system',content:systemPrompt},{role:'user',content:prompt}],tools:[tool],requiredToolName:writerProposalToolName});
  return{documentId:thread.document_id,documentVersionId,threadId,baseRevision:version.revision,baseHtmlHash:sha256(html),sourceHash,instruction,blocks,sources,blockAliases,sourceAliases,prompt,systemPrompt,tokenEstimate};
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
  const parsedInput=parseToolInput(value),blocks=new Map(snapshot.blocks.map(block=>[block.id,block])),sourceKeys=new Set(snapshot.sources.map(source=>source.key)),blockAliases=new Map(Object.entries(snapshot.blockAliases??{})),sourceAliases=new Map(Object.entries(snapshot.sourceAliases??{})),claimed=new Map<string,string>(),insertions=new Set<string>(),deleted=new Set<string>(),normalizedInputs:WriterProposalToolInput['changes']=[],changes:WriterProposalChange[]=[];
  for(const change of parsedInput.changes){
    const operation=change.operation,resolvedBlockId=blockAliases.get(operation.blockId)??operation.blockId,target=blocks.get(resolvedBlockId);
    if(!target||!editableTags.has(target.tag))throw new Error(`Writer proposal targets an unknown or non-text block: ${operation.blockId}`);
    if(operation.type==='insert-text-block'){
      const insertion=`${target.id}:${operation.position}`;if(insertions.has(insertion))throw new Error('Writer proposal contains conflicting insertions at the same position');insertions.add(insertion);
    }else{
      const prior=claimed.get(target.id);if(prior)throw new Error(`Writer proposal contains conflicting changes for block ${operation.blockId}`);claimed.set(target.id,operation.type);
    }
    if(operation.type==='delete-text-block'){if(target.primaryTitle)throw new Error('Writer proposal cannot delete the primary document title');deleted.add(target.id)}
    if(operation.type==='replace-text'&&target.primaryTitle&&!operation.text.trim())throw new Error('Writer proposal cannot blank the primary document title');
    if(operation.type==='replace-text'&&operation.text===target.text)throw new Error(`Writer proposal contains a no-op replacement for block ${operation.blockId}`);
    const resolvedSourceKeys=change.sourceKeys.map(key=>sourceAliases.get(key)??key);
    for(const key of resolvedSourceKeys)if(!sourceKeys.has(key))throw new Error(`Writer proposal cites an unselected source: ${key}`);
    if(new Set(resolvedSourceKeys).size!==resolvedSourceKeys.length)throw new Error('Writer proposal cites the same source more than once in one change');
    const normalized={...change,operation:{...operation,blockId:target.id},sourceKeys:resolvedSourceKeys} as WriterProposalToolInput['changes'][number];
    normalizedInputs.push(normalized);changes.push({...normalized,id:nanoid(),beforeText:target.text,beforeTag:target.tag});
  }
  for(const insertion of insertions)if(deleted.has(insertion.slice(0,insertion.lastIndexOf(':'))))throw new Error('Writer proposal cannot insert relative to a deleted block');
  return{input:{...parsedInput,changes:normalizedInputs},changes};
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
