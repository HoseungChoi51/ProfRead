import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { visualRecapSchema, diagramSpecSchema } from '@afterdraft/shared';
import { db, now, row, rows } from '../db/index.js';

const artifactSchema=z.object({documentVersionId:z.string().trim().min(1),kind:z.enum(['tldr','half-page','compact','visual-recap','diagram']),scopeType:z.enum(['document','section','answer','thread']),scopeId:z.string().trim().min(1),content:z.unknown(),sourceRefs:z.array(z.string()).min(1),promoted:z.boolean().default(false)});
const singletonKinds=new Set(['tldr','half-page','visual-recap']);
const basisKinds=new Set(['tldr','half-page','visual-recap']);

export type SummaryBasis={documentVersionId:string;revision:number;signalHash:string};
type Freshness={status:'current'|'needs-review'|'unknown';reasons:string[]};
type StoredArtifact={
  id:string;document_version_id:string;kind:string;version:number;scope_type:string;scope_id:string;
  content_json:string;source_refs_json:string;promoted:number;created_at:string;
  basis_document_version_id:string|null;basis_revision:number|null;basis_signal_hash:string|null;
};
type ArtifactInput=z.infer<typeof artifactSchema>;
type ScopeError={status:400|404;error:string};

function validateArtifactScope(input:ArtifactInput,documentId:string):ScopeError|undefined{
  if(input.scopeType==='document')return input.scopeId===documentId?undefined:{status:400,error:'Document artifact scope does not match its document version'};
  if(input.scopeType==='section'){
    const anchor=row<{document_version_id:string}>('SELECT document_version_id FROM anchors WHERE id=?',input.scopeId);
    if(!anchor)return{status:404,error:'Section artifact anchor not found'};
    if(anchor.document_version_id!==input.documentVersionId)return{status:400,error:'Section artifact scope does not belong to the supplied document version'};
    return;
  }
  if(input.scopeType==='thread'){
    const thread=row<{document_id:string}>('SELECT document_id FROM threads WHERE id=?',input.scopeId);
    if(!thread)return{status:404,error:'Thread artifact scope not found'};
    if(thread.document_id!==documentId)return{status:400,error:'Thread artifact scope does not belong to the supplied document'};
    return;
  }
  const answer=row<{document_id:string}>('SELECT t.document_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?',input.scopeId);
  if(!answer)return{status:404,error:'Answer artifact message not found'};
  if(answer.document_id!==documentId)return{status:400,error:'Answer artifact scope does not belong to the supplied document'};
}

function validateContent(kind:string,content:unknown){
  if(kind==='visual-recap')return visualRecapSchema.parse(content);
  if(kind==='diagram')return diagramSpecSchema.parse(content);
  if(typeof content!=='string')throw new Error('Text artifact content must be a string');
  const words=content.trim().split(/\s+/).filter(Boolean).length;
  if(kind==='tldr'&&(words>150||(content.match(/^\s*[-*]/gm)??[]).length>5))throw new Error('TL;DR must contain at most five bullets and 150 words');
  if(kind==='half-page'&&(words<300||words>450))throw new Error('Half-page summary must contain 300 to 450 words');
  return content;
}

export function summaryBasis(documentVersionId:string):SummaryBasis{
  if(!row('SELECT id FROM document_versions WHERE id=?',documentVersionId))throw new Error('Document version not found');
  const revision=row<{revision:number}>('SELECT COALESCE(MAX(revision),0) revision FROM document_edit_revisions WHERE document_version_id=?',documentVersionId)?.revision??0;
  const signals=rows<{id:string;kind:string;exact_quote:string;note:string|null}>(`SELECT h.id,h.kind,a.exact_quote,h.note FROM highlights h JOIN anchors a ON a.id=h.anchor_id WHERE a.document_version_id=? AND h.kind IN ('important','comment') ORDER BY h.id`,documentVersionId).map(signal=>({id:signal.id,kind:signal.kind,exactQuote:signal.exact_quote,note:signal.note?.trim()||null}));
  const signalHash=createHash('sha256').update(JSON.stringify(signals)).digest('hex');
  return{documentVersionId,revision,signalHash};
}

function latestVersion(documentId:string):{id:string}|undefined{
  return row<{id:string}>('SELECT id FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1',documentId);
}

