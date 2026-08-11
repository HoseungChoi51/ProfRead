import{describe,expect,it}from'vitest';import{contextBundleSchema,diagramSpecSchema,documentEditOperationSchema,summaryBasisSchema,summaryFreshnessSchema,summaryReviewResultSchema,taskActionSchema,visualRecapSchema,writerEditOperationSchema,writerProposalResultSchema,writerProposalToolInputSchema,writerProposalToolName,writerSourceRefSchema}from'./index.js';
describe('structured artifact contracts',()=>{it('rejects scriptable diagram IDs and unknown layouts',()=>{expect(()=>diagramSpecSchema.parse({version:1,title:'Bad',layout:'freeform',nodes:[],edges:[]})).toThrow();expect(()=>diagramSpecSchema.parse({version:1,title:'Bad',layout:'flow',nodes:[{id:'<script>',label:'x',sourceRefs:[]}],edges:[]})).toThrow()});it('caps visual recap sections at six',()=>{expect(()=>visualRecapSchema.parse({version:1,title:'x',thesis:'x',sections:Array.from({length:7},()=>({title:'x',summary:'x',sourceRefs:[]})),relationships:[],takeaways:[],openQuestions:[],sourceRefs:[]})).toThrow()});it('accepts only bounded integer image widths',()=>{expect(documentEditOperationSchema.parse({type:'resize-image',blockId:'image-1',width:640})).toMatchObject({width:640});expect(()=>documentEditOperationSchema.parse({type:'resize-image',blockId:'image-1',width:47})).toThrow();expect(()=>documentEditOperationSchema.parse({type:'resize-image',blockId:'image-1',width:640.5})).toThrow()})});
describe('reader signal contracts',()=>{it('accepts polish-note and typed reader signals',()=>{expect(taskActionSchema.parse('polish-note')).toBe('polish-note');expect(contextBundleSchema.parse({tier:'brief',article:'Body',branch:[],readerSignals:[{id:'signal-1',kind:'comment',exactQuote:'Claim',note:'Needs a caveat'}],curatedNotes:['[READER COMMENT] "Claim" — Needs a caveat'],tokenEstimate:12}).readerSignals[0]).toMatchObject({kind:'comment',note:'Needs a caveat'})});it('rejects unknown reader signal kinds',()=>{expect(()=>contextBundleSchema.parse({tier:'brief',article:'Body',readerSignals:[{id:'signal-1',kind:'favorite',exactQuote:'Claim',note:null}],tokenEstimate:1})).toThrow()})});

describe('document writer contracts',()=>{
  it('registers the document writer and summary review actions',()=>{
    expect(taskActionSchema.parse('document-write')).toBe('document-write');
    expect(taskActionSchema.parse('review-summary')).toBe('review-summary');
    expect(writerProposalToolName).toBe('propose_document_edits');
  });
  it('accepts only same-shape typed source references',()=>{
    expect(writerSourceRefSchema.parse({type:'message',id:'answer-1'})).toEqual({type:'message',id:'answer-1'});
    expect(()=>writerSourceRefSchema.parse({type:'document',id:'other'})).toThrow();
    expect(()=>writerSourceRefSchema.parse({type:'artifact',id:''})).toThrow();
  });
  it('accepts bounded replace, insert, and delete proposal operations',()=>{
    const proposal=writerProposalToolInputSchema.parse({version:1,title:'Clarify the argument',summary:'Two targeted changes.',changes:[
      {operation:{type:'replace-text',blockId:'paragraph-1',text:'Revised paragraph.'},rationale:'Clarifies the claim.',sourceKeys:['message:answer-1']},
      {operation:{type:'insert-text-block',blockId:'paragraph-1',position:'after',tag:'p',text:'Additional explanation.'},rationale:'Adds retained discussion context.',sourceKeys:[]},
      {operation:{type:'delete-text-block',blockId:'paragraph-2'},rationale:'Removes a duplicate.',sourceKeys:[]},
    ]});
    expect(proposal.changes).toHaveLength(3);
    expect(documentEditOperationSchema.parse(proposal.changes[1]!.operation)).toMatchObject({type:'insert-text-block',position:'after'});
  });
  it('rejects unsafe tags, blank inserted text, missing rationales, and unbounded proposals',()=>{
    expect(()=>writerEditOperationSchema.parse({type:'insert-text-block',blockId:'p1',position:'after',tag:'script',text:'bad'})).toThrow();
    expect(()=>writerEditOperationSchema.parse({type:'insert-text-block',blockId:'p1',position:'after',tag:'p',text:'   '})).toThrow();
    expect(()=>writerProposalToolInputSchema.parse({version:1,title:'Draft',summary:'Summary',changes:[{operation:{type:'delete-text-block',blockId:'p1'},rationale:'',sourceKeys:[]}]})).toThrow();
    expect(()=>writerProposalToolInputSchema.parse({version:1,title:'Draft',summary:'Summary',changes:Array.from({length:201},()=>({operation:{type:'delete-text-block',blockId:'p1'},rationale:'Remove duplicate',sourceKeys:[]}))})).toThrow();
  });
  it('validates normalized proposal provenance and immutable before-values',()=>{
    const hash='a'.repeat(64),parsed=writerProposalResultSchema.parse({id:'proposal-1',threadId:'writer-1',modelRunId:'run-1',documentVersionId:'version-1',baseRevision:3,baseHtmlHash:hash,sourceHash:hash,instruction:'Use the selected definition.',title:'Definition pass',summary:'One replacement.',changes:[{id:'change-1',operation:{type:'replace-text',blockId:'p1',text:'New'},rationale:'Use the selected definition.',sourceKeys:['message:a1'],beforeText:'Old',beforeTag:'p'}],status:'draft',appliedRevision:null,appliedChangeIds:null,createdAt:'2026-08-11T00:00:00Z',updatedAt:'2026-08-11T00:00:00Z',appliedAt:null});
    expect(parsed).toMatchObject({baseRevision:3,status:'draft'});
    expect(()=>writerProposalResultSchema.parse({...parsed,baseHtmlHash:'not-a-hash'})).toThrow();
  });
});

