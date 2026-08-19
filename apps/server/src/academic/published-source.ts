import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import * as cheerio from 'cheerio';
import {config} from '../config.js';
import {extractAcademicBundle,type AcademicManifest,type ExtractedBundle,type ExtractedBundleFile} from './bundle.js';
import type {AcademicJob} from './runner.js';
import {convertJats as workerConvertJats} from './worker-client.js';
import {PublishedFetchError,safePublishedFetch,type SafePublishedResponse} from './published-fetch.js';
import {normalizeGenericPublishedHtml,PublishedIncompleteError} from './published-html.js';
import {findOfficialPmcJats} from './published-repository.js';
import type {NormalizedPublishedHtml,NormalizedPublishedJats,NormalizedPublishedPdf,NormalizedPublishedSource,PublishedBundleConverter,ResolvePublishedSourceOptions} from './published-types.js';
import {extractPublishedDoi,fetchOptions,normalizePublishedLocator,retrievalTime,sha256} from './published-utils.js';

export type {NormalizedPublishedHtml,NormalizedPublishedJats,NormalizedPublishedPdf,NormalizedPublishedSource,PublishedSourceAsset,PublishedSourceProvenance,PublishedSourceWarning,ResolvePublishedSourceOptions} from './published-types.js';
export {extractPublishedDoi,normalizePublishedLocator} from './published-utils.js';

export interface PublishedSourceHookOptions extends ResolvePublishedSourceOptions{
  convertJats?:PublishedBundleConverter;convertPdf?:(sourcePath:string,filename:string,includeReference:boolean,signal?:AbortSignal)=>Promise<Buffer>;
  resolve?:(locator:string,options?:ResolvePublishedSourceOptions)=>Promise<NormalizedPublishedSource>;
  overallTimeoutMs?:number;
}
function responseKind(response:SafePublishedResponse):'html'|'jats'|'pdf'|'unknown'{
  if(response.bytes.length>=5&&response.bytes.subarray(0,5).toString('ascii')==='%PDF-')return'pdf';
  const sample=response.bytes.subarray(0,128*1024).toString('utf8');
  if(['application/xml','text/xml','application/jats+xml'].includes(response.contentType)&&/<article(?:\s|>)/i.test(sample))return'jats';
  if(['text/html','application/xhtml+xml'].includes(response.contentType)||/<(?:!doctype\s+html|html)(?:\s|>)/i.test(sample))return'html';return'unknown';
}
function jatsMetadata(bytes:Buffer):{doi:string|null;title:string}{const $=cheerio.load(bytes.toString('utf8'),{xmlMode:true});return{doi:extractPublishedDoi($('article-id[pub-id-type="doi"]').first().text()),title:$('article-title').first().text().replace(/\s+/g,' ').trim().slice(0,500)||'Published article'}}
function fallbackAllowed(error:unknown):boolean{return!(error instanceof PublishedFetchError&&['invalid-url','unsafe-address'].includes(error.code))}

