import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { pdfQuadSchema, pdfRectSchema, type OcrLanguage, type PdfPage } from '@profread/shared';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { extractVerifiedWorkerBundle } from '../academic/bundle.js';
import { prepareReadingPdf } from '../academic/worker-client.js';
import { fetchArxivPdf } from '../academic/arxiv.js';
import { resolvePublishedSource } from '../academic/published-source.js';
import { enqueuePdfIndex } from './indexer.js';

export const workerPageSchema=z.object({readerPage:z.number().int().positive(),sourcePage:z.number().int().positive(),view:pdfRectSchema,rotation:z.number().int(),
  status:z.enum(['pending','native','ocr','image-only','failed']),text:z.string().max(1_000_000),
  items:z.array(z.object({str:z.string(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),quad:pdfQuadSchema,
    transform:z.array(z.number()).optional(),width:z.number().optional(),height:z.number().optional(),fontName:z.string().optional(),dir:z.string().optional(),hasEOL:z.boolean().optional(),confidence:z.number().optional()})).max(30_000),
  label:z.string().optional(),error:z.string().optional(),transcript:z.string().max(1_000_000).optional(),readingOrder:z.array(z.string()).optional(),ocr:z.object({meanConfidence:z.number()}).passthrough().optional()});
export const workerIndexSchema=z.object({schemaVersion:z.literal(1),sourceHash:z.string(),derivativeHash:z.string(),sourcePageCount:z.number().int().positive(),pageCount:z.number().int().positive(),selectedPageStart:z.number().int().positive(),selectedPageEnd:z.number().int().positive(),coordinateSpace:z.literal('pdf-user-space'),pages:z.array(workerPageSchema).max(100)});
export function mapWorkerPage(page:z.infer<typeof workerPageSchema>):PdfPage{return{page:page.readerPage,sourcePage:page.sourcePage,view:page.view,rotation:page.rotation,text:page.text,textStatus:page.status,items:page.items.map(({str,...item})=>({...item,text:str})),...(page.label?{label:page.label}:{}),...(page.error?{error:page.error}:{}),...(page.transcript!==undefined?{transcript:page.transcript}:{}),...(page.readingOrder?{readingOrder:page.readingOrder}:{}),...(page.ocr?{confidence:page.ocr.meanConfidence}:{})}}
export const hashPdf=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
type PdfImportJob={id:string;source_kind:string;source_path:string;source_name:string;source_hash:string;target_document_id:string|null;pdf_target_version_id:string|null;article_title:string|null;selected_page_start:number|null;selected_page_end:number|null;ocr_language:OcrLanguage};

async function materializeSource(job:PdfImportJob,signal:AbortSignal):Promise<{path:string;hash:string;title:string}>{
  if(job.source_kind==='pdf'){const bytes=await readFile(job.source_path);if(hashPdf(bytes)!==job.source_hash)throw new Error('Source PDF hash changed');return{path:job.source_path,hash:job.source_hash,title:job.article_title??basename(job.source_name).replace(/\.pdf$/i,'')}}
  const locator=(await readFile(job.source_path,'utf8')).trim();
  let bytes:Buffer,title:string;
  if(job.source_kind==='arxiv'){const fetched=await fetchArxivPdf(locator,{signal});bytes=fetched.bytes;title=`arXiv ${fetched.arxivId}`}
  else if(job.source_kind==='url'){const source=await resolvePublishedSource(locator,{signal});if(source.kind!=='pdf')throw new Error('PDF reading requires a direct PDF URL. Use HTML reading for this web page.');bytes=source.bytes;title=source.title}
  else throw new Error('PDF reading supports PDF uploads, direct PDF URLs, and arXiv');
  const path=join(config.dataDir,'imports',job.id,`download-${nanoid(8)}.pdf`);await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,hash:hashPdf(bytes),title};
}

