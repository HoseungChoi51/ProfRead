import {basename} from 'node:path';
import {promisify} from 'node:util';
import yauzl from 'yauzl';
import {config} from '../config.js';

const openZip=promisify<Buffer,yauzl.Options,yauzl.ZipFile>(yauzl.fromBuffer);

export type PublishedArchiveEntry={path:string;bytes:Buffer};

function safeEntryName(raw:string):string{
  const name=raw.replaceAll('\\','/');
  if(!name||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))throw new Error(`Unsafe repository archive path: ${JSON.stringify(raw)}`);
  return name;
}

function safeReference(raw:string):string|null{
  const value=raw.trim().replaceAll('\\','/');
  if(!value||value.includes('\0')||value.startsWith('/')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)||value.split('/').includes('..')||value.length>500)return null;
  return value.replace(/^\.\//,'');
}

/**
 * Read only the archive entries referenced by trusted JATS. The complete archive
 * is still inventoried so an unselected ZIP bomb cannot hide behind selection.
 */
export async function readPublishedArchiveAssets(buffer:Buffer,references:Iterable<string>,limits:{maxEntryBytes?:number;maxExpandedBytes?:number;maxEntries?:number}={}):Promise<{entries:PublishedArchiveEntry[];unsafeReferences:string[]} >{
  if(buffer.length<4||buffer[0]!==0x50||buffer[1]!==0x4b)throw new Error('Repository asset response is not a ZIP archive');
  const normalized=new Set<string>(),unsafeReferences:string[]=[];
  for(const raw of references){const safe=safeReference(raw);if(safe)normalized.add(safe);else unsafeReferences.push(raw)}
  const wantedBasenames=new Set([...normalized].map(value=>basename(value))),zip=await openZip(buffer,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true,autoClose:true}),entries:PublishedArchiveEntry[]=[],seen=new Set<string>();
  const maxEntryBytes=limits.maxEntryBytes??30*1024*1024,maxExpandedBytes=limits.maxExpandedBytes??config.limits.expandedBytes,maxEntries=limits.maxEntries??config.limits.entries;
  let count=0,total=0;
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const fail=(error:unknown)=>{if(!settled){settled=true;zip.close();reject(error)}};
    zip.on('error',fail);zip.on('end',()=>{if(!settled){settled=true;resolve()}});
    zip.on('entry',entry=>{try{
      const name=safeEntryName(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xffff;
      if(seen.has(name))throw new Error(`Duplicate repository archive entry: ${name}`);seen.add(name);
      if((mode&0o170000)===0o120000||(entry.generalPurposeBitFlag&1)!==0)throw new Error(`Unsafe repository archive entry: ${name}`);
      if(++count>maxEntries)throw new Error('Repository archive has too many entries');
      if(entry.compressedSize>0&&entry.uncompressedSize/entry.compressedSize>200)throw new Error('Repository archive expansion ratio exceeded');
      total+=entry.uncompressedSize;if(total>maxExpandedBytes)throw new Error('Repository archive expansion limit exceeded');
      if(name.endsWith('/')||(!normalized.has(name)&&!wantedBasenames.has(basename(name)))){zip.readEntry();return}
      if(entry.uncompressedSize>maxEntryBytes)throw new Error(`Repository image exceeds the ${maxEntryBytes} byte limit: ${name}`);
      zip.openReadStream(entry,(error,stream)=>{if(error||!stream){fail(error??new Error('Could not read repository archive entry'));return}const chunks:Buffer[]=[];let actual=0;stream.on('data',(chunk:Buffer)=>{actual+=chunk.length;if(actual>entry.uncompressedSize)stream.destroy(new Error('Repository archive size mismatch'));else chunks.push(chunk)});stream.on('error',fail);stream.on('end',()=>{if(settled)return;entries.push({path:name,bytes:Buffer.concat(chunks)});zip.readEntry()})});
    }catch(error){fail(error)}});
    zip.readEntry();
  });
  return{entries,unsafeReferences};
}

export function matchPublishedArchiveEntry(reference:string,entries:PublishedArchiveEntry[]):PublishedArchiveEntry|null{
  const safe=safeReference(reference);if(!safe)return null;const exact=entries.filter(entry=>entry.path===safe);if(exact.length===1)return exact[0]!;const byName=entries.filter(entry=>basename(entry.path)===basename(safe));return byName.length===1?byName[0]!:null;
}
