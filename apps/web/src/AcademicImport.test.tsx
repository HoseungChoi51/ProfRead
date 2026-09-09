import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {parseAppRoute} from './App.js';
import {
  ImportFindingCard,
  RepairBatchPanel,
  ReviewIssueCard,
  academicCompanionPdfAllowed,
  academicImportAccept,
  academicUploadSourceKind,
  availableImportJobActions,
  clampImportCallLimit,
  importFallbackGuidance,
  importJobStageLabel,
  isImportJobTerminal,
  directRepairLabel,
  groupReviewIssues,
  issueEvidenceForDisplay,
  normalizeAcademicWebReference,
  normalizeImportDetail,
  normalizeImportFinding,
  normalizeImportDialogPolicy,
  normalizeImportJobs,
  normalizeImportSourceSummary,
  normalizeRepairBatch,
  normalizeReviewIssue,
  openReviewIssue,
  repairBatchRequest,
  adjudicationReviewFeedbackUpdates,
  reviewerPolicyPayload as rememberPolicyPayload,
  reviewerPolicyDomain,
  reviewVerification,
  selectedReviewFeedbackUpdates,
} from './AcademicImport.js';
import {academicImportTasks,isAcademicImportPrompt,isActiveAcademicImportPrompt,normalizeAcademicPolicy,normalizeReviewerPolicies,reviewerPolicyPayload as settingsPolicyPayload,reviewerPolicyScopeLabel} from './Settings.js';

