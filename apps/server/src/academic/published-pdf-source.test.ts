import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {describe,expect,it,vi} from 'vitest';
import {createPublishedSourceHook,type NormalizedPublishedPdf} from './published-source.js';

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

describe('public PDF materialization',()=>{
  it('retains converter page provenance and passes source-reference policy',async()=>{
    const root=await mkdtemp(join(tmpdir(),'afterdraft-public-pdf-'));try{
      const locator='https://publisher.test/paper.pdf',sourcePath=join(root,'source.url'),locatorHash=hash(locator),pdf=Buffer.from('%PDF-1.7\nfixture'),contentSha256=hash(pdf),document=Buffer.from('<!doctype html><html><head><title>Full paper title</title></head><body><p>Body</p></body></html>'),page=Buffer.from([0xff,0xd8,0xff,0xd9]);await writeFile(sourcePath,locator);
      const source:NormalizedPublishedPdf={kind:'pdf',title:'Full paper title',bytes:pdf,filename:'paper.pdf',assets:[],warnings:[],provenance:{requestedUrl:locator,finalUrl:locator,canonicalUrl:locator,redirectChain:[],doi:null,retrievedAt:'2026-08-19T00:00:00.000Z',adapter:'direct-pdf',license:null,contentSha256}},manifest={schemaVersion:1,operation:'convert',source:{kind:'pdf',sha256:contentSha256,pageCount:14,convertedPageCount:14,textMode:'hybrid',assetCount:21,fallbackUsed:true},converter:{selected:'poppler-hybrid-pdf'},output:{entryPath:'document.html',title:'Full paper title'},warnings:[],files:[{path:'document.html',bytes:document.byteLength,sha256:hash(document)},{path:'assets/pdf-page-001.jpg',bytes:page.byteLength,sha256:hash(page)}]},archive=Buffer.from(zipSync({'document.html':document,'assets/pdf-page-001.jpg':page,'manifest.json':strToU8(JSON.stringify(manifest))})),convertPdf=vi.fn(async(_path:string,_name:string,includeReference:boolean)=>{expect(includeReference).toBe(true);return archive}),resolve=vi.fn(async()=>source),hook=createPublishedSourceHook({resolve,convertPdf}),job={id:'url-pdf',source_kind:'url' as const,source_name:locator,source_mime_type:'text/uri-list',source_path:sourcePath,source_hash:locatorHash,companion_pdf_path:null,entry_path:null,status:'queued',ai_review_enabled:1,max_calls:30,review_concurrency:2,auto_apply:0,source_reference:1},bundle=await hook(job,join(root,'bundle'),new AbortController().signal);
      expect(convertPdf).toHaveBeenCalledOnce();expect(bundle.manifest.source).toMatchObject({sha256:locatorHash,contentSha256,pageCount:14,convertedPageCount:14,textMode:'hybrid',assetCount:21,fallbackUsed:true,requestedUrl:locator});expect(bundle.manifest.output).toMatchObject({title:'Full paper title'});
    }finally{await rm(root,{recursive:true,force:true})}
  });
});
