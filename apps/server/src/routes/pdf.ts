import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ocrLanguageSchema } from '@profread/shared';
import { db, now, row, rows } from '../db/index.js';
import { enqueueAcademicImport } from '../academic/runner.js';
import { hashPdf } from '../pdf/import.js';
import { cancelPdfIndex, enqueuePdfIndex } from '../pdf/indexer.js';
import { pdfManifest, pdfPages, publicRepresentation, representation, retainedPdf } from '../pdf/repository.js';

export function pdfByteRange(header:string|undefined,size:number):{start:number;end:number}|null|undefined{
  if(!header)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))return null;
  let start:number,end:number;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)return null;start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{start,end}:null;
}
export function registerPdfRoutes(app:FastifyInstance):void{
  app.get('/api/representations/:id/manifest',async(request,reply)=>{const result=pdfManifest((request.params as{id:string}).id);return result??reply.code(404).send({error:'PDF representation not found'})});
  app.get('/api/representations/:id/pdf',async(request,reply)=>{
    const source=representation((request.params as{id:string}).id);if(source?.kind!=='pdf'||!source.pdf_path)return reply.code(404).send({error:'PDF not found'});
    const file=await stat(source.pdf_path),etag=`"${source.pdf_hash}"`,range=pdfByteRange(request.headers['if-range']&&request.headers['if-range']!==etag?undefined:request.headers.range,file.size);
    reply.header('content-type','application/pdf').header('content-disposition','inline; filename="profread-article.pdf"').header('accept-ranges','bytes').header('cache-control','private, max-age=31536000, immutable').header('etag',etag);
    if(range===null)return reply.code(416).header('content-range',`bytes */${file.size}`).send();
    if(range)return reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${file.size}`).header('content-length',range.end-range.start+1).send(createReadStream(source.pdf_path,range));
    return reply.header('content-length',file.size).send(createReadStream(source.pdf_path));
  });
  app.get('/api/representations/:id/search',async(request,reply)=>{
    const id=(request.params as{id:string}).id;if(representation(id)?.kind!=='pdf')return reply.code(404).send({error:'PDF not found'});
    const parsed=z.object({q:z.string().trim().min(1).max(500)}).safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'Enter a search query'});
    const query=parsed.data.q.match(/[\p{L}\p{N}]+/gu)?.slice(0,30).map(token=>`"${token}"`).join(' AND ');if(!query)return[];
    return rows<{page:number;excerpt:string}>('SELECT page,snippet(pdf_search_index,2,\'\',\'\',\' … \',30) excerpt FROM pdf_search_index WHERE pdf_search_index MATCH ? AND representation_id=? ORDER BY rank LIMIT 100',query,id);
  });
  app.post('/api/representations/:id/ocr',async(request,reply)=>{
    const id=(request.params as{id:string}).id,source=representation(id);if(source?.kind!=='pdf')return reply.code(404).send({error:'PDF not found'});
    const parsed=z.object({page:z.number().int().positive().optional(),ocrLanguage:ocrLanguageSchema.optional(),force:z.boolean().default(true)}).safeParse(request.body??{});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    const pages=parsed.data.page?[parsed.data.page]:pdfPages(id).filter(page=>parsed.data.force||(['pending','failed'].includes(page.textStatus)||Boolean(page.error))).map(page=>page.page);
    if(!pages.length)return{ok:true,status:source.status};
    return reply.code(202).send(enqueuePdfIndex(id,pages,parsed.data.force,parsed.data.ocrLanguage??source.ocr_language));
  });
  app.post('/api/representations/:id/index/cancel',async(request,reply)=>{const id=(request.params as{id:string}).id;if(representation(id)?.kind!=='pdf')return reply.code(404).send({error:'PDF not found'});cancelPdfIndex(id);return{ok:true}});
  app.post('/api/documents/:id/pdf',async(request,reply)=>{
    const id=(request.params as{id:string}).id,document=row<{version_id:string;title:string}>(`SELECT d.title,v.id version_id FROM documents d JOIN document_versions v ON v.document_id=d.id WHERE d.id=? ORDER BY v.version DESC LIMIT 1`,id);
    if(!document)return reply.code(404).send({error:'Document not found'});
    const existing=row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'",document.version_id);if(existing)return{representation:publicRepresentation(representation(existing.id)!)};
    const active=row<{id:string;status:string}>("SELECT id,status FROM import_jobs WHERE pdf_target_version_id=? AND status IN ('queued','converting')",document.version_id);if(active)return reply.code(202).send({jobId:active.id,status:active.status});
    const parsed=z.object({ocrLanguage:ocrLanguageSchema.default('eng')}).safeParse(request.body??{});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});
    const source=retainedPdf(document.version_id);if(!source)return reply.code(409).send({error:'The original PDF is not retained for this article. Import its PDF as a new article.'});
    const jobId=nanoid(),time=now(),hash=hashPdf(await readFile(source.path));
    // Recheck after filesystem I/O: another request may have attached or queued it.
    const attached=row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'",document.version_id);if(attached)return{representation:publicRepresentation(representation(attached.id)!)};
    const queued=row<{id:string;status:string}>("SELECT id,status FROM import_jobs WHERE pdf_target_version_id=? AND status IN ('queued','converting')",document.version_id);if(queued)return reply.code(202).send({jobId:queued.id,status:queued.status});
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,target_document_id,pdf_target_version_id,
      reading_format,ocr_language,article_title,selected_page_start,selected_page_end,status,stage,ai_review_enabled,created_at,updated_at)
      VALUES(?,'pdf',?,'application/pdf',?,?,?,?,'pdf',?,?,?,?,'queued','queued',0,?,?)`).run(jobId,`${document.title}.pdf`,source.path,hash,id,document.version_id,parsed.data.ocrLanguage,source.pageStart?document.title:null,source.pageStart??null,source.pageEnd??null,time,time);
    enqueueAcademicImport(jobId);return reply.code(202).send({jobId,status:'queued'});
  });
}
