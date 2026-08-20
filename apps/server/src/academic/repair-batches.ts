import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  academicRepairBatchProposalSchema,
  type AcademicRepairBatchProposal,
  type DocumentEditOperation,
  type ImportRepairProposal,
} from '@afterdraft/shared';
import { config } from '../config.js';
import { db, now, row, rows } from '../db/index.js';
import { applyDocumentEditOperations } from '../edits/index.js';
import { sanitizeDocument, sanitizeSvgAsset } from '../ingest/sanitize.js';
import { stagedResultSchema } from './persistence.js';
import { importRepairOperation } from './repairs.js';
import { listAcademicReviewIssues, type AcademicReviewIssue } from './review-issues.js';

export type AcademicRepairOperation={id:string;proposal:AcademicRepairBatchProposal;issueIds:string[];rationale?:string};
export type AcademicRepairBatch={
  id:string;jobId:string;status:'draft'|'accepted'|'reverted'|'stale'|'failed';baseDerivativeHash:string;
  candidateDerivativeHash:string|null;operations:AcademicRepairOperation[];selectedOperationIds:string[]|null;
  validation:Record<string,unknown>|null;error:string|null;issueIds:string[];previewUrl:string|null;
  createdAt:string;updatedAt:string;acceptedAt:string|null;revertedAt:string|null;
};
export type AcademicReviewRevision={id:string;jobId:string;repairBatchId:string;parentRevisionId:string|null;status:'candidate'|'active'|'reverted'|'stale';baseDerivativeHash:string;candidateDerivativeHash:string;canonicalHash:string;inventoryHash:string;operations:AcademicRepairOperation[];createdAt:string;activatedAt:string|null;revertedAt:string|null};
export type AcademicRepairPlanner=(input:{jobId:string;issues:AcademicReviewIssue[];baseDerivativeHash:string})=>Promise<unknown>;
let academicRepairPlanner:AcademicRepairPlanner|undefined;
export function registerAcademicRepairPlanner(planner:AcademicRepairPlanner):void{academicRepairPlanner=planner}