function freshness(artifact:StoredArtifact,current:SummaryBasis):Freshness{
  if(artifact.basis_document_version_id===null||artifact.basis_revision===null||artifact.basis_signal_hash===null)return{status:'unknown',reasons:['missing-basis']};
  const reasons:string[]=[];
  if(artifact.basis_document_version_id!==current.documentVersionId)reasons.push('document-version-changed');
  if(artifact.basis_revision!==current.revision)reasons.push('document-edits-changed');
  if(artifact.basis_signal_hash!==current.signalHash)reasons.push('reader-signals-changed');
  return{status:reasons.length?'needs-review':'current',reasons};
}

function serializeArtifact(artifact:StoredArtifact,currentBasis:SummaryBasis|undefined){
  const tracksBasis=artifact.scope_type==='document'&&basisKinds.has(artifact.kind);
  return{
    ...artifact,
    content:JSON.parse(artifact.content_json),
    sourceRefs:JSON.parse(artifact.source_refs_json),
    promoted:Boolean(artifact.promoted),
    ...(tracksBasis&&currentBasis?{freshness:freshness(artifact,currentBasis)}:{}),
  };
}

export function registerKnowledgeRoutes(app:FastifyInstance):void{
  app.get('/api/documents/:id/artifacts',async(request,reply)=>{
    const documentId=(request.params as{id:string}).id,currentVersion=latestVersion(documentId);
    if(!currentVersion)return reply.code(404).send({error:'Document not found'});
    const currentBasis=summaryBasis(currentVersion.id);
    return rows<StoredArtifact>(`SELECT a.* FROM artifacts a JOIN document_versions v ON v.id=a.document_version_id WHERE v.document_id=? AND (a.kind NOT IN ('tldr','half-page','visual-recap') OR a.version=(SELECT MAX(newer.version) FROM artifacts newer WHERE newer.kind=a.kind AND newer.scope_type=a.scope_type AND newer.scope_id=a.scope_id)) ORDER BY a.created_at DESC`,documentId).map(artifact=>serializeArtifact(artifact,currentBasis));
  });

  app.post('/api/artifacts',async(request,reply)=>{
    const parsed=artifactSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    const version=row<{document_id:string}>('SELECT document_id FROM document_versions WHERE id=?',parsed.data.documentVersionId);
    if(!version)return reply.code(404).send({error:'Document version not found'});
    const scopeError=validateArtifactScope(parsed.data,version.document_id);
    if(scopeError)return reply.code(scopeError.status).send({error:scopeError.error});
    let content;
    try{content=validateContent(parsed.data.kind,parsed.data.content)}catch(error){return reply.code(422).send({error:(error as Error).message})}
    const basis=parsed.data.scopeType==='document'&&basisKinds.has(parsed.data.kind)?summaryBasis(parsed.data.documentVersionId):undefined;
    const time=now(),existing=singletonKinds.has(parsed.data.kind)?row<{id:string;version:number}>('SELECT id,version FROM artifacts WHERE kind=? AND scope_type=? AND scope_id=? ORDER BY version DESC LIMIT 1',parsed.data.kind,parsed.data.scopeType,parsed.data.scopeId):undefined;
    const artifactVersion=existing?.version??(row<{next:number}>('SELECT COALESCE(MAX(version),0)+1 next FROM artifacts WHERE kind=? AND scope_type=? AND scope_id=?',parsed.data.kind,parsed.data.scopeType,parsed.data.scopeId)?.next??1),id=existing?.id??nanoid();
    if(existing)db.prepare('UPDATE artifacts SET document_version_id=?,content_json=?,source_refs_json=?,promoted=?,basis_document_version_id=?,basis_revision=?,basis_signal_hash=?,created_at=? WHERE id=?').run(parsed.data.documentVersionId,JSON.stringify(content),JSON.stringify(parsed.data.sourceRefs),parsed.data.promoted?1:0,basis?.documentVersionId??null,basis?.revision??null,basis?.signalHash??null,time,id);
    else db.prepare('INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,basis_document_version_id,basis_revision,basis_signal_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,parsed.data.documentVersionId,parsed.data.kind,artifactVersion,parsed.data.scopeType,parsed.data.scopeId,JSON.stringify(content),JSON.stringify(parsed.data.sourceRefs),parsed.data.promoted?1:0,basis?.documentVersionId??null,basis?.revision??null,basis?.signalHash??null,time);
    if(existing)db.prepare("DELETE FROM search_index WHERE kind='artifact' AND entity_id=?").run(id);
    db.prepare('INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run('artifact',id,version.document_id,parsed.data.kind,typeof content==='string'?content:JSON.stringify(content),'','',time);
    return reply.code(existing?200:201).send({id,version:artifactVersion,...parsed.data,content,createdAt:time,...(basis?{basis}:{}),...(basis?{freshness:{status:'current',reasons:[]}}:{})});
  });

  app.post('/api/artifacts/:id/accept-current-basis',async(request,reply)=>{
    const artifact=row<Pick<StoredArtifact,'id'|'kind'|'scope_type'|'scope_id'>>('SELECT id,kind,scope_type,scope_id FROM artifacts WHERE id=?',(request.params as{id:string}).id);
    if(!artifact)return reply.code(404).send({error:'Artifact not found'});
    if(artifact.scope_type!=='document'||!basisKinds.has(artifact.kind))return reply.code(409).send({error:'Artifact does not support freshness tracking'});
    const currentVersion=latestVersion(artifact.scope_id);
    if(!currentVersion)return reply.code(404).send({error:'Artifact document not found'});
    const basis=summaryBasis(currentVersion.id);
    db.prepare('UPDATE artifacts SET document_version_id=?,basis_document_version_id=?,basis_revision=?,basis_signal_hash=? WHERE id=?').run(currentVersion.id,basis.documentVersionId,basis.revision,basis.signalHash,artifact.id);
    return{ok:true,basis,freshness:{status:'current',reasons:[]} as Freshness};
  });

  app.patch('/api/artifacts/:id/promote',async(request,reply)=>{const parsed=z.object({promoted:z.boolean()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const result=db.prepare('UPDATE artifacts SET promoted=? WHERE id=?').run(parsed.data.promoted?1:0,(request.params as{id:string}).id);return result.changes?{ok:true}:reply.code(404).send({error:'Artifact not found'});});
  app.get('/api/anchors/repair',async()=>rows(`SELECT a.*,d.id document_id,d.title FROM anchors a JOIN document_versions v ON v.id=a.document_version_id JOIN documents d ON d.id=v.document_id WHERE a.status='unmatched' ORDER BY a.created_at DESC`));
  app.post('/api/anchors/:id/repair',async(request,reply)=>{const parsed=z.object({blockId:z.string(),startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),exactQuote:z.string()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const anchorId=(request.params as{id:string}).id,block=row<{start_offset:number}>('SELECT b.start_offset FROM blocks b JOIN anchors a ON a.document_version_id=b.document_version_id WHERE a.id=? AND b.id=?',anchorId,parsed.data.blockId);if(!block)return reply.code(404).send({error:'Target block not found'});const result=db.prepare("UPDATE anchors SET block_id=?,start_offset=?,end_offset=?,exact_quote=?,status='attached' WHERE id=?").run(parsed.data.blockId,block.start_offset+parsed.data.startOffset,block.start_offset+parsed.data.endOffset,parsed.data.exactQuote,anchorId);return result.changes?{ok:true}:reply.code(404).send({error:'Anchor not found'});});
  app.get('/api/search',async(request,reply)=>{const q=request.query as Record<string,string|undefined>;if(!q.q?.trim())return reply.code(400).send({error:'Search query is required'});const filters:string[]=['search_index MATCH ?'];const params:any[]=[q.q];for(const [key,column] of [['document','document_id'],['type','kind'],['model','model_id']] as const)if(q[key]){filters.push(`${column}=?`);params.push(q[key])}if(q.tag){filters.push('tags LIKE ?');params.push(`%${q.tag}%`)}if(q.from){filters.push('created_at>=?');params.push(q.from)}if(q.to){filters.push('created_at<=?');params.push(q.to)}return rows(`SELECT kind,entity_id,document_id,title,snippet(search_index,4,'<mark>','</mark>','…',24) snippet,tags,model_id,created_at FROM search_index WHERE ${filters.join(' AND ')} ORDER BY rank LIMIT 100`,...params)});
}
