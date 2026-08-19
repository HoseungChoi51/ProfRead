import { describe, expect, it } from 'vitest';
import { boundedTriageOutline, planImageBatches, planOutlineChunks, selectRenderEvidence, selectSourceEvidence, type EvidenceItem } from './review.js';

describe('academic review coverage planning',()=>{
  it('reports every outline cap instead of silently dropping blocks',()=>{
    const outline=Array.from({length:8},(_value,index)=>({ref:`b${index}`,tag:'p',text:'x'.repeat(20)}));
    const chunks=planOutlineChunks(outline,70,2),triage=boundedTriageOutline(outline,3,10_000);
    expect(chunks.chunks).toHaveLength(2);expect(chunks.truncated).toBe(true);
    expect(triage.items).toHaveLength(3);expect(triage.truncated).toBe(true);
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

  it('keeps deterministic render metrics associated with exact block IDs',()=>{
    const files:any[]=[{path:'renders/narrow.png',storagePath:'/tmp/narrow.png',bytes:80,sha256:'a'},{path:'objects/narrow/q1.png',storagePath:'/tmp/q1.png',bytes:40,sha256:'b'}];
    const selected=selectRenderEvidence({views:[{viewport:{name:'narrow'},screenshots:['renders/narrow.png'],objects:[{ref:'q1',blockId:'table-1',tag:'table'}],objectScreenshots:[{ref:'q1',path:'objects/narrow/q1.png'}]}]},files);
    expect(selected).toEqual(expect.arrayContaining([expect.objectContaining({kind:'overview',bytes:80}),expect.objectContaining({kind:'object',blockId:'table-1',tag:'table',bytes:40})]));
  });

  it('uses published PDF page fallbacks as source evidence without duplicate reference files',()=>{
    const files:any[]=[{path:'assets/pdf-page-001.jpg',storagePath:'/tmp/page-1.jpg',bytes:120,sha256:'a'},{path:'assets/pdf-object-p001-001.jpg',storagePath:'/tmp/object.jpg',bytes:80,sha256:'b'}];
    expect(selectSourceEvidence(files)).toEqual([expect.objectContaining({kind:'source-page',storagePath:'/tmp/page-1.jpg',mimeType:'image/jpeg',bytes:120})]);
  });
});
