import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { db, now, row, rows } from '../db/index.js';
import { normalizeAssetPath, sanitizeDocument } from '../ingest/sanitize.js';
import { readSafeZip } from '../ingest/zip.js';
import { registerImportJobLifecycle } from '../routes/import-jobs.js';
import { assetMime, extractAcademicBundle, stableAssetId, type AcademicManifest, type ExtractedBundle } from './bundle.js';
import { pdfReferenceEvidence } from './pdf-reference.js';
import { publishAcademicImport, type StagedAcademicResult } from './persistence.js';
import { AcademicWorkerError, convertDocx, convertTex } from './worker-client.js';

type SourceKind='html'|'docx'|'tex'|'tex-zip'|'arxiv';
export interface AcademicJob{ id:string;source_kind:SourceKind;source_name:string;source_mime_type:string;source_path:string;source_hash:string;companion_pdf_path:string|null;entry_path:string|null;status:string;ai_review_enabled:number;max_calls:number;review_concurrency:number;auto_apply:number;source_reference:number }
export interface AcademicReviewContext{job:AcademicJob;bundle:ExtractedBundle;staged:StagedAcademicResult;previewPath:string;signal:AbortSignal}
export interface AcademicReviewOutcome{status:'completed'|'partial'|'failed';callCount:number}
type ReviewHook=(context:AcademicReviewContext)=>Promise<AcademicReviewOutcome>;
type SourceHook=(job:AcademicJob,directory:string,signal:AbortSignal)=>Promise<ExtractedBundle>;

let reviewHook:ReviewHook|undefined;
const sourceHooks=new Map<SourceKind,SourceHook>(),queued=new Set<string>(),controllers=new Map<string,AbortController>();
let draining=false,started=false;

export function registerAcademicReviewHook(hook:ReviewHook):void{reviewHook=hook}
export function registerAcademicSourceHook(kind:SourceKind,hook:SourceHook):void{sourceHooks.set(kind,hook)}

class AcademicEntryRequiredError extends Error{constructor(readonly entryChoices:string[]){super('Choose an article entry before conversion can continue')}}

function stage(jobId:string,id:string,label:string,status:'pending'|'running'|'completed'|'failed',progress:number,message?:string):void{
  const current=row<{stages_json:string}>('SELECT stages_json FROM import_jobs WHERE id=?',jobId),items:(Array<Record<string,unknown>>)=current?JSON.parse(current.stages_json):[],index=items.findIndex(item=>item.id===id),value={id,key:id,stage:id,label,status,...(message?{message}:{})};
  if(index>=0)items[index]=value;else items.push(value);
  db.prepare("UPDATE import_jobs SET stage=?,progress=?,stages_json=?,updated_at=? WHERE id=? AND status='converting'").run(id,progress,JSON.stringify(items),now(),jobId);
}
function derivativeHash(bundle:ExtractedBundle,publishable:ExtractedBundle['files']):string{
  const entry=bundle.files.find(file=>file.path===bundle.entryPath);if(!entry)throw new Error('Converted HTML entry is missing');
  const content=[entry,...publishable].map(file=>`${file.path}\0${file.sha256}`).sort();
  return createHash('sha256').update(['academic-v1',...content].join('\0')).digest('hex');
}

async function reachableAssets(bundle:ExtractedBundle,source:string):Promise<ExtractedBundle['files']>{
  const qaOnly=/^(?:reference|renders|objects|provenance)\//i,available=new Map(bundle.files.filter(file=>!qaOnly.test(file.path)&&assetMime(file.path)).map(file=>[file.path,file])),selected=new Set<string>(),cssQueue:string[]=[];
  const add=(base:string,value:string|undefined)=>{if(!value)return;const path=normalizeAssetPath(base,value),file=path?available.get(path):undefined;if(!file||selected.has(file.path))return;selected.add(file.path);if(assetMime(file.path)==='text/css')cssQueue.push(file.path)};
  const addCssUrls=(css:string,base:string)=>{for(const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))add(base,match[2])};
  const entryBase=bundle.entryPath.includes('/')?bundle.entryPath.slice(0,bundle.entryPath.lastIndexOf('/')):'',$=cheerio.load(source);
  $('link[rel~="stylesheet"][href]').each((_index,element)=>add(entryBase,$(element).attr('href')));
  $('img[src],source[src]').each((_index,element)=>add(entryBase,$(element).attr('src')));
  $('style').each((_index,element)=>addCssUrls($(element).html()??'',entryBase));
  $('[style]').each((_index,element)=>addCssUrls($(element).attr('style')??'',entryBase));
  while(cssQueue.length){const path=cssQueue.shift()!,file=available.get(path)!;addCssUrls(await readFile(file.storagePath,'utf8'),path.includes('/')?path.slice(0,path.lastIndexOf('/')):'')}
  return bundle.files.filter(file=>selected.has(file.path));
}

