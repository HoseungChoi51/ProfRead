import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { z } from 'zod';
import { config } from '../config.js';

const openZip=promisify<Buffer,yauzl.Options,yauzl.ZipFile>(yauzl.fromBuffer);
const allowedExtensions=new Set(['.html','.htm','.css','.json','.png','.jpg','.jpeg','.gif','.webp','.svg','.woff','.woff2','.ttf','.otf','.pdf']);
const manifestSchema=z.object({
  schemaVersion:z.number().int(),
  operation:z.enum(['convert','render','inspect','pdf-prepare','pdf-index','pdf-crop']),
  source:z.object({kind:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough(),
  output:z.object({entryPath:z.string().min(1)}).passthrough().optional(),
  converter:z.record(z.string(),z.unknown()).optional(),
  inventory:z.record(z.string(),z.unknown()).optional(),
  warnings:z.array(z.object({code:z.string(),severity:z.enum(['info','warning','error']),message:z.string(),evidence:z.record(z.string(),z.unknown()).optional()}).passthrough()).default([]),
  files:z.array(z.object({path:z.string(),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).default([]),
}).passthrough();

export type AcademicManifest=z.infer<typeof manifestSchema>;
export interface ExtractedBundleFile{path:string;storagePath:string;bytes:number;sha256:string}
export interface VerifiedWorkerBundle{directory:string;manifest:AcademicManifest;files:ExtractedBundleFile[]}
export interface ExtractedBundle extends VerifiedWorkerBundle{entryPath:string;manifest:AcademicManifest&{operation:'convert';output:{entryPath:string}}}

function safeName(raw:string):string{
  const name=raw.replaceAll('\\','/');
  if(!name||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))throw new Error(`Unsafe worker bundle path: ${JSON.stringify(raw)}`);
  if(!name.endsWith('/')&&!allowedExtensions.has(extname(name).toLowerCase()))throw new Error(`Unsupported worker bundle entry: ${name}`);
  return name;
}
function streamFor(zip:yauzl.ZipFile,entry:yauzl.Entry):Promise<NodeJS.ReadableStream>{return new Promise((accept,reject)=>zip.openReadStream(entry,(error,stream)=>error||!stream?reject(error??new Error('Could not read worker bundle entry')):accept(stream)))}

export async function extractVerifiedWorkerBundle(buffer:Buffer,directory:string,expectedSourceHash:string,operation:AcademicManifest['operation']):Promise<VerifiedWorkerBundle>{
  if(buffer.byteLength>config.limits.expandedBytes)throw new Error('Worker response exceeds the import expansion limit');
  await mkdir(directory,{recursive:true,mode:0o700});
  const zip=await openZip(buffer,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true}),files:ExtractedBundleFile[]=[],seen=new Set<string>();
  let count=0,total=0;
  await new Promise<void>((accept,reject)=>{
    let settled=false;
    const fail=(error:unknown)=>{if(!settled){settled=true;zip.close();reject(error)}};
    zip.on('error',fail);zip.on('end',()=>{if(!settled){settled=true;accept()}});
    zip.on('entry',entry=>{void(async()=>{
      const name=safeName(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xffff;
      if(seen.has(name))throw new Error(`Duplicate worker bundle entry: ${name}`);seen.add(name);
      if((mode&0o170000)===0o120000||(entry.generalPurposeBitFlag&1)!==0)throw new Error(`Unsafe worker bundle entry: ${name}`);
      if(++count>config.limits.entries||entry.uncompressedSize>config.limits.expandedBytes)throw new Error('Worker bundle entry limit exceeded');
      if(entry.compressedSize>0&&entry.uncompressedSize/entry.compressedSize>200)throw new Error('Worker bundle expansion ratio exceeded');
      total+=entry.uncompressedSize;if(total>config.limits.expandedBytes)throw new Error('Worker bundle expansion limit exceeded');
      if(name.endsWith('/')){await mkdir(resolve(directory,name),{recursive:true,mode:0o700});zip.readEntry();return}
      const target=resolve(directory,name),root=resolve(directory)+sep;if(!target.startsWith(root))throw new Error('Unsafe worker bundle extraction target');
      await mkdir(dirname(target),{recursive:true,mode:0o700});const hash=createHash('sha256');let bytes=0;
      const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>entry.uncompressedSize)return callback(new Error('Worker bundle entry exceeded its declared size'));hash.update(chunk);callback(null,chunk)}});
      await pipeline(await streamFor(zip,entry),meter,createWriteStream(target,{flags:'wx',mode:0o600}));
      if(bytes!==entry.uncompressedSize)throw new Error('Worker bundle entry size mismatch');
      files.push({path:name,storagePath:target,bytes,sha256:hash.digest('hex')});zip.readEntry();
    })().catch(fail)});
    zip.readEntry();
  });
  const manifestFile=files.find(file=>file.path==='manifest.json');if(!manifestFile)throw new Error('Worker bundle has no manifest.json');
  const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestFile.storagePath,'utf8')));
  if(manifest.operation!==operation)throw new Error(`Worker bundle operation mismatch: expected ${operation}`);
  if(manifest.source.sha256!==expectedSourceHash)throw new Error('Worker bundle source hash does not match the uploaded source');
  const byPath=new Map(files.map(file=>[file.path,file]));
  const listed=new Set(manifest.files.map(file=>safeName(file.path)));
  for(const expected of manifest.files){const path=safeName(expected.path),actual=byPath.get(path);if(!actual||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw new Error(`Worker bundle integrity check failed: ${path}`)}
  // A worker may retain diagnostic/provenance files outside manifest.files.
  // They stay quarantined in the job bundle, but never enter the verified set
  // consumed by preview, review, or publication.
  return{directory,manifest,files:files.filter(file=>file.path==='manifest.json'||listed.has(file.path))};
}

