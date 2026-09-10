import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PdfPage, PdfSelector } from '@profread/shared';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { createPdfAnchor, documentRepresentations, pdfPages, savePdfPages, validatePdfSelector } from './repository.js';
import { pdfByteRange } from '../routes/pdf.js';

const app=await buildApp();let cookie='',csrf='';
beforeAll(async()=>{const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'test-owner-password'}});cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');csrf=login.cookies.find(item=>item.name==='profread_csrf')!.value;});
afterAll(()=>app.close());
const headers=()=>({cookie,'x-csrf-token':csrf});
async function fixture(html=false){
  const imported=html?await importSource({buffer:Buffer.from(`<title>Coexisting ${randomUUID()}</title><p>Unmodified HTML paragraph.</p>`),filename:'coexisting.html',mimeType:'text/html'}):undefined;
  const documentId=imported?.documentId??randomUUID(),versionId=imported?.versionId??randomUUID(),id=randomUUID(),time=now(),hash='a'.repeat(64),bytes=Buffer.from('%PDF-1.7\nImmutable reader bytes\n%%EOF'),root=join(config.dataDir,'pdf',id),path=join(root,'reading.pdf');
  await mkdir(root,{recursive:true});await writeFile(path,bytes);
  if(!imported){db.prepare('INSERT INTO documents(id,title,created_at)VALUES(?,?,?)').run(documentId,'Native PDF',time);db.prepare('INSERT INTO document_versions(id,document_id,content_hash,source_name,canonical_text,token_estimate,version,created_at)VALUES(?,?,?,?,\'\',0,1,?)').run(versionId,documentId,randomUUID(),'source.pdf',time);}
  db.prepare("INSERT INTO document_representations(id,document_version_id,kind,status,source_hash,source_path,pdf_hash,pdf_path,source_page_start,source_page_end,page_count,created_at,updated_at)VALUES(?,?,'pdf','ready',?,?,?,?,22,23,2,?,?)").run(id,versionId,hash,path,hash,path,time,time);
  const first:PdfPage={page:1,sourcePage:22,view:[0,0,500,700],rotation:0,text:'Original mathematics quotation',textStatus:'native',items:[{text:'Original mathematics quotation',start:0,end:30,quad:[20,680,280,680,280,660,20,660]}]};
  first.items[0]!.end=first.text.length;
  const second:PdfPage={page:2,sourcePage:23,view:[0,0,500,700],rotation:0,text:'',textStatus:'image-only',items:[]};
  for(const page of[first,second])db.prepare('INSERT INTO pdf_page_revisions(representation_id,revision,page,data_json)VALUES(?,0,?,?)').run(id,page.page,JSON.stringify(page));
  const selector:PdfSelector={kind:'pdf-text',representationId:id,sourceHash:hash,extractionRevision:0,exact:first.text,segments:[{page:1,startOffset:0,endOffset:first.text.length,exact:first.text,quads:[first.items[0]!.quad]}]};
  return{documentId,versionId,id,bytes,first,second,selector};
}
describe('PDF representations and source anchors',()=>{
  it('stores native documents without fake HTML and authenticates byte ranges',async()=>{
    const value=await fixture();
    expect(row<{sanitized_html_path:null;entry_path:null}>('SELECT sanitized_html_path,entry_path FROM document_versions WHERE id=?',value.versionId)).toEqual({sanitized_html_path:null,entry_path:null});
    const doc=await app.inject({method:'GET',url:`/api/documents/${value.documentId}`,headers:headers()});expect(doc.statusCode).toBe(200);expect(doc.json().representations).toMatchObject([{id:value.id,kind:'pdf'}]);
    const url=`/api/representations/${value.id}/pdf`;
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    const range=await app.inject({method:'GET',url,headers:{...headers(),range:'bytes=0-7'}});expect(range.statusCode).toBe(206);expect(range.rawPayload).toEqual(value.bytes.subarray(0,8));expect(range.headers['content-range']).toBe(`bytes 0-7/${value.bytes.length}`);
    expect((await app.inject({method:'GET',url,headers:{...headers(),range:'bytes=999-1000'}})).statusCode).toBe(416);
    expect((await app.inject({method:'GET',url:`/api/versions/${value.versionId}/content`,headers:headers()})).statusCode).toBe(404);
  });
  it('keeps exact source anchors and old extraction revisions through OCR updates',async()=>{
    const value=await fixture(),anchor=createPdfAnchor(value.versionId,value.selector);
    savePdfPages(value.id,[{...value.first,text:'Different OCR quotation',items:[],textStatus:'ocr'}]);
    expect(pdfPages(value.id,0)[0]?.text).toBe(value.first.text);expect(pdfPages(value.id)[0]?.text).toBe('Different OCR quotation');
    expect(JSON.parse(row<{selector_json:string}>('SELECT selector_json FROM anchors WHERE id=?',anchor.id)!.selector_json)).toEqual(value.selector);
    expect(validatePdfSelector(value.versionId,value.selector)).toEqual(value.selector);
    expect(()=>validatePdfSelector(value.versionId,{...value.selector,sourceHash:'b'.repeat(64)})).toThrow(/source revision/);
    expect(()=>validatePdfSelector(value.versionId,{...value.selector,segments:[{...value.selector.segments[0],exact:'Wrong quotation'}]})).toThrow(/text changed/);
    expect(()=>validatePdfSelector(value.versionId,{...value.selector,segments:[{...value.selector.segments[0],page:22}]})).toThrow(/page sequence/);
  });
  it('persists region highlights, discussion source, and separate HTML/PDF positions',async()=>{
    const value=await fixture(true),views=documentRepresentations(value.documentId,value.versionId),html=views.representations.find(item=>item.kind==='html')!;
    expect(views.preferredRepresentationId).toBe(html.id);
    const region:PdfSelector={...value.selector,kind:'pdf-region',exact:'',segments:[{page:2,quads:[[40,500,200,500,200,400,40,400]]}]};
    const anchored=await app.inject({method:'POST',url:'/api/anchors',headers:headers(),payload:{documentVersionId:value.versionId,selector:region}});expect(anchored.statusCode).toBe(201);
    const anchorId=anchored.json().id;
    const highlight=await app.inject({method:'POST',url:'/api/highlights',headers:headers(),payload:{anchorId,kind:'comment',note:'Discuss this figure'}});expect(highlight.statusCode).toBe(201);
    const highlights=await app.inject({method:'GET',url:`/api/documents/${value.documentId}/highlights`,headers:headers()});expect(highlights.json()[0]).toMatchObject({representation:'pdf',selector:region});
    const thread=await app.inject({method:'POST',url:'/api/threads',headers:headers(),payload:{documentId:value.documentId,anchorId}});expect(thread.statusCode).toBe(201);expect(thread.json().representationId).toBe(value.id);
    const positionUrl=`/api/documents/${value.documentId}/progress`;
    expect((await app.inject({method:'PUT',url:positionUrl,headers:headers(),payload:{representationId:html.id,blockId:'html-block',offsetRatio:0.2}})).statusCode).toBe(200);
    expect((await app.inject({method:'PUT',url:positionUrl,headers:headers(),payload:{representationId:value.id,page:2,offsetRatio:0.6,zoom:2,rotation:90}})).statusCode).toBe(200);
    const manifest=await app.inject({method:'GET',url:`/api/representations/${value.id}/manifest`,headers:headers()});expect(manifest.json().progress).toMatchObject({page:2,offsetRatio:0.6,zoom:2,rotation:90});
    expect(row<{block_id:string;offset_ratio:number}>('SELECT block_id,offset_ratio FROM reading_progress WHERE document_id=?',value.documentId)).toEqual({block_id:'html-block',offset_ratio:0.2});
    expect(documentRepresentations(value.documentId,value.versionId).preferredRepresentationId).toBe(value.id);
    expect((await app.inject({method:'PUT',url:positionUrl,headers:headers(),payload:{representationId:html.id}})).statusCode).toBe(200);
    expect((await app.inject({method:'PUT',url:positionUrl,headers:headers(),payload:{representationId:value.id}})).statusCode).toBe(200);
    expect(row('SELECT page,offset_ratio,zoom,rotation FROM representation_progress WHERE representation_id=?',value.id)).toEqual({page:2,offset_ratio:0.6,zoom:2,rotation:90});
    expect(row('SELECT block_id,offset_ratio FROM reading_progress WHERE document_id=?',value.documentId)).toEqual({block_id:'html-block',offset_ratio:0.2});
  });
  it('keeps PDF highlights and source versions after a new HTML import',async()=>{
    const value=await fixture(true),anchor=createPdfAnchor(value.versionId,value.selector);
    const highlight=await app.inject({method:'POST',url:'/api/highlights',headers:headers(),payload:{anchorId:anchor.id,kind:'important'}});expect(highlight.statusCode).toBe(201);
    const next=await importSource({buffer:Buffer.from('<title>New HTML revision</title><p>New converted text.</p>'),filename:'new-version.html',mimeType:'text/html',documentId:value.documentId});
    expect(next.versionId).not.toBe(value.versionId);
    const views=documentRepresentations(value.documentId,next.versionId!);expect(views.representations).toEqual(expect.arrayContaining([expect.objectContaining({id:value.id,documentVersionId:value.versionId,version:1}),expect.objectContaining({id:'html-'+next.versionId})]));
    expect(validatePdfSelector(value.versionId,value.selector)).toEqual(value.selector);
    expect(row<{document_version_id:string}>('SELECT document_version_id FROM anchors WHERE id=?',anchor.id)?.document_version_id).toBe(value.versionId);
    const highlights=await app.inject({url:`/api/documents/${value.documentId}/highlights`,headers:headers()});expect(highlights.json()).toEqual(expect.arrayContaining([expect.objectContaining({anchor_id:anchor.id})]));
    const thread=await app.inject({method:'POST',url:'/api/threads',headers:headers(),payload:{documentId:value.documentId,anchorId:anchor.id}});expect(thread.statusCode).toBe(201);expect(thread.json().representationId).toBe(value.id);
  });
  it('removes PDF derivative files and search records only after title-confirmed deletion',async()=>{
    const value=await fixture();savePdfPages(value.id,[value.first]);
    const url=`/api/documents/${value.documentId}`;
    expect((await app.inject({method:'DELETE',url,headers:headers(),payload:{confirmTitle:'Wrong title'}})).statusCode).toBe(409);
    await expect(access(join(config.dataDir,'pdf',value.id,'reading.pdf'))).resolves.toBeUndefined();
    const deleted=await app.inject({method:'DELETE',url,headers:headers(),payload:{confirmTitle:'Native PDF'}});expect(deleted.statusCode).toBe(200);expect(deleted.json().cleanupComplete).toBe(true);
    expect(row('SELECT id FROM document_representations WHERE id=?',value.id)).toBeUndefined();expect(row('SELECT 1 FROM pdf_search_index WHERE representation_id=?',value.id)).toBeUndefined();
    await expect(access(join(config.dataDir,'pdf',value.id))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('handles suffix and open-ended byte ranges without accepting invalid ranges',()=>{
    expect(pdfByteRange('bytes=-8',100)).toEqual({start:92,end:99});expect(pdfByteRange('bytes=80-',100)).toEqual({start:80,end:99});
    for(const value of['bytes=0-1,3-4','bytes=-0','bytes=9-2','bytes=100-','bytes=9999999999999999999999-'])expect(pdfByteRange(value,100)).toBeNull();
  });
});