const createBatchSchema=z.object({issueIds:z.array(z.string().min(1).max(128)).min(1).max(100),strategy:z.enum(['direct','planner']).default('planner')}).strict();
const acceptBatchSchema=z.object({operationIds:z.array(z.string().min(1).max(128)).min(1).max(100).optional()}).strict();
const patchEnvelopeSchema=z.object({operations:z.array(z.object({targetRef:z.string().min(1).max(64),setStyle:z.record(z.string().min(1).max(40),z.string().max(160).nullable())}).strict()).min(1).max(40)}).strict();
const plannedItemSchema=z.object({issueId:z.string().min(1).max(128),rationale:z.string().trim().min(1).max(2000),proposal:academicRepairBatchProposalSchema}).strict();
const safeStyleProperties=new Set(['width','max-width','overflow','overflow-x','overflow-y','margin-left','margin-right','object-fit']);
const svgReferenceAttributes=['marker-start','marker-mid','marker-end']as const;
const svgDrawableTags=['path','g','circle','rect','line','polyline','polygon','ellipse','text','use'];
type EditedDocument=ReturnType<typeof applyDocumentEditOperations>;
type SelectedIssueSnapshot={id:string;stateHash:string};
type StoredBatch={id:string;import_job_id:string;status:AcademicRepairBatch['status'];base_derivative_hash:string;candidate_derivative_hash:string|null;operations_json:string;selected_operation_ids_json:string|null;validation_json:string|null;error:string|null;created_at:string;updated_at:string;accepted_at:string|null;reverted_at:string|null};
type StoredRevision={id:string;import_job_id:string;repair_batch_id:string;parent_revision_id:string|null;status:AcademicReviewRevision['status'];base_derivative_hash:string;candidate_derivative_hash:string;html_path:string;canonical_hash:string;inventory_hash:string;operations_json:string;created_at:string;activated_at:string|null;reverted_at:string|null};
function fail(message:string,statusCode=400):never{throw Object.assign(new Error(message),{statusCode})}
function parseJson<T>(value:string|null|undefined,fallback:T):T{if(!value)return fallback;try{return JSON.parse(value)as T}catch{return fallback}}
function hash(value:string|Buffer):string{return createHash('sha256').update(value).digest('hex')}
function inside(root:string,path:string):boolean{return resolve(path).startsWith(resolve(root)+sep)}
function findBlock($:cheerio.CheerioAPI,id:string):cheerio.Cheerio<any>{return $('[data-block-id]').filter((_index,node)=>$(node).attr('data-block-id')===id).first()}
function inventoryHash(html:string):string{const $=cheerio.load(html),items:string[]=[];$('[src],[href],[poster],[srcset],[style]').each((_index,element)=>{const node=$(element);for(const name of['src','href','poster','srcset']){const value=node.attr(name)?.trim();if(value&&!value.startsWith('#'))items.push(`${name}:${value}`)}for(const match of(node.attr('style')??'').matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi))if(match[1]&&!match[1].startsWith('#'))items.push(`url:${match[1]}`)});return hash(items.sort().join('\n'))}
function validViewBox(value:string|undefined):string|null{if(!value||value.length>160)return null;const values=value.trim().split(/[\s,]+/).map(Number);return values.length===4&&values.every(Number.isFinite)&&values[2]!>0&&values[3]!>0&&values.every(number=>Math.abs(number)<=1e7)?values.join(' '):null}
function findSvg($:cheerio.CheerioAPI,targetRef:string):cheerio.Cheerio<any>{const target=findBlock($,targetRef);return target.is('svg')?target:target.is('figure')?target.find('svg').first():target.closest('figure').find('svg').first()}
function safeLocalMarker(value:string|undefined,ids:Set<string>):string|null{const match=value?.trim().match(/^url\(\s*['"]?#([A-Za-z0-9_.:-]+)['"]?\s*\)$/i);return match?.[1]&&ids.has(match[1])?`url(#${match[1]})`:null}
function drawableNodes($:cheerio.CheerioAPI,svg:cheerio.Cheerio<any>,tag:string):cheerio.Cheerio<any>[] {return svg.find(tag).filter((_index,node)=>$(node).parents('marker').length===0).toArray().map(node=>$(node))}
function restoreSvgSemantics(candidateHtml:string,sourceHtml:string,targetRef:string):string{
  const targetDoc=cheerio.load(candidateHtml),targetSvg=findSvg(targetDoc,targetRef);if(!targetSvg.length)fail(`SVG repair target no longer exists: ${targetRef}`,409);
  // Recreate the expected derivative from the immutable source so stable block IDs,
  // rather than brittle document ordinals, identify the corresponding SVG.
  const expected=sanitizeDocument(sourceHtml,'document.html',()=>null).html,sourceDoc=cheerio.load(expected),sourceSvg=findSvg(sourceDoc,targetRef);if(!sourceSvg.length)fail('The immutable source has no corresponding SVG block',409);const sanitized=sanitizeSvgAsset(sourceDoc.html(sourceSvg)??'');if(!sanitized)fail('The immutable source SVG failed safety validation',409);const safeDoc=cheerio.load(sanitized,{xmlMode:true}),safeSvg=safeDoc('svg').first(),viewBox=validViewBox(safeSvg.attr('viewBox')??safeSvg.attr('viewbox'));if(viewBox)targetSvg.attr('viewBox',viewBox).removeAttr('viewbox');
  const markers=safeSvg.find('marker[id]').filter((_index,node)=>/^[A-Za-z0-9_.:-]{1,128}$/.test(safeDoc(node).attr('id')??'')),ids=new Set(markers.toArray().map(node=>safeDoc(node).attr('id')!));if(markers.length){let defs=targetSvg.children('defs').first();if(!defs.length){targetSvg.prepend('<defs></defs>');defs=targetSvg.children('defs').first()}for(const marker of markers.toArray()){const id=safeDoc(marker).attr('id')!;defs.find('marker').filter((_index,node)=>targetDoc(node).attr('id')===id).remove();defs.append(safeDoc.html(marker)??'')}}
  for(const tag of svgDrawableTags){const sources=drawableNodes(safeDoc,safeSvg,tag),targets=drawableNodes(targetDoc,targetSvg,tag);for(let index=0;index<Math.min(sources.length,targets.length);index++){const inline=new Map((sources[index]!.attr('style')??'').split(';').map(value=>value.trim()).filter(Boolean).map(value=>{const split=value.indexOf(':');return split>0?[value.slice(0,split).trim().toLowerCase(),value.slice(split+1).trim()]as const:['','']as const}));for(const name of svgReferenceAttributes){const value=safeLocalMarker(sources[index]!.attr(name)??inline.get(name),ids);if(value){const target=targets[index]!,declarations=(target.attr('style')??'').split(';').map(item=>item.trim()).filter(Boolean).filter(item=>item.slice(0,item.indexOf(':')).trim().toLowerCase()!==name);if(declarations.length)target.attr('style',declarations.join(';'));else target.removeAttr('style');target.attr(name,value)}}}}return targetDoc.html();
}
function safeStyleValue(property:string,value:string):boolean{
  if(value.length>160||/[;{}@\\]/.test(value)||/(?:url|expression|javascript|data|var)\s*\(/i.test(value))return false;
  if(property==='width')return /^(?:auto|100%|fit-content)$/.test(value);
  if(property==='max-width'){if(/^(?:none|100%)$/.test(value))return true;const match=value.match(/^(\d+(?:\.\d+)?)(px|rem|em)$/);if(!match)return false;const amount=Number(match[1])*(match[2]==='px'?1:16);return amount>0&&amount<=1600}
  if(property.startsWith('overflow'))return /^(?:auto|scroll|visible)$/.test(value);
  if(property==='margin-left'||property==='margin-right')return /^(?:auto|0)$/.test(value);
  return property==='object-fit'&&/^(?:contain|scale-down)$/.test(value);
}
export function parseDerivedHtmlCssPatch(proposal:Extract<AcademicRepairBatchProposal,{type:'derived-html-css-patch'}>):z.infer<typeof patchEnvelopeSchema>{let raw:unknown;try{raw=JSON.parse(proposal.patch)}catch{fail('Derived HTML/CSS patch must be a JSON operation envelope')}const value=patchEnvelopeSchema.parse(raw),allowedTargets=new Set(proposal.targetRefs);for(const operation of value.operations){if(!allowedTargets.has(operation.targetRef))fail('Derived patch targets a block outside its declared envelope');for(const[property,styleValue]of Object.entries(operation.setStyle))if(!safeStyleProperties.has(property)||styleValue!==null&&!safeStyleValue(property,styleValue))fail(`Unsafe derived style declaration: ${property}`)}return value}
function applyDerivedPatch(html:string,proposal:Extract<AcademicRepairBatchProposal,{type:'derived-html-css-patch'}>):string{const $=cheerio.load(html),patch=parseDerivedHtmlCssPatch(proposal);for(const operation of patch.operations){const node=findBlock($,operation.targetRef);if(!node.length)fail(`Derived patch target no longer exists: ${operation.targetRef}`,409);const styles=new Map((node.attr('style')??'').split(';').map(value=>value.trim()).filter(Boolean).map(value=>{const split=value.indexOf(':');return split>0?[value.slice(0,split).trim().toLowerCase(),value.slice(split+1).trim()]as const:['',value]as const}).filter(([key])=>key));for(const[property,value]of Object.entries(operation.setStyle)){if(value===null)styles.delete(property);else styles.set(property,value)}const serialized=[...styles].map(([property,value])=>`${property}:${value}`).join(';');if(serialized)node.attr('style',serialized);else node.removeAttr('style')}return $.html()}
function proposalTargetRefs(proposal:AcademicRepairBatchProposal):string[]{return proposal.type==='derived-html-css-patch'?proposal.targetRefs:[proposal.targetRef]}
function documentOperation(proposal:AcademicRepairBatchProposal):DocumentEditOperation|null{return proposal.type==='derived-html-css-patch'?null:importRepairOperation(proposal as ImportRepairProposal)}
function validateProposal(proposal:AcademicRepairBatchProposal,issues:AcademicReviewIssue[]):void{if(!['set-object-layout','wrap-overflow','clear-fixed-dimensions','restore-svg-semantics','derived-html-css-patch'].includes(proposal.type))fail(`Repair type is not safe for an automatic derivative: ${proposal.type}`);const targets=proposalTargetRefs(proposal),owners=issues.filter(issue=>targets.every(target=>issue.targetRefs.includes(target)));if(!owners.length)fail('Every repair proposal must be confined to one selected review issue');if(proposal.type==='derived-html-css-patch')parseDerivedHtmlCssPatch(proposal);else if(!documentOperation(proposal))fail(`Repair cannot be represented safely: ${proposal.type}`)}
function publicRevision(item:StoredRevision):AcademicReviewRevision{return{id:item.id,jobId:item.import_job_id,repairBatchId:item.repair_batch_id,parentRevisionId:item.parent_revision_id,status:item.status,baseDerivativeHash:item.base_derivative_hash,candidateDerivativeHash:item.candidate_derivative_hash,canonicalHash:item.canonical_hash,inventoryHash:item.inventory_hash,operations:parseJson(item.operations_json,[]),createdAt:item.created_at,activatedAt:item.activated_at,revertedAt:item.reverted_at}}
function publicBatch(item:StoredBatch):AcademicRepairBatch{const issueIds=rows<{review_issue_id:string}>('SELECT review_issue_id FROM import_repair_batch_issues WHERE repair_batch_id=? ORDER BY review_issue_id',item.id).map(value=>value.review_issue_id),revision=row<StoredRevision>('SELECT * FROM import_review_revisions WHERE repair_batch_id=? ORDER BY created_at DESC LIMIT 1',item.id);return{id:item.id,jobId:item.import_job_id,status:item.status,baseDerivativeHash:item.base_derivative_hash,candidateDerivativeHash:item.candidate_derivative_hash,operations:parseJson(item.operations_json,[]),selectedOperationIds:parseJson(item.selected_operation_ids_json,null),validation:parseJson(item.validation_json,null),error:item.error,issueIds,previewUrl:revision?`/api/import-jobs/${item.import_job_id}/repair-batches/${item.id}/preview`:null,createdAt:item.created_at,updatedAt:item.updated_at,acceptedAt:item.accepted_at,revertedAt:item.reverted_at}}
export function listAcademicRepairBatches(jobId:string):AcademicRepairBatch[]{return rows<StoredBatch>('SELECT * FROM import_repair_batches WHERE import_job_id=? ORDER BY created_at DESC,id DESC',jobId).map(publicBatch)}
export function academicRepairBatch(jobId:string,batchId:string):AcademicRepairBatch|null{const item=row<StoredBatch>('SELECT * FROM import_repair_batches WHERE id=? AND import_job_id=?',batchId,jobId);return item?publicBatch(item):null}
export function activeAcademicReviewRevision(jobId:string):AcademicReviewRevision|null{const item=row<StoredRevision>("SELECT * FROM import_review_revisions WHERE import_job_id=? AND status='active'",jobId);return item?publicRevision(item):null}
function activeStoredRevision(jobId:string):StoredRevision|undefined{return row<StoredRevision>("SELECT * FROM import_review_revisions WHERE import_job_id=? AND status='active'",jobId)}
function currentBaseIdentity(jobId:string):{hash:string;parentRevisionId:string|null}{const active=activeAcademicReviewRevision(jobId);if(active)return{hash:active.candidateDerivativeHash,parentRevisionId:active.id};const stored=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId);if(!stored?.result_json)fail('Import result is unavailable',409);return{hash:stagedResultSchema.parse(JSON.parse(stored.result_json)).derivativeHash,parentRevisionId:null}}
function assertReviewReady(jobId:string):void{const job=row<{status:string;stage:string}>('SELECT status,stage FROM import_jobs WHERE id=?',jobId);if(!job)fail('Import job not found',404);if(job.status!=='review-ready'||!['review','publish-failed'].includes(job.stage))fail('Repair revisions can only be changed during stable review',409)}
function assertCurrentBase(jobId:string,expected:{hash:string;parentRevisionId:string|null}):void{const current=currentBaseIdentity(jobId);if(current.hash!==expected.hash||current.parentRevisionId!==expected.parentRevisionId)fail('Repair batch is stale; rebuild it against the current derivative',409)}
const plannerReservations=new Set<string>();
function reserveRepairPlanner(jobId:string):()=>void{
  if(plannerReservations.has(jobId))fail('Repair planning is already in progress for this import',409);
  const reserved=db.prepare("UPDATE import_jobs SET stage=stage WHERE id=? AND status='review-ready' AND stage IN ('review','publish-failed')").run(jobId);
  if(reserved.changes!==1)fail('Repair planning can only start during stable review',409);
  plannerReservations.add(jobId);return()=>{plannerReservations.delete(jobId)};
}
function issuePlanState(issue:AcademicReviewIssue):string{return JSON.stringify({
  updatedAt:issue.updatedAt,status:issue.status,verificationStatus:issue.verificationStatus,verificationReason:issue.verificationReason,
  repairable:issue.repairable,proposedRepair:issue.proposedRepair,targetRefs:issue.targetRefs,
  feedback:issue.feedback?{id:issue.feedback.id,decision:issue.feedback.decision,reason:issue.feedback.reason,comment:issue.feedback.comment,reviewerNote:issue.feedback.reviewerNote,createdAt:issue.feedback.createdAt}:null,
})}
function assertIssueEligibility(issue:AcademicReviewIssue,strategy:'direct'|'planner'):void{
  if(issue.verificationStatus==='rejected'||issue.verificationStatus==='resolved'||issue.status==='dismissed'||issue.status==='manual')fail('Rejected, resolved, dismissed, or manual issues cannot enter a repair batch',409);
  if(strategy==='direct'&&(issue.verificationStatus!=='confirmed'||!issue.repairable))fail('Direct repair requires confirmed, repairable issues',409);
}
function issueSnapshots(issues:AcademicReviewIssue[]):SelectedIssueSnapshot[]{return issues.map(issue=>({id:issue.id,stateHash:hash(issuePlanState(issue))}))}
function assertSelectedIssuesUnchanged(jobId:string,snapshots:SelectedIssueSnapshot[],strategy:'direct'|'planner',context='while repair planning was in progress'):AcademicReviewIssue[]{
  const wanted=new Set(snapshots.map(item=>item.id)),issues=listAcademicReviewIssues(jobId).filter(issue=>wanted.has(issue.id));
  if(issues.length!==wanted.size)fail(`One or more selected review issues changed ${context}`,409);
  const expected=new Map(snapshots.map(item=>[item.id,item.stateHash]));
  for(const issue of issues){assertIssueEligibility(issue,strategy);if(hash(issuePlanState(issue))!==expected.get(issue.id))fail(`Selected review issue feedback or verification changed ${context}`,409)}
  return issues;
}
function persistedIssueSnapshots(validation:Record<string,unknown>,issueIds:Set<string>):SelectedIssueSnapshot[]{
  const parsed=z.array(z.object({id:z.string().min(1).max(128),stateHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).safeParse(validation.issueSnapshots);
  if(!parsed.success)fail('Repair candidate is not bound to a valid review-issue snapshot',409);
  const byId=new Map(parsed.data.map(item=>[item.id,item]));if(byId.size!==parsed.data.length)fail('Repair candidate contains duplicate review-issue snapshots',409);
  const selected=[...issueIds].map(id=>byId.get(id));if(selected.some(item=>!item))fail('Repair candidate is missing a selected review-issue snapshot',409);return selected as SelectedIssueSnapshot[];
}
async function loadCurrentBase(jobId:string){const job=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId);if(!job?.result_json)fail('Import result is unavailable',409);const staged=stagedResultSchema.parse(JSON.parse(job.result_json)),root=join(config.dataDir,'imports',jobId),entry=resolve(staged.bundleDirectory,staged.entryPath);if(!inside(root,entry))fail('Import source path is outside its immutable staging directory',409);const identity=currentBaseIdentity(jobId),active=identity.parentRevisionId?activeStoredRevision(jobId):undefined,htmlPath=active?.html_path??join(root,'preview.html');if(!inside(root,htmlPath))fail('Review derivative path is outside its job directory',409);return{...identity,html:await readFile(htmlPath,'utf8'),sourceHtml:await readFile(entry,'utf8'),staged}}
async function applyOperations(baseHtml:string,sourceHtml:string,operations:AcademicRepairOperation[]):Promise<EditedDocument&{canonicalHash:string;inventoryHash:string;changed:boolean}>{const baseline=applyDocumentEditOperations(baseHtml,[]),baselineInventory=inventoryHash(baseHtml);let html=baseHtml;for(const item of operations){const proposal=item.proposal;if(proposal.type==='derived-html-css-patch')html=applyDerivedPatch(html,proposal);else if(proposal.type==='restore-svg-semantics')html=restoreSvgSemantics(html,sourceHtml,proposal.targetRef);else{const operation=documentOperation(proposal);if(!operation)fail(`Unsupported derivative operation: ${proposal.type}`);html=applyDocumentEditOperations(html,[operation]).html}}const result=applyDocumentEditOperations(html,[],baseline.title),nextInventory=inventoryHash(result.html);if(result.canonicalText!==baseline.canonicalText)fail('A repair candidate attempted to change scholarly content',409);if(nextInventory!==baselineInventory)fail('A repair candidate attempted to change the asset inventory',409);return{...result,canonicalHash:hash(result.canonicalText),inventoryHash:nextInventory,changed:result.html!==baseline.html}}
function operationsFor(items:Array<z.infer<typeof plannedItemSchema>>,issues:AcademicReviewIssue[],strategy:'direct'|'planner'):AcademicRepairOperation[]{const byId=new Map(issues.map(issue=>[issue.id,issue])),seenIssues=new Set<string>(),operations=items.map(item=>{const issue=byId.get(item.issueId);if(!issue)fail('Repair planner returned an operation for an unselected issue');if(seenIssues.has(item.issueId))fail('Repair plan may contain at most one operation per review issue');seenIssues.add(item.issueId);validateProposal(item.proposal,[issue]);return{id:nanoid(),proposal:item.proposal,issueIds:[item.issueId],rationale:item.rationale}});if(!operations.length)fail('Repair plan contains no safe operations');if(strategy==='direct'){const covered=new Set(operations.flatMap(operation=>operation.issueIds));for(const issue of issues)if(!covered.has(issue.id))fail('Direct repair requires a validated proposal for every selected issue')}return operations}
async function plannedProposals(jobId:string,issues:AcademicReviewIssue[],baseDerivativeHash:string,strategy:'direct'|'planner'){
  if(strategy==='direct'){const items=issues.map(issue=>issue.proposedRepair?{issueId:issue.id,rationale:'Apply the validated deterministic repair for this review issue.',proposal:issue.proposedRepair}:null);if(items.some(value=>!value))fail('Direct repair requires a validated proposal for every selected issue',409);return{items:items as Array<z.infer<typeof plannedItemSchema>>,modelRunId:null,source:'deterministic' as const}}
  if(!academicRepairPlanner)fail('Academic repair planner is not available',503);
  try{const raw=await academicRepairPlanner({jobId,issues,baseDerivativeHash}),record=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{proposals:raw},items=z.array(plannedItemSchema).min(1).max(100).parse(record.proposals);for(const item of items){const issue=issues.find(candidate=>candidate.id===item.issueId);if(!issue)fail('Repair planner returned an operation for an unselected issue');validateProposal(item.proposal,[issue])}return{items,modelRunId:typeof record.modelRunId==='string'?record.modelRunId:null,source:'planner' as const}}catch(error){if((error as any)?.statusCode)throw error;fail('Academic repair planning failed safety validation',502)}
}
export async function createAcademicRepairBatch(jobId:string,input:unknown):Promise<AcademicRepairBatch>{
  const value=createBatchSchema.parse(input);assertReviewReady(jobId);
  const all=listAcademicReviewIssues(jobId),wanted=new Set(value.issueIds),issues=all.filter(issue=>wanted.has(issue.id));
  if(issues.length!==wanted.size)fail('One or more review issues do not belong to this import',404);
  for(const issue of issues)assertIssueEligibility(issue,value.strategy);
  const snapshots=issueSnapshots(issues),base=await loadCurrentBase(jobId);let planned:Awaited<ReturnType<typeof plannedProposals>>;
  if(value.strategy==='planner'){const release=reserveRepairPlanner(jobId);try{planned=await plannedProposals(jobId,issues,base.hash,value.strategy)}finally{release()}}
  else planned=await plannedProposals(jobId,issues,base.hash,value.strategy);
  assertReviewReady(jobId);const currentIssues=assertSelectedIssuesUnchanged(jobId,snapshots,value.strategy),operations=operationsFor(planned.items,currentIssues,value.strategy),candidate=await applyOperations(base.html,base.sourceHtml,operations),candidateHash=hash(candidate.html);
  if(!candidate.changed||candidateHash===base.hash)fail('Repair plan produced no change to the current derivative',409);
  const batchId=nanoid(),revisionId=nanoid(),directory=join(config.dataDir,'imports',jobId,'review-revisions'),htmlPath=join(directory,`${revisionId}.html`),time=now();
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(htmlPath,candidate.html,{flag:'wx',mode:0o600});
  try{
    db.exec('BEGIN IMMEDIATE');assertReviewReady(jobId);assertCurrentBase(jobId,base);assertSelectedIssuesUnchanged(jobId,snapshots,value.strategy);
    db.prepare('INSERT INTO import_repair_batches(id,import_job_id,status,base_derivative_hash,candidate_derivative_hash,operations_json,validation_json,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)').run(batchId,jobId,'draft',base.hash,candidateHash,JSON.stringify(operations),JSON.stringify({canonicalHash:candidate.canonicalHash,inventoryHash:candidate.inventoryHash,canonicalUnchanged:true,inventoryUnchanged:true,visualVerified:false,errors:[],modelRunId:planned.modelRunId,proposalSource:planned.source,issueSnapshots:snapshots}),time,time);
    for(const issue of issues)db.prepare('INSERT INTO import_repair_batch_issues(repair_batch_id,review_issue_id)VALUES(?,?)').run(batchId,issue.id);
    db.prepare('INSERT INTO import_review_revisions(id,import_job_id,repair_batch_id,parent_revision_id,status,base_derivative_hash,candidate_derivative_hash,html_path,canonical_hash,inventory_hash,operations_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,jobId,batchId,base.parentRevisionId,'candidate',base.hash,candidateHash,htmlPath,candidate.canonicalHash,candidate.inventoryHash,JSON.stringify(operations),time);
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch(rollbackError){void rollbackError}await rm(htmlPath,{force:true});throw error}
  return academicRepairBatch(jobId,batchId)!;
}
function storedBatch(jobId:string,batchId:string):StoredBatch{const batch=row<StoredBatch>('SELECT * FROM import_repair_batches WHERE id=? AND import_job_id=?',batchId,jobId);if(!batch)fail('Repair batch not found',404);return batch}
export async function acceptAcademicRepairBatch(jobId:string,batchId:string,input:unknown={}):Promise<AcademicRepairBatch>{
  const value=acceptBatchSchema.parse(input??{});assertReviewReady(jobId);
  const batch=storedBatch(jobId,batchId);if(batch.status!=='draft')fail('Only a draft repair batch can be accepted',409);
  const validation=parseJson<Record<string,unknown>>(batch.validation_json,{});
  if(validation.canonicalUnchanged!==true||validation.inventoryUnchanged!==true||!Array.isArray(validation.errors)||validation.errors.length)fail('Repair candidate has not passed invariant validation',409);
  const originalRevision=row<StoredRevision>('SELECT * FROM import_review_revisions WHERE repair_batch_id=? AND import_job_id=? AND candidate_derivative_hash=?',batchId,jobId,batch.candidate_derivative_hash);if(!originalRevision)fail('Validated repair candidate is unavailable',409);
  const base=await loadCurrentBase(jobId);if(base.hash!==batch.base_derivative_hash||base.parentRevisionId!==originalRevision.parent_revision_id){const changed=db.prepare("UPDATE import_repair_batches SET status='stale',updated_at=?,error='The active derivative changed before acceptance' WHERE id=? AND import_job_id=? AND status='draft' AND EXISTS(SELECT 1 FROM import_jobs j WHERE j.id=import_repair_batches.import_job_id AND j.status='review-ready' AND j.stage IN ('review','publish-failed'))").run(now(),batchId,jobId);if(changed.changes)db.prepare("UPDATE import_review_revisions SET status='stale' WHERE repair_batch_id=? AND import_job_id=? AND status='candidate'").run(batchId,jobId);fail('Repair batch is stale; rebuild it against the current derivative',409)}
  const operations=parseJson<AcademicRepairOperation[]>(batch.operations_json,[]),selected=value.operationIds?new Set(value.operationIds):new Set(operations.map(operation=>operation.id));
  if([...selected].some(id=>!operations.some(operation=>operation.id===id)))fail('Selected operation does not belong to this batch');
  const chosen=operations.filter(operation=>selected.has(operation.id));if(!chosen.length)fail('At least one repair operation must be accepted');
  const chosenIssueIds=new Set(chosen.flatMap(operation=>operation.issueIds)),strategy=validation.proposalSource==='deterministic'?'direct':'planner',chosenSnapshots=persistedIssueSnapshots(validation,chosenIssueIds);
  assertSelectedIssuesUnchanged(jobId,chosenSnapshots,strategy,'since this repair candidate was created');
  let revision:StoredRevision|undefined=originalRevision,pendingRevision:StoredRevision|undefined,pendingPath:string|undefined;
  if(chosen.length!==operations.length){
    const candidate=await applyOperations(base.html,base.sourceHtml,chosen),candidateHash=hash(candidate.html),id=nanoid(),directory=join(config.dataDir,'imports',jobId,'review-revisions'),htmlPath=join(directory,`${id}.html`),createdAt=now();
    if(!candidate.changed||candidateHash===base.hash)fail('Selected repair operations produced no change to the current derivative',409);
    await mkdir(directory,{recursive:true,mode:0o700});await writeFile(htmlPath,candidate.html,{flag:'wx',mode:0o600});pendingPath=htmlPath;
    pendingRevision={id,import_job_id:jobId,repair_batch_id:batchId,parent_revision_id:base.parentRevisionId,status:'candidate',base_derivative_hash:base.hash,candidate_derivative_hash:candidateHash,html_path:htmlPath,canonical_hash:candidate.canonicalHash,inventory_hash:candidate.inventoryHash,operations_json:JSON.stringify(chosen),created_at:createdAt,activated_at:null,reverted_at:null};revision=pendingRevision;
  }
  if(!revision)fail('Validated repair candidate is unavailable',409);
  const time=now();
  try{
    db.exec('BEGIN IMMEDIATE');assertReviewReady(jobId);assertCurrentBase(jobId,base);assertSelectedIssuesUnchanged(jobId,chosenSnapshots,strategy,'since this repair candidate was created');
    const fresh=storedBatch(jobId,batchId);if(fresh.status!=='draft'||fresh.base_derivative_hash!==base.hash||fresh.candidate_derivative_hash!==batch.candidate_derivative_hash)fail('Repair batch changed before acceptance',409);
    if(pendingRevision)db.prepare('INSERT INTO import_review_revisions(id,import_job_id,repair_batch_id,parent_revision_id,status,base_derivative_hash,candidate_derivative_hash,html_path,canonical_hash,inventory_hash,operations_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(pendingRevision.id,jobId,batchId,pendingRevision.parent_revision_id,'candidate',pendingRevision.base_derivative_hash,pendingRevision.candidate_derivative_hash,pendingRevision.html_path,pendingRevision.canonical_hash,pendingRevision.inventory_hash,pendingRevision.operations_json,pendingRevision.created_at);
    if(revision.parent_revision_id!==base.parentRevisionId||revision.base_derivative_hash!==base.hash)fail('Repair revision ancestry is stale',409);
    if(base.parentRevisionId){const deactivated=db.prepare("UPDATE import_review_revisions SET status='candidate' WHERE id=? AND import_job_id=? AND status='active'").run(base.parentRevisionId,jobId);if(deactivated.changes!==1)fail('Active repair revision changed before acceptance',409)}
    const activated=db.prepare("UPDATE import_review_revisions SET status='active',activated_at=?,reverted_at=NULL WHERE id=? AND import_job_id=? AND repair_batch_id=? AND status='candidate'").run(time,revision.id,jobId,batchId);if(activated.changes!==1)fail('Repair revision changed before acceptance',409);
    const accepted=db.prepare("UPDATE import_repair_batches SET status='accepted',selected_operation_ids_json=?,candidate_derivative_hash=?,accepted_at=?,updated_at=?,error=NULL WHERE id=? AND import_job_id=? AND status='draft'").run(JSON.stringify([...selected]),revision.candidate_derivative_hash,time,time,batchId,jobId);if(accepted.changes!==1)fail('Repair batch changed before acceptance',409);
    for(const issueId of new Set(chosen.flatMap(operation=>operation.issueIds)))db.prepare("UPDATE import_review_issues SET status='accepted',verification_status='resolved',verification_reason='Resolved by reviewer-accepted repair revision; visual verification was not run',updated_at=? WHERE id=? AND import_job_id=?").run(time,issueId,jobId);
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch(rollbackError){void rollbackError}if(pendingPath)await rm(pendingPath,{force:true});throw error}
  return academicRepairBatch(jobId,batchId)!;
}
export function revertAcademicRepairBatch(jobId:string,batchId:string):AcademicRepairBatch{
  assertReviewReady(jobId);const time=now();db.exec('BEGIN IMMEDIATE');
  try{
    assertReviewReady(jobId);const batch=storedBatch(jobId,batchId);if(batch.status!=='accepted')fail('Only an accepted repair batch can be reverted',409);
    const revision=row<StoredRevision>("SELECT * FROM import_review_revisions WHERE repair_batch_id=? AND import_job_id=? AND status='active'",batchId,jobId);if(!revision)fail('Only the active repair batch can be reverted',409);
    let predecessor:StoredRevision|undefined;
    if(revision.parent_revision_id){predecessor=row<StoredRevision>("SELECT r.* FROM import_review_revisions r JOIN import_repair_batches b ON b.id=r.repair_batch_id AND b.import_job_id=r.import_job_id WHERE r.id=? AND r.import_job_id=? AND b.status='accepted'",revision.parent_revision_id,jobId);if(!predecessor||predecessor.candidate_derivative_hash!==revision.base_derivative_hash)fail('Repair revision ancestry is incomplete',409)}
    else{const staged=currentBaseIdentity(jobId);if(staged.parentRevisionId!==revision.id)fail('Active repair revision changed before revert',409)}
    const reverted=db.prepare("UPDATE import_review_revisions SET status='reverted',reverted_at=? WHERE id=? AND import_job_id=? AND status='active'").run(time,revision.id,jobId);if(reverted.changes!==1)fail('Active repair revision changed before revert',409);
    if(predecessor){const activated=db.prepare("UPDATE import_review_revisions SET status='active',activated_at=?,reverted_at=NULL WHERE id=? AND import_job_id=? AND status='candidate'").run(time,predecessor.id,jobId);if(activated.changes!==1)fail('Parent repair revision is unavailable',409)}
    const batchResult=db.prepare("UPDATE import_repair_batches SET status='reverted',reverted_at=?,updated_at=? WHERE id=? AND import_job_id=? AND status='accepted'").run(time,time,batchId,jobId);if(batchResult.changes!==1)fail('Repair batch changed before revert',409);
    const stillResolved=new Set(acceptedAcademicReviewPlan(jobId).operations.flatMap(operation=>operation.issueIds));
    for(const issueId of new Set(parseJson<AcademicRepairOperation[]>(revision.operations_json,[]).flatMap(operation=>operation.issueIds))){
      if(stillResolved.has(issueId))db.prepare("UPDATE import_review_issues SET status='accepted',verification_status='resolved',verification_reason='Resolved by an active ancestor repair revision',updated_at=? WHERE id=? AND import_job_id=?").run(time,issueId,jobId);
      else db.prepare("UPDATE import_review_issues SET status='pending',verification_status='confirmed',verification_reason='Accepted repair was reverted',updated_at=? WHERE id=? AND import_job_id=?").run(time,issueId,jobId);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return academicRepairBatch(jobId,batchId)!;
}
function staleReplacement(jobId:string,replacementId:string,message:string):void{
  const time=now();
  try{
    db.prepare("UPDATE import_repair_batches SET status='stale',updated_at=?,error=? WHERE id=? AND import_job_id=? AND status='draft'").run(time,message,replacementId,jobId);
    db.prepare("UPDATE import_review_revisions SET status='stale' WHERE repair_batch_id=? AND import_job_id=? AND status='candidate'").run(replacementId,jobId);
  }catch{ /* Best-effort cleanup must not hide the original review-stage or CAS failure. */ }
}
export async function rebuildAcademicRepairBatch(jobId:string,batchId:string):Promise<AcademicRepairBatch>{
  assertReviewReady(jobId);
  const old=storedBatch(jobId,batchId),issueIds=rows<{review_issue_id:string}>('SELECT review_issue_id FROM import_repair_batch_issues WHERE repair_batch_id=?',old.id).map(value=>value.review_issue_id),strategy=parseJson<{proposalSource?:string}>(old.validation_json,{}).proposalSource==='deterministic'?'direct':'planner';
  if(old.status==='accepted')fail('Revert an accepted repair batch before rebuilding it',409);
  if(old.status==='stale'&&old.error?.startsWith('Rebuilt as '))fail('This stale repair batch has already been rebuilt',409);
  const replacement=await createAcademicRepairBatch(jobId,{issueIds,strategy});let conflict=false;
  db.exec('BEGIN IMMEDIATE');
  try{
    assertReviewReady(jobId);
    const time=now(),stale=db.prepare("UPDATE import_repair_batches SET status='stale',updated_at=?,error=? WHERE id=? AND import_job_id=? AND status=? AND updated_at=? AND COALESCE(error,'')=COALESCE(?,'')").run(time,`Rebuilt as ${replacement.id}`,batchId,jobId,old.status,old.updated_at,old.error);
    if(stale.changes===1)db.prepare("UPDATE import_review_revisions SET status='stale' WHERE repair_batch_id=? AND import_job_id=? AND status='candidate'").run(batchId,jobId);
    else{conflict=true;staleReplacement(jobId,replacement.id,'The source batch changed during rebuild')}
    db.exec('COMMIT');
  }catch(error){
    try{db.exec('ROLLBACK')}catch(rollbackError){void rollbackError}
    staleReplacement(jobId,replacement.id,'Rebuild was interrupted before activation');
    throw error;
  }
  if(conflict)fail('Repair batch changed during rebuild; start from the current active revision',409);
  return replacement;
}
export async function academicRepairBatchPreview(jobId:string,batchId:string):Promise<string>{const batch=storedBatch(jobId,batchId),revision=row<StoredRevision>("SELECT * FROM import_review_revisions WHERE repair_batch_id=? AND import_job_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,created_at DESC LIMIT 1",batch.id,jobId);if(!revision||!inside(join(config.dataDir,'imports',jobId),revision.html_path))fail('Repair candidate preview is unavailable',404);return readFile(revision.html_path,'utf8')}
export function acceptedAcademicReviewPlan(jobId:string):{operations:AcademicRepairOperation[];signature:string;revisionId:string|null}{
  let revision=activeAcademicReviewRevision(jobId);if(!revision)return{operations:[],signature:'[]',revisionId:null};
  const stagedRow=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId),stagedHash=stagedRow?.result_json?stagedResultSchema.parse(JSON.parse(stagedRow.result_json)).derivativeHash:null,chain:AcademicReviewRevision[]=[],visited=new Set<string>();
  while(revision){
    if(visited.has(revision.id))fail('Active repair revision chain contains a cycle',409);visited.add(revision.id);
    const accepted=row<{ok:number}>("SELECT 1 ok FROM import_repair_batches WHERE id=? AND import_job_id=? AND status='accepted'",revision.repairBatchId,jobId);if(!accepted)fail('Active repair revision is not backed by an accepted batch',409);
    chain.unshift(revision);
    if(!revision.parentRevisionId){if(revision.baseDerivativeHash!==stagedHash)fail('Active repair revision does not descend from the staged derivative',409);break}
    const previous=row<StoredRevision>("SELECT r.* FROM import_review_revisions r JOIN import_repair_batches b ON b.id=r.repair_batch_id AND b.import_job_id=r.import_job_id WHERE r.id=? AND r.import_job_id=? AND b.status='accepted'",revision.parentRevisionId,jobId);
    if(!previous||previous.candidate_derivative_hash!==revision.baseDerivativeHash)fail('Active repair revision chain is incomplete',409);revision=publicRevision(previous);
  }
  const operations=chain.flatMap(item=>item.operations),signature=JSON.stringify(operations.map(operation=>({proposal:operation.proposal,issueIds:operation.issueIds,...(operation.rationale?{rationale:operation.rationale}:{})})));return{operations,signature,revisionId:chain.at(-1)?.id??null};
}
export async function applyAcceptedAcademicReview(jobId:string,html:string,preferredTitle?:string):Promise<EditedDocument>{const plan=acceptedAcademicReviewPlan(jobId);if(!plan.operations.length)return applyDocumentEditOperations(html,[],preferredTitle);const stagedRow=row<{result_json:string|null}>('SELECT result_json FROM import_jobs WHERE id=?',jobId);if(!stagedRow?.result_json)fail('Import result is unavailable',409);const staged=stagedResultSchema.parse(JSON.parse(stagedRow.result_json)),path=resolve(staged.bundleDirectory,staged.entryPath),root=join(config.dataDir,'imports',jobId);if(!inside(root,path))fail('Immutable source path is invalid',409);const applied=await applyOperations(html,await readFile(path,'utf8'),plan.operations);return applyDocumentEditOperations(applied.html,[],preferredTitle)}
