import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { summaryBasis } from './knowledge.js';
import { conciseAnnotationCandidate } from './runs.js';

process.env.OPENAI_API_KEY='test-openai-key';
const app=await buildApp();
const providerResponse=(chunks:string[])=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close()}}),{status:200});

function addAnchor(documentVersionId:string):string{
  const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',documentVersionId)!;
  const id=randomUUID();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,documentVersionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',now());return id;
}

afterAll(async()=>{vi.unstubAllGlobals();delete process.env.OPENAI_API_KEY;await app.close()});

describe('annotation candidates',()=>{
  it('normalizes Markdown into at most two readable sentences and 500 code points',()=>{
    expect(conciseAnnotationCandidate('**Term** means the first thing. It also has context! A third detail is omitted.')).toBe('Term means the first thing. It also has context!');
    expect(Array.from(conciseAnnotationCandidate('가'.repeat(700))).length).toBe(500);
    expect(conciseAnnotationCandidate('[Useful label](https://example.test) is retained.')).toBe('Useful label is retained.');
  });
});

describe('polish-note runs',()=>{
  it('streams and audits the result without adding a discussion message or artifact',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.71',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Polish note</title><p>A claim worth annotating.</p>'),filename:'polish.html',mimeType:'text/html'});
    if(!imported.documentId||!imported.versionId)throw new Error('Import did not create a document');
    const unscoped=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,action:'polish-note',input:'orphan draft'}});
    expect(unscoped.statusCode).toBe(400);
    const createdThread=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId:imported.documentId,title:'Annotation context'}}),threadId=JSON.parse(createdThread.body).id as string;
    await app.inject({method:'POST',url:`/api/threads/${threadId}/messages`,headers,payload:{role:'user',content:'The earlier discussion says the causal direction is uncertain.'}});
    const tooLong=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,threadId,action:'polish-note',input:'😀'.repeat(501)}});expect(tooLong.statusCode).toBe(400);
    let providerBody:any;const providerText=`The causal direction remains uncertain and should be stated cautiously. ${'😀'.repeat(500)}`,expectedText=Array.from(providerText).slice(0,500).join('');
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{providerBody=JSON.parse(String(init?.body));return providerResponse([`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:providerText})}\n\n`,'data: {"type":"response.completed","response":{"id":"response-polish","status":"completed","usage":{"input_tokens":40,"output_tokens":12}}}\n\n'])}));
    const requestId=randomUUID(),response=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId,documentVersionId:imported.versionId,threadId,action:'polish-note',input:'causality uncertain; be cautious'}});
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('The causal direction remains uncertain');
    expect(JSON.stringify(providerBody)).toContain('causality uncertain; be cautious');
    expect(JSON.stringify(providerBody)).toContain('earlier discussion says the causal direction is uncertain');
    expect(row<{action:string;model_id:string;profile:string;status:string;response_text:string}>('SELECT action,model_id,profile,status,response_text FROM model_runs WHERE request_id=?',requestId)).toMatchObject({action:'polish-note',model_id:'gpt-5.6-luna',profile:'quick',status:'completed',response_text:expectedText});
    expect(Array.from(expectedText)).toHaveLength(500);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM messages WHERE thread_id=?',threadId)?.count).toBe(1);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM search_index WHERE kind=\'answer\' AND document_id=?',imported.documentId)?.count).toBe(0);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM artifacts WHERE document_version_id=?',imported.versionId)?.count).toBe(0);
  });

  it('stores document summary provenance from the same reader signals sent to the model',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.72',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Summary basis</title><p>The decisive evidence is in this sentence.</p>'),filename:'summary-basis.html',mimeType:'text/html'});
    if(!imported.documentId||!imported.versionId)throw new Error('Import did not create a document');
    const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal LIMIT 1',imported.versionId)!,anchorId=randomUUID(),time=now();
    db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,imported.versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);
    db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),anchorId,1,'yellow','important','Retain this evidence',time,time);
    const basisAtStart=summaryBasis(imported.versionId);
    let providerBody:any;
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{providerBody=JSON.parse(String(init?.body));const changed=now();db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),anchorId,0,'pink','comment','Added while the summary was running',changed,changed);return providerResponse(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A focused summary."}\n\n','data: {"type":"response.completed","response":{"id":"response-summary","status":"completed"}}\n\n'])}));
    const response=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,artifactScopeType:'document',artifactScopeId:imported.documentId,action:'tldr',input:''}});
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(providerBody)).toContain('[IMPORTANT]');
    expect(JSON.stringify(providerBody)).toContain('Retain this evidence');
    const currentBasis=summaryBasis(imported.versionId),artifact=row<{basis_document_version_id:string;basis_revision:number;basis_signal_hash:string}>('SELECT basis_document_version_id,basis_revision,basis_signal_hash FROM artifacts WHERE kind=\'tldr\' AND scope_type=\'document\' AND scope_id=?',imported.documentId);
    expect(currentBasis.signalHash).not.toBe(basisAtStart.signalHash);
    expect(artifact).toEqual({basis_document_version_id:basisAtStart.documentVersionId,basis_revision:basisAtStart.revision,basis_signal_hash:basisAtStart.signalHash});
    const listed=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/artifacts`,headers:{cookie}})).body);
    expect(listed[0].freshness).toEqual({status:'needs-review',reasons:['reader-signals-changed']});
  });
});

describe('semantic summary-review runs',()=>{
  it('forces one structured review call, applies KEEP with CAS, and replays without another provider call',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.74',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Review route</title><p>The complete article already supports the concise conclusion.</p>'),filename:'review-route.html',mimeType:'text/html'});
    if(!imported.documentId||!imported.versionId)throw new Error('Review route fixture failed to import');
    const artifactId=randomUUID(),originalBasis=summaryBasis(imported.versionId),time=now();
    db.prepare(`INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,basis_document_version_id,basis_revision,basis_signal_hash,created_at)
      VALUES(?,?, 'tldr',1,'document',?,?,?,0,?,?,?,?)`).run(artifactId,imported.versionId,imported.documentId,JSON.stringify('- The article supports the concise conclusion.'),JSON.stringify([imported.versionId]),originalBasis.documentVersionId,originalBasis.revision,originalBasis.signalHash,time);
    db.prepare("INSERT INTO search_index(kind,entity_id,document_id,title,body,tags,model_id,created_at)VALUES('artifact',?,?, 'tldr',?,'','old-model',?)").run(artifactId,imported.documentId,'- The article supports the concise conclusion.',time);
    const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',imported.versionId)!,anchorId=randomUUID(),signalId=randomUUID();
    db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,imported.versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);
    db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,1,'yellow','important',?,?,?)").run(signalId,anchorId,'Make sure the conclusion remains visible.',time,time);
    const result={decision:'KEEP',rationale:'The existing summary already covers the article and Important signal.',sourceStatus:'adequate',signalCoverage:[{signalId,status:'covered',explanation:null}],replacement:null};let providerBody:any;
    const fetchSpy=vi.fn(async(_url:unknown,init?:RequestInit)=>{providerBody=JSON.parse(String(init?.body));return providerResponse([
      `event: response.output_item.done\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',call_id:'review-call',name:'review_summary',arguments:JSON.stringify(result)}})}\n\n`,
      'data: {"type":"response.completed","response":{"id":"review-response","status":"completed"}}\n\n',
    ])});vi.stubGlobal('fetch',fetchSpy);
    const requestId=randomUUID(),payload={requestId,documentVersionId:imported.versionId,action:'review-summary',input:'',artifactScopeType:'document',artifactScopeId:imported.documentId,reviewArtifactId:artifactId,expectedArtifactVersion:1};
    const response=await app.inject({method:'POST',url:'/api/runs',headers,payload});
    expect(response.statusCode,response.body).toBe(200);expect(response.body).toContain('event: review_result');expect(response.body).toContain('"decision":"KEEP"');expect(response.body).toContain('event: done');
    expect(providerBody.tool_choice).toEqual({type:'function',name:'review_summary'});expect(JSON.stringify(providerBody)).toContain('complete article already supports');expect(JSON.stringify(providerBody)).toContain(signalId);
    expect(row<{version:number;content_json:string;basis_signal_hash:string}>('SELECT version,content_json,basis_signal_hash FROM artifacts WHERE id=?',artifactId)).toEqual({version:2,content_json:JSON.stringify('- The article supports the concise conclusion.'),basis_signal_hash:summaryBasis(imported.versionId).signalHash});
    const replay=await app.inject({method:'POST',url:'/api/runs',headers,payload});expect(replay.statusCode).toBe(200);expect(replay.body).toContain('event: review_result');expect(fetchSpy).toHaveBeenCalledTimes(1);
    const current=await app.inject({method:'POST',url:'/api/runs',headers,payload:{...payload,requestId:randomUUID(),expectedArtifactVersion:2}});expect(current.statusCode).toBe(409);expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails a tool-call run that reaches EOF before provider completion without mutating the review target',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.75',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Review EOF</title><p>The article supports the stored summary.</p>'),filename:'review-eof.html',mimeType:'text/html'});if(!imported.documentId||!imported.versionId)throw new Error('Review EOF fixture failed');
    const artifactId=randomUUID(),basis=summaryBasis(imported.versionId),time=now();db.prepare(`INSERT INTO artifacts(id,document_version_id,kind,version,scope_type,scope_id,content_json,source_refs_json,promoted,basis_document_version_id,basis_revision,basis_signal_hash,created_at)
      VALUES(?,?,'tldr',1,'document',?,?,?,0,?,?,?,?)`).run(artifactId,imported.versionId,imported.documentId,JSON.stringify('- Stored summary'),JSON.stringify([imported.versionId]),basis.documentVersionId,basis.revision,basis.signalHash,time);
    const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',imported.versionId)!,anchorId=randomUUID(),signalId=randomUUID();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,imported.versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,1,'yellow','important',NULL,?,?)").run(signalId,anchorId,time,time);
    const verdict={decision:'KEEP',rationale:'Already covered.',sourceStatus:'adequate',signalCoverage:[{signalId,status:'covered',explanation:null}],replacement:null};vi.stubGlobal('fetch',vi.fn(async()=>providerResponse([`data: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',call_id:'review-eof',name:'review_summary',arguments:JSON.stringify(verdict)}})}\n\n`])));
    const requestId=randomUUID(),response=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId,documentVersionId:imported.versionId,action:'review-summary',input:'',artifactScopeType:'document',artifactScopeId:imported.documentId,reviewArtifactId:artifactId,expectedArtifactVersion:1}});
    expect(response.statusCode).toBe(200);expect(response.body).toContain('Provider stream ended before a completed terminal event');expect(response.body).not.toContain('event: review_result');expect(response.body).not.toContain('event: done');
    expect(row<{status:string}>('SELECT status FROM model_runs WHERE request_id=?',requestId)?.status).toBe('failed');expect(row<{version:number;content_json:string}>('SELECT version,content_json FROM artifacts WHERE id=?',artifactId)).toEqual({version:1,content_json:JSON.stringify('- Stored summary')});expect(row<{status:string}>('SELECT status FROM summary_reviews WHERE artifact_id=? ORDER BY created_at DESC LIMIT 1',artifactId)?.status).toBe('failed');
  });

  it('can semantically review a short generated half-page and apply a valid Korean replacement',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.76',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Generated legacy summary</title><p>An important conclusion belongs in the summary.</p>'),filename:'generated-legacy-summary.html',mimeType:'text/html'});if(!imported.documentId||!imported.versionId)throw new Error('Generated legacy summary fixture failed');
    vi.stubGlobal('fetch',vi.fn(async()=>providerResponse(['data: {"type":"response.output_text.delta","delta":"A short generated half-page."}\n\n','data: {"type":"response.completed","response":{"id":"half-page-response","status":"completed"}}\n\n'])));
    const generated=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,action:'half-page',input:'',artifactScopeType:'document',artifactScopeId:imported.documentId}});expect(generated.body).toContain('event: done');
    const artifact=row<{id:string;version:number;content_json:string}>('SELECT id,version,content_json FROM artifacts WHERE kind=\'half-page\' AND scope_type=\'document\' AND scope_id=?',imported.documentId)!;expect(artifact).toMatchObject({version:1,content_json:JSON.stringify('A short generated half-page.')});
    const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',imported.versionId)!,anchorId=randomUUID(),signalId=randomUUID(),time=now();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,imported.versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,1,'yellow','important','Include the conclusion',?,?)").run(signalId,anchorId,time,time);
    const replacement='한'.repeat(320),verdict={decision:'REPLACE',rationale:'The generated summary omits the Important conclusion.',sourceStatus:'adequate',signalCoverage:[{signalId,status:'missing',explanation:null}],replacement:{kind:'half-page',content:replacement}};vi.stubGlobal('fetch',vi.fn(async()=>providerResponse([`data: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',call_id:'review-generated',name:'review_summary',arguments:JSON.stringify(verdict)}})}\n\n`,'data: {"type":"response.completed","response":{"id":"review-generated-response","status":"completed"}}\n\n'])));
    const reviewed=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,action:'review-summary',input:'',artifactScopeType:'document',artifactScopeId:imported.documentId,reviewArtifactId:artifact.id,expectedArtifactVersion:1}});expect(reviewed.body).toContain('event: review_result');expect(reviewed.body).toContain('event: done');expect(row<{version:number;content_json:string}>('SELECT version,content_json FROM artifacts WHERE id=?',artifact.id)).toEqual({version:2,content_json:JSON.stringify(replacement)});
  });
});

