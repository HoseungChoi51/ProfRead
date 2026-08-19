import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export type ResolvedAddress={address:string;family:4|6};
export type PublishedFetchHeaders=Record<string,string>;
export interface PinnedResponse{
  status:number;
  headers:Headers;
  body:AsyncIterable<Uint8Array>;
  cancel?:()=>void;
}
export type PublishedResolver=(hostname:string,signal:AbortSignal)=>Promise<ResolvedAddress[]>;
export type PinnedTransport=(url:URL,address:ResolvedAddress,headers:PublishedFetchHeaders,signal:AbortSignal)=>Promise<PinnedResponse>;

export interface SafePublishedFetchOptions{
  signal?:AbortSignal;
  resolver?:PublishedResolver;
  transport?:PinnedTransport;
  maxBytes?:number;
  maxRedirects?:number;
  timeoutMs?:number;
  accept?:string;
  userAgent?:string;
}
export interface SafePublishedResponse{
  requestedUrl:string;
  finalUrl:string;
  redirectChain:string[];
  status:number;
  headers:Headers;
  contentType:string;
  bytes:Buffer;
}

export type PublishedFetchErrorCode='invalid-url'|'unsafe-address'|'dns-failed'|'too-many-redirects'|'too-large'|'unsupported-encoding'|'challenge'|'authentication-required'|'rate-limited'|'http-status'|'network-error';
export class PublishedFetchError extends Error{
  constructor(message:string,readonly code:PublishedFetchErrorCode,readonly status?:number){super(message)}
}

