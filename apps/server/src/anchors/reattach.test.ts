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

  it('reattaches empty visual selections only by stable block identity',()=>{
    const candidates=[{blockId:'nearby',text:'Nearby paragraph',start:40,end:56},{blockId:'visual',text:'Diagram label',start:80,end:93}];
    expect(reattach({exact:'',prefix:'',suffix:'',startOffset:80,blockId:'visual'},candidates)).toEqual({blockId:'visual',startOffset:0,endOffset:0,score:1,status:'attached'});
    expect(reattach({exact:'',prefix:'',suffix:'',startOffset:42,blockId:'removed'},candidates)).toEqual({blockId:'nearby',startOffset:0,endOffset:0,score:0,status:'unmatched'});
  });
});
