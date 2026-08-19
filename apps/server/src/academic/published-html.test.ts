import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {SafePublishedResponse} from './published-fetch.js';
import {normalizeGenericPublishedHtml,PublishedIncompleteError} from './published-html.js';

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
function fetched(requestedUrl:string,finalUrl:string,bytes:string|Buffer,type:string):SafePublishedResponse{return{requestedUrl,finalUrl,redirectChain:requestedUrl===finalUrl?[]:[requestedUrl],status:200,headers:new Headers({'content-type':type}),contentType:type,bytes:Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)}}
function completePage(body:string,head=''):string{return`<!doctype html><html><head><title>Paper</title>${head}</head><body><article><h1>Paper</h1><h2>Introduction</h2><p>Complete article body.</p>${body}</article></body></html>`}

describe('generic published HTML normalization',()=>{
  it('evaluates abstract completeness within the selected article, not a long publisher shell',async()=>{
    const page='https://publisher.test/paper',html=`<!doctype html><html><head><title>Paper</title></head><body><article><h1>Paper</h1><h2>Abstract</h2><p>Abstract only.</p></article><footer>${'publisher navigation '.repeat(400)}</footer></body></html>`;
    await expect(normalizeGenericPublishedHtml(fetched(page,page,html,'text/html'),page,null)).rejects.toBeInstanceOf(PublishedIncompleteError);
  });

  it('does not let hidden code or a containing main element disguise an abstract-only article',async()=>{
    const page='https://publisher.test/paper',script=`<script>${'x'.repeat(4000)}</script>`,related=`<aside>${'related navigation '.repeat(300)}</aside>`,graphic='<figure><img src="data:image/png;base64,AA=="><figcaption>Graphical abstract</figcaption></figure>';
    for(const html of [`<main><article><h2>Abstract</h2><p>Abstract only.</p>${script}</article></main>`,`<main><article><h2>Abstract</h2><p>Abstract only.</p></article>${related}</main>`,`<article><h2>Abstract</h2><p>Abstract only.</p>${graphic}</article>`])await expect(normalizeGenericPublishedHtml(fetched(page,page,html,'text/html'),page,null)).rejects.toBeInstanceOf(PublishedIncompleteError);
  });

  it('rejects HTTP-200 sign-in and login forms as access shells',async()=>{
    const page='https://publisher.test/paper';
    for(const label of ['Sign in','Login']){const html=`<!doctype html><html><head><title>${label}</title></head><body><main><h1>${label}</h1><form action="/login"><label>Password <input type="password"></label></form></main></body></html>`;await expect(normalizeGenericPublishedHtml(fetched(page,page,html,'text/html'),page,null)).rejects.toBeInstanceOf(PublishedIncompleteError)}
  });

  it('hashes the exact response bytes even when decoding uses a legacy charset',async()=>{
    const page='https://publisher.test/paper',prefix=Buffer.from(completePage('<p>caf'),'ascii'),bytes=Buffer.concat([prefix,Buffer.from([0xe9]),Buffer.from('</p>','ascii')]),response=fetched(page,page,bytes,'text/html; charset=iso-8859-1');
    response.headers.set('content-type','text/html; charset=iso-8859-1');
    const result=await normalizeGenericPublishedHtml(response,page,null);
    expect(result.provenance.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('deduplicates assets whose different request URLs redirect to the same final resource',async()=>{
    const page='https://publisher.test/paper',final='https://cdn.test/shared.png',fetcher=vi.fn(async(input:string|URL)=>fetched(String(input),final,png,'image/png')),result=await normalizeGenericPublishedHtml(fetched(page,page,completePage('<img src="/first"><img src="/second">'),'text/html'),page,null,{fetcher});
    expect(result.assets).toHaveLength(1);
    const paths=[...result.html.matchAll(/<img src="([^"]+)"/g)].map(match=>match[1]);
    expect(paths).toEqual([result.assets[0]!.sourcePath,result.assets[0]!.sourcePath]);
  });

  it('removes recursive CSS imports before fetching nested assets',async()=>{
    const page='https://publisher.test/paper',style='https://publisher.test/style.css',dot='https://publisher.test/dot.png',fetcher=vi.fn(async(input:string|URL)=>{const url=String(input);if(url===style)return fetched(url,url,'@import url("/style.css"); .paper{mask:url("/style.css");background:url("/dot.png")}', 'text/css');if(url===dot)return fetched(url,url,png,'image/png');throw new Error(`unexpected ${url}`)}),result=await normalizeGenericPublishedHtml(fetched(page,page,completePage('',`<link rel="stylesheet" href="/style.css">`),'text/html'),page,null,{fetcher});
    expect(fetcher.mock.calls.map(call=>String(call[0]))).toEqual([style,dot]);
    expect(result.assets.map(asset=>asset.mimeType).sort()).toEqual(['image/png','text/css']);
    expect(result.assets.find(asset=>asset.mimeType==='text/css')?.bytes.toString()).not.toContain('@import');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'asset-recursion',sourceUrl:style})]));
  });
});
