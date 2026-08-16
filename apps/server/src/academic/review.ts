import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { runImportAudit, type ImportAuditRequest, type ImportAuditResult } from '../models/import-audit.js';
import { extractRenderBundle, type ExtractedBundleFile } from './bundle.js';
import { academicOutline, visibleAcademicText, writeSelfContainedPreview, type AcademicOutlineItem } from './evidence.js';
import { automaticImportRepairDecision, corroborateImportRepair } from './repairs.js';
import { registerAcademicReviewHook, type AcademicReviewContext, type AcademicReviewOutcome } from './runner.js';
import { renderHtml } from './worker-client.js';

export type EvidenceItem = {
  id: string;
  label: string;
  kind: 'overview'|'object'|'source-page';
  storagePath: string;
  mimeType: 'image/png'|'image/jpeg'|'image/webp';
  blockId?: string;
  tag?: string;
  detail: 'high'|'original';
  bytes: number;
};
type EvidenceIndexItem = Omit<EvidenceItem,'storagePath'|'detail'|'bytes'> & { relativePath:string;url:string };
type AuditRunner=(request:ImportAuditRequest)=>Promise<ImportAuditResult>;

const humanize=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ').replace(/\b\w/g,letter=>letter.toUpperCase());
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

export function planOutlineChunks(items:AcademicOutlineItem[],maximumCharacters=36_000,maximumChunks=4):{chunks:AcademicOutlineItem[][];truncated:boolean}{
  const result:AcademicOutlineItem[][]=[];let current:AcademicOutlineItem[]=[],length=0;
  for(const item of items){const size=item.text.length+item.ref.length+32;if(current.length&&length+size>maximumCharacters){result.push(current);current=[];length=0}current.push(item);length+=size}
  if(current.length)result.push(current);return{chunks:result.slice(0,maximumChunks),truncated:result.length>maximumChunks};
}
export function boundedTriageOutline(items:AcademicOutlineItem[],maximumItems=300,maximumCharacters=48_000):{items:AcademicOutlineItem[];truncated:boolean}{
  const selected:AcademicOutlineItem[]=[];let length=0;
  for(const item of items){const next={...item,text:item.text.slice(0,240)},size=next.text.length+next.ref.length+32;if(selected.length>=maximumItems||selected.length&&length+size>maximumCharacters)break;selected.push(next);length+=size}
  return{items:selected,truncated:selected.length<items.length};
}
function asArray(value:unknown):any[]{return Array.isArray(value)?value:[]}
function imageMime(path:string):EvidenceItem['mimeType']{return /\.jpe?g$/i.test(path)?'image/jpeg':/\.webp$/i.test(path)?'image/webp':'image/png'}
function evidenceId(prefix:string,path:string):string{return`${prefix}-${hash(path).slice(0,18)}`}

export function selectRenderEvidence(manifest:Record<string,unknown>,files:ExtractedBundleFile[]):EvidenceItem[]{
  const byPath=new Map(files.map(file=>[file.path,file])),overview:EvidenceItem[]=[],objects:EvidenceItem[]=[];
  for(const view of asArray(manifest.views)){
    const name=String(view?.viewport?.name??'view'),metrics=new Map(asArray(view?.objects).map((item:any)=>[String(item.ref),item]));
    for(const path of asArray(view?.screenshots).map(String)){const file=byPath.get(path);if(file)overview.push({id:evidenceId('overview',`${name}:${path}`),label:`${humanize(name)} reading-view overview`,kind:'overview',storagePath:file.storagePath,mimeType:imageMime(path),detail:'high',bytes:file.bytes})}
    for(const capture of asArray(view?.objectScreenshots)){
      const path=String(capture?.path??''),file=byPath.get(path),metric=metrics.get(String(capture?.ref??''));if(!file||!metric)continue;
      const tag=String(metric.tag??''),blockId=typeof metric.blockId==='string'?metric.blockId:undefined;
      if(!['figure','table','img','svg','video','math'].includes(tag))continue;
      objects.push({id:evidenceId('object',`${name}:${path}`),label:`${humanize(name)} ${tag} ${String(capture.ref)}`,kind:'object',storagePath:file.storagePath,mimeType:imageMime(path),...(blockId?{blockId}:{}),tag,detail:tag==='table'||tag==='math'?'original':'high',bytes:file.bytes});
    }
  }
  const nonMath=objects.filter(item=>item.tag!=='math'),math=objects.filter(item=>item.tag==='math');
  const sampledMath=math.filter((_item,index)=>index%Math.max(1,Math.ceil(math.length/16))===0).slice(0,16);
  return[...overview,...nonMath,...sampledMath];
}

function sourceEvidence(files:ExtractedBundleFile[]):EvidenceItem[]{return files.filter(file=>/^reference\/page-.*\.png$/i.test(file.path)).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true})).map((file,index)=>({id:evidenceId('source',file.path),label:`Source rendering page ${index+1}`,kind:'source-page',storagePath:file.storagePath,mimeType:'image/png',detail:'high',bytes:file.bytes}))}
function roundRobin(...lists:EvidenceItem[][]):EvidenceItem[]{const output:EvidenceItem[]=[];for(let index=0;lists.some(list=>index<list.length);index++)for(const list of lists)if(list[index])output.push(list[index]!);return output}

