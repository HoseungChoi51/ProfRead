import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfManifest } from '@profread/shared';

const worker=vi.hoisted(()=>({prepare:vi.fn(),index:vi.fn(),inspect:vi.fn(),url:vi.fn(),arxiv:vi.fn()}));
vi.mock('../academic/worker-client.js',async original=>({...await original<typeof import('../academic/worker-client.js')>(),prepareReadingPdf:worker.prepare,indexReadingPdf:worker.index,inspectPdf:worker.inspect}));
vi.mock('../academic/published-source.js',async original=>({...await original<typeof import('../academic/published-source.js')>(),resolvePublishedSource:worker.url}));
vi.mock('../academic/arxiv.js',async original=>({...await original<typeof import('../academic/arxiv.js')>(),fetchArxivPdf:worker.arxiv}));

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { startPdfIndexer, stopPdfIndexer } from './indexer.js';
import { pdfPages, representation } from './repository.js';

const app=await buildApp();
let headers:Record<string,string>={};
beforeAll(async()=>{const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.3.21',payload:{password:'test-owner-password'}});headers={cookie:login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),'x-csrf-token':login.cookies.find(item=>item.name==='profread_csrf')!.value};});
afterAll(()=>app.close());
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const pdf=()=>Buffer.from(`%PDF-1.7\nIsolated ingestion fixture ${randomUUID()}\n%%EOF`);
const sourcePages=5;

function bundle(operation:string,sourceHash:string,files:Record<string,Uint8Array>):Buffer{
  const manifest={schemaVersion:1,operation,source:{kind:'pdf',sha256:sourceHash},warnings:[],files:Object.entries(files).map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  return Buffer.from(zipSync({...files,'manifest.json':strToU8(JSON.stringify(manifest))},{level:0}));
}
function page(readerPage:number,sourcePage:number,status='pending'){
  const text=status==='native'?`Mathematics evidence on source page ${sourcePage}.`:'';
  return{readerPage,sourcePage,view:[0,0,500,700],width:500,height:700,rotation:0,status,text,transcript:text,readingOrder:text?['item-0']:[],items:text?[{id:'item-0',itemIndex:0,str:text,start:0,end:text.length,quad:[20,680,450,680,450,660,20,660]}]:[]};
}
async function prepare(path:string,range?:{pageStart:number;pageEnd:number}){
  const source=await readFile(path),start=range?.pageStart??1,end=range?.pageEnd??sourcePages,reading=Buffer.from(`%PDF-1.7\nDerivative ${hash(source)} pages ${start}-${end}\n%%EOF`);
  const index={schemaVersion:1,sourceHash:hash(source),derivativeHash:hash(reading),sourcePageCount:sourcePages,pageCount:end-start+1,selectedPageStart:start,selectedPageEnd:end,coordinateSpace:'pdf-user-space',pages:Array.from({length:end-start+1},(_,i)=>page(i+1,start+i))};
  return bundle('pdf-prepare',hash(source),{'reading.pdf':reading,'pdf-index.json':strToU8(JSON.stringify(index))});
}
type IndexOptions={pageStart:number;pageEnd:number;sourcePageStart:number;ocr:string;language:string};
async function index(path:string,options:IndexOptions){
  const source=await readFile(path),sourceHash=hash(source),total=Number(source.toString().match(/pages (\d+)-(\d+)/)?.[2]??sourcePages)-options.sourcePageStart+1;
  return bundle('pdf-index',sourceHash,{'pdf-index.json':strToU8(JSON.stringify({schemaVersion:1,sourceHash,derivativeHash:sourceHash,sourcePageCount:total,pageCount:total,selectedPageStart:1,selectedPageEnd:total,coordinateSpace:'pdf-user-space',pages:[page(options.pageStart,options.sourcePageStart+options.pageStart-1,'native')]}))});
}
beforeEach(()=>{
  vi.clearAllMocks();worker.prepare.mockImplementation(prepare);worker.index.mockImplementation(index);
  worker.inspect.mockImplementation(async(path:string,_filename:string,title:string)=>{
    const pages=Array.from({length:sourcePages},(_,i)=>({page:i+1,textLength:100,excerpt:'Target article',titleCoverage:1,thumbnailPath:`pages/page-${String(i+1).padStart(3,'0')}.jpg`}));
    const files:Record<string,Uint8Array>={'inspection.json':strToU8(JSON.stringify({schemaVersion:1,title,pageCount:sourcePages,pages,suggestion:{startPage:2,endPage:3,confidence:'high',source:'local',rationale:'Local title match',evidencePages:[2,3]}}))};
    for(const item of pages)files[item.thumbnailPath]=Buffer.from([0xff,0xd8,0xff,0xd9]);
    return bundle('inspect',hash(await readFile(path)),files);
  });
});
async function eventually<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,label:string):Promise<T>{
  for(let i=0;i<400;i++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(`Timed out waiting for ${label}`);
}
type Job={id:string;status:string;error:string|null;document_id:string;document_version_id:string};
async function waitJob(id:string,status='published'){
  return eventually(()=>{const job=row<Job>('SELECT * FROM import_jobs WHERE id=?',id)!;if(job.status==='failed'&&status!=='failed')throw new Error(job.error??'Import failed');return job;},job=>job.status===status,`import ${status}`);
}
function multipart(fields:Record<string,string>,source?:Buffer){
  const boundary=`profread-test-${randomUUID()}`,parts:Buffer[]=Object.entries(fields).map(([key,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  if(source)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),source,Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));return{payload:Buffer.concat(parts),headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`}};
}
async function upload(source=pdf(),fields:Record<string,string>={}){
  const response=await app.inject({method:'POST',url:'/api/import-jobs',...multipart({sourceKind:'pdf',readingFormat:'pdf',aiReview:JSON.stringify({enabled:false}),...fields},fields.sourceKind&&fields.sourceKind!=='pdf'?undefined:source)});
  expect(response.statusCode,response.body).toBe(202);return{jobId:response.json().jobId as string,source};
}
function pdfFor(job:Job){return row<{id:string}>("SELECT id FROM document_representations WHERE document_version_id=? AND kind='pdf'",job.document_version_id)!.id;}
async function waitPdf(id:string,status='ready'){await eventually(()=>representation(id),value=>value?.status===status,`PDF ${status}`);}
async function manifest(id:string){const response=await app.inject({method:'GET',url:`/api/representations/${id}/manifest`,headers});expect(response.statusCode,response.body).toBe(200);return response.json<PdfManifest>();}
function gatePage(target:number){
  let started=false;
  worker.index.mockImplementation(async(path:string,options:IndexOptions,signal:AbortSignal)=>{
    if(options.pageStart!==target)return index(path,options);started=true;
    return new Promise<Buffer>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  });return()=>eventually(()=>started,Boolean,`page ${target} started`);
}

describe('PDF HTTP ingestion and checkpoint lifecycle',()=>{
  it('waits for explicit magazine confirmation, publishes without HTML, and keeps the scoped immutable PDF after staging cleanup',async()=>{
    const uploadResult=await upload(pdf(),{articleSelection:JSON.stringify({title:'Selected mathematics article',aiBoundary:false})});
    await waitJob(uploadResult.jobId,'awaiting-selection');expect(worker.prepare).not.toHaveBeenCalled();
    const detail=await app.inject({method:'GET',url:`/api/import-jobs/${uploadResult.jobId}`,headers});expect(detail.json()).toMatchObject({readingFormat:'pdf',articleSelection:{pageCount:5},aiReview:{enabled:false}});
    const confirmed=await app.inject({method:'POST',url:`/api/import-jobs/${uploadResult.jobId}/article-selection`,headers,payload:{startPage:2,endPage:3}});expect(confirmed.statusCode,confirmed.body).toBe(200);
    const job=await waitJob(uploadResult.jobId),id=pdfFor(job);await waitPdf(id);
    expect(worker.prepare.mock.calls[0]?.[1]).toEqual({pageStart:2,pageEnd:3});
    expect(row('SELECT sanitized_html_path,entry_path FROM document_versions WHERE id=?',job.document_version_id)).toEqual({sanitized_html_path:null,entry_path:null});
    const saved=representation(id)!,before=await manifest(id);expect(before.pages.map(item=>item.sourcePage)).toEqual([2,3]);expect(before.pages.map(item=>item.textStatus)).toEqual(['native','native']);
    expect(await readFile(saved.source_path!)).toEqual(uploadResult.source);expect(saved.source_hash).toBe(hash(uploadResult.source));
    const reading=await readFile(saved.pdf_path!);expect(hash(reading)).toBe(saved.pdf_hash);
    const staging=join(config.dataDir,'imports',uploadResult.jobId);expect(saved.source_path!.startsWith(staging)).toBe(false);await rm(staging,{recursive:true});
    const served=await app.inject({method:'GET',url:`/api/representations/${id}/pdf`,headers:{...headers,range:'bytes=0-7'}});expect(served.statusCode).toBe(206);expect(served.rawPayload).toEqual(reading.subarray(0,8));
    expect(await readFile(saved.source_path!)).toEqual(uploadResult.source);
    const search=await app.inject({method:'GET',url:`/api/representations/${id}/search?q=mathematics`,headers});expect(search.json().map((item:{page:number})=>item.page).sort()).toEqual([1,2]);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM model_runs')!.count).toBe(0);
  });

  it('attaches one idempotent PDF view to a retained HTML source without replacing the HTML version',async()=>{
    const imported=await importSource({buffer:Buffer.from(`<title>Coexisting ${randomUUID()}</title><p>Keep this exact HTML article.</p>`),filename:'article.html',mimeType:'text/html'});
    const version=row<{sanitized_html_path:string;content_hash:string}>('SELECT sanitized_html_path,content_hash FROM document_versions WHERE id=?',imported.versionId)!,originalHtml=await readFile(version.sanitized_html_path),source=pdf(),retained=join(dirname(version.sanitized_html_path),'source.pdf');await mkdir(dirname(retained),{recursive:true});await chmod(dirname(retained),0o700);await writeFile(retained,source);await chmod(dirname(retained),0o555);
    const endpoint=`/api/documents/${imported.documentId}/pdf`,[first,second]=await Promise.all([app.inject({method:'POST',url:endpoint,headers,payload:{ocrLanguage:'eng+kor'}}),app.inject({method:'POST',url:endpoint,headers,payload:{ocrLanguage:'eng+kor'}})]);expect(first.statusCode,first.body).toBe(202);
    expect([200,202]).toContain(second.statusCode);if(second.statusCode===202)expect(second.json().jobId).toBe(first.json().jobId);
    const job=await waitJob(first.json().jobId),id=pdfFor(job);await waitPdf(id);expect(job.document_version_id).toBe(imported.versionId);
    const third=await app.inject({method:'POST',url:endpoint,headers,payload:{}});expect(third.statusCode,third.body).toBe(200);expect(third.json().representation.id).toBe(id);expect(worker.prepare).toHaveBeenCalledTimes(1);
    expect(await readFile(version.sanitized_html_path)).toEqual(originalHtml);expect(await readFile(retained)).toEqual(source);expect(representation(id)?.ocr_language).toBe('eng+kor');
    expect(row<{count:number}>('SELECT COUNT(*) count FROM document_versions WHERE document_id=?',imported.documentId)!.count).toBe(1);
    const document=await app.inject({method:'GET',url:`/api/documents/${imported.documentId}`,headers});expect(document.json().representations.map((item:{kind:string})=>item.kind).sort()).toEqual(['html','pdf']);
  });

  it.each(['url','arxiv'] as const)('retains actual downloaded %s PDF bytes, not the locator file',async kind=>{
    const source=pdf(),url='https://example.org/isolated-paper.pdf';
    worker.url.mockResolvedValue({kind:'pdf',bytes:source,title:'Downloaded mathematics',filename:'paper.pdf'});
    worker.arxiv.mockResolvedValue({arxivId:'2501.01234',sourceUrl:'https://arxiv.org/pdf/2501.01234',bytes:source});
    const created=await upload(source,{sourceKind:kind,...(kind==='url'?{sourceUrl:url}:{arxiv:'2501.01234'})}),job=await waitJob(created.jobId),id=pdfFor(job);await waitPdf(id);
    const saved=representation(id)!;expect(await readFile(saved.source_path!)).toEqual(source);expect(saved.source_hash).toBe(hash(source));
    expect(worker.prepare).toHaveBeenCalledOnce();expect(worker.prepare.mock.calls[0]?.[0]).toMatch(/download-.*\.pdf$/);
  });

  it('publishes pending pages before indexing, keeps completed pages on cancellation, and retries only incomplete pages',async()=>{
    const started=gatePage(2),created=await upload(),job=await waitJob(created.jobId),id=pdfFor(job);await started();
    expect((await manifest(id)).pages.map(item=>item.textStatus)).toEqual(['native','pending','pending','pending','pending']);
    const cancelled=await app.inject({method:'POST',url:`/api/representations/${id}/index/cancel`,headers});expect(cancelled.statusCode).toBe(200);await waitPdf(id,'cancelled');
    await eventually(()=>row<{status:string}>("SELECT status FROM pdf_index_jobs WHERE representation_id=? ORDER BY created_at DESC LIMIT 1",id)?.status,status=>status==='cancelled','cancelled index');
    worker.index.mockImplementation(index);
    const retried=await app.inject({method:'POST',url:`/api/representations/${id}/ocr`,headers,payload:{force:false}});expect(retried.statusCode,retried.body).toBe(202);await waitPdf(id);
    expect(worker.index.mock.calls.filter(([,options])=>options.pageStart===1)).toHaveLength(1);expect(pdfPages(id).every(item=>item.textStatus==='native')).toBe(true);
  });

  it('resumes a stopped index job from its persisted completed-page checkpoint',async()=>{
    const started=gatePage(2),created=await upload(),job=await waitJob(created.jobId),id=pdfFor(job);await started();stopPdfIndexer();
    const checkpoint=await eventually(()=>row<{id:string;status:string;completed_json:string}>('SELECT id,status,completed_json FROM pdf_index_jobs WHERE representation_id=?',id)!,value=>value.status==='queued','queued checkpoint');
    expect(JSON.parse(checkpoint.completed_json)).toEqual([1]);worker.index.mockImplementation(index);startPdfIndexer();await waitPdf(id);
    expect(worker.index.mock.calls.filter(([,options])=>options.pageStart===1)).toHaveLength(1);expect(row<{status:string}>('SELECT status FROM pdf_index_jobs WHERE id=?',checkpoint.id)?.status).toBe('completed');
  });

  it('marks a worker page failure as partial and retries that page without discarding successful revisions',async()=>{
    worker.index.mockImplementation(async(path:string,options:IndexOptions)=>{if(options.pageStart===3)throw new Error('Test OCR timeout');return index(path,options);});
    const created=await upload(),job=await waitJob(created.jobId),id=pdfFor(job);await waitPdf(id,'partial');
    const before=pdfPages(id);expect(before[2]).toMatchObject({textStatus:'failed',error:'Test OCR timeout'});expect(before.filter(item=>item.textStatus==='native')).toHaveLength(4);
    worker.index.mockImplementation(index);const retry=await app.inject({method:'POST',url:`/api/representations/${id}/ocr`,headers,payload:{force:false}});expect(retry.statusCode).toBe(202);await waitPdf(id);
    expect(worker.index.mock.calls.filter(([,options])=>options.pageStart===3)).toHaveLength(2);expect(worker.index.mock.calls.filter(([,options])=>options.pageStart!==3)).toHaveLength(4);expect(pdfPages(id)[0]).toEqual(before[0]);
  });

  it('rejects a source-mismatched preparation bundle without publishing a document',async()=>{
    const other=pdf();worker.prepare.mockImplementation(async()=>bundle('pdf-prepare',hash(other),{'reading.pdf':other,'pdf-index.json':strToU8('{}')}));
    const before=row<{count:number}>('SELECT COUNT(*) count FROM documents')!.count,created=await upload(),job=await waitJob(created.jobId,'failed');expect(job.error).toMatch(/source hash/);expect(row<{count:number}>('SELECT COUNT(*) count FROM documents')!.count).toBe(before);
  });

  it('rejects a verified derivative whose page range differs from the user-confirmed selection',async()=>{
    worker.prepare.mockImplementation((path:string)=>prepare(path,{pageStart:1,pageEnd:2}));
    const created=await upload(pdf(),{articleSelection:JSON.stringify({title:'Confirmed article boundaries',aiBoundary:false})});await waitJob(created.jobId,'awaiting-selection');
    const confirmed=await app.inject({method:'POST',url:`/api/import-jobs/${created.jobId}/article-selection`,headers,payload:{startPage:2,endPage:3}});expect(confirmed.statusCode).toBe(200);
    const outcome=await eventually(()=>row<Job>('SELECT * FROM import_jobs WHERE id=?',created.jobId)!,job=>['failed','published'].includes(job.status),'range verification');
    expect(outcome.status,outcome.error??'Published a derivative outside the confirmed article range').toBe('failed');
  });

  it('fails once before worker execution when retained reading bytes change and preserves previous extraction revisions',async()=>{
    const created=await upload(),job=await waitJob(created.jobId),id=pdfFor(job);await waitPdf(id);
    const saved=representation(id)!,revision=saved.extraction_revision,before=pdfPages(id),path=saved.pdf_path!;
    await chmod(path,0o600);await writeFile(path,pdf());worker.index.mockClear();
    const retried=await app.inject({method:'POST',url:`/api/representations/${id}/ocr`,headers,payload:{page:1,force:true}});expect(retried.statusCode,retried.body).toBe(202);await waitPdf(id,'failed');
    expect(worker.index).not.toHaveBeenCalled();expect(representation(id)?.error).toMatch(/source hash changed/);expect(representation(id)?.extraction_revision).toBe(revision);expect(pdfPages(id)).toEqual(before);
    expect(row<{status:string}>('SELECT status FROM pdf_index_jobs WHERE id=?',retried.json().jobId)?.status).toBe('failed');
  });
});