export async function publishPdfImport(jobId:string,signal:AbortSignal){
  const job=row<PdfImportJob>('SELECT * FROM import_jobs WHERE id=?',jobId);if(!job)throw new Error('Import job not found');
  if(job.target_document_id&&!job.pdf_target_version_id&&row<{sanitized_html_path:string|null}>('SELECT sanitized_html_path FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1',job.target_document_id)?.sanitized_html_path){
    throw new Error('A PDF-only re-import cannot replace an HTML article. Use Add PDF view for the retained original, or import a changed PDF as a new article.');
  }
  const source=await materializeSource(job,signal),range=job.selected_page_start&&job.selected_page_end?{pageStart:job.selected_page_start,pageEnd:job.selected_page_end}:undefined;
  const directory=join(config.dataDir,'imports',job.id,`pdf-prepare-${nanoid(8)}`);
  const bundle=await extractVerifiedWorkerBundle(await prepareReadingPdf(source.path,range,signal),directory,source.hash,'pdf-prepare');
  const indexFile=bundle.files.find(file=>file.path==='pdf-index.json'),pdfFile=bundle.files.find(file=>file.path==='reading.pdf');
  if(!indexFile||!pdfFile)throw new Error('Prepared PDF bundle is incomplete');
  const index=workerIndexSchema.parse(JSON.parse(await readFile(indexFile.storagePath,'utf8')));
  if(index.sourceHash!==source.hash||index.derivativeHash!==pdfFile.sha256||index.pages.length!==index.pageCount||index.selectedPageEnd-index.selectedPageStart+1!==index.pageCount||index.pages.some((page,i)=>page.readerPage!==i+1||page.sourcePage!==index.selectedPageStart+i)||index.selectedPageStart!==(range?.pageStart??1)||index.selectedPageEnd!==(range?.pageEnd??index.sourcePageCount)||index.selectedPageEnd>index.sourcePageCount)throw new Error('Prepared PDF source mapping failed verification');
  signal.throwIfAborted();
  const contentHash=hashPdf(Buffer.from(`profread-pdf-v1\0${source.hash}\0${index.selectedPageStart}:${index.selectedPageEnd}\0${job.target_document_id??''}`));
  const target=job.pdf_target_version_id?row<{id:string;document_id:string}>('SELECT id,document_id FROM document_versions WHERE id=?',job.pdf_target_version_id):row<{id:string;document_id:string}>('SELECT id,document_id FROM document_versions WHERE content_hash=?',contentHash);
  if(job.pdf_target_version_id&&!target)throw new Error('Target article version no longer exists');
  const documentId=target?.document_id??job.target_document_id??nanoid(),versionId=target?.id??nanoid();
  const existing=row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'",versionId);
  if(existing){finishImport(jobId,documentId,versionId);return{documentId,versionId,representationId:existing.id,deduplicated:true}}
  const representationId=nanoid(),storage=join(config.dataDir,'pdf',representationId),originalPath=join(storage,'source.pdf'),pdfPath=join(storage,'reading.pdf');
  await mkdir(storage,{recursive:true,mode:0o700});await copyFile(source.path,originalPath,constants.COPYFILE_EXCL);await copyFile(pdfFile.storagePath,pdfPath,constants.COPYFILE_EXCL);await chmod(originalPath,0o444);await chmod(pdfPath,0o444);
  signal.throwIfAborted();const time=now();db.exec('BEGIN IMMEDIATE');
  try{
    if(!target){
      if(!job.target_document_id)db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,source.title,time);
      const next=row<{next:number}>('SELECT COALESCE(MAX(version),0)+1 next FROM document_versions WHERE document_id=?',documentId)!.next;
      db.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,entry_path,sanitized_html_path,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,NULL,NULL,\'\',0,?,?)').run(versionId,documentId,contentHash,job.source_name,next,time);
      db.prepare('INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at)VALUES(\'article\',?,?,?,\'\',\'\',\'\',?)').run(versionId,documentId,source.title,time);
    }
    db.prepare(`INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,ocr_language,created_at,updated_at)
      VALUES(?,?,'pdf','indexing',?,?,?,?,?,?,?,?,?,?)`).run(representationId,versionId,source.hash,originalPath,pdfFile.sha256,pdfPath,index.selectedPageStart,index.selectedPageEnd,index.pageCount,job.ocr_language,time,time);
    for(const page of index.pages)db.prepare('INSERT INTO pdf_page_revisions(representation_id,revision,page,data_json)VALUES(?,0,?,?)').run(representationId,page.readerPage,JSON.stringify(mapWorkerPage(page)));
    db.prepare('INSERT INTO document_view_preferences(document_id,representation_id)VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET representation_id=excluded.representation_id').run(documentId,representationId);
    finishImport(jobId,documentId,versionId);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  enqueuePdfIndex(representationId,index.pages.map(page=>page.readerPage),false,job.ocr_language);
  return{documentId,versionId,representationId,deduplicated:false};
}
function finishImport(jobId:string,documentId:string,versionId:string){const time=now();const result=db.prepare("UPDATE import_jobs SET status='published',stage='published',qa_status='skipped',document_id=?,document_version_id=?,progress=1,error=NULL,updated_at=?,completed_at=? WHERE id=? AND status='converting'").run(documentId,versionId,time,time,jobId);if(!result.changes)throw new Error('PDF import state changed before publication')}