const blocked=new BlockList();
for(const [network,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const)blocked.addSubnet(network,prefix,'ipv4');
for(const [network,prefix] of [
  ['::',96],['::1',128],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001::',32],['2001:2::',48],
  ['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8],
  ['fec0::',10],
] as const)blocked.addSubnet(network,prefix,'ipv6');

function plainHostname(value:string):string{return value.startsWith('[')&&value.endsWith(']')?value.slice(1,-1):value}
const credentialQuery=/^(?:access[_-]?token|auth(?:orization)?|api[_-]?key|apikey|token|signature|sig|key-pair-id|x-amz-.+|x-goog-.+)$/i;
const trackingQuery=/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;
export function isPublicPublishedAddress(value:string):boolean{
  const address=plainHostname(value).split('%',1)[0]??'',family=isIP(address);if(!family)return false;
  let normalized=address;if(family===6)try{normalized=plainHostname(new URL(`https://[${address}]/`).hostname)}catch{return false}
  if(family===6&&/^::ffff:/i.test(normalized))return false;
  return !blocked.check(normalized,family===4?'ipv4':'ipv6');
}

export function validatePublishedUrl(value:string|URL):URL{
  let url:URL;try{url=value instanceof URL?new URL(value):new URL(value)}catch{throw new PublishedFetchError('Enter a valid HTTPS article URL','invalid-url')}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new PublishedFetchError('Published sources must use public HTTPS without credentials or a custom port','invalid-url');
  for(const key of [...url.searchParams.keys()]){if(credentialQuery.test(key))throw new PublishedFetchError('Signed or credential-bearing article URLs are not accepted','invalid-url');if(trackingQuery.test(key))url.searchParams.delete(key)}
  url.hash='';return url;
}

const defaultResolver:PublishedResolver=async(hostname,signal)=>{
  if(signal.aborted)throw signal.reason;const host=plainHostname(hostname),family=isIP(host);if(family)return[{address:host,family:family as 4|6}];
  try{const result=(await lookup(host,{all:true,verbatim:true})).map(item=>({address:item.address,family:item.family as 4|6}));if(signal.aborted)throw signal.reason;return result}catch(error){if(signal.aborted)throw signal.reason;throw new PublishedFetchError(`Could not resolve ${host}: ${error instanceof Error?error.message:String(error)}`,'dns-failed')}
};

const defaultTransport:PinnedTransport=(url,address,headers,signal)=>new Promise((resolve,reject)=>{
  const pinnedLookup=((_hostname:string,options:unknown,callback:(error:NodeJS.ErrnoException|null,address:string|ResolvedAddress[],family?:number)=>void)=>{
    const all=Boolean(options&&typeof options==='object'&&'all' in options&&(options as{all?:boolean}).all);
    if(all)callback(null,[address]);else callback(null,address.address,address.family);
  }) as never;
  const request=httpsRequest(url,{method:'GET',headers,signal,maxHeaderSize:64*1024,lookup:pinnedLookup,...(!isIP(plainHostname(url.hostname))?{servername:plainHostname(url.hostname)}:{})},response=>{
    const responseHeaders=new Headers();for(const [name,value] of Object.entries(response.headers)){if(Array.isArray(value))for(const item of value)responseHeaders.append(name,item);else if(value!==undefined)responseHeaders.set(name,String(value))}
    resolve({status:response.statusCode??0,headers:responseHeaders,body:response,cancel:()=>response.destroy()});
  });
  request.once('error',reject);request.end();
});

function decoded(body:AsyncIterable<Uint8Array>,encoding:string):AsyncIterable<Uint8Array>{
  const source=Readable.from(body);if(!encoding||encoding==='identity')return source;if(encoding==='gzip'||encoding==='x-gzip')return source.pipe(createGunzip());if(encoding==='br')return source.pipe(createBrotliDecompress());if(encoding==='deflate')return source.pipe(createInflate());throw new PublishedFetchError(`Unsupported response encoding: ${encoding}`,'unsupported-encoding');
}
async function boundedBody(response:PinnedResponse,limit:number):Promise<Buffer>{
  const declared=Number(response.headers.get('content-length')??0);if(Number.isFinite(declared)&&declared>limit){response.cancel?.();throw new PublishedFetchError(`Published resource exceeds the ${limit} byte limit`,'too-large')}
  const chunks:Buffer[]=[],encoding=(response.headers.get('content-encoding')??'').trim().toLowerCase();let bytes=0;
  try{for await(const raw of decoded(response.body,encoding)){const chunk=Buffer.from(raw);bytes+=chunk.byteLength;if(bytes>limit){response.cancel?.();throw new PublishedFetchError(`Published resource exceeds the ${limit} byte limit`,'too-large')}chunks.push(chunk)}}catch(error){if(error instanceof PublishedFetchError)throw error;throw new PublishedFetchError(error instanceof Error?error.message:'Could not read published resource','network-error')}
  return Buffer.concat(chunks);
}
function contentType(headers:Headers):string{return(headers.get('content-type')??'').split(';',1)[0]!.trim().toLowerCase()}
function looksLikeChallenge(content:Buffer,status:number):boolean{
  const sample=content.subarray(0,256*1024).toString('utf8').toLowerCase();
  const cloudflareMarker=/(?:\b_cf_chl_opt\b|\/cdn-cgi\/challenge-platform\/|\bcf-chl-(?:widget|running|managed|interactive)\b|id=["']challenge-form["'])/i.test(sample);
  const cloudflareTitle=/<title[^>]*>\s*just a moment(?:\.\.\.)?\s*<\/title>/i.test(sample),cloudflareCopy=/(?:performing security verification|enable javascript and cookies to continue)/i.test(sample);
  const challengeCopy=/(?:verify (?:that )?you(?:'re| are) (?:a human|not a robot)|checking your browser|captcha|enable javascript and (?:reload|continue)|security check to access)/i.test(sample);
  const challengeStructure=/(?:data-sitekey\s*=|\b(?:g-recaptcha|h-captcha|cf-turnstile)\b|<(?:form|iframe|script)\b[^>]*(?:captcha|challenge|turnstile))/i.test(sample);
  return cloudflareMarker||(cloudflareTitle&&cloudflareCopy)||(challengeCopy&&(status>=400||challengeStructure));
}

export async function safePublishedFetch(value:string|URL,options:SafePublishedFetchOptions={}):Promise<SafePublishedResponse>{
  const requested=validatePublishedUrl(value),resolver=options.resolver??defaultResolver,transport=options.transport??defaultTransport,limit=options.maxBytes??20*1024*1024,maxRedirects=options.maxRedirects??5,timeout=AbortSignal.timeout(options.timeoutMs??30_000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout,redirectChain:string[]=[];
  let url=requested;
  for(let redirects=0;;redirects++){
    if(redirects>maxRedirects)throw new PublishedFetchError('Published source returned too many redirects','too-many-redirects');
    const addresses=await resolver(plainHostname(url.hostname),signal);if(!addresses.length||addresses.some(item=>![4,6].includes(item.family)||!isPublicPublishedAddress(item.address)))throw new PublishedFetchError(`Refused a non-public address for ${plainHostname(url.hostname)}`,'unsafe-address');
    let response:PinnedResponse;try{response=await transport(url,addresses[0]!,{accept:options.accept??'text/html,application/xhtml+xml,application/xml,text/xml,application/pdf;q=0.9,*/*;q=0.1','accept-encoding':'gzip, br, deflate','user-agent':options.userAgent??'AfterDraft-Published-Importer/0.5'},signal)}catch(error){if(error instanceof PublishedFetchError)throw error;throw new PublishedFetchError(error instanceof Error?error.message:'Published source request failed','network-error')}
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');response.cancel?.();if(!location)throw new PublishedFetchError(`Redirect ${response.status} omitted its destination`,'http-status',response.status);redirectChain.push(url.toString());url=validatePublishedUrl(new URL(location,url));continue}
    const errorLimit=response.status>=400?Math.min(limit,1024*1024):limit,bytes=await boundedBody(response,errorLimit),challenge=response.headers.get('cf-mitigated')?.toLowerCase()==='challenge'||looksLikeChallenge(bytes,response.status);
    if(challenge)throw new PublishedFetchError('The publisher returned a bot-verification challenge','challenge',response.status);
    if(response.status===401||response.status===403)throw new PublishedFetchError('The published source requires authentication or denied automated access','authentication-required',response.status);
    if(response.status===429)throw new PublishedFetchError('The published source rate-limited this import','rate-limited',response.status);
    if(response.status<200||response.status>=300)throw new PublishedFetchError(`Published source returned HTTP ${response.status}`,'http-status',response.status);
    return{requestedUrl:requested.toString(),finalUrl:url.toString(),redirectChain,status:response.status,headers:response.headers,contentType:contentType(response.headers),bytes};
  }
}
