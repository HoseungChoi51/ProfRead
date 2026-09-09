import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { sanitizeDocument } from '../ingest/sanitize.js';
import {
  acceptAcademicRepairBatch,
  acceptedAcademicReviewPlan,
  activeAcademicReviewRevision,
  academicRepairBatch,
  academicRepairBatchPreview,
  applyAcceptedAcademicReview,
  createAcademicRepairBatch,
  registerAcademicRepairPlanner,
  revertAcademicRepairBatch,
} from './repair-batches.js';
import { recheckAcademicReviewIssues } from './review.js';
import { listAcademicReviewIssues, materializeAcademicReviewIssues } from './review-issues.js';
import { saveReviewerFeedback } from './reviewer-feedback.js';
import { createReviewerPolicy, deleteReviewerPolicy, reviewerPolicyEffects, reviewerPolicySnapshot } from './reviewer-policies.js';

const jobs:string[]=[],policies:string[]=[];
afterEach(async()=>{for(const id of policies.splice(0))deleteReviewerPolicy(id);for(const jobId of jobs.splice(0)){db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId);await rm(join(config.dataDir,'imports',jobId),{recursive:true,force:true})}});

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}

async function fixture(sourceHtml:string,mutatePreview?:(html:string)=>string){
  const jobId=`repair-${nanoid()}`,root=join(config.dataDir,'imports',jobId),bundle=join(root,'bundle'),entry=join(bundle,'document.html'),upload=join(root,'source.html');
  await mkdir(bundle,{recursive:true});await writeFile(entry,sourceHtml);await writeFile(upload,sourceHtml);
  const sanitized=sanitizeDocument(sourceHtml,'document.html',()=>null),preview=mutatePreview?.(sanitized.html)??sanitized.html,derivativeHash=createHash('sha256').update(preview).digest('hex'),time=now();
  await writeFile(join(root,'preview.html'),preview);
  const result={entryPath:'document.html',bundleDirectory:bundle,derivativeHash,manifest:{schemaVersion:1},assets:[]};
  db.prepare("INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,result_json,status,stage,created_at,updated_at)VALUES(?,'html','paper.html','text/html',?,?,?,'review-ready','review',?,?)").run(jobId,upload,'a'.repeat(64),JSON.stringify(result),time,time);
  jobs.push(jobId);return{jobId,preview,root};
}

