import { describe, expect, it } from 'vitest';
import { reattach } from './reattach.js';

describe('anchor reattachment',()=>{
  it('prefers exact quote with surrounding context',()=>{
    const found=reattach({exact:'same quote',prefix:'right ',suffix:' ending',startOffset:50},[{blockId:'a',text:'wrong same quote place',start:0,end:22},{blockId:'b',text:'right same quote ending',start:40,end:63}]);
    expect(found.blockId).toBe('b');
    expect(found.status).toBe('attached');
  });

  it('marks weak fuzzy candidates unmatched',()=>expect(reattach({exact:'cryptographic protocol',prefix:'',suffix:'',startOffset:0},[{blockId:'x',text:'banana orchard',start:0,end:14}]).status).toBe('unmatched'));

  it('keeps a high-similarity non-exact candidate unmatched for explicit repair',()=>{
    const found=reattach({exact:'alpha beta gamma',prefix:'',suffix:'',startOffset:20},[{blockId:'changed',text:'alpha beta changed gamma',start:20,end:44}]);
    expect(found).toMatchObject({blockId:'changed',startOffset:0,endOffset:24,status:'unmatched'});
    expect(found.score).toBeGreaterThanOrEqual(.62);
  });

  it('keeps the selected repeated occurrence in a trusted block after earlier content shifts',()=>{
    const found=reattach(
      {exact:'target',prefix:'chosen ',suffix:' ending',startOffset:100,blockId:'selected',localStartOffset:7,blockIdentityReliable:true},
      [
        {blockId:'near-old-global',text:'chosen target ending',start:93,end:113},
        {blockId:'selected',text:'chosen target ending',start:500,end:520},
      ],
    );
    expect(found).toMatchObject({blockId:'selected',startOffset:7,endOffset:13,status:'attached'});
  });

  it('does not trust occurrence-derived block identity across indistinguishable versions',()=>{
    const found=reattach(
      {exact:'target',prefix:'chosen ',suffix:' ending',startOffset:100,blockId:'same-hash',localStartOffset:7},
      [
        {blockId:'same-hash',text:'chosen target ending',start:90,end:110},
        {blockId:'next-occurrence',text:'chosen target ending',start:500,end:520},
      ],
    );
    expect(found.status).toBe('unmatched');
  });

  it('marks repeated same-block quotes unmatched when stored context cannot identify one',()=>{
    const found=reattach(
      {exact:'target',prefix:'missing ',suffix:' context',startOffset:20,blockId:'stable',localStartOffset:0,blockIdentityReliable:true},
      [{blockId:'stable',text:'target between target',start:200,end:221}],
    );
    expect(found).toMatchObject({blockId:'stable',status:'unmatched'});
  });

  it('never attaches outside a trusted block when it is missing or the quote is absent there',()=>{
    const found=reattach(
      {exact:'target',prefix:'chosen ',suffix:' ending',startOffset:20,blockId:'stable',localStartOffset:7,blockIdentityReliable:true},
      [
        {blockId:'stable',text:'chosen replacement ending',start:100,end:125},
        {blockId:'other',text:'chosen target ending',start:200,end:220},
      ],
    );
    expect(found).toMatchObject({blockId:'stable',status:'unmatched'});
    expect(reattach(
      {exact:'target',prefix:'chosen ',suffix:' ending',startOffset:20,blockId:'removed',localStartOffset:7,blockIdentityReliable:true},
      [{blockId:'other',text:'chosen target ending',start:200,end:220}],
    )).toMatchObject({status:'unmatched'});
  });

  it('requires a unique source selector before cross-version attachment',()=>{
    const candidates=[{blockId:'survivor',text:'chosen target ending',start:100,end:120}];
    expect(reattach({exact:'target',prefix:'chosen ',suffix:' ending',startOffset:20,sourceContextOccurrenceCount:2},candidates).status).toBe('unmatched');
    expect(reattach({exact:'target',prefix:'chosen ',suffix:' ending',startOffset:20,sourceContextOccurrenceCount:1},candidates)).toMatchObject({blockId:'survivor',status:'attached'});
  });

  it('attaches a unique exact quote only when its stored context still matches',()=>{
    expect(reattach({exact:'target',prefix:'before ',suffix:' after',startOffset:10},[{blockId:'one',text:'before target after',start:100,end:119}])).toMatchObject({blockId:'one',status:'attached'});
    expect(reattach({exact:'target',prefix:'old ',suffix:' context',startOffset:10},[{blockId:'one',text:'new target setting',start:100,end:118}]).status).toBe('unmatched');
  });

  it('reattaches empty visual selections only by stable block identity',()=>{
    const candidates=[{blockId:'nearby',text:'Nearby paragraph',start:40,end:56},{blockId:'visual',text:'Diagram label',start:80,end:93}];
    expect(reattach({exact:'',prefix:'',suffix:'',startOffset:80,blockId:'visual'},candidates)).toEqual({blockId:'visual',startOffset:0,endOffset:0,score:1,status:'attached'});
    expect(reattach({exact:'',prefix:'',suffix:'',startOffset:42,blockId:'removed'},candidates)).toEqual({blockId:'nearby',startOffset:0,endOffset:0,score:0,status:'unmatched'});
  });
});
