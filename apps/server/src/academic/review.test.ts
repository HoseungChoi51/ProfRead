import { describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { db,now } from '../db/index.js';
import { sanitizeDocument } from '../ingest/sanitize.js';
import { saveReviewerFeedback } from './reviewer-feedback.js';
import { boundedTriageOutline, compareSvgSemantics, planImageBatches, planOutlineChunks, prioritizeReviewEvidence, recheckAcademicReviewIssues, rendererCoverage, selectRenderEvidence, selectSourceEvidence, type EvidenceItem } from './review.js';

describe('academic review coverage planning',()=>{
  it('reports every outline cap instead of silently dropping blocks',()=>{
    const outline=Array.from({length:8},(_value,index)=>({ref:`b${index}`,tag:'p',text:'x'.repeat(20),fullLength:20,excerptLength:20,truncated:false}));
    const chunks=planOutlineChunks(outline,70,2),triage=boundedTriageOutline(outline,3,10_000);
    expect(chunks.chunks).toHaveLength(2);expect(chunks.truncated).toBe(true);
    expect(triage.items).toHaveLength(3);expect(triage.truncated).toBe(true);
  });

  it('marks per-item excerpt truncation explicitly instead of fabricating cut-off prose',()=>{
    const text=`Complete words ${'long '.repeat(80)}ending`,outline=[{ref:'b1',tag:'p',text,fullLength:text.length,excerptLength:text.length,truncated:false}];
    const item=boundedTriageOutline(outline,3,10_000).items[0]!;
    expect(item.truncated).toBe(true);expect(item.text).toContain('[TRUNCATED; fullLength=');expect(item.text).toMatch(/long… \[TRUNCATED/);expect(item.text).not.toContain('lon…');
  });

  it('preflights image sizes and batches within provider limits before reads',()=>{
    const item=(id:string,bytes:number):EvidenceItem=>({id,label:id,kind:'overview',storagePath:`/${id}.png`,mimeType:'image/png',detail:'high',bytes});
    const plan=planImageBatches([item('a',19_000_000),item('too-large',20_000_001),item('b',19_000_000),item('c',19_000_000)],10);
    expect(plan.oversize).toBe(1);expect(plan.budgetExhausted).toBe(false);expect(plan.selected.map(value=>value.id)).toEqual(['a','b','c']);
    expect(plan.batches.map(batch=>batch.reduce((sum,value)=>sum+value.bytes,0))).toEqual([38_000_000,19_000_000]);
  });

  it('marks evidence omitted by the model-call image budget',()=>{
    const item=(id:string):EvidenceItem=>({id,label:id,kind:'source-page',storagePath:`/${id}.png`,mimeType:'image/png',detail:'high',bytes:100});
    const plan=planImageBatches([item('a'),item('b'),item('c')],2);
    expect(plan.selected.map(value=>value.id)).toEqual(['a','b']);
    expect(plan.budgetExhausted).toBe(true);
  });

  it('reserves source pages and one view of every semantic object before duplicate viewports',()=>{
    const image=(id:string,kind:EvidenceItem['kind'],blockId?:string):EvidenceItem=>({id,label:id,kind,storagePath:`/${id}.png`,mimeType:'image/png',detail:'high',bytes:100,...(blockId?{blockId}:{})}),render=[image('overview-1','overview'),image('overview-2','overview'),image('f1-desktop','object','f1'),image('f1-narrow','object','f1'),image('f2-desktop','object','f2'),image('f2-narrow','object','f2')],source=[image('page-1','source-page'),image('page-20','source-page'),image('page-40','source-page')],prioritized=prioritizeReviewEvidence(render,source,7),selected=planImageBatches(prioritized,7);
    expect(selected.selected.map(item=>item.id)).toEqual(expect.arrayContaining(['overview-1','overview-2','page-1','page-40','f1-desktop','f2-desktop']));
    expect(selected.batches.some(batch=>batch.map(item=>item.blockId).filter(Boolean).join(',')==='f1,f1')).toBe(true);
  });

  it('does not let an oversized item consume a selection slot',()=>{const item=(id:string,bytes:number):EvidenceItem=>({id,label:id,kind:'source-page',storagePath:`/${id}.png`,mimeType:'image/png',detail:'high',bytes}),plan=planImageBatches([item('too-large',20_000_001),item('a',10),item('b',10)],2);expect(plan.selected.map(value=>value.id)).toEqual(['a','b']);expect(plan.oversize).toBe(1)});

  it('reports renderer semantic omissions and screenshot failures',()=>{expect(rendererCoverage({views:[{screenshotCoverage:{semanticEligible:5,semanticCaptured:4}},{screenshotCoverage:{semanticEligible:5,semanticCaptured:3}}],warnings:[{code:'object_screenshot_failed'}]})).toEqual({semanticEligible:10,semanticCaptured:7,missing:3,screenshotFailures:1})});

  it('keeps deterministic render metrics associated with exact block IDs',()=>{
    const files:any[]=[{path:'renders/narrow.png',storagePath:'/tmp/narrow.png',bytes:80,sha256:'a'},{path:'objects/narrow/q1.png',storagePath:'/tmp/q1.png',bytes:40,sha256:'b'}];
    const selected=selectRenderEvidence({views:[{viewport:{name:'narrow'},screenshots:['renders/narrow.png'],objects:[{ref:'q1',blockId:'svg-1',tag:'svg',semanticObject:{rootRef:'q0',rootBlockId:'figure-1',rootTag:'figure',nested:true},svgGeometry:{hasViewBox:true,contentOutsideViewport:false}}],objectScreenshots:[{ref:'q1',path:'objects/narrow/q1.png'}]}]},files);
    expect(selected).toEqual(expect.arrayContaining([expect.objectContaining({kind:'overview',bytes:80}),expect.objectContaining({kind:'object',blockId:'figure-1',tag:'figure',bytes:40,metadata:expect.objectContaining({capturedTag:'svg',svgGeometry:expect.objectContaining({hasViewBox:true})})})]));
  });

  it('uses published PDF page fallbacks as source evidence without duplicate reference files',()=>{
    const files:any[]=[{path:'assets/pdf-page-001.jpg',storagePath:'/tmp/page-1.jpg',bytes:120,sha256:'a'},{path:'assets/pdf-object-p001-001.jpg',storagePath:'/tmp/object.jpg',bytes:80,sha256:'b'}];
    expect(selectSourceEvidence(files)).toEqual([expect.objectContaining({kind:'source-page',storagePath:'/tmp/page-1.jpg',mimeType:'image/jpeg',bytes:120})]);
  });

  it('detects sanitizer loss of SVG viewBox and marker semantics without a model',()=>{
    const source='<figure><svg viewBox="0 0 100 50"><defs><marker id="arrow"></marker></defs><path marker-end="url(#arrow)"></path></svg></figure>',preview='<figure data-block-id="figure-1"><svg data-block-id="svg-1"><path></path></svg></figure>',delta=compareSvgSemantics(source,preview)[0]!;
    expect(delta).toMatchObject({targetRef:'svg-1',degraded:true,source:{viewBox:'0 0 100 50',markers:1,localPaintRefs:1},output:{viewBox:null,markers:0,localPaintRefs:0}});
    expect(compareSvgSemantics(source,source)[0]?.degraded).toBe(false);
  });

  it('never ordinal-matches a missing stable SVG to a different diagram',()=>{
    const source='<svg data-block-id="svg-a" viewBox="0 0 100 50"></svg><svg data-block-id="svg-b" viewBox="0 0 200 80"></svg>',preview='<svg data-block-id="svg-b" viewBox="0 0 200 80"></svg>',deltas=compareSvgSemantics(source,preview);
    expect(deltas[0]).toMatchObject({targetRef:'svg-a',degraded:true,output:{viewBox:null}});
    expect(deltas[1]).toMatchObject({targetRef:'svg-b',degraded:false,output:{viewBox:'0 0 200 80'}});
  });

  it('does not treat a model finding own source-comparison prose as independent recheck evidence',async()=>{
    const jobId=`job-${nanoid()}`,findingId=`finding-${nanoid()}`,issueId=`issue-${nanoid()}`,time=now();
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at) VALUES(?,'html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review',?,?)`).run(jobId,'a'.repeat(64),time,time);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,source_comparison,target_ref,evidence_json,confidence,decision,created_at,updated_at) VALUES(?,?,'model','missing-content','error','Missing content','Claimed missing text','The model says the source is complete.','block-1','[{"id":"outline","kind":"outline"}]','high','pending',?,?)`).run(findingId,jobId,time,time);
    db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,status,confidence,target_refs_json,evidence_json,source_actions_json,created_at,updated_at) VALUES(?,?,?,'missing-content','error','Missing content','Claimed missing text','unverified','pending','high','["block-1"]','[{"id":"outline","kind":"outline"}]','["import-triage"]',?,?)`).run(issueId,jobId,'f'.repeat(64),time,time);
    db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issueId,findingId);
    let calls=0;try{const result=await recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async()=>{calls++;throw new Error('must not call')}});expect(calls).toBe(0);expect(result.reviewIssues[0]).toMatchObject({verificationStatus:'unverified',verificationReason:expect.stringMatching(/independent source comparison/)});saveReviewerFeedback(jobId,issueId,{decision:'dismissed',comment:'This outline-only warning is false.'});await expect(recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async()=>{calls++;throw new Error('must not call')}})).rejects.toMatchObject({statusCode:409});expect(calls).toBe(0);expect(db.prepare('SELECT status,verification_status FROM import_review_issues WHERE id=?').get(issueId)).toEqual({status:'dismissed',verification_status:'rejected'});}finally{db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId)}
  });

  it('rechecks semantic warnings against bounded immutable-source versus preview evidence',async()=>{
    const jobId=`job-${nanoid()}`,findingId=`finding-${nanoid()}`,issueId=`issue-${nanoid()}`,runId=`run-${nanoid()}`,time=now(),root=join(config.dataDir,'imports',jobId),bundle=join(root,'bundle'),source='<html><head><title>Complete paper</title></head><body><p>Complete semantic text that is not missing.</p></body></html>',preview=sanitizeDocument(source,'document.html',()=>null),targetRef=preview.blocks.find(block=>block.type==='text')!.id;
    await mkdir(bundle,{recursive:true});await writeFile(join(bundle,'document.html'),source);await writeFile(join(root,'preview.html'),preview.html);
    const staged={entryPath:'document.html',bundleDirectory:bundle,derivativeHash:'7'.repeat(64),manifest:{},assets:[]};
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,max_calls,call_count,result_json,created_at,updated_at) VALUES(?,'html','paper.html','text/html',?,?,'review-ready','review',1,0,?,?,?)`).run(jobId,join(root,'source.html'),'6'.repeat(64),JSON.stringify(staged),time,time);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,confidence,corroborated,decision,created_at,updated_at) VALUES(?,?,'model','missing-content','error','Missing content','The paragraph appears truncated',?,'[{"id":"outline","kind":"outline"}]','high',0,'pending',?,?)`).run(findingId,jobId,targetRef,time,time);
    db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,status,confidence,corroborated,target_refs_json,evidence_json,source_actions_json,created_at,updated_at) VALUES(?,?,?,'missing-content','error','Missing content','The paragraph appears truncated','unverified','pending','high',0,?,'[{"id":"outline","kind":"outline"}]','["import-triage"]',?,?)`).run(issueId,jobId,'7'.repeat(64),JSON.stringify([targetRef]),time,time);
    db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issueId,findingId);db.prepare("INSERT INTO model_runs(id,request_id,action,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,'import-adjudicate','deep','test','import-evidence','completed',?)").run(runId,runId,time);
    try{
      const result=await recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async request=>{expect(request.images).toBeUndefined();expect(request.evidenceRefs).toHaveLength(1);expect(request.evidenceRefs[0]).toMatch(/^source-comparison-/);const manifest=JSON.parse(request.promptValues.evidenceManifestJson!);expect(manifest.sourceComparisons[0].text).toContain('Complete semantic text that is not missing.');return{report:{version:1,verdict:'clean',coverage:{reviewedRefs:[request.evidenceRefs[0]!],unreviewedRefs:[]},findings:[]},runId,modelId:'test',inputTokens:1,outputTokens:1}}});
      expect(result).toMatchObject({callsUsed:1,failedCalls:0});expect(result.reviewIssues[0]).toMatchObject({verificationStatus:'rejected'});
    }finally{db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId);await rm(root,{recursive:true,force:true})}
  });

  it('never lets a model recheck downgrade a deterministic confirmation',async()=>{
    const jobId=`job-${nanoid()}`,findingId=`finding-${nanoid()}`,issueId=`issue-${nanoid()}`,time=now();
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,created_at,updated_at) VALUES(?,'html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review',?,?)`).run(jobId,'b'.repeat(64),time,time);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,confidence,corroborated,decision,created_at,updated_at) VALUES(?,?,'deterministic','svg-semantics-degraded','error','SVG semantics degraded','Lost a safe viewBox','block-1','[]','high',1,'pending',?,?)`).run(findingId,jobId,time,time);
    db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,status,confidence,corroborated,target_refs_json,evidence_json,source_actions_json,created_at,updated_at) VALUES(?,?,?,'svg-semantics-degraded','error','SVG semantics degraded','Lost a safe viewBox','confirmed','pending','high',1,'["block-1"]','[]','[]',?,?)`).run(issueId,jobId,'e'.repeat(64),time,time);
    db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issueId,findingId);
    let calls=0;try{const result=await recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async()=>{calls++;throw new Error('must not call')}});expect(calls).toBe(0);expect(result.reviewIssues[0]).toMatchObject({verificationStatus:'confirmed',corroborated:true});}finally{db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId)}
  });

  it('does not confirm or clean-reject an issue from evidence the recheck did not review',async()=>{
    const jobId=`job-${nanoid()}`,findingId=`finding-${nanoid()}`,issueId=`issue-${nanoid()}`,time=now(),root=join(config.dataDir,'imports',jobId),evidenceIds=['object-one','object-two','object-three','object-four','object-five','object-six'],indexedIds=evidenceIds.slice(0,5),evidenceJson=JSON.stringify(evidenceIds.map(id=>({id,kind:'object'})));
    await mkdir(join(root,'evidence'),{recursive:true});for(const id of indexedIds)await writeFile(join(root,'evidence',`${id}.png`),Buffer.from([137,80,78,71,13,10,26,10]));
    await writeFile(join(root,'evidence','index.json'),JSON.stringify(indexedIds.map(id=>({id,relativePath:`evidence/${id}.png`,mimeType:'image/png'}))));
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,max_calls,call_count,created_at,updated_at) VALUES(?,'html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review',2,0,?,?)`).run(jobId,'9'.repeat(64),time,time);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,confidence,corroborated,decision,created_at,updated_at) VALUES(?,?,'model','figure-cropped','error','Figure cropped','Visible crop','block-1',?,'high',0,'pending',?,?)`).run(findingId,jobId,evidenceJson,time,time);
    db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,status,confidence,corroborated,target_refs_json,evidence_json,source_actions_json,created_at,updated_at) VALUES(?,?,?,'figure-cropped','error','Figure cropped','Visible crop','unverified','pending','high',0,'["block-1"]',?,'["import-visual-audit"]',?,?)`).run(issueId,jobId,'8'.repeat(64),evidenceJson,time,time);
    db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issueId,findingId);
    const unsupportedRun=`${jobId}-run-unreviewed`,cleanRun=`${jobId}-run-clean`;for(const runId of[unsupportedRun,cleanRun])db.prepare("INSERT INTO model_runs(id,request_id,action,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,'import-adjudicate','deep','test','import-evidence','completed',?)").run(runId,runId,time);
    const finding={issueCode:'figure-cropped' as const,severity:'error' as const,evidenceRefs:['object-two'],targetRefs:['block-1'],observation:'The second image is cropped.',sourceComparison:'',confidence:'high' as const,suggestedRepair:null,requestedEvidenceRefs:[]};
    try{
      const unsupported=await recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async request=>{expect(request.evidenceRefs).toEqual(evidenceIds.slice(0,4));return{report:{version:1,verdict:'review',coverage:{reviewedRefs:['object-one','object-three','object-four'],unreviewedRefs:['object-two']},findings:[finding]},runId:unsupportedRun,modelId:'test',inputTokens:1,outputTokens:1}}});
      expect(unsupported.reviewIssues[0]).toMatchObject({verificationStatus:'unverified',verificationReason:expect.stringMatching(/all supplied evidence/)});
      expect(db.prepare('SELECT stage FROM import_jobs WHERE id=?').get(jobId)).toEqual({stage:'review'});
      const incompleteClean=await recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit:async request=>{expect(request.evidenceRefs).toEqual(evidenceIds.slice(0,4));expect(request.promptValues.evidenceManifestJson).toContain('object-five');expect(request.promptValues.evidenceManifestJson).toContain('object-six');return{report:{version:1,verdict:'clean',coverage:{reviewedRefs:evidenceIds.slice(0,4),unreviewedRefs:[]},findings:[]},runId:cleanRun,modelId:'test',inputTokens:1,outputTokens:1}}});
      expect(incompleteClean.reviewIssues[0]).toMatchObject({verificationStatus:'unverified',verificationReason:expect.stringMatching(/all supplied evidence/)});
      expect(db.prepare('SELECT stage,call_count FROM import_jobs WHERE id=?').get(jobId)).toEqual({stage:'review',call_count:2});
    }finally{db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId);await rm(root,{recursive:true,force:true})}
  });

  it('atomically reserves the model-call budget across concurrent rechecks',async()=>{
    const jobId=`job-${nanoid()}`,findingId=`finding-${nanoid()}`,issueId=`issue-${nanoid()}`,time=now(),root=join(config.dataDir,'imports',jobId),evidencePath=join(root,'evidence','pixel.png');
    await mkdir(join(root,'evidence'),{recursive:true});await writeFile(evidencePath,Buffer.from([137,80,78,71,13,10,26,10]));
    await writeFile(join(root,'evidence','index.json'),JSON.stringify([{id:'object-one',relativePath:'evidence/pixel.png',mimeType:'image/png'}]));
    db.prepare(`INSERT INTO import_jobs(id,source_kind,source_name,source_mime_type,source_path,source_hash,status,stage,max_calls,call_count,created_at,updated_at) VALUES(?,'html','paper.html','text/html','/tmp/paper.html',?,'review-ready','review',1,0,?,?)`).run(jobId,'c'.repeat(64),time,time);
    db.prepare(`INSERT INTO import_findings(id,import_job_id,source,issue_code,severity,title,description,target_ref,evidence_json,confidence,corroborated,decision,created_at,updated_at) VALUES(?,?,'model','figure-cropped','error','Figure cropped','Visible crop','block-1','[{"id":"object-one","kind":"object"}]','high',0,'pending',?,?)`).run(findingId,jobId,time,time);
    db.prepare(`INSERT INTO import_review_issues(id,import_job_id,fingerprint,issue_code,severity,title,description,verification_status,status,confidence,corroborated,target_refs_json,evidence_json,source_actions_json,created_at,updated_at) VALUES(?,?,?,'figure-cropped','error','Figure cropped','Visible crop','unverified','pending','high',0,'["block-1"]','[{"id":"object-one","kind":"object"}]','["import-visual-audit"]',?,?)`).run(issueId,jobId,'d'.repeat(64),time,time);
    db.prepare('INSERT INTO import_review_issue_findings(issue_id,finding_id)VALUES(?,?)').run(issueId,findingId);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve}),audit=async()=>{entered();await hold;throw new Error('synthetic provider failure')};
    try{
      const first=recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit});expect(db.prepare('SELECT stage FROM import_jobs WHERE id=?').get(jobId)).toEqual({stage:'review-recheck'});expect(()=>saveReviewerFeedback(jobId,issueId,{decision:'dismissed'})).toThrow();await started;
      expect(db.prepare('SELECT stage FROM import_jobs WHERE id=?').get(jobId)).toEqual({stage:'review-recheck'});
      await expect(recheckAcademicReviewIssues(jobId,[issueId],undefined,{audit})).rejects.toMatchObject({statusCode:409});
      release();await expect(first).resolves.toMatchObject({callsUsed:1,failedCalls:1});
      expect(db.prepare('SELECT stage,call_count FROM import_jobs WHERE id=?').get(jobId)).toEqual({stage:'review',call_count:1});
    }finally{release?.();db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId);await rm(root,{recursive:true,force:true})}
  });
});