export async function resolvePublishedSource(locator:string,options:ResolvePublishedSourceOptions={}):Promise<NormalizedPublishedSource>{
  const normalized=normalizePublishedLocator(locator),requestedUrl=normalized.url.toString(),fetcher=options.fetcher??safePublishedFetch;let directError:unknown;
  try{
    const response=await fetcher(normalized.url,fetchOptions(options,{maxBytes:config.limits.zipBytes,accept:'text/html,application/xhtml+xml,application/xml,text/xml,application/pdf;q=0.9,*/*;q=0.1'})),kind=responseKind(response),contentSha256=sha256(response.bytes),retrievedAt=retrievalTime(options);
    if(kind==='html')return await normalizeGenericPublishedHtml(response,requestedUrl,normalized.doi,options);
    if(kind==='jats'){
      const metadata=jatsMetadata(response.bytes);if(normalized.doi&&metadata.doi&&metadata.doi!==normalized.doi)throw new Error('Published URL returned JATS for a different DOI');
      return{kind:'jats',title:metadata.title,bytes:response.bytes,filename:'article.xml',assets:[],warnings:[],provenance:{requestedUrl,finalUrl:response.finalUrl,canonicalUrl:response.finalUrl,redirectChain:response.redirectChain,doi:metadata.doi??normalized.doi,retrievedAt,adapter:'direct-jats',license:null,contentSha256}};
    }
    if(kind==='pdf'){
      const path=basename(new URL(response.finalUrl).pathname),title=normalized.doi??(path.replace(/\.pdf$/i,'')||'Published article');
      return{kind:'pdf',title,bytes:response.bytes,filename:/\.pdf$/i.test(path)?path:'article.pdf',assets:[],warnings:[],provenance:{requestedUrl,finalUrl:response.finalUrl,canonicalUrl:response.finalUrl,redirectChain:response.redirectChain,doi:normalized.doi,retrievedAt,adapter:'direct-pdf',license:null,contentSha256}};
    }
    throw new Error(`Published URL returned unsupported content type ${response.contentType||'unknown'}`);
  }catch(error){if(options.signal?.aborted)throw options.signal.reason??error;directError=error}
  if(!fallbackAllowed(directError))throw directError;
  const doi=directError instanceof PublishedIncompleteError?directError.doi:normalized.doi,directFailure=directError instanceof Error?directError.message:String(directError);
  if(doi){const fallback=await findOfficialPmcJats(doi,requestedUrl,directFailure,options);if(fallback)return fallback}throw directError;
}

function sourceManifest(source:NormalizedPublishedSource,locatorHash:string):{kind:string;sha256:string;[key:string]:unknown}{
  const item=source.provenance,contentType=source.kind==='html'?'text/html':source.kind==='jats'?'application/xml':'application/pdf';return{kind:source.kind==='html'?'published-html':source.kind==='jats'?'published-jats':'published-pdf',sha256:locatorHash,contentSha256:item.contentSha256,contentType,assetCount:source.assets.length,fallbackUsed:Boolean(item.directFailure),requestedUrl:item.requestedUrl,finalUrl:item.finalUrl,canonicalUrl:item.canonicalUrl,doi:item.doi,retrievedAt:item.retrievedAt,adapter:item.adapter,license:item.license,redirectChain:item.redirectChain,...(item.directFailure?{directFailure:item.directFailure}:{}),...(item.pmcid?{pmcid:item.pmcid}:{})};
}
async function addFile(directory:string,path:string,bytes:Buffer):Promise<ExtractedBundleFile>{
  const storagePath=join(directory,path);await mkdir(dirname(storagePath),{recursive:true,mode:0o700});await writeFile(storagePath,bytes,{mode:0o600,flag:'wx'});return{path,storagePath,bytes:bytes.byteLength,sha256:sha256(bytes)};
}
function importWarnings(source:NormalizedPublishedSource):AcademicManifest['warnings']{return source.warnings.map(item=>({code:item.code,severity:'warning',message:item.message,...(item.sourceUrl?{evidence:{sourceUrl:item.sourceUrl}}:{})}))}
async function materializeHtml(source:NormalizedPublishedHtml,directory:string,locatorHash:string):Promise<ExtractedBundle>{
  await mkdir(directory,{recursive:true,mode:0o700});const entry=Buffer.from(source.html);if(entry.byteLength>config.limits.htmlBytes)throw new Error('Normalized published HTML exceeds the HTML size limit');const entryPath='document.html',files:ExtractedBundleFile[]=[await addFile(directory,entryPath,entry)];for(const asset of source.assets)files.push(await addFile(directory,asset.sourcePath,asset.bytes));
  const manifest:AcademicManifest&{operation:'convert';output:{entryPath:string;title:string}}={schemaVersion:1,operation:'convert',source:sourceManifest(source,locatorHash) as AcademicManifest['source'],converter:{selected:'published-generic-html',revision:'1'},output:{entryPath,title:source.title},warnings:importWarnings(source),files:files.map(({path,bytes,sha256})=>({path,bytes,sha256}))},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2));files.push(await addFile(directory,'manifest.json',manifestBytes));return{directory,entryPath,manifest,files};
}
async function rewriteConvertedManifest(bundle:ExtractedBundle,source:NormalizedPublishedSource,locatorHash:string):Promise<void>{
  const converted=bundle.manifest.source as Record<string,unknown>,published=sourceManifest(source,locatorHash),convertedAssets=Number(converted.assetCount??0);bundle.manifest.source={...converted,...published,assetCount:(Number.isFinite(convertedAssets)?convertedAssets:0)+source.assets.length,fallbackUsed:Boolean(converted.fallbackUsed)||Boolean(source.provenance.directFailure)};bundle.manifest.warnings.push(...importWarnings(source));bundle.manifest.files=bundle.files.filter(file=>file.path!=='manifest.json').map(({path,bytes,sha256})=>({path,bytes,sha256}));const file=bundle.files.find(item=>item.path==='manifest.json');if(!file)throw new Error('Converted published bundle has no manifest');const bytes=Buffer.from(JSON.stringify(bundle.manifest,null,2));await writeFile(file.storagePath,bytes,{mode:0o600});file.bytes=bytes.byteLength;file.sha256=sha256(bytes);
}
async function materializeConverted(source:NormalizedPublishedJats|NormalizedPublishedPdf,directory:string,locatorHash:string,converter:PublishedBundleConverter|undefined,signal:AbortSignal):Promise<ExtractedBundle>{
  if(!converter)throw new Error(`${source.kind.toUpperCase()} conversion is not configured for public URL imports`);await mkdir(directory,{recursive:true,mode:0o700});const sourcePath=join(directory,source.filename);await writeFile(sourcePath,source.bytes,{mode:0o600,flag:'wx'});const archive=await converter(sourcePath,source.filename,signal),bundle=await extractAcademicBundle(archive,directory,source.provenance.contentSha256);
  if(source.assets.length){
    const byRef=new Map<string,(typeof source.assets)[number]>();for(const asset of source.assets)for(const reference of new Set([...(asset.sourceRefs??[]),...(asset.sourceRef?[asset.sourceRef]:[])])){byRef.set(reference,asset);byRef.set(basename(reference),asset)}
    const entry=bundle.files.find(file=>file.path===bundle.entryPath);if(!entry)throw new Error('Converted published bundle HTML is missing');const $=cheerio.load(await readFile(entry.storagePath,'utf8'));
    $('img[src],source[src]').each((_i,element)=>{const node=$(element),raw=node.attr('src')??'',asset=byRef.get(raw)??byRef.get(basename(raw));if(asset)node.attr('src',asset.sourcePath)});
    const html=Buffer.from($.html());await writeFile(entry.storagePath,html,{mode:0o600});entry.bytes=html.byteLength;entry.sha256=sha256(html);for(const asset of source.assets)bundle.files.push(await addFile(directory,asset.sourcePath,asset.bytes));
  }
  await rewriteConvertedManifest(bundle,source,locatorHash);return bundle;
}

