import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { writerProposalChangeSchema, writerSourceRefSchema, type WriterSourceRef } from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';
import { saveWriterEdits } from '../edits/index.js';
import { currentWriterBasis, writerProposals } from '../models/writer-context.js';
import { beginWriterApply, endWriterApply, isWriterApplying } from '../models/writer-activity.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceRequestSchema=z.union([
  writerSourceRefSchema,
  z.object({sourceType:z.enum(['message','thread-annotation','artifact','highlight']),sourceId:z.string().trim().min(1).max(256)}).transform(value=>({type:value.sourceType,id:value.sourceId})),
]);

type WriterThread={id:string;document_id:string;title:string|null;created_at:string;updated_at:string};
type StoredSource={id:string;thread_id:string;source_type:string;source_id:string;label:string;anchor_id:string|null;snapshot_json:string;snapshot_hash:string;created_at:string};

function writerThread(documentId:string):WriterThread|undefined{return row<WriterThread>("SELECT id,document_id,title,created_at,updated_at FROM threads WHERE document_id=? AND kind='writer'",documentId)}
function assertWriter(threadId:string):WriterThread{
  const writer=row<WriterThread>("SELECT id,document_id,title,created_at,updated_at FROM threads WHERE id=? AND kind='writer' AND anchor_id IS NULL AND parent_message_id IS NULL",threadId);
  if(!writer)throw Object.assign(new Error('Document Writer not found'),{statusCode:404});return writer;
}
function serializeSource(source:StoredSource){return{id:source.id,threadId:source.thread_id,sourceType:source.source_type,sourceId:source.source_id,label:source.label,anchorId:source.anchor_id,snapshot:JSON.parse(source.snapshot_json),snapshotHash:source.snapshot_hash,createdAt:source.created_at}}

async function writerState(documentId:string,threadId:string){
  const writer=assertWriter(threadId);if(writer.document_id!==documentId)throw Object.assign(new Error('Writer does not belong to this document'),{statusCode:400});
  const latest=row<{id:string}>('SELECT id FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1',documentId);if(!latest)throw Object.assign(new Error('Document has no version'),{statusCode:404});
  const basis=await currentWriterBasis(latest.id,threadId),sources=rows<StoredSource>('SELECT * FROM writer_sources WHERE thread_id=? ORDER BY created_at,id',threadId).map(serializeSource);
  const messages=rows<{id:string;role:string;content:string;parent_message_id:string|null;created_at:string}>('SELECT id,role,content,parent_message_id,created_at FROM messages WHERE thread_id=? ORDER BY created_at,id',threadId).map(message=>({id:message.id,role:message.role,content:message.content,parentMessageId:message.parent_message_id,createdAt:message.created_at}));
  const proposals=writerProposals(threadId).map(proposal=>{const reasons:string[]=[];if(proposal.documentVersionId!==basis.documentVersionId)reasons.push('document-version-changed');if(proposal.baseRevision!==basis.revision||proposal.baseHtmlHash!==basis.htmlHash)reasons.push('document-edits-changed');if(proposal.sourceHash!==basis.sourceHash)reasons.push('writer-sources-changed');return{...proposal,freshness:{status:reasons.length?'stale':'current',reasons}}});
  return{thread:{...writer,kind:'writer',messages},sources,proposals,currentDocumentVersionId:basis.documentVersionId,currentRevision:basis.revision};
}

