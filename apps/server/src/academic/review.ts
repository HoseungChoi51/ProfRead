import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { sanitizeDocument } from '../ingest/sanitize.js';
import { runImportAudit, type ImportAuditRequest, type ImportAuditResult } from '../models/import-audit.js';
import { runImportRepairPlan } from '../models/import-repair.js';
import { extractRenderBundle, type ExtractedBundleFile } from './bundle.js';
import { academicOutline, visibleAcademicText, writeSelfContainedPreview, type AcademicOutlineItem } from './evidence.js';
import { stagedResultSchema } from './persistence.js';
import { applyAcademicAdjudication, listAcademicReviewIssues, materializeAcademicReviewIssues, registerAcademicIssueAdjudicator, registerAcademicReviewRebuilder } from './review-issues.js';
import { registerAcademicRepairPlanner } from './repair-batches.js';
import { corroborateImportRepair } from './repairs.js';
import { reviewerPolicySnapshot } from './reviewer-policies.js';
import { rebuildAcademicImportReview, registerAcademicReviewHook, type AcademicReviewContext, type AcademicReviewOutcome } from './runner.js';
import { renderHtml } from './worker-client.js';

export type EvidenceItem = {
  id: string;
  label: string;
  kind: 'overview'|'context'|'object'|'source-page';
  storagePath: string;
  mimeType: 'image/png'|'image/jpeg'|'image/webp';
  blockId?: string;
  tag?: string;
  detail: 'high'|'original';
  bytes: number;
  metadata?: Record<string,unknown>;
};
type EvidenceIndexItem = Omit<EvidenceItem,'storagePath'|'detail'|'bytes'> & { relativePath:string;url:string };
type AuditRunner=(request:ImportAuditRequest)=>Promise<ImportAuditResult>;

const humanize=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ').replace(/\b\w/g,letter=>letter.toUpperCase());
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