export function planImageBatches(items:EvidenceItem[],maximumImages:number):{batches:EvidenceItem[][];selected:EvidenceItem[];oversize:number;budgetExhausted:boolean}{
  const batches:EvidenceItem[][]=[];let current:EvidenceItem[]=[],bytes=0,oversize=0;
  for(const item of items.slice(0,Math.max(0,maximumImages))){if(item.bytes>20_000_000){oversize++;continue}if(current.length===3||bytes+item.bytes>50_000_000){if(current.length)batches.push(current);current=[];bytes=0}current.push(item);bytes+=item.bytes}
  if(current.length)batches.push(current);return{batches,selected:batches.flat(),oversize,budgetExhausted:items.length>Math.max(0,maximumImages)};
}

async function writeEvidenceIndex(jobId:string,items:EvidenceItem[]):Promise<Map<string,EvidenceIndexItem>>{
  const root=join(config.dataDir,'imports',jobId),index=new Map<string,EvidenceIndexItem>();
  for(const item of items){const absolute=resolve(item.storagePath),prefix=resolve(root)+sep;if(!absolute.startsWith(prefix))continue;const publicItem:EvidenceIndexItem={id:item.id,label:item.label,kind:item.kind,relativePath:relative(root,absolute).split(sep).join('/'),url:`/api/import-jobs/${jobId}/evidence/${item.id}`,...(item.blockId?{blockId:item.blockId}:{}),...(item.tag?{tag:item.tag}:{}) ,mimeType:item.mimeType};index.set(item.id,publicItem)}
  await mkdir(join(root,'evidence'),{recursive:true,mode:0o700});await writeFile(join(root,'evidence','index.json'),JSON.stringify([...index.values()],null,2),{mode:0o600});return index;
}

