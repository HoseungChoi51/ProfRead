import { describe, expect, it } from 'vitest';
import { boundedTriageOutline, planImageBatches, planOutlineChunks, selectRenderEvidence, type EvidenceItem } from './review.js';

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
    expect(plan.oversize).toBe(1);expect(plan.selected.map(value=>value.id)).toEqual(['a','b','c']);
    expect(plan.batches.map(batch=>batch.reduce((sum,value)=>sum+value.bytes,0))).toEqual([38_000_000,19_000_000]);
  });

  it('keeps deterministic render metrics associated with exact block IDs',()=>{
    const files:any[]=[{path:'renders/narrow.png',storagePath:'/tmp/narrow.png',bytes:80,sha256:'a'},{path:'objects/narrow/q1.png',storagePath:'/tmp/q1.png',bytes:40,sha256:'b'}];
    const selected=selectRenderEvidence({views:[{viewport:{name:'narrow'},screenshots:['renders/narrow.png'],objects:[{ref:'q1',blockId:'table-1',tag:'table'}],objectScreenshots:[{ref:'q1',path:'objects/narrow/q1.png'}]}]},files);
    expect(selected).toEqual(expect.arrayContaining([expect.objectContaining({kind:'overview',bytes:80}),expect.objectContaining({kind:'object',blockId:'table-1',tag:'table',bytes:40})]));
  });
});
