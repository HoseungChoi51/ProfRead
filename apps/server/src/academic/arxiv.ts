import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import * as cheerio from 'cheerio';

export type ArxivAsset = { sourcePath:string; mimeType:string; bytes:Buffer };
export type ArxivWarning = { code:string; message:string; sourceUrl?:string };
export type ArxivBundle = {
  arxivId:string;
  sourceUrl:string;
  pdfUrl:string;
  entryPath:'document.html';
  html:string;
  assets:ArxivAsset[];
  warnings:ArxivWarning[];
};

type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;
type FetchOptions={fetchImpl?:FetchLike;signal?:AbortSignal;maxBytes?:number;maxAssets?:number};
const newId=/^\d{4}\.\d{4,5}(?:v\d+)?$/i,oldId=/^[a-z][a-z0-9.-]*\/\d{7}(?:v\d+)?$/i;
const htmlLimit=20*1024*1024,assetLimit=30*1024*1024,totalDefault=120*1024*1024;
const allowedAssetTypes=new Set(['text/css','image/png','image/jpeg','image/gif','image/webp','image/svg+xml','font/woff','font/woff2','font/ttf','font/otf','application/font-woff','application/vnd.ms-fontobject','application/octet-stream']);

function allowedArxivHost(hostname:string):boolean{return hostname==='arxiv.org'||hostname.endsWith('.arxiv.org')}
export function parseArxivReference(value:string):string{
  let candidate=value.trim();
  try{const url=new URL(candidate);if(!allowedArxivHost(url.hostname.toLowerCase()))throw new Error('Only arxiv.org URLs are supported');const match=url.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i);if(!match)throw new Error('Use an arXiv abstract, HTML, or PDF URL');candidate=decodeURIComponent(match[1]!)}catch(error){if(/^https?:/i.test(candidate))throw error}
  candidate=candidate.replace(/^arxiv:/i,'').trim();if(!newId.test(candidate)&&!oldId.test(candidate))throw new Error('Enter a valid arXiv ID or arxiv.org URL');return candidate;
}

function checkedUrl(value:string|URL):URL{const url=value instanceof URL?value:new URL(value);if(url.protocol!=='https:'||!allowedArxivHost(url.hostname.toLowerCase())||url.username||url.password)throw new Error('arXiv fetch was redirected outside the approved HTTPS hosts');return url}
function combinedSignal(signal?:AbortSignal):AbortSignal{const timeout=AbortSignal.timeout(30_000);return signal?AbortSignal.any([signal,timeout]):timeout}
async function fetchBytes(fetchImpl:FetchLike,urlValue:string|URL,limit:number,signal?:AbortSignal,redirects=0):Promise<{url:URL;bytes:Buffer;contentType:string}>{
  const url=checkedUrl(urlValue);if(redirects>4)throw new Error('arXiv returned too many redirects');
  const response=await fetchImpl(url,{redirect:'manual',signal:combinedSignal(signal),headers:{accept:'text/html,text/css,image/*,font/*,application/octet-stream;q=0.5','user-agent':'ProfRead academic importer/0.4'}});
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw new Error(`arXiv redirect ${response.status} omitted its destination`);return fetchBytes(fetchImpl,new URL(location,url),limit,signal,redirects+1)}
  if(!response.ok)throw new Error(`arXiv returned ${response.status} for ${url.pathname}`);const declared=Number(response.headers.get('content-length')??0);if(Number.isFinite(declared)&&declared>limit)throw new Error(`arXiv resource exceeds the ${limit} byte limit`);
  if(!response.body){const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>limit)throw new Error(`arXiv resource exceeds the ${limit} byte limit`);return{url,bytes,contentType:(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase()}}
  const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;while(true){const{done,value}=await reader.read();if(done)break;const chunk=Buffer.from(value);length+=chunk.length;if(length>limit){await reader.cancel();throw new Error(`arXiv resource exceeds the ${limit} byte limit`)}chunks.push(chunk)}return{url,bytes:Buffer.concat(chunks),contentType:(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase()};
}

function extensionFor(url:URL,mimeType:string):string{const known:Record<string,string>={'text/css':'.css','image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp','image/svg+xml':'.svg','font/woff':'.woff','font/woff2':'.woff2','font/ttf':'.ttf','font/otf':'.otf','application/font-woff':'.woff','application/vnd.ms-fontobject':'.eot'};const ext=extname(url.pathname).toLowerCase();return known[mimeType]??(/^[.][a-z0-9]{1,6}$/.test(ext)?ext:'.bin')}
function logicalPath(url:URL,mimeType:string):string{return`assets/${createHash('sha256').update(url.toString()).digest('hex').slice(0,24)}${extensionFor(url,mimeType)}`}
function resourceUrl(raw:string,base:URL):URL|null{const value=raw.trim();if(!value||value.startsWith('#')||/^data:/i.test(value))return null;try{const url=new URL(value,base);if(url.protocol==='http:')url.protocol='https:';return checkedUrl(url)}catch{return null}}