function persistReport(jobId:string,result:ImportAuditResult,evidence:Map<string,EvidenceIndexItem>,renderManifest:Record<string,unknown>,previewHtml:string,autoApply:boolean):void{
  const insert=db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,repair_json,confidence,corroborated,decision,model_run_id,created_at,updated_at)
    VALUES(?,?,'model',?,?,?,?,?,?,?,?,?,?,?,?,?)`),time=now();
  for(const finding of result.report.findings){
    const attached=finding.evidenceRefs.map(ref=>evidence.get(ref)??{id:ref,label:humanize(ref),kind:'overview'});
    const corroborated=corroborateImportRepair(finding,renderManifest,previewHtml),repairJson=finding.suggestedRepair?JSON.stringify(finding.suggestedRepair):null;
    let decision=automaticImportRepairDecision(finding,corroborated,autoApply);
    if(decision==='accepted'&&finding.suggestedRepair){const existing=row<{repair_json:string|null}>("SELECT repair_json FROM import_findings WHERE import_job_id=? AND target_ref=? AND decision='accepted' LIMIT 1",jobId,finding.suggestedRepair.targetRef);if(existing?.repair_json!==undefined&&existing.repair_json!==repairJson)decision='pending'}
    insert.run(nanoid(),jobId,finding.issueCode,finding.severity,humanize(finding.issueCode),finding.observation,finding.suggestedRepair?.targetRef??finding.targetRefs[0]??null,JSON.stringify(attached),repairJson,finding.confidence,corroborated?1:0,decision,result.runId,time,time);
  }
}

async function executeCalls(jobId:string,requests:ImportAuditRequest[],maximum:number,concurrency:number,audit:AuditRunner,evidence:Map<string,EvidenceIndexItem>,renderManifest:Record<string,unknown>,previewHtml:string,autoApply:boolean,signal:AbortSignal):Promise<{used:number;failed:number;unreviewed:number}>{
  let next=0,used=0,failed=0,unreviewed=0,providerUnavailable=false;
  const worker=async()=>{while(true){const index=next++;if(index>=requests.length||used>=maximum||providerUnavailable||signal.aborted)return;const request={...requests[index]!,ordinal:used+1,signal};used++;db.prepare('UPDATE import_jobs SET call_count=?,updated_at=? WHERE id=?').run(used,now(),jobId);try{const result=await audit(request);unreviewed+=result.report.coverage.unreviewedRefs.length;persistReport(jobId,result,evidence,renderManifest,previewHtml,autoApply)}catch(error){failed++;const message=error instanceof Error?error.message:String(error);if(/not ready|not configured|authentication|api key|unauthoriz|forbidden/i.test(message))providerUnavailable=true}}};
  await Promise.all(Array.from({length:Math.max(1,Math.min(2,concurrency))},()=>worker()));return{used,failed,unreviewed};
}

export async function reviewAcademicImport(context:AcademicReviewContext,deps:{audit?:AuditRunner}={}):Promise<AcademicReviewOutcome>{
  const audit=deps.audit??runImportAudit,maximum=Math.max(1,Math.min(40,context.job.max_calls)),root=join(config.dataDir,'imports',context.job.id),previewHtml=await readFile(context.previewPath,'utf8'),rawOutline=academicOutline(previewHtml,2_001),outlineTruncated=rawOutline.length>2_000,outline=rawOutline.slice(0,2_000),targetRefs=outline.map(item=>item.ref);
  db.prepare("DELETE FROM import_findings WHERE import_job_id=? AND source='model'").run(context.job.id);
  let renderItems:EvidenceItem[]=[],renderManifest:Record<string,unknown>={},renderFailed=false;
  try{
    const inputPath=join(root,'evidence','render-input.html'),embedded=await writeSelfContainedPreview(context.job.id,context.previewPath,context.staged,inputPath);if(embedded.bytes>64*1024*1024)throw new Error('Self-contained render input exceeds 64 MB');
    const archive=await renderHtml(inputPath,context.signal),renderDirectory=join(root,'evidence',`render-${nanoid(8)}`),renderBundle=await extractRenderBundle(archive,renderDirectory,hash(embedded.sha256Input));renderManifest=renderBundle.manifest;renderItems=selectRenderEvidence(renderBundle.manifest,renderBundle.files);
  }catch{renderFailed=true}
  const sourceItems=context.job.source_reference?sourceEvidence(context.bundle.files):[],ordered=roundRobin(renderItems.filter(item=>item.kind==='overview'),sourceItems,renderItems.filter(item=>item.kind==='object'));
  const textPlan=planOutlineChunks(outline),triagePlan=boundedTriageOutline(outline),reserved=1+textPlan.chunks.length,visualLimit=Math.max(0,(maximum-reserved)*3),imagePlan=planImageBatches(ordered,visualLimit),selectedImages=imagePlan.selected,evidence=await writeEvidenceIndex(context.job.id,[...selectedImages]);
  const warnings=JSON.stringify(context.bundle.manifest.warnings??[]),inventory=JSON.stringify(context.bundle.manifest.inventory??{}),requests:ImportAuditRequest[]=[];
  requests.push({jobId:context.job.id,ordinal:1,action:'import-triage',promptValues:{manifestJson:JSON.stringify({source:context.bundle.manifest.source,converter:context.bundle.manifest.converter,inventory:context.bundle.manifest.inventory}),outlineJson:JSON.stringify(triagePlan.items),deterministicWarningsJson:warnings},evidenceRefs:['manifest','outline','warnings'],targetRefs});
  for(const [index,part] of textPlan.chunks.entries())requests.push({jobId:context.job.id,ordinal:1,action:'import-semantic-audit',promptValues:{visibleSourceText:`Independent source evidence is represented by the OOXML/converter inventory below. Do not infer a textual omission without direct source evidence.\n${inventory}`,convertedText:visibleAcademicText(part),evidenceRefsJson:JSON.stringify([{id:`text-${index+1}`,kind:'converted-visible-text'}]),deterministicWarningsJson:warnings},evidenceRefs:[`text-${index+1}`],targetRefs:part.map(item=>item.ref)});
  for(const batch of imagePlan.batches)requests.push({jobId:context.job.id,ordinal:1,action:'import-visual-audit',promptValues:{evidenceManifestJson:JSON.stringify(batch.map(item=>({id:item.id,label:item.label,kind:item.kind,blockId:item.blockId??null,tag:item.tag??null}))),deterministicWarningsJson:warnings},evidenceRefs:batch.map(item=>item.id),targetRefs:[...new Set(batch.flatMap(item=>item.blockId?[item.blockId]:[]))],images:await Promise.all(batch.map(async item=>({id:item.id,mimeType:item.mimeType,data:(await readFile(item.storagePath)).toString('base64'),detail:item.detail})))});
  const result=await executeCalls(context.job.id,requests,maximum,context.job.review_concurrency,audit,evidence,renderManifest,previewHtml,Boolean(context.job.auto_apply),context.signal),partial=renderFailed||outlineTruncated||triagePlan.truncated||textPlan.truncated||imagePlan.oversize>0||selectedImages.length<ordered.length||requests.length>maximum||result.failed>0||result.unreviewed>0;
  db.prepare('UPDATE import_jobs SET provenance_json=json_set(provenance_json,\'$.qaCoverage\',json(?)),updated_at=? WHERE id=?').run(JSON.stringify({plannedCalls:requests.length,usedCalls:result.used,failedCalls:result.failed,unreviewedRefs:result.unreviewed,renderedEvidence:selectedImages.length,availableEvidence:ordered.length,oversizeEvidence:imagePlan.oversize,outlineBlocks:outline.length,outlineTruncated,triageTruncated:triagePlan.truncated,textTruncated:textPlan.truncated,budgetExhausted:requests.length>maximum||imagePlan.budgetExhausted,renderFailed}),now(),context.job.id);
  return{status:result.used===0||result.failed===result.used?'failed':partial?'partial':'completed',callCount:result.used};
}

export function installAcademicReviewHook():void{registerAcademicReviewHook(context=>reviewAcademicImport(context))}
