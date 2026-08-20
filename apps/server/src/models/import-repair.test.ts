import { describe,expect,it } from 'vitest';
import { importRepairTool,validateImportRepairPlan } from './import-repair.js';
import { promptTemplate } from './prompts.js';

function expectStrict(value:unknown):void{
  if(!value||typeof value!=='object')return;const item=value as Record<string,unknown>;
  if(item.type==='object'){expect(item.additionalProperties).toBe(false);expect(item.required).toEqual(Object.keys(item.properties as object));}
  for(const child of Object.values(item)){if(Array.isArray(child))child.forEach(expectStrict);else expectStrict(child)}
}

describe('import repair planner contract',()=>{
  it('gives authenticated reviewer comments bounded presentation authority without weakening safety',()=>{
    expect(promptTemplate('system.import-review')).toContain('may guide presentation goals and constraints only within the server-provided repair allowlist');
    expect(promptTemplate('import.repair-plan')).toContain('Authenticated reviewer presentation instructions');
    expect(promptTemplate('system.import-review')).toContain('never authorize content changes');
  });
  it('uses a strict provider tool schema',()=>{
    expectStrict(importRepairTool.schema);
    expect(JSON.stringify(importRepairTool.schema)).not.toMatch(/"(?:minLength|maxLength|oneOf|\$schema)"/);
  });

  it('accepts issue-linked structured and derived presentation repairs',()=>{
    const plan=validateImportRepairPlan({version:1,summary:'Repair two confirmed presentation defects.',proposals:[
      {issueId:'issue-svg',rationale:'Restore sanitizer-safe geometry from the immutable source.',proposal:{type:'restore-svg-semantics',targetRef:'block-svg'}},
      {issueId:'issue-css',rationale:'Remove only the clipping style.',proposal:{type:'derived-html-css-patch',targetRefs:['block-figure'],patch:JSON.stringify({operations:[{targetRef:'block-figure',setStyle:{overflow:null}}]})}},
    ]},['issue-svg','issue-css'],['block-svg','block-figure']);
    expect(plan.proposals.map(item=>item.issueId)).toEqual(['issue-svg','issue-css']);
  });

  it('rejects invented issue and target references',()=>{
    const value={version:1,summary:'Bounded repair.',proposals:[{issueId:'invented',rationale:'No.',proposal:{type:'clear-fixed-dimensions',targetRef:'block-1'}}]};
    expect(()=>validateImportRepairPlan(value,['issue-1'],['block-1'])).toThrow(/unknown issue/);
    expect(()=>validateImportRepairPlan({...value,proposals:[{...value.proposals[0],issueId:'issue-1',proposal:{type:'clear-fixed-dimensions',targetRef:'invented'}}]},['issue-1'],['block-1'])).toThrow(/unknown target/);
  });

  it('rejects duplicate issue-operation pairs',()=>{
    const proposal={type:'wrap-overflow',targetRef:'table-1'} as const,item={issueId:'issue-1',rationale:'Make the table horizontally scrollable.',proposal};
    expect(()=>validateImportRepairPlan({version:1,summary:'Duplicate.',proposals:[item,item]},['issue-1'],['table-1'])).toThrow(/more than one operation/);
  });

  it('rejects multiple different operations for one issue',()=>{
    expect(()=>validateImportRepairPlan({version:1,summary:'Too many.',proposals:[
      {issueId:'issue-1',rationale:'Wrap.',proposal:{type:'wrap-overflow',targetRef:'table-1'}},
      {issueId:'issue-1',rationale:'Resize.',proposal:{type:'set-object-layout',targetRef:'table-1',width:'full',alignment:'center',enlargeable:false}},
    ]},['issue-1'],['table-1'])).toThrow(/more than one operation/);
  });

  it('advertises and accepts only repairs supported by candidate validation',()=>{
    const schema=JSON.stringify(importRepairTool.schema);
    expect(schema).not.toMatch(/associate-caption|move-object|draft-alt-text/);
    expect(()=>validateImportRepairPlan({version:1,summary:'Unsafe.',proposals:[{
      issueId:'issue-1',rationale:'Invent text.',proposal:{type:'draft-alt-text',targetRef:'figure-1',text:'A guess.'},
    }]},['issue-1'],['figure-1'])).toThrow(/unsupported repair type/);
    expect(validateImportRepairPlan({version:1,summary:'No safe repair.',proposals:[{
      issueId:'issue-1',rationale:'Manual source editing is required.',proposal:null,
    }]},['issue-1'],['figure-1']).proposals[0]?.proposal).toBeNull();
  });
});
