import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { effectiveVersion } from '../edits/effective.js';
import { importSource } from '../ingest/index.js';
import { db, now, row } from '../db/index.js';
import { beginWriterApply, beginWriterGeneration, endWriterApply, endWriterGeneration } from '../models/writer-activity.js';

process.env.OPENAI_API_KEY='test-openai-key';
const app=await buildApp();
const providerResponse=(chunks:string[])=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close()}}),{status:200});

afterAll(async()=>{vi.unstubAllGlobals();delete process.env.OPENAI_API_KEY;await app.close()});

describe('Document Writer',()=>{
  it('snapshots explicit sources, persists a forced-tool proposal, and safely applies only selected changes',async()=>{
    const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'127.0.0.83',payload:{password:'test-owner-password'}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; '),csrf=login.cookies.find(item=>item.name==='profread_csrf')!.value,headers={cookie,'x-csrf-token':csrf};
    const imported=await importSource({buffer:Buffer.from('<title>Writer lifecycle</title><h1>Writer lifecycle</h1><p>Original body.</p>'),filename:'writer.html',mimeType:'text/html'});
    if(!imported.documentId||!imported.versionId)throw new Error('Writer fixture failed to import');
    const block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND text_content=?',imported.versionId,'Original body.')!,anchorId=randomUUID(),threadId=randomUUID(),messageId=randomUUID(),time=now();
    db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,imported.versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,title,created_at,updated_at)VALUES(?,?,?,?,?,?)').run(threadId,imported.documentId,anchorId,'Useful discussion',time,time);
    db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at)VALUES(?,?,?,?,?)').run(messageId,threadId,'assistant','Use the concrete recommendation from this answer.',time);

    const created=await app.inject({method:'POST',url:`/api/documents/${imported.documentId}/writer`,headers});
    expect(created.statusCode).toBe(201);
    const writer=JSON.parse(created.body),writerId=writer.thread.id as string;
    const duplicate=await app.inject({method:'POST',url:`/api/documents/${imported.documentId}/writer`,headers});
    expect(duplicate.statusCode).toBe(200);expect(JSON.parse(duplicate.body).thread.id).toBe(writerId);
    const added=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'message',id:messageId}}),source=JSON.parse(added.body);
    expect(added.statusCode).toBe(201);expect(source.label).toBe('Answer · Original body.');expect(source.snapshot.text).toContain('concrete recommendation');
    const deduped=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'message',id:messageId}});
    expect(deduped.statusCode).toBe(200);expect(JSON.parse(deduped.body).id).toBe(source.id);

    const unsavedAnnotation=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'thread-annotation',id:threadId}});expect(unsavedAnnotation.statusCode).toBe(409);expect(unsavedAnnotation.body).toContain('Save the annotation');
    const savedAnnotation=await app.inject({method:'PATCH',url:`/api/threads/${threadId}/annotation`,headers,payload:{text:'Curated annotation selected for Writer.'}});expect(savedAnnotation.statusCode).toBe(200);
    const annotationAdded=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'thread-annotation',id:threadId}}),annotationSource=JSON.parse(annotationAdded.body);expect(annotationAdded.statusCode).toBe(201);expect(annotationSource).toMatchObject({label:'Annotation · Original body.',anchorId,snapshot:{type:'thread-annotation',threadId,anchorQuote:'Original body.',text:'Curated annotation selected for Writer.'}});
    const highlightResponse=await app.inject({method:'POST',url:'/api/highlights',headers,payload:{anchorId,kind:'important',note:'Selected highlight note.'}}),highlightId=JSON.parse(highlightResponse.body).id as string;expect(highlightResponse.statusCode).toBe(201);
    const highlightAdded=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'highlight',id:highlightId}}),highlightSource=JSON.parse(highlightAdded.body);expect(highlightAdded.statusCode).toBe(201);expect(highlightSource).toMatchObject({label:'important · Original body.',anchorId,snapshot:{type:'highlight',highlightId,kind:'important',quote:'Original body.',note:'Selected highlight note.'}});
    const artifactPayload={documentVersionId:imported.versionId,kind:'tldr',scopeType:'document',scopeId:imported.documentId,content:'- Selected artifact content.',sourceRefs:[imported.versionId],promoted:false},artifactResponse=await app.inject({method:'POST',url:'/api/artifacts',headers,payload:artifactPayload}),artifactId=JSON.parse(artifactResponse.body).id as string;expect(artifactResponse.statusCode).toBe(201);
    const artifactAdded=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'artifact',id:artifactId}}),artifactSource=JSON.parse(artifactAdded.body);expect(artifactAdded.statusCode).toBe(201);expect(artifactSource).toMatchObject({label:'tldr · document',anchorId:null,snapshot:{type:'artifact',artifactId,kind:'tldr',scopeType:'document',scopeId:imported.documentId,content:'- Selected artifact content.',sourceRefs:[imported.versionId]}});

    const immutableSources=[source,annotationSource,highlightSource,artifactSource].map(({id,label,snapshot,snapshotHash}:any)=>({id,label,snapshot,snapshotHash}));
    db.prepare('UPDATE messages SET content=? WHERE id=?').run('Changed answer after source selection.',messageId);
    expect((await app.inject({method:'PATCH',url:`/api/threads/${threadId}/annotation`,headers,payload:{text:'Changed annotation after source selection.'}})).statusCode).toBe(200);
    expect((await app.inject({method:'PATCH',url:`/api/highlights/${highlightId}`,headers,payload:{kind:'important',note:'Changed highlight after source selection.'}})).statusCode).toBe(200);
    const changedArtifact=await app.inject({method:'POST',url:'/api/artifacts',headers,payload:{...artifactPayload,content:'- Changed artifact after source selection.'}});expect(changedArtifact.statusCode).toBe(200);expect(JSON.parse(changedArtifact.body).id).toBe(artifactId);
    const immutableState=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body);for(const expected of immutableSources)expect(immutableState.sources.find((item:any)=>item.id===expected.id)).toMatchObject(expected);

    const other=await importSource({buffer:Buffer.from('<title>Other writer source</title><p>Other article.</p>'),filename:'writer-other.html',mimeType:'text/html'});
    if(!other.documentId||!other.versionId)throw new Error('Other fixture failed to import');
    const otherThread=randomUUID(),otherMessage=randomUUID();db.prepare('INSERT INTO threads(id,document_id,created_at,updated_at)VALUES(?,?,?,?)').run(otherThread,other.documentId,time,time);db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at)VALUES(?,?,?,?,?)').run(otherMessage,otherThread,'assistant','Wrong document.',time);
    db.prepare('UPDATE threads SET annotation_text=? WHERE id=?').run('Other saved annotation.',otherThread);
    const otherBlock=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND text_content=?',other.versionId,'Other article.')!,otherAnchor=randomUUID(),otherHighlight=randomUUID();db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(otherAnchor,other.versionId,otherBlock.id,otherBlock.text_content,'','',otherBlock.start_offset,otherBlock.end_offset,'text',time);db.prepare("INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,1,'yellow','important',?,?,?)").run(otherHighlight,otherAnchor,'Other highlight.',time,time);
    const otherArtifactResponse=await app.inject({method:'POST',url:'/api/artifacts',headers,payload:{documentVersionId:other.versionId,kind:'tldr',scopeType:'document',scopeId:other.documentId,content:'- Other artifact.',sourceRefs:[other.versionId],promoted:false}}),otherArtifact=JSON.parse(otherArtifactResponse.body).id as string;expect(otherArtifactResponse.statusCode).toBe(201);
    for(const ref of [{type:'message',id:otherMessage},{type:'thread-annotation',id:otherThread},{type:'highlight',id:otherHighlight},{type:'artifact',id:otherArtifact}]){const rejected=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:ref});expect(rejected.statusCode,rejected.body).toBe(400);expect(rejected.body).toContain('another document')}
    expect(JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body).sources).toHaveLength(4);

    const proposalInput={version:1,title:'Targeted revision',summary:'Insert a sourced clarification and leave the original body unchanged.',changes:[
      {operation:{type:'replace-text',blockId:block.id,text:'Replacement that will not be selected.'},rationale:'Optional rewrite',sourceKeys:[source.id]},
      {operation:{type:'insert-text-block',blockId:block.id,position:'after',tag:'p',text:'Safe <script>alert(1)</script> clarification.'},rationale:'Add the selected evidence',sourceKeys:[source.id]},
    ]};
    vi.stubGlobal('fetch',vi.fn(async()=>providerResponse([
      `data: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',call_id:'writer-failed-call',name:'propose_document_edits',arguments:JSON.stringify(proposalInput)}})}\n\n`,
      'data: {"type":"response.failed","response":{"error":{"message":"writer provider failed"}}}\n\n',
    ])));const failedRequestId=randomUUID(),failed=await app.inject({method:'POST',url:'/api/runs',headers,payload:{requestId:failedRequestId,documentVersionId:imported.versionId,threadId:writerId,action:'document-write',input:'This failed request must not persist.'}});expect(failed.body).toContain('writer provider failed');expect(row<{count:number}>('SELECT COUNT(*) count FROM writer_proposals WHERE thread_id=?',writerId)?.count).toBe(0);expect(row<{count:number}>('SELECT COUNT(*) count FROM messages WHERE thread_id=?',writerId)?.count).toBe(0);expect(row<{status:string}>('SELECT status FROM model_runs WHERE request_id=?',failedRequestId)?.status).toBe('failed');
    let providerBody:any;const fetchSpy=vi.fn(async(_url:unknown,init?:RequestInit)=>{providerBody=JSON.parse(String(init?.body));return providerResponse([
      `event: response.output_item.done\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',call_id:'writer-call',name:'propose_document_edits',arguments:JSON.stringify(proposalInput)}})}\n\n`,
      'data: {"type":"response.completed","response":{"id":"writer-response","status":"completed","usage":{"input_tokens":80,"output_tokens":40}}}\n\n',
    ])});vi.stubGlobal('fetch',fetchSpy);
    const runPayload={requestId:randomUUID(),documentVersionId:imported.versionId,threadId:writerId,action:'document-write',input:'Use the selected source to clarify the article.'},run=await app.inject({method:'POST',url:'/api/runs',headers,payload:runPayload});
    expect(run.statusCode).toBe(200);expect(run.body).toContain('event: proposal');expect(run.body).toContain('event: done');
    expect(providerBody.tool_choice).toEqual({type:'function',name:'propose_document_edits'});
    expect(JSON.stringify(providerBody)).toContain('Curated annotation selected for Writer.');expect(JSON.stringify(providerBody)).toContain('Selected highlight note.');expect(JSON.stringify(providerBody)).toContain('Selected artifact content.');expect(JSON.stringify(providerBody)).not.toContain('Changed annotation after source selection.');
    const replay=await app.inject({method:'POST',url:'/api/runs',headers,payload:runPayload});expect(replay.body).toContain('event: proposal');expect(replay.body).toContain('"replayed":true');expect(fetchSpy).toHaveBeenCalledTimes(1);
    const state=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body),proposal=state.proposals[0];
    expect(proposal.status).toBe('draft');expect(proposal.changes).toHaveLength(2);expect(proposal.freshness.status).toBe('current');expect(state.thread.messages.map((message:any)=>message.role)).toEqual(['user','assistant']);
    const inserted=proposal.changes.find((change:any)=>change.operation.type==='insert-text-block');

    const supplementalMessageId=randomUUID();db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at)VALUES(?,?,?,?,?)').run(supplementalMessageId,threadId,'assistant','A second explicit source changes the proposal basis.',now());
    const supplementalResponse=await app.inject({method:'POST',url:`/api/writers/${writerId}/sources`,headers,payload:{type:'message',id:supplementalMessageId}}),supplementalSource=JSON.parse(supplementalResponse.body);
    expect(supplementalResponse.statusCode).toBe(201);
    const sourceStaleState=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body);
    expect(sourceStaleState.proposals[0].freshness).toEqual({status:'stale',reasons:['writer-sources-changed']});
    const sourceStaleApply=await app.inject({method:'POST',url:`/api/writer-proposals/${proposal.id}/apply`,headers,payload:{changeIds:[inserted.id],baseRevision:proposal.baseRevision}});
    expect(sourceStaleApply.statusCode).toBe(409);expect(sourceStaleApply.body).toContain('stale');
    const removedSupplemental=await app.inject({method:'DELETE',url:`/api/writers/${writerId}/sources/${supplementalSource.id}`,headers});expect(removedSupplemental.statusCode).toBe(200);
    const sourceRestoredState=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body);expect(sourceRestoredState.proposals[0].freshness.status).toBe('current');

    expect(beginWriterApply(writerId)).toBe(true);try{const blockedRun=await app.inject({method:'POST',url:'/api/runs',headers,payload:{...runPayload,requestId:randomUUID()}});expect(blockedRun.statusCode).toBe(409);expect(blockedRun.body).toContain('applying')}finally{endWriterApply(writerId)}
    expect(beginWriterGeneration(writerId)).toBe(true);try{const blockedApply=await app.inject({method:'POST',url:`/api/writer-proposals/${proposal.id}/apply`,headers,payload:{changeIds:[inserted.id],baseRevision:proposal.baseRevision}});expect(blockedApply.statusCode).toBe(409);expect(blockedApply.body).toContain('generated')}finally{endWriterGeneration(writerId)}
    const activeRunId=randomUUID();db.prepare(`INSERT INTO model_runs(id,thread_id,request_id,action,profile,routing_reason,context_tier,status,created_at)VALUES(?,?,?,'document-write','writer','overlap test','writer-full','running',?)`).run(activeRunId,writerId,randomUUID(),now());const databaseBlocked=await app.inject({method:'POST',url:`/api/writer-proposals/${proposal.id}/apply`,headers,payload:{changeIds:[inserted.id],baseRevision:proposal.baseRevision}});expect(databaseBlocked.statusCode).toBe(409);expect(databaseBlocked.body).toContain('still generating');db.prepare("UPDATE model_runs SET status='failed',completed_at=? WHERE id=?").run(now(),activeRunId);
    const applied=await app.inject({method:'POST',url:`/api/writer-proposals/${proposal.id}/apply`,headers,payload:{changeIds:[inserted.id],baseRevision:proposal.baseRevision}});
    expect(applied.statusCode,applied.body).toBe(200);expect(JSON.parse(applied.body).revision).toBe(1);
    const effective=effectiveVersion(imported.versionId)!,html=await readFile(effective.htmlPath,'utf8');
    expect(html).toContain('Original body.');expect(html).toContain('Safe &lt;script&gt;alert(1)&lt;/script&gt; clarification.');expect(html).not.toContain('Replacement that will not be selected.');
    expect(row<{origin_type:string;origin_id:string}>('SELECT origin_type,origin_id FROM document_edit_revisions WHERE document_version_id=? AND revision=1',imported.versionId)).toEqual({origin_type:'writer-proposal',origin_id:proposal.id});
    const repeated=await app.inject({method:'POST',url:`/api/writer-proposals/${proposal.id}/apply`,headers,payload:{changeIds:[inserted.id],baseRevision:proposal.baseRevision}});
    expect(repeated.statusCode).toBe(409);

    const secondRun=await app.inject({method:'POST',url:'/api/runs',headers,payload:{...runPayload,requestId:randomUUID(),input:'Prepare a second proposal before a manual document edit.'}});expect(secondRun.body).toContain('event: proposal');expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondState=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body),secondProposal=secondState.proposals.find((item:any)=>item.status==='draft'),secondInserted=secondProposal.changes.find((change:any)=>change.operation.type==='insert-text-block');
    const manualEdit=await app.inject({method:'POST',url:`/api/versions/${imported.versionId}/edits`,headers,payload:{baseRevision:1,operations:[{type:'replace-text',blockId:block.id,text:'Manually revised body.'}]}});expect(manualEdit.statusCode,manualEdit.body).toBe(200);
    const revisionStaleState=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${imported.documentId}/writer`,headers:{cookie}})).body),staleProposal=revisionStaleState.proposals.find((item:any)=>item.id===secondProposal.id);expect(staleProposal.freshness.status).toBe('stale');expect(staleProposal.freshness.reasons).toContain('document-edits-changed');
    const revisionStaleApply=await app.inject({method:'POST',url:`/api/writer-proposals/${secondProposal.id}/apply`,headers,payload:{changeIds:[secondInserted.id],baseRevision:secondProposal.baseRevision}});expect(revisionStaleApply.statusCode).toBe(409);expect(revisionStaleApply.body).toContain('stale');
  });
});