function sourceSnapshot(writer:WriterThread,ref:WriterSourceRef):{label:string;anchorId:string|null;snapshot:unknown}{
  if(ref.type==='message'){
    const value=row<{role:string;content:string;thread_id:string;document_id:string;anchor_id:string|null;exact_quote:string|null}>(`SELECT m.role,m.content,t.id thread_id,t.document_id,t.anchor_id,a.exact_quote FROM messages m JOIN threads t ON t.id=m.thread_id LEFT JOIN anchors a ON a.id=t.anchor_id WHERE m.id=?`,ref.id);
    if(!value)throw Object.assign(new Error('Writer answer source not found'),{statusCode:404});if(value.document_id!==writer.document_id)throw Object.assign(new Error('Writer source belongs to another document'),{statusCode:400});if(value.role!=='assistant')throw Object.assign(new Error('Only assistant answers can be added as message sources'),{statusCode:400});
    return{label:`Answer · ${(value.exact_quote||value.content).replace(/\s+/g,' ').trim().slice(0,120)}`,anchorId:value.anchor_id,snapshot:{type:'message',messageId:ref.id,threadId:value.thread_id,anchorQuote:value.exact_quote,text:value.content}};
  }
  if(ref.type==='thread-annotation'){
    const value=row<{document_id:string;anchor_id:string|null;exact_quote:string|null;annotation_text:string|null}>(`SELECT t.document_id,t.anchor_id,t.annotation_text,a.exact_quote FROM threads t LEFT JOIN anchors a ON a.id=t.anchor_id WHERE t.id=?`,ref.id);
    if(!value)throw Object.assign(new Error('Writer annotation source not found'),{statusCode:404});if(value.document_id!==writer.document_id)throw Object.assign(new Error('Writer source belongs to another document'),{statusCode:400});if(!value.annotation_text?.trim())throw Object.assign(new Error('Save the annotation before adding it to Writer'),{statusCode:409});
    return{label:`Annotation · ${(value.exact_quote||value.annotation_text).replace(/\s+/g,' ').trim().slice(0,120)}`,anchorId:value.anchor_id,snapshot:{type:'thread-annotation',threadId:ref.id,anchorQuote:value.exact_quote,text:value.annotation_text}};
  }
  if(ref.type==='highlight'){
    const value=row<{document_id:string;document_version_id:string;anchor_id:string;kind:string;note:string|null;exact_quote:string}>(`SELECT v.document_id,a.document_version_id,h.anchor_id,h.kind,h.note,a.exact_quote FROM highlights h JOIN anchors a ON a.id=h.anchor_id JOIN document_versions v ON v.id=a.document_version_id WHERE h.id=?`,ref.id);
    if(!value)throw Object.assign(new Error('Writer highlight source not found'),{statusCode:404});if(value.document_id!==writer.document_id)throw Object.assign(new Error('Writer source belongs to another document'),{statusCode:400});
    return{label:`${value.kind} · ${value.exact_quote.replace(/\s+/g,' ').trim().slice(0,120)}`,anchorId:value.anchor_id,snapshot:{type:'highlight',highlightId:ref.id,kind:value.kind,quote:value.exact_quote,note:value.note}};
  }
  const value=row<{document_id:string;kind:string;scope_type:string;scope_id:string;content_json:string;source_refs_json:string}>(`SELECT v.document_id,a.kind,a.scope_type,a.scope_id,a.content_json,a.source_refs_json FROM artifacts a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?`,ref.id);
  if(!value)throw Object.assign(new Error('Writer artifact source not found'),{statusCode:404});if(value.document_id!==writer.document_id)throw Object.assign(new Error('Writer source belongs to another document'),{statusCode:400});
  return{label:`${value.kind} · ${value.scope_type}`,anchorId:value.scope_type==='section'?value.scope_id:null,snapshot:{type:'artifact',artifactId:ref.id,kind:value.kind,scopeType:value.scope_type,scopeId:value.scope_id,content:JSON.parse(value.content_json),sourceRefs:JSON.parse(value.source_refs_json)}};
}

