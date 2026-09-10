import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, now, row } from '../db/index.js';
import { importSource } from './index.js';
import { createPdfAnchor, documentRepresentations, savePdfPages } from '../pdf/repository.js';
import { resolvePdfRunSource } from '../pdf/runs.js';

process.env.OPENAI_API_KEY='test-html-republication-key';
const app=await buildApp();let headers:Record<string,string>={};
beforeAll(async()=>{const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.4.23',payload:{password:'test-owner-password'}});headers={cookie:login.cookies.map(value=>`${value.name}=${value.value}`).join('; '),'x-csrf-token':login.cookies.find(value=>value.name==='profread_csrf')!.value};});
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(async()=>new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:'The reattached HTML source remains available.'})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{id:randomUUID(),status:'completed',usage:{input_tokens:20,output_tokens:10}}})}\n\n`,{status:200}))));
afterAll(async()=>{vi.unstubAllGlobals();delete process.env.OPENAI_API_KEY;await app.close();});
async function thread(documentId:string,extra:Record<string,string>){const response=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId,...extra}});expect(response.statusCode,response.body).toBe(201);return response.json().id as string;}
async function child(documentId:string,parent:string,extra:Record<string,string>={}){const message=await app.inject({method:'POST',url:`/api/threads/${parent}/messages`,headers,payload:{role:'assistant',content:'Earlier source discussion.'}});expect(message.statusCode).toBe(201);return thread(documentId,{parentMessageId:message.json().id,...extra});}
async function waitJob(id:string){for(let attempt=0;attempt<300;attempt++){const job=row<{status:string;error:string|null}>('SELECT status,error FROM import_jobs WHERE id=?',id)!;if(job.status==='review-ready')return;if(job.status==='failed')throw new Error(job.error??'Academic HTML import failed');await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('HTML import did not reach review-ready');}
async function academicImport(documentId:string,html:string){
  const boundary=`profread-${randomUUID()}`,fields={sourceKind:'upload',documentId,aiReview:JSON.stringify({enabled:false})};
  const body=Buffer.from(Object.entries(fields).map(([key,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')+`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reimport.html"\r\nContent-Type: text/html\r\n\r\n${html}\r\n--${boundary}--\r\n`);
  const created=await app.inject({method:'POST',url:'/api/import-jobs',headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`},payload:body});expect(created.statusCode,created.body).toBe(202);await waitJob(created.json().jobId);
  const published=await app.inject({method:'POST',url:`/api/import-jobs/${created.json().jobId}/finalize`,headers});expect(published.statusCode,published.body).toBe(200);return published.json() as{documentId:string;versionId:string};
}

describe('HTML republication discussion source associations',()=>{
  it.each(['direct','academic'] as const)('moves HTML source associations atomically during %s publication but leaves PDF branches unchanged',async mode=>{
    const original=await importSource({buffer:Buffer.from(`<title>HTML association ${randomUUID()}</title><p>Stable theorem statement.</p><p>Original ending.</p>`),filename:'original.html',mimeType:'text/html'}),documentId=original.documentId!,versionId=original.versionId!,htmlId=`html-${versionId}`;
    const block=row<{id:string;text_content:string}>('SELECT id,text_content FROM blocks WHERE document_version_id=? AND text_content=?',versionId,'Stable theorem statement.')!;
    const anchored=await app.inject({method:'POST',url:'/api/anchors',headers,payload:{documentVersionId:versionId,selector:{blockId:block.id,blockType:'text',exact:block.text_content,prefix:'',suffix:'',startOffset:0,endOffset:block.text_content.length}}});expect(anchored.statusCode,anchored.body).toBe(201);
    const oldAnchor=anchored.json().id as string,root=await thread(documentId,{anchorId:oldAnchor,representationId:htmlId}),nested=await child(documentId,root),grandchild=await child(documentId,nested),legacyRoot=await thread(documentId,{});
    db.prepare('UPDATE threads SET representation_id=NULL WHERE id IN (?,?)').run(grandchild,legacyRoot);
    const legacyChild=await child(documentId,legacyRoot);db.prepare('UPDATE threads SET representation_id=NULL WHERE id=?').run(legacyChild);
    db.prepare('INSERT INTO document_view_preferences(document_id,representation_id)VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET representation_id=excluded.representation_id').run(documentId,htmlId);
    const pdfId=randomUUID(),time=now(),hash='a'.repeat(64);
    db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,pdf_hash,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','ready',?,?,22,22,1,?,?)").run(pdfId,versionId,hash,hash,time,time);
    const revision=savePdfPages(pdfId,[{page:1,sourcePage:22,view:[0,0,600,800],rotation:0,text:'',textStatus:'image-only',items:[]}]);
    const pdfAnchor=createPdfAnchor(versionId,{kind:'pdf-region',representationId:pdfId,sourceHash:hash,extractionRevision:revision,exact:'',segments:[{page:1,quads:[[20,700,100,700,100,600,20,600]]}]}),pdfRoot=await thread(documentId,{anchorId:pdfAnchor.id,representationId:pdfId}),pdfChild=await child(documentId,pdfRoot);
    const oldPdfAnchor=row('SELECT * FROM anchors WHERE id=?',pdfAnchor.id),oldPdfRoot=row('SELECT * FROM threads WHERE id=?',pdfRoot),oldPdfChild=row('SELECT * FROM threads WHERE id=?',pdfChild);
    const html=`<title>HTML association updated ${randomUUID()}</title><p>New introductory paragraph.</p><p>Stable theorem statement.</p><p>Changed ending.</p>`;
    const next=mode==='direct'?await importSource({documentId,buffer:Buffer.from(html),filename:'updated.html',mimeType:'text/html'}):await academicImport(documentId,html),nextVersionId=next.versionId!,nextHtml=`html-${nextVersionId}`;
    const moved=row<{anchor_id:string;representation_id:string}>('SELECT anchor_id,representation_id FROM threads WHERE id=?',root)!;
    expect(moved.anchor_id).not.toBe(oldAnchor);expect(moved.representation_id).toBe(nextHtml);
    expect(row('SELECT document_version_id,representation_id,migrated_from_id,status FROM anchors WHERE id=?',moved.anchor_id)).toEqual({document_version_id:nextVersionId,representation_id:nextHtml,migrated_from_id:oldAnchor,status:'attached'});
    for(const id of[root,nested,grandchild,legacyRoot,legacyChild]){
      expect(row<{representation_id:string}>('SELECT representation_id FROM threads WHERE id=?',id)?.representation_id).toBe(nextHtml);
      expect(resolvePdfRunSource({documentVersionId:nextVersionId,representationId:nextHtml,threadId:id})).toBeUndefined();
    }
    expect(documentRepresentations(documentId,nextVersionId).preferredRepresentationId).toBe(nextHtml);
    expect(row('SELECT * FROM anchors WHERE id=?',pdfAnchor.id)).toEqual(oldPdfAnchor);expect(row('SELECT * FROM threads WHERE id=?',pdfRoot)).toEqual(oldPdfRoot);expect(row('SELECT * FROM threads WHERE id=?',pdfChild)).toEqual(oldPdfChild);
    expect(row<{representation_id:string}>('SELECT representation_id FROM anchors WHERE id=?',oldAnchor)?.representation_id).toBe(htmlId);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const continued=await child(documentId,grandchild);expect(row<{representation_id:string}>('SELECT representation_id FROM threads WHERE id=?',continued)?.representation_id).toBe(nextHtml);
    for(const [id,anchorId] of[[root,moved.anchor_id],[grandchild,undefined]] as const){
      const run=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:nextVersionId,representationId:nextHtml,threadId:id,...(anchorId?{anchorId}:{}),action:'ask',input:'Explain the stable theorem.',modelOverride:'gpt-5.6-sol'}});
      expect(run.statusCode,run.body).toBe(200);expect(run.body).toContain('event: done');expect(run.body).not.toContain('event: error');
    }
  });
});
