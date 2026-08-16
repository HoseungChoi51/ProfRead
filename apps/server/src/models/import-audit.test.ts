import { describe,expect,it } from 'vitest';
import { importAuditReplayKey,importAuditTool,mayAutoApplyImportRepair,validateImportAuditReport } from './import-audit.js';

function expectStrict(value:unknown):void{
  if(!value||typeof value!=='object')return;const item=value as Record<string,unknown>;
  if(item.type==='object'){expect(item.additionalProperties).toBe(false);expect(item.required).toEqual(Object.keys(item.properties as object));}
  for(const child of Object.values(item)){if(Array.isArray(child))child.forEach(expectStrict);else expectStrict(child)}
}

const clean={version:1,verdict:'clean',coverage:{reviewedRefs:['shot-1'],unreviewedRefs:[]},findings:[]};

describe('import audit contract',()=>{
  it('uses a strict provider schema',()=>{expectStrict(importAuditTool.schema);expect(JSON.stringify(importAuditTool.schema)).not.toMatch(/"(?:minLength|maxLength|oneOf|\$schema)"/)});
  it('accepts a fully accounted evidence report',()=>{expect(validateImportAuditReport(clean,['shot-1'],['b1'])).toEqual(clean)});
  it('rejects invented evidence and repair targets',()=>{
    expect(()=>validateImportAuditReport({...clean,coverage:{reviewedRefs:['invented'],unreviewedRefs:[]}},['shot-1'],['b1'])).toThrow(/unknown/);
    expect(()=>validateImportAuditReport({...clean,verdict:'review',findings:[{issueCode:'table-overflow',severity:'warning',evidenceRefs:['shot-1'],targetRefs:['b1'],observation:'Wide table',sourceComparison:'',confidence:'high',suggestedRepair:{type:'wrap-overflow',targetRef:'b2'},requestedEvidenceRefs:[]}]},['shot-1'],['b1'])).toThrow(/unknown/);
  });
  it('only allows high-confidence, corroborated, reversible or exact-source repairs',()=>{const base={issueCode:'table-overflow' as const,severity:'warning' as const,evidenceRefs:['shot-1'],targetRefs:['b1'],observation:'Wide table',sourceComparison:'',confidence:'high' as const,requestedEvidenceRefs:[]};expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},true)).toBe(true);expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},false)).toBe(false);expect(mayAutoApplyImportRepair({...base,suggestedRepair:{type:'move-object',targetRef:'b1',destinationRef:'b2',position:'after'}},true)).toBe(false);expect(mayAutoApplyImportRepair({...base,confidence:'medium',suggestedRepair:{type:'wrap-overflow',targetRef:'b1'}},true)).toBe(false)});
  it('fingerprints prompts, model routes, evidence bytes, and references for replay',()=>{const request={jobId:'job-1',ordinal:2,action:'import-visual-audit' as const,evidenceRefs:['shot-1'],targetRefs:['b1'],images:[{id:'shot-1',mimeType:'image/png' as const,data:Buffer.from('one').toString('base64'),detail:'high' as const}]},key=importAuditReplayKey(request,'gpt-5.6-sol','system v1','prompt v1');expect(importAuditReplayKey(request,'gpt-5.6-sol','system v1','prompt v1')).toBe(key);expect(importAuditReplayKey(request,'gpt-5.6-terra','system v1','prompt v1')).not.toBe(key);expect(importAuditReplayKey(request,'gpt-5.6-sol','system v2','prompt v1')).not.toBe(key);expect(importAuditReplayKey({...request,images:[{...request.images[0]!,data:Buffer.from('two').toString('base64')}]},'gpt-5.6-sol','system v1','prompt v1')).not.toBe(key);expect(importAuditReplayKey({...request,targetRefs:['b2']},'gpt-5.6-sol','system v1','prompt v1')).not.toBe(key)});
});
