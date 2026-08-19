import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {parseAppRoute} from './App.js';
import {
  ImportFindingCard,
  academicCompanionPdfAllowed,
  academicImportAccept,
  academicUploadSourceKind,
  availableImportJobActions,
  clampImportCallLimit,
  importFallbackGuidance,
  importJobStageLabel,
  normalizeAcademicWebReference,
  normalizeImportFinding,
  normalizeImportDialogPolicy,
  normalizeImportJobs,
  normalizeImportSourceSummary,
} from './AcademicImport.js';
import {academicImportTasks,isAcademicImportPrompt,isActiveAcademicImportPrompt,normalizeAcademicPolicy} from './Settings.js';

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
    expect(normalizeImportDialogPolicy({values:{enabled:false,maxCalls:14,sourceReference:false,autoApply:false}})).toEqual({enabled:false,maxCalls:14,sourceReference:false,autoApply:false});
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
    expect(availableImportJobActions('failed',null)).toEqual(['review','retry']);
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
});

describe('academic importer settings',()=>{
  it('keeps import review prompts and routes separate from reader actions',()=>{
    expect(academicImportTasks.map(([key])=>key)).toEqual([
      'import-triage','import-semantic-audit','import-visual-audit',
    ]);
    expect(isAcademicImportPrompt('system.import-review')).toBe(true);
    expect(isAcademicImportPrompt('import.visual-audit')).toBe(true);
    expect(isAcademicImportPrompt('contract.import-findings')).toBe(true);
    expect(isAcademicImportPrompt('contract.ask')).toBe(false);
    expect(isActiveAcademicImportPrompt('import.visual-audit')).toBe(true);
    expect(isActiveAcademicImportPrompt('import.adjudicate')).toBe(false);
  });

  it('normalizes and bounds stored academic review defaults',()=>{
    const policy=normalizeAcademicPolicy({values:{enabled:false,max_calls:90,concurrency:8,source_reference:false,auto_apply:false},customized:true});
    expect(policy.values).toEqual({enabled:false,maxCalls:40,concurrency:2,sourceReference:false,autoApply:false});
    expect(policy.customized).toBe(true);
  });
});
