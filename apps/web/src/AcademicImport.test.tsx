import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {parseAppRoute} from './App.js';
import {
  ImportFindingCard,
  academicImportAccept,
  availableImportJobActions,
  clampImportCallLimit,
  importJobStageLabel,
  normalizeImportFinding,
  normalizeImportDialogPolicy,
  normalizeImportJobs,
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
    }]})).toEqual([expect.objectContaining({
      id:'job-1',sourceName:'Draft.docx',stage:'ai-review',progress:63,
      warningCount:4,findingCount:2,callsUsed:7,maxCalls:30,
    })]);
    expect(importJobStageLabel('ai-review')).toBe('AI/VLM review');
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