type SvgSemanticDelta={index:number;targetRef:string|null;source:{viewBox:string|null;markers:number;localPaintRefs:number};output:{viewBox:string|null;markers:number;localPaintRefs:number};degraded:boolean};
function svgSemantics(html:string):Array<{viewBox:string|null;markers:number;localPaintRefs:number;targetRef:string|null}>{
  const $=cheerio.load(html);return $('svg').toArray().map(element=>{const node=$(element),serialized=$.html(node),viewBox=node.attr('viewBox')??node.attr('viewbox')??null;return{viewBox,markers:node.find('marker').length,localPaintRefs:[...serialized.matchAll(/url\(\s*["']?#[A-Za-z0-9_.:-]+["']?\s*\)/g)].length,targetRef:node.attr('data-block-id')??null}});
}
export function compareSvgSemantics(sourceHtml:string,previewHtml:string):SvgSemanticDelta[]{
  const source=svgSemantics(sourceHtml),output=svgSemantics(previewHtml),byRef=new Map(output.filter(item=>item.targetRef).map(item=>[item.targetRef,item]));return source.map((item,index)=>{const converted=(item.targetRef?byRef.get(item.targetRef):output[index])??{viewBox:null,markers:0,localPaintRefs:0,targetRef:null},degraded=Boolean(item.viewBox&&!converted.viewBox)||converted.markers<item.markers||converted.localPaintRefs<item.localPaintRefs;return{index,targetRef:item.targetRef??converted.targetRef,source:{viewBox:item.viewBox,markers:item.markers,localPaintRefs:item.localPaintRefs},output:{viewBox:converted.viewBox,markers:converted.markers,localPaintRefs:converted.localPaintRefs},degraded}});
}
function persistSvgSemanticDeltas(jobId:string,deltas:SvgSemanticDelta[]):void{
  db.prepare("DELETE FROM import_findings WHERE import_job_id=? AND source='deterministic' AND issue_code='svg-semantics-degraded'").run(jobId);const insert=db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,source_comparison,target_ref,evidence_json,repair_json,confidence,corroborated,decision,model_run_id,created_at,updated_at) VALUES(?,?,'deterministic','svg-semantics-degraded','error','SVG semantics degraded',?,?,?,?,?,'high',1,'pending',NULL,?,?)`),time=now();
  for(const delta of deltas.filter(item=>item.degraded)){const description='The sanitized preview lost SVG geometry or local marker semantics that exist in the immutable converted source.',comparison=JSON.stringify({source:delta.source,output:delta.output,index:delta.index}),evidence=JSON.stringify([{id:`svg-source-comparison-${delta.index+1}`,kind:'source-comparison',label:`SVG ${delta.index+1} source versus preview semantics`,comparison:{source:delta.source,output:delta.output}}]),repair=delta.targetRef?JSON.stringify({type:'restore-svg-semantics',targetRef:delta.targetRef}):null;insert.run(nanoid(),jobId,description,comparison,delta.targetRef,evidence,repair,time,time)}
}

export function planOutlineChunks(items:AcademicOutlineItem[],maximumCharacters=36_000,maximumChunks=4):{chunks:AcademicOutlineItem[][];truncated:boolean}{
  const result:AcademicOutlineItem[][]=[];let current:AcademicOutlineItem[]=[],length=0;
  for(const item of items){const size=item.text.length+item.ref.length+32;if(current.length&&length+size>maximumCharacters){result.push(current);current=[];length=0}current.push(item);length+=size}
  if(current.length)result.push(current);return{chunks:result.slice(0,maximumChunks),truncated:result.length>maximumChunks};
}
export function boundedTriageOutline(items:AcademicOutlineItem[],maximumItems=300,maximumCharacters=48_000):{items:AcademicOutlineItem[];truncated:boolean}{
  const selected:AcademicOutlineItem[]=[];let length=0;
  for(const item of items){
    const limit=240,candidate=item.text.slice(0,limit-1),boundary=candidate.lastIndexOf(item.tag==='pre'?'\n':' '),truncated=item.truncated||item.text.length>limit,
      text=truncated?`${boundary>0?candidate.slice(0,boundary):candidate}… [TRUNCATED; fullLength=${item.fullLength}]`:item.text,
      next={...item,text,excerptLength:text.length,truncated},size=next.text.length+next.ref.length+96;
    if(selected.length>=maximumItems||selected.length&&length+size>maximumCharacters)break;selected.push(next);length+=size;
  }
  return{items:selected,truncated:selected.length<items.length};
}
function asArray(value:unknown):any[]{return Array.isArray(value)?value:[]}
function imageMime(path:string):EvidenceItem['mimeType']{return /\.jpe?g$/i.test(path)?'image/jpeg':/\.webp$/i.test(path)?'image/webp':'image/png'}
function evidenceId(prefix:string,path:string):string{return`${prefix}-${hash(path).slice(0,18)}`}

export function selectRenderEvidence(manifest:Record<string,unknown>,files:ExtractedBundleFile[]):EvidenceItem[]{
  const byPath=new Map(files.map(file=>[file.path,file])),overview:EvidenceItem[]=[],contexts:EvidenceItem[]=[],objects:EvidenceItem[]=[];
  for(const view of asArray(manifest.views)){
    const name=String(view?.viewport?.name??'view'),metricItems=asArray(view?.objects),metrics=new Map(metricItems.map((item:any)=>[String(item.ref),item]));
    for(const path of asArray(view?.screenshots).map(String)){const file=byPath.get(path);if(file)overview.push({id:evidenceId('overview',`${name}:${path}`),label:`${humanize(name)} reading-view overview`,kind:'overview',storagePath:file.storagePath,mimeType:imageMime(path),detail:'high',bytes:file.bytes})}
    const addTargetCapture=(capture:any,kind:'context'|'object')=>{
      const path=String(capture?.path??''),file=byPath.get(path),metric=metrics.get(String(capture?.ref??''));if(!file||!metric)return;
      const semantic=metric.semanticObject&&typeof metric.semanticObject==='object'?metric.semanticObject as Record<string,unknown>:undefined,
        capturedTag=String(metric.tag??''),tag=typeof semantic?.rootTag==='string'?semantic.rootTag:capturedTag,
        blockId=typeof semantic?.rootBlockId==='string'?semantic.rootBlockId:typeof metric.blockId==='string'?metric.blockId:undefined;
      if(!['figure','table','img','svg','video','math'].includes(tag))return;
      const rootRef=String(semantic?.rootRef??metric.ref??capture.ref),semanticMetrics=metricItems.filter((item:any)=>String(item?.semanticObject?.rootRef??item?.ref)===rootRef),svgDiagnostics=semanticMetrics.filter((item:any)=>item?.tag==='svg'&&item.svgGeometry).map((item:any)=>({ref:item.ref,blockId:item.blockId??null,geometry:item.svgGeometry})),metadata={viewport:name,captureRef:String(capture.ref),capturedTag,semanticObject:semantic??null,text:{fullLength:metric.textLength??null,excerptLength:typeof metric.text==='string'?metric.text.length:0,truncated:Boolean(metric.textTruncated)},structure:metric.structure??null,svgGeometry:metric.svgGeometry??null,svgDiagnostics,layout:{visible:metric.visible!==false,clippedX:Boolean(metric.clippedX),clippedY:Boolean(metric.clippedY),clientWidth:metric.clientWidth??null,scrollWidth:metric.scrollWidth??null,clientHeight:metric.clientHeight??null,scrollHeight:metric.scrollHeight??null,overflowX:metric.overflowX??null,overflowY:metric.overflowY??null}};
      const item:EvidenceItem={id:evidenceId(kind,`${name}:${path}`),label:kind==='context'?`${humanize(name)} reading-view context around ${tag}`:`${humanize(name)} ${tag} close-up`,kind,storagePath:file.storagePath,mimeType:imageMime(path),...(blockId?{blockId}:{}),tag,detail:kind==='object'&&(tag==='table'||tag==='math')?'original':'high',bytes:file.bytes,metadata:{...metadata,...(capture.clip?{contextClip:capture.clip}:{})}};(kind==='context'?contexts:objects).push(item);
    };
    for(const capture of asArray(view?.contextScreenshots))addTargetCapture(capture,'context');
    for(const capture of asArray(view?.objectScreenshots))addTargetCapture(capture,'object');
  }
  const nonMath=objects.filter(item=>item.tag!=='math'),math=objects.filter(item=>item.tag==='math');
  const sampledMath=math.filter((_item,index)=>index%Math.max(1,Math.ceil(math.length/16))===0).slice(0,16);
  return[...contexts,...nonMath,...sampledMath,...overview];
}

export function selectSourceEvidence(files:ExtractedBundleFile[]):EvidenceItem[]{return files.filter(file=>/^reference\/page-.*\.(?:png|jpe?g)$/i.test(file.path)||/^assets\/pdf-page-\d+\.jpe?g$/i.test(file.path)).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true})).map((file,index)=>({id:evidenceId('source',file.path),label:`Source rendering page ${index+1}`,kind:'source-page',storagePath:file.storagePath,mimeType:imageMime(file.path),detail:'high',bytes:file.bytes}))}
function spread<T>(items:T[],maximum:number):T[]{if(maximum<=0||!items.length)return[];if(items.length<=maximum)return items;if(maximum===1)return[items[0]!];return Array.from({length:maximum},(_value,index)=>items[Math.round(index*(items.length-1)/(maximum-1))]!)}
function evidenceGroup(item:EvidenceItem):string{return ['context','object'].includes(item.kind)?item.blockId??String(item.metadata?.captureRef??item.id):item.id}
export function prioritizeReviewEvidence(renderItems:EvidenceItem[],sourceItems:EvidenceItem[],maximumImages:number):EvidenceItem[]{
  const overviews=renderItems.filter(item=>item.kind==='overview'),objects=renderItems.filter(item=>['context','object'].includes(item.kind)),reservedOverviews=objects.length?[]:spread(overviews,Math.min(2,maximumImages)),reservedSources=spread(sourceItems,Math.min(sourceItems.length,maximumImages>=4?2:maximumImages>=2?1:0)),quota=[...reservedOverviews,...reservedSources],groups=new Map<string,EvidenceItem[]>();
  for(const item of objects)groups.set(evidenceGroup(item),[...(groups.get(evidenceGroup(item))??[]),item]);
  const capacity=Math.max(0,maximumImages-quota.length),selected:EvidenceItem[]=[];for(const values of groups.values())if(values[0]&&selected.length<capacity)selected.push(values[0]);for(let pass=1;selected.length<capacity&&[...groups.values()].some(values=>values[pass]);pass++)for(const values of groups.values())if(values[pass]&&selected.length<capacity)selected.push(values[pass]!);
  const selectedIds=new Set([...quota,...selected].map(item=>item.id)),chosenByGroup=new Map<string,EvidenceItem[]>();for(const item of selected)chosenByGroup.set(evidenceGroup(item),[...(chosenByGroup.get(evidenceGroup(item))??[]),item]);const paired=[...chosenByGroup.values()].flat();
  return[...quota,...paired,...renderItems.filter(item=>!selectedIds.has(item.id)&&(!objects.length||item.kind!=='overview')),...sourceItems.filter(item=>!selectedIds.has(item.id))];
}
export function planImageBatches(items:EvidenceItem[],maximumImages:number):{batches:EvidenceItem[][];selected:EvidenceItem[];oversize:number;budgetExhausted:boolean}{
  const batches:EvidenceItem[][]=[];let current:EvidenceItem[]=[],bytes=0,oversize=0,accepted=0,index=0;
  while(index<items.length&&accepted<Math.max(0,maximumImages)){const first=items[index]!,key=evidenceGroup(first),unit:EvidenceItem[]=[first];index++;if(['context','object'].includes(first.kind))while(index<items.length&&unit.length<2&&['context','object'].includes(items[index]!.kind)&&evidenceGroup(items[index]!)===key)unit.push(items[index++]!);const usable=unit.filter(item=>{if(item.bytes>20_000_000){oversize++;return false}return true}).slice(0,Math.max(0,maximumImages)-accepted);if(!usable.length)continue;const unitBytes=usable.reduce((sum,item)=>sum+item.bytes,0);if(current.length&&(current.length+usable.length>3||bytes+unitBytes>50_000_000)){batches.push(current);current=[];bytes=0}for(const item of usable){if(current.length===3||bytes+item.bytes>50_000_000){if(current.length)batches.push(current);current=[];bytes=0}current.push(item);bytes+=item.bytes;accepted++}}
  if(current.length)batches.push(current);return{batches,selected:batches.flat(),oversize,budgetExhausted:index<items.length};
}

export function rendererCoverage(manifest:Record<string,unknown>):{semanticEligible:number;semanticCaptured:number;missing:number;screenshotFailures:number}{let semanticEligible=0,semanticCaptured=0,screenshotFailures=0;for(const view of asArray(manifest.views)){semanticEligible+=Number(view?.screenshotCoverage?.semanticEligible??0)||0;semanticCaptured+=Number(view?.screenshotCoverage?.semanticCaptured??0)||0}screenshotFailures=asArray(manifest.warnings).filter((item:any)=>/^(?:object|context)_screenshot_(?:failed|skipped)$/.test(String(item?.code??''))).length;return{semanticEligible,semanticCaptured,missing:Math.max(0,semanticEligible-semanticCaptured),screenshotFailures}}

type RecheckResult={reviewIssues:ReturnType<typeof listAcademicReviewIssues>;callsUsed:number;failedCalls:number};
type StoredEvidenceIndexItem={id:string;relativePath:string;mimeType:'image/png'|'image/jpeg'|'image/webp'};
async function evidenceImagesForIssue(jobId:string,evidenceRefs:string[]):Promise<{images:NonNullable<ImportAuditRequest['images']>;inspectableRefs:string[]}>{
  const root=join(config.dataDir,'imports',jobId),items=JSON.parse(await readFile(join(root,'evidence','index.json'),'utf8').catch(()=>'[]')) as StoredEvidenceIndexItem[],wanted=new Set(evidenceRefs),images:NonNullable<ImportAuditRequest['images']>=[],inspectableRefs:string[]=[];
  for(const item of items){if(!wanted.has(item.id)||!/^[A-Za-z0-9_-]{1,100}$/.test(item.id))continue;inspectableRefs.push(item.id);if(images.length>=4)continue;const path=resolve(root,item.relativePath);if(!path.startsWith(resolve(root)+sep))continue;const content=await readFile(path).catch(()=>null);if(!content||content.byteLength>20_000_000)continue;images.push({id:item.id,mimeType:item.mimeType,data:content.toString('base64'),detail:'high'})}
  return{images,inspectableRefs:[...new Set(inspectableRefs)]};
}

type SourceComparisonItem={id:string;text:string};
function boundedComparisonNode($:cheerio.CheerioAPI,node:cheerio.Cheerio<any>):Record<string,unknown>|null{
  if(!node.length)return null;const element=node.get(0),tag=element&&'tagName' in element?String(element.tagName):'unknown',plain=node.text().replace(/\s+/g,' ').trim(),serialized=$.html(node),textLimit=3_000,htmlLimit=6_000;
  return{tag,text:plain.length>textLimit?`${plain.slice(0,textLimit-24)}… [TRUNCATED]`:plain,textLength:plain.length,textTruncated:plain.length>textLimit,html:serialized.length>htmlLimit?`${serialized.slice(0,htmlLimit-24)}…[TRUNCATED]`:serialized,htmlLength:serialized.length,htmlTruncated:serialized.length>htmlLimit};
}
function blockByRef($:cheerio.CheerioAPI,targetRef:string):cheerio.Cheerio<any>{return $('[data-block-id]').filter((_index,element)=>$(element).attr('data-block-id')===targetRef).first()}
async function sourceComparisonsForIssue(jobId:string,targetRefs:string[]):Promise<{items:SourceComparisonItem[];inspectableRefs:string[]}>{
  const stored=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId);if(!stored?.result_json)return{items:[],inspectableRefs:[]};
  try{
    const staged=stagedResultSchema.parse(JSON.parse(stored.result_json)),root=resolve(config.dataDir,'imports',jobId),bundleRoot=resolve(staged.bundleDirectory);if(!bundleRoot.startsWith(root+sep))return{items:[],inspectableRefs:[]};
    const sourcePath=resolve(bundleRoot,staged.entryPath);if(!sourcePath.startsWith(bundleRoot+sep))return{items:[],inspectableRefs:[]};
    const active=row<{html_path:string}>("SELECT html_path FROM import_review_revisions WHERE import_job_id=? AND status='active'",jobId),previewPath=resolve(active?.html_path??join(root,'preview.html'));if(!previewPath.startsWith(root+sep))return{items:[],inspectableRefs:[]};
    const [sourceHtml,previewHtml]=await Promise.all([readFile(sourcePath,'utf8'),readFile(previewPath,'utf8')]),assetIds=new Map(staged.assets.map(asset=>[asset.sourcePath,asset.id])),expectedHtml=sanitizeDocument(sourceHtml,staged.entryPath,path=>assetIds.has(path)?`/api/import-jobs/${jobId}/assets/${assetIds.get(path)}`:null).html,expected=cheerio.load(expectedHtml),preview=cheerio.load(previewHtml),items:SourceComparisonItem[]=[],inspectableRefs:string[]=[];
    for(const targetRef of [...new Set(targetRefs)]){
      const sourceNode=blockByRef(expected,targetRef),previewNode=blockByRef(preview,targetRef);if(!sourceNode.length&&!previewNode.length)continue;const id=`source-comparison-${hash(targetRef).slice(0,18)}`;inspectableRefs.push(id);if(items.length>=4)continue;
      items.push({id,text:JSON.stringify({targetRef,source:boundedComparisonNode(expected,sourceNode),preview:boundedComparisonNode(preview,previewNode)})});
    }
    return{items,inspectableRefs};
  }catch{return{items:[],inspectableRefs:[]}}
}

/** Recheck only the issues the reviewer selected, against their exact stored evidence. */
export async function recheckAcademicReviewIssues(jobId:string,issueIds:string[],signal?:AbortSignal,deps:{audit?:AuditRunner}={}):Promise<RecheckResult>{
  const job=row<{status:string;stage:string;call_count:number;max_calls:number;source_kind:string;source_name:string}>('SELECT status,stage,call_count,max_calls,source_kind,source_name FROM import_jobs WHERE id=?',jobId);if(!job)throw Object.assign(new Error('Import job not found'),{statusCode:404});if(job.status!=='review-ready'||!['review','publish-failed'].includes(job.stage))throw Object.assign(new Error('Review issues can only be rechecked during stable review'),{statusCode:409});
  const claimed=db.prepare("UPDATE import_jobs SET stage='review-recheck',updated_at=? WHERE id=? AND status='review-ready' AND stage IN ('review','publish-failed')").run(now(),jobId);if(!claimed.changes)throw Object.assign(new Error('The import review changed before the recheck could start'),{statusCode:409});
  let used=0,failed=0;
  try{
    const wanted=[...new Set(issueIds)],issues=listAcademicReviewIssues(jobId).filter(issue=>wanted.includes(issue.id));if(issues.length!==wanted.length)throw Object.assign(new Error('One or more review issues were not found'),{statusCode:404});if(issues.some(issue=>issue.status!=='pending'||['rejected','resolved'].includes(issue.verificationStatus)))throw Object.assign(new Error('Only open review issues can be rechecked'),{statusCode:409});
    const audit=deps.audit??runImportAudit,policy=reviewerPolicySnapshot({jobId,sourceKind:job.source_kind,sourceName:job.source_name}),adjudications:unknown[]=[],raw=db.prepare('SELECT id,source,issue_code,severity,description,source_comparison,target_ref,evidence_json,repair_json,confidence,corroborated FROM import_findings WHERE id=?'),
      prepared:Array<{issue:(typeof issues)[number];rawFindings:Array<Record<string,any>>;images:NonNullable<ImportAuditRequest['images']>;sourceComparisons:Array<{id:string;text:string}>;evidenceRefs:string[];inspectableRefs:string[]}>=[];
    for(const issue of issues){
      if(signal?.aborted)throw new Error('Academic issue recheck was cancelled');const rawFindings=issue.findingIds.map(id=>raw.get(id)).filter(Boolean) as Array<Record<string,any>>;if(rawFindings.some(item=>item.source==='deterministic'))continue;
      const storedEvidenceIds=[...new Set(issue.evidence.map((item:any)=>typeof item?.id==='string'?item.id:'').filter(Boolean))],expectedInspectableRefs=[...new Set(issue.evidence.filter((item:any)=>['overview','context','object','source-page'].includes(String(item?.kind??''))||String(item?.mimeType??item?.mime_type??'').startsWith('image/')||typeof item?.url==='string'&&item.url.includes('/evidence/')).map((item:any)=>String(item.id)).filter(Boolean))],loaded=await evidenceImagesForIssue(jobId,storedEvidenceIds),images=loaded.images,comparisons=await sourceComparisonsForIssue(jobId,issue.targetRefs),sourceComparisons=comparisons.items,evidenceRefs=[...images.map(image=>image.id),...sourceComparisons.map(item=>item.id)],inspectableRefs=[...new Set([...expectedInspectableRefs,...loaded.inspectableRefs,...comparisons.inspectableRefs])];
      if(!evidenceRefs.length){adjudications.push({issueId:issue.id,verificationStatus:'unverified',reason:'Recheck was not allowed to guess: no independent source comparison or inspectable visual evidence is available.',repair:null,report:{skipped:'insufficient-independent-evidence'}});continue}
      prepared.push({issue,rawFindings,images,sourceComparisons,evidenceRefs,inspectableRefs});
    }
    let usedStart=row<{call_count:number}>('SELECT call_count FROM import_jobs WHERE id=?',jobId)!.call_count;
    if(prepared.length){
      const reserved=db.prepare("UPDATE import_jobs SET call_count=call_count+?,updated_at=? WHERE id=? AND status='review-ready' AND stage='review-recheck' AND call_count+?<=MIN(max_calls,40)").run(prepared.length,now(),jobId,prepared.length);
      if(!reserved.changes){const current=row<{status:string;stage:string;call_count:number;max_calls:number}>('SELECT status,stage,call_count,max_calls FROM import_jobs WHERE id=?',jobId);if(!current||current.status!=='review-ready'||current.stage!=='review-recheck')throw Object.assign(new Error('The import review changed while the recheck was being prepared'),{statusCode:409});const remaining=Math.max(0,Math.min(40,current.max_calls)-current.call_count);throw Object.assign(new Error(`This recheck needs ${prepared.length} evidence-backed model calls but only ${remaining} remain in the import budget`),{statusCode:409})}
      usedStart=row<{call_count:number}>('SELECT call_count FROM import_jobs WHERE id=?',jobId)!.call_count-prepared.length;
    }
    for(const item of prepared){
      const{issue,rawFindings,images,sourceComparisons,evidenceRefs,inspectableRefs}=item,ordinal=usedStart+used+1;used++;
      try{
        const result=await audit({jobId,ordinal,action:'import-adjudicate',promptValues:{findingsJson:JSON.stringify({groupedIssue:issue,rawFindings,reviewerFeedback:issue.feedback,reviewerPolicies:JSON.parse(policy.promptJson)}),evidenceManifestJson:JSON.stringify({visualEvidence:issue.evidence.filter((evidence:any)=>images.some(image=>image.id===evidence?.id)),sourceComparisons,omittedInspectableRefs:inspectableRefs.filter(ref=>!evidenceRefs.includes(ref))}),},evidenceRefs,targetRefs:issue.targetRefs,...(images.length?{images}:{}),...(signal?{signal}:{})}),reviewed=new Set(result.report.coverage.reviewedRefs),matching=result.report.findings.filter(finding=>finding.issueCode===issue.issueCode&&finding.confidence==='high'&&finding.requestedEvidenceRefs.length===0&&finding.targetRefs.some(ref=>issue.targetRefs.includes(ref))&&finding.evidenceRefs.length>0&&finding.evidenceRefs.every(ref=>reviewed.has(ref))),first=matching[0],allTargetedEvidenceReviewed=inspectableRefs.length===evidenceRefs.length&&inspectableRefs.every(ref=>reviewed.has(ref));
        // Diagnosis and repair authorization are intentionally separate. A
        // recheck can confirm the observation, but repair-batch validation must
        // independently establish and apply a safe operation.
        if(first)adjudications.push({issueId:issue.id,verificationStatus:'confirmed',reason:first.sourceComparison||first.observation,repair:null,modelRunId:result.runId,report:result.report});
        else if(result.report.verdict==='clean'&&allTargetedEvidenceReviewed)adjudications.push({issueId:issue.id,verificationStatus:'rejected',reason:'Targeted model recheck found no directly supported defect in the supplied evidence.',repair:null,modelRunId:result.runId,report:result.report});
        else adjudications.push({issueId:issue.id,verificationStatus:'unverified',reason:'Targeted model recheck could not confirm or reject this issue from all supplied evidence.',repair:null,modelRunId:result.runId,report:result.report});
      }catch{failed++}
    }
    const held=row<{status:string;stage:string}>('SELECT status,stage FROM import_jobs WHERE id=?',jobId);if(!held||held.status!=='review-ready'||held.stage!=='review-recheck')throw Object.assign(new Error('The import review changed before recheck results could be saved'),{statusCode:409});
    if(adjudications.length)applyAcademicAdjudication(jobId,adjudications);
    return{reviewIssues:listAcademicReviewIssues(jobId),callsUsed:used,failedCalls:failed};
  }finally{db.prepare("UPDATE import_jobs SET stage=?,updated_at=? WHERE id=? AND status='review-ready' AND stage='review-recheck'").run(job.stage,now(),jobId)}
}

async function writeEvidenceIndex(jobId:string,items:EvidenceItem[]):Promise<Map<string,EvidenceIndexItem>>{
  const root=join(config.dataDir,'imports',jobId),index=new Map<string,EvidenceIndexItem>();
  for(const item of items){const absolute=resolve(item.storagePath),prefix=resolve(root)+sep;if(!absolute.startsWith(prefix))continue;const publicItem:EvidenceIndexItem={id:item.id,label:item.label,kind:item.kind,relativePath:relative(root,absolute).split(sep).join('/'),url:`/api/import-jobs/${jobId}/evidence/${item.id}`,...(item.blockId?{blockId:item.blockId}:{}),...(item.tag?{tag:item.tag}:{}),...(item.metadata?{metadata:item.metadata}:{}),mimeType:item.mimeType};index.set(item.id,publicItem)}
  await mkdir(join(root,'evidence'),{recursive:true,mode:0o700});await writeFile(join(root,'evidence','index.json'),JSON.stringify([...index.values()],null,2),{mode:0o600});return index;
}

function persistReport(jobId:string,result:ImportAuditResult,evidence:Map<string,EvidenceIndexItem>,renderManifest:Record<string,unknown>,previewHtml:string):void{
  const insert=db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,source_comparison,target_ref,evidence_json,repair_json,confidence,corroborated,decision,model_run_id,created_at,updated_at)
    VALUES(?,?,'model',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),time=now();
  for(const finding of result.report.findings){
    const attached=finding.evidenceRefs.map(ref=>evidence.get(ref)??{id:ref,label:humanize(ref),kind:ref==='outline'?'outline':/^text-/.test(ref)?'converted-text':ref});
    const corroborated=corroborateImportRepair(finding,renderManifest,previewHtml),repairJson=finding.suggestedRepair?JSON.stringify(finding.suggestedRepair):null;
    insert.run(nanoid(),jobId,finding.issueCode,finding.severity,humanize(finding.issueCode),finding.observation,finding.sourceComparison,finding.suggestedRepair?.targetRef??finding.targetRefs[0]??null,JSON.stringify(attached),repairJson,finding.confidence,corroborated?1:0,'pending',result.runId,time,time);
  }
}

async function executeCalls(jobId:string,requests:ImportAuditRequest[],maximum:number,concurrency:number,audit:AuditRunner,evidence:Map<string,EvidenceIndexItem>,renderManifest:Record<string,unknown>,previewHtml:string,signal:AbortSignal):Promise<{used:number;failed:number;unreviewed:number}>{
  let next=0,used=0,failed=0,unreviewed=0,providerUnavailable=false;
  const worker=async()=>{while(true){const index=next++;if(index>=requests.length||used>=maximum||providerUnavailable||signal.aborted)return;const request={...requests[index]!,ordinal:used+1,signal};used++;db.prepare('UPDATE import_jobs SET call_count=?,updated_at=? WHERE id=?').run(used,now(),jobId);try{const result=await audit(request);unreviewed+=result.report.coverage.unreviewedRefs.length;persistReport(jobId,result,evidence,renderManifest,previewHtml)}catch(error){failed++;const message=error instanceof Error?error.message:String(error);if(/not ready|not configured|authentication|api key|unauthoriz|forbidden/i.test(message))providerUnavailable=true}}};
  await Promise.all(Array.from({length:Math.max(1,Math.min(2,concurrency))},()=>worker()));return{used,failed,unreviewed};
}

export async function reviewAcademicImport(context:AcademicReviewContext,deps:{audit?:AuditRunner}={}):Promise<AcademicReviewOutcome>{
  const audit=deps.audit??runImportAudit,maximum=Math.max(1,Math.min(40,context.job.max_calls)),root=join(config.dataDir,'imports',context.job.id),previewHtml=await readFile(context.previewPath,'utf8'),convertedSource=await readFile(join(context.bundle.directory,context.bundle.entryPath),'utf8'),assetsByPath=new Map(context.staged.assets.map(asset=>[asset.sourcePath,asset.id])),expectedPreview=sanitizeDocument(convertedSource,context.bundle.entryPath,path=>assetsByPath.has(path)?`/api/import-jobs/${context.job.id}/assets/${assetsByPath.get(path)}`:null).html,svgDeltas=compareSvgSemantics(expectedPreview,previewHtml);persistSvgSemanticDeltas(context.job.id,svgDeltas);const rawOutline=academicOutline(previewHtml,2_001),outlineTruncated=rawOutline.length>2_000,outline=rawOutline.slice(0,2_000),targetRefs=outline.map(item=>item.ref);
  db.prepare("DELETE FROM import_findings WHERE import_job_id=? AND source='model'").run(context.job.id);
  let renderItems:EvidenceItem[]=[],renderManifest:Record<string,unknown>={},renderFailed=false;
  try{
    const inputPath=join(root,'evidence','render-input.html'),embedded=await writeSelfContainedPreview(context.job.id,context.previewPath,context.staged,inputPath);if(embedded.bytes>64*1024*1024)throw new Error('Self-contained render input exceeds 64 MB');
    const archive=await renderHtml(inputPath,context.signal),renderDirectory=join(root,'evidence',`render-${nanoid(8)}`),renderBundle=await extractRenderBundle(archive,renderDirectory,hash(embedded.sha256Input));renderManifest=renderBundle.manifest;renderItems=selectRenderEvidence(renderBundle.manifest,renderBundle.files);
  }catch{renderFailed=true}
  const sourceItems=context.job.source_reference?selectSourceEvidence(context.bundle.files):[],textPlan=planOutlineChunks(outline),triagePlan=boundedTriageOutline(outline),reserved=1+textPlan.chunks.length,visualLimit=Math.max(0,(maximum-reserved)*3),ordered=prioritizeReviewEvidence(renderItems,sourceItems,visualLimit),imagePlan=planImageBatches(ordered,visualLimit),selectedImages=imagePlan.selected,evidence=await writeEvidenceIndex(context.job.id,[...selectedImages]),renderCoverage=rendererCoverage(renderManifest);
  const policies=reviewerPolicySnapshot({jobId:context.job.id,sourceKind:context.job.source_kind,sourceName:context.job.source_name}),warnings=JSON.stringify({deterministicWarnings:context.bundle.manifest.warnings??[],svgSourceComparison:svgDeltas,renderCoverage,reviewerPolicyGuidance:JSON.parse(policies.promptJson)}),inventory=JSON.stringify(context.bundle.manifest.inventory??{}),requests:ImportAuditRequest[]=[];
  requests.push({jobId:context.job.id,ordinal:1,action:'import-triage',promptValues:{manifestJson:JSON.stringify({source:context.bundle.manifest.source,converter:context.bundle.manifest.converter,inventory:context.bundle.manifest.inventory}),outlineJson:JSON.stringify(triagePlan.items),deterministicWarningsJson:warnings},evidenceRefs:['manifest','outline','warnings'],targetRefs});
  for(const [index,part] of textPlan.chunks.entries())requests.push({jobId:context.job.id,ordinal:1,action:'import-semantic-audit',promptValues:{visibleSourceText:`Independent source evidence is represented by the source-specific converter inventory below. Do not infer a textual omission without direct source evidence, and do not reconstruct scholarly content.\n${inventory}`,convertedText:visibleAcademicText(part),evidenceRefsJson:JSON.stringify([{id:`text-${index+1}`,kind:'converted-visible-text'}]),deterministicWarningsJson:warnings},evidenceRefs:[`text-${index+1}`],targetRefs:part.map(item=>item.ref)});
  for(const batch of imagePlan.batches)requests.push({jobId:context.job.id,ordinal:1,action:'import-visual-audit',promptValues:{evidenceManifestJson:JSON.stringify(batch.map(item=>({id:item.id,label:item.label,kind:item.kind,blockId:item.blockId??null,tag:item.tag??null,metadata:item.metadata??null}))),deterministicWarningsJson:warnings},evidenceRefs:batch.map(item=>item.id),targetRefs:[...new Set(batch.flatMap(item=>item.blockId?[item.blockId]:[]))],images:await Promise.all(batch.map(async item=>({id:item.id,mimeType:item.mimeType,data:(await readFile(item.storagePath)).toString('base64'),detail:item.detail})))});
  const result=await executeCalls(context.job.id,requests,maximum,context.job.review_concurrency,audit,evidence,renderManifest,previewHtml,context.signal),partial=renderFailed||outlineTruncated||triagePlan.truncated||textPlan.truncated||imagePlan.oversize>0||imagePlan.budgetExhausted||renderCoverage.missing>0||renderCoverage.screenshotFailures>0||requests.length>maximum||result.failed>0||result.unreviewed>0;
  db.prepare('UPDATE import_jobs SET provenance_json=json_set(provenance_json,\'$.qaCoverage\',json(?)),updated_at=? WHERE id=?').run(JSON.stringify({plannedCalls:requests.length,usedCalls:result.used,failedCalls:result.failed,unreviewedRefs:result.unreviewed,renderedEvidence:selectedImages.length,availableEvidence:ordered.length+renderCoverage.missing,semanticEligible:renderCoverage.semanticEligible,semanticCaptured:renderCoverage.semanticCaptured,screenshotFailures:renderCoverage.screenshotFailures,oversizeEvidence:imagePlan.oversize,outlineBlocks:outline.length,outlineTruncated,triageTruncated:triagePlan.truncated,textTruncated:textPlan.truncated,budgetExhausted:requests.length>maximum||imagePlan.budgetExhausted,renderFailed}),now(),context.job.id);
  await materializeAcademicReviewIssues(context.job.id,{rebuild:true});
  return{status:result.used===0||result.failed===result.used?'failed':partial?'partial':'completed',callCount:result.used};
}

function repairProposalRefs(proposal:any):string[]{if(proposal.type==='derived-html-css-patch')return proposal.targetRefs??[];const refs=[proposal.targetRef];if(proposal.captionRef)refs.push(proposal.captionRef);if(proposal.destinationRef)refs.push(proposal.destinationRef);if(Array.isArray(proposal.sourceRefs))refs.push(...proposal.sourceRefs);if(proposal.sourceRef)refs.push(proposal.sourceRef);return refs.filter((value):value is string=>typeof value==='string')}
function reviewBlock($:cheerio.CheerioAPI,targetRef:string){return $('[data-block-id]').filter((_index,element)=>$(element).attr('data-block-id')===targetRef).first()}
function blockRef(node:cheerio.Cheerio<any>):string|undefined{return node.attr('data-block-id')}
function delegatedTargets($:cheerio.CheerioAPI,issue:Parameters<Parameters<typeof registerAcademicRepairPlanner>[0]>[0]['issues'][number]):string[]{
  const refs:string[]=[];const add=(node:cheerio.Cheerio<any>)=>{const ref=blockRef(node);if(ref&&!refs.includes(ref)&&refs.length<40)refs.push(ref)};
  for(const targetRef of issue.targetRefs){
    const target=reviewBlock($,targetRef);if(!target.length)continue;add(target);
    if(issue.issueCode==='broken-reading-order'){
      for(const direction of['prev','next']as const){let sibling=target[direction]();while(sibling.length&&refs.length<8&&/^h[1-6]$/i.test(sibling.get(0)!.tagName)){add(sibling);sibling=sibling[direction]()}}
    }
    if(issue.issueCode==='caption-association'){
      let sibling=target.prev();for(let index=0;index<2&&sibling.length;index++,sibling=sibling.prev())add(sibling);
      sibling=target.next();for(let index=0;index<2&&sibling.length;index++,sibling=sibling.next())add(sibling);
      const figure=target.is('figure')?target:target.closest('figure');if(figure.length){add(figure);figure.find('[data-block-id]').each((_index,node)=>add($(node)))}
    }
    if(issue.issueCode==='template-chrome'){
      const page=target.closest('.pdf-source-page');if(page.length)page.find('[data-block-id]').each((_index,node)=>{const candidate=$(node),text=candidate.text().replace(/\s+/g,' ').trim();if(candidate.is('.pdf-visual-fallback-note')||candidate.is('figcaption')&&/^Original PDF page \d+$/i.test(text))add(candidate)});
      for(const sibling of[target.prev(),target.next()]){const text=sibling.text().replace(/\s+/g,' ').trim();if(sibling.is('.pdf-visual-fallback-note')||sibling.is('figcaption')&&/^Original PDF page \d+$/i.test(text))add(sibling)}
    }
  }
  return refs;
}
async function planAcademicReviewRepairs(input:Parameters<Parameters<typeof registerAcademicRepairPlanner>[0]>[0]){
  const issues=input.issues;
  const job=row<{status:string;stage:string;call_count:number;max_calls:number}>('SELECT status,stage,call_count,max_calls FROM import_jobs WHERE id=?',input.jobId);if(!job||job.status!=='review-ready'||job.stage==='review-rebuild')throw Object.assign(new Error('Import review is not ready for repair planning'),{statusCode:409});
  const root=resolve(config.dataDir,'imports',input.jobId),active=row<{html_path:string}>("SELECT html_path FROM import_review_revisions WHERE import_job_id=? AND status='active'",input.jobId),htmlPath=resolve(active?.html_path??join(root,'preview.html'));if(!htmlPath.startsWith(root+sep))throw new Error('Review derivative path is outside its job directory');
  const html=await readFile(htmlPath,'utf8'),$=cheerio.load(html),authorizedTargetRefs=Object.fromEntries(issues.map(issue=>[issue.id,input.strategy==='delegate'?delegatedTargets($,issue):issue.targetRefs.filter(ref=>reviewBlock($,ref).length)])),targetRefs=[...new Set(Object.values(authorizedTargetRefs).flat())];if(!targetRefs.length)throw Object.assign(new Error(input.strategy==='delegate'?'Selected confirmed issues have no bounded document targets AI can edit.':'Selected review issues have no repairable document targets'),{statusCode:409});if(targetRefs.length>40)throw Object.assign(new Error('Select at most 40 document targets for one repair batch'),{statusCode:400});
  const fragments=targetRefs.map(targetRef=>{const node=reviewBlock($,targetRef);if(!node.length)throw Object.assign(new Error(`Repair target no longer exists: ${targetRef}`),{statusCode:409});const serialized=$.html(node),issueIds=issues.filter(issue=>authorizedTargetRefs[issue.id]?.includes(targetRef)).map(issue=>issue.id);return{targetRef,issueIds,tag:node.get(0)!.tagName,html:serialized.length>6_000?`${serialized.slice(0,5_980)}…[TRUNCATED]`:serialized}}),evidenceRefs=[...new Set(issues.flatMap(issue=>issue.evidence.map((item:any)=>typeof item?.id==='string'?item.id:'').filter(Boolean)))],images=(await evidenceImagesForIssue(input.jobId,evidenceRefs)).images,reserved=db.prepare("UPDATE import_jobs SET call_count=call_count+1,updated_at=? WHERE id=? AND status='review-ready' AND stage IN ('review','publish-failed') AND call_count+1<=MIN(max_calls,40)").run(now(),input.jobId);
  if(!reserved.changes)throw Object.assign(new Error('No model-call budget remains for repair planning'),{statusCode:409});const ordinal=row<{call_count:number}>('SELECT call_count FROM import_jobs WHERE id=?',input.jobId)!.call_count,byIssue=new Map(issues.map(issue=>[issue.id,issue]));
  const result=await runImportRepairPlan({jobId:input.jobId,ordinal,strategy:input.strategy,issues:issues.map(issue=>({id:issue.id,issueCode:issue.issueCode,severity:issue.severity,description:issue.description,verificationStatus:issue.verificationStatus,targetRefs:authorizedTargetRefs[issue.id],evidence:issue.evidence.map((item:any)=>({id:item?.id??null,kind:item?.kind??null,label:item?.label??null}))})),reviewerInstructions:issues.map(issue=>({issueId:issue.id,decision:issue.feedback?.decision??null,reason:issue.feedback?.reason??null,comment:issue.feedback?.comment??null,note:issue.feedback?.reviewerNote??null})),targetFragments:fragments,allowedIssueIds:issues.map(issue=>issue.id),targetRefs,...(images.length?{images}:{})});
  const proposals=[] as unknown[];for(const item of result.plan.proposals){if(!item.proposal)continue;const issue=byIssue.get(item.issueId),allowed=authorizedTargetRefs[item.issueId]??[];if(!issue||!repairProposalRefs(item.proposal).every(ref=>allowed.includes(ref)))throw new Error('Repair planner returned an operation outside its issue-specific target envelope');proposals.push({issueId:item.issueId,rationale:item.rationale,proposal:item.proposal})}if(!proposals.length)throw Object.assign(new Error(input.strategy==='delegate'?'AI could not produce a bounded repair candidate for the confirmed issues. The issues remain confirmed; add a more specific instruction or handle them after publishing.':'The repair planner found no safe automatic operation for the selected issues; keep the comments for manual follow-up or select different issues.'),{statusCode:409});
  return{proposals,modelRunId:result.runId,authorizedTargetRefs};
}

export function installAcademicReviewHook():void{
  registerAcademicReviewHook(context=>reviewAcademicImport(context));
  registerAcademicIssueAdjudicator((jobId,issueIds)=>recheckAcademicReviewIssues(jobId,issueIds??listAcademicReviewIssues(jobId).filter(issue=>issue.status==='pending'&&!['rejected','resolved'].includes(issue.verificationStatus)).map(issue=>issue.id)));
  registerAcademicReviewRebuilder(async jobId=>{const result=await rebuildAcademicImportReview(jobId,context=>reviewAcademicImport(context)),reviewIssues=await materializeAcademicReviewIssues(jobId,{rebuild:true});return{...result,reviewIssues}});
  registerAcademicRepairPlanner(planAcademicReviewRepairs);
}
