import { describe, expect, it } from 'vitest';
import type { ImportAuditReport, ImportRepairProposal } from '@afterdraft/shared';
import { automaticImportRepairDecision, corroborateImportRepair, importRepairOperation } from './repairs.js';

const manifest = {
  views:[{
    viewport:{name:'narrow',width:768,height:1400},
    objects:[{blockId:'table-1',tag:'table',visible:true,clippedX:true,clientWidth:720,scrollWidth:1320,rect:{x:24,width:720}}],
  }],
};
const html = '<div class="afterdraft-table-scroll"><table data-block-id="table-1" width="1320" style="width:1320px"><tbody><tr><td>Scholarly cell text</td></tr></tbody></table></div><math data-block-id="equation-1"><mi>x</mi></math><p data-block-id="prose-1">Do not rewrite me</p>';
const base: Omit<ImportAuditReport['findings'][number],'suggestedRepair'> = {
  issueCode:'table-overflow',severity:'warning',evidenceRefs:['narrow-shot'],targetRefs:['table-1'],
  observation:'The table exceeds its reading column.',sourceComparison:'',confidence:'high',requestedEvidenceRefs:[],
};

describe('academic import repair policy',()=>{
  it('does not call an intentionally scrollable table cropped',()=>{
    const finding={...base,suggestedRepair:{type:'wrap-overflow',targetRef:'table-1'}} satisfies ImportAuditReport['findings'][number];
    expect(corroborateImportRepair(finding,manifest,html)).toBe(false);
    expect(automaticImportRepairDecision(finding,false,true)).toBe('pending');
    expect(automaticImportRepairDecision(finding,true,false)).toBe('pending');
    expect(automaticImportRepairDecision({...finding,confidence:'medium'},true,true)).toBe('pending');
  });

  it('never translates manuscript, equation, citation, caption, or move suggestions',()=>{
    const prohibited=[
      {type:'join-source-fragments',targetRef:'prose-1',sourceRefs:['a','b']},
      {type:'associate-caption',targetRef:'table-1',captionRef:'prose-1'},
      {type:'move-object',targetRef:'table-1',destinationRef:'prose-1',position:'after'},
      {type:'draft-alt-text',targetRef:'table-1',text:'Model-authored content'},
    ] satisfies ImportRepairProposal[];
    for(const repair of prohibited)expect(importRepairOperation(repair)).toBeNull();
    const equation={...base,targetRefs:['equation-1'],suggestedRepair:{type:'clear-fixed-dimensions',targetRef:'equation-1'}} satisfies ImportAuditReport['findings'][number];
    expect(corroborateImportRepair(equation,manifest,html)).toBe(false);
  });

  it('requires measured overflow, a fixed dimension when clearing one, and a real table scroll host',()=>{
    const clear={...base,suggestedRepair:{type:'clear-fixed-dimensions',targetRef:'table-1'}} satisfies ImportAuditReport['findings'][number];
    expect(corroborateImportRepair(clear,manifest,html)).toBe(false);
    expect(corroborateImportRepair(clear,{views:[{viewport:{width:768},objects:[{blockId:'table-1',tag:'table',visible:true,clientWidth:720,scrollWidth:720,rect:{x:24,width:720}}]}]},html)).toBe(false);
    expect(corroborateImportRepair({...base,suggestedRepair:{type:'wrap-overflow',targetRef:'table-1'}},manifest,html.replace('class="afterdraft-table-scroll"',''))).toBe(false);
  });

  it('corroborates vertical cropping at a semantic figure root when nested media has fixed dimensions',()=>{
    const figureHtml=`${html}<figure data-block-id="figure-1"><img data-block-id="image-1" width="900" height="420" src="/figure.png"></figure>`,finding={...base,issueCode:'figure-cropped' as const,targetRefs:['figure-1'],suggestedRepair:{type:'clear-fixed-dimensions' as const,targetRef:'figure-1'}},vertical={views:[{viewport:{width:768,height:900},objects:[{blockId:'figure-1',tag:'figure',visible:true,clippedY:true,clientHeight:150,scrollHeight:420,overflowY:'hidden',rect:{x:24,width:720}}]}]};
    expect(corroborateImportRepair(finding,vertical,figureHtml)).toBe(true);
    expect(corroborateImportRepair(finding,{views:[{viewport:{width:768,height:900},objects:[{blockId:'figure-1',tag:'figure',visible:true,clippedY:true,clientHeight:150,scrollHeight:420,overflowY:'auto',rect:{x:24,width:720}}]}]},figureHtml)).toBe(false);
    expect(corroborateImportRepair(finding,{views:[{viewport:{width:768,height:900},objects:[{blockId:'figure-1',tag:'figure',visible:true,clippedY:true,clientHeight:150,scrollHeight:420,overflowY:'scroll',rect:{x:24,width:720}}]}]},figureHtml)).toBe(false);
    expect(corroborateImportRepair(finding,{views:[{viewport:{width:768,height:900},objects:[{blockId:'figure-1',tag:'figure',visible:true,clippedY:false,clientHeight:420,scrollHeight:420,overflowY:'visible',rect:{x:24,width:720}}]}]},figureHtml)).toBe(false);
  });
});
