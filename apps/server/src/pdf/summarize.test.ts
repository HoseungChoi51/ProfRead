import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDefinition, ModelProvider, PdfPage, ProviderRunRequest, RunEvent } from '@profread/shared';
import { compressPdfSummary, type PdfSummaryProgress } from './summarize.js';
import { pageSourceCitation, type PdfContextSnapshot } from './context.js';
import { buildPdfEvidence } from './evidence.js';

vi.mock('../models/behavior.js',()=>({contextBehaviorSettings:()=>({reservedPromptTokens:512})}));
vi.mock('./evidence.js',()=>({buildPdfEvidence:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
const capabilities={text:true,vision:false,structuredOutput:false,functionTools:false,providerWebSearch:false,reasoningControl:false,imageGeneration:false,streaming:true};
const model:ModelDefinition={id:'summary-model',providerId:'test',label:'Test',protocol:'chat-completions',contextWindow:12_000,maxOutput:1024,priority:1,enabled:true,capabilities};
function snapshot(texts:string[],imageOnly=false):PdfContextSnapshot{
  const pages:PdfPage[]=texts.map((text,index)=>({page:index+1,sourcePage:index+21,view:[0,0,612,792],rotation:0,text,textStatus:imageOnly?'image-only':'native',items:[]}));
  const citations=pages.map(page=>pageSourceCitation(page,{id:'representation',source_hash:'a'.repeat(64),extraction_revision:1}));
  return{context:{tier:'canonical',article:'Original article context',branch:[],curatedNotes:[],readerSignals:[],tokenEstimate:100},representationId:'representation',documentVersionId:'version',sourceHash:'a'.repeat(64),pdfHash:'b'.repeat(64),extractionRevision:1,citations,evidenceTargets:citations,coverage:{totalPages:pages.length,includedPages:pages.map(page=>page.sourcePage),pendingPages:[],failedPages:[],imageOnlyPages:imageOnly?pages.map(page=>page.sourcePage):[],lowConfidencePages:[],partial:false},requiresVision:imageOnly,requiresChunking:true,pages};
}
function ids(request:ProviderRunRequest):string[]{return [...new Set((request.messages[1]!.content.split('Allowed source IDs: ')[1]!.split('\n')[0]!.match(/\[pdf-p\d+\]/g)??[]))]}
function sourceData(request:ProviderRunRequest):string{return request.messages[1]!.content.split('<source_data>\n')[1]!.split('\n</source_data>')[0]!}
function providerFor(answer:(request:ProviderRunRequest,index:number)=>string,finishReason='stop'):{provider:ModelProvider;requests:ProviderRunRequest[]}{
  const requests:ProviderRunRequest[]=[];
  const provider:ModelProvider={listModels:async()=>[model],estimateContext:request=>Buffer.byteLength(JSON.stringify(request.messages)),async *run(request){
    requests.push(request);yield{type:'text_delta',delta:answer(request,requests.length-1)};
    yield{type:'usage',inputTokens:10,outputTokens:5};yield{type:'completed',finishReason};
  }};
  return{provider,requests};
}

describe('whole PDF map/reduce summaries',()=>{
  it('maps every page in groups of at most four and preserves all source citations',async()=>{
    const source=snapshot(Array.from({length:9},(_,index)=>`Unique source page ${index+1}`));
    const{provider,requests}=providerFor(request=>`Grounded study notes ${ids(request).join(' ')}`),progress:PdfSummaryProgress[]=[];
    const result=await compressPdfSummary(source,provider,model,new AbortController().signal,event=>{progress.push(event)});
    expect(requests).toHaveLength(3);
    expect(requests.map(request=>ids(request).length)).toEqual([4,4,1]);
    for(let page=1;page<=9;page++)expect(requests.some(request=>sourceData(request).includes(`Unique source page ${page}`))).toBe(true);
    expect(result.citations.map(value=>value.id)).toEqual(source.citations.map(value=>value.id));
    expect(result.inputTokens).toBe(30);expect(result.outputTokens).toBe(15);
    expect(progress.at(-1)).toEqual({phase:'map',completed:3,total:3});
  });

  it('splits an oversized source page without losing its final text or splitting surrogate pairs',async()=>{
    const body='A'.repeat(30_000)+'🧮 final-tail-unique',source=snapshot([body]);
    const{provider,requests}=providerFor(request=>`Study notes ${ids(request).join(' ')}`);
    await compressPdfSummary(source,provider,model,new AbortController().signal);
    const fragments=requests.filter(request=>request.messages[1]!.content.startsWith('Phase: map')).map(sourceData);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join('')).toContain('🧮 final-tail-unique');
    expect(fragments.reduce((count,fragment)=>count+(fragment.match(/A/g)?.length??0),0)).toBe(30_000);
    expect(fragments.every(fragment=>Buffer.from(fragment,'utf8').toString('utf8')===fragment)).toBe(true);
  });

  it('reads every image-only page through bounded source evidence, including pages beyond the first four',async()=>{
    const source=snapshot(Array.from({length:9},()=>''),true);
    vi.mocked(buildPdfEvidence).mockImplementation(async value=>({images:value.evidenceTargets.map(citation=>({id:captionId(citation.id),mimeType:'image/png',data:'encoded-image',detail:'high'})),citations:value.evidenceTargets,omittedPageNumbers:[]}));
    const{provider,requests}=providerFor(request=>`Page-image notes ${ids(request).join(' ')}`);
    const result=await compressPdfSummary(source,provider,{...model,contextWindow:100_000,capabilities:{...capabilities,vision:true}},new AbortController().signal);
    expect(requests.map(request=>request.images?.length)).toEqual([4,4,1]);
    expect(vi.mocked(buildPdfEvidence).mock.calls.flatMap(([value])=>value.evidenceTargets.map(citation=>citation.id))).toEqual(source.citations.map(citation=>citation.id));
    expect(result.citations).toHaveLength(9);
  });

  it.each([
    {label:'low-confidence OCR',confidence:29.2},
    {label:'OCR extraction error',confidence:95,error:'OCR page orientation could not be verified'},
  ])('requires every $label page image despite nonempty transcript text',async condition=>{
    const source=snapshot(Array.from({length:5},(_,index)=>`Nonempty but unreliable OCR transcript ${index+1}`));
    source.pages=source.pages.map(page=>({...page,textStatus:'ocr',confidence:condition.confidence,...('error' in condition?{error:condition.error}:{})}));
    const signal=new AbortController().signal,textOnly=providerFor(request=>ids(request).join(' '));
    await expect(compressPdfSummary(source,textOnly.provider,model,signal)).rejects.toThrow(/vision-capable/);
    expect(textOnly.requests).toHaveLength(0);
    vi.mocked(buildPdfEvidence).mockImplementation(async value=>({images:value.evidenceTargets.map(citation=>({id:captionId(citation.id),mimeType:'image/png',data:'verified-page-image',detail:'high'})),citations:value.evidenceTargets,omittedPageNumbers:[]}));
    const{provider,requests}=providerFor(request=>`Verified visual notes ${ids(request).join(' ')}`);
    await compressPdfSummary(source,provider,{...model,contextWindow:100_000,capabilities:{...capabilities,vision:true}},signal);
    expect(requests.map(request=>request.images?.length)).toEqual([4,1]);
    expect(vi.mocked(buildPdfEvidence).mock.calls.flatMap(([value])=>value.evidenceTargets.map(citation=>citation.id))).toEqual(source.citations.map(citation=>citation.id));
    expect(requests.every(request=>sourceData(request).includes('OCR/extraction is unreliable'))).toBe(true);
    expect(requests.every(request=>sourceData(request).includes('do not rely on this transcript alone'))).toBe(true);
  });

  it('reduces all mapped notes hierarchically until the final context fits',async()=>{
    const source=snapshot(Array.from({length:12},(_,index)=>`Source ${index}`));
    const{provider,requests}=providerFor(request=>`${request.messages[1]!.content.startsWith('Phase: map')?'x'.repeat(2000):'Reduced findings'} ${ids(request).join(' ')}`),progress:PdfSummaryProgress[]=[];
    const smaller={...model,contextWindow:7000,maxOutput:500};
    const result=await compressPdfSummary(source,provider,smaller,new AbortController().signal,event=>{progress.push(event)});
    expect(requests.some(request=>request.messages[1]!.content.startsWith('Phase: reduce'))).toBe(true);
    expect(progress.some(event=>event.phase==='reduce')).toBe(true);
    expect(result.citations).toHaveLength(12);
    expect(result.article).toContain('[pdf-p32]');
    expect(provider.estimateContext({model:smaller,messages:[{role:'user',content:result.article}]})+512+500).toBeLessThan(smaller.contextWindow);
  });

  it('rejects unavailable vision, omitted pages, invented citations, and truncated intermediate streams',async()=>{
    const ordinary=snapshot(['First','Last']),signal=new AbortController().signal;
    await expect(compressPdfSummary(snapshot([''],true),providerFor(()=> 'unused').provider,model,signal)).rejects.toThrow(/vision-capable/);
    await expect(compressPdfSummary(ordinary,providerFor(()=> 'Only first [pdf-p21]').provider,model,signal)).rejects.toThrow(/omitted/);
    await expect(compressPdfSummary(ordinary,providerFor(()=> '[pdf-p21] [pdf-p22] [pdf-p999]').provider,model,signal)).rejects.toThrow(/outside/);
    await expect(compressPdfSummary(ordinary,providerFor(request=>ids(request).join(' '),'length').provider,model,signal)).rejects.toThrow(/did not finish/);
  });

  it('does not quietly drop notes when reduction fails to get smaller',async()=>{
    const source=snapshot(Array.from({length:12},()=> 'Source text'));
    const{provider}=providerFor(request=>request.messages[1]!.content.startsWith('Phase: map')?`${'x'.repeat(2000)} ${ids(request).join(' ')}`:sourceData(request));
    await expect(compressPdfSummary(source,provider,{...model,contextWindow:7000,maxOutput:500},new AbortController().signal)).rejects.toThrow(/did not reduce/);
  });

  it('stops before later source calls after cancellation',async()=>{
    const controller=new AbortController(),source=snapshot(Array.from({length:9},()=> 'Source text'));
    const{provider,requests}=providerFor(request=>ids(request).join(' '));
    const original=provider.run.bind(provider);
    provider.run=async function*(request):AsyncIterable<RunEvent>{for await(const event of original(request)){yield event;controller.abort();}};
    await expect(compressPdfSummary(source,provider,model,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(requests).toHaveLength(1);
  });
  it('rejects oversized article scope before spending any model calls',async()=>{
    const{provider,requests}=providerFor(request=>ids(request).join(' '));
    await expect(compressPdfSummary(snapshot(Array.from({length:101},()=> 'Page')),provider,model,new AbortController().signal)).rejects.toThrow(/bounded whole-article summary size/);
    expect(requests).toHaveLength(0);
  });
});
function captionId(value:string){return`${value}-image-1`}
