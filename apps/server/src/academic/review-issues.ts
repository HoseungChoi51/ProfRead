import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import { importRepairProposalSchema, type ImportRepairProposal } from '@afterdraft/shared';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db, now, row, rows } from '../db/index.js';
import { config } from '../config.js';
import { sanitizeDocument, sanitizeSvgAsset } from '../ingest/sanitize.js';
import { latestReviewerFeedback, reviewerFeedbackForIssue, type ReviewerFeedback } from './reviewer-feedback.js';
import { reviewerGuidanceForJob } from './reviewer-policies.js';

type VerificationStatus='unverified'|'confirmed'|'rejected'|'resolved';
type RawFinding={id:string;source:'deterministic'|'model';issue_code:string;severity:'info'|'warning'|'error';title:string;description:string;source_comparison:string;target_ref:string|null;evidence_json:string;repair_json:string|null;confidence:'low'|'medium'|'high'|null;corroborated:number;decision:'pending'|'accepted'|'dismissed'|'manual';model_run_id:string|null;source_action:string|null;created_at:string};
type StoredIssue={id:string;import_job_id:string;fingerprint:string;issue_code:string;severity:'info'|'warning'|'error';title:string;description:string;verification_status:VerificationStatus;verification_reason:string|null;status:'pending'|'accepted'|'dismissed'|'manual';confidence:'low'|'medium'|'high'|null;corroborated:number;target_refs_json:string;evidence_json:string;source_actions_json:string;policy_ids_json:string;proposed_repair_json:string|null;repairable:number;adjudication_json:string|null;adjudication_model_run_id:string|null;created_at:string;updated_at:string};
export type AcademicReviewIssue={
  id:string;jobId:string;fingerprint:string;issueCode:string;severity:'info'|'warning'|'error';title:string;description:string;
  verificationStatus:VerificationStatus;verificationReason:string|null;status:'pending'|'accepted'|'dismissed'|'manual';
  confidence:'low'|'medium'|'high'|null;corroborated:boolean;findingIds:string[];targetRefs:string[];evidence:unknown[];
  sourceActions:string[];policyIds:string[];proposedRepair:ImportRepairProposal|null;repairable:boolean;feedback:ReviewerFeedback|null;
  adjudication:unknown|null;adjudicationModelRunId:string|null;createdAt:string;updatedAt:string;
};
const representationOnlyCodes=new Set(['missing-content','duplicate-content','table-overflow','broken-reading-order','caption-association','unreadable-layout']);
const severityRank={info:0,warning:1,error:2}as const,confidenceRank={low:0,medium:1,high:2}as const;
function parseJson<T>(value:string|null|undefined,fallback:T):T{if(!value)return fallback;try{return JSON.parse(value) as T}catch{return fallback}}
function unique<T>(values:T[]):T[]{return[...new Set(values)]}
function inside(root:string,path:string):boolean{return resolve(path).startsWith(resolve(root)+sep)}
function evidenceId(value:unknown):string{return typeof value==='object'&&value!==null&&typeof(value as any).id==='string'?(value as any).id:''}
function evidenceKind(value:unknown):string{return typeof value==='object'&&value!==null&&typeof(value as any).kind==='string'?(value as any).kind:''}
export function publicAcademicReviewEvidence(jobId:string,value:unknown):unknown{
  if(Array.isArray(value))return value.map(item=>publicAcademicReviewEvidence(jobId,item));
  if(!value||typeof value!=='object')return value;
  const source=value as Record<string,unknown>,safe:Record<string,unknown>={};
  for(const[key,item]of Object.entries(source)){if(/^(?:storage_?path|relative_?path|path|bytes?|byte_?size|content|data|base64)$/i.test(key))continue;safe[key]=publicAcademicReviewEvidence(jobId,item)}
  const mimeType=typeof safe.mimeType==='string'?safe.mimeType:typeof safe.mime_type==='string'?safe.mime_type:null;
  if(typeof safe.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(safe.id)&&mimeType&&/^image\/(?:png|jpeg|webp)$/.test(mimeType)){safe.mimeType=mimeType;delete safe.mime_type;safe.url=`/api/import-jobs/${jobId}/evidence/${safe.id}`}
  return safe;
}
function publicIssue(item:StoredIssue,findingIds:string[],feedback:ReviewerFeedback|null):AcademicReviewIssue{return{
  id:item.id,jobId:item.import_job_id,fingerprint:item.fingerprint,issueCode:item.issue_code,severity:item.severity,title:item.title,description:item.description,
  verificationStatus:item.verification_status,verificationReason:item.verification_reason,status:item.status,confidence:item.confidence,corroborated:Boolean(item.corroborated),
  findingIds,targetRefs:parseJson(item.target_refs_json,[]),evidence:publicAcademicReviewEvidence(item.import_job_id,parseJson(item.evidence_json,[])) as unknown[],sourceActions:parseJson(item.source_actions_json,[]),policyIds:parseJson(item.policy_ids_json,[]),
  proposedRepair:item.proposed_repair_json?parseJson(item.proposed_repair_json,null):null,repairable:Boolean(item.repairable),feedback,
  adjudication:parseJson(item.adjudication_json,null),adjudicationModelRunId:item.adjudication_model_run_id,createdAt:item.created_at,updatedAt:item.updated_at,
}}
export function listAcademicReviewIssues(jobId:string):AcademicReviewIssue[]{
  const feedback=latestReviewerFeedback(jobId),items=rows<StoredIssue>(`SELECT i.* FROM import_review_issues i WHERE i.import_job_id=? AND EXISTS(SELECT 1 FROM import_review_issue_findings x WHERE x.issue_id=i.id) ORDER BY CASE i.verification_status WHEN 'confirmed' THEN 0 WHEN 'unverified' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,CASE i.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,i.created_at,i.id`,jobId);
  const findingRows=rows<{issue_id:string;finding_id:string}>('SELECT x.issue_id,x.finding_id FROM import_review_issue_findings x JOIN import_review_issues i ON i.id=x.issue_id WHERE i.import_job_id=? ORDER BY x.finding_id',jobId),byIssue=new Map<string,string[]>();
  for(const link of findingRows)byIssue.set(link.issue_id,[...(byIssue.get(link.issue_id)??[]),link.finding_id]);
  return items.map(item=>publicIssue(item,byIssue.get(item.id)??[],feedback.get(item.id)??null));
}
function semanticTargetMap(html:string):{semantic:(target:string|null)=>string;svgFor:(target:string)=>string|null;doc:cheerio.CheerioAPI}{
  const $=cheerio.load(html),semantic=(target:string|null):string=>{if(!target)return'';const node=$(`[data-block-id="${target}"]`).first();if(!node.length)return target;const figure=node.is('figure')?node:node.closest('figure');return figure.attr('data-block-id')??target},svgFor=(target:string):string|null=>{const node=$(`[data-block-id="${target}"]`).first();const svg=node.is('svg')?node:(node.is('figure')?node.find('svg').first():node.closest('figure').find('svg').first());return svg.attr('data-block-id')??null};return{semantic,svgFor,doc:$};
}
function fixedDimensionAttributes(attributes:Record<string,string|undefined>):boolean{const style=attributes.style??'';return Boolean(attributes.width||attributes.height)||/(?:^|;)\s*(?:width|height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|pc|in|cm|mm)(?:\s*!important)?\s*(?:;|$)/i.test(style)}
function fixedDimension(node:cheerio.Cheerio<any>):boolean{return fixedDimensionAttributes((node.get(0)as any)?.attribs??{})}
function fixedDimensionInObject(node:cheerio.Cheerio<any>):boolean{const figure=node.is('figure')?node:node.closest('figure');return fixedDimension(node)||Boolean(figure.length&&(fixedDimension(figure)||figure.find('img,svg,video,table').toArray().some(element=>fixedDimensionAttributes((element as any).attribs??{}))))}
function normalizedViewBox(value:string|undefined):string|null{if(!value||value.length>160)return null;const values=value.trim().split(/[\s,]+/).map(Number);return values.length===4&&values.every(Number.isFinite)&&values[2]!>0&&values[3]!>0&&values.every(number=>Math.abs(number)<=1e7)?values.join(' '):null}
type SvgSemantics={viewBox:string|null;markerIds:string[];markerRefs:string[]};
function svgSemantics($:cheerio.CheerioAPI,svg:cheerio.Cheerio<any>):SvgSemantics|null{const sanitized=sanitizeSvgAsset($.html(svg)??'');if(!sanitized)return null;const safe=cheerio.load(sanitized,{xmlMode:true}),root=safe('svg').first(),markerIds=unique(root.find('marker[id]').map((_index,node)=>safe(node).attr('id')??'').get().filter(Boolean)),markerRefs:string[]=[];root.find('*').addBack().each((_index,node)=>{const item=safe(node),style=item.attr('style')??'';for(const name of['marker-start','marker-mid','marker-end']){const raw=item.attr(name)??style.split(';').map(value=>value.trim()).find(value=>value.toLowerCase().startsWith(`${name}:`))?.slice(name.length+1),match=raw?.match(/url\(\s*['"]?#([A-Za-z0-9_.:-]+)['"]?\s*\)/i);if(match?.[1])markerRefs.push(match[1])}});return{viewBox:normalizedViewBox(root.attr('viewBox')??root.attr('viewbox')),markerIds,markerRefs:unique(markerRefs)}}
async function sourceSvgSemantics(jobId:string):Promise<Map<string,SvgSemantics>>{
  const views=new Map<string,SvgSemantics>(),job=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId);if(!job?.result_json)return views;const result=parseJson<{bundleDirectory?:string;entryPath?:string}>(job.result_json,{}),root=join(config.dataDir,'imports',jobId),path=result.bundleDirectory&&result.entryPath?resolve(result.bundleDirectory,result.entryPath):'';if(!path||!inside(root,path))return views;
  const expected=sanitizeDocument(await readFile(path,'utf8'),result.entryPath??'document.html',()=>null),source=cheerio.load(expected.html);
  source('svg[data-block-id]').each((_index,node)=>{const id=source(node).attr('data-block-id'),semantics=svgSemantics(source,source(node));if(id&&semantics)views.set(id,semantics)});return views;
}
function parseRepair(value:string|null):ImportRepairProposal|null{if(!value)return null;const parsed=importRepairProposalSchema.safeParse(parseJson(value,null));return parsed.success?parsed.data:null}
function repairPrecondition(repair:ImportRepairProposal|null,map:ReturnType<typeof semanticTargetMap>,sourceViews:Map<string,SvgSemantics>):ImportRepairProposal|null{
  if(!repair)return null;const node=map.doc(`[data-block-id="${repair.targetRef}"]`).first();if(!node.length)return null;
  if(repair.type==='clear-fixed-dimensions')return fixedDimensionInObject(node)?repair:null;
  if(repair.type==='restore-svg-semantics'){const svg=node.is('svg')?node:(node.is('figure')?node.find('svg').first():node.closest('figure').find('svg').first()),svgId=svg.attr('data-block-id'),source=svgId?sourceViews.get(svgId):null,current=svg.length?svgSemantics(map.doc,svg):null,lost=Boolean(source&&current&&((source.viewBox&&source.viewBox!==current.viewBox)||source.markerIds.some(id=>!current.markerIds.includes(id))||source.markerRefs.some(id=>!current.markerRefs.includes(id))));return lost&&svgId?{type:'restore-svg-semantics',targetRef:svgId}:null}
  if(repair.type==='wrap-overflow')return node.is('table')?repair:null;
  if(repair.type==='set-object-layout')return node.is('figure,img,svg,table,video,math')&&repair.width!=='auto'?repair:null;
  return null;
}
type Group={items:RawFinding[];fingerprint:string;semanticTarget:string;evidence:unknown[];targetRefs:string[];sourceActions:string[]};
function classify(group:Group):{status:VerificationStatus;reason:string;corroborated:boolean}{
  const deterministic=group.items.some(item=>item.source==='deterministic'),explicit=group.items.some(item=>Boolean(item.corroborated));
  if(deterministic)return{status:'confirmed',reason:'Confirmed by deterministic validation.',corroborated:true};
  if(explicit)return{status:'confirmed',reason:'Confirmed by deterministic render measurements.',corroborated:true};
  const ids=group.evidence.map(evidenceId),representationOnly=ids.length>0&&ids.every(id=>id==='outline'||/^text-/.test(id));
  if(representationOnly&&representationOnlyCodes.has(group.items[0]!.issue_code))return{status:'rejected',reason:'Rejected as a lossy outline/text representation artifact; full DOM or visual evidence is required.',corroborated:false};
  return{status:'unverified',reason:'Requires stronger source, DOM, or visual evidence.',corroborated:false};
}
export async function materializeAcademicReviewIssues(jobId:string,options:{rebuild?:boolean}={}):Promise<AcademicReviewIssue[]>{
  const job=row<{id:string}>('SELECT id FROM import_jobs WHERE id=?',jobId);if(!job)throw Object.assign(new Error('Import job not found'),{statusCode:404});
  const findings=rows<RawFinding>(`SELECT f.*,r.action source_action FROM import_findings f LEFT JOIN model_runs r ON r.id=f.model_run_id WHERE f.import_job_id=? ORDER BY f.created_at,f.id`,jobId),previewPath=join(config.dataDir,'imports',jobId,'preview.html'),preview=await readFile(previewPath,'utf8').catch(()=>'<html><body></body></html>'),map=semanticTargetMap(preview),sourceViews=await sourceSvgSemantics(jobId).catch(()=>new Map<string,SvgSemantics>());
  const groups=new Map<string,Group>();
  for(const item of findings){const semanticTarget=map.semantic(item.target_ref),key=`${item.issue_code}\0${semanticTarget||item.target_ref||item.id}`,fingerprint=createHash('sha256').update(key).digest('hex'),evidence=parseJson<unknown[]>(item.evidence_json,[]),existing=groups.get(fingerprint)??{items:[],fingerprint,semanticTarget,evidence:[],targetRefs:[],sourceActions:[]};existing.items.push(item);existing.evidence.push(...evidence);if(item.target_ref)existing.targetRefs.push(item.target_ref);const repair=parseRepair(item.repair_json);if(repair)existing.targetRefs.push(repair.targetRef);if(item.source_action)existing.sourceActions.push(item.source_action);groups.set(fingerprint,existing)}
  const time=now();void options.rebuild;db.exec('BEGIN IMMEDIATE');try{
    db.prepare('DELETE FROM import_review_issue_findings WHERE issue_id IN (SELECT id FROM import_review_issues WHERE import_job_id=?)').run(jobId);
    for(const group of groups.values()){
      group.evidence=[...new Map(group.evidence.map(item=>[evidenceId(item)||JSON.stringify(item),item])).values()];group.targetRefs=unique(group.targetRefs);group.sourceActions=unique(group.sourceActions);
      let classification=classify(group);const issueCode=group.items[0]!.issue_code,evidenceKinds=unique(group.evidence.map(evidenceKind).filter(Boolean)),sources=unique(group.items.map(item=>item.source)),policies=reviewerGuidanceForJob(jobId,{issueCode,evidenceKinds,sources,sourceActions:group.sourceActions}),policyIds=policies.map(policy=>policy.id),rawRepair=group.items.map(item=>parseRepair(item.repair_json)).find(Boolean)??null,svgRef=issueCode==='figure-cropped'?map.svgFor(group.semanticTarget):null,semanticRepair=svgRef?repairPrecondition({type:'restore-svg-semantics',targetRef:svgRef},map,sourceViews):null;let repair=semanticRepair??repairPrecondition(rawRepair,map,sourceViews);
      if(semanticRepair)classification={status:'confirmed',reason:'Confirmed by deterministic comparison with safe SVG semantics in the immutable source.',corroborated:true};
      if(classification.status==='rejected')repair=null;
      if(repair)group.targetRefs=unique([...group.targetRefs,repair.targetRef]);
      const severity=classification.status==='rejected'?'info':group.items.reduce((best,item)=>severityRank[item.severity]>severityRank[best]?item.severity:best,'info' as RawFinding['severity']);
      const confidence=group.items.map(item=>item.confidence).filter(Boolean).reduce((best,value)=>!best||confidenceRank[value!]<confidenceRank[best]?value!:best,null as RawFinding['confidence']),title=group.items[0]!.title,description=group.items.map(item=>item.description).sort((a,b)=>b.length-a.length)[0]!,legacyStatuses=unique(group.items.map(item=>item.decision)),initialStatus=legacyStatuses.length===1?legacyStatuses[0]!:'pending',id=`review-${createHash('sha256').update(jobId).update('\0').update(group.fingerprint).digest('hex').slice(0,24)}`;
      if(initialStatus==='dismissed'){classification={status:'rejected',reason:'Rejected by the human reviewer as a false positive.',corroborated:false};repair=null}else if(initialStatus==='manual'){classification={status:'resolved',reason:'The human reviewer chose to handle this issue after publishing.',corroborated:false};repair=null}
      db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,verification_reason,status,confidence,corroborated,target_refs_json,evidence_json,source_actions_json,policy_ids_json,proposed_repair_json,repairable,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(import_job_id,fingerprint) DO UPDATE SET issue_code=excluded.issue_code,severity=excluded.severity,title=excluded.title,description=excluded.description,verification_status=CASE WHEN import_review_issues.status='dismissed' THEN 'rejected' WHEN import_review_issues.status='manual' OR import_review_issues.verification_status='resolved' THEN 'resolved' ELSE excluded.verification_status END,verification_reason=CASE WHEN import_review_issues.status IN ('dismissed','manual') OR import_review_issues.verification_status='resolved' THEN import_review_issues.verification_reason ELSE excluded.verification_reason END,confidence=excluded.confidence,corroborated=excluded.corroborated,target_refs_json=excluded.target_refs_json,evidence_json=excluded.evidence_json,source_actions_json=excluded.source_actions_json,policy_ids_json=excluded.policy_ids_json,proposed_repair_json=CASE WHEN import_review_issues.status IN ('dismissed','manual') THEN NULL ELSE excluded.proposed_repair_json END,repairable=CASE WHEN import_review_issues.status IN ('dismissed','manual') THEN 0 ELSE excluded.repairable END,updated_at=excluded.updated_at`)
        .run(id,jobId,group.fingerprint,issueCode,severity,title,description,classification.status,classification.reason,initialStatus,confidence,Number(classification.corroborated),JSON.stringify(group.targetRefs),JSON.stringify(group.evidence),JSON.stringify(group.sourceActions),JSON.stringify(policyIds),repair?JSON.stringify(repair):null,Number(Boolean(repair)),group.items[0]!.created_at,time);
      const issue=row<{id:string}>('SELECT id FROM import_review_issues WHERE import_job_id=? AND fingerprint=?',jobId,group.fingerprint)!;for(const finding of group.items)db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issue.id,finding.id);
    }
    db.prepare('DELETE FROM import_review_issues WHERE import_job_id=? AND NOT EXISTS(SELECT 1 FROM import_review_issue_findings x WHERE x.issue_id=import_review_issues.id)').run(jobId);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return listAcademicReviewIssues(jobId);
}
const adjudicationSchema=z.object({issueId:z.string().min(1),verificationStatus:z.enum(['unverified','confirmed','rejected']),reason:z.string().trim().min(1).max(4000),repair:importRepairProposalSchema.nullable().optional(),modelRunId:z.string().min(1).nullable().optional(),report:z.unknown().optional()}).strict();
export function applyAcademicAdjudication(jobId:string,input:unknown):AcademicReviewIssue[]{
  const values=z.array(adjudicationSchema).min(1).max(200).parse(Array.isArray(input)?input:[input]),time=now();db.exec('BEGIN IMMEDIATE');try{
    for(const value of values){const issue=row<{id:string;deterministic:number}>(`SELECT i.id,EXISTS(SELECT 1 FROM import_review_issue_findings x JOIN import_findings f ON f.id=x.finding_id WHERE x.issue_id=i.id AND f.source='deterministic') deterministic FROM import_review_issues i WHERE i.id=? AND i.import_job_id=?`,value.issueId,jobId);if(!issue)throw Object.assign(new Error('Review issue not found'),{statusCode:404});if(issue.deterministic&&value.verificationStatus!=='confirmed')throw Object.assign(new Error('Model adjudication cannot downgrade deterministic confirmation'),{statusCode:409});const report={verificationStatus:value.verificationStatus,reason:value.reason,repair:value.repair??null,report:value.report??null};db.prepare('INSERT INTO import_review_adjudications(id,import_job_id,review_issue_id,model_run_id,report_json,created_at)VALUES(?,?,?,?,?,?)').run(nanoid(),jobId,value.issueId,value.modelRunId??null,JSON.stringify(report),time);db.prepare('UPDATE import_review_issues SET verification_status=?,verification_reason=?,proposed_repair_json=?,repairable=?,adjudication_json=?,adjudication_model_run_id=?,updated_at=? WHERE id=? AND import_job_id=?').run(value.verificationStatus,value.reason,value.repair?JSON.stringify(value.repair):null,Number(Boolean(value.repair)),JSON.stringify(report),value.modelRunId??null,time,value.issueId,jobId)}
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}return listAcademicReviewIssues(jobId);
}
export function adjudicateAcademicReviewIssues(jobId:string,issueIds?:string[]):{reviewIssues:AcademicReviewIssue[];policyApplications:Array<{issueId:string;policyIds:string[]}>}{
  const issues=listAcademicReviewIssues(jobId).filter(issue=>!issueIds||issueIds.includes(issue.id)),applications=issues.map(issue=>{const evidenceKinds=unique(issue.evidence.map(evidenceKind).filter(Boolean)),sources=unique(rows<{source:string}>(`SELECT DISTINCT f.source FROM import_review_issue_findings x JOIN import_findings f ON f.id=x.finding_id WHERE x.issue_id=?`,issue.id).map(item=>item.source)),subject={issueCode:issue.issueCode,evidenceKinds,sources,sourceActions:issue.sourceActions};return{issueId:issue.id,policyIds:reviewerGuidanceForJob(jobId,subject).map(policy=>policy.id)}});return{reviewIssues:listAcademicReviewIssues(jobId),policyApplications:applications};
}
export function reviewIssue(id:string):AcademicReviewIssue|null{const item=row<StoredIssue>('SELECT * FROM import_review_issues WHERE id=?',id);if(!item)return null;const findingIds=rows<{finding_id:string}>('SELECT finding_id FROM import_review_issue_findings WHERE issue_id=? ORDER BY finding_id',id).map(value=>value.finding_id);return publicIssue(item,findingIds,reviewerFeedbackForIssue(id))}

export type AcademicIssueAdjudicator=(jobId:string,issueIds?:string[])=>Promise<unknown>;
export type AcademicReviewRebuilder=(jobId:string)=>Promise<unknown>;
let academicIssueAdjudicator:AcademicIssueAdjudicator|undefined,academicReviewRebuilder:AcademicReviewRebuilder|undefined;
export function registerAcademicIssueAdjudicator(value:AcademicIssueAdjudicator):void{academicIssueAdjudicator=value}
export function registerAcademicReviewRebuilder(value:AcademicReviewRebuilder):void{academicReviewRebuilder=value}
export async function runAcademicIssueAdjudication(jobId:string,issueIds?:string[]):Promise<unknown>{
  if(!academicIssueAdjudicator)throw Object.assign(new Error('Academic issue adjudicator is not available'),{statusCode:503});
  return academicIssueAdjudicator(jobId,issueIds);
}
export async function rebuildAcademicReview(jobId:string):Promise<unknown>{
  if(!academicReviewRebuilder)throw Object.assign(new Error('Full academic review rebuild is not available'),{statusCode:503});
  return academicReviewRebuilder(jobId);
}