async function htmlBundle(job:AcademicJob,directory:string):Promise<ExtractedBundle>{
  await mkdir(directory,{recursive:true,mode:0o700});const entryPath='document.html',storagePath=join(directory,entryPath);await copyFile(job.source_path,storagePath);
  const content=await readFile(storagePath),bytes=content.byteLength;if(bytes>config.limits.htmlBytes)throw new Error('HTML source exceeds the HTML size limit');const sha256=createHash('sha256').update(content).digest('hex');
  const manifest:ExtractedBundle['manifest']={schemaVersion:1,operation:'convert',source:{kind:'html',sha256:job.source_hash},output:{entryPath},converter:{selected:'identity-html'},warnings:[],files:[{path:entryPath,bytes,sha256}]};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return{directory,entryPath,manifest,files:[{path:entryPath,storagePath,bytes,sha256},{path:'manifest.json',storagePath:join(directory,'manifest.json'),bytes:0,sha256:''}]};
}
async function htmlZipBundle(job:AcademicJob,directory:string):Promise<ExtractedBundle>{
  const archive=await readSafeZip(await readFile(job.source_path));if(!archive.htmlEntries.length)throw new Error('ZIP does not contain an HTML entry');archive.htmlEntries.sort();
  if(!job.entry_path&&archive.htmlEntries.length>1)throw new AcademicEntryRequiredError(archive.htmlEntries);
  const entryPath=job.entry_path??archive.htmlEntries[0]!;if(!archive.htmlEntries.includes(entryPath))throw new Error('Selected entry is not an HTML file in this ZIP');
  const files:ExtractedBundle['files']=[];await mkdir(directory,{recursive:true,mode:0o700});
  for(const [path,content] of archive.files){const storagePath=join(directory,path);await mkdir(dirname(storagePath),{recursive:true,mode:0o700});await writeFile(storagePath,content,{mode:0o600,flag:'wx'});files.push({path,storagePath,bytes:content.byteLength,sha256:createHash('sha256').update(content).digest('hex')})}
  const entry=files.find(file=>file.path===entryPath)!;if(entry.bytes>config.limits.htmlBytes)throw new Error('HTML source exceeds the HTML size limit');
  const manifest:ExtractedBundle['manifest']={schemaVersion:1,operation:'convert',source:{kind:'html-zip',sha256:job.source_hash},output:{entryPath},converter:{selected:'identity-html-zip'},warnings:[],files:files.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  const manifestPath=join(directory,'manifest.json'),manifestContent=Buffer.from(JSON.stringify(manifest,null,2));await writeFile(manifestPath,manifestContent,{mode:0o600,flag:'wx'});files.push({path:'manifest.json',storagePath:manifestPath,bytes:manifestContent.byteLength,sha256:createHash('sha256').update(manifestContent).digest('hex')});return{directory,entryPath,manifest,files};
}
async function convert(job:AcademicJob,directory:string,signal:AbortSignal):Promise<ExtractedBundle>{
  const hook=sourceHooks.get(job.source_kind);if(hook)return hook(job,directory,signal);
  if(job.source_kind==='html')return extname(job.source_name).toLowerCase()==='.zip'||job.source_mime_type==='application/zip'?htmlZipBundle(job,directory):htmlBundle(job,directory);
  if(job.source_kind==='docx'){const archive=await convertDocx(job.source_path,job.source_name,Boolean(job.ai_review_enabled&&job.source_reference),signal);return extractAcademicBundle(archive,directory,job.source_hash)}
  if(job.source_kind==='tex'||job.source_kind==='tex-zip'){const archive=await convertTex(job.source_path,job.source_name,job.entry_path??undefined,signal);return extractAcademicBundle(archive,directory,job.source_hash)}
  throw new Error(`No converter is registered for ${job.source_kind}`);
}
async function attachCompanionReference(job:AcademicJob,bundle:ExtractedBundle,directory:string,signal:AbortSignal):Promise<ExtractedBundle>{
  if(!job.ai_review_enabled||!job.source_reference||!job.companion_pdf_path||!['tex','tex-zip'].includes(job.source_kind))return bundle;
  try{
    const reference=await pdfReferenceEvidence(job.companion_pdf_path,directory,signal);
    bundle.files.push(...reference.files);bundle.manifest.warnings.push(...reference.warnings);
  }catch(error){
    bundle.manifest.warnings.push({code:'companion_reference_failed',severity:'warning',message:`The companion PDF could not be rendered for visual comparison: ${error instanceof Error?error.message:String(error)}`});
  }
  return bundle;
}
function insertWarnings(jobId:string,warnings:AcademicManifest['warnings']):void{
  db.prepare("DELETE FROM import_findings WHERE import_job_id=? AND source='deterministic'").run(jobId);const insert=db.prepare('INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,repair_json,confidence,decision,model_run_id,created_at,updated_at)VALUES(?,?,\'deterministic\',?,?,?,?,?, ?,NULL,NULL,\'pending\',NULL,?,?)'),time=now();
  for(const warning of warnings)insert.run(nanoid(),jobId,warning.code,warning.severity,warning.code.replaceAll('_',' '),warning.message,null,JSON.stringify(warning.evidence?[warning.evidence]:[]),time,time);
}
async function prepare(job:AcademicJob,bundle:ExtractedBundle):Promise<{staged:StagedAcademicResult;previewPath:string}>{
  const source=await readFile(join(bundle.directory,bundle.entryPath),'utf8'),publishable=await reachableAssets(bundle,source),assets=publishable.map(file=>({id:stableAssetId(file.path),sourcePath:file.path,mimeType:assetMime(file.path)!,storagePath:file.storagePath,bytes:file.bytes,sha256:file.sha256})),byPath=new Map(assets.map(asset=>[asset.sourcePath,asset.id]));
  const parsed=sanitizeDocument(source,bundle.entryPath,path=>byPath.has(path)?`/api/import-jobs/${job.id}/assets/${byPath.get(path)}`:null),previewPath=join(config.dataDir,'imports',job.id,'preview.html');
  await writeFile(previewPath,parsed.html,{mode:0o600});
  const staged:StagedAcademicResult={entryPath:bundle.entryPath,bundleDirectory:bundle.directory,derivativeHash:derivativeHash(bundle,publishable),manifest:bundle.manifest,assets};
  return{staged,previewPath};
}
async function run(jobId:string):Promise<void>{
  const claimed=db.prepare("UPDATE import_jobs SET status='converting',stage='converting',progress=0.05,error=NULL,cancel_requested=0,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='queued'").run(now(),now(),jobId);if(!claimed.changes)return;
  const job=row<AcademicJob>('SELECT id,source_kind,source_name,source_mime_type,source_path,source_hash,companion_pdf_path,entry_path,status,ai_review_enabled,max_calls,review_concurrency,auto_apply,source_reference FROM import_jobs WHERE id=?',jobId)!,
    controller=new AbortController(),bundleDirectory=join(config.dataDir,'imports',jobId,`bundle-${nanoid(8)}`);controllers.set(jobId,controller);
  try{
    stage(jobId,'conversion','Convert and inventory source','running',0.15);const bundle=await attachCompanionReference(job,await convert(job,bundleDirectory,controller.signal),bundleDirectory,controller.signal);
    stage(jobId,'conversion','Convert and inventory source','completed',0.55);stage(jobId,'deterministic-review','Validate and normalize output','running',0.65);
    const {staged,previewPath}=await prepare(job,bundle),warnings=bundle.manifest.warnings??[];insertWarnings(jobId,warnings);
    db.prepare('UPDATE import_jobs SET result_json=?,warnings_json=?,provenance_json=?,updated_at=? WHERE id=?').run(JSON.stringify(staged),JSON.stringify(warnings),JSON.stringify({source:bundle.manifest.source,converter:bundle.manifest.converter??null,inventory:bundle.manifest.inventory??null}),now(),jobId);
    stage(jobId,'deterministic-review','Validate and normalize output','completed',0.78);
    if(job.ai_review_enabled&&reviewHook){stage(jobId,'model-review','Model-assisted visual and semantic review','running',0.82);db.prepare("UPDATE import_jobs SET qa_status='running',updated_at=? WHERE id=?").run(now(),jobId);try{const outcome=await reviewHook({job,bundle,staged,previewPath,signal:controller.signal});if(controller.signal.aborted)throw new Error('Academic import was cancelled');db.prepare('UPDATE import_jobs SET qa_status=?,call_count=?,updated_at=? WHERE id=?').run(outcome.status,outcome.callCount,now(),jobId);stage(jobId,'model-review','Model-assisted visual and semantic review',outcome.status==='failed'?'failed':'completed',0.94)}catch(error){if(controller.signal.aborted)throw error;db.prepare("UPDATE import_jobs SET qa_status='failed',updated_at=? WHERE id=?").run(now(),jobId);stage(jobId,'model-review','Model-assisted visual and semantic review','failed',0.94,error instanceof Error?error.message:'Model review failed')}}
    else if(job.ai_review_enabled)db.prepare("UPDATE import_jobs SET qa_status='not-run',updated_at=? WHERE id=?").run(now(),jobId);
    if(controller.signal.aborted)throw new Error('Academic import was cancelled');
    stage(jobId,'review','Ready for reader review','completed',1);db.prepare("UPDATE import_jobs SET status='review-ready',stage='review',progress=1,error=NULL,updated_at=? WHERE id=? AND status='converting'").run(now(),jobId);
  }catch(error){const cancelled=controller.signal.aborted||row<{status:string}>('SELECT status FROM import_jobs WHERE id=?',jobId)?.status==='cancelled',entryChoices=error instanceof AcademicEntryRequiredError?error.entryChoices:error instanceof AcademicWorkerError&&error.code==='entry_required'?error.entryChoices:undefined;if(!cancelled){const time=now();if(entryChoices?.length)db.prepare("UPDATE import_jobs SET status='failed',stage='entry-selection',progress=0,entry_choices_json=?,error=?,updated_at=?,completed_at=? WHERE id=?").run(JSON.stringify(entryChoices),error instanceof Error?error.message:'Choose a project entry',time,time,jobId);else db.prepare("UPDATE import_jobs SET status='failed',stage='failed',progress=0,error=?,updated_at=?,completed_at=? WHERE id=?").run(error instanceof Error?error.message:String(error),time,time,jobId)}await rm(bundleDirectory,{recursive:true,force:true}).catch(()=>{})}
  finally{controllers.delete(jobId)}
}
async function drain():Promise<void>{if(draining)return;draining=true;try{while(queued.size){const id=queued.values().next().value as string;queued.delete(id);await run(id)}}finally{draining=false;if(queued.size)void drain()}}
export function enqueueAcademicImport(jobId:string):void{queued.add(jobId);setImmediate(()=>void drain())}
export function cancelAcademicImport(jobId:string):void{controllers.get(jobId)?.abort()}
export async function finalizeAcademicImport(jobId:string){const claimed=db.prepare("UPDATE import_jobs SET status='finalizing',stage='finalizing',error=NULL,updated_at=? WHERE id=? AND status='review-ready'").run(now(),jobId);if(!claimed.changes)throw Object.assign(new Error('Import is not ready to publish'),{statusCode:409});try{return await publishAcademicImport(jobId)}catch(error){db.prepare("UPDATE import_jobs SET status='review-ready',stage='publish-failed',error=?,updated_at=? WHERE id=? AND status='finalizing'").run(error instanceof Error?error.message:String(error),now(),jobId);throw error}}
export function startAcademicImportRunner():void{if(started)return;started=true;registerImportJobLifecycle({enqueue:enqueueAcademicImport,cancel:cancelAcademicImport,finalize:finalizeAcademicImport});for(const item of rows<{id:string}>("SELECT id FROM import_jobs WHERE status='queued' ORDER BY created_at"))enqueueAcademicImport(item.id)}
