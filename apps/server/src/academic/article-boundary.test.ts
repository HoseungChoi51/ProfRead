import { describe,expect,it } from 'vitest';
import { validateArticleBoundarySuggestion } from './article-boundary.js';

describe('article boundary model contract',()=>{
  it('accepts a bounded inclusive suggestion and marks its source',()=>{
    expect(validateArticleBoundarySuggestion({version:1,startPage:22,endPage:28,confidence:'high',rationale:'The title spread begins on 22 and the next article begins after 28.',evidencePages:[22,23,28]},72)).toEqual({startPage:22,endPage:28,confidence:'high',source:'ai',rationale:'The title spread begins on 22 and the next article begins after 28.',evidencePages:[22,23,28]});
  });

  it('rejects reversed, out-of-issue, and duplicate evidence pages',()=>{
    const base={version:1,startPage:22,endPage:28,confidence:'low',rationale:'Ambiguous boundary.',evidencePages:[22,28]};
    expect(()=>validateArticleBoundarySuggestion({...base,startPage:29},72)).toThrow(/invalid page range/);
    expect(()=>validateArticleBoundarySuggestion({...base,endPage:73},72)).toThrow(/invalid page range/);
    expect(()=>validateArticleBoundarySuggestion({...base,evidencePages:[22,22]},72)).toThrow(/invalid evidence pages/);
  });
});