describe('summary review contracts',()=>{
  const hash='b'.repeat(64);
  it('shares summary basis and freshness metadata',()=>{
    expect(summaryBasisSchema.parse({documentVersionId:'v1',revision:2,signalHash:hash})).toMatchObject({revision:2});
    expect(summaryFreshnessSchema.parse({status:'needs-review',reasons:['document-edits-changed','reader-signals-changed']})).toMatchObject({status:'needs-review'});
    expect(()=>summaryFreshnessSchema.parse({status:'current',reasons:['unknown-reason']})).toThrow();
  });
  it('discriminates KEEP from text and image-free visual REPLACE results',()=>{
    expect(summaryReviewResultSchema.parse({decision:'KEEP',rationale:'Every important signal is already represented.',sourceStatus:'adequate',signalCoverage:[{signalId:'important-1',status:'covered'}]})).toMatchObject({decision:'KEEP'});
    expect(summaryReviewResultSchema.parse({decision:'REPLACE',rationale:'A caveat is missing.',sourceStatus:'adequate',signalCoverage:[{signalId:'comment-1',status:'missing'}],replacement:{kind:'tldr',content:'- Revised summary'}})).toMatchObject({decision:'REPLACE',replacement:{kind:'tldr'}});
    const visual={version:1,title:'Recap',thesis:'Thesis',sections:[],relationships:[],takeaways:[],openQuestions:[],sourceRefs:[]};
    expect(summaryReviewResultSchema.parse({decision:'REPLACE',rationale:'Update the recap.',sourceStatus:'adequate',signalCoverage:[{signalId:'important-1',status:'contradicted'}],replacement:{kind:'visual-recap',content:visual}})).toMatchObject({replacement:{kind:'visual-recap'}});
    expect(summaryReviewResultSchema.parse({decision:'REPLACE',rationale:'The source document changed materially.',sourceStatus:'material-gap',signalCoverage:[],replacement:{kind:'tldr',content:'Replacement after source edit'}})).toMatchObject({sourceStatus:'material-gap'});
    expect(()=>summaryReviewResultSchema.parse({decision:'REPLACE',rationale:'Unsafe image payload.',sourceStatus:'material-gap',signalCoverage:[],replacement:{kind:'visual-recap',content:{...visual,image:{url:'/api/generated/x.png',alt:'x',modelId:'m'}}}})).toThrow();
    expect(()=>summaryReviewResultSchema.parse({decision:'KEEP',rationale:'Keep',sourceStatus:'adequate',signalCoverage:[{signalId:'important-1',status:'covered'}],replacement:{kind:'tldr',content:'extra'}})).toThrow();
    expect(()=>summaryReviewResultSchema.parse({decision:'KEEP',rationale:'Incorrect keep',sourceStatus:'material-gap',signalCoverage:[{signalId:'important-1',status:'covered'}]})).toThrow();
    expect(()=>summaryReviewResultSchema.parse({decision:'KEEP',rationale:'Incorrect keep',sourceStatus:'adequate',signalCoverage:[{signalId:'important-1',status:'missing'}]})).toThrow();
    expect(()=>summaryReviewResultSchema.parse({decision:'REPLACE',rationale:'Unjustified replacement',sourceStatus:'adequate',signalCoverage:[{signalId:'important-1',status:'covered'}],replacement:{kind:'tldr',content:'Replacement'}})).toThrow();
  });
});
