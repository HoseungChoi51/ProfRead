import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';

export class AcademicWorkerError extends Error{
  constructor(message:string,readonly status:number,readonly code?:string,readonly entryChoices:string[]=[]){super(message)}
}

async function boundedBody(response:Response,limit:number):Promise<Buffer>{
  const declared=Number(response.headers.get('content-length')??0);if(declared>limit)throw new AcademicWorkerError('Academic worker response is too large',502,'response_too_large');
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks:Buffer[]=[];let bytes=0;
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();throw new AcademicWorkerError('Academic worker response is too large',502,'response_too_large')}chunks.push(Buffer.from(value))}
  return Buffer.concat(chunks);
}
function operationUrl(path:string,params:Record<string,string|boolean|number|undefined>):URL{
  const url=new URL(path,config.academicWorkerUrl.endsWith('/')?config.academicWorkerUrl:`${config.academicWorkerUrl}/`);
  for(const [key,value] of Object.entries(params))if(value!==undefined)url.searchParams.set(key,String(value));
  return url;
}
async function request(path:string,sourcePath:string,mimeType:string,params:Record<string,string|boolean|number|undefined>,signal?:AbortSignal,timeoutMs=10*60_000):Promise<Buffer>{
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error('Academic worker timed out')),timeoutMs);
  const abort=()=>timeout.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  try{
    const body=await openAsBlob(sourcePath,{type:mimeType}),response=await fetch(operationUrl(path,params),{method:'POST',headers:{'content-type':mimeType},body,signal:timeout.signal});
    const bytes=await boundedBody(response,response.ok?config.limits.workerResponseBytes:1024*1024);
    if(!response.ok){let parsed:{error?:string;code?:string;entryChoices?:unknown}={};try{parsed=JSON.parse(bytes.toString('utf8'))}catch{/* use status fallback */}const entryChoices=Array.isArray(parsed.entryChoices)?parsed.entryChoices.filter((value):value is string=>typeof value==='string'&&value.length>0&&value.length<=500).slice(0,200):[];throw new AcademicWorkerError(parsed.error??`Academic worker returned ${response.status}`,response.status,parsed.code,entryChoices)}
    if(!/application\/zip/i.test(response.headers.get('content-type')??''))throw new AcademicWorkerError('Academic worker did not return a ZIP bundle',502,'invalid_response');
    return bytes;
  }catch(error){if(error instanceof AcademicWorkerError)throw error;if(timeout.signal.aborted)throw new AcademicWorkerError(signal?.aborted?'Academic import was cancelled':'Academic worker timed out',signal?.aborted?499:504,signal?.aborted?'cancelled':'timeout');throw new AcademicWorkerError(error instanceof Error?error.message:'Academic worker request failed',502,'worker_unavailable')}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}

export function convertDocx(sourcePath:string,filename:string,includeReference:boolean,signal?:AbortSignal):Promise<Buffer>{return request('/v1/convert/docx',sourcePath,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',{filename,reference:includeReference,referencePages:40},signal)}
export function convertTex(sourcePath:string,filename:string,entry:string|undefined,signal?:AbortSignal):Promise<Buffer>{return request('/v1/convert/tex',sourcePath,/\.zip$/i.test(filename)?'application/zip':'application/x-tex',{filename,entry},signal)}
export function convertJats(sourcePath:string,filename:string,signal?:AbortSignal):Promise<Buffer>{return request('/v1/convert/jats',sourcePath,'application/xml',{filename},signal)}
export function convertPdf(sourcePath:string,filename:string,includeReference:boolean,signal?:AbortSignal,range?:{pageStart:number;pageEnd:number;title:string}):Promise<Buffer>{return request('/v1/convert/pdf',sourcePath,'application/pdf',{filename,reference:includeReference,referencePages:60,pageStart:range?.pageStart,pageEnd:range?.pageEnd,title:range?.title},signal,18*60_000)}
export function inspectPdf(sourcePath:string,filename:string,title:string,signal?:AbortSignal):Promise<Buffer>{return request('/v1/inspect/pdf',sourcePath,'application/pdf',{filename,title},signal,18*60_000)}
export function renderHtml(sourcePath:string,signal?:AbortSignal):Promise<Buffer>{return request('/v1/render',sourcePath,'text/html',{maxObjects:160},signal)}
export function renderPdf(sourcePath:string,pages=60,signal?:AbortSignal):Promise<Buffer>{return request('/v1/render/pdf',sourcePath,'application/pdf',{filename:basename(sourcePath),pages},signal)}
