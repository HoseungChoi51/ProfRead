import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db, now, row, rows } from '../db/index.js';
import { ensureHtmlRepresentation, presentAnchoredItem, representation } from '../pdf/repository.js';

const optionalId=z.preprocess(value=>typeof value==='string'&&!value.trim()?undefined:value,z.string().trim().min(1).optional());
const annotationText=z.string().max(1000).refine(
  value=>Array.from(value).length<=500,
  'Annotation text must contain at most 500 Unicode characters',
);

export function registerThreadRoutes(app: FastifyInstance): void {
  app.get('/api/documents/:id/threads', async request => rows<any>(`SELECT t.*,COALESCE(t.representation_id,a.representation_id) representation_id,a.selector_json,a.block_id,a.exact_quote,a.prefix_text,a.suffix_text,a.status,a.block_type,a.start_offset-b.start_offset local_start_offset,a.end_offset-b.start_offset local_end_offset,
    (SELECT r.action FROM model_runs r WHERE r.thread_id=t.id ORDER BY r.created_at LIMIT 1) action,
    (SELECT json_group_array(json_object('id',m.id,'role',m.role,'content',m.content,'parentMessageId',m.parent_message_id,'createdAt',m.created_at,'modelRunId',m.model_run_id)) FROM messages m WHERE m.thread_id=t.id ORDER BY m.created_at) messages
    FROM threads t LEFT JOIN anchors a ON a.id=t.anchor_id LEFT JOIN blocks b ON b.document_version_id=a.document_version_id AND b.id=a.block_id WHERE t.document_id=? ORDER BY t.created_at`,(request.params as {id:string}).id).map(item=>{
      const messages=(JSON.parse(item.messages??'[]') as Array<{modelRunId?:string}>).map(message=>({...message,sourceCitations:message.modelRunId?rows<{id:string;label:string;selector_json:string}>('SELECT evidence_id id,label,selector_json FROM source_citations WHERE model_run_id=?',message.modelRunId).map(citation=>({id:citation.id,label:citation.label,selector:JSON.parse(citation.selector_json)})):[]}));
      return{...presentAnchoredItem(item),messages:JSON.stringify(messages)};
    }));
  app.post('/api/threads', async (request,reply)=>{
    const parsed=z.object({documentId:z.string().trim().min(1),anchorId:optionalId,parentMessageId:optionalId,representationId:optionalId,title:z.string().max(240).optional()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    const document=row<{latest_version_id:string|null}>(`SELECT (SELECT v.id FROM document_versions v WHERE v.document_id=d.id ORDER BY v.version DESC LIMIT 1) latest_version_id FROM documents d WHERE d.id=?`,parsed.data.documentId);
    if(!document)return reply.code(404).send({error:'Document not found'});
    if(parsed.data.anchorId){
      const anchor=row<{document_version_id:string;document_id:string;selector_json:string|null}>('SELECT a.document_version_id,v.document_id,a.selector_json FROM anchors a JOIN document_versions v ON v.id=a.document_version_id WHERE a.id=?',parsed.data.anchorId);
      if(!anchor)return reply.code(404).send({error:'Anchor not found'});
      if(anchor.document_id!==parsed.data.documentId)return reply.code(400).send({error:'Anchor does not belong to the supplied document'});
      if(anchor.document_version_id!==document.latest_version_id&&!anchor.selector_json)return reply.code(400).send({error:'Anchor does not belong to the current document version'});
    }
    if(parsed.data.parentMessageId){
      const parent=row<{document_id:string}>('SELECT t.document_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?',parsed.data.parentMessageId);
      if(!parent)return reply.code(404).send({error:'Parent message not found'});
      if(parent.document_id!==parsed.data.documentId)return reply.code(400).send({error:'Parent message does not belong to the supplied document'});
    }
    ensureHtmlRepresentation(document.latest_version_id!);
    const anchorView=parsed.data.anchorId?row<{representation_id:string|null}>('SELECT representation_id FROM anchors WHERE id=?',parsed.data.anchorId)?.representation_id:undefined;
    const parentView=parsed.data.parentMessageId?row<{representation_id:string|null}>('SELECT t.representation_id FROM threads t JOIN messages m ON m.thread_id=t.id WHERE m.id=?',parsed.data.parentMessageId)?.representation_id:undefined;
    const defaultView=row<{id:string}>('SELECT id FROM document_representations WHERE document_version_id=? ORDER BY kind LIMIT 1',document.latest_version_id!)?.id;
    const viewId=anchorView??parentView??parsed.data.representationId??defaultView,view=viewId?representation(viewId):undefined;
    const viewDocument=view?row<{document_id:string}>('SELECT document_id FROM document_versions WHERE id=?',view.document_version_id):undefined;
    if(!view||viewDocument?.document_id!==parsed.data.documentId||(view.kind==='html'&&view.document_version_id!==document.latest_version_id)||parsed.data.representationId&&parsed.data.representationId!==viewId||anchorView&&parentView&&anchorView!==parentView)return reply.code(400).send({error:'Discussion source does not match its article, anchor, or parent'});
    const id=nanoid(),time=now();db.prepare('INSERT INTO threads (id,document_id,anchor_id,parent_message_id,title,representation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,parsed.data.documentId,parsed.data.anchorId??null,parsed.data.parentMessageId??null,parsed.data.title??null,viewId!,time,time);return reply.code(201).send({id,...parsed.data,representationId:viewId,representation:view.kind,createdAt:time,messages:[]});
  });
  app.patch('/api/threads/:id/annotation',async(request,reply)=>{const parsed=z.object({text:annotationText.nullable().optional(),annotationText:annotationText.nullable().optional()}).refine(value=>value.text!==undefined||value.annotationText!==undefined,'Annotation text is required').safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const id=(request.params as{id:string}).id,text=(parsed.data.text??parsed.data.annotationText)?.trim()||null,time=now(),result=db.prepare(`UPDATE threads SET annotation_text=?,annotation_candidate_status=CASE WHEN ? IS NOT NULL THEN 'accepted' WHEN annotation_candidate_text IS NOT NULL THEN 'pending' ELSE NULL END,updated_at=? WHERE id=?`).run(text,text,time,id);return result.changes?{ok:true,text,annotationText:text,candidateStatus:text?'accepted':'pending',updatedAt:time}:reply.code(404).send({error:'Thread not found'});});
  app.post('/api/threads/:id/annotation-candidate/dismiss',async(request,reply)=>{const id=(request.params as{id:string}).id,time=now(),thread=row<{annotation_candidate_text:string|null;annotation_candidate_status:string|null;annotation_text:string|null}>('SELECT annotation_candidate_text,annotation_candidate_status,annotation_text FROM threads WHERE id=?',id);if(!thread?.annotation_candidate_text)return reply.code(404).send({error:'Annotation candidate not found'});if(thread.annotation_text?.trim()||thread.annotation_candidate_status!=='pending')return reply.code(409).send({error:'Only a pending unsaved annotation candidate can be dismissed'});db.prepare("UPDATE threads SET annotation_candidate_status='dismissed',updated_at=? WHERE id=?").run(time,id);return{ok:true,status:'dismissed',updatedAt:time};});
  app.post('/api/threads/:id/messages', async (request,reply)=>{const parsed=z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(100000),parentMessageId:z.string().optional()}).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});const threadId=(request.params as {id:string}).id;if(!row('SELECT id FROM threads WHERE id=?',threadId))return reply.code(404).send({error:'Thread not found'});const id=nanoid(),time=now();db.prepare('INSERT INTO messages (id,thread_id,parent_message_id,role,content,created_at) VALUES (?,?,?,?,?,?)').run(id,threadId,parsed.data.parentMessageId??null,parsed.data.role,parsed.data.content,time);db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(time,threadId);if(parsed.data.role==='assistant')db.prepare(`INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at) SELECT 'answer',?,document_id,'',?,'','',? FROM threads WHERE id=?`).run(id,parsed.data.content,time,threadId);return reply.code(201).send({id,threadId,...parsed.data,createdAt:time});});
}
