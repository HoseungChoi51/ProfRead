import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fetchArxivBundle, fetchArxivPdf, type ArxivBundle } from './arxiv.js';
import { pdfReferenceEvidence } from './pdf-reference.js';
import { registerAcademicSourceHook, type AcademicJob } from './runner.js';
import type { AcademicManifest, ExtractedBundle, ExtractedBundleFile } from './bundle.js';

const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

export async function materializeArxivBundle(bundle:ArxivBundle,directory:string,sourceHash:string):Promise<ExtractedBundle>{
  await mkdir(directory,{recursive:true,mode:0o700});const files:ExtractedBundleFile[]=[];
  const add=async(path:string,bytes:Buffer)=>{const storagePath=join(directory,path);await mkdir(dirname(storagePath),{recursive:true,mode:0o700});await writeFile(storagePath,bytes,{mode:0o600,flag:'wx'});const item={path,storagePath,bytes:bytes.byteLength,sha256:sha256(bytes)};files.push(item);return item};
  await add(bundle.entryPath,Buffer.from(bundle.html));for(const asset of bundle.assets)await add(asset.sourcePath,asset.bytes);
  const manifest:AcademicManifest&{operation:'convert';output:{entryPath:string}}={schemaVersion:1,operation:'convert',source:{kind:'arxiv-html',sha256:sourceHash,arxivId:bundle.arxivId,url:bundle.sourceUrl,pdfUrl:bundle.pdfUrl},converter:{selected:'native-arxiv-html',revision:'1'},output:{entryPath:bundle.entryPath},warnings:bundle.warnings.map(warning=>({code:warning.code,severity:warning.code==='source-chrome-removed'?'info':'warning',message:warning.message,...(warning.sourceUrl?{evidence:{sourceUrl:warning.sourceUrl}}:{})})),files:files.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  const manifestPath=join(directory,'manifest.json'),manifestBytes=Buffer.from(JSON.stringify(manifest,null,2));await writeFile(manifestPath,manifestBytes,{mode:0o600,flag:'wx'});files.push({path:'manifest.json',storagePath:manifestPath,bytes:manifestBytes.byteLength,sha256:sha256(manifestBytes)});
  return{directory,entryPath:bundle.entryPath,manifest,files};
}

async function arxivSource(job:AcademicJob,directory:string,signal:AbortSignal):Promise<ExtractedBundle>{
  const reference=(await import('node:fs/promises').then(module=>module.readFile(job.source_path,'utf8'))).trim(),bundle=await fetchArxivBundle(reference,{signal}),result=await materializeArxivBundle(bundle,directory,job.source_hash);
  if(!job.ai_review_enabled||!job.source_reference)return result;
  const pdfPath=join(directory,'arxiv-reference.pdf');
  try{
    const pdf=await fetchArxivPdf(reference,{signal,maxBytes:64*1024*1024});await writeFile(pdfPath,pdf.bytes,{mode:0o600,flag:'wx'});
    const rendered=await pdfReferenceEvidence(pdfPath,directory,signal);result.files.push(...rendered.files);result.manifest.warnings.push(...rendered.warnings);
  }catch(error){
    result.manifest.warnings.push({code:'arxiv_reference_failed',severity:'warning',message:`The official arXiv PDF could not be rendered for visual comparison: ${error instanceof Error?error.message:String(error)}`});
  }finally{await rm(pdfPath,{force:true}).catch(()=>{})}
  return result;
}

export function installArxivSourceHook():void{registerAcademicSourceHook('arxiv',arxivSource)}
