import { basename, extname, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assertFileWithinWorkerOutputLimit, bundleFiles, createZip, sha256Bytes, writeJson } from './files.js';
import { WorkerError } from './errors.js';
import { runCommand } from './process.js';
import type { OperationResult } from './convert.js';

export interface JatsConversionOptions{filename:string;signal?:AbortSignal}

function decodeXmlText(value:string):string{
  return value.replace(/<[^>]+>/g,' ').replace(/&(?:amp|#38);/gi,'&').replace(/&(?:lt|#60);/gi,'<').replace(/&(?:gt|#62);/gi,'>').replace(/&(?:quot|#34);/gi,'"').replace(/&(?:apos|#39);/gi,"'").replace(/&#(\d+);/g,(_match,value)=>{const code=Number(value);return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):''}).replace(/\s+/g,' ').trim();
}
export function jatsTitle(source:string,filename='article.xml'):string{
  const match=source.match(/<article-title(?:\s[^>]*)?>([\s\S]*?)<\/article-title>/i),title=match?decodeXmlText(match[1]!):'';
  return title.slice(0,500)||basename(filename,extname(filename)).trim()||'Imported article';
}

export async function convertJats(body:Buffer,options:JatsConversionOptions):Promise<OperationResult>{
  if(body.byteLength<20||!/<article(?:\s|>)/i.test(body.subarray(0,Math.min(body.byteLength,128*1024)).toString('utf8')))throw new WorkerError('invalid_jats','The source is not a JATS article document.',422);
  const root=await mkdtemp(join(tmpdir(),'afterdraft-jats-')),bundle=join(root,'bundle'),input=join(root,'article.xml');await mkdir(bundle);await writeFile(input,body,{mode:0o600});
  try{
    const source=body.toString('utf8'),title=jatsTitle(source,options.filename),conversion=await runCommand('pandoc',[input,'--from=jats','--to=html5','--standalone','--mathml','--wrap=none','--metadata',`pagetitle=${title}`,'--output=document.html'],{cwd:bundle,signal:options.signal,timeoutMs:180_000});
    const html=await readFile(join(bundle,'document.html'),'utf8');if(!/<body[\s>]/i.test(html)||html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().length<20)throw new WorkerError('incomplete_conversion','JATS conversion did not produce a complete article body.',422);
    const manifest:Record<string,unknown>={schemaVersion:1,operation:'convert',source:{kind:'jats',filename:basename(options.filename||'article.xml'),bytes:body.byteLength,sha256:sha256Bytes(body)},converter:{selected:'pandoc-jats',attempts:[{tool:conversion.command,exitCode:conversion.exitCode,durationMs:conversion.durationMs}]},output:{entryPath:'document.html',title},warnings:[]};
    manifest.files=await bundleFiles(bundle);await writeJson(join(bundle,'manifest.json'),manifest);const archive=join(root,'result.zip');await createZip(bundle,archive,options.signal);await assertFileWithinWorkerOutputLimit(archive,'Converted JATS bundle exceeds the worker response limit.');return{root,archivePath:archive,downloadName:'afterdraft-jats-bundle.zip'};
  }catch(error){await rm(root,{recursive:true,force:true});throw error}
}