function addFinding(jobId:string,input:{source?:'deterministic'|'model';code:string;targetRef:string;repair?:unknown;evidence?:unknown[];corroborated?:boolean}){
  const id=`finding-${nanoid()}`,time=now();
  db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,source_comparison,target_ref,evidence_json,repair_json,confidence,corroborated,decision,created_at,updated_at)
    VALUES(?,?,?,?,?,'Review defect','Review defect description','',?,?,?,'high',?,'pending',?,?)`)
    .run(id,jobId,input.source??'model',input.code,'warning',input.targetRef,JSON.stringify(input.evidence??[]),input.repair?JSON.stringify(input.repair):null,Number(Boolean(input.corroborated)),time,time);
  return id;
}

describe('academic repair revision workflow',()=>{
  it('keeps converted heading structure reviewable without trusting it as content-loss evidence',async()=>{
    const source='<html><body><h1>Paper title</h1><h6>Abstract</h6><p>Summary</p><h2>Introduction</h2></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),abstractId=cheerio.load(prepared.html)('h6[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);
    addFinding(jobId,{code:'broken-reading-order',targetRef:abstractId,evidence:[{id:'text-1',kind:'converted-text',label:'Text 1'}],repair:{type:'set-semantic-role',targetRef:abstractId,role:'abstract'}});
    addFinding(jobId,{code:'missing-content',targetRef:abstractId,evidence:[{id:'text-2',kind:'converted-text',label:'Text 2'}]});
    const issues=await materializeAcademicReviewIssues(jobId),readingOrder=issues.find(issue=>issue.issueCode==='broken-reading-order')!,missingContent=issues.find(issue=>issue.issueCode==='missing-content')!;
    expect(readingOrder).toMatchObject({status:'pending',severity:'warning',verificationStatus:'unverified',verificationReason:expect.stringMatching(/heading and block structure is direct review evidence/i),repairable:false});
    expect(missingContent).toMatchObject({status:'pending',severity:'info',verificationStatus:'rejected',verificationReason:expect.stringMatching(/lossy outline\/text representation artifact/i)});
  });

  it('truth-checks and restores source SVG viewBox plus effective inline marker semantics by stable block ID',async()=>{
    const source='<html><body><figure><svg viewBox="0 0 100 50"><defs><marker id="arrow"><path d="M0 0L4 2L0 4z"/></marker></defs><path d="M0 25L90 25" style="stroke:black;marker-end:url(#arrow)"/></svg><figcaption>Architecture</figcaption></figure></body></html>';
    let figureId='',svgId='';
    const prepared=sanitizeDocument(source,'document.html',()=>null),expected=cheerio.load(prepared.html);figureId=expected('figure[data-block-id]').attr('data-block-id')!;svgId=expected('svg[data-block-id]').attr('data-block-id')!;
    const {jobId,preview,root}=await fixture(source,html=>{const $=cheerio.load(html),svg=$(`[data-block-id="${svgId}"]`);svg.removeAttr('viewBox').removeAttr('viewbox');svg.find('defs').remove();svg.find('path').last().attr('style','stroke:black;marker-end:url("")');return $.html()});
    addFinding(jobId,{code:'figure-cropped',targetRef:figureId,evidence:[{id:'object-one',kind:'object',mimeType:'image/png',storagePath:'/srv/private/evidence.png',relativePath:'evidence/a.png',bytes:99}]});
    const [issue]=await materializeAcademicReviewIssues(jobId);
    expect(issue).toMatchObject({verificationStatus:'confirmed',repairable:true,proposedRepair:{type:'restore-svg-semantics',targetRef:svgId},targetRefs:expect.arrayContaining([figureId,svgId])});
    expect(issue!.evidence).toEqual([expect.objectContaining({id:'object-one',url:`/api/import-jobs/${jobId}/evidence/object-one`})]);
    expect(JSON.stringify(issue)).not.toMatch(/storagePath|relativePath|\/srv\/private|bytes/);
    expect(issue).toMatchObject({status:'pending'});
    await writeFile(join(root,'preview.html'),'<html><body><p>The SVG target is temporarily unavailable.</p></body></html>');
    await expect(createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'direct'})).rejects.toThrow(/target no longer exists/i);
    expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'pending',verificationStatus:'confirmed'});
    await writeFile(join(root,'preview.html'),preview);
    const batch=await createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'direct'});
    expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'pending',verificationStatus:'confirmed'});
    expect(batch.validation).toMatchObject({canonicalUnchanged:true,inventoryUnchanged:true,visualVerified:false,errors:[]});
    const candidate=cheerio.load(await academicRepairBatchPreview(jobId,batch.id)),svg=candidate(`[data-block-id="${svgId}"]`),line=svg.find('path').last();
    expect(svg.attr('viewBox')).toBe('0 0 100 50');expect(svg.find('marker#arrow')).toHaveLength(1);expect(line.attr('marker-end')).toBe('url(#arrow)');expect(line.attr('style')).not.toMatch(/marker-end/i);
    await acceptAcademicRepairBatch(jobId,batch.id);
    expect(activeAcademicReviewRevision(jobId)).toMatchObject({repairBatchId:batch.id,parentRevisionId:null});
    expect(JSON.stringify(activeAcademicReviewRevision(jobId))).not.toContain(config.dataDir);
    expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'accepted',verificationStatus:'resolved'});
    revertAcademicRepairBatch(jobId,batch.id);
    expect(activeAcademicReviewRevision(jobId)).toBeNull();expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'pending',verificationStatus:'confirmed'});
  });

  it('delegates only user-confirmed issues, previews bounded semantic changes, and preserves confirmation on revert',async()=>{
    const source='<html><body><p class="pdf-visual-fallback-note">Original PDF page 7</p><p>Article body.</p></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),helperId=cheerio.load(prepared.html)('.pdf-visual-fallback-note[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);
    expect(helperId).toBeTruthy();addFinding(jobId,{code:'template-chrome',targetRef:helperId});const[issue]=await materializeAcademicReviewIssues(jobId);
    registerAcademicRepairPlanner(async()=>({authorizedTargetRefs:{[issue!.id]:[helperId]},modelRunId:'delegated-run',proposals:[{issueId:issue!.id,rationale:'Remove only the recognized converter helper note.',proposal:{type:'suppress-source-chrome',targetRef:helperId,sourceRef:helperId}}]}));
    await expect(createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'delegate'})).rejects.toThrow(/user-confirmed/i);
    saveReviewerFeedback(jobId,issue!.id,{decision:'accepted',comment:'This is converter chrome, not article content.'});
    registerAcademicRepairPlanner(async input=>{expect(input.strategy).toBe('delegate');return{authorizedTargetRefs:{[issue!.id]:[helperId]},modelRunId:'delegated-run',proposals:[{issueId:issue!.id,rationale:'Remove only the recognized converter helper note.',proposal:{type:'suppress-source-chrome',targetRef:helperId,sourceRef:helperId}}]}});
    const batch=await createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'delegate'});
    expect(batch.validation).toMatchObject({canonicalUnchanged:false,inventoryUnchanged:true,delegated:true,userConfirmed:true,proposalSource:'delegated'});
    expect(cheerio.load(await academicRepairBatchPreview(jobId,batch.id))('.pdf-visual-fallback-note')).toHaveLength(0);
    await acceptAcademicRepairBatch(jobId,batch.id);expect(acceptedAcademicReviewPlan(jobId)).toMatchObject({delegated:true});expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'accepted',verificationStatus:'resolved'});
    revertAcademicRepairBatch(jobId,batch.id);expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'accepted',verificationStatus:'confirmed',verificationReason:expect.stringMatching(/user-confirmed issue reopened/i)});
  });

  it('joins consecutive source fragments verbatim in preview and final publication replay',async()=>{
    const source='<html><body><h1>What it means to be a mathematician</h1><h1>when AI does the math</h1><p>Article body.</p></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),$=cheerio.load(prepared.html),titleRefs=$('h1[data-block-id]').toArray().map(node=>$(node).attr('data-block-id')!),{jobId,preview}=await fixture(source);
    expect(titleRefs).toHaveLength(2);addFinding(jobId,{code:'broken-reading-order',targetRef:titleRefs[0]!});const[issue]=await materializeAcademicReviewIssues(jobId);saveReviewerFeedback(jobId,issue!.id,{decision:'accepted',comment:'These are consecutive fragments of one printed title.'});
    registerAcademicRepairPlanner(async()=>({authorizedTargetRefs:{[issue!.id]:titleRefs},proposals:[{issueId:issue!.id,rationale:'Join the two supplied title fragments in their existing order.',proposal:{type:'join-source-fragments',targetRef:titleRefs[0]!,sourceRefs:[titleRefs[1]!]}}]}));
    const batch=await createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'delegate'}),candidate=cheerio.load(await academicRepairBatchPreview(jobId,batch.id));expect(candidate('h1')).toHaveLength(1);expect(candidate('h1').text()).toBe('What it means to be a mathematician when AI does the math');
    await acceptAcademicRepairBatch(jobId,batch.id);const published=cheerio.load((await applyAcceptedAcademicReview(jobId,preview)).html);expect(published('h1')).toHaveLength(1);expect(published('h1').text()).toBe('What it means to be a mathematician when AI does the math');
  });

  it('binds planner operations to their named issue, allows a safe partial plan, and rejects two operations for one issue',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);
    addFinding(jobId,{code:'figure-cropped',targetRef:imgId});addFinding(jobId,{code:'missing-alt',targetRef:imgId});
    const issues=await materializeAcademicReviewIssues(jobId),repairIssue=issues.find(issue=>issue.issueCode==='figure-cropped')!,manualIssue=issues.find(issue=>issue.issueCode==='missing-alt')!;
    registerAcademicRepairPlanner(async()=>({modelRunId:'planner-run',proposals:[{issueId:repairIssue.id,rationale:'Clear the proven fixed width only.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]}));
    const batch=await createAcademicRepairBatch(jobId,{issueIds:issues.map(issue=>issue.id),strategy:'planner'});
    expect(batch.operations).toHaveLength(1);expect(batch.operations[0]).toMatchObject({issueIds:[repairIssue.id],rationale:'Clear the proven fixed width only.'});
    await acceptAcademicRepairBatch(jobId,batch.id);
    expect(listAcademicReviewIssues(jobId).find(issue=>issue.id===repairIssue.id)).toMatchObject({verificationStatus:'resolved'});
    expect(listAcademicReviewIssues(jobId).find(issue=>issue.id===manualIssue.id)).toMatchObject({status:'pending',verificationStatus:'unverified'});

    const second=await fixture(source),secondId=cheerio.load(second.preview)('img[data-block-id]').attr('data-block-id')!;addFinding(second.jobId,{code:'figure-cropped',targetRef:secondId});const [only]=await materializeAcademicReviewIssues(second.jobId);
    registerAcademicRepairPlanner(async()=>({proposals:[
      {issueId:only!.id,rationale:'First.',proposal:{type:'clear-fixed-dimensions',targetRef:secondId}},
      {issueId:only!.id,rationale:'Second.',proposal:{type:'set-object-layout',targetRef:secondId,width:'full',alignment:'center',enlargeable:true}},
    ]}));
    await expect(createAcademicRepairBatch(second.jobId,{issueIds:[only!.id],strategy:'planner'})).rejects.toThrow(/at most one operation/i);
  });

  it('rejects planner output when reviewer feedback or issue eligibility changes while the model is awaiting',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,first=await fixture(source);
    addFinding(first.jobId,{code:'figure-cropped',targetRef:imgId});const[firstIssue]=await materializeAcademicReviewIssues(first.jobId),plan=deferred<unknown>(),entered=deferred<void>();
    registerAcademicRepairPlanner(async()=>{entered.resolve();return plan.promise});
    const creating=createAcademicRepairBatch(first.jobId,{issueIds:[firstIssue!.id],strategy:'planner'}),rejected=expect(creating).rejects.toMatchObject({statusCode:409});await entered.promise;
    saveReviewerFeedback(first.jobId,firstIssue!.id,{decision:'dismissed',comment:'This is readable.'});
    plan.resolve({proposals:[{issueId:firstIssue!.id,rationale:'Clear the width.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]});await rejected;
    expect(academicRepairBatch(first.jobId,'missing')).toBeNull();expect(row<{count:number}>('SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=?',first.jobId)?.count).toBe(0);

    const second=await fixture(source);addFinding(second.jobId,{code:'figure-cropped',targetRef:imgId});const[secondIssue]=await materializeAcademicReviewIssues(second.jobId),notePlan=deferred<unknown>(),noteEntered=deferred<void>();
    registerAcademicRepairPlanner(async()=>{noteEntered.resolve();return notePlan.promise});
    const noteCreating=createAcademicRepairBatch(second.jobId,{issueIds:[secondIssue!.id],strategy:'planner'}),noteRejected=expect(noteCreating).rejects.toMatchObject({statusCode:409});await noteEntered.promise;
    saveReviewerFeedback(second.jobId,secondIssue!.id,{note:'Try a narrower layout.'});
    notePlan.resolve({proposals:[{issueId:secondIssue!.id,rationale:'Clear the width.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]});await noteRejected;
    expect(row<{count:number}>('SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=?',second.jobId)?.count).toBe(0);
  });

  it('rejects a deferred planner when recheck or finalization claims the review',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,first=await fixture(source),evidenceDirectory=join(first.root,'evidence');
    await mkdir(evidenceDirectory,{recursive:true});await writeFile(join(evidenceDirectory,'object-one.png'),Buffer.from([137,80,78,71,13,10,26,10]));await writeFile(join(evidenceDirectory,'index.json'),JSON.stringify([{id:'object-one',relativePath:'evidence/object-one.png',mimeType:'image/png'}]));
    addFinding(first.jobId,{code:'figure-cropped',targetRef:imgId,evidence:[{id:'object-one',kind:'object',mimeType:'image/png'}]});const[firstIssue]=await materializeAcademicReviewIssues(first.jobId),plan=deferred<unknown>(),plannerEntered=deferred<void>(),audit=deferred<any>(),auditEntered=deferred<void>();
    registerAcademicRepairPlanner(async()=>{plannerEntered.resolve();return plan.promise});
    const creating=createAcademicRepairBatch(first.jobId,{issueIds:[firstIssue!.id],strategy:'planner'}),rejected=expect(creating).rejects.toMatchObject({statusCode:409});await plannerEntered.promise;
    const rechecking=recheckAcademicReviewIssues(first.jobId,[firstIssue!.id],undefined,{audit:async()=>{auditEntered.resolve();return audit.promise}});await auditEntered.promise;
    expect(row<{stage:string}>('SELECT stage FROM import_jobs WHERE id=?',first.jobId)).toEqual({stage:'review-recheck'});
    plan.resolve({proposals:[{issueId:firstIssue!.id,rationale:'Clear the width.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]});await rejected;
    audit.reject(new Error('Synthetic audit failure'));await expect(rechecking).resolves.toMatchObject({callsUsed:1,failedCalls:1});
    expect(row<{count:number}>('SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=?',first.jobId)?.count).toBe(0);

    const second=await fixture(source);addFinding(second.jobId,{code:'figure-cropped',targetRef:imgId});const[secondIssue]=await materializeAcademicReviewIssues(second.jobId),finalPlan=deferred<unknown>(),finalEntered=deferred<void>();
    registerAcademicRepairPlanner(async()=>{finalEntered.resolve();return finalPlan.promise});
    const finalCreating=createAcademicRepairBatch(second.jobId,{issueIds:[secondIssue!.id],strategy:'planner'}),finalRejected=expect(finalCreating).rejects.toMatchObject({statusCode:409});await finalEntered.promise;
    db.prepare("UPDATE import_jobs SET status='finalizing',stage='finalizing',updated_at=? WHERE id=? AND status='review-ready' AND stage='review'").run(now(),second.jobId);
    finalPlan.resolve({proposals:[{issueId:secondIssue!.id,rationale:'Clear the width.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]});await finalRejected;
    expect(row<{count:number}>('SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=?',second.jobId)?.count).toBe(0);
  });

  it('rejects repair proposals that produce a no-op derivative',async()=>{
    const source='<html><body><img src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);
    addFinding(jobId,{code:'figure-cropped',targetRef:imgId});const[issue]=await materializeAcademicReviewIssues(jobId);
    registerAcademicRepairPlanner(async()=>({proposals:[{issueId:issue!.id,rationale:'Try clearing dimensions.',proposal:{type:'clear-fixed-dimensions',targetRef:imgId}}]}));
    await expect(createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'planner'})).rejects.toThrow(/produced no change/i);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM import_repair_batches WHERE import_job_id=?',jobId)?.count).toBe(0);

    const mixedSource='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/><img src="data:image/png;base64,iVBORw0KGgo="/></body></html>',mixedPrepared=sanitizeDocument(mixedSource,'document.html',()=>null),ids=cheerio.load(mixedPrepared.html)('img[data-block-id]').map((_index,node)=>cheerio.load(node)(node).attr('data-block-id')).get(),mixed=await fixture(mixedSource);
    addFinding(mixed.jobId,{code:'cropped-fixed',targetRef:ids[0]!});addFinding(mixed.jobId,{code:'cropped-fluid',targetRef:ids[1]!});const issues=await materializeAcademicReviewIssues(mixed.jobId),fluid=issues.find(item=>item.targetRefs.includes(ids[1]!))!;
    registerAcademicRepairPlanner(async()=>({proposals:issues.map((item,index)=>({issueId:item.id,rationale:'Clear dimensions.',proposal:{type:'clear-fixed-dimensions' as const,targetRef:ids[index]!}}))}));
    const batch=await createAcademicRepairBatch(mixed.jobId,{issueIds:issues.map(item=>item.id),strategy:'planner'}),noOp=batch.operations.find(operation=>operation.issueIds.includes(fluid.id))!;
    await expect(acceptAcademicRepairBatch(mixed.jobId,batch.id,{operationIds:[noOp.id]})).rejects.toThrow(/produced no change/i);expect(academicRepairBatch(mixed.jobId,batch.id)).toMatchObject({status:'draft'});
  });

  it('refuses to accept a draft after its chosen issue is dismissed or its reviewer instruction is edited',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,first=await fixture(source);
    addFinding(first.jobId,{source:'deterministic',code:'figure-cropped',targetRef:imgId,repair:{type:'clear-fixed-dimensions',targetRef:imgId}});const[firstIssue]=await materializeAcademicReviewIssues(first.jobId);saveReviewerFeedback(first.jobId,firstIssue!.id,{decision:'accepted',comment:'Apply the safe repair.'});
    const dismissedDraft=await createAcademicRepairBatch(first.jobId,{issueIds:[firstIssue!.id],strategy:'direct'});saveReviewerFeedback(first.jobId,firstIssue!.id,{decision:'dismissed',comment:'Visual inspection shows no defect.'});
    await expect(acceptAcademicRepairBatch(first.jobId,dismissedDraft.id)).rejects.toMatchObject({statusCode:409});expect(academicRepairBatch(first.jobId,dismissedDraft.id)).toMatchObject({status:'draft'});

    const second=await fixture(source);addFinding(second.jobId,{source:'deterministic',code:'figure-cropped',targetRef:imgId,repair:{type:'clear-fixed-dimensions',targetRef:imgId}});const[secondIssue]=await materializeAcademicReviewIssues(second.jobId);saveReviewerFeedback(second.jobId,secondIssue!.id,{decision:'accepted',comment:'Apply the safe repair.'});
    const editedDraft=await createAcademicRepairBatch(second.jobId,{issueIds:[secondIssue!.id],strategy:'direct'});saveReviewerFeedback(second.jobId,secondIssue!.id,{comment:'Pause and preserve the current width.'});
    await expect(acceptAcademicRepairBatch(second.jobId,editedDraft.id)).rejects.toThrow(/feedback or verification changed/i);expect(academicRepairBatch(second.jobId,editedDraft.id)).toMatchObject({status:'draft'});
  });

  it('marks a draft stale when active ancestry changes even if the derivative hash is identical',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),imgId=cheerio.load(prepared.html)('img[data-block-id]').attr('data-block-id')!,{jobId,root}=await fixture(source);
    addFinding(jobId,{source:'deterministic',code:'figure-cropped',targetRef:imgId,repair:{type:'clear-fixed-dimensions',targetRef:imgId}});const[issue]=await materializeAcademicReviewIssues(jobId);saveReviewerFeedback(jobId,issue!.id,{decision:'accepted'});
    const draft=await createAcademicRepairBatch(jobId,{issueIds:[issue!.id],strategy:'direct'}),foreignBatch=`batch-${nanoid()}`,foreignRevision=`revision-${nanoid()}`,time=now();
    db.prepare("INSERT INTO import_repair_batches(id,import_job_id,status,base_derivative_hash,candidate_derivative_hash,operations_json,validation_json,created_at,updated_at,accepted_at)VALUES(?,?,?,?,?,'[]','{}',?,?,?)").run(foreignBatch,jobId,'accepted',draft.baseDerivativeHash,draft.baseDerivativeHash,time,time,time);
    db.prepare("INSERT INTO import_review_revisions(id,import_job_id,repair_batch_id,parent_revision_id,status,base_derivative_hash,candidate_derivative_hash,html_path,canonical_hash,inventory_hash,operations_json,created_at,activated_at)VALUES(?,?,?,NULL,'active',?,?,?,?,?,'[]',?,?)").run(foreignRevision,jobId,foreignBatch,draft.baseDerivativeHash,draft.baseDerivativeHash,join(root,'preview.html'),'canonical','inventory',time,time);
    await expect(acceptAcademicRepairBatch(jobId,draft.id)).rejects.toMatchObject({statusCode:409});expect(academicRepairBatch(jobId,draft.id)).toMatchObject({status:'stale',error:expect.stringMatching(/active derivative changed/i)});
  });

  it('maintains explicit ancestry, blocks review-rebuild mutations, and reverts only the active branch',async()=>{
    const source='<html><body><img width="640" src="data:image/png;base64,iVBORw0KGgo="/><img width="320" src="data:image/png;base64,iVBORw0KGgo="/></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),ids=cheerio.load(prepared.html)('img[data-block-id]').map((_i,node)=>cheerio.load(node)(node).attr('data-block-id')).get(),{jobId}=await fixture(source);
    addFinding(jobId,{source:'deterministic',code:'fixed-one',targetRef:ids[0]!,repair:{type:'clear-fixed-dimensions',targetRef:ids[0]}});addFinding(jobId,{source:'deterministic',code:'fixed-two',targetRef:ids[1]!,repair:{type:'clear-fixed-dimensions',targetRef:ids[1]}});
    const issues=await materializeAcademicReviewIssues(jobId);for(const issue of issues)saveReviewerFeedback(jobId,issue.id,{decision:'accepted'});
    const firstIssue=issues.find(issue=>issue.targetRefs.includes(ids[0]!))!,secondIssue=issues.find(issue=>issue.targetRefs.includes(ids[1]!))!,first=await createAcademicRepairBatch(jobId,{issueIds:[firstIssue.id],strategy:'direct'});await acceptAcademicRepairBatch(jobId,first.id);
    const second=await createAcademicRepairBatch(jobId,{issueIds:[secondIssue.id],strategy:'direct'});await acceptAcademicRepairBatch(jobId,second.id);
    expect(activeAcademicReviewRevision(jobId)).toMatchObject({repairBatchId:second.id,parentRevisionId:expect.any(String)});expect(acceptedAcademicReviewPlan(jobId).operations).toHaveLength(2);
    revertAcademicRepairBatch(jobId,second.id);expect(activeAcademicReviewRevision(jobId)).toMatchObject({repairBatchId:first.id,parentRevisionId:null});expect(listAcademicReviewIssues(jobId).find(issue=>issue.id===secondIssue.id)).toMatchObject({status:'pending',verificationStatus:'confirmed'});
    db.prepare("UPDATE import_jobs SET stage='review-rebuild' WHERE id=?").run(jobId);
    await expect(createAcademicRepairBatch(jobId,{issueIds:[secondIssue.id],strategy:'direct'})).rejects.toMatchObject({statusCode:409});
    await expect(acceptAcademicRepairBatch(jobId,first.id)).rejects.toMatchObject({statusCode:409});
  });

  it('persists complete feedback snapshots and resolves manual verdicts in last-write order',async()=>{
    const policy=createReviewerPolicy({name:'Wording context',enabled:true,priority:10,match:{issueCode:'wording',sourceKind:'html'},action:'context-note'});policies.push(policy.id);
    const source='<html><body><p>Text</p></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),target=cheerio.load(prepared.html)('p[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);addFinding(jobId,{code:'wording',targetRef:target});const [issue]=await materializeAcademicReviewIssues(jobId);
    expect(issue!.policyIds).toEqual([policy.id]);
    const snapshot=reviewerPolicySnapshot({jobId}),prompt=JSON.parse(snapshot.promptJson);expect(snapshot.policies.map(item=>item.id)).toEqual([policy.id]);expect(prompt.effects).toEqual(reviewerPolicyEffects);expect(Object.keys(prompt.effects).sort()).toEqual(['context-note','increase-scrutiny','lower-priority','require-stronger-evidence']);
    saveReviewerFeedback(jobId,issue!.id,{decision:'accepted',comment:'Initial comment'});
    const merged=saveReviewerFeedback(jobId,issue!.id,{note:'Later note'});
    expect(merged).toMatchObject({decision:'accepted',comment:'Initial comment',reviewerNote:'Later note'});
    const manual=saveReviewerFeedback(jobId,issue!.id,{decision:'manual'});
    expect(manual).toMatchObject({decision:'manual',comment:'Initial comment',reviewerNote:'Later note'});
    expect(listAcademicReviewIssues(jobId)[0]).toMatchObject({status:'manual',verificationStatus:'resolved'});
    expect(row<{decision:string;reviewer_note:string}>('SELECT decision,reviewer_note FROM import_reviewer_feedback WHERE review_issue_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',issue!.id)).toEqual({decision:'manual',reviewer_note:'Later note'});
  });

  it('preserves a human false-positive verdict when findings are rematerialized',async()=>{
    const source='<html><body><p>Complete text</p></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),target=cheerio.load(prepared.html)('p[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source);addFinding(jobId,{code:'missing-content',targetRef:target,evidence:[{id:'object-one',kind:'object'}]});const[issue]=await materializeAcademicReviewIssues(jobId);
    saveReviewerFeedback(jobId,issue!.id,{decision:'dismissed',comment:'The immutable source and preview agree.'});
    const[rebuilt]=await materializeAcademicReviewIssues(jobId,{rebuild:true});
    expect(rebuilt).toMatchObject({id:issue!.id,status:'dismissed',verificationStatus:'rejected',repairable:false});
  });

  it('carries unresolved issues across a rebuild that omits them and relinks them when rediscovered',async()=>{
    const source='<html><body><p>Text under review</p></body></html>',prepared=sanitizeDocument(source,'document.html',()=>null),target=cheerio.load(prepared.html)('p[data-block-id]').attr('data-block-id')!,{jobId}=await fixture(source),findingId=addFinding(jobId,{source:'deterministic',code:'missing-content',targetRef:target}),[issue]=await materializeAcademicReviewIssues(jobId);
    expect(issue).toMatchObject({severity:'warning',status:'pending',verificationStatus:'confirmed',findingIds:[findingId]});

    db.prepare('DELETE FROM import_findings WHERE id=?').run(findingId);
    const[carried]=await materializeAcademicReviewIssues(jobId,{rebuild:true});
    expect(carried).toMatchObject({id:issue!.id,status:'pending',verificationStatus:'confirmed',findingIds:[],verificationReason:expect.stringMatching(/carried forward.*did not re-report or verify/i)});

    const rediscoveredId=addFinding(jobId,{source:'deterministic',code:'missing-content',targetRef:target}),[rediscovered]=await materializeAcademicReviewIssues(jobId,{rebuild:true});
    expect(rediscovered).toMatchObject({id:issue!.id,status:'pending',verificationStatus:'confirmed',findingIds:[rediscoveredId],verificationReason:'Confirmed by deterministic validation.'});
  });
});