describe('academic import navigation and input policy',()=>{
  it('routes persisted job reviews independently from documents',()=>{
    expect(parseAppRoute('/imports/job%201')).toEqual({kind:'import',id:'job 1'});
    expect(parseAppRoute('/documents/document-1')).toEqual({kind:'document',id:'document-1'});
    expect(parseAppRoute('/')).toEqual({kind:'library'});
  });

  it('offers the supported academic source extensions',()=>{
    expect(academicImportAccept).toContain('.docx');
    expect(academicImportAccept).toContain('.tex');
    expect(academicImportAccept).toContain('.zip');
    expect(academicImportAccept).toContain('.html');
    expect(academicImportAccept).toContain('.pdf');
    expect(academicImportAccept).toContain('application/pdf');
  });

  it('routes a primary PDF separately and only offers companions for TeX inputs',()=>{
    expect(academicUploadSourceKind({name:'paper.pdf',type:''})).toBe('pdf');
    expect(academicUploadSourceKind({name:'paper.bin',type:'application/pdf'})).toBe('pdf');
    expect(academicUploadSourceKind({name:'paper.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})).toBe('upload');
    expect(academicCompanionPdfAllowed({name:'main.tex'})).toBe(true);
    expect(academicCompanionPdfAllowed({name:'project.ZIP'})).toBe(true);
    expect(academicCompanionPdfAllowed({name:'paper.pdf'})).toBe(false);
    expect(academicCompanionPdfAllowed(null)).toBe(false);
  });

  it('accepts public HTTPS article URLs and bare DOI references',()=>{
    expect(normalizeAcademicWebReference(' 10.1515/nanoph-2023-0852 ')).toBe('10.1515/nanoph-2023-0852');
    expect(normalizeAcademicWebReference('https://publisher.example/paper')).toBe('https://publisher.example/paper');
    expect(normalizeAcademicWebReference('http://publisher.example/paper')).toBeNull();
    expect(normalizeAcademicWebReference('https://user:secret@publisher.example/paper')).toBeNull();
    expect(normalizeAcademicWebReference('not a DOI')).toBeNull();
  });

  it('enforces the per-import model-call ceiling',()=>{
    expect(clampImportCallLimit(0)).toBe(1);
    expect(clampImportCallLimit(27.6)).toBe(28);
    expect(clampImportCallLimit(200)).toBe(40);
    expect(clampImportCallLimit(Number.NaN)).toBe(30);
  });

  it('uses saved importer defaults when opening a new import',()=>{
    expect(normalizeImportDialogPolicy({values:{enabled:false,maxCalls:14,sourceReference:false,autoApply:true}})).toEqual({enabled:false,maxCalls:14,sourceReference:false,autoApply:false});
    expect(normalizeImportDialogPolicy({})).toMatchObject({autoApply:false});
  });
});

describe('academic import job presentation',()=>{
  it('normalizes snake-case persisted jobs and wrapped list responses',()=>{
    expect(normalizeImportJobs({jobs:[{
      id:'job-1',source_name:'Draft.docx',status:'ai_review',progress:63,
      warning_count:4,finding_count:2,calls_used:7,max_calls:30,document_id:null,
      source_kind:'pdf',document_title:'A discovered paper title',
    }]})).toEqual([expect.objectContaining({
      id:'job-1',sourceName:'Draft.docx',stage:'ai-review',progress:63,
      warningCount:4,findingCount:2,callsUsed:7,maxCalls:30,
      sourceKind:'pdf',documentTitle:'A discovered paper title',
    })]);
    expect(importJobStageLabel('ai-review')).toBe('AI/VLM review');
    expect(importJobStageLabel('fetching')).toBe('Fetching publication');
    expect(importJobStageLabel('awaiting-selection')).toBe('Choose article pages');
    expect(isImportJobTerminal('awaiting-selection')).toBe(true);
  });

  it('normalizes a private magazine page index into confirmable public thumbnails',()=>{
    const detail=normalizeImportDetail({id:'article-job',source_name:'issue.pdf',source_kind:'pdf',status:'awaiting-selection',articleSelection:{title:'Target',pageCount:72,aiBoundary:true,pages:[{page:22,textLength:381,titleCoverage:1,excerpt:'Target',thumbnailUrl:'/api/import-jobs/article-job/article-pages/22/thumbnail'}],suggestion:{startPage:22,endPage:28,confidence:'high',source:'local',rationale:'Unique title.',evidencePages:[22,28]}}});
    expect(detail.articleSelection).toEqual(expect.objectContaining({title:'Target',pageCount:72,aiBoundary:true,suggestion:expect.objectContaining({startPage:22,endPage:28,source:'local'}),pages:[expect.objectContaining({page:22,thumbnailUrl:'/api/import-jobs/article-job/article-pages/22/thumbnail'})]}));
  });

  it('summarizes PDF and publisher provenance without exposing internal paths',()=>{
    expect(normalizeImportSourceSummary({source:{kind:'pdf',pageCount:12,convertedPageCount:12,textMode:'native'}},'pdf')).toEqual({label:'PDF source',detail:'12/12 pages converted · native text',origin:null});
    expect(normalizeImportSourceSummary({source:{kind:'publisher-html',requestedUrl:'https://doi.org/10.1/example',finalUrl:'https://publisher.example/full',doi:'10.1/example',assetCount:7,adapter:'jats',directFailure:'Publisher page fell back to a structured source.'}},'url')).toEqual({
      label:'Web · publisher.example',
      detail:'7 assets localized · DOI 10.1/example · jats adapter · fallback used',
      origin:'https://publisher.example/full',
    });
  });

  it('provides actionable source-specific failure help',()=>{
    expect(importFallbackGuidance('url')).toContain('upload the paper PDF');
    expect(importFallbackGuidance('pdf')).toContain('text-searchable PDF');
    expect(importFallbackGuidance('docx')).toBeNull();
  });

  it('gates job actions by persisted state',()=>{
    expect(availableImportJobActions('converting',null)).toEqual(['review','cancel']);
    expect(availableImportJobActions('failed',null)).toEqual(['review','retry','cancel']);
    expect(availableImportJobActions('published','document-1')).toEqual(['open']);
  });

  it('renders evidence and only exposes an auto repair when corroborated',()=>{
    const finding=normalizeImportFinding({
      id:'finding-1',code:'fixed-width-overflow',title:'Table is clipped',description:'The last column is not visible.',
      severity:'error',confidence:.96,corroborated:true,repairDescription:'Wrap the table for horizontal scrolling.',
      evidence:[{id:'before',label:'Converted output',url:'/api/import-jobs/job-1/evidence/before'}],
    });
    const html=renderToStaticMarkup(<ImportFindingCard finding={finding} busy={false} onDecision={()=>{}} onEvidence={()=>{}} onTarget={()=>{}}/>);
    expect(html).toContain('Table is clipped');
    expect(html).toContain('Converted output');
    expect(html).toContain('Accept repair');
    expect(html).toContain('Deterministic check agrees');

    const modelOnly=renderToStaticMarkup(<ImportFindingCard finding={{...finding,corroborated:false}} busy={false} onDecision={()=>{}} onEvidence={()=>{}} onTarget={()=>{}}/>);
    expect(modelOnly).not.toContain('Accept repair');
    expect(modelOnly).toContain('Model observation only');
    const medium=renderToStaticMarkup(<ImportFindingCard finding={{...finding,confidence:.7}} busy={false} onDecision={()=>{}} onEvidence={()=>{}} onTarget={()=>{}}/>);expect(medium).not.toContain('Accept repair');
  });

  it('normalizes persisted model finding names, confidence levels, and repairs',()=>{
    expect(normalizeImportFinding({
      id:'finding-2',issueCode:'table-overflow',targetRef:'block-table',confidence:'high',
      repair:{type:'wrap-overflow',targetRef:'block-table'},decision:'pending',
    })).toMatchObject({
      code:'table-overflow',targetRef:'block-table',blockId:'block-table',
      confidence:.95,repair:'wrap overflow',
    });
  });

  it('normalizes grouped review issues and preserves feedback aliases',()=>{
    const issue=normalizeReviewIssue({
      issue_id:'issue-1',job_id:'job-1',issue_code:'table-overflow',status:'pending',confidence:'high',corroborated:true,source:'model',
      target_refs:['table-1','table-1'],finding_ids:['finding-1'],proposed_repair:{type:'clear-fixed-dimensions',target_ref:'table-1'},repairable:true,
      feedback:{verdict:'dismissed',comment:'Expected wide source table',reviewer_note:'Publisher layout is intentional'},
    });
    expect(issue).toMatchObject({id:'issue-1',jobId:'job-1',code:'table-overflow',verification:'confirmed',confidence:.95,source:'model',targetRefs:['table-1'],repairable:true,feedback:{decision:'dismissed',reason:'Expected wide source table',note:'Publisher layout is intentional'}});
    expect(directRepairLabel(issue)).toBe('Clear fixed dimensions');
    expect(directRepairLabel(normalizeReviewIssue({id:'svg',proposedRepair:{type:'restore-svg-semantics',targetRef:'svg-1'},repairable:true,corroborated:true}))).toBe('Restore SVG geometry and markers');
    expect(reviewVerification('dismissed',true)).toBe('rejected');
    expect(reviewVerification('accepted',false)).toBe('resolved');
  });

  it('falls back from legacy findings while keeping native review issues distinguishable',()=>{
    const legacy=normalizeImportDetail({id:'legacy-job',source_name:'paper.html',status:'review-ready',findings:[{id:'finding-1',issue_code:'missing-alt-text',decision:'dismissed'}]});
    expect(legacy.nativeReviewIssues).toBe(false);
    expect(legacy.reviewIssues[0]).toMatchObject({id:'finding-1',code:'missing-alt-text',verification:'rejected'});
    const native=normalizeImportDetail({id:'new-job',sourceName:'paper.pdf',status:'review-ready',reviewIssues:[{id:'issue-2',issueCode:'figure-cropped',verificationStatus:'unverified'}],repairBatches:[]});
    expect(native.nativeReviewIssues).toBe(true);
    expect(native.reviewIssues[0]).toMatchObject({id:'issue-2',verification:'unverified'});
  });

  it('normalizes candidate repair batches and groups issue verification in workflow order',()=>{
    const batch=normalizeRepairBatch({batch_id:'batch-1',status:'draft',issue_ids:['i1'],candidate_derivative_hash:'a'.repeat(64),operations:[{id:'op-1',type:'set-object-layout',target_ref:'figure-1',width:'full',alignment:'center'}],validation:{canonical_unchanged:true,inventory_unchanged:true,errors:[]}});
    expect(batch).toMatchObject({id:'batch-1',status:'draft',issueIds:['i1'],operations:[{id:'op-1',serverId:'op-1',type:'set-object-layout'}],validation:{canonicalUnchanged:true,inventoryUnchanged:true,errors:[]}});
    expect(batch.operations[0]?.label).toContain('full, center');
    const confirmed=normalizeReviewIssue({id:'confirmed',corroborated:true}),unverified=normalizeReviewIssue({id:'unverified'}),rejected=normalizeReviewIssue({id:'rejected',status:'dismissed'}),resolved=normalizeReviewIssue({id:'resolved',status:'manual'});
    expect(groupReviewIssues([resolved,rejected,unverified,confirmed]).map(group=>group.verification)).toEqual(['confirmed','unverified','rejected','resolved']);
  });

  it('renders actionable verified issues without offering direct repair to unverified observations',()=>{
    const issue=normalizeReviewIssue({id:'issue-1',issueCode:'responsive-regression',title:'Fixed image width',description:'Image clips on a narrow viewport.',status:'pending',confidence:'high',corroborated:true,repairable:true,targetRefs:['figure-1'],proposedRepair:{type:'clear-fixed-dimensions',targetRef:'figure-1'},feedback:{reason:'Preserve the caption',note:'Checked source PDF'}});
    const html=renderToStaticMarkup(<ReviewIssueCard issue={issue} selected feedbackEnabled busy={false} onSelected={()=>{}} onSave={async()=>{}} onDirectRepair={async()=>{}} onDraftChange={()=>{}} onEvidence={()=>{}} onTarget={()=>{}} onRemember={()=>{}}/>);
    expect(html).toContain('Clear fixed dimensions');
    expect(html).toContain('Handle after publishing');
    expect(html).toContain('Remember response');
    expect(html).toContain('Preserve the caption');
    const unverified=renderToStaticMarkup(<ReviewIssueCard issue={{...issue,corroborated:false,verification:'unverified'}} selected={false} feedbackEnabled busy={false} onSelected={()=>{}} onSave={async()=>{}} onDirectRepair={async()=>{}} onDraftChange={()=>{}} onEvidence={()=>{}} onTarget={()=>{}} onRemember={()=>{}}/>);
    expect(unverified).not.toContain('Clear fixed dimensions');
    expect(unverified).toContain('Reviewer observation only');
  });

  it('shows target context and close-ups instead of scaling a full-document overview',()=>{
    const evidence=[
      {id:'overview',label:'Narrow reading-view overview',url:'/api/import-jobs/job/evidence/overview',kind:'overview' as const,detail:null},
      {id:'context',label:'Narrow reading-view context around figure',url:'/api/import-jobs/job/evidence/context',kind:'context' as const,detail:null},
      {id:'object',label:'Narrow figure close-up',url:'/api/import-jobs/job/evidence/object',kind:'object' as const,detail:null},
    ];
    expect(issueEvidenceForDisplay(evidence)).toEqual(evidence.slice(1));
    expect(issueEvidenceForDisplay([evidence[0]!])).toEqual([evidence[0]]);
    const issue=normalizeReviewIssue({id:'issue-context',issueCode:'figure-cropped',title:'Figure cropped',status:'pending',evidence});
    const html=renderToStaticMarkup(<ReviewIssueCard issue={issue} selected={false} feedbackEnabled busy={false} onSelected={()=>{}} onSave={async()=>{}} onDirectRepair={async()=>{}} onDraftChange={()=>{}} onEvidence={()=>{}} onTarget={()=>{}} onRemember={()=>{}}/>);
    expect(html).toContain('Narrow reading-view context around figure');
    expect(html).toContain('Narrow figure close-up');
    expect(html).not.toContain('Narrow reading-view overview');
  });

  it('lets an open commented issue enter batch planning before a repair exists and renders textual evidence',()=>{
    const issue=normalizeReviewIssue({id:'issue-commented',issueCode:'citation-mismatch',title:'Check citation',status:'pending',verificationStatus:'unverified',repairable:false,evidence:[{id:'source-comparison',kind:'source-comparison',label:'Source comparison',storagePath:'/srv/private/import.png',comparison:{source:'[12]',output:'[21]'}}]});
    const html=renderToStaticMarkup(<ReviewIssueCard issue={issue} selected={false} feedbackEnabled busy={false} onSelected={()=>{}} onSave={async()=>{}} onDirectRepair={async()=>{}} onDraftChange={()=>{}} onEvidence={()=>{}} onTarget={()=>{}} onRemember={()=>{}}/>);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="checkbox" disabled');
    expect(html).toContain('Save comment');
    expect(issue.evidence[0]?.detail).toContain('&quot;source&quot;'.replaceAll('&quot;','"'));
    expect(JSON.stringify(issue)).not.toContain('/srv/private');
    expect(repairBatchRequest([issue.id,issue.id],'planner')).toEqual({issueIds:['issue-commented'],strategy:'planner'});
    expect(repairBatchRequest([issue.id],'delegate')).toEqual({issueIds:['issue-commented'],strategy:'delegate'});
    expect(selectedReviewFeedbackUpdates(['issue-b','issue-a','issue-b'],{'issue-a':{comment:'Preserve symbols',note:'Compared with PDF'},'issue-b':{comment:'Move after paragraph 4',note:''}})).toEqual([
      {issueId:'issue-b',comment:'Move after paragraph 4',note:''},
      {issueId:'issue-a',comment:'Preserve symbols',note:'Compared with PDF'},
    ]);
    expect(adjudicationReviewFeedbackUpdates([],{'issue-a':{comment:'Preserve symbols',note:'Compared with PDF'},'issue-b':{comment:'Move after paragraph 4',note:''}}).map(item=>item.issueId).sort()).toEqual(['issue-a','issue-b']);
    expect(adjudicationReviewFeedbackUpdates(['issue-b'],{'issue-a':{comment:'Preserve symbols',note:'Compared with PDF'},'issue-b':{comment:'Move after paragraph 4',note:''}}).map(item=>item.issueId)).toEqual(['issue-b']);
  });

  it('keeps reviewer-confirmed issues open and explains delegated candidates that change structure',()=>{
    const confirmed=normalizeReviewIssue({id:'confirmed',issueCode:'broken-reading-order',title:'Split title',status:'accepted',verificationStatus:'confirmed',feedback:{decision:'accepted',comment:'Join the title fragments.'}});
    expect(openReviewIssue(confirmed)).toBe(true);
    const issueHtml=renderToStaticMarkup(<ReviewIssueCard issue={confirmed} selected feedbackEnabled busy={false} onSelected={()=>{}} onSave={async()=>{}} onDirectRepair={async()=>{}} onDraftChange={()=>{}} onEvidence={()=>{}} onTarget={()=>{}} onRemember={()=>{}}/>);
    expect(issueHtml).toContain('User-confirmed and open for AI delegation');expect(issueHtml).not.toContain('type="checkbox" disabled');
    const batch=normalizeRepairBatch({id:'delegated',status:'draft',operations:[{id:'join',proposal:{type:'join-source-fragments',targetRef:'title-1',sourceRefs:['title-2']}}],validation:{canonicalUnchanged:false,inventoryUnchanged:true,errors:[],delegated:true,userConfirmed:true}}),batchHtml=renderToStaticMarkup(<RepairBatchPanel batches={[batch]} selectedId="delegated" busy={false} onSelect={()=>{}} onRefresh={()=>{}} onAccept={()=>{}} onRevert={()=>{}}/>);
    expect(batch.operations[0]?.targetRefs).toEqual(['title-1','title-2']);expect(batchHtml).toContain('Structure/text changed · user-confirmed');expect(batchHtml).toContain('AI delegated');expect(batchHtml).toContain('approve only operations that preserve the article');
  });

  it('shows validated candidate operations and builds guidance-only memory payloads',()=>{
    const batch=normalizeRepairBatch({id:'batch-1',status:'draft',operations:[{id:'operation-1',type:'clear-fixed-dimensions',targetRef:'figure-1'}],validation:{canonicalUnchanged:true,inventoryUnchanged:true,errors:[]}});
    const html=renderToStaticMarkup(<RepairBatchPanel batches={[batch]} selectedId="batch-1" busy={false} onSelect={()=>{}} onRefresh={()=>{}} onAccept={()=>{}} onRevert={()=>{}}/>);
    expect(html).toContain('Text unchanged');
    expect(html).toContain('Inventory unchanged');
    expect(html).toContain('Accept selected repairs');
    const issue=normalizeReviewIssue({id:'issue-1',issueCode:'table-overflow',source:'model'});
    expect(rememberPolicyPayload(issue,'category-source','lower-priority','Wide tables are expected')).toEqual({name:'Wide tables are expected',enabled:true,priority:100,match:{issueCode:'table-overflow',source:'model'},action:'lower-priority'});
    const broad=normalizeRepairBatch({id:'batch-css',status:'draft',operations:[{id:'operation-css',rationale:'Remove only clipping.',proposal:{type:'derived-html-css-patch',targetRefs:['figure-1'],patch:'{"operations":[{"targetRef":"figure-1","setStyle":{"overflow":null}}]}'}}],validation:{canonicalUnchanged:true,inventoryUnchanged:true,errors:[]}});
    const broadHtml=renderToStaticMarkup(<RepairBatchPanel batches={[broad]} selectedId="batch-css" busy={false} onSelect={()=>{}} onRefresh={()=>{}} onAccept={()=>{}} onRevert={()=>{}}/>);
    expect(broadHtml).toContain('Review exact change');
    expect(broadHtml).toContain('Proposed presentation patch');
    expect(broadHtml).toContain('Remove only clipping.');
    expect(broadHtml).toContain('disabled');
    const staleHtml=renderToStaticMarkup(<RepairBatchPanel batches={[{...batch,status:'stale'}]} selectedId="batch-1" busy={false} onSelect={()=>{}} onRefresh={()=>{}} onAccept={()=>{}} onRevert={()=>{}}/>);
    expect(staleHtml).toContain('Rebuild candidate');
  });
});

describe('academic importer settings',()=>{
  it('keeps import review prompts and routes separate from reader actions',()=>{
    expect(academicImportTasks.map(([key])=>key)).toEqual([
      'import-triage','import-semantic-audit','import-visual-audit','import-repair-plan',
    ]);
    expect(isAcademicImportPrompt('system.import-review')).toBe(true);
    expect(isAcademicImportPrompt('import.visual-audit')).toBe(true);
    expect(isAcademicImportPrompt('contract.import-findings')).toBe(true);
    expect(isAcademicImportPrompt('contract.ask')).toBe(false);
    expect(isActiveAcademicImportPrompt('import.visual-audit')).toBe(true);
    expect(isActiveAcademicImportPrompt('import.repair-plan')).toBe(true);
    expect(isActiveAcademicImportPrompt('contract.import-repairs')).toBe(true);
    expect(isActiveAcademicImportPrompt('import.adjudicate')).toBe(false);
  });

  it('normalizes and bounds stored academic review defaults',()=>{
    const policy=normalizeAcademicPolicy({values:{enabled:false,max_calls:90,concurrency:8,source_reference:false,auto_apply:true},customized:true});
    expect(policy.values).toEqual({enabled:false,maxCalls:40,concurrency:2,sourceReference:false,autoApply:false});
    expect(policy.customized).toBe(true);
  });

  it('normalizes editable reviewer guidance without widening invalid matches or actions',()=>{
    const policies=normalizeReviewerPolicies({policies:[{policy_id:'policy-1',name:'  Wide publisher tables  ',enabled:0,priority:5000,matcher:{issue_code:'table-overflow',evidence_kind:'object',source:'model'},action:'lower-priority'}]});
    expect(policies[0]).toMatchObject({id:'policy-1',name:'Wide publisher tables',enabled:false,priority:5000,match:{issueCode:'table-overflow',evidenceKind:'object',source:'model'},action:'lower-priority'});
    expect(reviewerPolicyScopeLabel(policies[0]!)).toBe('issue table-overflow · evidence object · model findings');
    expect(settingsPolicyPayload({name:'  Stronger evidence ',enabled:true,priority:-3,issueCode:' figure-cropped ',evidenceKind:'',source:'deterministic',sourceAction:'',sourceKind:' url ',domain:' Publisher.Example ',action:'require-stronger-evidence'})).toEqual({name:'Stronger evidence',enabled:true,priority:0,match:{issueCode:'figure-cropped',source:'deterministic',sourceKind:'url',domain:'publisher.example'},action:'require-stronger-evidence'});
    expect(reviewerPolicyDomain('https://Publisher.Example/paper')).toBe('publisher.example');
    expect(reviewerPolicyDomain('not a URL')).toBeNull();
    expect(normalizeReviewerPolicies({policies:[{id:'unsafe',action:'dismiss'}]})[0]?.action).toBe('require-stronger-evidence');
  });
});