export async function extractAcademicBundle(buffer:Buffer,directory:string,expectedSourceHash:string):Promise<ExtractedBundle>{
  const bundle=await extractVerifiedWorkerBundle(buffer,directory,expectedSourceHash,'convert'),output=bundle.manifest.output;if(!output)throw new Error('Worker conversion bundle has no HTML output');
  const entryPath=safeName(output.entryPath),entry=bundle.files.find(file=>file.path===entryPath);if(!entry||!['.html','.htm'].includes(extname(entryPath).toLowerCase()))throw new Error('Worker bundle HTML entry is missing');
  if((await stat(entry.storagePath)).size>config.limits.htmlBytes)throw new Error('Converted HTML exceeds the HTML size limit');
  return{...bundle,entryPath,manifest:bundle.manifest as ExtractedBundle['manifest']};
}
export async function extractRenderBundle(buffer:Buffer,directory:string,expectedSourceHash:string):Promise<VerifiedWorkerBundle>{
  const bundle=await extractVerifiedWorkerBundle(buffer,directory,expectedSourceHash,'render');
  for(const file of bundle.files)if(file.path!=='manifest.json'&&!['.png','.json'].includes(extname(file.path).toLowerCase()))throw new Error(`Unsupported render evidence file: ${file.path}`);
  return bundle;
}

export async function extractInspectionBundle(buffer:Buffer,directory:string,expectedSourceHash:string):Promise<VerifiedWorkerBundle>{
  const bundle=await extractVerifiedWorkerBundle(buffer,directory,expectedSourceHash,'inspect');
  for(const file of bundle.files)if(file.path!=='manifest.json'&&file.path!=='inspection.json'&&!['.jpg','.json'].includes(extname(file.path).toLowerCase()))throw new Error(`Unsupported inspection evidence file: ${file.path}`);
  return bundle;
}

export const academicMimeTypes:Record<string,string>={'.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
export function assetMime(path:string):string|undefined{return academicMimeTypes[extname(path).toLowerCase()]}
export function stableAssetId(path:string):string{return createHash('sha256').update(path).digest('hex').slice(0,24)}