export function registerWriterRoutes(app:FastifyInstance):void{
  app.get('/api/documents/:id/writer',async(request,reply)=>{const documentId=(request.params as{id:string}).id,writer=writerThread(documentId);if(!writer)return reply.code(404).send({error:'Document Writer has not been created'});try{return await writerState(documentId,writer.id)}catch(error){return reply.code((error as any).statusCode??400).send({error:(error as Error).message})}});
  app.post('/api/documents/:id/writer',async(request,reply)=>{const documentId=(request.params as{id:string}).id;if(!row('SELECT id FROM documents WHERE id=?',documentId))return reply.code(404).send({error:'Document not found'});let writer=writerThread(documentId),created=false;if(!writer){const id=nanoid(),time=now();db.exec('BEGIN IMMEDIATE');try{writer=writerThread(documentId);if(!writer){db.prepare("INSERT INTO threads(id,document_id,title,kind,created_at,updated_at)VALUES(?,?,?,'writer',?,?)").run(id,documentId,'Document Writer',time,time);writer=writerThread(documentId);created=true}db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}}return reply.code(created?201:200).send(await writerState(documentId,writer!.id));});
  app.post('/api/writers/:id/sources',async(request,reply)=>{const parsed=sourceRequestSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const writer=assertWriter((request.params as{id:string}).id);if(isWriterApplying(writer.id))return reply.code(409).send({error:'Writer proposal is being applied'});try{const resolved=sourceSnapshot(writer,parsed.data),snapshotJson=JSON.stringify(resolved.snapshot),snapshotHash=hash(snapshotJson),id=nanoid(),time=now();db.prepare(`INSERT OR IGNORE INTO writer_sources(id,thread_id,source_type,source_id,label,anchor_id,snapshot_json,snapshot_hash,created_at)VALUES(?,?,?,?,?,?,?,?,?)`).run(id,writer.id,parsed.data.type,parsed.data.id,resolved.label,resolved.anchorId,snapshotJson,snapshotHash,time);const stored=row<StoredSource>('SELECT * FROM writer_sources WHERE thread_id=? AND source_type=? AND source_id=?',writer.id,parsed.data.type,parsed.data.id)!;return reply.code(stored.id===id?201:200).send(serializeSource(stored))}catch(error){return reply.code((error as any).statusCode??400).send({error:(error as Error).message})}});
  app.delete('/api/writers/:writerId/sources/:sourceId',async(request,reply)=>{const {writerId,sourceId}=request.params as{writerId:string;sourceId:string};assertWriter(writerId);if(isWriterApplying(writerId))return reply.code(409).send({error:'Writer proposal is being applied'});const result=db.prepare('DELETE FROM writer_sources WHERE id=? AND thread_id=?').run(sourceId,writerId);return result.changes?{ok:true}:reply.code(404).send({error:'Writer source not found'})});
  app.post('/api/writer-proposals/:id/apply',async(request,reply)=>{
    const parsed=z.object({changeIds:z.array(z.string().trim().min(1)).min(1).max(200),baseRevision:z.number().int().nonnegative()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    const proposalId=(request.params as{id:string}).id,stored=row<any>('SELECT * FROM writer_proposals WHERE id=?',proposalId);if(!stored)return reply.code(404).send({error:'Writer proposal not found'});
    const existingEdit=row<{revision:number;created_at:string}>("SELECT revision,created_at FROM document_edit_revisions WHERE origin_type='writer-proposal' AND origin_id=?",proposalId);
    if(stored.status==='draft'&&existingEdit){const appliedIds=stored.applied_change_ids_json?JSON.parse(stored.applied_change_ids_json):parsed.data.changeIds,time=now();db.prepare("UPDATE writer_proposals SET status='applied',applied_revision=?,applied_change_ids_json=?,updated_at=?,applied_at=? WHERE id=? AND status='draft'").run(existingEdit.revision,JSON.stringify(appliedIds),time,time,proposalId);return{ok:true,revision:existingEdit.revision,proposalId,appliedChangeIds:appliedIds,reconciled:true}}
    if(stored.status!=='draft')return reply.code(409).send({error:'Writer proposal is no longer a draft'});
    const writer=assertWriter(stored.thread_id);if(!beginWriterApply(writer.id))return reply.code(409).send({error:'Writer proposal is already being applied or generated'});
    try{
      const active=row<{id:string}>("SELECT id FROM model_runs WHERE thread_id=? AND action='document-write' AND status='running'",writer.id);if(active)return reply.code(409).send({error:'Document Writer is still generating a proposal',runId:active.id});
      const latest=row<{id:string}>('SELECT id FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1',writer.document_id);if(!latest||latest.id!==stored.document_version_id)return reply.code(409).send({error:'Writer proposal targets an older document version'});
      const basis=await currentWriterBasis(stored.document_version_id,writer.id);if(parsed.data.baseRevision!==stored.base_revision||basis.revision!==stored.base_revision||basis.htmlHash!==stored.base_html_hash||basis.sourceHash!==stored.source_hash)return reply.code(409).send({error:'Writer proposal is stale; regenerate it from the current document and sources'});
      const changes=z.array(writerProposalChangeSchema).parse(JSON.parse(stored.changes_json)),requested=[...new Set(parsed.data.changeIds)];if(requested.length!==parsed.data.changeIds.length)return reply.code(400).send({error:'Duplicate Writer change IDs are not allowed'});const selected=requested.map(id=>changes.find(change=>change.id===id));if(selected.some(change=>!change))return reply.code(400).send({error:'Writer change selection does not match the stored proposal'});
      const reserved=db.prepare("UPDATE writer_proposals SET applied_change_ids_json=?,updated_at=? WHERE id=? AND status='draft'").run(JSON.stringify(requested),now(),proposalId);if(!reserved.changes)return reply.code(409).send({error:'Writer proposal changed while it was being applied'});
      const saved=await saveWriterEdits(stored.document_version_id,stored.base_revision,selected.map(change=>change!.operation),proposalId),time=now();const result=db.prepare("UPDATE writer_proposals SET status='applied',applied_revision=?,updated_at=?,applied_at=? WHERE id=? AND status='draft'").run(saved.revision,time,time,proposalId);if(!result.changes)return reply.code(409).send({error:'Writer proposal changed while it was being applied'});return{ok:true,revision:saved.revision,proposalId,appliedChangeIds:requested};
    }catch(error){const applied=row<{revision:number}>("SELECT revision FROM document_edit_revisions WHERE origin_type='writer-proposal' AND origin_id=?",proposalId);if(applied){const current=row<{applied_change_ids_json:string|null}>('SELECT applied_change_ids_json FROM writer_proposals WHERE id=?',proposalId),appliedIds=current?.applied_change_ids_json?JSON.parse(current.applied_change_ids_json):parsed.data.changeIds,time=now();db.prepare("UPDATE writer_proposals SET status='applied',applied_revision=?,applied_change_ids_json=?,updated_at=?,applied_at=? WHERE id=? AND status='draft'").run(applied.revision,JSON.stringify(appliedIds),time,time,proposalId);return{ok:true,revision:applied.revision,proposalId,appliedChangeIds:appliedIds,reconciled:true}}db.prepare("UPDATE writer_proposals SET applied_change_ids_json=NULL,updated_at=? WHERE id=? AND status='draft'").run(now(),proposalId);return reply.code((error as any).statusCode??400).send({error:(error as Error).message})}
    finally{endWriterApply(writer.id)}
  });
  app.post('/api/writer-proposals/:id/dismiss',async(request,reply)=>{const id=(request.params as{id:string}).id,proposal=row<{thread_id:string;status:string}>('SELECT thread_id,status FROM writer_proposals WHERE id=?',id);if(!proposal)return reply.code(404).send({error:'Writer proposal not found'});if(isWriterApplying(proposal.thread_id))return reply.code(409).send({error:'Writer proposal is being applied'});if(proposal.status!=='draft')return reply.code(409).send({error:'Writer proposal is not an active draft'});const time=now(),result=db.prepare("UPDATE writer_proposals SET status='dismissed',updated_at=? WHERE id=? AND status='draft'").run(time,id);return result.changes?{ok:true}:reply.code(409).send({error:'Writer proposal changed before it could be dismissed'})});
}
