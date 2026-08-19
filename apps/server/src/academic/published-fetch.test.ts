import {Readable} from 'node:stream';
import {describe,expect,it,vi} from 'vitest';
import {PublishedFetchError,isPublicPublishedAddress,safePublishedFetch,validatePublishedUrl,type PinnedResponse,type PinnedTransport,type PublishedResolver} from './published-fetch.js';

const publicResolver:PublishedResolver=async()=>[{address:'93.184.216.34',family:4}];
function response(status:number,body:string|Buffer,headers:Record<string,string>={}):PinnedResponse{return{status,headers:new Headers(headers),body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(body)])}}
function routes(values:Record<string,PinnedResponse>):PinnedTransport{return vi.fn(async url=>{const item=values[url.toString()];if(!item)throw new Error(`Unexpected URL ${url}`);return item})}

describe('published HTTPS fetch boundary',()=>{
  it('normalizes tracking parameters but rejects credentials, signed locators, HTTP, and custom ports',()=>{
    expect(validatePublishedUrl('https://example.test/paper?utm_source=x&id=7#part').toString()).toBe('https://example.test/paper?id=7');
    for(const value of ['http://example.test/paper','https://user:secret@example.test/paper','https://example.test:8443/paper','https://example.test/paper?api_key=secret','https://example.test/paper?X-Amz-Signature=secret'])expect(()=>validatePublishedUrl(value)).toThrow(PublishedFetchError);
  });
  it('classifies private, local, mapped, and documentation addresses as unsafe',()=>{
    for(const value of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.2','100.64.0.1','198.51.100.2','::1','::7f00:1','::ffff:127.0.0.1','0:0:0:0:0:ffff:5db8:d822','fd00::1','fec0::1','2001:0:4136:e378:8000:63bf:80ff:fffe','2001:db8::1'])expect(isPublicPublishedAddress(value),value).toBe(false);
    expect(isPublicPublishedAddress('93.184.216.34')).toBe(true);expect(isPublicPublishedAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects any unsafe DNS answer before transport and passes the validated address as a transport pin',async()=>{
    const unsafeTransport=vi.fn(),mixed:PublishedResolver=async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}];await expect(safePublishedFetch('https://example.test/paper',{resolver:mixed,transport:unsafeTransport})).rejects.toMatchObject({code:'unsafe-address'});expect(unsafeTransport).not.toHaveBeenCalled();
    let capturedPin:unknown;const pinned:PinnedTransport=async(url,pin)=>{void url;capturedPin=pin;return response(200,'<html><article>Full paper</article></html>',{'content-type':'text/html'})};await safePublishedFetch('https://example.test/paper',{resolver:publicResolver,transport:pinned});expect(capturedPin).toEqual({address:'93.184.216.34',family:4});
  });
  it('revalidates every redirect and never follows one to a private address',async()=>{
    const resolver:PublishedResolver=async host=>host==='publisher.test'?[{address:'93.184.216.34',family:4}]:[{address:'127.0.0.1',family:4}],transport=routes({'https://publisher.test/paper':response(302,'',{location:'https://metadata.test/private'})});
    await expect(safePublishedFetch('https://publisher.test/paper',{resolver,transport})).rejects.toMatchObject({code:'unsafe-address'});
  });
  it('returns a bounded redirect chain and rejects challenge and oversized responses',async()=>{
    const transport=routes({'https://publisher.test/start':response(302,'',{location:'/paper'}),'https://publisher.test/paper':response(200,'<html><article>Paper</article></html>',{'content-type':'text/html'})}),result=await safePublishedFetch('https://publisher.test/start',{resolver:publicResolver,transport});expect(result).toMatchObject({finalUrl:'https://publisher.test/paper',redirectChain:['https://publisher.test/start']});
    const challenged=routes({'https://publisher.test/paper':response(403,'Verify that you are a human',{'content-type':'text/html','cf-mitigated':'challenge'})});await expect(safePublishedFetch('https://publisher.test/paper',{resolver:publicResolver,transport:challenged})).rejects.toMatchObject({code:'challenge'});
    const cloudflare200=routes({'https://publisher.test/paper':response(200,'<!doctype html><title>Just a moment...</title><p>Performing security verification</p><script>window._cf_chl_opt={}</script>',{'content-type':'text/html'})});await expect(safePublishedFetch('https://publisher.test/paper',{resolver:publicResolver,transport:cloudflare200})).rejects.toMatchObject({code:'challenge',status:200});
    const legitimateTitle=routes({'https://publisher.test/essay':response(200,'<!doctype html><title>Just a moment...</title><article>A paper with an unfortunately similar title.</article>',{'content-type':'text/html'})});await expect(safePublishedFetch('https://publisher.test/essay',{resolver:publicResolver,transport:legitimateTitle})).resolves.toMatchObject({status:200});
    const captchaPaper=routes({'https://publisher.test/captcha-paper':response(200,'<!doctype html><title>CAPTCHA research</title><article><h1>CAPTCHA research</h1><p>We evaluate CAPTCHA systems in modern browsers.</p></article>',{'content-type':'text/html'})});await expect(safePublishedFetch('https://publisher.test/captcha-paper',{resolver:publicResolver,transport:captchaPaper})).resolves.toMatchObject({status:200});
    const large=routes({'https://publisher.test/paper':response(200,'123456',{'content-type':'text/html'})});await expect(safePublishedFetch('https://publisher.test/paper',{resolver:publicResolver,transport:large,maxBytes:5})).rejects.toMatchObject({code:'too-large'});
  });
});
