import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { utf16ContextWindow } from '../anchors/context.js';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';

const app=await buildApp();
let cookie='';
let csrf='';

beforeAll(async()=>{
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'test-owner-password'}});
  cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');
  csrf=login.cookies.find(item=>item.name==='afterdraft_csrf')!.value;
});
afterAll(()=>app.close());

const readHeaders=()=>({cookie});
const writeHeaders=()=>({cookie,'x-csrf-token':csrf});

async function anchoredDocument(html:string){
  const imported=await importSource({buffer:Buffer.from(html),filename:`v02-${randomUUID()}.html`,mimeType:'text/html'});
  if(!imported.documentId||!imported.versionId)throw new Error('Import failed');
  const block=row<{id:string;text_content:string;start_offset:number}>('SELECT id,text_content,start_offset FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',imported.versionId)!;
  return{documentId:imported.documentId,versionId:imported.versionId,block};
}

async function createAnchor(documentVersionId:string,block:{id:string;text_content:string},exact:string,startOffset:number){
  const endOffset=startOffset+exact.length,context=utf16ContextWindow(block.text_content,startOffset,endOffset),response=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId,selector:{blockId:block.id,exact,prefix:context.prefix,suffix:context.suffix,startOffset,endOffset,blockType:'text'}}});
  expect(response.statusCode).toBe(201);
  return JSON.parse(response.body) as{id:string};
}