export async function fetchArxivBundle(reference:string,options:FetchOptions={}):Promise<ArxivBundle>{
  const arxivId=parseArxivReference(reference),fetchImpl=options.fetchImpl??fetch,maxBytes=options.maxBytes??totalDefault,maxAssets=options.maxAssets??600,sourceUrl=`https://arxiv.org/html/${arxivId}`,pdfUrl=`https://arxiv.org/pdf/${arxivId}`;
  const page=await fetchBytes(fetchImpl,sourceUrl,htmlLimit,options.signal);if(page.contentType&&page.contentType!=='text/html'&&page.contentType!=='application/xhtml+xml')throw new Error(`arXiv HTML endpoint returned ${page.contentType}`);
  let total=page.bytes.length;const warnings:ArxivWarning[]=[],assets:ArxivAsset[]=[],paths=new Map<string,string>(),inFlight=new Map<string,Promise<string|null>>();
  const fetchAsset=async(url:URL):Promise<string|null>=>{const key=url.toString(),known=paths.get(key);if(known)return known;const pending=inFlight.get(key);if(pending)return pending;const task=(async()=>{if(assets.length>=maxAssets){warnings.push({code:'asset-count-limit',message:`Skipped assets after the ${maxAssets}-file limit`,sourceUrl:key});return null}try{const result=await fetchBytes(fetchImpl,url,assetLimit,options.signal);const type=result.contentType||'application/octet-stream';if(!allowedAssetTypes.has(type))throw new Error(`unsupported content type ${type}`);if(total+result.bytes.length>maxBytes)throw new Error(`total import exceeds the ${maxBytes} byte limit`);total+=result.bytes.length;const path=logicalPath(result.url,type);paths.set(key,path);paths.set(result.url.toString(),path);let bytes=result.bytes;if(type==='text/css')bytes=Buffer.from(await rewriteCss(result.bytes.toString('utf8'),result.url));assets.push({sourcePath:path,mimeType:type,bytes});return path}catch(error){warnings.push({code:'asset-fetch-failed',message:error instanceof Error?error.message:String(error),sourceUrl:key});return null}})();inFlight.set(key,task);return task};
  const rewriteCss=async(css:string,base:URL):Promise<string>=>{const matches=[...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)],replacements=new Map<string,string>();for(const match of matches){const raw=match[2]??'',url=resourceUrl(raw,base);if(!url){replacements.set(raw,'');continue}const path=await fetchAsset(url);replacements.set(raw,path?basename(path):'')}return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_all,_quote,raw:string)=>`url("${replacements.get(raw)??''}")`).replace(/@import[\s\S]*?(?:;|$)/gi,'')};
  const $=cheerio.load(page.bytes.toString('utf8'));
  const article=$('article.ltx_document').first();if(article.length){$('body').empty().append(article);warnings.push({code:'source-chrome-removed',message:'Removed arXiv navigation, report controls, and site footer from the article view'})}
  const references:Array<{element:any;attribute:string;raw:string}>=[];
  $('link[rel~="stylesheet"][href]').each((_i,element)=>{references.push({element,attribute:'href',raw:$(element).attr('href')??''})});
  $('img[src],source[src]').each((_i,element)=>{references.push({element,attribute:'src',raw:$(element).attr('src')??''})});
  for(const item of references){const url=resourceUrl(item.raw,page.url);if(!url){$(item.element).attr(item.attribute,'');warnings.push({code:'unsafe-asset-url',message:'Removed a non-arXiv or unsafe asset URL',sourceUrl:item.raw});continue}const path=await fetchAsset(url);$(item.element).attr(item.attribute,path??'');if(item.attribute==='src')$(item.element).removeAttr('srcset')}
  $('base').remove();
  return{arxivId,sourceUrl:page.url.toString(),pdfUrl,entryPath:'document.html',html:$.html(),assets,warnings};
}

export async function fetchArxivPdf(reference:string,options:FetchOptions={}):Promise<{arxivId:string;sourceUrl:string;bytes:Buffer}>{
  const arxivId=parseArxivReference(reference),result=await fetchBytes(options.fetchImpl??fetch,`https://arxiv.org/pdf/${arxivId}`,options.maxBytes??100*1024*1024,options.signal);
  if(result.contentType&&result.contentType!=='application/pdf')throw new Error(`arXiv PDF endpoint returned ${result.contentType}`);
  if(result.bytes.length<5||result.bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('arXiv PDF endpoint returned invalid PDF data');
  return{arxivId,sourceUrl:result.url.toString(),bytes:result.bytes};
}