export function createPublishedSourceHook(options:PublishedSourceHookOptions={}):(job:AcademicJob,directory:string,signal:AbortSignal)=>Promise<ExtractedBundle>{
  const{convertJats=workerConvertJats,convertPdf,resolve=resolvePublishedSource,overallTimeoutMs=5*60_000,signal:configuredSignal,...resolverOptions}=options;
  return async(job,directory,signal)=>{const locator=(await readFile(job.source_path,'utf8')).trim();if(!locator||locator.length>4096)throw new Error('Stored public URL locator is invalid');const deadline=AbortSignal.timeout(overallTimeoutMs),sourceSignal=AbortSignal.any(configuredSignal?[signal,configuredSignal,deadline]:[signal,deadline]);let source:NormalizedPublishedSource;try{source=await resolve(locator,{...resolverOptions,signal:sourceSignal})}catch(error){if(deadline.aborted&&!signal.aborted&&!configuredSignal?.aborted)throw new Error('Public article retrieval exceeded its bounded import deadline');throw error}if(source.kind==='html')return materializeHtml(source,directory,job.source_hash);const converter=source.kind==='jats'?convertJats:convertPdf?(path:string,filename:string,nextSignal?:AbortSignal)=>convertPdf(path,filename,Boolean(job.ai_review_enabled&&job.source_reference),nextSignal):undefined;return materializeConverted(source,directory,job.source_hash,converter,signal)};
}
