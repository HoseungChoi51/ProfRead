import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { OcrLanguage } from '@profread/shared';
import { config } from '../config.js';
import { db, now, row, rows } from '../db/index.js';
import { extractVerifiedWorkerBundle } from '../academic/bundle.js';
import { indexReadingPdf } from '../academic/worker-client.js';
import { mapWorkerPage, workerIndexSchema } from './import.js';
import { pdfPages, representation, savePdfPages } from './repository.js';

type IndexJob={id:string;representation_id:string;pages_json:string;completed_json:string;force_ocr:number;language:OcrLanguage;status:string};
let draining=false,stopping=false;
const controllers=new Map<string,AbortController>();
export function enqueuePdfIndex(id:string,pages:number[],force=false,language:OcrLanguage='eng'):{jobId:string}{
  const current=representation(id);if(current?.kind!=='pdf')throw Object.assign(new Error('PDF representation not found'),{statusCode:404});
  if(!pages.length||pages.some(page=>!Number.isInteger(page)||page<1||page>(current.page_count??0)))throw Object.assign(new Error('Invalid PDF indexing pages'),{statusCode:400});
  const active=row<{id:string}>("SELECT id FROM pdf_index_jobs WHERE representation_id=? AND status IN ('queued','running')",id);
  if(active){if(force)throw Object.assign(new Error('Wait for current PDF indexing or cancel it first'),{statusCode:409});return{jobId:active.id}}
  const jobId=nanoid(),time=now();db.prepare('INSERT INTO pdf_index_jobs(id,representation_id,pages_json,force_ocr,language,created_at,updated_at)VALUES(?,?,?,?,?,?,?)').run(jobId,id,JSON.stringify([...new Set(pages)].sort((a,b)=>a-b)),force?1:0,language,time,time);
  db.prepare("UPDATE document_representations SET status='indexing',ocr_language=?,error=NULL,updated_at=? WHERE id=?").run(language,time,id);
  setImmediate(()=>void drain());return{jobId};
}
async function run(job:IndexJob):Promise<void>{
  const source=representation(job.representation_id);if(!source?.pdf_path||!source.pdf_hash){db.prepare("UPDATE pdf_index_jobs SET status='failed',error='PDF source is missing',updated_at=? WHERE id=?").run(now(),job.id);return;}
  const controller=new AbortController();controllers.set(job.id,controller);
  db.prepare("UPDATE pdf_index_jobs SET status='running',updated_at=? WHERE id=?").run(now(),job.id);
  const requested=JSON.parse(job.pages_json) as number[],completed=new Set(JSON.parse(job.completed_json) as number[]);
  try{
    const sourceBytes=await readFile(source.pdf_path);if(createHash('sha256').update(sourceBytes).digest('hex')!==source.pdf_hash)throw new Error('Stored PDF source hash changed');
    for(const pageNumber of requested){
      if(completed.has(pageNumber))continue;controller.signal.throwIfAborted();
      const before=pdfPages(source.id).find(page=>page.page===pageNumber);if(!before)throw new Error('PDF page mapping is missing');
      try{
        const bytes=await indexReadingPdf(source.pdf_path,{sourcePageStart:source.source_page_start??1,pageStart:pageNumber,pageEnd:pageNumber,ocr:job.force_ocr?'force':'auto',language:job.language},controller.signal);
        const bundle=await extractVerifiedWorkerBundle(bytes,join(config.dataDir,'pdf',source.id,'index',`${job.id}-${pageNumber}-${nanoid(6)}`),source.pdf_hash,'pdf-index');
        const file=bundle.files.find(item=>item.path==='pdf-index.json');if(!file)throw new Error('Worker omitted PDF page index');
        const index=workerIndexSchema.parse(JSON.parse(await readFile(file.storagePath,'utf8'))),page=index.pages[0];
        if(index.derivativeHash!==source.pdf_hash||index.pages.length!==1||!page||page.readerPage!==pageNumber||page.sourcePage!==before.sourcePage||JSON.stringify(page.view)!==JSON.stringify(before.view)||page.rotation!==before.rotation)throw new Error('Worker PDF page evidence does not match the saved source');
        controller.signal.throwIfAborted();savePdfPages(source.id,[{...mapWorkerPage(page),...(before.label?{label:before.label}:{})}]);
      }catch(error){if(controller.signal.aborted)throw error;savePdfPages(source.id,[{...before,textStatus:'failed',error:error instanceof Error?error.message:String(error)}]);}
      completed.add(pageNumber);db.prepare('UPDATE pdf_index_jobs SET completed_json=?,updated_at=? WHERE id=?').run(JSON.stringify([...completed]),now(),job.id);
    }
    const pages=pdfPages(source.id),failed=pages.some(page=>page.textStatus==='failed'||page.textStatus==='pending'||Boolean(page.error)),time=now();
    db.prepare("UPDATE pdf_index_jobs SET status=?,updated_at=? WHERE id=?").run(failed?'partial':'completed',time,job.id);
    db.prepare('UPDATE document_representations SET status=?,updated_at=? WHERE id=?').run(failed?'partial':'ready',time,source.id);
    const html=row("SELECT id FROM document_representations WHERE document_version_id=? AND kind='html'",source.document_version_id);
    if(!html){const transcript=pages.map(page=>page.transcript??page.text).join('\n');db.prepare("UPDATE search_index SET body=? WHERE entity_id=? AND kind='article'").run(transcript,source.document_version_id);db.prepare('UPDATE document_versions SET token_estimate=? WHERE id=?').run(Math.ceil(transcript.length/4),source.document_version_id);}
  }catch(error){const status=controller.signal.aborted?(stopping?'queued':'cancelled'):'failed',message=error instanceof Error?error.message:String(error);db.prepare('UPDATE pdf_index_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(status,message,now(),job.id);db.prepare('UPDATE document_representations SET status=?,error=?,updated_at=? WHERE id=?').run(stopping?'indexing':status,message,now(),source.id);}
  finally{controllers.delete(job.id)}
}
async function drain(){if(draining||stopping)return;draining=true;try{for(;;){if(stopping)break;const job=row<IndexJob>("SELECT * FROM pdf_index_jobs WHERE status='queued' ORDER BY created_at LIMIT 1");if(!job)break;await run(job)}}finally{draining=false}}
export function cancelPdfIndex(representationId:string):void{
  for(const job of rows<{id:string}>("SELECT id FROM pdf_index_jobs WHERE representation_id=? AND status IN ('queued','running')",representationId)){controllers.get(job.id)?.abort(new Error('PDF indexing cancelled'));db.prepare("UPDATE pdf_index_jobs SET status='cancelled',updated_at=? WHERE id=?").run(now(),job.id)}
  db.prepare("UPDATE document_representations SET status='cancelled',updated_at=? WHERE id=?").run(now(),representationId);
}
export function startPdfIndexer():void{
  stopping=false;db.prepare("UPDATE pdf_index_jobs SET status='queued' WHERE status='running'").run();
  // Recover the small publication→enqueue crash window as well as interrupted
  // page jobs. Existing revisions and completed-page checkpoints stay intact.
  for(const source of rows<{id:string;ocr_language:OcrLanguage}>("SELECT id,ocr_language FROM document_representations r WHERE kind='pdf' AND status='indexing' AND NOT EXISTS(SELECT 1 FROM pdf_index_jobs j WHERE j.representation_id=r.id AND j.status IN ('queued','running'))")){
    const pending=pdfPages(source.id).filter(page=>page.textStatus==='pending').map(page=>page.page);
    if(pending.length)enqueuePdfIndex(source.id,pending,false,source.ocr_language);
    else db.prepare("UPDATE document_representations SET status='partial' WHERE id=?").run(source.id);
  }
  setImmediate(()=>void drain());
}
export function stopPdfIndexer():void{stopping=true;for(const controller of controllers.values())controller.abort(new Error('Service stopping; indexing will resume'))}