describe('v0.2 semantic reader data',()=>{
  it('accepts image resize operations through the authenticated edit route',async()=>{
    const imported=await importSource({buffer:Buffer.from('<title>Resize API</title><figure><img alt="Resizable"></figure>'),filename:`resize-${randomUUID()}.html`,mimeType:'text/html'});
    if(!imported.versionId)throw new Error('Import failed');
    const image=row<{id:string;start_offset:number}>("SELECT id,start_offset FROM blocks WHERE document_version_id=? AND block_type='image'",imported.versionId)!;
    const anchored=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:imported.versionId,selector:{blockId:image.id,exact:'',prefix:'',suffix:'',startOffset:0,endOffset:0,blockType:'image'}}});
    expect(anchored.statusCode).toBe(201);
    const anchorId=JSON.parse(anchored.body).id as string;
    const response=await app.inject({method:'POST',url:`/api/versions/${imported.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'resize-image',blockId:image.id,width:720}]}});
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).summary).toEqual({'resize-image':1});
    expect(row<{block_id:string;start_offset:number;end_offset:number;status:string}>('SELECT block_id,start_offset,end_offset,status FROM anchors WHERE id=?',anchorId)).toEqual({block_id:image.id,start_offset:image.start_offset,end_offset:image.start_offset,status:'attached'});
    const content=await app.inject({method:'GET',url:`/api/versions/${imported.versionId}/content`,headers:readHeaders()});
    expect(content.body).toContain('width="720"');
  });

  it('reattaches an empty-quote visual anchor when importing a new version',async()=>{
    const first=await importSource({buffer:Buffer.from('<title>Visual v1</title><p>Before</p><img alt="Stable visual">'),filename:`visual-v1-${randomUUID()}.html`,mimeType:'text/html'});
    if(!first.documentId||!first.versionId)throw new Error('First visual import failed');
    const visual=row<{id:string;start_offset:number}>('SELECT id,start_offset FROM blocks WHERE document_version_id=? AND block_type=\'image\'',first.versionId)!;
    const anchorResponse=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:first.versionId,selector:{blockId:visual.id,exact:'',prefix:'',suffix:'',startOffset:0,endOffset:0,blockType:'image'}}});
    expect(anchorResponse.statusCode).toBe(201);
    const anchorId=JSON.parse(anchorResponse.body).id as string,threadId=randomUUID(),time=now();
    db.prepare('INSERT INTO threads(id,document_id,anchor_id,created_at,updated_at)VALUES(?,?,?,?,?)').run(threadId,first.documentId,anchorId,time,time);

    const second=await importSource({buffer:Buffer.from('<title>Visual v2</title><h2>New introduction</h2><img alt="Stable visual">'),filename:`visual-v2-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!second.versionId)throw new Error('Second visual import failed');
    const migrated=row<{document_version_id:string;block_id:string;status:string;start_offset:number;end_offset:number}>('SELECT a.document_version_id,a.block_id,a.status,a.start_offset,a.end_offset FROM threads t JOIN anchors a ON a.id=t.anchor_id WHERE t.id=?',threadId);
    const nextVisual=row<{id:string;start_offset:number}>('SELECT id,start_offset FROM blocks WHERE document_version_id=? AND block_type=\'image\'',second.versionId)!;
    expect(migrated).toEqual({document_version_id:second.versionId,block_id:nextVisual.id,status:'attached',start_offset:nextVisual.start_offset,end_offset:nextVisual.start_offset});
  });

  it('keeps a non-exact version reattachment unmatched for repair',async()=>{
    const item=await anchoredDocument(`<title>Fuzzy import ${randomUUID()}</title><p>alpha beta gamma</p>`),anchor=await createAnchor(item.versionId,item.block,'alpha beta gamma',0);
    const second=await importSource({buffer:Buffer.from(`<title>Fuzzy import next ${randomUUID()}</title><p>alpha beta changed gamma</p>`),filename:`fuzzy-import-${randomUUID()}.html`,mimeType:'text/html',documentId:item.documentId});
    if(!second.versionId)throw new Error('Fuzzy version import failed');
    const nextBlock=row<{id:string;start_offset:number;end_offset:number}>('SELECT id,start_offset,end_offset FROM blocks WHERE document_version_id=? AND text_content=\'alpha beta changed gamma\'',second.versionId)!,migrated=row<{block_id:string;start_offset:number;end_offset:number;status:string}>('SELECT block_id,start_offset,end_offset,status FROM anchors WHERE migrated_from_id=?',anchor.id);
    expect(migrated).toEqual({block_id:nextBlock.id,start_offset:nextBlock.start_offset,end_offset:nextBlock.end_offset,status:'unmatched'});
  });

  it('keeps a non-exact edit reattachment unmatched for repair',async()=>{
    const item=await anchoredDocument(`<title>Fuzzy edit ${randomUUID()}</title><p>alpha beta gamma</p>`),anchor=await createAnchor(item.versionId,item.block,'alpha beta gamma',0),changed='alpha beta changed gamma';
    const highlightResponse=await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:anchor.id,kind:'important'}}),threadResponse=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:item.documentId,anchorId:anchor.id,title:'Fuzzy anchor'}});
    expect(highlightResponse.statusCode).toBe(201);expect(threadResponse.statusCode).toBe(201);
    const response=await app.inject({method:'POST',url:`/api/versions/${item.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'replace-text',blockId:item.block.id,text:changed}]}});
    expect(response.statusCode).toBe(200);
    const block=row<{start_offset:number;end_offset:number}>('SELECT start_offset,end_offset FROM blocks WHERE document_version_id=? AND id=?',item.versionId,item.block.id)!;
    expect(row<{start_offset:number;end_offset:number;status:string}>('SELECT start_offset,end_offset,status FROM anchors WHERE id=?',anchor.id)).toEqual({start_offset:block.start_offset,end_offset:block.end_offset,status:'unmatched'});
    const highlights=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/highlights`,headers:readHeaders()})).body) as Array<{anchor_id:string;status:string}>,threads=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/threads`,headers:readHeaders()})).body) as Array<{anchor_id:string;status:string}>;
    expect(highlights.find(entry=>entry.anchor_id===anchor.id)?.status).toBe('unmatched');expect(threads.find(entry=>entry.anchor_id===anchor.id)?.status).toBe('unmatched');
  });

  it('keeps an exact repeated quote in its trusted block when an earlier edit shifts global offsets',async()=>{
    const item=await anchoredDocument('<title>Shifted edit</title><p>chosen target ending</p>'),localStart=item.block.text_content.indexOf('target'),anchor=await createAnchor(item.versionId,item.block,'target',localStart);
    const response=await app.inject({method:'POST',url:`/api/versions/${item.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'insert-text-block',blockId:item.block.id,position:'before',tag:'p',text:'chosen target ending'}]}});
    expect(response.statusCode).toBe(200);
    const shifted=row<{start_offset:number}>('SELECT start_offset FROM blocks WHERE document_version_id=? AND id=?',item.versionId,item.block.id)!;
    expect(row<{block_id:string;start_offset:number;end_offset:number;status:string}>('SELECT block_id,start_offset,end_offset,status FROM anchors WHERE id=?',anchor.id)).toEqual({block_id:item.block.id,start_offset:shifted.start_offset+localStart,end_offset:shifted.start_offset+localStart+'target'.length,status:'attached'});
  });

  it('keeps trusted context unchanged when an edit makes an exact quote unsupported',async()=>{
    const item=await anchoredDocument('<title>Changed context</title><p>before target after</p>'),localStart=item.block.text_content.indexOf('target'),anchor=await createAnchor(item.versionId,item.block,'target',localStart),before=row<{prefix_text:string;suffix_text:string}>('SELECT prefix_text,suffix_text FROM anchors WHERE id=?',anchor.id)!;
    const response=await app.inject({method:'POST',url:`/api/versions/${item.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'replace-text',blockId:item.block.id,text:'different target setting'}]}});
    expect(response.statusCode).toBe(200);
    expect(row<{prefix_text:string;suffix_text:string;status:string}>('SELECT prefix_text,suffix_text,status FROM anchors WHERE id=?',anchor.id)).toEqual({...before,status:'unmatched'});
  });

  it('does not trust occurrence-derived block identity across ambiguous imported versions',async()=>{
    const first=await importSource({buffer:Buffer.from('<title>Duplicate v1</title><p>chosen target ending</p><p>chosen target ending</p>'),filename:`duplicate-v1-${randomUUID()}.html`,mimeType:'text/html'});
    if(!first.documentId||!first.versionId)throw new Error('First duplicate import failed');
    const selected=row<{id:string;text_content:string;start_offset:number}>('SELECT id,text_content,start_offset FROM blocks WHERE document_version_id=? AND text_content=? ORDER BY ordinal DESC LIMIT 1',first.versionId,'chosen target ending')!,localStart=selected.text_content.indexOf('target'),anchor=await createAnchor(first.versionId,selected,'target',localStart),context=row<{prefix_text:string;suffix_text:string}>('SELECT prefix_text,suffix_text FROM anchors WHERE id=?',anchor.id)!;
    const second=await importSource({buffer:Buffer.from('<title>Duplicate v2</title><p>chosen target ending</p><p>chosen target ending</p><p>chosen target ending</p>'),filename:`duplicate-v2-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!second.versionId)throw new Error('Second duplicate import failed');
    expect(row<{prefix_text:string;suffix_text:string;status:string}>('SELECT prefix_text,suffix_text,status FROM anchors WHERE migrated_from_id=?',anchor.id)).toEqual({...context,status:'unmatched'});
  });

  it('does not move a selected duplicate to the indistinguishable survivor in a new version',async()=>{
    const first=await importSource({buffer:Buffer.from(`<title>Deleted duplicate ${randomUUID()}</title><p>chosen target ending</p><p>chosen target ending</p>`),filename:`deleted-duplicate-v1-${randomUUID()}.html`,mimeType:'text/html'});
    if(!first.documentId||!first.versionId)throw new Error('First duplicate import failed');
    const selected=row<{id:string;text_content:string}>('SELECT id,text_content FROM blocks WHERE document_version_id=? AND text_content=? ORDER BY ordinal DESC LIMIT 1',first.versionId,'chosen target ending')!,localStart=selected.text_content.indexOf('target'),anchor=await createAnchor(first.versionId,selected,'target',localStart);
    const second=await importSource({buffer:Buffer.from(`<title>Deleted duplicate next ${randomUUID()}</title><p>chosen target ending</p>`),filename:`deleted-duplicate-v2-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!second.versionId)throw new Error('Second duplicate import failed');
    expect(row<{status:string}>('SELECT status FROM anchors WHERE migrated_from_id=?',anchor.id)).toEqual({status:'unmatched'});
  });

  it('does not auto-reattach an explicitly unmatched anchor during an edit',async()=>{
    const item=await anchoredDocument(`<title>Sticky unmatched edit ${randomUUID()}</title><p>chosen target ending</p>`),localStart=item.block.text_content.indexOf('target'),anchor=await createAnchor(item.versionId,item.block,'target',localStart);
    db.prepare("UPDATE anchors SET status='unmatched' WHERE id=?").run(anchor.id);
    const response=await app.inject({method:'POST',url:`/api/versions/${item.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'insert-text-block',blockId:item.block.id,position:'before',tag:'p',text:'New introduction'}]}});
    expect(response.statusCode).toBe(200);
    expect(row<{status:string}>('SELECT status FROM anchors WHERE id=?',anchor.id)).toEqual({status:'unmatched'});
  });

  it('does not auto-reattach an explicitly unmatched anchor in a new version',async()=>{
    const item=await anchoredDocument(`<title>Sticky unmatched version ${randomUUID()}</title><p>chosen target ending</p>`),localStart=item.block.text_content.indexOf('target'),anchor=await createAnchor(item.versionId,item.block,'target',localStart);
    db.prepare("UPDATE anchors SET status='unmatched' WHERE id=?").run(anchor.id);
    const second=await importSource({buffer:Buffer.from(`<title>Sticky unmatched next ${randomUUID()}</title><p>chosen target ending</p>`),filename:`sticky-unmatched-${randomUUID()}.html`,mimeType:'text/html',documentId:item.documentId});
    if(!second.versionId)throw new Error('Sticky unmatched version import failed');
    expect(row<{status:string}>('SELECT status FROM anchors WHERE migrated_from_id=?',anchor.id)).toEqual({status:'unmatched'});
  });

  it('anchors a repeated quote at the selected occurrence and validates semantic highlights',async()=>{
    const item=await anchoredDocument('<title>Repeated</title><p>same quote between same quote</p>'),exact='same quote',localStart=item.block.text_content.lastIndexOf(exact),anchor=await createAnchor(item.versionId!,item.block,exact,localStart);
    expect(row<{start_offset:number}>('SELECT start_offset FROM anchors WHERE id=?',anchor.id)?.start_offset).toBe(item.block.start_offset+localStart);

    const wrongOffset=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:item.versionId,selector:{blockId:item.block.id,exact,prefix:'',suffix:'',startOffset:1,endOffset:1+exact.length,blockType:'text'}}});
    expect(wrongOffset.statusCode).toBe(409);expect(wrongOffset.body).toContain('selected location');
    const conflictingContext=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:item.versionId,selector:{blockId:item.block.id,exact,prefix:'same quote between ',suffix:'',startOffset:0,endOffset:exact.length,blockType:'text'}}});
    expect(conflictingContext.statusCode).toBe(409);expect(conflictingContext.body).toContain('selected location');
    const overlapping=await anchoredDocument('<title>Overlapping repeat</title><p>aaa</p>'),overlappingResponse=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:overlapping.versionId,selector:{blockId:overlapping.block.id,exact:'aa',prefix:'',suffix:'',startOffset:2,endOffset:4,blockType:'text'}}});
    expect(overlappingResponse.statusCode).toBe(409);expect(overlappingResponse.body).toContain('selected location');

    const invalid=await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:anchor.id,kind:'comment',note:'   '}});
    expect(invalid.statusCode).toBe(400);
    const created=await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:anchor.id,kind:'important',note:null}});
    expect(created.statusCode).toBe(201);
    const highlight=JSON.parse(created.body) as{id:string;kind:string;color:string;checked:boolean};
    expect(highlight).toMatchObject({kind:'important',color:'yellow',checked:true});

    const listed=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/highlights`,headers:readHeaders()})).body);
    expect(listed[0]).toMatchObject({id:highlight.id,kind:'important',prefix_text:'same quote between ',suffix_text:'',status:'attached',local_start_offset:localStart,local_end_offset:localStart+exact.length});
    expect((await app.inject({method:'PATCH',url:`/api/highlights/${highlight.id}`,headers:writeHeaders(),payload:{kind:'comment',note:null}})).statusCode).toBe(400);
    const updated=await app.inject({method:'PATCH',url:`/api/highlights/${highlight.id}`,headers:writeHeaders(),payload:{kind:'comment',note:'Reader context'}});
    expect(JSON.parse(updated.body)).toMatchObject({kind:'comment',color:'pink',checked:true,note:'Reader context'});
    expect((await app.inject({method:'DELETE',url:`/api/highlights/${highlight.id}`,headers:writeHeaders()})).statusCode).toBe(200);
    expect((await app.inject({method:'DELETE',url:`/api/highlights/${highlight.id}`,headers:writeHeaders()})).statusCode).toBe(404);
  });

  it('validates repaired offsets and refreshes exact surrounding context',async()=>{
    const item=await anchoredDocument('<title>Repair repeated</title><p>left target middle target right</p>'),first=item.block.text_content.indexOf('target'),anchor=await createAnchor(item.versionId,item.block,'target',first),second=item.block.text_content.lastIndexOf('target');
    db.prepare("UPDATE anchors SET status='unmatched' WHERE id=?").run(anchor.id);
    const stale=await app.inject({method:'POST',url:`/api/anchors/${anchor.id}/repair`,headers:writeHeaders(),payload:{blockId:item.block.id,startOffset:second-1,endOffset:second+5,exactQuote:'target'}});
    expect(stale.statusCode).toBe(409);expect(stale.body).toContain('selected location');
    const repaired=await app.inject({method:'POST',url:`/api/anchors/${anchor.id}/repair`,headers:writeHeaders(),payload:{blockId:item.block.id,startOffset:second,endOffset:second+6,exactQuote:'target'}});
    expect(repaired.statusCode).toBe(200);
    expect(row<{start_offset:number;end_offset:number;prefix_text:string;suffix_text:string;status:string}>('SELECT start_offset,end_offset,prefix_text,suffix_text,status FROM anchors WHERE id=?',anchor.id)).toEqual({start_offset:item.block.start_offset+second,end_offset:item.block.start_offset+second+6,prefix_text:item.block.text_content.slice(Math.max(0,second-32),second),suffix_text:item.block.text_content.slice(second+6,second+38),status:'attached'});
  });

  it('round-trips surrogate-safe contexts through creation, rendering data, edit refresh, and repair',async()=>{
    const expectedPrefix=`🙂${'a'.repeat(31)}`,exact='target',expectedSuffix=`${'b'.repeat(31)}🙂`,item=await anchoredDocument(`<title>UTF-16 contexts ${randomUUID()}</title><p>${expectedPrefix}${exact}${expectedSuffix}</p>`),localStart=item.block.text_content.indexOf(exact),localEnd=localStart+exact.length,unsafePrefix=item.block.text_content.slice(localStart-32,localStart),unsafeSuffix=item.block.text_content.slice(localEnd,localEnd+32);
    expect(unsafePrefix.length).toBe(32);expect(unsafePrefix.charCodeAt(0)).toBeGreaterThanOrEqual(0xdc00);
    expect(unsafeSuffix.length).toBe(32);expect(unsafeSuffix.charCodeAt(unsafeSuffix.length-1)).toBeLessThanOrEqual(0xdbff);
    const stale=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:item.versionId,selector:{blockId:item.block.id,exact,prefix:unsafePrefix,suffix:unsafeSuffix,startOffset:localStart,endOffset:localEnd,blockType:'text'}}});
    expect(stale.statusCode).toBe(409);
    const splitExact=item.block.text_content.slice(1,2),split=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:item.versionId,selector:{blockId:item.block.id,exact:splitExact,prefix:'',suffix:'',startOffset:1,endOffset:2,blockType:'text'}}});
    expect(split.statusCode).toBe(409);

    const context=utf16ContextWindow(item.block.text_content,localStart,localEnd),created=await app.inject({method:'POST',url:'/api/anchors',headers:writeHeaders(),payload:{documentVersionId:item.versionId,selector:{blockId:item.block.id,exact,prefix:context.prefix,suffix:context.suffix,startOffset:localStart,endOffset:localEnd,blockType:'text'}}});
    expect(created.statusCode).toBe(201);
    const anchor=JSON.parse(created.body) as{id:string;prefix:string;suffix:string;startOffset:number;endOffset:number};
    expect(anchor).toMatchObject({prefix:expectedPrefix,suffix:expectedSuffix,startOffset:item.block.start_offset+localStart,endOffset:item.block.start_offset+localEnd});
    expect(row<{prefix_text:string;suffix_text:string}>('SELECT prefix_text,suffix_text FROM anchors WHERE id=?',anchor.id)).toEqual({prefix_text:expectedPrefix,suffix_text:expectedSuffix});

    const highlighted=await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:anchor.id,kind:'important'}});expect(highlighted.statusCode).toBe(201);
    const listed=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/highlights`,headers:readHeaders()})).body) as Array<{anchor_id:string;prefix_text:string;suffix_text:string;local_start_offset:number;local_end_offset:number}>,rendered=listed.find(entry=>entry.anchor_id===anchor.id)!;
    expect(rendered).toMatchObject({prefix_text:expectedPrefix,suffix_text:expectedSuffix,local_start_offset:localStart,local_end_offset:localEnd});
    expect(item.block.text_content.slice(localStart-rendered.prefix_text.length,localStart)).toBe(rendered.prefix_text);
    expect(item.block.text_content.slice(localEnd,localEnd+rendered.suffix_text.length)).toBe(rendered.suffix_text);

    const edited=await app.inject({method:'POST',url:`/api/versions/${item.versionId}/edits`,headers:writeHeaders(),payload:{baseRevision:0,operations:[{type:'insert-text-block',blockId:item.block.id,position:'before',tag:'p',text:'New introduction'}]}});expect(edited.statusCode).toBe(200);
    const shifted=row<{start_offset:number;text_content:string}>('SELECT start_offset,text_content FROM blocks WHERE document_version_id=? AND id=?',item.versionId,item.block.id)!,afterEdit=row<{start_offset:number;end_offset:number;prefix_text:string;suffix_text:string;status:string}>('SELECT start_offset,end_offset,prefix_text,suffix_text,status FROM anchors WHERE id=?',anchor.id)!;
    expect(afterEdit).toEqual({start_offset:shifted.start_offset+localStart,end_offset:shifted.start_offset+localEnd,prefix_text:expectedPrefix,suffix_text:expectedSuffix,status:'attached'});

    db.prepare("UPDATE anchors SET status='unmatched' WHERE id=?").run(anchor.id);
    const repaired=await app.inject({method:'POST',url:`/api/anchors/${anchor.id}/repair`,headers:writeHeaders(),payload:{blockId:item.block.id,startOffset:localStart,endOffset:localEnd,exactQuote:exact}});expect(repaired.statusCode).toBe(200);expect(JSON.parse(repaired.body)).toMatchObject({prefix:expectedPrefix,suffix:expectedSuffix});
    expect(row<{prefix_text:string;suffix_text:string;status:string}>('SELECT prefix_text,suffix_text,status FROM anchors WHERE id=?',anchor.id)).toEqual({prefix_text:expectedPrefix,suffix_text:expectedSuffix,status:'attached'});

    const next=await importSource({buffer:Buffer.from(`<title>UTF-16 contexts next ${randomUUID()}</title><p>${expectedPrefix}${exact}${expectedSuffix}</p>`),filename:`utf16-context-next-${randomUUID()}.html`,mimeType:'text/html',documentId:item.documentId});if(!next.versionId)throw new Error('UTF-16 context version import failed');
    expect(row<{prefix_text:string;suffix_text:string;status:string}>('SELECT prefix_text,suffix_text,status FROM anchors WHERE migrated_from_id=?',anchor.id)).toEqual({prefix_text:expectedPrefix,suffix_text:expectedSuffix,status:'attached'});
  });

  it('stores, returns, and removes an editable thread annotation',async()=>{
    const item=await anchoredDocument('<title>Annotation</title><p>Annotated passage</p>'),anchor=await createAnchor(item.versionId!,item.block,'Annotated passage',0);
    const created=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:item.documentId,anchorId:anchor.id,title:'Define'}}),thread=JSON.parse(created.body) as{id:string};
    expect((await app.inject({method:'PATCH',url:`/api/threads/${thread.id}/annotation`,headers:writeHeaders(),payload:{text:'  A concise note.  '}})).statusCode).toBe(200);
    const listed=JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/threads`,headers:readHeaders()})).body),saved=listed.find((entry:{id:string})=>entry.id===thread.id);
    expect(saved).toMatchObject({annotation_text:'A concise note.',prefix_text:'',suffix_text:'',status:'attached',local_start_offset:0,local_end_offset:'Annotated passage'.length});
    expect((await app.inject({method:'PATCH',url:`/api/threads/${thread.id}/annotation`,headers:writeHeaders(),payload:{text:'🙂'.repeat(500)}})).statusCode).toBe(200);
    expect((await app.inject({method:'PATCH',url:`/api/threads/${thread.id}/annotation`,headers:writeHeaders(),payload:{text:'🙂'.repeat(501)}})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url:`/api/threads/${thread.id}/annotation`,headers:writeHeaders(),payload:{text:'x'.repeat(501)}})).statusCode).toBe(400);
    const removed=await app.inject({method:'PATCH',url:`/api/threads/${thread.id}/annotation`,headers:writeHeaders(),payload:{text:null}});
    expect(JSON.parse(removed.body)).toMatchObject({ok:true,text:null});
  });

  it('creates only document-local threads against the current version while preserving anchor-less and nested threads',async()=>{
    const first=await anchoredDocument(`<title>Thread scope</title><p>Original passage ${randomUUID()}</p>`),other=await anchoredDocument(`<title>Other thread scope</title><p>Other passage ${randomUUID()}</p>`),oldAnchor=await createAnchor(first.versionId,first.block,first.block.text_content,0),otherAnchor=await createAnchor(other.versionId,other.block,other.block.text_content,0);
    const crossDocument=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,anchorId:otherAnchor.id,title:'Invalid cross-document thread'}});
    expect(crossDocument.statusCode).toBe(400);expect(crossDocument.body).toContain('supplied document');
    const next=await importSource({buffer:Buffer.from(`<title>Thread scope next</title><p>Current passage ${randomUUID()}</p>`),filename:`thread-next-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!next.versionId)throw new Error('Next version import failed');
    const stale=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,anchorId:oldAnchor.id,title:'Invalid stale thread'}});
    expect(stale.statusCode).toBe(400);expect(stale.body).toContain('current document version');
    const nextBlock=row<{id:string;text_content:string;start_offset:number}>('SELECT id,text_content,start_offset FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',next.versionId)!,currentAnchor=await createAnchor(next.versionId,nextBlock,nextBlock.text_content,0);
    const anchored=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,anchorId:currentAnchor.id,title:'Current anchored thread'}});
    expect(anchored.statusCode).toBe(201);
    const anchorless=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,title:'Document thread'}});
    expect(anchorless.statusCode).toBe(201);expect(JSON.parse(anchorless.body).anchorId).toBeUndefined();
    const parentThread=JSON.parse(anchored.body).id as string,parentMessageResponse=await app.inject({method:'POST',url:`/api/threads/${parentThread}/messages`,headers:writeHeaders(),payload:{role:'assistant',content:'A parent answer'}}),parentMessage=JSON.parse(parentMessageResponse.body).id as string;
    const nested=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,anchorId:currentAnchor.id,parentMessageId:parentMessage,title:'Nested follow-up'}});
    expect(nested.statusCode).toBe(201);expect(JSON.parse(nested.body)).toMatchObject({anchorId:currentAnchor.id,parentMessageId:parentMessage});
    const otherThread=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:other.documentId,anchorId:otherAnchor.id,title:'Other parent'}}),otherThreadId=JSON.parse(otherThread.body).id as string,otherMessageResponse=await app.inject({method:'POST',url:`/api/threads/${otherThreadId}/messages`,headers:writeHeaders(),payload:{role:'assistant',content:'Other parent answer'}}),otherMessage=JSON.parse(otherMessageResponse.body).id as string;
    const crossParent=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:first.documentId,anchorId:currentAnchor.id,parentMessageId:otherMessage,title:'Invalid nested thread'}});
    expect(crossParent.statusCode).toBe(400);expect(crossParent.body).toContain('Parent message');
  });

  it('rejects direct artifacts whose section, thread, or answer scope belongs elsewhere',async()=>{
    const first=await anchoredDocument(`<title>Artifact scope</title><p>Initial scope ${randomUUID()}</p>`),oldAnchor=await createAnchor(first.versionId,first.block,first.block.text_content,0);
    const next=await importSource({buffer:Buffer.from(`<title>Artifact scope next</title><p>Current scope ${randomUUID()}</p>`),filename:`artifact-scope-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!next.versionId)throw new Error('Next artifact-scope version failed');
    const other=await anchoredDocument(`<title>Other artifact scope</title><p>Other scope ${randomUUID()}</p>`),otherAnchor=await createAnchor(other.versionId,other.block,other.block.text_content,0);
    const otherThreadResponse=await app.inject({method:'POST',url:'/api/threads',headers:writeHeaders(),payload:{documentId:other.documentId,anchorId:otherAnchor.id,title:'Other scope thread'}}),otherThread=JSON.parse(otherThreadResponse.body).id as string;
    const otherAnswerResponse=await app.inject({method:'POST',url:`/api/threads/${otherThread}/messages`,headers:writeHeaders(),payload:{role:'assistant',content:'Other scoped answer'}}),otherAnswer=JSON.parse(otherAnswerResponse.body).id as string;
    const payload=(scopeType:'section'|'thread'|'answer',scopeId:string)=>({documentVersionId:next.versionId,kind:'compact',scopeType,scopeId,content:'Scoped artifact',sourceRefs:[next.versionId],promoted:false});

    const staleSection=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:payload('section',oldAnchor.id)});
    expect(staleSection.statusCode).toBe(400);expect(staleSection.body).toContain('document version');
    const crossThread=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:payload('thread',otherThread)});
    expect(crossThread.statusCode).toBe(400);expect(crossThread.body).toContain('supplied document');
    const crossAnswer=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:payload('answer',otherAnswer)});
    expect(crossAnswer.statusCode).toBe(400);expect(crossAnswer.body).toContain('supplied document');
    const missingScope=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:payload('thread',randomUUID())});
    expect(missingScope.statusCode).toBe(404);expect(missingScope.body).toContain('Thread artifact scope not found');
  });

  it('counts important highlights only on the latest document version',async()=>{
    const first=await anchoredDocument('<title>Count versions</title><p>Old version passage</p>');
    const second=await importSource({buffer:Buffer.from('<title>Count versions</title><p>New version passage</p>'),filename:`count-${randomUUID()}.html`,mimeType:'text/html',documentId:first.documentId});
    if(!second.versionId)throw new Error('Second import failed');
    const oldAnchor=await createAnchor(first.versionId,first.block,'Old version passage',0);
    await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:oldAnchor.id,kind:'important',note:null}});
    const library=async()=>JSON.parse((await app.inject({method:'GET',url:'/api/documents',headers:readHeaders()})).body).find((entry:{id:string})=>entry.id===first.documentId);
    expect((await library()).checked_count).toBe(0);
    const latestBlock=row<{id:string;text_content:string;start_offset:number}>('SELECT id,text_content,start_offset FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal DESC LIMIT 1',second.versionId)!,latestAnchor=await createAnchor(second.versionId,latestBlock,'New version passage',0);
    await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:latestAnchor.id,kind:'important',note:null}});
    expect((await library()).checked_count).toBe(1);
  });

  it('tracks summary freshness across reader signals, edits, and document versions',async()=>{
    const item=await anchoredDocument('<title>Freshness</title><p>Summary source text</p>'),anchor=await createAnchor(item.versionId!,item.block,'Summary source text',0),artifactPayload={documentVersionId:item.versionId,kind:'tldr',scopeType:'document',scopeId:item.documentId,content:'Initial summary',sourceRefs:[item.versionId],promoted:false};
    const created=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:artifactPayload});
    expect(created.statusCode).toBe(201);
    const artifact=JSON.parse(created.body) as{id:string;version:number};
    expect(artifact.version).toBe(1);
    const replaced=await app.inject({method:'POST',url:'/api/artifacts',headers:writeHeaders(),payload:{...artifactPayload,content:'Updated summary'}});
    expect(replaced.statusCode).toBe(200);
    expect(JSON.parse(replaced.body)).toMatchObject({id:artifact.id,version:2,content:'Updated summary'});
    const artifacts=async()=>JSON.parse((await app.inject({method:'GET',url:`/api/documents/${item.documentId}/artifacts`,headers:readHeaders()})).body) as Array<{id:string;version:number;freshness:{status:string;reasons:string[]}}>;
    const acceptCurrent=async(expectedArtifactVersion:number)=>app.inject({method:'POST',url:`/api/artifacts/${artifact.id}/accept-current-basis`,headers:writeHeaders(),payload:{expectedArtifactVersion}});
    expect((await artifacts())[0]!.freshness).toEqual({status:'current',reasons:[]});

    const question=await app.inject({method:'POST',url:'/api/highlights',headers:writeHeaders(),payload:{anchorId:anchor.id,kind:'question',note:null}}),questionId=JSON.parse(question.body).id as string;
    expect((await artifacts())[0]!.freshness).toEqual({status:'current',reasons:[]});
    await app.inject({method:'PATCH',url:`/api/highlights/${questionId}`,headers:writeHeaders(),payload:{kind:'important',note:null}});
    expect((await artifacts())[0]!.freshness).toEqual({status:'needs-review',reasons:['reader-signals-changed']});
    expect((await app.inject({method:'POST',url:`/api/artifacts/${artifact.id}/accept-current-basis`,headers:writeHeaders()})).statusCode).toBe(400);
    expect((await acceptCurrent(1)).statusCode).toBe(409);
    const accepted=await acceptCurrent(2);
    expect(JSON.parse(accepted.body)).toMatchObject({version:3,freshness:{status:'current',reasons:[]}});

    db.prepare('INSERT INTO document_edit_revisions(id,document_version_id,revision,edited_html_path,canonical_text,base_title,summary_json,restored_from_revision,created_at)VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),item.versionId,1,'/tmp/v02-freshness.html','Summary source text','Freshness','{}',null,now());
    expect((await artifacts())[0]!.freshness).toEqual({status:'needs-review',reasons:['document-edits-changed']});
    expect((await acceptCurrent(3)).statusCode).toBe(200);
    const next=await importSource({buffer:Buffer.from('<title>Freshness next</title><p>Summary source text changed</p>'),filename:`next-${randomUUID()}.html`,mimeType:'text/html',documentId:item.documentId});
    expect(next.versionId).not.toBe(item.versionId);
    const changed=(await artifacts())[0]!.freshness;
    expect(changed.status).toBe('needs-review');
    expect(changed.reasons).toContain('document-version-changed');

    expect((await acceptCurrent(4)).statusCode).toBe(200);
    expect(row<{document_version_id:string}>('SELECT document_version_id FROM artifacts WHERE id=?',artifact.id)?.document_version_id).toBe(next.versionId);

    db.prepare('UPDATE artifacts SET basis_document_version_id=NULL,basis_revision=NULL,basis_signal_hash=NULL WHERE id=?').run(artifact.id);
    expect((await artifacts())[0]!.freshness).toEqual({status:'unknown',reasons:['missing-basis']});
  });
});
