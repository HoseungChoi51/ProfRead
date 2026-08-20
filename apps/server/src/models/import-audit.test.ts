import { describe,expect,it } from 'vitest';
import { appendImportAuditReferenceContract,importAuditReplayKey,importAuditTool,mayAutoApplyImportRepair,validateImportAuditReport } from './import-audit.js';

function expectStrict(value:unknown):void{
  if(!value||typeof value!=='object')return;const item=value as Record<string,unknown>;
  if(item.type==='object'){expect(item.additionalProperties).toBe(false);expect(item.required).toEqual(Object.keys(item.properties as object));}
  for(const child of Object.values(item)){if(Array.isArray(child))child.forEach(expectStrict);else expectStrict(child)}
}

const clean={version:1,verdict:'clean',coverage:{reviewedRefs:['shot-1'],unreviewedRefs:[]},findings:[]};

describe('import audit contract',()=>{
  it('uses a strict provider schema',()=>{expectStrict(importAuditTool.schema);expect(JSON.stringify(importAuditTool.schema)).not.toMatch(/"(?:minLength|maxLength|oneOf|\$schema)"/)});
  it('accepts a fully accounted evidence report',()=>{expect(validateImportAuditReport(clean,['shot-1'],['b1'])).toEqual(clean)});
  it('requires reviewed and unreviewed evidence to be a true partition',()=>{
    expect(()=>validateImportAuditReport({...clean,coverage:{reviewedRefs:['shot-1'],unreviewedRefs:['shot-1','shot-2']}},['shot-1','shot-2'],['b1'])).toThrow(/both reviewed and unreviewed/);
  });
  it('never lets a finding cite evidence the model classified as unreviewed',()=>{
    const finding={issueCode:'figure-cropped' as const,severity:'error' as const,evidenceRefs:['shot-2'],targetRefs:['b1'],observation:'The figure is cropped.',sourceComparison:'',confidence:'high' as const,suggestedRepair:null,requestedEvidenceRefs:[]};
    expect(()=>validateImportAuditReport({version:1,verdict:'review',coverage:{reviewedRefs:['shot-1'],unreviewedRefs:['shot-2']},findings:[finding]},['shot-1','shot-2'],['b1'])).toThrow(/did not review/);
  });
  it('rejects invented evidence and repair targets',()=>{
    expect(()=>validateImportAuditReport({...clean,coverage:{reviewedRefs:['invented'],unreviewedRefs:[]}},['shot-1'],['b1'])).toThrow(/unknown/);
    expect(()=>validateImportAuditReport({...clean,verdict:'review',findings:[{issueCode:'table-overflow',severity:'warning',evidenceRefs:['shot-1'],targetRefs:['b1'],observation:'Wide table',sourceComparison:'',confidence:'high',suggestedRepair:{type:'wrap-overflow',targetRef:'b2'},requestedEvidenceRefs:[]}]},['shot-1'],['b1'])).toThrow(/unknown/);
  });
  it('disambiguates Luna triage coverage from block target references',()=>{
    const evidenceRefs=['manifest','outline','warnings'],targetRefs=['block-2831e0d85583461cb8e4'],prompt=appendImportAuditReferenceContract('Triage the conversion.',evidenceRefs,targetRefs);
    expect(prompt).toContain('Allowed evidenceRefs JSON: ["manifest","outline","warnings"]');
    expect(prompt).toContain('Allowed targetRefs JSON: ["block-2831e0d85583461cb8e4"]');
    expect(prompt).toContain('Never put a targetRef in coverage');
    expect(prompt).toContain('may cite only evidence listed in coverage.reviewedRefs');
    expect(()=>validateImportAuditReport({version:1,verdict:'clean',coverage:{reviewedRefs:targetRefs,unreviewedRefs:[]},findings:[]},evidenceRefs,targetRefs)).toThrow(/unknown reviewed evidence/);
    expect(validateImportAuditReport({version:1,verdict:'clean',coverage:{reviewedRefs:evidenceRefs,unreviewedRefs:[]},findings:[]},evidenceRefs,targetRefs).coverage.reviewedRefs).toEqual(evidenceRefs);
  });
  it('disambiguates Sol visual evidence IDs from finding target references',()=>{
    const evidenceRefs=['object-8fe2887b6a4cee81ac'],targetRefs=['block-figure-1'],prompt=appendImportAuditReferenceContract('Review the attached object.',evidenceRefs,targetRefs),finding={issueCode:'figure-cropped' as const,severity:'warning' as const,evidenceRefs,targetRefs:evidenceRefs,observation:'The visible object may be cropped.',sourceComparison:'',confidence:'high' as const,suggestedRepair:null,requestedEvidenceRefs:[]};
    expect(prompt).toContain('Allowed evidenceRefs JSON: ["object-8fe2887b6a4cee81ac"]');
    expect(prompt).toContain('Allowed targetRefs JSON: ["block-figure-1"]');
    expect(prompt).toContain('Never put an evidenceRef in a target field');
    expect(()=>validateImportAuditReport({version:1,verdict:'review',coverage:{reviewedRefs:evidenceRefs,unreviewedRefs:[]},findings:[finding]},evidenceRefs,targetRefs)).toThrow(/unknown finding target/);
    expect(validateImportAuditReport({version:1,verdict:'review',coverage:{reviewedRefs:evidenceRefs,unreviewedRefs:[]},findings:[{...finding,targetRefs}]},evidenceRefs,targetRefs).findings[0]?.targetRefs).toEqual(targetRefs);
  });
  it('only allows high-confidence, corroborated, reversible or exact-source repairs',()=>{const base={issueCode:'table-overflow' as const,severity:'warning' as const,evidenceRefs:['shot-1'],targetRefs:['b1'],observation:'Wide table',sourceComparison:'',confidence:'high' as const,requestedEvidenceRefs:[]};expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},true)).toBe(true);expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},false)).toBe(false);expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'move-object',targetRef:'b1',destinationRef:'b2',position:'after'}},true)).toBe(false);expect(mayAutoApplyImportRepair({...base,confidence:'medium',suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},true)).toBe(false)});
  it('permits a source-backed SVG restoration proposal but never auto-applies it',()=>{const finding={issueCode:'figure-cropped' as const,severity:'error' as const,evidenceRefs:['shot-1'],targetRefs:['svg-1'],observation:'SVG geometry was lost.',sourceComparison:'Source has a viewBox; preview does not.',confidence:'high' as const,requestedEvidenceRefs:[],suggestedRepair:{type:'restore-svg-semantics' as const,targetRef:'svg-1'}};expect(validateImportAuditReport({version:1,verdict:'blocking',coverage:{reviewedRefs:['shot-1'],unreviewedRefs:[]},findings:[finding]},['shot-1'],['svg-1']).findings[0]?.suggestedRepair).toEqual(finding.suggestedRepair);expect(mayAutoApplyImportRepair(finding,true)).toBe(false)});
  it('fingerprints prompts, model routes, evidence bytes, and references for replay',()=>{const request={jobId:'job-1',ordinal:2,action:'import-visual-audit' as const,evidenceRefs:['shot-1'],targetRefs:['b1'],images:[{id:'shot-1',mimeType:'image/png' as const,data:Buffer.from('one').toString('base64'),detail:'high' as const}]},key=importAuditReplayKey(request,'gpt-5.6-sol','system v1','prompt v1');expect(importAuditReplayKey(request,'gpt-5.6-sol','system v1','prompt v1')).toBe(key);expect(importAuditReplayKey(request,'gpt-5.6-terra','system v1','prompt v1')).not.toBe(key);expect(importAuditReplayKey(request,'gpt-5.6-sol','system v2','prompt v1')).not.toBe(key);expect(importAuditReplayKey({...request,images:[{...request.images[0]!,data:Buffer.from('two').toString('base64')}]},'gpt-5.6-sol','system v1','prompt v1')).not.toBe(key);expect(importAuditReplayKey({...request,targetRefs:['b2']},'gpt-5.6-sol','system v1','prompt v1')).not.toBe(key)});
});