describe('run scope integrity',()=>{
  it('rejects invalid relational tuples before a provider call or artifact write, then accepts matched scopes',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.73',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const first=await importSource({buffer:Buffer.from(`<title>Scope one</title><p>First scoped passage ${randomUUID()}</p>`),filename:'scope-one.html',mimeType:'text/html'}),second=await importSource({buffer:Buffer.from(`<title>Scope two</title><p>Second scoped passage ${randomUUID()}</p>`),filename:'scope-two.html',mimeType:'text/html'});
    if(!first.documentId||!first.versionId||!second.documentId||!second.versionId)throw new Error('Scope fixtures failed to import');
    const anchorOne=addAnchor(first.versionId),alternateAnchor=addAnchor(first.versionId),anchorTwo=addAnchor(second.versionId);
    const createThread=async(documentId:string,anchorId?:string)=>{const response=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId,...(anchorId?{anchorId}:{})}});expect(response.statusCode).toBe(201);return JSON.parse(response.body).id as string};
    const anchoredThread=await createThread(first.documentId,anchorOne),documentThread=await createThread(first.documentId),otherThread=await createThread(second.documentId);
    const firstMessageResponse=await app.inject({method:'POST',url:`/api/threads/${anchoredThread}/messages`,headers,payload:{role:'user',content:'First document answer source'}}),firstMessage=JSON.parse(firstMessageResponse.body).id as string;
    const otherMessageResponse=await app.inject({method:'POST',url:`/api/threads/${otherThread}/messages`,headers,payload:{role:'user',content:'Other document answer source'}}),otherMessage=JSON.parse(otherMessageResponse.body).id as string;
    const corruptAnchorThread=randomUUID(),crossLineageThread=randomUUID(),time=now();
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,parent_message_id,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(corruptAnchorThread,first.documentId,anchorTwo,null,time,time);
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,parent_message_id,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(crossLineageThread,first.documentId,anchorOne,otherMessage,time,time);
    const fetchSpy=vi.fn(async()=>providerResponse(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Scoped result."}\n\n','data: {"type":"response.completed","response":{"id":"response-scope","status":"completed"}}\n\n']));vi.stubGlobal('fetch',fetchSpy);
    const artifactsBefore=row<{count:number}>('SELECT COUNT(*) count FROM artifacts')!.count;
    const base={documentVersionId:first.versionId,action:'tldr' as const,input:''},invalid:Array<{payload:Record<string,unknown>;status:number;error:string}>=[
      {payload:{...base,documentVersionId:randomUUID()},status:404,error:'Document version'},
      {payload:{...base,threadId:randomUUID()},status:404,error:'Thread'},
      {payload:{...base,threadId:otherThread},status:400,error:'Thread'},
      {payload:{...base,anchorId:randomUUID()},status:404,error:'Anchor'},
      {payload:{...base,anchorId:anchorTwo},status:400,error:'Anchor'},
      {payload:{...base,threadId:anchoredThread},status:400,error:'anchor'},
      {payload:{...base,threadId:anchoredThread,anchorId:alternateAnchor},status:400,error:'anchor'},
      {payload:{...base,threadId:corruptAnchorThread},status:400,error:'Thread anchor'},
      {payload:{...base,threadId:crossLineageThread,anchorId:anchorOne},status:400,error:'ancestry'},
      {payload:{...base},status:400,error:'explicit scope'},
      {payload:{...base,artifactScopeType:'document'},status:400,error:'scope type and ID'},
      {payload:{...base,artifactScopeId:first.documentId},status:400,error:'scope type and ID'},
      {payload:{...base,artifactScopeType:'document',artifactScopeId:second.documentId},status:400,error:'Document artifact'},
      {payload:{...base,anchorId:anchorOne,artifactScopeType:'section',artifactScopeId:alternateAnchor},status:400,error:'Section artifact'},
      {payload:{...base,threadId:documentThread,artifactScopeType:'thread',artifactScopeId:anchoredThread},status:400,error:'Thread artifact'},
      {payload:{...base,artifactScopeType:'answer',artifactScopeId:otherMessage},status:400,error:'Answer artifact'},
      {payload:{...base,threadId:anchoredThread,anchorId:anchorOne,artifactScopeType:'answer',artifactScopeId:randomUUID()},status:404,error:'Answer artifact'},
      {payload:{...base,threadId:otherThread,action:'polish-note',input:'Tighten this note'},status:400,error:'Thread'},
    ];
    const requestIds:string[]=[];
    for(const item of invalid){const requestId=randomUUID();requestIds.push(requestId);const response=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId,...item.payload}});expect(response.statusCode,response.body).toBe(item.status);expect(response.body).toContain(item.error);}
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(row<{count:number}>(`SELECT COUNT(*) count FROM model_runs WHERE request_id IN (${requestIds.map(()=>'?').join(',')})`,...requestIds)?.count).toBe(0);
    expect(row<{count:number}>('SELECT COUNT(*) count FROM artifacts')?.count).toBe(artifactsBefore);

    const sectionRequest=randomUUID(),section=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:sectionRequest,...base,threadId:anchoredThread,anchorId:anchorOne,artifactScopeType:'section',artifactScopeId:anchorOne}});
    expect(section.statusCode).toBe(200);expect(section.body).toContain('event: done');expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(row<{scope_type:string;scope_id:string}>('SELECT scope_type,scope_id FROM artifacts WHERE document_version_id=? AND kind=\'tldr\' AND scope_type=\'section\' AND scope_id=?',first.versionId,anchorOne)).toEqual({scope_type:'section',scope_id:anchorOne});
    expect(row<{annotation_candidate_text:string|null}>('SELECT annotation_candidate_text FROM threads WHERE id=?',anchoredThread)?.annotation_candidate_text).toBeNull();
    const conversational=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:first.versionId,threadId:anchoredThread,anchorId:anchorOne,action:'explain',input:''}});expect(conversational.statusCode).toBe(200);expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(row<{annotation_candidate_text:string;annotation_candidate_status:string;annotation_candidate_source_message_id:string}>('SELECT annotation_candidate_text,annotation_candidate_status,annotation_candidate_source_message_id FROM threads WHERE id=?',anchoredThread)).toMatchObject({annotation_candidate_text:'Scoped result.',annotation_candidate_status:'pending',annotation_candidate_source_message_id:expect.any(String)});
    const acceptedCandidate=await app.inject({method:'PATCH',url:`/api/threads/${anchoredThread}/annotation`,headers,payload:{text:'Reader-edited concise result.'}});expect(acceptedCandidate.statusCode).toBe(200);expect(JSON.parse(acceptedCandidate.body).candidateStatus).toBe('accepted');
    const acceptedBeforeLaterAnswer=row<{annotation_text:string;annotation_candidate_status:string;annotation_candidate_source_message_id:string}>('SELECT annotation_text,annotation_candidate_status,annotation_candidate_source_message_id FROM threads WHERE id=?',anchoredThread)!;
    const laterConversational=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:first.versionId,threadId:anchoredThread,anchorId:anchorOne,action:'define',input:''}});expect(laterConversational.statusCode).toBe(200);expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(row<{annotation_text:string;annotation_candidate_status:string;annotation_candidate_source_message_id:string}>('SELECT annotation_text,annotation_candidate_status,annotation_candidate_source_message_id FROM threads WHERE id=?',anchoredThread)).toEqual(acceptedBeforeLaterAnswer);
    const protectedDismiss=await app.inject({method:'POST',url:`/api/threads/${anchoredThread}/annotation-candidate/dismiss`,headers});expect(protectedDismiss.statusCode).toBe(409);
    await app.inject({method:'PATCH',url:`/api/threads/${anchoredThread}/annotation`,headers,payload:{text:null}});
    const dismissedCandidate=await app.inject({method:'POST',url:`/api/threads/${anchoredThread}/annotation-candidate/dismiss`,headers});expect(dismissedCandidate.statusCode).toBe(200);expect(row<{annotation_candidate_status:string}>('SELECT annotation_candidate_status FROM threads WHERE id=?',anchoredThread)?.annotation_candidate_status).toBe('dismissed');
    const childResponse=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId:first.documentId,anchorId:anchorOne,parentMessageId:firstMessage}}),childThread=JSON.parse(childResponse.body).id as string;
    expect(childResponse.statusCode).toBe(201);
    const answer=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),...base,threadId:childThread,anchorId:anchorOne,artifactScopeType:'answer',artifactScopeId:firstMessage}});
    expect(answer.statusCode).toBe(200);expect(answer.body).toContain('event: done');expect(fetchSpy).toHaveBeenCalledTimes(4);
    const documentSummary=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),...base,threadId:documentThread,artifactScopeType:'document',artifactScopeId:first.documentId}});
    expect(documentSummary.statusCode).toBe(200);expect(documentSummary.body).toContain('event: done');expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});
