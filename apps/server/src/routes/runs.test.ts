import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { summaryBasis } from './knowledge.js';

process.env.OPENAI_API_KEY='test-openai-key';
const app=await buildApp();
const providerResponse=(chunks:string[])=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close()}}),{status:200});

function addAnchor(documentVersionId:string):string{
  const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',documentVersionId)!;
  const id=randomUUID();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,documentVersionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',now());return id;
}

afterAll(async()=>{vi.unstubAllGlobals();delete process.env.OPENAI_API_KEY;await app.close()});

describe('polish-note runs',()=>{
  it('streams and audits the result without adding a discussion message or artifact',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.71',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Polish note</title><p>A claim worth annotating.</p>'),filename:'polish.html',mimeType:'text/html'});
    if(!imported.documentId||!imported.versionId)throw new Error('Import did not create a document');
    const unscoped=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),documentVersionId:imported.versionId,action:'polish-note',input:'orphan draft'}});
    expect(unscoped.statusCode).toBe(400);
    const createdThread=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId:imported.documentId,title:'Annotation context'}}),threadId=JSON.parse(createdThread.body).id as string;
    await app.inject({method:'POST',url:`/api/threads/${threadId}/messages`,headers,payload:{role:'user',content:'The earlier discussion says the causal direction is uncertain.'}});
    let providerBody:any;const providerText=`The causal direction remains uncertain and should be stated cautiously. ${'x'.repeat(500)}`,expectedText=providerText.slice(0,500);
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{providerBody=JSON.parse(String(init?.body));return providerResponse([`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:providerText})}\n\n`,'data: {"type":"response.completed","response":{"id":"response-polish","status":"completed","usage":{"input_tokens":40,"output_tokens":12}}}\n\n'])}));
    const requestId=randomUUID(),response=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId,documentVersionId:imported.versionId,threadId,action:'polish-note',input:'causality uncertain; be cautious'}});
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('The causal direction remains uncertain');
    expect(JSON.stringify(providerBody)).toContain('causality uncertain; be cautious');
    expect(JSON.stringify(providerBody)).toContain('earlier discussion says the causal direction is uncertain');
    expect(row<{action:string;model_id:string;profile:string;status:string;response_text:string}>('SELECT action,model_id,profile,status,response_text FROM model_runs WHERE request_id=?',requestId)).toMatchObject({action:'polish-note',model_id:'gpt-5.6-luna',profile:'quick',status:'completed',response_text:expectedText});
    expect(expectedText).toHaveLength(500);
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
    const childResponse=await app.inject({method:'POST',url:'/api/threads',headers,payload:{documentId:first.documentId,anchorId:anchorOne,parentMessageId:firstMessage}}),childThread=JSON.parse(childResponse.body).id as string;
    expect(childResponse.statusCode).toBe(201);
    const answer=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),...base,threadId:childThread,anchorId:anchorOne,artifactScopeType:'answer',artifactScopeId:firstMessage}});
    expect(answer.statusCode).toBe(200);expect(answer.body).toContain('event: done');expect(fetchSpy).toHaveBeenCalledTimes(2);
    const documentSummary=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:randomUUID(),...base,threadId:documentThread,artifactScopeType:'document',artifactScopeId:first.documentId}});
    expect(documentSummary.statusCode).toBe(200);expect(documentSummary.body).toContain('event: done');expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
